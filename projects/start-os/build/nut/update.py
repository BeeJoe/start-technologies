#!/usr/bin/env python3
"""Prepare a verified NUT source-pin update; never build, commit or publish it."""

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import tempfile
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

POOL = "https://deb.debian.org/debian/pool/main/n/nut/"
RELEASES = "https://api.github.com/repos/networkupstools/nut/releases"
PINS = "projects/start-os/build/nut/version.env"
CHANGELOG = "projects/start-os/changelog"
UPSTREAM = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
DEBIAN = re.compile(r"([0-9]+\.[0-9]+\.[0-9]+)-[0-9][0-9A-Za-z.+~]*")


def version(value):
    if not UPSTREAM.fullmatch(value):
        raise ValueError(f"Unsupported upstream version: {value!r}")
    return tuple(map(int, value.split(".")))


def fetch(url, limit=4 * 1024 * 1024):
    headers = {"User-Agent": "StartOS-NUT-updater"}
    token = os.environ.get("GH_TOKEN")
    if token and url.startswith(RELEASES):
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"Response exceeds limit: {url}")
    return data


def archive_hash(url, expected_size):
    if not 0 < expected_size <= 512 * 1024 * 1024:
        raise ValueError("Source archive has an unsupported size")
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(url, timeout=60) as response:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > expected_size:
                raise ValueError(f"Source archive exceeds signed size: {url}")
            digest.update(chunk)
    if size != expected_size:
        raise ValueError(f"Source archive size does not match signed manifest: {url}")
    return digest.hexdigest()


def read_pins(text):
    pins = {}
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        key, separator, raw = line.partition("=")
        values = shlex.split(raw)
        if (
            not separator
            or not re.fullmatch(r"NUT_[A-Z_0-9]+", key)
            or len(values) != 1
            or key in pins
        ):
            raise ValueError("Malformed or duplicate NUT pin")
        pins[key] = values[0]
    return pins


class PoolIndex(HTMLParser):
    def __init__(self):
        super().__init__()
        self.versions = set()

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href", "")
            match = re.fullmatch(r"nut_(.+)\.dsc", href)
            if match and DEBIAN.fullmatch(match[1]):
                self.versions.add(match[1])


def newer(left, right):
    result = subprocess.run(["dpkg", "--compare-versions", left, "gt", right], check=False)
    if result.returncode not in (0, 1):
        raise ValueError("Debian version comparison failed")
    return result.returncode == 0


def choose_candidate(index, pins, latest):
    parser = PoolIndex()
    parser.feed(index)
    selected = pins["NUT_DEBIAN_VERSION"]
    for candidate in sorted(parser.versions):
        upstream = DEBIAN.fullmatch(candidate)[1]
        if version(upstream) <= version(latest) and newer(candidate, selected):
            selected = candidate
    return selected


