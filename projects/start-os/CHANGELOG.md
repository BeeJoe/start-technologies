# Changelog

All notable changes to the StartOS OS product are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and StartOS
uses an [extended version](https://docs.start9.com) of semantic versioning.

Full per-release notes are published on the
[GitHub releases page](https://github.com/Start9Labs/start-technologies/releases). This
file tracks notable changes since the move to the monorepo.

## [0.4.0-beta.10]

### Added

- **Automatic backups.** StartOS can protect System data plus selected current
  and future services on one or more hourly, daily, weekly, or monthly schedules; estimate required
  capacity; retain configurable version history, including when a schedule
  reuses or changes an existing history; preserve unreferenced
  checkpoints as archives; recover or reassign unavailable locations; and
  restore a different manual or automatic checkpoint for each service. Backup
  activity, actionable notifications, and new-service selection reviews keep
  the scheduled lifecycle visible and recoverable.
- **In-place 0.3.5.1 → 0.4.0 update path.** Updating the OS from 0.3.5.1 no longer
  requires syncing a whole root filesystem file-by-file — the step that grew
  flakier the more files a device had. StartOS 0.3.5.1's existing over-the-air
  updater instead receives a compact migration payload (the 0.4.0 base image plus
  a boot-time rewire) and the 0.4.0 initramfs converts the on-disk layout to the
  0.4.0 format on first boot. The data partition is preserved and the existing
  package/database migration runs afterward as before.

- **IPv6 GUA exposure control.** On a service interface, an IPv6 global-unicast
  address (GUA) keeps the usual on/off toggle and adds a **Local / Public**
  dropdown in the access column. **Local** (the default) keeps it reachable on
  the local network only — traffic from outside the subnet is rejected;
  **Public** exposes it to the Internet and attempts an automatic gateway
  pinhole (PCP). The choice is carried by the address's `public` flag, so
  services selecting addresses for P2P see the correct reachability. A GUA on a
  StartOS-terminated SSL port is served by the host's own TLS listener; a port
  StartOS does not terminate is forwarded (DNAT) directly to the service
  container. IPv6 ULAs and IPv4 are unchanged.
- **DualStack public domains.** A public (clearnet) domain is now reachable over
  both IPv4 and IPv6 whenever its gateway has an IPv6 global-unicast address
  (GUA). StartOS advertises an `AAAA` target (the GUA) alongside the `A` target,
  opens an inbound IPv6 firewall pinhole for the domain's port (via PCP — v6 is
  NAT-free, so there is nothing to forward), and serves the domain on the GUA
  through its existing SNI-routed TLS listener. The bare GUA itself is not
  exposed — only traffic matching the domain by SNI is accepted — so an SSL
  domain needs no separate GUA WAN opt-in (a plaintext domain, which has no SNI
  to filter on, exposes the GUA the same way it exposes the WAN IPv4). The
  add-domain DNS check and the domain setup modal now verify and display both
  the `A`/IPv4 and `AAAA`/IPv6 records and reachability; IPv6 reachability is its
  own `net.gateway.check-port-v6` endpoint (separate from the IPv4
  `net.gateway.check-port`) so each family is probed independently.
- **`--force` on service start.** `start-cli package start <id> --force` (and the
  `package.start` RPC `force` flag) starts a service even when it has an unresolved
  critical task.
- **Automatic gateway configuration (#3306).** A StartOS server now opens its own public ports and publishes its private-domain DNS by talking to its gateway — a home router or a StartTunnel — instead of leaving it as a manual step.
  - **Automatic port forwarding.** When a public address needs a port open, StartOS opens it by speaking a port-control protocol to the gateway: PCP (RFC 6887) → NAT-PMP → UPnP IGD, in that order. Mappings are reference-counted and withdrawn when the address is disabled or deleted; each active mapping is renewed at about half its gateway-granted lease, well before it would expire, so a still-wanted forward is never dropped, and letting a mapping lapse (no further renewal) is itself a teardown path once an exposure goes away. A single shared `PortMapController` also answers reachability, so `check_port` skips the remote echo probe when an automatic mapping is already active and reports the gateway-assigned external IP directly. Port mapping is scoped to the gateway each exposure actually routes through (the interface's own subnet gateway), so the box never probes an unrelated LAN router. A port's forwards and mappings are driven only by the addresses advertised at that exact port — exposing an SSL address never opens its plaintext sibling.
  - **Private-domain DNS injection (RFC 2136).** When a private domain is enabled on a gateway, StartOS pushes an `A` record (domain → this host's IP on that subnet) to the gateway's DNS server via DNS UPDATE so LAN devices that don't use StartOS's resolver can still resolve it, and withdraws it on disable/delete. `check_dns` now verifies a private domain by resolving the specific FQDN against the LAN's DNS server(s) and confirming it returns one of this server's LAN addresses.
  - **PCP HOSTNAME extension (SNI demux).** SSL/TLS services can share a single external port (443) across many hostnames: the gateway demultiplexes inbound TLS by SNI. StartOS emits PCP HOSTNAME mappings for public-domain vhosts (PCP-only — NAT-PMP/UPnP can't demux), gated by a PCP ANNOUNCE capability probe so the option is only sent to gateways that understand it. The protocol is documented as an Internet-Draft (`rfcs/draft-start9-pcp-hostname`).
  - **PCP PORT_SET (RFC 7753).** A contiguous port range maps in a single PCP MAP instead of per-port sweeps.
  - **Per-gateway capability tracking, sharding, and backoff.** Each gateway's PCP/NAT-PMP/UPnP support (and the PCP HOSTNAME extension) is recorded on the gateway in the database — fed by periodic watcher probes and by the outcome of every mapping attempt — so a gateway that refuses a protocol stops being asked instead of paying a timeout per attempt (a yes is trusted for an hour, a no re-probed after five minutes). Mapping work is sharded per gateway interface, so one gateway's slow or absent answers never delay another gateway's mappings, and a mapping that keeps failing backs off exponentially (15 seconds, doubling to a 16-minute cap) rather than retrying on a fixed interval.
  - **In-place WireGuard gateway updates.** `start-cli net tunnel update <id> <config>` (and a per-gateway **Update config** UI action) re-issues a WireGuard config onto the existing interface without churning the gateway identity, so forwards and public/private domains keyed to it survive the swap — primarily to add a `DNS =` line to an existing config. The update path uses NetworkManager `Update2` + `Device.Reapply`, so updating the gateway carrying the request no longer drops its own transport. Because NetworkManager (≤ 1.52) strips WireGuard peer preshared-keys on `Reapply` even when they are passed to it explicitly, StartOS re-applies each peer's PSK straight to the kernel device (over stdin, never argv) after the reapply, so the tunnel keeps its shared secret.
  - **Best-effort HTTP→HTTPS redirect (IPv6).** When a service is publicly exposed on 443 over an IPv6 GUA, StartOS asks the gateway for an `80→443` redirect pinhole so plain `http://` auto-redirects to `https`. Over IPv4 no such map is requested — the upstream gateway (e.g. StartTunnel, which serves a port-80 redirect by default) handles it.
  - **Insecure exposures never reach the WAN.** A port is opened to the public internet (an IPv4 WAN forward, an IPv6 GUA pinhole/forward, or an upstream port-map) only when the exposure is itself secure — TLS on the wire or a self-securing protocol. A plaintext exposure can still reach the LAN over a gateway explicitly marked secure, but the WAN is treated as never secure regardless of the gateway's setting.
- **Private domains on StartTunnel gateways (ba5396f49).** Now that a StartTunnel proxies DNS per subnet, a private domain resolves for tunnel clients (their DNS forwards to this server, which answers with the gateway's tunnel address), so the UI no longer restricts the public/private domain picker to router gateways — all gateways can use it. The "DNS Server Config" guidance is now gateway-aware: for a tunnel gateway it instructs you to point the StartTunnel subnet's DNS at this server. The private-domain and clearnet setup dialogs also surface the automatic alternatives (enable DNS Injection for the device; automatic UPnP/NAT-PMP/PCP port forwarding) instead of describing only the manual paths.
- **`MultiHost.bindPortRange` backend (#3270).** Host support for reserving a contiguous TCP+UDP port range (2–500 ports) in one call, stored as a single `RangeBindInfo` record under `Host.binding_ranges` and installed as one nftables rule per chain (via `PortForward.count`). Intended for real-time / WebRTC servers (coturn, RTP, SIP). Backed by the new `bindRange` effect.
- **Package init progress reporting (#3323).** A service can stream progress during the install/update finalization phase via the new `setInitProgress` effect; the host nests it inside the install's finalization phase using the standard `FullProgress` wire format, and `setupInit` auto-reports one step per composed init handler.
- **Phased backup progress (#3250).** `serverInfo.statusInfo.backupProgress` now uses the standard `FullProgress` shape (matching update/install progress). `NamedProgress.progress` is generalized to `PhaseProgress` so a phase can carry sub-phases, and the new `setBackupProgress` effect lets a service container stream its own backup sub-progress.
- **Backup format v2 (#3289).** Backups are written to a new `StartOSBackupsV2` directory, and the backup report now includes per-package duration. The backup targets list shows the free space available on every drive and network folder so the user can confirm a backup will fit before starting it. When this server's pre-v2 `StartOSBackups/<server-id>` backup is present on the selected target, the UI additionally warns before backup, then confirms the format change (#3324, `backup.target.legacy-info` RPC). Once migrated, StartOS also helps remove the now-obsolete V1 data: after a backup completes, if the target still holds this server's V1 backup, a warning notification reminds the user it is no longer needed; and the backup-create page shows a **Delete old backup** action for any target holding this server's V1 backup — whether or not a new (V2) backup exists yet — removing only this server's old backup; other servers' backups and `StartOSBackupsV2` are untouched (`backup.target.delete-legacy` RPC). Deletion returns immediately — the backup is atomically moved to a hidden trash folder on the target — and its space is reclaimed by a background sweep that posts a notification when it finishes (unlinking a large backup can take hours on some filesystems); a backup started while reclamation is pending finishes it first, shown as a `Reclaiming Space` phase in the backup's progress. Deleting requires a confirmation, plus an extra confirmation when this server has no current (V2) backup on the target (so the user can't unknowingly delete their only backup). Legacy detection and deletion are scoped to the current server's ID, so a target shared by several servers no longer flags or removes another server's backup.
- **Direct cross-package action runs via `access` (#3267).** Action metadata gains an `access` field (`'public' | 'dependent' | 'user'`, default `'user'`) controlling who may invoke an action directly through `effects.action.run`. Public/dependent actions give dependents a direct path instead of only creating a task; direct runs still honor the action's `visibility` and `allowedStatuses`.
- **`input-not-matches` tasks accept multiple values (#3310).** `TaskInput` splits into `accept` (a list of acceptable partial inputs) and `set` (the value to prefill when none match); the cross-package critical-conflict guard fires only when the input conflicts with every `accept` entry. The host still accepts the legacy `{ value }` shape over the effects socket for s9pks built on the pre-2.0 SDK.
- **Service interfaces tab.** Service interfaces are promoted to a dedicated sidebar tab; the dashboard interfaces card and per-interface detail route are removed, sidebar nav labels are decoupled from route paths, and the tasks table is redesigned (action-first, service rendered as an icon).
- **Unified marketplace + brochure.** The in-OS marketplace and the public brochure now share `@start9labs/marketplace` components behind an `AbstractMarketplaceService` (the OS persists to patch-db, the brochure to localStorage), so both ship the identical detail/preview UI. The brochure app is ported into the workspace and auto-deployed to `marketplace.start9.com` on master. The registry-selection modal is replaced by an inline registry-select dropdown (switch/add/delete inline), and custom registries can now be added by bare domain (https default; http for `.onion`) (#3349). Empty categories are hidden (snapping back to "all" on a registry switch that empties the selection), category icons are refreshed for the current set, and a "Package a service" link sits beneath the sidebar categories.
- **Nested idmapped mounts (#3248).** StartOS gains syscall-based mount primitives (`open_tree`/`move_mount`/`fsopen`/`mount_setattr`) and a `start-container mount` path, wiring up the SDK's `idmap` field on volume/asset/dependency/backup mounts end-to-end. See [`../start-sdk/CHANGELOG.md`](../start-sdk/CHANGELOG.md) for the SDK-facing surface.
- **Raspberry Pi image hardening (#3249).** Vendor kernel bumped to 6.18.33+rpt with apt pins so `/boot` stays vendor-only, `earlycon` for first-boot diagnostics, a loop-safe self-diagnosing `init_resize`, and data-drive-only setup for pre-installed devices.
- **Graceful shutdown on external power events (#3319).** Two systemd pre-shutdown barrier units (`startos-shutdown.service` / `startos-restart.service`) call `start-cli server shutdown/restart` and wait for graceful container teardown, so externally-initiated shutdowns (UPS / `qm` / ACPI) tear services down cleanly. The shutdown/restart RPC gains an opt-in `wait` param.
- **iOS root-CA install via configuration profile (#3240).** A new endpoint serves an unsigned Apple Configuration Profile (`PayloadType com.apple.security.root`); iOS/iPadOS download links are UA-sniffed and routed to `.mobileconfig`, fixing the broken `.crt` install flow on iOS 26.5 Safari.
- **`diagnose-hang` capture script (#3236).** Captures startd runtime state entirely via `/proc` and basic tools (per-thread kernel stacks, fds/sockets, journal tail, dmesg, disk health, lxc status) when startd is unresponsive and `start-cli` can't help.
- **`lo` and `lxcbr0` treated as secure networks (#3297)** for insecure (plain-HTTP) traffic, since loopback and the container bridge never leave the host; an explicit secure setting still overrides the intrinsic default.
- **In-place 0.3.5.1 → 0.4.0 update path.** Updating the OS from 0.3.5.1 no longer
  requires syncing a whole root filesystem file-by-file — the step that grew
  flakier the more files a device had. StartOS 0.3.5.1's existing over-the-air
  updater instead receives a compact migration payload (the 0.4.0 base image plus
  a boot-time rewire) and the 0.4.0 initramfs converts the on-disk layout to the
  0.4.0 format on first boot. The data partition is preserved and the existing
  package/database migration runs afterward as before.

### Changed

- **Unified automatic schedule editing.** Multiple schedules now expand first
  into a compact, unboxed schedules list with icon-only switches, three-dot
  menus containing **Run now**, **View/Edit**, and a red **Delete schedule**
  action, plus selected-service counts. The one-schedule card right-aligns its
  switch, shows a **Paused** badge when off, and replaces its expand arrow with
  a three-dot menu that also offers **Add schedule** and **Delete schedule**.
  Opening one schedule collapses the list to a **View all schedules** card,
  while **Add schedule** sits below the list and focuses the schedule name. Any
  exit from a changed editor other than **Save** now asks for confirmation before
  discarding changes, including **Back**, changing panels, navigating, and closing
  the page.
  The unchanged **Default** name stays hidden while it is the only schedule;
  renamed schedules remain editable, and every name is editable once multiple
  schedules exist.
  Saving or canceling an edit collapses the full Automatic backups card; the
  schedules list appears when a multi-schedule card is expanded again. Monthly
  schedules add a day-of-month choice and
  use the month's last available day when the 30th or 31st does not exist. The
  collapsed main card surfaces enabled schedules needing attention and clears
  the warning after success or when a failed schedule is turned off. Service
  selection is collapsed by default behind a heading that summarizes the
  selected-service count and future-service policy. Version history requires a
  frequency, removes the custom option and retention-overrides editor, aligns
  repeated **Keep one backup every** rows, summarizes every configured tier,
  and lets every row be removed; removing the last row restores the latest-only
  default. Existing
  nonstandard CLI-created retention tiers remain exact until their row is
  changed. Hour and minute choices can no longer be cleared to an invalid null
  value. Every schedule, including the first or only one, puts **Delete
  schedule** opposite **Save**, with a confirmation option that changes the
  action to **Delete Schedule and Backups** when deleting checkpoints used only
  by that schedule, under the **Delete backup schedule?** heading. Turning
  automatic backups off now directly pauses schedules
  without a deletion dialog. After deletion, StartOS returns to the schedules
  list or collapses the Automatic backups card when one schedule remains;
  deleting the final schedule returns automatic backups to initial setup. The
  detailed editor can also request **Run now** while saving an existing
  schedule, resuming a user-paused schedule before the requested run.
- **Simplified Automatic Backups.** The expanded card now uses a flat settings
  layout, keeps **Run now** with the detailed actions, and leaves checkpoint
  browsing and restore actions in the dedicated **Backup history** and restore
  cards.
- **Automatic backup setup and version history.** The setup review places the
  master-password field after **Create the first backup now**, accepts Enter to
  turn automatic backups on, and provides a show/hide-password control.
  Version history now offers hour, day, week, and month intervals (day remains
  the default), labels the duration with the selected singular or plural unit,
  and lets additional rules be added with a plus button. Setup and schedule
  editing require acknowledging that every retained version and the staging
  copy are full copies before a multi-version policy can be saved. Capacity
  details now focus on live data, retained automatic storage, checkpoint count,
  and next-run staging instead of unrelated or duplicate figures.
  Capacity checks and transfer measurements use the underlying drive or network
  mount, avoiding the encrypted filesystem's synthetic 40.96 MB capacity.
- **New-service backup review.** A service task with one automatic schedule now
  offers to add the service directly without leaving Services or create a new
  schedule, submitting a decision for every schedule recorded by the task even
  when the visible schedule list changed afterward. Several schedules retain
  the selection list with every checkbox right-aligned and add an **Add new
  schedule** action; no configured schedule opens initial setup. System data is
  always included, so a selective schedule remains useful even when all of its
  installable services have been removed.
- **Automatic backup CLI coverage.** `start-cli` now manages automatic schedules,
  capacity estimates, activity, checkpoint history, target recovery,
  per-service retention overrides, new-service reviews, safe retention-policy
  changes, selected automatic-checkpoint restores, and mixed manual/automatic
  restore selections matching the UI.

- **Stable, predictable IPv6 address (EUI-64).** NetworkManager is set to derive
  each interface's IPv6 address from its MAC (modified EUI-64) with RFC 4941
  privacy extensions off. StartOS applies this to existing network connections
  on every boot, not just newly-created ones, so upgraded servers pick it up too.
  The server therefore keeps one stable global-unicast address (GUA) across
  reboots instead of the default rotating stable-privacy address, giving the
  GUA-based clearnet and public-domain features a predictable address to
  advertise (`AAAA`) and pinhole.
- **External ports 9050 and 9051 are no longer restricted (#3407).** The port
  allocator reserved 9050/9051 for the 0.3.x host Tor daemon, which no longer
  exists. Freeing 9050 lets the tor service bind its SOCKS proxy with
  `preferredExternalPort: 9050` (without exporting an interface), giving every
  service a stable, always-valid service-to-service address for Tor SOCKS on
  the internal bridge — `10.0.3.1:9050` — with no reactive watch on the tor
  package and therefore no dependent restarts when tor is installed, updated,
  or removed. 9051 (the old control port) is freed as well; 0.4.x tor uses a
  Unix control socket, so nothing binds it host-side.
- **The StartOS admin UI is now addressed like a regular service interface (#3387).**
  At the SDK/effects layer the server's own host is identified by the reserved
  package id `start-os`, host id `admin`, and interface id `admin-ui` (renamed
  from `startos-ui`) — no more `null`/`STARTOS` sentinels.
  `host_for`, the host RPC APIs, and the `getHostInfo` / `getServicePortForward` /
  `getServiceInterface` / `listServiceInterfaces` effects all resolve
  `start-os` to the server host, `start-os.startos` resolves like any package
  hostname, and the UI passes `start-os` wherever a package id is expected.
  Installing a package with the id `start-os` is rejected. The migration
  re-points the tor package's persisted hidden-service identity for the admin
  UI (`STARTOS`/`startos-ui` → `start-os`/`admin`) — including the onion-address
  import handoff written into tor's volume before tor is installed — preserving
  the server's existing `.onion` address across the identity change.
- **SDK:** `PluginHostnameInfo.packageId` is required in the type — url plugins
  (e.g. tor) should export the StartOS UI's urls as `start-os`/`admin` instead of
  `packageId: null`. For backwards compatibility during the beta.10 transition,
  the host still accepts the legacy `packageId: null` (or an absent field) over
  the effects socket and maps it to `start-os`.
- **OS Logs and Kernel Logs moved into System settings.** The top-level Logs tab
  is removed; OS Logs and Kernel Logs are now entries at the bottom of the System
  menu.
- **Migrated `startos-backup-fs` into the monorepo** as the `start-os/backup-fs`
  workspace member (from the former `Start9Labs/start-fs` repo); it is no longer
  built as an external `cargo install --git` dependency.
- **Monorepo reorganization.** `start-os` is now the monorepo for all Start9
  products. The OS product moved into its own `start-os/` directory as a thin
  wrapper: the `startbox` and `start-container` entry points live in
  `src/bin/`, the admin UI and setup wizard in `web/`, and the container runtime
  in `container-runtime/`. Backend logic moved from the old `core/` crate to the
  shared `start-core` crate (`shared-libs/crates/start-core`); shared Angular
  libraries moved to `shared-libs/ts-modules`; the SDK to `start-sdk`; and the `patch-db`
  submodule to `shared-libs/crates/patch-db`. Builds now run against the root Cargo and
  Angular workspaces (`cargo build -p start-os`, web from `shared-libs/ts-modules`).
- **Firewall migrated from iptables to native nftables (5b9cf7313).** Every StartOS-managed rule now lives in a single `table ip startos` with stable comment tags for handle-based, idempotent teardown (per-forward DNAT/hairpin/masquerade, the FORWARD `policy drop`, lxcbr0 container-egress accept, and the mangle policy-routing marks). lxc-net and wg-quick keep their own iptables-nft rules in separate tables. The `nftables` package is added to dependencies.
- **Manifest capability flags split (#3271, #3275).** The misleading `nestedRuntime` flag is replaced by two independent capabilities: `userspaceFilesystems` (mounts `/dev/fuse` for fuse-overlayfs storage) and `virtualNetworking` (mounts `/dev/net/tun` for VPN / WireGuard / tun workloads). Both are device grants only — the service LXC already retains `CAP_NET_ADMIN` within its user namespace via the standard `userns.conf` include, so no capability machinery is needed (an earlier `lxc.cap.drop` snippet that was wrongly framed as "re-granting `CAP_NET_ADMIN`" — and actually dropped five caps that were otherwise kept — was removed). Hard rename — packages using `nestedRuntime` must republish.
- **Service-container memory isolation (#3304).** Every service container is placed in a `services.slice` opted into systemd-oomd PSI monitoring, capped at total RAM minus a fixed 1 GiB host reservation; `system.slice`/`user.slice` get `MemoryMin` floors. A burst of concurrent installs can no longer overcommit RAM and wedge the host.
- **Container-runtime RPC/action logging is gated behind a dev build (#3325)** — production builds no longer log full RPC inputs/responses (which can contain action secrets) to service logs.
- **Web platform upgraded to Angular 22, TypeScript 6, and Taiga UI 5.11**, with a unified, version-pinned Prettier config enforced in CI.
- **SDK 2.0.0** ships alongside this release (see [`../start-sdk/CHANGELOG.md`](../start-sdk/CHANGELOG.md)); StartOS 0.4.0-beta.10 is its minimum host version.
- Backup progress is surfaced as a dialog with a percentage rather than a notification.
- **Dialogs and alerts no longer steal focus when they open.** `tuiAutoFocus` is
  gone from every surface that used it — the shared prompt dialog, the refresh
  alert, the OS-update dialog, the marketplace package drawer, and the setup
  wizard's password page. On mobile, autofocusing raised the keyboard the
  instant the sheet appeared, on top of the dialog's own buttons.

### Fixed

- **Automatic backup UI feedback.** Active backups no longer add a red badge to
  the navigation bar, first-run setup only reports a queued backup when another
  backup or restore is actually blocking it, mobile service-selection headings
  remain visible, and version-history switches stay to the right of their labels
  on desktop without overlapping narrow layouts. The one-schedule mobile card
  lets its heading wrap while keeping the switch and menu at the top, and the
  card fully collapses after first setup or a single-schedule save instead of
  exposing the internal **Default** name. Backup navigation uses white
  back actions, paused top-level card controls stay right-aligned on mobile, and
  duration values retain clear spacing below their labels. Only the unchanged
  **Default** name stays hidden while it is the sole schedule; custom and
  multi-schedule names remain editable. **Back** returns multi-schedule edits
  to the schedule list and single-schedule edits to the collapsed card. The
  delete confirmation now
  immediately and reversibly changes between **Delete Schedule** and **Delete
  Schedule and Backups** with its checkbox and refreshes checkpoint counts and
  reclaimable space from the server before opening. Service totals use the
  singular label for one service. Capacity estimates show one service
  total until **More Info** expands the labeled breakdown and only mention
  available space when the location reports it. Storage warnings use **network
  storage** instead of the protocol label **CIFS**.

- **Automatic backup directory traversal.** `backup-fs` now preserves every
  returned directory cursor and rejects unknown nonzero cursors instead of
  restarting a listing. Snapshot promotion no longer loops over the same
  directory indefinitely at partial progress, and service-level OS logs show
  where each automatic backup is running or failed.

- **Backup password visibility.** Master-password fields in automatic backup
  workflows now show exactly one eye control at a time, matching the manual
  backup and restore prompts.

- **Backup progress and mobile layout.** Backup progress uses the full content
  width as one flat panel rather than a nested card, saving automatic settings no
  longer opens a blocking progress notification, retention controls share a
  consistent size, and narrow screens keep location names, addresses, empty
  drive states, and compact destructive actions readable without overlap.
  Top-level backup cards now use the standard StartOS card color and gradient.
  The System sidebar replaces its red backup badge with the animated purple
  progress circle while the Backup Progress card is out of view.
  Backup-location rows now consistently place the icon and name on the left,
  the address or device path on the right, and center the no-drive state.
  Status columns are wider and wrap naturally so **No StartOS backups
  detected** remains readable. The future-services and **Toggle all**
  checkboxes are aligned above the individual service checkboxes.
  Manage-backup network locations keep the location name and address together
  on mobile, moving the complete address to the next line when necessary
  instead of shrinking and clipping it or splitting names and IP addresses.
  Empty network-folder and no-drive content is centered across the full table
  frame on desktop and mobile. Location choices also share the action button's
  centered width and keep long location names horizontal on phones, including
  automatic-backup setup. Physical-location refresh exposes its active state,
  and phone layouts place reported network free space beside the location.
  Automatic schedule rows are inset from phone edges, keep icon-only switches
  and action menus level with the schedule name, and let details use the full
  card width below those controls. The
  overall progress
  spinner and percentage align with each service's status, and service progress
  is right-aligned within the card.
  Manual and custom automatic runs no longer force-scroll or place a blocking
  notification over navigation; their blue progress indicator stays at the top
  of the page, scrolls out of view normally, links back to the main Services
  list, and disappears when the operation completes, fails, or leaves only an
  empty stale progress shell after an early target-space failure. Long service
  names no longer overlap their backup status; the status wraps to the next
  right-aligned line inside the progress card. While another backup or restore
  is running, the manual-backup card now shows a clear busy state instead of
  expanding to an empty panel. Newly installed services not covered by a
  future-services policy get a dismissible, nonblocking **Add to backup
  schedule** task that opens a plain schedule selector or initial setup.
- **Backup-location removal.** Schedule deletion can also remove the automatic
  checkpoints used only by that schedule, allowing unused network backup
  locations to be forgotten. The confirmation action clearly distinguishes
  deleting only the schedule from deleting the schedule and backups.
- **Legacy backup target loading.** Backup target discovery no longer waits
  indefinitely while measuring an old pre-v2 `StartOSBackups` folder on a slow
  network share. StartOS now checks only whether this server's old backup folder
  exists, reports free space separately, and still loads the backup sections so
  the user can delete the old backup or choose another location when space is
  tight.
- **Interrupted backup progress.** StartOS now marks persisted in-progress
  backup or restore activity as interrupted during startup, while the backup
  system is idle, and before each new operation. A newer terminal attempt now
  takes precedence over an older orphaned activity, so an insufficient-space
  failure cannot leave the backup progress card visible or keep backup controls
  busy while idle. Subsequent scheduled runs also use measured target-side
  growth for their free-space preflight instead of overestimating from logical
  snapshot size.
- **Concurrent backup and restore requests.** StartOS now serializes scheduled
  runs and rejects a second manual backup, explicit automatic run, or restore
  request while another operation owns the backup coordinator. Saving a new
  schedule with **Create the first backup now** is the deliberate exception:
  the schedule saves successfully, a notification explains the delay, and its
  requested first run is durably queued until the active backup or restore
  finishes.
- **Automatic backup failure notifications.** Scheduled-backup warnings show
  the backup location's user-facing name without exposing internal schedule or
  target identifiers through a meaningless **View details** action.
- **StartOS UI network metadata.** The built-in UI now stores a valid host ID,
  preventing an existing server database from failing validation and entering
  diagnostic mode after the upstream service-interface migration.
- **Login rate limiter no longer degrades logins to one per 20 seconds (#3512).**
  The password-login throttle used a single process-wide counter that only ever
  incremented and never reset, so after three logins since boot the entire box
  was capped at one login per 20 seconds across all clients (UI, CLI, API) for
  the rest of uptime. The counter now resets once 20 seconds pass without a
  further accepted login attempt — and a rejected attempt no longer advances the
  window — so the limit is a genuine three-attempts-per-20-seconds window rather
  than a permanent cap.
- **Large package installs no longer stall or freeze the box.** Downloading and
  unpacking a big s9pk streamed through the page cache with no writeback pacing,
  so on a fragmented copy-on-write btrfs filesystem the temporary and installed
  archives scattered across thousands of extents and their accumulated dirty
  pages flushed in one enormous final `fdatasync` — a stall lasting seconds to
  minutes whose victim varied by package size and each box's on-disk layout.
  Package transfers now reserve their space up front (`fallocate`), write to
  `nodatacow` files so they stay contiguous on btrfs, and pace writeback
  (`sync_file_range`) so only a bounded amount is ever left unsynced — keeping
  memory use flat and the final flush cheap.
- **DNS forwarder no longer wedges box-wide after an upstream blip (#3473).**
  After a WAN, tunnel, or DHCP event degraded the currently-configured upstream
  resolvers, container DNS could go dark for every service on the box — external
  lookups failing with `Temporary failure in name resolution` — until the
  upstreams recovered or the box was rebooted. The forwarder held a read lock on
  its upstream catalog across each upstream query (up to 30s) while the task
  installing new upstreams gave up after 10s and retried, starving the very
  update that would have replaced the dead upstreams. The resolver now snapshots
  the catalog and releases the lock before forwarding, and installs new upstreams
  by atomic swap — no lock wait, no timeout, no retry — so a pending upstream
  change always applies immediately. Forward queries also use a 5-second
  per-attempt upstream timeout (matching what container clients wait) rather than
  30 seconds, and names in the private `.startos`/`.embassy` zones that no
  running service claims are answered
  authoritatively (`NXDOMAIN`) instead of being forwarded to — and leaked at —
  upstream resolvers.
- **Enabling a public IPv4 address on an SSL service interface now opens the
  gateway port automatically.** Only a public _domain_ on an SSL-terminated port
  used to trigger automatic port forwarding (PCP/NAT-PMP/UPnP); turning on the
  bare public IPv4 left the port closed until it was forwarded by hand. StartOS
  now requests the pinhole for the SSL port the same way it already did for
  public domains and IPv6 GUAs, so a public IPv4 on an `addSsl` interface (the
  StartOS UI included) is reachable from the Internet without a manual forward.
- **Installer: "Preserve" selections that cannot keep your data are now refused instead of silently erasing the data drive.** During a USB install, choosing **Preserve** for a drive whose StartOS data pool lives on a _partition_ of the drive (the 0.3.x single-drive layout) while installing the OS to a _different_ drive fell through to creating a fresh, empty pool on the data drive — permanently destroying the data the user asked to keep, with no error. The installer now validates the preserve selection before writing anything and fails with an actionable error instead: a drive whose pool lives on a partition must be selected for **both** the OS drive and the data drive, and a drive whose pool spans the entire disk must be paired with a different OS drive. The setup wizard applies the same rules up front: when the selected drives cannot keep the data, the **StartOS Data Detected** dialog says why and disables **Preserve**, so an unpreservable selection is caught with guidance to fix it rather than surfacing as an error once the install is already under way.
- **IPv6 services exposed through a tunnel are now reachable, and outbound IPv6 no longer leaks around a gateway.** StartOS now applies the full IPv4 policy-routing layer to IPv6, including CONNMARK reply-routing: a reply to an inbound IPv6 connection that arrived over a tunnel — whether terminated on the host or DNAT'd to a service container — is pinned back out the interface it arrived on, so exposing a service over a StartTunnel's delegated IPv6 actually works. Previously those replies had no route back and were blackholed, so inbound IPv6 over a tunnel was dead. Outbound, the server's IPv6 default is now chosen by route metric exactly like IPv4, and leak prevention is per-gateway: an outbound gateway that is explicitly selected but can't carry IPv6 drops the server's IPv6 via a blackhole in that gateway's own routing table — so your real address never leaks out the ISP link — without blackholing the reply traffic that keeps inbound tunnel services working.
- **Updating a WireGuard gateway's config no longer drops its preshared key.** The in-place update path (`net tunnel update` / the **Update config** UI action, NetworkManager `Update2` + `Reapply`) persisted the interface private key but silently dropped each peer's preshared key, so a re-issued PSK-using tunnel failed its handshake and went dead (taking tunnel-routed DNS down with it). The peer secret is now flagged system-owned so the update persists it, and the settings (peer secrets inline) are passed to `Reapply` explicitly — an empty-dict `Reapply` still stripped the PSK from the _running_ device even with the profile persisted correctly, hanging all traffic through the tunnel (e.g. forwarded ports) until the next reboot.
- **Dev builds bricked by an empty persisted host id (#3387).** Builds between
  #3366 and #3387 persisted the server host's then-sentinel id (the empty
  string) in the admin UI interface's `addressInfo.hostId`, which strict
  deserialization rejects — every boot failed into the diagnostic UI. The
  server host now has a real id (`admin`) and the beta.10 migration rewrites
  the empty value.
- **Critical-task start gate is now enforced backend-side.** Starting a service with
  an unresolved critical task was previously blocked only in the web UI; the CLI and
  RPC bypassed it. `package.start` now rejects such a start unless `--force` is passed.
- **Split DNS for dual public/private domains (#3263).** A domain configured as both private (e.g. on Ethernet) and public (on a StartTunnel) is now served as private DNS to LAN clients, gated per-gateway in the resolver, instead of falling through to the upstream forwarder and hairpin-routing to the public VPS IP.
- **DNS `[::]:53` wildcard listener (#3346).** DNS listeners bind with `SO_REUSEPORT` so the dual-stack catch-all coexists with the per-address sockets; previously the catch-all's TCP bind failed with `EADDRINUSE` and was silently dropped.
- **Host address list renders instead of panicking (#3345)** — `start-cli` no longer hits `todo!()` displaying the server host address table.
- **Web server connections run in parallel with HTTP/2 adaptive window (#3328)**, fixing head-of-line stalls under load.
- **Logger writes moved off worker threads (#3259).** File/stderr log writes no longer hold a mutex across a blocking `stderr` write, which could park every tokio worker (and stall ports 80/443) if journald backpressured.
- **`create_task` self-deadlock during `setupInit` (#3273)** — a service calling `createOwnTask` with an `input-not-matches` trigger from its init handler no longer wedges in `updating`.
- **Replayed task state is preserved when the target service is unavailable (#3309)** — services running before shutdown no longer stay stopped after boot when a critical-severity task replays against a still-initializing dependency.
- **Stale mountpoints are reconciled before remount (#3314).** After a `SIGKILL` left kernel mounts in place, a same-boot restart now lazily unmounts the stale target instead of failing every service load with "already mounted".
- **`TMP_MOUNTS` self-deadlock on nested idmapped mounts** is avoided (5aee392a2).
- **Backups to a physical drive no longer intermittently fail with `could not load backup` (`NotFound`).** A temporary mount's teardown unmounted by path, so a stale detached unmount (e.g. from a `Drop`) could tear a drive down _after_ its shared `TMP_MOUNTS` slot had already been reused by a fresh mount at the same hashed path — and a concurrent operation loading `mount.backup-fs` off that drive then hit `ENOENT`. Teardown now runs under the per-mountpoint slot lock and unmounts only while the slot has no live guard, so it can't unmount a mount another operation just established. Surfaced by the periodic backup-target listing (backup page open) racing backup-fs loads on exFAT and BTRFS targets (#3498).
- **Unmountable partitions are skipped when listing backup targets (#3237)** instead of aborting the listing.
- **Bind-mount source directories are auto-created via recursive canonicalize** (d8ae7f199), and mount propagation is corrected (27322b4a9).
- **`/media/startos` ownership on migrated installs (#3311, #3312).** A migration repairs the stale `root:root` overlay entry so migrated nodes match fresh installs (`root:startos`), letting the `start9` SSH user browse package data without sudo.
- **CA fingerprint hex bytes are zero-padded**, with a `0.4.0-beta.10` repair migration for affected installs.
- **`.onion` (Tor) and `.local` (mDNS) are routed correctly through the host SOCKS proxy** (b5dec33cf), and reaching a `.onion` registry without Tor now reports a clear error ("the Tor service is not installed / not running") instead of a generic connection failure.
- **`NetService` is torn down synchronously on container destroy (#3285)**, and the nftables/policy-routing reconcile is made atomic, idempotent, and lock-free (daeee4f12, cebd6d703, 3ee50b0c3).
- **A service with no active bindings no longer wedges shutdown/restart indefinitely (#3350).** After #3285 moved network teardown into the awaited container-destroy path, a no-op `clear_bindings` emitted no patch-db revision, so the convergence wait blocked forever — stalling reboots for a service accessed only over Tor. The teardown now skips the wait when nothing changed.
- **Host `reboot`/`poweroff` now tears service containers down cleanly.** On an OS-level power-cycle, systemd stopped `lxc.service` (whose `ExecStop` is Debian's `lxc-containers stop`) and `lxc-monitord` _concurrently_ with the graceful-teardown hooks, killing each container before `startd`'s `Exit` RPC could stop it — a burst of `lxc-stop … is not running` / `Connection refused (os error 111)` and a stalled reboot. The teardown hooks (`startos-restart.service` / `startos-shutdown.service`) now order `After=lxc.service lxc-monitord.service`, so the LXC container-stop infrastructure stays up until the graceful teardown has finished. `Shutdown::execute` also skips its own `reboot`/`poweroff` when systemd is already performing the transition (and exits so systemd's stop of `startd.service` completes promptly). A power-cycle now tears containers down like `start-cli server restart`.
- **ACME issuance restored.** `async-acme` is re-pinned to keep its HTTP backend (#3342), and `ring` is installed as the process-default rustls provider so ACME cert acquisition no longer panics on the dual ring/aws-lc-rs build.
- **Union variant memory is isolated per row (#3337)**, disabled options render correctly in select dropdowns (#3229), and the per-row Wi-Fi overflow menu no longer disappears (#3243).
- **The redundant "Plugin:" prefix is dropped from interface plugin labels (#3349)** — the plugin address group already sits within a plugin section.
- **Login and CA-wizard UX cleanup (e86dcc242).** The login button uses an inline loading state that holds until navigation completes (replacing the global overlay loader) and is correctly centered; the CA wizard gets a solid card background, drops the redundant "Bookmark this page" step, and moves the "repeat on every device" caveat into a notification.
- **`fedimintd` → `fedimint-guardian`** package-ID rename is handled across all four `0.3.5.1`→`0.4.0` migration paths (2a806d8b8).
- **Allow non-ASCII characters in WiFi SSIDs (#3365).** Adding, connecting to, or
  removing a WiFi network whose SSID contains non-ASCII characters (e.g. an accented
  letter or a typographic apostrophe) no longer fails with "SSID may not have special
  characters". SSIDs are passed to NetworkManager as-is, and SSIDs containing a colon
  are now parsed correctly when listing connections. The WiFi passphrase still
  requires ASCII, as mandated by WPA.
- **Updates-tab progress circle vanishing during install finalization.** A
  package update marked the overall install progress complete right after the
  old version was uninstalled — before the new version's finalization/init
  progress (added with package init progress reporting, #3323) had run — so the
  Updates-tab loading circle snapped to full and then disappeared partway
  through "installing/finalizing". Overall progress now completes only once the
  package is fully installed, so the circle keeps tracking live finalization
  progress until the update finishes.
- **The UI no longer freezes after you enter your master password.** Creating a
  backup, restoring a backup, and changing your password each verified the
  password in the browser, via a _synchronous_ WASM Argon2id call on the main
  thread. At the parameters StartOS hashes with (64 MiB, t=3) that blocks the
  tab for seconds on a desktop and 20–25 seconds on a phone, where it reads as
  a hung browser; creating a backup onto a target whose existing backup used a
  different password ran it three times over. All three flows now let the server
  verify — which it already did on every one of these calls, natively, in
  milliseconds — and the argon2 WASM module is gone from the UI and
  setup-wizard entirely. A target whose existing backup was encrypted under a
  different password now comes back as the new `BackupPasswordMismatch` error
  kind, so the UI still knows to prompt for that original password rather than
  reporting the master password as wrong.
- **Backup password prompts no longer autocapitalize, and no longer look like a
  login to your password manager.** The shared prompt dialog sets
  `autocapitalize="off"`, so a mobile keyboard stops capitalizing the first
  character of a password you type into it, and it now submits through its own
  buttons (or Enter) instead of a `<form>` submit — a browser password manager
  saw that submit and offered to save your backup encryption password as a
  saved credential. The setup wizard's **Unlock Backup** prompt gets the same
  `autocapitalize` treatment.
- **A cancelled or failed package update now leaves the previous version
  running.** When an update is interrupted, StartOS restores the service's data to
  its pre-update state before restarting the old version, so the service comes back
  on the version it had. Previously the old version was started against the
  partially-migrated data and failed its downgrade migration with a "cannot
  migrate" error, leaving the service stuck until its container was rebuilt.
- **EFI system partitions are no longer listed as backup drives.** A GPT drive
  formatted on macOS or Windows (or a former boot drive) carries a small hidden
  EFI System Partition alongside its data partition, so the backup drive list
  showed the same physical drive twice — the second entry an unusable ~200 MB
  partition displayed as "0 GB". Partitions whose partition type marks them as
  an EFI System Partition are now skipped everywhere drives are listed (backup
  targets, setup-wizard drive lists, `start-cli disk list`), and a sub-gigabyte
  partition that does remain shows its capacity in MB instead of rounding down
  to "0 GB".
- **A transient failure querying clock-sync status no longer aborts boot or
  strands the clock-sync warning.** StartOS asks systemd (`timedatectl`) whether
  NTP has synchronized — once per second during the boot-time sync wait, then
  every 30 seconds in the background until the first sync lands. Both callers
  treated a failed query as fatal: during init it aborted boot into Diagnostic
  Mode, and in the background poller it silently killed the polling task,
  leaving the "Clock sync failure" warning up for the rest of the boot even
  after time synchronized. A failed query (e.g. a D-Bus activation timeout
  under boot load) is now treated as "not synchronized yet" — logged and
  retried on the existing cadence.

### Removed

- **Package `alerts` manifest field (BREAKING, #3333).** Packages can no longer define install / update / uninstall / restore / start / stop confirmation messages. StartOS stops reading and showing them; existing installs and old s9pks are unaffected (the field is ignored on load). Built-in confirmations for destructive actions are unchanged.
- **`nestedRuntime` manifest flag** — replaced by `userspaceFilesystems` / `virtualNetworking` (see _Changed_), with no compatibility alias.

### Security

- **TSIG-authenticated DNS UPDATE (#3306).** RFC 2136 injections are authenticated with TSIG (RFC 8945, HMAC-SHA256) keyed off a per-device key derived (HKDF-SHA256) from that device's WireGuard PSK, closing a forgery vector where any co-located service emitting from the server's tunnel IP could inject DNS.
- **Packages are blocked from port-mapping the gateway (#3306).** Only startd may send UPnP/NAT-PMP/PCP upstream; a dedicated nftables guard table drops these protocols when forwarded from any interface (LXC), so a service can't open ports on the upstream gateway.
- **Packages are blocked from talking DNS straight to the gateway.** The same guard table now drops DNS (udp/tcp 53) forwarded off the container bridge, so a service can't query a gateway or public resolver directly — its DNS goes through the OS resolver at `10.0.3.1:53`, same as every other lookup.
- **Dependency/advisory cleanup:** resolved Dependabot alerts across core, web, and container-runtime (#3301); migrated to hickory 0.26 to clear DNS RUSTSEC advisories (#3302); resolved forked-dep RUSTSEC advisories in tokio-tar and async-acme (#3303).
- **Password hashes and backup key material are no longer sent to the
  frontend.** `serverInfo.passwordHash` — the master password's argon2 hash —
  was replicated into the public database, so every authenticated client held
  offline-cracking material for the master password. Separately, the backup
  metadata returned by `getBackupTargets`, `setup.cifs.verify`, and the disk
  listing carried each backup's `passwordHash` **and** its `wrappedKey`: the
  backup's encryption key sealed under that password, so a client could crack
  the hash offline and then unwrap the actual backup key. Both existed only to
  let the browser verify passwords locally, which it no longer does (see
  _Fixed_). `ServerInfo` drops the field entirely — the real hash stays in the
  private database — and the on-disk backup metadata is split from its public
  view, so the API returns only hostname, version, and timestamp. Existing
  servers are cleaned up automatically: startup deserializes the database
  through the typed model, which drops the removed key.

## [0.4.0-beta.9] and earlier

See the [GitHub releases page](https://github.com/Start9Labs/start-technologies/releases)
for the full 0.4.0 beta and alpha history and all prior releases.

[0.4.0-beta.10]: https://github.com/Start9Labs/start-technologies/compare/v0.4.0-beta.9...HEAD
[0.4.0-beta.9]: https://github.com/Start9Labs/start-technologies/releases/tag/v0.4.0-beta.9
