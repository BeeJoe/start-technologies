# start-cli

`start-cli` is the command-line client for StartOS. It is a thin `bin` crate over
[`start-core`](../../shared-libs/crates/start-core) (the shared Rust backend, crate `start-core`,
lib name `start_core`). The CLI surfaces the same RPC API the StartOS server exposes, plus
local developer tooling for building and signing `.s9pk` packages.

Most subcommands are _remote_ calls: you point `start-cli` at a running StartOS server
(`--host`/`-H`) and it invokes the server's RPC API over HTTPS. A handful of commands
(`s9pk`, `init-key`, `pubkey`, `util`) run locally and are what package authors use day to day.

## Quickstart

Build the binary from the monorepo root:

```sh
make start-cli                                            # build the start-cli bin
cargo build -p start-cli --bin start-cli            # dev shortcut (debug)
cargo build -p start-cli --bin start-cli --release  # dev shortcut (release)
```

Run it:

```sh
target/debug/start-cli --help

# talk to a server
target/debug/start-cli -H https://server.local auth login
target/debug/start-cli -H https://server.local package list

# local developer tooling (no server needed)
target/debug/start-cli init-key                    # create a developer key
target/debug/start-cli pubkey                       # print its public key
target/debug/start-cli s9pk pack ...                # build a package
```

> In a StartOS image, `start-cli` is provided as a symlink to the multiplexed
> `startbox` binary (see the OS `Makefile`), so it is always on the server's `PATH`.

## Connecting to a server

`-H/--host` accepts either a URL (`https://server.local`) or a `host` profile name
defined in a workspace `.startos/config.yaml`. Common flags:

| Flag                          | Purpose                                 |
| ----------------------------- | --------------------------------------- |
| `-H, --host <url\|profile>`   | Target server URL or config profile     |
| `--registry <url\|profile>`   | Target registry for `registry` commands |
| `--proxy <url>`               | HTTP/SOCKS proxy for outbound requests  |
| `--cookie-path <path>`        | Where the session cookie is stored      |
| `--developer-key-path <path>` | Developer signing key location          |
| `--insecure`                  | Skip TLS verification (testing only)    |

Configuration is layered: explicit flags override `.startos/config.yaml` (local workspace),
which overrides `/etc/startos/config.yaml`. See
[`shared-libs/crates/start-core/src/context/config.rs`](../../shared-libs/crates/start-core/src/context/config.rs).

## Command surface

The full command tree comes from `start-core::main_api()`. Top-level groups include:

- `server`, `package`, `net`, `auth`, `db`, `ssh`, `wifi`, `disk`,
  `notification`, `backup`, `diagnostic`, `init`, `setup`, `kiosk` — server management (remote).
- `registry`, `tunnel` — operate against a registry / StartTunnel server.
- `s9pk`, `init-key`, `pubkey`, `util` — local packaging/dev tooling.
- `echo`, `state`, `git-info` — diagnostics.

Run `start-cli <group> --help` for any group.

## Automatic backup administration

The backup command tree covers the full automatic-backup lifecycle: create and
edit jobs, run or pause them, recover or reassign targets, inspect activity and
checkpoint history, preview and safely apply retention changes, resolve
new-service reviews, and restore selected checkpoints.

For example, this creates an hourly job while retaining hourly checkpoints for
one day and daily checkpoints for one week, then starts its first run:

```sh
start-cli backup estimate-capacity cifs-0 \
  --keep-tier 1h:1d \
  --keep-tier 1d:1w \
  --service-latest-only lnd
start-cli backup job add "Hourly backups" cifs-0 '<MASTER_PASSWORD>' \
  --cron '15 * * * *' \
  --timezone 'America/New_York' \
  --keep-tier 1h:1d \
  --keep-tier 1d:1w \
  --service-latest-only lnd
start-cli backup job list
start-cli backup job run-now <JOB_ID>
```

Use `start-cli backup history list` to obtain checkpoint IDs and
`start-cli package backup restore-checkpoint` to restore them. Retention-policy
updates intentionally use a two-step `backup policy preview-change` then
`backup policy apply` flow; the apply command accepts the exact checkpoint IDs
reported by the preview, preventing a stale policy change from deleting a
different set.

Use repeatable
`--service-keep-tier PACKAGE_ID=INTERVAL:COVERAGE` options or
`--service-latest-only PACKAGE_ID` when a service needs different retention
from the job default. On `backup job edit`,
`--use-default-retention PACKAGE_ID` removes an override.

The user-oriented command guide is in the StartOS
[`start-cli Reference`](../start-os/docs/src/cli-reference.md#backups), while the
generated option-level reference is committed under [`man/`](./man/).

## Features

Cargo features forward to `start-core`: `beta`, `console`, `dev`, `test`, `unstable`.
None are enabled by default.

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the crate is built (entrypoint, request flow, config).
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to contribute.
- [`AGENTS.md`](./AGENTS.md) — agent/dev rules; `CLAUDE.md` is a one-line `@AGENTS.md` import.

## License

MIT. See [LICENSE](../../LICENSE).
