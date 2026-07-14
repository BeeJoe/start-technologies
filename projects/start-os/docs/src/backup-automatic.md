# Automatic Backups

Automatic backups protect services on a schedule and keep their checkpoints
separate from the latest manual backup. StartOS brings automatic and manual
backups, restores, locations, and activity history together under `System >
Backups`.

> [!IMPORTANT]
> Automatic backups reduce the chance that a missed manual backup becomes data
> loss, but the backup location is still a single point of failure. Protect
> important data on more than one high-quality drive or network folder.

## Set Up Automatic Backups

1. Go to `System > Backups` and expand **Automatic backups**.
1. Choose a physical drive or network folder. Locations needing repair remain
   visible so you can fix them or select **Add or repair a location**.
1. Choose an hourly, daily, weekly, or monthly schedule and its exact time.
   Weekly schedules include a day of the week; monthly schedules include a day
   of the month. StartOS captures the timezone of the device used for setup, so
   the displayed local time remains meaningful through daylight-saving changes.
1. Choose the services to protect. All current services are selected by
   default. Expand **Select services** to place **Automatically include future
   services** and **Toggle all** above the service list. The
   section stays collapsed when you are not changing the selection.
1. Choose version-history settings. The safe storage default keeps only the
   latest automatic checkpoint. **Keep additional versions** can retain one
   version per hour, day, week, or month for the duration you select; day is the
   default interval. Each row requires a frequency. Select the plus button at
   the right edge to add another version-history rule with the same frequency
   and duration controls. Every row, including the first, can be removed;
   removing the last row turns **Keep additional versions** off and returns to
   the latest-checkpoint-only default.

   Existing nonstandard version-history intervals created with `start-cli` are
   preserved unless you change or remove that specific row in the UI.

1. Review the estimated storage, decide whether to **Create the first backup
   now**, and enter the master password. The password field follows that choice;
   use its eye icon to check what you typed. Select **Turn on automatic
   backups**, or press Enter while the password field is focused.

StartOS uses the password to initialize or unlock the encrypted backup and does
not store the password. Changing the server password does not change the
password on existing backups.

## Schedules and Service Selection

With one job, the main **Automatic backups** card keeps the On switch and **Run
now** action at card level. With multiple jobs, expanding the card first shows
the unboxed jobs list. Each row keeps its own On switch, **Run now**, and
**View/Edit** actions available without opening the full editor and reports how
many currently installed services it protects. On phones, each row is inset
from the screen edge and its On/Off switch stays at the right. Select
**View/Edit** to collapse the list and open that job. Saving closes the editor
and returns to the list. Select **View all jobs** to close without saving and
return to the list; StartOS warns you if that discards unsaved changes. **Add
new backup schedule** appears below the list and moves focus directly to the job
name field.

Each job can use a different exact time, backup location, service selection, or
version-history rules. StartOS validates enabled schedules together so their
frequency can support the version history they feed.

When an enabled job needs attention, the collapsed main **Automatic backups**
card says so and explains the problem. The warning clears after the job runs
successfully or is turned off. With several jobs, the collapsed summary reports
the number of schedules without presenting one job's time as though it applied
to every job.

When a selective schedule does not automatically include future services,
StartOS asks whether a newly installed service should be added to each affected
job. Resolve the review before starting that service; this prevents a new
service from silently running without the protection you intended.

Pausing or turning off automatic backups keeps schedules and checkpoints by
default. The confirmation dialog can instead permanently remove the automatic
schedules and automatic checkpoints. Manual checkpoints are never removed by
that option.

The bottom of an additional schedule's editor places **Delete schedule**
opposite **Save**. Its confirmation can also delete checkpoints no longer
referenced by another schedule; leaving that option off keeps them as an archive.

## Version History and Storage

Every retained automatic version is a full target-side copy, not a small
incremental delta. A run also needs temporary staging space. More frequent
version history therefore increases required space, run time, and I/O,
especially on network folders and slower external drives.

When version history contains several retention tiers, the collapsed summary
lists every tier so the editor never hides part of the active policy.

Capacity estimates separate the space used or projected for:

- current service data;
- the latest manual checkpoint;
- retained automatic checkpoints;
- archived checkpoints; and
- staging for the next run.

**Backup history** shows active and archived automatic checkpoints by service
and location. Version-history settings shared by several schedules cannot be
changed silently: StartOS previews the checkpoints that would be removed,
estimates the space reclaimed, names affected jobs, and requires confirmation
of that exact set before applying the change.

Changing a job to another location does not copy its existing checkpoints. They
remain archived on the original location, and the next run begins history on
the new location.

## Runs, Activity, and Restore

Each run stops a selected service, backs it up, and starts it again only if it
was running before the backup. Other services and the rest of StartOS remain
available. Progress continues if you leave the Backups page, and the progress
card links to the main Services list.

Only one backup or restore owns the backup system at a time. A scheduled job
waits while another operation is active; another manual backup, automatic run,
or restore request is rejected instead of being silently queued. If StartOS
restarts during an operation, it records the interrupted activity as failed and
clears stale progress so the next operation can proceed.

Use **Backup history** to review manual backups, automatic runs, and restores,
including partial failures and service-level errors. During restore, each
service defaults to its newest available checkpoint, but you can choose a
different manual or automatic checkpoint before starting. See [Restoring
Backups](./backup-restore.md).

## When a Backup Needs Attention

StartOS notifications identify the job, the human-readable backup location,
and the affected services, while preserving earlier checkpoints. They also
explain the next action:

- **Scheduled Backup Needs More Space** — free space, reduce retention or
  service scope, change the location, or delete the job.
- **Scheduled Backup Had Failures** — inspect the named services in **Backup
  history**; unaffected checkpoints remain available.
- **Backup Target Unavailable** — after three consecutive connection failures,
  affected jobs pause until you retry, reassign, or remove them.
- **Backup Target Requires Authentication** — retry the location with the
  current master password or move the job.
- **Backup Target Identity Changed** — reconnect the original device or folder,
  or explicitly reassign the job before it writes to the replacement.
- **Backup Selection Requires Review** — decide whether a newly installed
  service belongs in each selective job.

For deeper troubleshooting, `start-cli server logs` shows structured run-level
and service-level entries, including **automatic backup service started**,
**automatic backup service snapshot promotion started**, **automatic backup
service completed**, and failure details. These include useful identifiers,
durations, sizes, the job and location names, trigger, run state, and service
counts without logging the master password. See the [start-cli backup
reference](./cli-reference.md#backups) for the command corresponding to every
backup action in the UI.