def verify_manifest(signed, signer, key):
    if not re.fullmatch(r"[A-F0-9]{40}", signer):
        raise ValueError("NUT_SIGNER must be a full fingerprint")
    with tempfile.TemporaryDirectory(prefix="nut-signature-") as directory:
        root = Path(directory)
        (root / "key.asc").write_bytes(key)
        (root / "source.dsc").write_bytes(signed)
        subprocess.run(
            [
                "gpg", "--batch", "--no-tty", "--homedir", directory,
                "--dearmor", "--output", str(root / "key.gpg"), str(root / "key.asc"),
            ],
            check=True,
            capture_output=True,
        )
        result = subprocess.run(
            [
                "gpgv", "--homedir", directory, "--keyring", str(root / "key.gpg"),
                "--status-fd", "1", "--output", str(root / "verified"), str(root / "source.dsc"),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        signatures = [
            line.split() for line in result.stdout.splitlines()
            if line.startswith("[GNUPG:] VALIDSIG ")
        ]
        if not any(fields[2] == signer or fields[-1] == signer for fields in signatures):
            raise ValueError("Source manifest was not signed by the pinned maintainer")
        return (root / "verified").read_text()


def manifest_fields(text):
    fields = {}
    current = None
    for line in text.splitlines():
        if line.startswith((" ", "\t")) and current:
            fields[current] += "\n" + line.strip()
        elif line:
            name, separator, value = line.partition(":")
            if not separator or name in fields:
                raise ValueError("Malformed or duplicate source manifest field")
            current = name
            fields[name] = value.strip()
    return fields


def source_files(text, candidate, packages):
    fields = manifest_fields(text)
    if fields.get("Source") != "nut" or fields.get("Version") != candidate or fields.get("Format") != "3.0 (quilt)":
        raise ValueError("Signed source identity or format changed; review manually")
    binaries = {name.strip() for name in fields.get("Binary", "").split(",")}
    if not set(packages.split()) <= binaries:
        raise ValueError("NUT runtime package names changed; review manually")
    entries = {}
    for line in fields.get("Checksums-Sha256", "").splitlines():
        if not line:
            continue
        parts = line.split()
        if (
            len(parts) != 3
            or not re.fullmatch(r"[a-f0-9]{64}", parts[0])
            or not parts[1].isdigit()
            or Path(parts[2]).name != parts[2]
            or parts[2] in entries
        ):
            raise ValueError("Malformed source checksum entry")
        entries[parts[2]] = (parts[0], int(parts[1]))
    upstream = DEBIAN.fullmatch(candidate)[1]
    names = (f"nut_{upstream}.orig.tar.gz", f"nut_{candidate}.debian.tar.xz")
    if any(name not in entries for name in names):
        raise ValueError("Source archive format changed; review manually")
    return {name: entries[name] for name in names}


def prepare(root, get=fetch, hash_archive=archive_hash):
    original = (root / PINS).read_text()
    pins = read_pins(original)
    release = json.loads(get(RELEASES + "/latest"))
    latest = release["tag_name"].removeprefix("v")
    version(latest)
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("Latest upstream release is not stable")
    candidate = choose_candidate(get(POOL).decode(), pins, latest)
    report = {
        "current": pins["NUT_DEBIAN_VERSION"],
        "latestUpstream": latest,
        "candidate": candidate,
        "changed": candidate != pins["NUT_DEBIAN_VERSION"],
    }
    report["waitingForDebian"] = version(latest) > version(DEBIAN.fullmatch(candidate)[1])
    if not report["changed"]:
        return report, {}

    upstream = DEBIAN.fullmatch(candidate)[1]
    if version(upstream) < version(pins["NUT_VERSION"]):
        raise ValueError("Refusing an upstream downgrade")
    signed = get(POOL + f"nut_{candidate}.dsc")
    key = get(f"https://keyring.debian.org/pks/lookup?op=get&search=0x{pins['NUT_SIGNER']}")
    manifest = verify_manifest(signed, pins["NUT_SIGNER"], key)
    files = source_files(manifest, candidate, pins["NUT_PACKAGES"])
    for name, (expected, size) in files.items():
        if hash_archive(POOL + name, size) != expected:
            raise ValueError(f"Source archive checksum mismatch: {name}")

    # Debian's orig tarball must be the published upstream release archive.
    matching_release = (
        release if upstream == latest
        else json.loads(get(RELEASES + "/tags/v" + upstream))
    )
    if (
        matching_release.get("draft")
        or matching_release.get("prerelease")
        or matching_release.get("tag_name") != "v" + upstream
    ):
        raise ValueError("Matching upstream release is not stable")
    assets = [asset for asset in matching_release["assets"] if asset["name"] == f"nut-{upstream}.tar.gz"]
    orig_hash = files[f"nut_{upstream}.orig.tar.gz"][0]
    if len(assets) != 1 or assets[0].get("digest") != "sha256:" + orig_hash:
        raise ValueError("Upstream release digest is missing or differs from Debian source; review manually")

    suffix = re.fullmatch(
        re.escape(pins["NUT_DEBIAN_VERSION"]) + r"(~startos[0-9]+)\.[0-9]+",
        pins["NUT_PACKAGE_VERSION"],
    )
    if not suffix:
        raise ValueError("Unsupported StartOS package revision scheme")
    updates = {
        "NUT_VERSION": upstream,
        "NUT_DEBIAN_VERSION": candidate,
        "NUT_PACKAGE_VERSION": candidate + suffix[1] + ".1",
        "NUT_DSC_SHA256": hashlib.sha256(signed).hexdigest(),
        "NUT_SOURCE_SHA256": orig_hash,
        "NUT_DEBIAN_SHA256": files[f"nut_{candidate}.debian.tar.xz"][0],
    }
    rendered = original
    for name, value in updates.items():
        rendered, count = re.subn(
            r"^" + name + r"=.*$", lambda _: name + "=" + value,
            rendered, flags=re.MULTILINE,
        )
        if count != 1:
            raise ValueError(f"Missing or duplicate pin: {name}")
    changes = {PINS: rendered}
    pending = f"{CHANGELOG}/minor-added-ups-monitor.md"
    if (root / pending).exists():
        text = (root / pending).read_text()
        changed, count = re.subn(
            r"Includes NUT " + re.escape(pins["NUT_VERSION"]) + r" for broader UPS compatibility\.",
            f"Includes NUT {upstream} for broader UPS compatibility.", text,
        )
        if count != 1:
            raise ValueError("Pending UPS feature fragment changed; review manually")
        if changed != text:
            changes[pending] = changed
    else:
        entry = (
            f"Update UPS support to NUT {upstream}."
            if upstream != pins["NUT_VERSION"]
            else f"Refresh NUT {upstream} with Debian maintenance updates."
        )
        changes[f"{CHANGELOG}/patch-changed-nut-update.md"] = f"---\nrelease-notes: false\n---\n\n- {entry}\n"
    report.update({
        "packageVersion": updates["NUT_PACKAGE_VERSION"],
        "releaseUrl": f"https://github.com/networkupstools/nut/releases/tag/v{upstream}",
        "files": list(changes),
    })
    return report, changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="apply verified pins and changelog changes")
    parser.add_argument("--report", type=Path, help="write a JSON report")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[4]
    try:
        report, changes = prepare(root)
    except subprocess.CalledProcessError as error:
        detail = error.stderr
        if isinstance(detail, bytes):
            detail = detail.decode(errors="replace")
        parser.exit(1, f"NUT source signature verification failed; review manually.\n{detail or error}\n")
    if args.write:
        for name, contents in changes.items():
            path = root / name
            path.write_text(contents)
    rendered = json.dumps(report, indent=2) + "\n"
    if args.report:
        args.report.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
