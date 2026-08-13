# Restoring Backups

Restore a manual or automatic checkpoint to recover individual services, or use
a server backup during disaster recovery after a data-drive failure.

## Restoring Individual Services

Use an individual restore after uninstalling a service, rolling back unwanted
data changes, or recovering from service-data corruption.

1.  Go to `System > Backups` and expand **Restore from a backup**.
1.  Select the physical drive or network folder containing the backup. A
    location needing attention remains visible so you can repair it first.
1.  Enter the master password used to create the backup. Select the eye icon to
    show or hide the password while checking it.
1.  Select the services to restore. StartOS combines the restorable manual and
    automatic history on that location and chooses the newest checkpoint for
    each service by default. Use a service's checkpoint menu to choose another
    timestamp, including an older retained or archived automatic checkpoint.
1.  Select **Restore Selected**. You may leave the Backups page while the restore
    continues, click the progress card to return to the main Services list, and
    return to **Backup history** later to review the result.

Only one backup or restore can run at a time. A second request is rejected
instead of waiting invisibly, and scheduled backups wait until the active
operation ends. If StartOS restarts during the restore, **Backup history** marks
the interrupted operation as failed and clears stale progress.

For command-line recovery, use `start-cli backup history list` or `backup
history discover` to find automatic checkpoint IDs, then `start-cli package
backup restore-checkpoint` to select one checkpoint per service. See the
[start-cli reference](./cli-reference.md#activity-and-checkpoint-history).

> [!TIP]
> If you restore a backup from a different system architecture (x86, ARM, or
> RISC-V), _reinstall_ the restored services from the Marketplace afterward so
> they use native images. Do not uninstall them, because uninstalling removes
> their restored data.

## Restoring an Entire Server

If your StartOS data drive is lost or corrupted and you need to restore your
entire server, follow the [recovery options during initial
setup](./initial-setup.md#recover-options).
