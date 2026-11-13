#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
for directory in nut/*; do
    (cd "$directory" && sha256sum --check SHA256SUMS)
done
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -o Dpkg::Options::=--force-confold install -y --reinstall ./nut/*/*.deb ./startos-*.deb
