#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."
source projects/start-os/build/nut/version.env
arch=${ARCH:-$(uname -m)}
case "$arch" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    riscv64) ;;
    *) printf 'Unsupported NUT architecture: %s\n' "$arch" >&2; exit 1 ;;
esac
output="$(pwd)/results/nut/$arch"
mkdir -p "$(dirname "$output")"
staging=$(mktemp -d "$(dirname "$output")/.${arch}.XXXXXX")
trap 'rm -rf "$staging"' EXIT
docker run --rm --platform="linux/$arch" --tmpfs /build:rw,exec,size=1073741824 --volume "$staging:/output" \
    --volume "$(pwd)/projects/start-os/build/nut:/recipe:ro" \
    --env "OWNER_UID=$(id -u)" --env "OWNER_GID=$(id -g)" "$NUT_BUILD_IMAGE" \
    bash -euc 'bash /recipe/build-packages.sh; cp /packages/* /output/; chown "$OWNER_UID:$OWNER_GID" /output/*'
(cd "$staging" && sha256sum --check SHA256SUMS)
rm -rf "$output"
mv "$staging" "$output"
touch "$output/.done"
