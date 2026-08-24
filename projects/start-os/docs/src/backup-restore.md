# Restoring Backups

Restore a manual or automatic checkpoint to recover individual services, or use
a server backup during disaster recovery after a data-drive failure.

## Restoring Individual Services

An individual restore can recover service data from a manual or automatic
checkpoint. A service that is already installed must be uninstalled before its
checkpoint can be restored. Restore requires access to the physical drive or
network folder containing the backup and the master password used to encrypt it.

StartOS combines the restorable manual and automatic history on the selected
location. It chooses the newest checkpoint for each service by default, but a
different retained or archived checkpoint can be selected for any service.

Only one backup or restore can run at a time. A second request is rejected, while
scheduled backups wait for the active operation to finish. If StartOS restarts
during a restore, the interrupted operation is recorded as failed and stale
progress is cleared.

For command-line recovery, use `start-cli backup history list` or `backup
history discover` to find automatic checkpoint IDs, then `start-cli package
backup restore-checkpoint` to select one checkpoint per service. See the
[start-cli reference](./cli-reference.md#activity-and-checkpoint-history).

> [!TIP]
> After restoring a backup from a different system architecture (x86, ARM, or
> RISC-V), reinstall the restored services from the Marketplace so they use
> native images. Do not uninstall them, because uninstalling removes their
> restored data.

## Restoring an Entire Server

If the StartOS data drive is lost or corrupted, follow the [recovery options
during initial setup](./initial-setup.md#recover-options).
