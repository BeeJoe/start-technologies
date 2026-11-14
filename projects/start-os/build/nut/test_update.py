import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import update


class UpdaterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory(prefix="nut-test-keys-")
        cls.home = Path(cls.keys.name)
        subprocess.run(
            ["gpg", "--batch", "--homedir", str(cls.home), "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "NUT updater fixture <nut@example.invalid>", "ed25519", "sign", "0"],
            check=True, capture_output=True,
        )
        listing = subprocess.check_output(["gpg", "--homedir", str(cls.home), "--with-colons", "--list-keys"], text=True)
        cls.signer = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
        cls.key = subprocess.check_output(["gpg", "--homedir", str(cls.home), "--armor", "--export", cls.signer])

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["gpgconf", "--homedir", str(cls.home), "--kill", "gpg-agent"], check=True)
        cls.keys.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="nut-update-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        # The baseline must stay fixed when the real pin advances in a bot PR.
        pins = {
            "NUT_VERSION": "2.8.5",
            "NUT_BUILD_IMAGE": "debian:trixie-slim@sha256:" + "1" * 64,
            "NUT_DEBIAN_VERSION": "2.8.5-1",
            "NUT_PACKAGE_VERSION": "2.8.5-1~startos13.7",
            "NUT_SIGNER": self.signer,
            "NUT_DSC_SHA256": "0" * 64,
            "NUT_SOURCE_SHA256": "0" * 64,
            "NUT_DEBIAN_SHA256": "0" * 64,
            "NUT_PACKAGES": "'nut-client nut-server libupsclient7 libnutclient2t64 libnutscan4'",
        }
        text = "".join(f"{name}={value}\n" for name, value in pins.items())
        (self.root / update.PINS).parent.mkdir(parents=True)
        (self.root / update.PINS).write_text(text)
        (self.root / update.CHANGELOG).mkdir(parents=True)
        self.candidate = "2.8.6-1"
        self.orig = b"upstream archive fixture"
        self.debian = b"Debian packaging fixture"
        self.orig_hash = hashlib.sha256(self.orig).hexdigest()
        self.debian_hash = hashlib.sha256(self.debian).hexdigest()
        self.release = {"tag_name": "v2.8.6", "draft": False, "prerelease": False, "assets": [{"name": "nut-2.8.6.tar.gz", "digest": "sha256:" + self.orig_hash}]}
        self.manifest = self.manifest_text()
        self.signed = None
        self.calls = []
        self.index = '<a href="nut_2.8.6-1.dsc">new</a>'
        self.tagged_releases = {}

    def manifest_text(self):
        return f"""Format: 3.0 (quilt)
Source: nut
Version: {self.candidate}
Binary: nut-client, nut-server, libupsclient7, libnutclient2t64, libnutscan4
Checksums-Sha256:
 {self.orig_hash} {len(self.orig)} nut_2.8.6.orig.tar.gz
 {self.debian_hash} {len(self.debian)} nut_{self.candidate}.debian.tar.xz
"""

    def sign(self):
        return subprocess.check_output(
            ["gpg", "--batch", "--homedir", str(self.home), "--pinentry-mode", "loopback", "--passphrase", "", "--armor", "--clearsign"],
            input=self.manifest.encode(),
        )

    def get(self, url):
        self.calls.append(url)
        if url in self.tagged_releases:
            return json.dumps(self.tagged_releases[url]).encode()
        if url.startswith(update.RELEASES):
            return json.dumps(self.release).encode()
        if url == update.POOL:
            return self.index.encode()
        if "keyring.debian.org" in url:
            return self.key
        if url.endswith(".dsc"):
            return self.signed if self.signed is not None else self.sign()
        self.fail("Unexpected download: " + url)

    def archive(self, url, size):
        data = self.orig if url.endswith(".orig.tar.gz") else self.debian
        self.assertEqual(size, len(data))
        return hashlib.sha256(data).hexdigest()

    def prepare(self):
        return update.prepare(self.root, self.get, self.archive)

    def test_verified_upgrade_preserves_trust_and_build_image(self):
        original = (self.root / update.PINS).read_text()
        report, changes = self.prepare()
        self.assertTrue(report["changed"])
        self.assertEqual(report["packageVersion"], "2.8.6-1~startos13.1")
        pins = update.read_pins(changes[update.PINS])
        before = update.read_pins(original)
        for field in ("NUT_SIGNER", "NUT_BUILD_IMAGE", "NUT_PACKAGES"):
            self.assertEqual(pins[field], before[field])
        self.assertEqual(pins["NUT_SOURCE_SHA256"], self.orig_hash)
        self.assertIn(f"{update.CHANGELOG}/patch-changed-nut-update.md", changes)
        self.assertEqual((self.root / update.PINS).read_text(), original)

    def test_updates_pending_feature_instead_of_adding_fragment(self):
        name = f"{update.CHANGELOG}/minor-added-ups-monitor.md"
        (self.root / name).write_text("---\nrelease-notes: true\n---\n\n- Includes NUT 2.8.5 for broader UPS compatibility.\n")
        _, changes = self.prepare()
        self.assertEqual(set(changes), {update.PINS, name})
        self.assertIn("Includes NUT 2.8.6", changes[name])

    def test_applying_verified_update_is_idempotent(self):
        _, changes = self.prepare()
        for name, contents in changes.items():
            (self.root / name).write_text(contents)
        report, changes = self.prepare()
        self.assertFalse(report["changed"])
        self.assertEqual(changes, {})

    def test_current_line_maintenance_update_can_land_while_waiting_for_new_upstream(self):
        self.candidate = "2.8.5-2"
        self.index = '<a href="nut_2.8.5-2.dsc">maintenance</a>'
        self.manifest = self.manifest_text().replace("nut_2.8.6.orig", "nut_2.8.5.orig")
        self.tagged_releases[update.RELEASES + "/tags/v2.8.5"] = {
            **self.release, "tag_name": "v2.8.5",
            "assets": [{"name": "nut-2.8.5.tar.gz", "digest": "sha256:" + self.orig_hash}],
        }
        report, changes = self.prepare()
        self.assertTrue(report["waitingForDebian"])
        self.assertEqual(report["packageVersion"], "2.8.5-2~startos13.1")
        self.assertIn("Debian maintenance updates", changes[f"{update.CHANGELOG}/patch-changed-nut-update.md"])

    def test_current_pin_is_a_noop(self):
        self.index = '<a href="nut_2.8.5-1.dsc">current</a>'
        self.release["tag_name"] = "v2.8.5"
        report, changes = self.prepare()
        self.assertFalse(report["changed"])
        self.assertFalse(report["waitingForDebian"])
        self.assertEqual(changes, {})
        self.assertEqual(len(self.calls), 2)

    def test_missing_debian_source_reports_waiting_without_changing_pins(self):
        self.index = '<a href="nut_2.8.5-1.dsc">current</a>'
        report, changes = self.prepare()
        self.assertTrue(report["waitingForDebian"])
        self.assertFalse(report["changed"])
        self.assertEqual(changes, {})

    def test_debian_revision_comparison_is_not_lexical(self):
        pins = {"NUT_DEBIAN_VERSION": "2.8.5-9"}
        index = '<a href="nut_2.8.5-10.dsc">a</a><a href="nut_2.8.6-1~rc1.dsc">b</a><a href="nut_2.8.4-99.dsc">c</a>'
        self.assertEqual(update.choose_candidate(index, pins, "2.8.5"), "2.8.5-10")

    def test_pool_links_cannot_escape_or_select_prereleases(self):
        self.index = '<a href="../nut_2.8.6-1.dsc">a</a><a href="nut_2.9.0~rc1-1.dsc">b</a><a href="https://evil.invalid/nut_2.8.6-1.dsc">c</a>'
        self.assertFalse(self.prepare()[0]["changed"])

    def test_rejects_prerelease_api_response(self):
        self.release["prerelease"] = True
        with self.assertRaisesRegex(ValueError, "not stable"):
            self.prepare()

    def test_tampered_signed_manifest_is_rejected(self):
        self.signed = self.sign().replace(b"Source: nut", b"Source: bad")
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare()

    def test_different_signer_is_rejected_even_if_keyring_contains_valid_key(self):
        text = (self.root / update.PINS).read_text().replace(self.signer, "A" * 40)
        (self.root / update.PINS).write_text(text)
        with self.assertRaisesRegex(ValueError, "pinned maintainer"):
            self.prepare()

    def test_archive_checksum_mismatch_is_rejected(self):
        self.orig = b"modified archive fixture"
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.prepare()

    def test_upstream_digest_must_match_debian_source(self):
        self.release["assets"][0]["digest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "release digest"):
            self.prepare()

    def test_missing_runtime_package_requires_manual_review(self):
        self.manifest = self.manifest.replace("libnutscan4", "libnutscan5")
        with self.assertRaisesRegex(ValueError, "package names changed"):
            self.prepare()

    def test_wrong_source_identity_requires_manual_review(self):
        self.manifest = self.manifest.replace("Source: nut", "Source: another")
        with self.assertRaisesRegex(ValueError, "identity or format"):
            self.prepare()

    def test_archive_hash_enforces_signed_size(self):
        import io
        with patch("urllib.request.urlopen", return_value=io.BytesIO(b"too long")):
            with self.assertRaisesRegex(ValueError, "exceeds signed size"):
                update.archive_hash("https://example.invalid/archive", 3)


if __name__ == "__main__":
    unittest.main()
