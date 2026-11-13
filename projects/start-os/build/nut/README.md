# NUT packages

StartOS rebuilds Debian NUT 2.8.5-1 against Trixie as
`2.8.5-1~startos13.1`. `version.env` pins the upstream archive, Debian packaging,
source manifest, signing-key fingerprint, package revision and runtime package set.
The signer is Laurent Bigonville's Debian key
`7E0ED3D2B34A03B15F9F3121C7F7F9660D82A682`, published in the
[Debian keyring](https://keyring.debian.org/) and his
[Debian developer record](https://nm.debian.org/person/bigon/).
The source manifest's signature and all three SHA-256 hashes are checked before
extracting source. Build dependencies come exclusively from authenticated Trixie
repositories. The builder base is pinned to a multi-architecture image digest.

`make start-os-nut` builds for the selected StartOS architecture. Outputs live in
`results/nut/{amd64,arm64,riscv64}/`, including the matching client, server, scanner
and client libraries, checksums, signature evidence and Debian build information.
The per-architecture compiled archive carries this set into each platform's image
job, sharing one package build across firmware variants.
Debian's configuration paths, nut user/group, udev rules, systemd services, drivers
and shutdown hook are retained. USB discovery additionally requires Trixie's
`libusb-1.0-0`, explicitly included in the image dependencies.

The image builder installs these packages alongside the StartOS Debian package.
Local full updates and Debian-package updates stage and install the same set in
the update chroot. StartOS's package dependencies select their exact revision;
the `.deb` therefore travels with its matching NUT packages. A startbox-only
update does not update OS packages. OTA images carry the installed packages
through the existing image-signing and verification path; this build does not
publish an APT repository or enable a testing/unstable binary source.

`make start-os-deb` also produces a `.debs.tar` bundle containing the StartOS
package, matching NUT packages and `install-bundle.sh`. The wormhole Debian
target sends this complete bundle. `make start-os-nut-test` exercises fresh and
upgrade installs in disposable Trixie containers, cross-version client/server
reads, and a calibration/on-battery/low-battery sequence with a harmless shutdown
marker in place of powering off a machine.

NUT updates are explicit: a Debian security patch or upstream release needs a
reviewed source/hash/revision change and a rebuilt image. Trixie dependency
security updates remain available through normal image rebuilds. Exact NUT
dependencies prevent an OS build from silently selecting another upstream
release or reverting to Trixie's older NUT.

Trixie 2.8.1-5+deb13u1 already fixes the lingering calibration-state shutdown bug.
The full upgrade additionally brings USB driver support and reading improvements
for APC, Eaton and GoldenMate devices, and client timeout and stale-data fixes.
StartOS's own Rust monitor-login protocol is independent of the NUT client library.
See the [upstream release notes](https://networkupstools.org/historic/v2.8.5/docs/release-notes.chunked/NUT_Release_Notes.html).

NUT 2.8.5 moves Debian drivers to `/usr/libexec/nut` and adds optional enumerator
daemon units. StartOS retains the existing oneshot/path enumerator. The scanner
receives `--usb_scan` twice to include USB bus/port matching details; a single
flag now comments them out. The existing five-second final shutdown delay and
monitoring policy remain owned by StartOS.

Rollback uses the previous StartOS rootfs retained by the device updater, together
with its pre-upgrade private database/configuration snapshot when a StartOS data
migration has run. Package-only rollback uses the complete matching previous NUT
set with APT's explicit downgrade option and preserved configuration; mixing
client/server revisions is unsupported.
