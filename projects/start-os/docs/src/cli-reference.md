# start-cli Reference

The primary CLI for managing a StartOS server. Connect via [SSH](ssh.md) to run commands locally, or use `--host` to manage a server remotely. Pass `-h` at any level to see subcommands and options.

Service developers will find the [S9PK Packaging](#s9pk-packaging) and [Registry](#registry) sections especially useful. The `tunnel` subcommand group is documented separately in the [StartTunnel CLI Reference](/start-tunnel/cli-reference.html).

## Global Options

These apply to all subcommands.

- `-c, --config <PATH>` — Configuration file path
- `-H, --host <URL>` — StartOS server URL
- `-r, --registry <URL>` — Registry URL
- `--registry-hostname <HOST>` — Registry server hostname
- `--s9pk-s3base <URL>` — Base URL for publishing s9pks
- `--s9pk-s3bucket <BUCKET>` — S3 bucket for publishing
- `-t, --tunnel <URL>` — Tunnel server address
- `-p, --proxy <URL>` — HTTP/SOCKS proxy
- `--cookie-path <PATH>` — Cookie file path
- `--developer-key-path <PATH>` — Developer signing key path

## Authentication

Log in, log out, manage sessions, and reset the master password.

### `start-cli auth login`

Log in and create an authenticated session. Required before running any commands against a remote server.

### `start-cli auth logout <SESSION>`

End a specific authentication session.

### `start-cli auth reset-password`

Reset the master password. Must be run locally (via SSH or physical access).

### `start-cli auth get-pubkey`

Retrieve the server's public key.

### `start-cli auth session list`

List all active sessions.

- `--format` — Output format

### `start-cli auth session kill [IDS...]`

Terminate one or more sessions.

## Server

Restart, shut down, update, and configure the server.

### `start-cli server restart`

Restart the server.

### `start-cli server shutdown`

Shut down the server.

### `start-cli server update`

Check the configured registry for OS updates and apply if available.

### `start-cli server update-firmware`

Update the server firmware.

### `start-cli server logs`

Display StartOS system logs.

- `-l, --limit <N>` — Max entries
- `-f, --follow` — Stream in real-time
- `-c, --cursor <POS>` — Start from cursor
- `-B, --before` — Show logs before cursor
- `-b, --boot <ID>` — Filter by boot ID

### `start-cli server kernel-logs`

Display kernel logs. Same options as `server logs`.

### `start-cli server metrics`

Display server metrics (CPU, RAM, disk, temperature).

- `--format` — Output format

### `start-cli server time`

Display server time and uptime.

- `--format` — Output format

### `start-cli server device-info`

Display hardware and device information.

- `--format` — Output format

### `start-cli server rebuild`

Tear down and rebuild all service containers.

### `start-cli server set-hostname [NAME] [HOSTNAME]`

Set the server's name and hostname.

### `start-cli server set-smtp`

Configure SMTP for email notifications.

- `--host <HOST>` — SMTP server hostname (required)
- `--port <PORT>` — SMTP port (required)
- `--from <EMAIL>` — Sender address (required)
- `--username <USER>` — Auth username (required)
- `--password <PASS>` — Auth password
- `--security <MODE>` — `starttls` or `tls` (required)

### `start-cli server test-smtp`

Send a test email to verify SMTP configuration.

- `--host <HOST>` — SMTP server hostname (required)
- `--port <PORT>` — SMTP port (required)
- `--from <EMAIL>` — Sender address (required)
- `--to <EMAIL>` — Recipient address (required)
- `--username <USER>` — Auth username (required)
- `--password <PASS>` — Auth password (required)
- `--security <MODE>` — `starttls` or `tls` (required)

### `start-cli server clear-smtp`

Remove SMTP configuration and credentials.

### `start-cli server set-language <LANGUAGE>`

Set the system display language.

### `start-cli server set-keyboard <KEYBOARD>`

Set the keyboard layout.

### `start-cli server set-echoip-urls [URLS...]`

Set the Echo IP service URLs used for external IP detection.

### `start-cli server experimental governor [SET]`

View or set the CPU governor (e.g., `performance`, `powersave`).

- `--format` — Output format

### `start-cli server experimental zram`

Enable or disable ZRAM compressed swap.

- `--enable` — Enable zram

### Server Host Management

Manage network addresses and bindings for the server UI host.

### `start-cli server host address list`

List all addresses assigned to the server host.

- `--format` — Output format

### `start-cli server host address domain private add <FQDN> <GATEWAY>`

Add a private domain to the server host.

### `start-cli server host address domain private remove <FQDN>`

Remove a private domain from the server host.

### `start-cli server host address domain public add <FQDN> <GATEWAY> <INTERNAL_PORT>`

Add a public domain to the server host.

- `--acme <PROVIDER>` — ACME provider for certificate

### `start-cli server host address domain public remove <FQDN>`

Remove a public domain from the server host.

### `start-cli server host binding list`

List network bindings for the server host.

- `--format` — Output format

### `start-cli server host binding set-address-enabled <INTERNAL_PORT>`

Enable or disable a specific address binding.

- `--address <ADDRESS>` — Address to modify (required)
- `--enabled <true|false>` — Enable or disable

## Services

Install, start, stop, and manage service packages.

### `start-cli package list`

List all installed packages.

- `--format` — Output format

### `start-cli package install [ID] [VERSION]`

Install a package from the registry or sideload a local `.s9pk` file.

- `-s, --sideload` — Install from local file

### `start-cli package start <ID>`

Start a service. Blocked if the service has an unresolved critical task, unless `--force` is passed.

- `--force` — Start even if the service has an unresolved critical task

### `start-cli package stop <ID>`

Stop a running service.

### `start-cli package restart <ID>`

Restart a running service.

### `start-cli package uninstall <ID>`

Remove a package and its data.

### `start-cli package logs <ID>`

Display logs from a service.

- `-l, --limit <N>` — Max entries
- `-f, --follow` — Stream in real-time
- `-c, --cursor <POS>` — Start from cursor
- `-B, --before` — Show logs before cursor
- `-b, --boot <ID>` — Filter by boot ID

### `start-cli package attach <ID> [COMMAND]`

Open a shell inside a service's subcontainer (within the LXC container), or run a one-off command. If the service has only one subcontainer, you are placed directly into it; if there are multiple, you will be prompted to choose. See [Accessing Service Containers](service-containers.md) for details.

- `-s, --subcontainer <NAME>` — Target a specific subcontainer
- `-n, --name <NAME>` — Container name
- `-u, --user <USER>` — Run as a specific user
- `-i, --image-id <ID>` — Image identifier
- `--force-tty` — Force TTY mode

### `start-cli package stats <ID>`

Display LXC container resource usage.

- `--format` — Output format

### `start-cli package rebuild <ID>`

Rebuild a service's container.

### `start-cli package installed-version <ID>`

Show the installed version of a package.

- `--format` — Output format

### `start-cli package cancel-install <ID>`

Cancel a pending install or download.

### `start-cli package set-outbound-gateway <PACKAGE> [GATEWAY]`

Override the outbound gateway for a specific service.

### `start-cli package action run <PACKAGE_ID> <ACTION_ID> <INPUT>`

Run a service action (e.g., show credentials, configure settings).

- `-p, --package-id <ID>` — Package identifier
- `--format` — Output format

### `start-cli package action get-input <ACTION_ID>`

Retrieve the input spec for a service action.

- `-p, --package-id <ID>` — Package identifier
- `--format` — Output format

### `start-cli package action clear-task <PACKAGE_ID> <REPLAY_ID>`

Clear a pending service task.

- `--force` — Force clear even if running

### `start-cli package backup restore <TARGET_ID> <PASSWORD> [IDS...]`

Restore one or more packages from the target's manual checkpoint.

### `start-cli package backup restore-checkpoint <TARGET_ID> <PACKAGE_ID=SNAPSHOT_ID>...`

Restore one or more services from selected automatic checkpoints. Obtain the
snapshot IDs from `start-cli backup history list` or `backup history discover`.

- `--server-id <ID>` — Source StartOS server ID; defaults to this server
- `--password <PASS>` — Master password; required when this server has no saved
  credential for the target

### Service Host Management

Manage network addresses and bindings for a service host.

### `start-cli package host address list`

List all addresses for a service host.

- `--format` — Output format

### `start-cli package host address domain private add <FQDN> <GATEWAY>`

Add a private domain to a service host.

### `start-cli package host address domain private remove <FQDN>`

Remove a private domain from a service host.

### `start-cli package host address domain public add <FQDN> <GATEWAY> <INTERNAL_PORT>`

Add a public domain to a service host.

- `--acme <PROVIDER>` — ACME provider for certificate

### `start-cli package host address domain public remove <FQDN>`

Remove a public domain from a service host.

### `start-cli package host binding list`

List network bindings for a service host.

- `--format` — Output format

### `start-cli package host binding set-address-enabled <INTERNAL_PORT>`

Enable or disable a specific address binding for a service.

- `--address <ADDRESS>` — Address to modify (required)
- `--enabled <true|false>` — Enable or disable

## Backups

Create manual backups; manage automatic jobs, checkpoint history, and retention;
restore checkpoints; and manage backup targets. Commands that return records
accept the standard `--format` option. Use `start-cli backup -h` and the
committed man pages for the complete generated command surface.

### `start-cli backup create <TARGET_ID> <PASSWORD>`

Create a backup of all or selected packages.

- `--old-password <PASS>` — Previous backup password (for re-encryption)
- `--package-ids <IDS>` — Limit to specific packages

### `start-cli backup estimate-capacity <TARGET_ID>`

Estimate per-service automatic-backup storage and next-run staging requirements
before creating a job. With no service filters it includes every currently
installed service; with no version-history rules it estimates latest-only
retention.
The result separates live data, retained and archived checkpoints, staging
headroom, and the conservative projected peak. A job created without filters
also includes services installed in the future, whose size cannot yet be
estimated.

- `--package-ids <IDS>` — Include only comma-separated package IDs
- `--exclude-package-ids <IDS>` — Include current and future services except
  these comma-separated IDs
- `--keep-tier <INTERVAL:COVERAGE>` — Estimate a version-history rule; accepts
  the same repeatable duration syntax as `backup job add`
- `--service-keep-tier <PACKAGE_ID=INTERVAL:COVERAGE>` — Estimate a retention
  rule for one service; repeat the option to add more rules or services
- `--service-latest-only <PACKAGE_ID>` — Estimate latest-checkpoint-only
  retention for one or more comma-separated service IDs

### Automatic backup jobs

#### `start-cli backup job list`

List automatic backup jobs, their IDs, schedules, target state, and next-run
status.

#### `start-cli backup job add <NAME> <TARGET_ID> <PASSWORD>`

Create an automatic backup job. It defaults to all current and future services,
daily at 03:00 UTC, and latest-checkpoint-only retention.

- `--cron <CRON>` — Five-field cron schedule. For example, `15 * * * *` runs at
  15 minutes past every hour.
- `--timezone <ZONE>` — IANA timezone; defaults to `UTC`
- `--package-ids <IDS>` — Include only comma-separated package IDs
- `--exclude-package-ids <IDS>` — Include current and future services except
  these comma-separated IDs
- `--keep-tier <INTERVAL:COVERAGE>` — Retain versions at this interval for this
  coverage. Repeat for multiple rules; suffixes are `s`, `m`, `h`, `d`, and `w`.
  For example, `--keep-tier 1h:1d --keep-tier 1d:1w` retains hourly versions for
  one day and daily versions for one week.
- `--service-keep-tier <PACKAGE_ID=INTERVAL:COVERAGE>` — Override retention for
  one service. Repeat it to build multiple rules or configure more services.
- `--service-latest-only <PACKAGE_ID>` — Override one or more comma-separated
  services to retain only their latest checkpoint.
- `--disabled` — Create the job paused

Run `start-cli backup job run-now <ID>` after creating the job when you want the
first backup immediately.

#### `start-cli backup job edit <ID>`

Update only the supplied job settings. Schedule flags, service-selection flags,
and repeated `--keep-tier` values use the same forms as `job add`.

- `--name <NAME>` — Change the display name
- `--all-services` — Include every current and future service
- `--latest-only` — Replace version-history rules with the newest checkpoint only
- `--service-keep-tier <PACKAGE_ID=INTERVAL:COVERAGE>` — Add or replace a
  service-specific retention policy; repeat for multiple rules
- `--service-latest-only <PACKAGE_ID>` — Set comma-separated services to
  latest-checkpoint-only retention
- `--use-default-retention <PACKAGE_ID>` — Remove service-specific overrides
  from comma-separated services so they inherit the job default

#### Job state and target recovery

- `start-cli backup job enable <ID>` — Resume an automatic job
- `start-cli backup job disable <ID>` — Pause an automatic job
- `start-cli backup job delete <ID>` — Delete the job definition
- `start-cli backup job run-now <ID>` — Run the job immediately
- `start-cli backup job retry-target <TARGET_ID> <PASSWORD>` — Reconnect a
  target and resume its paused jobs
- `start-cli backup job reassign-target <ID> <TARGET_ID> <PASSWORD>` — Move a
  job to another target. Pass `--wait-for-schedule` to avoid an immediate run.

### Activity and checkpoint history

- `start-cli backup activity list` — List manual backup, automatic backup, and
  restore activity
- `start-cli backup history list` — List automatic checkpoint history known to
  this server
- `start-cli backup history discover <TARGET_ID> <SERVER_ID> <PASSWORD>` — Read
  automatic history directly from an encrypted target
- `start-cli backup history delete-archived` — Delete selected archived
  checkpoint IDs for a target and package. Active checkpoints are rejected; use
  the command's `-h` output for positional argument details.

### Retention policies

Preview every retention change before applying it:

```sh
start-cli backup policy preview-change cifs-0 bitcoind --keep-tier 1h:1d --keep-tier 1d:1w
```

Then apply the identical policy and repeat `--confirm-removal` for every
checkpoint ID listed in the preview:

```sh
start-cli backup policy apply cifs-0 bitcoind --keep-tier 1h:1d --keep-tier 1d:1w \
  --confirm-removal <CHECKPOINT_ID>
```

Use `--latest-only` instead of `--keep-tier` to retain only the newest automatic
checkpoint. Apply fails if the confirmation set differs from a fresh preview,
which prevents stale or unintended deletion.

### UI and CLI action parity

Every backup action exposed by the StartOS UI has a `start-cli` command:

- backup locations use `backup target list`, `backup target cifs add|update|remove`,
  and `backup target delete-legacy`;
- one-time backups use `backup create`;
- automatic jobs use `backup job list|add|edit|enable|disable|run-now|delete`,
  with `retry-target` and `reassign-target` for repair;
- estimates, activity, history, version-history changes, and new-service
  decisions use `backup estimate-capacity`, `backup activity`, `backup history`,
  `backup policy`, and `backup review`;
- manual restores use `package backup restore`, automatic restores use `package
  backup restore-checkpoint`, and a UI-style selection mixing manual and
  automatic checkpoints uses `package backup restore-mixed` with repeatable
  `--checkpoint PACKAGE_ID=SNAPSHOT_ID` values and `--manual-ids`.

### New-service reviews

- `start-cli backup review list` — List newly installed services awaiting a
  decision for selective automatic jobs
- `start-cli backup review decide <PACKAGE_ID> --decision <JOB_ID=add|skip>` —
  Add or skip the service for an affected job. Repeat `--decision` for every
  listed job.

### Backup targets

#### `start-cli backup target list`

List configured backup targets.

- `--format` — Output format

`start-cli backup targets` is a direct list-only shortcut.

#### `start-cli backup target info <TARGET_ID> <SERVER_ID> <PASSWORD>`

Display backup information for a target.

- `--format` — Output format

#### `start-cli backup target mount <TARGET_ID> <PASSWORD>`

Mount a backup target.

- `--server-id <ID>` — Server identifier
- `--allow-partial` — Leave media mounted even if backupfs fails

#### `start-cli backup target umount [TARGET_ID]`

Unmount a backup target.

#### `start-cli backup target cifs add <HOSTNAME> <PATH> <USERNAME> [PASSWORD]`

Add a new CIFS/SMB network share as a backup target.

#### `start-cli backup target cifs update <ID> <HOSTNAME> <PATH> <USERNAME> [PASSWORD]`

Update an existing CIFS backup target.

#### `start-cli backup target cifs remove <ID>`

Remove a CIFS backup target.

## Networking

Manage gateways, DNS, ACME certificates, tunnels, port forwards, and SSL vhosts.

### `start-cli net gateway list`

List all gateways.

- `--format` — Output format

### `start-cli net gateway set-name <GATEWAY> <NAME>`

Rename a gateway.

### `start-cli net gateway set-default-outbound <GATEWAY>`

Set the default outbound gateway for all services.

### `start-cli net gateway check-dns <GATEWAY>`

Test DNS resolution through a gateway.

- `--format` — Output format

### `start-cli net gateway check-port <GATEWAY>`

Test port connectivity through a gateway.

- `--format` — Output format

### `start-cli net gateway forget <GATEWAY>`

Remove a gateway from the system.

### `start-cli net dns set-static [SERVERS...]`

Set static DNS server addresses.

### `start-cli net dns query <FQDN>`

Test DNS resolution for a domain.

- `--format` — Output format

### `start-cli net dns dump-table`

Display the full DNS routing table.

- `--format` — Output format

### `start-cli net ssl generate-certificate <HOSTNAMES>...`

Generate an SSL certificate signed by the system Root CA. The command outputs the private key and full certificate chain in PEM format.

- `HOSTNAMES` — One or more hostnames or IP addresses to include in the certificate (required)
- `--ed25519` — Use Ed25519 instead of the default NIST P-256

### `start-cli net acme init`

Initialize ACME (Let's Encrypt) certificate provisioning.

- `--provider <PROVIDER>` — ACME provider identifier or URL (required)
- `--contact <EMAIL>` — Contact email for the certificate authority

### `start-cli net acme remove`

Remove ACME certificate configuration.

- `--provider <PROVIDER>` — ACME provider to remove (required)

### `start-cli net tunnel add <NAME> <CONFIG> [GATEWAY_TYPE]`

Add a WireGuard tunnel gateway.

- `--set-as-default-outbound` — Use this tunnel as the default outbound gateway
- `GATEWAY_TYPE` — `inbound-outbound` or `outbound-only`

### `start-cli net tunnel remove <ID>`

Remove a tunnel gateway.

### `start-cli net forward dump-table`

Display the port forwarding table.

- `--format` — Output format

### `start-cli net vhost add-passthrough`

Add an SSL passthrough vhost.

- `--hostname <HOST>` — Hostname (required)
- `--listen-port <PORT>` — Listen port (required)
- `--backend <ADDR>` — Backend address (required)
- `--public-gateway <ID>` — Public gateway
- `--private-ip <IP>` — Private IP

### `start-cli net vhost remove-passthrough`

Remove an SSL passthrough vhost.

- `--hostname <HOST>` — Hostname (required)
- `--listen-port <PORT>` — Listen port (required)

### `start-cli net vhost list-passthrough`

List SSL passthrough vhosts.

- `--format` — Output format

### `start-cli net vhost dump-table`

Display the full vhost routing table.

- `--format` — Output format

## SSH Keys

Manage authorized SSH keys for server access.

### `start-cli ssh add <KEY>`

Add an SSH public key.

### `start-cli ssh list`

List authorized SSH keys.

- `--format` — Output format

### `start-cli ssh remove <KEY>`

Remove an SSH key.

## WiFi

Connect to and manage wireless networks.

### `start-cli wifi add <SSID> <PASSWORD>`

Save a WiFi network and its credentials.

### `start-cli wifi connect <SSID>`

Connect to a saved WiFi network.

### `start-cli wifi remove <SSID>`

Remove a saved WiFi network.

### `start-cli wifi get`

Display the current WiFi connection.

- `--format` — Output format

### `start-cli wifi available`

List available WiFi networks.

- `--format` — Output format

### `start-cli wifi available get <SSID>`

Get details of a specific available network.

- `--format` — Output format

### `start-cli wifi country`

Display the current WiFi country code.

- `--format` — Output format

### `start-cli wifi country set <COUNTRY>`

Set the WiFi country code (ISO 3166-1 alpha-2).

### `start-cli wifi set-enabled`

Enable or disable WiFi.

- `--enabled` — Enable WiFi

## Notifications

View and manage system notifications.

### `start-cli notification list [BEFORE] [LIMIT]`

List notifications.

- `--format` — Output format

### `start-cli notification create <LEVEL> <TITLE> <MESSAGE>`

Create a notification.

- `-p, --package <ID>` — Associate with a package

### `start-cli notification mark-seen [IDS...]`

Mark notifications as read.

### `start-cli notification mark-seen-before <BEFORE>`

Mark all notifications before an ID as read.

### `start-cli notification mark-unseen [IDS...]`

Mark notifications as unread.

### `start-cli notification remove [IDS...]`

Delete notifications.

### `start-cli notification remove-before <BEFORE>`

Delete all notifications before an ID.

## Kiosk Mode

Control the local display.

### `start-cli kiosk enable`

Enable kiosk mode on the connected display.

### `start-cli kiosk disable`

Disable kiosk mode.

## Disks

List and repair storage devices.

### `start-cli disk list`

List all disks and partitions.

- `--format` — Output format

### `start-cli disk repair`

Repair filesystem issues on the data partition.

## Diagnostics

Troubleshoot issues when the system is in diagnostic mode.

### `start-cli diagnostic logs`

Display diagnostic logs. Same log options as `server logs`.

### `start-cli diagnostic kernel-logs`

Display diagnostic kernel logs. Same log options as `server logs`.

### `start-cli diagnostic error`

Display the current diagnostic error.

- `--format` — Output format

### `start-cli diagnostic restart`

Restart the server from diagnostic mode.

### `start-cli diagnostic rebuild`

Rebuild all containers from diagnostic mode.

### `start-cli diagnostic disk forget <GUID>`

Forget a disk so the system no longer expects it.

### `start-cli diagnostic disk repair`

Repair a disk from diagnostic mode.

## Database

Low-level access to the system database.

### `start-cli db dump [-p <POINTER>] [PATH]`

Dump database contents, optionally filtered by JSON pointer.

- `-p, --pointer <PTR>` — JSON pointer to a specific value
- `--format` — Output format

### `start-cli db apply <EXPR> [PATH]`

Apply a patch expression to the database.

### `start-cli db put [PATH] [VALUE]`

Set a value in the database.

### `start-cli db put-ui [PATH] [VALUE]`

Set a value in the UI database.

## S9PK Packaging

Build, inspect, edit, and publish service packages.

### `start-cli s9pk init-workspace [PATH]`

Initialize a StartOS packaging workspace in PATH (default: the current directory). Clones the packaging guide, writes the agent-context files (`AGENTS.md`, `AGENTS.local.md`, `CLAUDE.md`), and creates a `.startos/` directory holding the workspace signing key and host/registry config. Nesting is allowed; it refuses to run inside a package repo. See [Set Up Your Packaging Workspace](/packaging/environment-setup.html#set-up-your-packaging-workspace).

### `start-cli s9pk init-package <NAME>`

Scaffold a new package from the current workspace's template, using NAME (e.g. `"Hello World"`) as the human-readable package name, then run `npm install`. Must be run inside a workspace.

### `start-cli s9pk pack [PATH]`

Build an s9pk package from source files.

- `-o, --output <PATH>` — Output file path
- `--javascript <PATH>` — JavaScript bundle path
- `--icon <PATH>` — Service icon path
- `--license <PATH>` — License file path
- `--assets <PATH>` — Assets directory path
- `--no-assets` — Build without assets
- `--arch <ARCH>` — Filter by CPU architecture

### `start-cli s9pk publish <S9PK>`

Publish an s9pk to the configured S3 bucket and index it on the registry.

### `start-cli s9pk convert <S9PK>`

Convert an s9pk from v1 to v2 format.

### `start-cli s9pk select [S9PKS...]`

Select the best compatible s9pk for the target device from a list.

### `start-cli s9pk list-ingredients [PATH]`

List all file paths that would be included in a pack. Same options as `s9pk pack`.

### `start-cli s9pk inspect manifest`

Display the package manifest.

- `--format` — Output format

### `start-cli s9pk inspect file-tree`

Display the file tree inside the s9pk.

- `--format` — Output format

### `start-cli s9pk inspect cat <FILE_PATH>`

Extract and display a file from the s9pk.

### `start-cli s9pk inspect commitment`

Display the root sighash and max size.

- `--format` — Output format

### `start-cli s9pk edit manifest <EXPRESSION>`

Apply a patch expression to the manifest.

- `--format` — Output format

### `start-cli s9pk edit add-image <ID>`

Add a container image to the s9pk.

- `--docker-build` — Build from Dockerfile
- `--dockerfile <PATH>` — Dockerfile path
- `--workdir <PATH>` — Build context directory
- `--docker-tag <TAG>` — Docker image tag
- `--arch <ARCH>` — CPU architecture filter
- `--emulate-missing-as <ARCH>` — Emulate missing arch
- `--nvidia-container` — Enable NVIDIA support

## Registry

Manage a StartOS package registry — the server that hosts, indexes, and distributes s9pk packages and OS updates. These commands can be run remotely via `start-cli registry`, or locally on the registry server using the standalone `start-registry` binary (same subcommands, different entry point).

### `start-cli registry index`

List registry metadata and all packages.

- `--format` — Output format

### `start-cli registry info`

Display the registry name and icon.

- `--format` — Output format

### `start-cli registry info set-name <NAME>`

Set the registry's display name.

### `start-cli registry info set-icon <ICON>`

Set the registry's icon from a file path.

### Registry Admin Management

Manage registry administrators and their signing keys.

### `start-cli registry admin add <SIGNER> [DATABASE]`

Add a signer as an administrator.

### `start-cli registry admin remove <SIGNER>`

Remove an administrator.

### `start-cli registry admin list`

List all administrators.

- `--format` — Output format

### `start-cli registry admin signer add [DATABASE]`

Register a new signer identity.

- `-n, --name <NAME>` — Signer display name (required)
- `-c, --contact <INFO>` — Contact information
- `--key <KEY>` — Public key

### `start-cli registry admin signer edit <ID>`

Edit a signer's metadata.

- `-n, --set-name <NAME>` — Update name
- `-c, --add-contact <INFO>` — Add contact
- `-k, --add-key <KEY>` — Add public key
- `-C, --remove-contact <INFO>` — Remove contact
- `-K, --remove-key <KEY>` — Remove public key

### `start-cli registry admin signer list`

List all registered signers.

- `--format` — Output format

### Registry Package Management

Add, remove, index, and distribute service packages.

### `start-cli registry package index`

List all packages and categories.

- `--format` — Output format

### `start-cli registry package add <FILE>`

Add a package to the registry from a local s9pk file.

- `--url <URL>` — URL of the package
- `--no-verify` — Skip signature verification

### `start-cli registry package remove <ID> <VERSION>`

Remove a package version from the registry.

- `--sighash <HASH>` — Hash for signature verification

### `start-cli registry package get [ID] [OTHER_VERSIONS]`

List installation candidates for a package.

- `-v, --target-version <RANGE>` — Version range constraint
- `--source-version <VERSION>` — Source version for upgrade path
- `--format` — Output format
- `OTHER_VERSIONS` — Detail level: `none`, `short`, or `full`

### `start-cli registry package download <ID>`

Download an s9pk package file.

- `-v, --target-version <RANGE>` — Version constraint
- `-d, --dest <PATH>` — Destination path

### `start-cli registry package add-mirror <FILE> <URL>`

Add a download mirror for a package.

- `--no-verify` — Skip signature verification

### `start-cli registry package remove-mirror <ID> <VERSION>`

Remove a package mirror.

- `--url <URL>` — Mirror URL to remove (required)

### Registry Package Categories

Organize packages into browseable categories.

### `start-cli registry package category add <ID> <NAME>`

Create a new category.

### `start-cli registry package category remove <ID>`

Delete a category.

### `start-cli registry package category list`

List all categories.

- `--format` — Output format

### `start-cli registry package category add-package <ID> <PACKAGE>`

Add a package to a category.

### `start-cli registry package category remove-package <ID> <PACKAGE>`

Remove a package from a category.

### Registry Package Signers

Manage cryptographic signers authorized for packages.

### `start-cli registry package signer add <ID> <SIGNER>`

Authorize a signer for a package.

- `--versions <RANGE>` — Version range to authorize
- `--merge` — Merge with existing range instead of replacing

### `start-cli registry package signer remove <ID> <SIGNER>`

Revoke a signer for a package.

### `start-cli registry package signer list <ID>`

List authorized signers for a package.

- `--format` — Output format

### Registry OS Versions

Manage StartOS version records in the registry.

### `start-cli registry os index`

List all OS versions.

- `--format` — Output format

### `start-cli registry os version add <VERSION> <HEADLINE> <RELEASE_NOTES> <SOURCE_VERSION>`

Register a new OS version.

### `start-cli registry os version get`

Get OS version information with filters.

- `--src <VERSION>` — Source version to upgrade from
- `--target-version <VERSION>` — Target version constraint
- `--id <SERVER_ID>` — Server identifier
- `--platform <PLATFORM>` — Target platform
- `--format` — Output format

### `start-cli registry os version remove <VERSION>`

Remove an OS version.

### `start-cli registry os version signer add <VERSION> <SIGNER>`

Add a signer for an OS version.

### `start-cli registry os version signer remove <VERSION> <SIGNER>`

Remove a signer from an OS version.

### `start-cli registry os version signer list <VERSION>`

List signers for an OS version.

- `--format` — Output format

### Registry OS Assets

Upload and manage OS installation images (IMG, ISO, squashfs).

### `start-cli registry os asset add <FILE> <URL>`

Upload an OS asset to the registry.

- `-p, --platform <PLATFORM>` — Target platform (required)
- `-v, --version <VERSION>` — OS version (required)

### `start-cli registry os asset sign <FILE>`

Sign an OS asset and register the signature.

- `-p, --platform <PLATFORM>` — Target platform (required)
- `-v, --version <VERSION>` — OS version (required)

### `start-cli registry os asset remove`

Remove an OS asset.

### `start-cli registry os asset get img <VERSION> <PLATFORM>`

Download an IMG file.

- `-d, --download <DIR>` — Download directory
- `-r, --reverify` — Verify hash after download

### `start-cli registry os asset get iso <VERSION> <PLATFORM>`

Download an ISO file. Same options as `get img`.

### `start-cli registry os asset get squashfs <VERSION> <PLATFORM>`

Download a squashfs file. Same options as `get img`.

### Registry Database

Low-level access to the registry database.

### `start-cli registry db dump [-p <POINTER>] [PATH]`

Dump database contents, optionally filtered by JSON pointer.

- `-p, --pointer <PTR>` — JSON pointer
- `--format` — Output format

### `start-cli registry db apply <EXPR> [PATH]`

Apply a patch expression to the database.

## Initial Setup

Commands for the first-boot setup process.

### `start-cli setup disk`

Configure the data disk during initial setup.

### `start-cli setup cifs`

Configure a CIFS/SMB network share during initial setup.

### `start-cli setup logs`

Display setup logs. Same log options as `server logs`.

### `start-cli init subscribe`

Stream initialization progress events.

### `start-cli init logs`

Display initialization logs. Same log options as `server logs`.

### `start-cli init kernel-logs`

Display initialization kernel logs. Same log options as `server logs`.

### `start-cli init-key`

Create a new developer signing key.

## Utilities

### `start-cli echo <MESSAGE>`

Echo a message back from the server. Useful for testing connectivity.

### `start-cli flash-os <SQUASHFS> <DISK>`

Flash a StartOS image to a drive.

- `--efi <true|false>` — Use EFI boot mode

### `start-cli git-info`

Display the git hash of this build.

### `start-cli pubkey`

Display the developer public key.

### `start-cli state`

Display the current API specification.

### `start-cli util b3sum <FILE>`

Calculate the BLAKE3 hash of a file.

- `--no-mmap` — Disable memory-mapped I/O
