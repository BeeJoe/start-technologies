# Automatic Backups

Automatic backups protect System data and selected services on a schedule. They
keep their checkpoints separate from the latest manual backup.

> [!IMPORTANT]
> A backup location is still a single point of failure. Protect important data
> on more than one high-quality drive or network folder.

## Protection and Encryption

Each schedule has its own backup location, timing, service selection, and
version-history policy. System data and installed services are selected by
default when the first schedule is created. A schedule can also include future
services automatically.

StartOS stops each selected service while copying its data, then starts it again
if it was running before the backup. Other services remain available. A service
backup that runs for more than six hours fails so it cannot block later backup
or restore operations indefinitely.

Automatic backups use the same master-password encryption as manual backups.
StartOS uses the password to initialize or unlock the backup location but does
not store it. Changing the server password does not re-encrypt existing backups.

## Schedules

Schedules can run hourly, daily, weekly, or monthly at a chosen local time.
StartOS stores the timezone with the schedule so daylight-saving changes are
handled correctly. A monthly schedule set for a date that does not occur in a
given month runs on that month's final day.

Multiple schedules can protect different services, use different locations, or
run at different times. Pausing a schedule keeps its settings and checkpoints.
When no schedule includes future services, StartOS recommends adding each newly
installed service to one or more schedules; the recommendation can be dismissed.

Only one backup or restore operation runs at a time. Scheduled backups wait for
an active operation to finish. A second manual backup, restore, or explicit
automatic run is rejected rather than queued silently. A requested first run
for a newly created schedule waits and starts when the backup system becomes
free. If StartOS restarts during an operation, the interrupted activity is
recorded as failed and stale progress is cleared.

## Version History and Storage

By default, StartOS keeps only the latest automatic checkpoint for each item.
Version-history rules can additionally retain one checkpoint per hour, day,
week, or month for a chosen duration. A schedule must run at least as often as
the most frequent rule it supplies; for example, hourly history requires an
hourly schedule.

Each retained checkpoint is a full copy on the backup location, not an
incremental delta. A run also needs temporary staging space. Keeping more
versions therefore increases storage use, run time, and I/O, especially on
network folders and slower drives. Capacity estimates account for current data,
retained checkpoints, and staging space.

Retention applies to a service's shared automatic history on a backup location.
If several schedules use that history, StartOS previews the checkpoints a policy
change would remove and the schedules it would affect before applying it.

Changing a schedule's location does not copy its existing checkpoints. They
remain archived on the old location, and the next run begins a history on the
new one. Deleting a schedule can either leave its automatic checkpoints archived
or remove checkpoints no longer referenced by another schedule. Manual
checkpoints are never removed by schedule deletion. Deleting archived
checkpoints after reconnecting a location requires the current master password.

## History, Restore, and Failures

Backup history records manual backups, automatic runs, and restores, including
service-level failures. It retains the newest 1,000 completed entries in addition
to any backup or restore still in progress. Successful checkpoints remain
available when another service in the same run fails. During restore, StartOS
selects the newest available checkpoint for each service by default, but any
retained or archived manual or automatic checkpoint can be chosen instead. See
[Restoring Backups](./backup-restore.md).

StartOS pauses affected schedules after three consecutive failures to connect to
a backup location. It also refuses to write when credentials are no longer
valid, the location's identity has changed, or its metadata is invalid. Repair
the original location, provide current credentials, or explicitly move the
schedule to another location before resuming it.

The command-line backup interface can list and manage schedules, inspect
activity and checkpoints, preview retention changes, repair targets, and start
runs. See the [start-cli backup reference](./cli-reference.md#backups).
