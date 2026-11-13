#!/bin/bash
set -euo pipefail

ROOT=$(realpath "$(dirname "${BASH_SOURCE[0]}")/../../../..")
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
recipe=projects/start-os/build
mkdir -p "$fixture/$recipe/lib" "$fixture/$recipe/nut" "$fixture/bin"
cp -a "$ROOT/$recipe/dpkg-deps" "$fixture/$recipe/"
cp "$ROOT/$recipe/nut/"{build.sh,version.env} "$fixture/$recipe/nut/"
cd "$fixture"
source "$recipe/nut/version.env"
for platform in x86_64 x86_64-nonfree x86_64-nvidia aarch64 aarch64-nonfree aarch64-nvidia raspberrypi rockchip64 riscv64 riscv64-nonfree; do
    arch=${platform%%-*}
    case "$arch" in raspberrypi|rockchip64) arch=aarch64 ;; esac
    ARCH="$arch" PLATFORM="$platform" bash "$recipe/dpkg-deps/generate.sh"
    for package in $NUT_PACKAGES; do
        grep -qx "$package=$NUT_PACKAGE_VERSION" "$recipe/lib/depends"
    done
done

cat > bin/docker <<'SH'
#!/bin/bash
set -euo pipefail
if [ "${FAIL_NUT_BUILD:-}" = 1 ]; then exit 42; fi
while [ "$#" -gt 0 ]; do
    if [ "$1" = --volume ]; then
        case "$2" in *:/output) output=${2%:/output} ;; esac
        shift 2
    else
        shift
    fi
done
printf 'built package\n' > "$output/package.deb"
(cd "$output" && sha256sum package.deb > SHA256SUMS)
SH
chmod +x bin/docker
export PATH="$fixture/bin:$PATH"
mkdir -p results/nut/amd64
printf 'obsolete package\n' > results/nut/amd64/old-version.deb
ARCH=x86_64 bash "$recipe/nut/build.sh"
test ! -e results/nut/amd64/old-version.deb
test -f results/nut/amd64/.done
(cd results/nut/amd64 && sha256sum --check SHA256SUMS)
if FAIL_NUT_BUILD=1 ARCH=x86_64 bash "$recipe/nut/build.sh"; then
    printf 'Failed package build was accepted\n' >&2
    exit 1
fi
test -f results/nut/amd64/.done
(cd results/nut/amd64 && sha256sum --check SHA256SUMS)
test "$(find results/nut -mindepth 1 -maxdepth 1 -type d | wc -l)" = 1
printf 'NUT selection, stale-package removal and failed-build preservation passed\n'
