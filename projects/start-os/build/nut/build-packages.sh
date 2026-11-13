#!/bin/bash
set -euo pipefail

source /recipe/version.env
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends build-essential ca-certificates curl dpkg-dev gnupg gpgv
mkdir -p /build /packages
cd /build
pool=https://deb.debian.org/debian/pool/main/n/nut
for file in "nut_${NUT_DEBIAN_VERSION}.dsc" "nut_${NUT_VERSION}.orig.tar.gz" "nut_${NUT_DEBIAN_VERSION}.debian.tar.xz"; do
    curl --fail --location --retry 3 "$pool/$file" -o "$file"
done
printf '%s  %s\n' \
    "$NUT_DSC_SHA256" "nut_${NUT_DEBIAN_VERSION}.dsc" \
    "$NUT_SOURCE_SHA256" "nut_${NUT_VERSION}.orig.tar.gz" \
    "$NUT_DEBIAN_SHA256" "nut_${NUT_DEBIAN_VERSION}.debian.tar.xz" | sha256sum --check
curl --fail --location --retry 3 \
    "https://keyring.debian.org/pks/lookup?op=get&search=0x${NUT_SIGNER}" -o signer.asc
export GNUPGHOME=/build/gnupg
mkdir -m 700 "$GNUPGHOME"
gpg --batch --import signer.asc
gpg --batch --export "$NUT_SIGNER" > signer.gpg
gpgv --keyring /build/signer.gpg --status-fd 1 "nut_${NUT_DEBIAN_VERSION}.dsc" > signature.status
grep -E "^\[GNUPG:\] VALIDSIG .* ${NUT_SIGNER}$" signature.status
dpkg-source --no-check -x "nut_${NUT_DEBIAN_VERSION}.dsc" source
cd source
apt-get update
apt-get build-dep -y --no-install-recommends --arch-only --build-profiles=nodoc .
{
    printf 'nut (%s) trixie; urgency=medium\n\n' "$NUT_PACKAGE_VERSION"
    printf '  * Rebuild Debian %s against Trixie for StartOS.\n\n' "$NUT_DEBIAN_VERSION"
    printf ' -- Start9 Labs <support@start9.com>  Fri, 13 Nov 2026 00:00:00 +0000\n\n'
    cat debian/changelog
} > debian/changelog.startos
mv debian/changelog.startos debian/changelog
DEB_BUILD_OPTIONS="parallel=4 nodoc" dpkg-buildpackage --build=any --no-sign --build-profiles=nodoc
arch=$(dpkg --print-architecture)
for package in $NUT_PACKAGES; do
    cp "/build/${package}_${NUT_PACKAGE_VERSION}_${arch}.deb" /packages/
done
cp /recipe/version.env /packages/
cp /build/signature.status /packages/
cp /build/*.buildinfo /packages/
cd /packages
sha256sum ./*.deb > SHA256SUMS
rm -rf /build/* /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
