# AGENTS.md — StartOS OS product

Operating rules for AI developers working in `start-os/`. `CLAUDE.md` is a
one-line `@AGENTS.md` import. See the root [AGENTS.md](../../AGENTS.md) for
monorepo-wide rules and [ARCHITECTURE.md](ARCHITECTURE.md) for how this product
is wired.

**Read up the tree first.** These docs are hierarchical: before working here, read the `AGENTS.md` in each enclosing directory up to the repo root (and their `ARCHITECTURE.md` / `CONTRIBUTING.md` where relevant). This file covers only what is specific to this scope and does not repeat rules already stated higher up.

## Layout

- `src/bin/startbox.rs`, `src/bin/start-container.rs` — the only Rust in this
  dir. They are thin entry points; backend logic lives in
  `../../shared-libs/crates/start-core` (crate `start-core`, lib `start_core`).
- `web/ui`, `web/setup-wizard` — Angular apps in the root Angular workspace
  (`angular.json` at the repo root). Run web commands (`npm run check:ui`, `npm run start:ui`, …)
  from the repo root, not from here.
- `container-runtime/` — Node.js LXC runtime with its **own** AGENTS/CLAUDE;
  read `container-runtime/AGENTS.md` before touching it.
- `docs/` — the end-user mdbook (book "StartOS"), served at `/start-os/`.
- `build/` — OS image assembly (image-recipe, dpkg-deps, firmware) plus the
  `startbox`/`start-container` build scripts; `debian/` — Debian control;
  `backup-fs/` carries its own build script. Systemd units + `services.slice`
  and `assets/` live directly in this dir; the shared build infra (root
  `build/`) and `apt/` are at the repo root.

## Prerequisites and build configuration

The OS product uses the shared root toolchain plus multi-arch emulation and
image-packaging tools. Admin UI or setup-wizard work needs only the web
prerequisites in [`shared-libs/ts-modules/CONTRIBUTING.md`](../../shared-libs/ts-modules/CONTRIBUTING.md).

For a full OS image build on Debian or Ubuntu:

```sh
sudo apt install -y qemu-user-static binfmt-support squashfs-tools b3sum

# One-time cross-arch setup; safe to re-run
docker run --privileged --rm tonistiigi/binfmt --install all
docker buildx create --name start9 --use 2>/dev/null || docker buildx use start9
```

For faster iteration, run `. ./devmode.sh` from the repo root. This sets
`ENVIRONMENT=dev` and `GIT_BRANCH_AS_HASH=1`.

OS builds accept the repo-wide `PROFILE` and `GIT_BRANCH_AS_HASH` variables
plus these values:

- `PLATFORM`: `x86_64`, `x86_64-nonfree`, `aarch64`, `aarch64-nonfree`,
  `riscv64`, or `raspberrypi`. The selected platform is remembered between
  builds; `-nonfree` variants include proprietary firmware and Raspberry Pi
  includes non-free components by necessity.
- `ENVIRONMENT`: hyphen-separated `dev` (password SSH before setup and no
  frontend compression), `unstable` (extra assertions/debugging), and `console`
  (tokio-console) flags.

## Build & test (run from the repo root)

- Compile the OS bins: `cargo check -p start-os` (or `cargo build -p start-os
--bin startbox`). Local `cargo check` is **linux-only** — CI also builds
  apple-darwin and aarch64/riscv64 musl; platform-specific changes can pass here
  yet break those.
- Regenerate TS bindings after any change to exported Rust types:
  `make start-core-ts-bindings`. Then rebuild start-core (`cd shared-libs/ts-modules/start-core && make dist`)
  and the SDK (`cd projects/start-sdk && make bundle`) before web/runtime type-checks —
  editing `shared-libs/ts-modules/start-core/lib/osBindings/*.ts` alone is not enough.
- Type-check web apps: `npm run check:ui && npm run check:setup`.
- Type-check the runtime: `cd projects/start-os/container-runtime && npm run check`.
- Build the UI: `make start-os-ui` (or `make start-os-uis` for ui + setup-wizard).
- Build all StartOS artifacts: `make start-os`. Build a bootable image with
  `make start-os-$(IMAGE_TYPE)` (`start-os-iso`, or `start-os-img` on Raspberry
  Pi), a Debian package with `make start-os-deb`, or the squashfs image with
  `make start-os-squashfs`.
- Tests: `make test` (Rust + SDK + container-runtime), or `make start-core-test`.
- Format: `make start-os-format` / `make start-os-format-check` (Rust only);
  TS/web/container-runtime formatting runs through `make web-format` (root
  prettier config).
- Regenerate `start-container` man pages (committed under `man/`):
  `cargo test -p start-core export_manpage_start_container`.

## Deploying to a device

| Target                                        | Purpose                                      |
| --------------------------------------------- | -------------------------------------------- |
| `start-os-update-startbox REMOTE=start9@<ip>` | Deploy binary + UI only                      |
| `start-os-update-deb REMOTE=start9@<ip>`      | Deploy the full Debian package               |
| `start-os-update REMOTE=start9@<ip>`          | Perform an OTA-style update                  |
| `start-os-emulate-reflash REMOTE=start9@<ip>` | Reflash as from a live ISO                   |
| `start-os-update-overlay REMOTE=start9@<ip>`  | Deploy to a reboot-volatile overlay          |
| `start-os-wormhole`                           | Send the startbox binary over magic-wormhole |
| `start-os-wormhole-deb`                       | Send the Debian package over magic-wormhole  |
| `start-os-wormhole-squashfs`                  | Send the squashfs image over magic-wormhole  |

To create a local VM, install `virt-manager`, add the user to `libvirt`, build
`PLATFORM=$(uname -m) ENVIRONMENT=dev make start-os-iso`, and use the screenshot
walkthrough in [`assets/create-vm/`](assets/create-vm/) to create a generic VM
whose storage pool points at `results/`.

## Cross-layer changes

When exported Rust types change, verify in this order:

1. `cargo check -p start-os`
2. `make start-core-ts-bindings`
3. `cd projects/start-sdk && make bundle`
4. `npm run check:ui && npm run check:setup`
5. `cd projects/start-os/container-runtime && npm run check`

## Gotchas

- **UIs are embedded into `startbox` at compile time** (`include_dir!`), so the
  web build must precede the Rust build — use the `Makefile`, which encodes the
  ordering, rather than running `cargo build` against a stale `web/dist`.
- **`unshare-userns` must stay a multi-call applet**, not a CLI subcommand: it
  calls `unshare(CLONE_NEWUSER)`, which the kernel rejects on a multi-threaded
  process. See the comment in `src/bin/start-container.rs`.
- **One prettier config.** All TS (web, container-runtime) is governed by the
  root `.prettierrc.json` + `.prettierignore`; run prettier from the repo root
  so the ignore applies (`__fixtures__/` etc. must stay unformatted). Don't add
  per-component prettier configs or scripts.
- **Don't edit generated binding files** like
  `shared-libs/ts-modules/start-core/lib/osBindings/index.ts` or `projects/start-sdk/s9pk.mk`.
- **The `beta` feature swaps the UI seed** (`patchdb-ui-seed.beta.json`) and
  forwards to `start-core`'s `beta` feature — keep both seeds in sync when you
  change seed shape.

## Docs are part of the change

User-facing changes (UI, CLI output/flags, install/setup flow) must update the
matching page under `docs/` in the same change. Keep this AGENTS, README, and
ARCHITECTURE current when you change structure, build steps, or conventions.
