use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use chrono::Utc;
use clap::Parser;
use rpc_toolkit::{Context, HandlerExt, ParentHandler, from_fn_async};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    BackupJob, BackupJobId, BackupJobPause, BackupJobStatus, BackupRun, BackupRunTrigger,
    BackupServiceScope, RetentionPolicy, RetentionPolicyChangePreview, RetentionTier, Schedule,
    ScheduledBackupCredential, ScheduledBackupMountGuard, ServiceSnapshot, ServiceSnapshotId,
    ServiceTargetHistory, run_job, validate_combined_schedule_coverage,
};
use crate::auth::PasswordType;
use crate::backup::target::BackupTargetId;
use crate::context::RpcContext;
use crate::db::model::DatabaseModel;
use crate::disk::mount::filesystem::ReadWrite;
use crate::disk::mount::guard::{GenericMountGuard, TmpMountGuard};
use crate::middleware::auth::session::SessionAuthContext;
use crate::prelude::*;
use crate::rpc_continuations::Guid;
use crate::util::io::dir_size;
use crate::util::serde::HandlerExtSerde;
use crate::volume::PKG_VOLUME_DIR;
use crate::{DATA_DIR, PackageId};

pub fn job<C: Context>() -> ParentHandler<C> {
    ParentHandler::new()
        .subcommand(
            "list",
            from_fn_async(list)
                .with_display_serializable()
                .with_about("about.list-automatic-backup-jobs")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "add",
            from_fn_async(add_cli)
                .with_display_serializable()
                .with_about("about.add-automatic-backup-job")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "edit",
            from_fn_async(edit_cli)
                .with_display_serializable()
                .with_about("about.edit-automatic-backup-job")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand("create", from_fn_async(create).no_cli())
        .subcommand("update", from_fn_async(update).no_cli())
        .subcommand("set-enabled", from_fn_async(set_enabled).no_cli())
        .subcommand(
            "enable",
            from_fn_async(enable_cli)
                .with_display_serializable()
                .with_about("about.enable-automatic-backup-job")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "disable",
            from_fn_async(disable_cli)
                .with_display_serializable()
                .with_about("about.disable-automatic-backup-job")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "delete",
            from_fn_async(delete)
                .no_display()
                .with_about("about.delete-automatic-backup-job")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "run-now",
            from_fn_async(run_now)
                .with_display_serializable()
                .with_about("about.run-automatic-backup-job-now")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "retry-target",
            from_fn_async(retry_target)
                .with_display_serializable()
                .with_about("about.retry-automatic-backup-target")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "reassign-target",
            from_fn_async(reassign_target)
                .with_display_serializable()
                .with_about("about.reassign-automatic-backup-target")
                .with_call_remote::<crate::context::CliContext>(),
        )
}

pub fn history<C: Context>() -> ParentHandler<C> {
    ParentHandler::new()
        .subcommand(
            "list",
            from_fn_async(list_histories)
                .with_display_serializable()
                .with_about("about.list-automatic-backup-history")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "discover",
            from_fn_async(discover_histories)
                .with_display_serializable()
                .with_about("about.discover-automatic-backup-history")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "delete-archived-snapshots",
            from_fn_async(delete_archived_snapshots).no_cli(),
        )
        .subcommand(
            "delete-archived",
            from_fn_async(delete_archived_snapshots_cli)
                .with_display_serializable()
                .with_about("about.delete-archived-backup-checkpoints")
                .with_call_remote::<crate::context::CliContext>(),
        )
}

pub fn policy<C: Context>() -> ParentHandler<C> {
    ParentHandler::new()
        .subcommand("estimate", from_fn_async(estimate_capacity).no_cli())
        .subcommand("preview", from_fn_async(preview_policy_change).no_cli())
        .subcommand("update", from_fn_async(update_policy).no_cli())
        .subcommand(
            "preview-change",
            from_fn_async(preview_policy_change_cli)
                .with_display_serializable()
                .with_about("about.preview-backup-retention-change")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "apply",
            from_fn_async(apply_retention_policy_cli)
                .with_display_serializable()
                .with_about("about.apply-backup-retention-policy")
                .with_call_remote::<crate::context::CliContext>(),
        )
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EstimateBackupCapacityParams {
    pub target_id: BackupTargetId,
    pub services: BackupServiceScope,
    pub default_retention: RetentionPolicy,
    pub retention_overrides: BTreeMap<PackageId, RetentionPolicy>,
}

#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct EstimateBackupCapacityCliParams {
    /// Backup target to estimate.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Estimate only these service package IDs. Accepts comma-separated values.
    #[arg(
        long,
        value_delimiter = ',',
        conflicts_with = "exclude_package_ids",
        help = "help.arg.automatic-backup-package-ids"
    )]
    pub package_ids: Vec<PackageId>,
    /// Estimate every current and future service except these package IDs.
    #[arg(
        long,
        value_delimiter = ',',
        conflicts_with = "package_ids",
        help = "help.arg.automatic-backup-excluded-package-ids"
    )]
    pub exclude_package_ids: Vec<PackageId>,
    /// Version-history rule INTERVAL:COVERAGE; accepts s, m, h, d, or w suffixes and may repeat.
    #[arg(
        long = "keep-rule",
        alias = "keep-tier",
        value_name = "INTERVAL:COVERAGE",
        value_parser = parse_retention_tier,
        help = "help.arg.automatic-backup-retention-tier"
    )]
    pub retention_tiers: Vec<RetentionTier>,
    /// Per-service version-history rule PACKAGE_ID=INTERVAL:COVERAGE; may repeat.
    #[arg(
        long = "service-keep-rule",
        alias = "service-keep-tier",
        value_name = "PACKAGE_ID=INTERVAL:COVERAGE",
        value_parser = parse_retention_override_tier,
        help = "help.arg.automatic-backup-service-retention-tier"
    )]
    pub retention_override_tiers: Vec<(PackageId, RetentionTier)>,
    /// Service package IDs that should keep only their latest checkpoint.
    #[arg(
        long = "service-latest-only",
        value_name = "PACKAGE_ID",
        value_delimiter = ',',
        help = "help.arg.automatic-backup-service-latest-only"
    )]
    pub latest_only_overrides: Vec<PackageId>,
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BackupServiceCapacityEstimate {
    pub package_id: PackageId,
    #[ts(type = "number")]
    pub live_logical_bytes: u64,
    pub retained_snapshot_count: usize,
    #[ts(type = "number")]
    pub maximum_projected_snapshot_count: u64,
    #[ts(type = "number")]
    pub scheduled_retained_bytes: u64,
    #[ts(type = "number | null")]
    pub manual_checkpoint_bytes: Option<u64>,
    #[ts(type = "number")]
    pub archived_bytes: u64,
    #[ts(type = "number")]
    pub staging_headroom_bytes: u64,
    #[ts(type = "number | null")]
    pub last_changed_bytes: Option<u64>,
    #[ts(type = "number")]
    pub conservative_peak_excluding_manual_bytes: u64,
}

pub async fn estimate_capacity(
    ctx: RpcContext,
    EstimateBackupCapacityParams {
        target_id,
        services,
        default_retention,
        retention_overrides,
    }: EstimateBackupCapacityParams,
) -> Result<Vec<BackupServiceCapacityEstimate>, Error> {
    default_retention.validate()?;
    for policy in retention_overrides.values() {
        policy.validate()?;
    }
    let db = ctx.db.peek().await;
    let package_ids = selected_installed_services(&db, &services)?;
    let mut estimates = Vec::with_capacity(package_ids.len());
    for package_id in package_ids {
        let live_path = Path::new(DATA_DIR).join(PKG_VOLUME_DIR).join(&package_id);
        let live_logical_bytes = if tokio::fs::metadata(&live_path).await.is_ok() {
            dir_size(&live_path, None).await?
        } else {
            0
        };
        let history: Option<ServiceTargetHistory> = db
            .as_public()
            .as_scheduled_backups()
            .as_histories()
            .as_idx(&history_key(&target_id, &package_id))
            .map(|history| history.de())
            .transpose()?;
        let policy = history
            .as_ref()
            .map(|history| history.policy.clone())
            .unwrap_or_else(|| {
                retention_overrides
                    .get(&package_id)
                    .unwrap_or(&default_retention)
                    .clone()
            });
        let maximum_projected_snapshot_count = policy.maximum_projected_snapshot_count()?;
        let active = history
            .as_ref()
            .map(|history| {
                history
                    .snapshots
                    .iter()
                    .filter(|snapshot| !snapshot.archived)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let archived = history
            .as_ref()
            .map(|history| {
                history
                    .snapshots
                    .iter()
                    .filter(|snapshot| snapshot.archived)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let scheduled_retained_bytes = active
            .iter()
            .map(|snapshot| snapshot.physical_size.unwrap_or(snapshot.logical_size))
            .sum::<u64>();
        let archived_bytes = archived
            .iter()
            .map(|snapshot| snapshot.physical_size.unwrap_or(snapshot.logical_size))
            .sum::<u64>();
        let measured_copy_bytes = active
            .iter()
            .max_by_key(|snapshot| snapshot.completed_at)
            .map(|snapshot| snapshot.physical_size.unwrap_or(snapshot.logical_size))
            .unwrap_or(live_logical_bytes)
            .max(live_logical_bytes);
        let staging_headroom_bytes = measured_copy_bytes
            .checked_mul(110)
            .and_then(|bytes| bytes.checked_add(99))
            .map(|bytes| bytes / 100)
            .ok_or_else(|| {
                Error::new(
                    eyre!("{}", t!("backup.scheduled.capacity-overflow")),
                    ErrorKind::InvalidRequest,
                )
            })?;
        let conservative_peak_excluding_manual_bytes = measured_copy_bytes
            .checked_mul(maximum_projected_snapshot_count)
            .and_then(|bytes| bytes.checked_add(archived_bytes))
            .and_then(|bytes| bytes.checked_add(staging_headroom_bytes))
            .ok_or_else(|| {
                Error::new(
                    eyre!("{}", t!("backup.scheduled.capacity-overflow")),
                    ErrorKind::InvalidRequest,
                )
            })?;
        estimates.push(BackupServiceCapacityEstimate {
            package_id,
            live_logical_bytes,
            retained_snapshot_count: active.len(),
            maximum_projected_snapshot_count,
            scheduled_retained_bytes,
            manual_checkpoint_bytes: None,
            archived_bytes,
            staging_headroom_bytes,
            last_changed_bytes: active
                .iter()
                .max_by_key(|snapshot| snapshot.completed_at)
                .and_then(|snapshot| snapshot.changed_bytes),
            conservative_peak_excluding_manual_bytes,
        });
    }
    Ok(estimates)
}

pub async fn estimate_capacity_cli(
    ctx: RpcContext,
    EstimateBackupCapacityCliParams {
        target_id,
        package_ids,
        exclude_package_ids,
        retention_tiers,
        retention_override_tiers,
        latest_only_overrides,
    }: EstimateBackupCapacityCliParams,
) -> Result<Vec<BackupServiceCapacityEstimate>, Error> {
    let services = if !package_ids.is_empty() {
        BackupServiceScope::Selected {
            package_ids: package_ids.into_iter().collect(),
        }
    } else {
        BackupServiceScope::AllExcept {
            excluded_package_ids: exclude_package_ids.into_iter().collect(),
        }
    };
    estimate_capacity(
        ctx,
        EstimateBackupCapacityParams {
            target_id,
            services,
            default_retention: RetentionPolicy {
                tiers: retention_tiers,
            },
            retention_overrides: retention_overrides_from_cli(
                retention_override_tiers,
                latest_only_overrides,
            )?,
        },
    )
    .await
}

pub async fn list(ctx: RpcContext) -> Result<Vec<BackupJob>, Error> {
    Ok(ctx
        .db
        .peek()
        .await
        .as_public()
        .as_scheduled_backups()
        .as_jobs()
        .as_entries()?
        .into_iter()
        .map(|(_, job)| job.de())
        .collect::<Result<_, _>>()?)
}

pub async fn list_histories(ctx: RpcContext) -> Result<Vec<ServiceTargetHistory>, Error> {
    ctx.db
        .peek()
        .await
        .as_public()
        .as_scheduled_backups()
        .as_histories()
        .as_entries()?
        .into_iter()
        .map(|(_, history)| history.de())
        .collect()
}

#[derive(Deserialize, Serialize, Parser, TS)]
#[group(skip)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct DiscoverScheduledBackupsParams {
    /// Backup target containing the automatic checkpoints.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Source StartOS server ID stored on the backup target.
    #[arg(help = "help.arg.server-id")]
    pub server_id: String,
    /// Master password that encrypted the source server's checkpoints.
    #[arg(help = "help.arg.backup-password")]
    pub password: String,
}

pub async fn discover_histories(
    ctx: RpcContext,
    DiscoverScheduledBackupsParams {
        target_id,
        server_id,
        password,
    }: DiscoverScheduledBackupsParams,
) -> Result<Vec<ServiceTargetHistory>, Error> {
    let db = ctx.db.peek().await;
    let guard = ScheduledBackupMountGuard::discover_with_password(
        TmpMountGuard::mount(&target_id.clone().load(&db)?, ReadWrite).await?,
        &server_id,
        &password,
    )
    .await?
    .0;
    let target_instance_id = guard.recovery.target_instance_id.clone();
    let histories = guard
        .metadata
        .services
        .iter()
        .map(|(package_id, history)| ServiceTargetHistory {
            target_id: target_id.clone(),
            target_instance_id: target_instance_id.clone(),
            package_id: package_id.clone(),
            timezone: history.timezone.clone(),
            policy: history.policy.clone(),
            feeding_jobs: history
                .snapshots
                .iter()
                .map(|snapshot| snapshot.job_id.clone())
                .collect(),
            snapshots: history.snapshots.clone(),
            archived: history.archived,
        })
        .collect();
    guard.unmount().await?;
    Ok(histories)
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArchivedSnapshotsParams {
    pub target_id: BackupTargetId,
    pub package_id: PackageId,
    pub snapshot_ids: BTreeSet<ServiceSnapshotId>,
}

#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct DeleteArchivedSnapshotsCliParams {
    /// Backup target containing the archived checkpoints.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Service package ID whose archived checkpoints should be deleted.
    #[arg(help = "help.arg.package-id")]
    pub package_id: PackageId,
    /// Automatic checkpoint IDs to delete.
    #[arg(required = true, help = "help.arg.automatic-backup-snapshot-ids")]
    pub snapshot_ids: Vec<ServiceSnapshotId>,
}

pub async fn delete_archived_snapshots_cli(
    ctx: RpcContext,
    DeleteArchivedSnapshotsCliParams {
        target_id,
        package_id,
        snapshot_ids,
    }: DeleteArchivedSnapshotsCliParams,
) -> Result<ServiceTargetHistory, Error> {
    delete_archived_snapshots(
        ctx,
        DeleteArchivedSnapshotsParams {
            target_id,
            package_id,
            snapshot_ids: snapshot_ids.into_iter().collect(),
        },
    )
    .await
}

pub async fn delete_archived_snapshots(
    ctx: RpcContext,
    DeleteArchivedSnapshotsParams {
        target_id,
        package_id,
        snapshot_ids,
    }: DeleteArchivedSnapshotsParams,
) -> Result<ServiceTargetHistory, Error> {
    let db = ctx.db.peek().await;
    let key = history_key(&target_id, &package_id);
    let mut history: ServiceTargetHistory = db
        .as_public()
        .as_scheduled_backups()
        .as_histories()
        .as_idx(&key)
        .or_not_found(&key)?
        .de()?;
    let archived_ids: BTreeSet<_> = history
        .snapshots
        .iter()
        .filter(|snapshot| snapshot.archived)
        .map(|snapshot| snapshot.id.clone())
        .collect();
    if !snapshot_ids.is_subset(&archived_ids) {
        return Err(Error::new(
            eyre!("{}", t!("backup.scheduled.delete-active-history")),
            ErrorKind::InvalidRequest,
        ));
    }
    let credential: ScheduledBackupCredential = db
        .as_private()
        .as_scheduled_backup_credentials()
        .as_idx(&target_id.to_string())
        .or_not_found(target_id.to_string())?
        .de()?;
    let encryption_key =
        credential.open(&db.as_private().as_scheduled_backup_device_key().de()?)?;
    let server_id = db.as_public().as_server_info().as_id().de()?;
    let mut guard = ScheduledBackupMountGuard::mount_with_key(
        TmpMountGuard::mount(&target_id.clone().load(&db)?, ReadWrite).await?,
        &server_id,
        &credential.target_instance_id,
        &encryption_key,
    )
    .await?;
    history.snapshots = guard
        .delete_archived_snapshots(&package_id, &snapshot_ids)
        .await?;
    guard.save_and_unmount().await?;
    ctx.db
        .mutate(|db| {
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_histories_mut()
                .insert(&key, &history)?;
            Ok(())
        })
        .await
        .result?;
    Ok(history)
}

#[derive(Deserialize, Serialize, Parser, TS)]
#[group(skip)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct RetryBackupTargetParams {
    /// Backup target to reconnect and resume.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Current master password.
    #[arg(help = "help.arg.backup-password")]
    pub password: PasswordType,
}

pub async fn retry_target(
    ctx: RpcContext,
    RetryBackupTargetParams {
        target_id,
        password,
    }: RetryBackupTargetParams,
) -> Result<Vec<BackupJob>, Error> {
    let password = password.decrypt(&ctx)?;
    let db = ctx.db.peek().await;
    RpcContext::check_password(&db, &password)?;
    let credential: ScheduledBackupCredential = db
        .as_private()
        .as_scheduled_backup_credentials()
        .as_idx(&target_id.to_string())
        .or_not_found(target_id.to_string())?
        .de()?;
    let server_id = db.as_public().as_server_info().as_id().de()?;
    let (guard, encryption_key) = ScheduledBackupMountGuard::mount_with_password(
        TmpMountGuard::mount(&target_id.clone().load(&db)?, ReadWrite).await?,
        &server_id,
        &credential.target_instance_id,
        &password,
    )
    .await?;
    guard.save_and_unmount().await?;

    let jobs = ctx
        .db
        .mutate(|db| {
            let device_key = db.as_private().as_scheduled_backup_device_key().de()?;
            let credential = ScheduledBackupCredential::seal(
                credential.target_instance_id.clone(),
                &encryption_key,
                &device_key,
            )?;
            db.as_private_mut()
                .as_scheduled_backup_credentials_mut()
                .insert(&target_id.to_string(), &credential)?;

            let state = db.as_public_mut().as_scheduled_backups_mut();
            let jobs: Vec<BackupJob> = state
                .as_jobs()
                .as_entries()?
                .into_iter()
                .map(|(_, job)| job.de())
                .collect::<Result<Vec<BackupJob>, Error>>()?;
            let mut resumed = Vec::new();
            for mut job in jobs.into_iter().filter(|job| job.target_id == target_id) {
                if matches!(
                    job.pause,
                    Some(
                        BackupJobPause::TargetUnavailable { .. }
                            | BackupJobPause::TargetIdentityMismatch
                            | BackupJobPause::ReauthenticationRequired
                    )
                ) {
                    job.pause = None;
                    job.status.consecutive_failures = 0;
                    job.status.next_run_at = job
                        .enabled
                        .then(|| {
                            job.schedule
                                .next_after_cursor(Utc::now(), job.status.last_scheduled_at)
                        })
                        .transpose()?
                        .map(|next| next.utc);
                    job.updated_at = Utc::now();
                    state.as_jobs_mut().insert(&job.id, &job)?;
                }
                resumed.push(job);
            }
            let mut failure = state
                .as_target_failures()
                .as_idx(&target_id.to_string())
                .map(|state| state.de())
                .transpose()?
                .unwrap_or_default();
            failure.reset();
            state
                .as_target_failures_mut()
                .insert(&target_id.to_string(), &failure)?;
            Ok(resumed)
        })
        .await
        .result?;
    sync_archive_states(&ctx, &target_id).await.log_err();
    Ok(jobs)
}

#[derive(Deserialize, Serialize, Parser, TS)]
#[group(skip)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct ReassignBackupTargetParams {
    /// Automatic backup job ID to move.
    #[arg(help = "help.arg.automatic-backup-job-id")]
    pub id: BackupJobId,
    /// New backup target ID.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Current master password.
    #[arg(help = "help.arg.backup-password")]
    pub password: PasswordType,
    /// Wait for the next scheduled time instead of running on the new target now.
    #[arg(long, help = "help.arg.automatic-backup-wait-for-schedule")]
    #[serde(default)]
    pub wait_for_schedule: bool,
}

pub async fn reassign_target(
    ctx: RpcContext,
    ReassignBackupTargetParams {
        id,
        target_id,
        password,
        wait_for_schedule,
    }: ReassignBackupTargetParams,
) -> Result<BackupJob, Error> {
    let password = password.decrypt(&ctx)?;
    let db = ctx.db.peek().await;
    RpcContext::check_password(&db, &password)?;
    let mut job: BackupJob = db
        .as_public()
        .as_scheduled_backups()
        .as_jobs()
        .as_idx(&id)
        .or_not_found(&id)?
        .de()?;
    let package_ids = selected_installed_services(&db, &job.services)?;
    validate_new_job_coverage(
        &db,
        &target_id,
        &package_ids,
        &job.schedule,
        &job.default_retention,
        &job.retention_overrides,
        None,
        true,
    )?;
    validate_remaining_coverage(&db, &job.target_id, &package_ids, &job.id)?;
    let server_id = db.as_public().as_server_info().as_id().de()?;
    let hostname = ctx
        .account
        .peek(|account| account.hostname.hostname.clone());
    let target_guard = TmpMountGuard::mount(&target_id.clone().load(&db)?, ReadWrite).await?;
    let available = crate::disk::util::get_available(target_guard.path()).await?;
    super::runner::preflight_new_target_capacity(&package_ids, available).await?;
    let (guard, encryption_key) =
        ScheduledBackupMountGuard::initialize(target_guard, &server_id, hostname, &password)
            .await?;
    let target_instance_id = guard.recovery.target_instance_id.clone();
    guard.save_and_unmount().await?;

    let old_job = job.clone();
    job.target_id = target_id.clone();
    job.target_instance_id = target_instance_id.clone();
    job.pause = None;
    job.enabled = true;
    job.updated_at = Utc::now();
    job.status.consecutive_failures = 0;
    job.status.next_run_at = if wait_for_schedule {
        Some(job.schedule.next_after(Utc::now(), None)?.utc)
    } else {
        Some(Utc::now())
    };
    ctx.db
        .mutate(|db| {
            let device_key = db.as_private().as_scheduled_backup_device_key().de()?;
            let credential =
                ScheduledBackupCredential::seal(target_instance_id, &encryption_key, &device_key)?;
            db.as_private_mut()
                .as_scheduled_backup_credentials_mut()
                .insert(&target_id.to_string(), &credential)?;
            disassociate_histories(db, &old_job, &package_ids)?;
            associate_histories(db, &job, &package_ids)?;
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_jobs_mut()
                .insert(&id, &job)?;
            refresh_archive_state(db, &old_job.target_id)?;
            refresh_archive_state(db, &target_id)?;
            Ok(())
        })
        .await
        .result?;
    sync_archive_states(&ctx, &old_job.target_id)
        .await
        .log_err();
    sync_archive_states(&ctx, &job.target_id).await.log_err();
    Ok(job)
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRetentionPolicyParams {
    pub target_id: BackupTargetId,
    pub package_id: PackageId,
    pub policy: RetentionPolicy,
}

pub async fn preview_policy_change(
    ctx: RpcContext,
    params: PreviewRetentionPolicyParams,
) -> Result<RetentionPolicyChangePreview, Error> {
    let db = ctx.db.peek().await;
    policy_preview(&db, &params)
}

#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct PreviewRetentionPolicyCliParams {
    /// Backup target containing the automatic checkpoints.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Service package ID whose automatic checkpoints should use this policy.
    #[arg(help = "help.arg.package-id")]
    pub package_id: PackageId,
    /// Version-history rule INTERVAL:COVERAGE; accepts s, m, h, d, or w suffixes and may repeat.
    #[arg(
        long = "keep-rule",
        alias = "keep-tier",
        value_name = "INTERVAL:COVERAGE",
        value_parser = parse_retention_tier,
        required_unless_present = "latest_only",
        conflicts_with = "latest_only",
        help = "help.arg.automatic-backup-retention-tier"
    )]
    pub retention_tiers: Vec<RetentionTier>,
    /// Keep only the latest automatic checkpoint.
    #[arg(
        long,
        required_unless_present = "retention_tiers",
        help = "help.arg.automatic-backup-latest-only"
    )]
    pub latest_only: bool,
}

pub async fn preview_policy_change_cli(
    ctx: RpcContext,
    PreviewRetentionPolicyCliParams {
        target_id,
        package_id,
        retention_tiers,
        latest_only,
    }: PreviewRetentionPolicyCliParams,
) -> Result<RetentionPolicyChangePreview, Error> {
    preview_policy_change(
        ctx,
        PreviewRetentionPolicyParams {
            target_id,
            package_id,
            policy: retention_policy_from_cli(retention_tiers, latest_only)?,
        },
    )
    .await
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRetentionPolicyParams {
    pub target_id: BackupTargetId,
    pub package_id: PackageId,
    pub policy: RetentionPolicy,
    pub confirmed_removals: BTreeSet<ServiceSnapshotId>,
}

#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct ApplyRetentionPolicyCliParams {
    /// Backup target containing the automatic checkpoints.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Service package ID whose automatic checkpoints should use this policy.
    #[arg(help = "help.arg.package-id")]
    pub package_id: PackageId,
    /// Version-history rule INTERVAL:COVERAGE; accepts s, m, h, d, or w suffixes and may repeat.
    #[arg(
        long = "keep-rule",
        alias = "keep-tier",
        value_name = "INTERVAL:COVERAGE",
        value_parser = parse_retention_tier,
        required_unless_present = "latest_only",
        conflicts_with = "latest_only",
        help = "help.arg.automatic-backup-retention-tier"
    )]
    pub retention_tiers: Vec<RetentionTier>,
    /// Keep only the latest automatic checkpoint.
    #[arg(
        long,
        required_unless_present = "retention_tiers",
        help = "help.arg.automatic-backup-latest-only"
    )]
    pub latest_only: bool,
    /// Checkpoint ID reported as removed by preview-change. Repeat for every reported ID.
    #[arg(
        long = "confirm-removal",
        value_name = "CHECKPOINT_ID",
        help = "help.arg.automatic-backup-confirm-removal"
    )]
    pub confirmed_removals: Vec<ServiceSnapshotId>,
}

pub async fn apply_retention_policy_cli(
    ctx: RpcContext,
    ApplyRetentionPolicyCliParams {
        target_id,
        package_id,
        retention_tiers,
        latest_only,
        confirmed_removals,
    }: ApplyRetentionPolicyCliParams,
) -> Result<ServiceTargetHistory, Error> {
    update_policy(
        ctx,
        UpdateRetentionPolicyParams {
            target_id,
            package_id,
            policy: retention_policy_from_cli(retention_tiers, latest_only)?,
            confirmed_removals: confirmed_removals.into_iter().collect(),
        },
    )
    .await
}

fn retention_policy_from_cli(
    retention_tiers: Vec<RetentionTier>,
    latest_only: bool,
) -> Result<RetentionPolicy, Error> {
    if latest_only != retention_tiers.is_empty() {
        return Err(Error::new(
            eyre!("{}", t!("backup.scheduled.invalid-retention-tiers")),
            ErrorKind::InvalidRequest,
        ));
    }
    let policy = RetentionPolicy {
        tiers: retention_tiers,
    };
    policy.validate()?;
    Ok(policy)
}

pub async fn update_policy(
    ctx: RpcContext,
    UpdateRetentionPolicyParams {
        target_id,
        package_id,
        policy,
        confirmed_removals,
    }: UpdateRetentionPolicyParams,
) -> Result<ServiceTargetHistory, Error> {
    policy.validate()?;
    let db = ctx.db.peek().await;
    let preview = policy_preview(
        &db,
        &PreviewRetentionPolicyParams {
            target_id: target_id.clone(),
            package_id: package_id.clone(),
            policy: policy.clone(),
        },
    )?;
    let exact_removals: BTreeSet<_> = preview.removed.iter().map(|s| s.id.clone()).collect();
    if exact_removals != confirmed_removals {
        return Err(Error::new(
            eyre!("{}", t!("backup.scheduled.prune-confirmation-stale")),
            ErrorKind::InvalidRequest,
        ));
    }
    let key = history_key(&target_id, &package_id);
    let mut history: ServiceTargetHistory = db
        .as_public()
        .as_scheduled_backups()
        .as_histories()
        .as_idx(&key)
        .or_not_found(&key)?
        .de()?;
    validate_history_policy_coverage(&db, &history, &policy, None)?;
    let credential: ScheduledBackupCredential = db
        .as_private()
        .as_scheduled_backup_credentials()
        .as_idx(&target_id.to_string())
        .or_not_found(target_id.to_string())?
        .de()?;
    let encryption_key =
        credential.open(&db.as_private().as_scheduled_backup_device_key().de()?)?;
    let server_id = db.as_public().as_server_info().as_id().de()?;
    let mut guard = ScheduledBackupMountGuard::mount_with_key(
        TmpMountGuard::mount(&target_id.clone().load(&db)?, ReadWrite).await?,
        &server_id,
        &credential.target_instance_id,
        &encryption_key,
    )
    .await?;
    history.snapshots = guard
        .apply_policy(&package_id, history.timezone.clone(), policy.clone())
        .await?;
    guard.save_and_unmount().await?;
    history.policy = policy;
    ctx.db
        .mutate(|db| {
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_histories_mut()
                .insert(&key, &history)?;
            Ok(())
        })
        .await
        .result?;
    Ok(history)
}

fn policy_preview(
    db: &DatabaseModel,
    params: &PreviewRetentionPolicyParams,
) -> Result<RetentionPolicyChangePreview, Error> {
    params.policy.validate()?;
    let key = history_key(&params.target_id, &params.package_id);
    let history: ServiceTargetHistory = db
        .as_public()
        .as_scheduled_backups()
        .as_histories()
        .as_idx(&key)
        .or_not_found(&key)?
        .de()?;
    let timezone = history.timezone.parse().map_err(|_| {
        Error::new(
            eyre!("{}", t!("backup.scheduled.stored-timezone-invalid")),
            ErrorKind::Backup,
        )
    })?;
    let preview = params.policy.preview(&history.snapshots, timezone)?;
    let jobs = db.as_public().as_scheduled_backups().as_jobs();
    let affected_jobs = history
        .feeding_jobs
        .iter()
        .filter_map(|id| jobs.as_idx(id))
        .map(|job| job.de().map(|job: BackupJob| job.name))
        .collect::<Result<_, _>>()?;
    Ok(RetentionPolicyChangePreview {
        removed: preview.removed,
        estimated_reclaimed_bytes: preview.estimated_reclaimed_bytes,
        affected_jobs,
    })
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateBackupJobParams {
    pub name: String,
    pub target_id: BackupTargetId,
    pub services: BackupServiceScope,
    pub schedule: Schedule,
    pub default_retention: RetentionPolicy,
    pub retention_overrides: BTreeMap<PackageId, RetentionPolicy>,
    pub password: PasswordType,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// CLI-friendly automatic backup creation. Omitting both service filters means
/// every current and future service. Omitting version-history rules means latest-only.
#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct AddBackupJobCliParams {
    /// Display name for the automatic backup job.
    #[arg(help = "help.arg.automatic-backup-job-name")]
    pub name: String,
    /// Backup target identifier, such as cifs-0 or disk-/dev/sda1.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Master password used to initialize the encrypted automatic backup store.
    #[arg(help = "help.arg.backup-password")]
    pub password: PasswordType,
    /// Five-field cron expression (minute, hour, day of month, month, weekday).
    #[arg(
        long,
        default_value = "0 3 * * *",
        help = "help.arg.automatic-backup-cron"
    )]
    pub cron: String,
    /// IANA timezone for the schedule.
    #[arg(
        long,
        default_value = "UTC",
        help = "help.arg.automatic-backup-timezone"
    )]
    pub timezone: String,
    /// Back up only these service package IDs. Accepts comma-separated values.
    #[arg(
        long,
        value_delimiter = ',',
        conflicts_with = "exclude_package_ids",
        help = "help.arg.automatic-backup-package-ids"
    )]
    pub package_ids: Vec<PackageId>,
    /// Back up every current and future service except these package IDs.
    #[arg(
        long,
        value_delimiter = ',',
        conflicts_with = "package_ids",
        help = "help.arg.automatic-backup-excluded-package-ids"
    )]
    pub exclude_package_ids: Vec<PackageId>,
    /// Version-history rule INTERVAL:COVERAGE; accepts s, m, h, d, or w suffixes and may repeat.
    #[arg(
        long = "keep-rule",
        alias = "keep-tier",
        value_name = "INTERVAL:COVERAGE",
        value_parser = parse_retention_tier,
        help = "help.arg.automatic-backup-retention-tier"
    )]
    pub retention_tiers: Vec<RetentionTier>,
    /// Per-service version-history rule PACKAGE_ID=INTERVAL:COVERAGE; may repeat.
    #[arg(
        long = "service-keep-rule",
        alias = "service-keep-tier",
        value_name = "PACKAGE_ID=INTERVAL:COVERAGE",
        value_parser = parse_retention_override_tier,
        help = "help.arg.automatic-backup-service-retention-tier"
    )]
    pub retention_override_tiers: Vec<(PackageId, RetentionTier)>,
    /// Service package IDs that should keep only their latest checkpoint.
    #[arg(
        long = "service-latest-only",
        value_name = "PACKAGE_ID",
        value_delimiter = ',',
        help = "help.arg.automatic-backup-service-latest-only"
    )]
    pub latest_only_overrides: Vec<PackageId>,
    /// Create the job paused instead of scheduling its first run.
    #[arg(long, help = "help.arg.automatic-backup-disabled")]
    pub disabled: bool,
}

pub async fn add_cli(
    ctx: RpcContext,
    AddBackupJobCliParams {
        name,
        target_id,
        password,
        cron,
        timezone,
        package_ids,
        exclude_package_ids,
        retention_tiers,
        retention_override_tiers,
        latest_only_overrides,
        disabled,
    }: AddBackupJobCliParams,
) -> Result<BackupJob, Error> {
    let services = if !package_ids.is_empty() {
        BackupServiceScope::Selected {
            package_ids: package_ids.into_iter().collect(),
        }
    } else {
        BackupServiceScope::AllExcept {
            excluded_package_ids: exclude_package_ids.into_iter().collect(),
        }
    };
    create(
        ctx,
        CreateBackupJobParams {
            name,
            target_id,
            services,
            schedule: Schedule::new(cron, timezone)?,
            default_retention: RetentionPolicy {
                tiers: retention_tiers,
            },
            retention_overrides: retention_overrides_from_cli(
                retention_override_tiers,
                latest_only_overrides,
            )?,
            password,
            enabled: !disabled,
        },
    )
    .await
}

/// Update only the automatic backup job settings supplied on the command line.
#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct EditBackupJobCliParams {
    /// Automatic backup job ID.
    #[arg(help = "help.arg.automatic-backup-job-id")]
    pub id: BackupJobId,
    /// New display name.
    #[arg(long, help = "help.arg.automatic-backup-job-name")]
    pub name: Option<String>,
    /// New five-field cron expression (minute, hour, day of month, month, weekday).
    #[arg(long, help = "help.arg.automatic-backup-cron")]
    pub cron: Option<String>,
    /// New IANA timezone for the schedule.
    #[arg(long, help = "help.arg.automatic-backup-timezone")]
    pub timezone: Option<String>,
    /// Back up every current and future service.
    #[arg(
        long,
        conflicts_with_all = ["package_ids", "exclude_package_ids"],
        help = "help.arg.automatic-backup-all-services"
    )]
    pub all_services: bool,
    /// Back up only these service package IDs. Accepts comma-separated values.
    #[arg(
        long,
        value_delimiter = ',',
        conflicts_with_all = ["all_services", "exclude_package_ids"],
        help = "help.arg.automatic-backup-package-ids"
    )]
    pub package_ids: Vec<PackageId>,
    /// Back up every current and future service except these package IDs.
    #[arg(
        long,
        value_delimiter = ',',
        conflicts_with_all = ["all_services", "package_ids"],
        help = "help.arg.automatic-backup-excluded-package-ids"
    )]
    pub exclude_package_ids: Vec<PackageId>,
    /// Version-history rule INTERVAL:COVERAGE; accepts s, m, h, d, or w suffixes and may repeat.
    #[arg(
        long = "keep-rule",
        alias = "keep-tier",
        value_name = "INTERVAL:COVERAGE",
        value_parser = parse_retention_tier,
        conflicts_with = "latest_only",
        help = "help.arg.automatic-backup-retention-tier"
    )]
    pub retention_tiers: Vec<RetentionTier>,
    /// Keep only the latest automatic checkpoint.
    #[arg(long, help = "help.arg.automatic-backup-latest-only")]
    pub latest_only: bool,
    /// Set per-service version-history rule PACKAGE_ID=INTERVAL:COVERAGE; may repeat.
    #[arg(
        long = "service-keep-rule",
        alias = "service-keep-tier",
        value_name = "PACKAGE_ID=INTERVAL:COVERAGE",
        value_parser = parse_retention_override_tier,
        help = "help.arg.automatic-backup-service-retention-tier"
    )]
    pub retention_override_tiers: Vec<(PackageId, RetentionTier)>,
    /// Set these service package IDs to latest-checkpoint-only retention.
    #[arg(
        long = "service-latest-only",
        value_name = "PACKAGE_ID",
        value_delimiter = ',',
        help = "help.arg.automatic-backup-service-latest-only"
    )]
    pub latest_only_overrides: Vec<PackageId>,
    /// Remove per-service overrides so these packages use the job default.
    #[arg(
        long = "use-default-retention",
        value_name = "PACKAGE_ID",
        value_delimiter = ',',
        help = "help.arg.automatic-backup-use-default-retention"
    )]
    pub default_retention_packages: Vec<PackageId>,
}

pub async fn edit_cli(
    ctx: RpcContext,
    EditBackupJobCliParams {
        id,
        name,
        cron,
        timezone,
        all_services,
        package_ids,
        exclude_package_ids,
        retention_tiers,
        latest_only,
        retention_override_tiers,
        latest_only_overrides,
        default_retention_packages,
    }: EditBackupJobCliParams,
) -> Result<BackupJob, Error> {
    let job: BackupJob = ctx
        .db
        .peek()
        .await
        .as_public()
        .as_scheduled_backups()
        .as_jobs()
        .as_idx(&id)
        .or_not_found(&id)?
        .de()?;
    let services = if all_services {
        BackupServiceScope::All
    } else if !package_ids.is_empty() {
        BackupServiceScope::Selected {
            package_ids: package_ids.into_iter().collect(),
        }
    } else if !exclude_package_ids.is_empty() {
        BackupServiceScope::AllExcept {
            excluded_package_ids: exclude_package_ids.into_iter().collect(),
        }
    } else {
        job.services.clone()
    };
    let schedule = if cron.is_some() || timezone.is_some() {
        Schedule::new(
            cron.unwrap_or_else(|| job.schedule.cron.clone()),
            timezone.unwrap_or_else(|| job.schedule.timezone.clone()),
        )?
    } else {
        job.schedule.clone()
    };
    let default_retention = if latest_only {
        RetentionPolicy::latest_only()
    } else if !retention_tiers.is_empty() {
        RetentionPolicy {
            tiers: retention_tiers,
        }
    } else {
        job.default_retention.clone()
    };

    let mut retention_overrides = job.retention_overrides;
    let override_updates =
        retention_overrides_from_cli(retention_override_tiers, latest_only_overrides)?;
    let default_retention_packages: BTreeSet<_> = default_retention_packages.into_iter().collect();
    if override_updates
        .keys()
        .any(|package_id| default_retention_packages.contains(package_id))
    {
        return Err(Error::new(
            eyre!("{}", t!("backup.scheduled.invalid-retention-tiers")),
            ErrorKind::InvalidRequest,
        ));
    }
    for package_id in default_retention_packages {
        retention_overrides.remove(&package_id);
    }
    retention_overrides.extend(override_updates);

    update(
        ctx,
        UpdateBackupJobParams {
            id,
            name: name.unwrap_or(job.name),
            services,
            schedule,
            default_retention,
            retention_overrides,
        },
    )
    .await
}

fn parse_retention_tier(value: &str) -> Result<RetentionTier, String> {
    let (interval, coverage) = value
        .split_once(':')
        .ok_or_else(|| t!("backup.scheduled.invalid-version-history-rule").to_string())?;
    let tier = RetentionTier {
        interval_seconds: parse_duration_seconds(interval)?,
        coverage_seconds: parse_duration_seconds(coverage)?,
    };
    RetentionPolicy {
        tiers: vec![tier.clone()],
    }
    .validate()
    .map_err(|error| error.to_string())?;
    Ok(tier)
}

fn parse_retention_override_tier(value: &str) -> Result<(PackageId, RetentionTier), String> {
    let (package_id, tier) = value
        .split_once('=')
        .ok_or_else(|| t!("backup.scheduled.invalid-retention-override").to_string())?;
    Ok((
        package_id
            .parse()
            .map_err(|error: crate::id::InvalidId| error.to_string())?,
        parse_retention_tier(tier)?,
    ))
}

fn retention_overrides_from_cli(
    retention_override_tiers: Vec<(PackageId, RetentionTier)>,
    latest_only_overrides: Vec<PackageId>,
) -> Result<BTreeMap<PackageId, RetentionPolicy>, Error> {
    let mut overrides: BTreeMap<PackageId, RetentionPolicy> = BTreeMap::new();
    for (package_id, tier) in retention_override_tiers {
        overrides.entry(package_id).or_default().tiers.push(tier);
    }
    for package_id in latest_only_overrides {
        if overrides.contains_key(&package_id) {
            return Err(Error::new(
                eyre!("{}", t!("backup.scheduled.invalid-retention-tiers")),
                ErrorKind::InvalidRequest,
            ));
        }
        overrides.insert(package_id, RetentionPolicy::latest_only());
    }
    for policy in overrides.values() {
        policy.validate()?;
    }
    Ok(overrides)
}

fn parse_duration_seconds(value: &str) -> Result<u64, String> {
    let value = value.trim();
    let split = value
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(value.len());
    let (amount, suffix) = value.split_at(split);
    let amount = amount
        .parse::<u64>()
        .map_err(|_| t!("backup.scheduled.invalid-duration", value = value).to_string())?;
    let multiplier = match suffix {
        "" | "s" => 1,
        "m" => 60,
        "h" => 60 * 60,
        "d" => 24 * 60 * 60,
        "w" => 7 * 24 * 60 * 60,
        _ => {
            return Err(t!("backup.scheduled.invalid-duration-unit", value = value).to_string());
        }
    };
    amount
        .checked_mul(multiplier)
        .filter(|seconds| *seconds > 0)
        .ok_or_else(|| t!("backup.scheduled.invalid-duration", value = value).to_string())
}

pub fn parse_checkpoint_selection(value: &str) -> Result<(PackageId, ServiceSnapshotId), String> {
    let (package_id, snapshot_id) = value
        .split_once('=')
        .ok_or_else(|| t!("backup.scheduled.invalid-checkpoint-selection").to_string())?;
    Ok((
        package_id
            .parse()
            .map_err(|error: crate::id::InvalidId| error.to_string())?,
        snapshot_id
            .parse()
            .map_err(|error: Error| error.to_string())?,
    ))
}

pub fn parse_review_decision(value: &str) -> Result<(BackupJobId, bool), String> {
    let (job_id, decision) = value
        .split_once('=')
        .ok_or_else(|| t!("backup.scheduled.invalid-review-decision").to_string())?;
    let add = match decision {
        "add" => true,
        "skip" => false,
        _ => {
            return Err(t!("backup.scheduled.invalid-review-decision").to_string());
        }
    };
    Ok((
        job_id.parse().map_err(|error: Error| error.to_string())?,
        add,
    ))
}

#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct ResolveBackupReviewCliParams {
    /// Newly installed service package ID awaiting a backup decision.
    #[arg(help = "help.arg.package-id")]
    pub package_id: PackageId,
    /// Decision for an affected job, as JOB_ID=add or JOB_ID=skip. Repeat for every job.
    #[arg(
        long = "decision",
        required = true,
        value_parser = parse_review_decision,
        help = "help.arg.automatic-backup-review-decision"
    )]
    pub decisions: Vec<(BackupJobId, bool)>,
}

pub async fn resolve_review_cli(
    ctx: RpcContext,
    ResolveBackupReviewCliParams {
        package_id,
        decisions,
    }: ResolveBackupReviewCliParams,
) -> Result<(), Error> {
    super::review::resolve(
        ctx,
        super::review::ResolveNewServiceBackupReviewParams {
            package_id,
            decisions: decisions.into_iter().collect(),
        },
    )
    .await
}

#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct RestoreAutomaticCheckpointCliParams {
    /// Backup target containing the automatic checkpoints.
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    /// Checkpoint selection as PACKAGE_ID=SNAPSHOT_ID. Repeat to restore multiple services.
    #[arg(
        required = true,
        value_parser = parse_checkpoint_selection,
        help = "help.arg.automatic-backup-checkpoint-selection"
    )]
    pub checkpoints: Vec<(PackageId, ServiceSnapshotId)>,
    /// Source StartOS server ID. Defaults to this server.
    #[arg(long, help = "help.arg.server-id")]
    pub server_id: Option<String>,
    /// Master password, required when this server has no saved target credential.
    #[arg(long, help = "help.arg.backup-password")]
    pub password: Option<String>,
}

pub async fn restore_automatic_checkpoint_cli(
    ctx: RpcContext,
    RestoreAutomaticCheckpointCliParams {
        target_id,
        checkpoints,
        server_id,
        password,
    }: RestoreAutomaticCheckpointCliParams,
) -> Result<(), Error> {
    crate::backup::restore::restore_scheduled_packages_rpc(
        ctx,
        crate::backup::restore::RestoreScheduledPackagesParams {
            target_id,
            snapshots: checkpoints.into_iter().collect(),
            server_id,
            password,
        },
    )
    .await
}

pub async fn create(
    ctx: RpcContext,
    CreateBackupJobParams {
        name,
        target_id,
        services,
        schedule,
        default_retention,
        retention_overrides,
        password,
        enabled,
    }: CreateBackupJobParams,
) -> Result<BackupJob, Error> {
    validate_job_input(&name, &schedule, &default_retention, &retention_overrides)?;
    let password = password.decrypt(&ctx)?;
    let db = ctx.db.peek().await;
    RpcContext::check_password(&db, &password)?;
    let package_ids = selected_installed_services(&db, &services)?;
    validate_new_job_coverage(
        &db,
        &target_id,
        &package_ids,
        &schedule,
        &default_retention,
        &retention_overrides,
        None,
        enabled,
    )?;
    let server_id = db.as_public().as_server_info().as_id().de()?;
    let hostname = ctx
        .account
        .peek(|account| account.hostname.hostname.clone());
    let target_guard = TmpMountGuard::mount(&target_id.clone().load(&db)?, ReadWrite).await?;
    let (scheduled_guard, encryption_key) =
        ScheduledBackupMountGuard::initialize(target_guard, &server_id, hostname, &password)
            .await?;
    let target_instance_id = scheduled_guard.recovery.target_instance_id.clone();
    scheduled_guard.save_and_unmount().await?;

    let id = Guid::new();
    let now = Utc::now();
    let next_run_at = enabled
        .then(|| schedule.next_after(now, None))
        .transpose()?
        .map(|x| x.utc);
    let job = BackupJob {
        id: id.clone(),
        name,
        enabled,
        pause: None,
        target_id: target_id.clone(),
        target_instance_id: target_instance_id.clone(),
        services,
        schedule,
        default_retention,
        retention_overrides,
        status: BackupJobStatus {
            next_run_at,
            ..Default::default()
        },
        created_at: now,
        updated_at: now,
    };

    ctx.db
        .mutate(|db| {
            let device_key = db.as_private().as_scheduled_backup_device_key().de()?;
            let credential =
                ScheduledBackupCredential::seal(target_instance_id, &encryption_key, &device_key)?;
            db.as_private_mut()
                .as_scheduled_backup_credentials_mut()
                .insert(&target_id.to_string(), &credential)?;
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_jobs_mut()
                .insert(&id, &job)?;
            associate_histories(db, &job, &package_ids)?;
            refresh_archive_state(db, &job.target_id)?;
            Ok(())
        })
        .await
        .result?;
    sync_archive_states(&ctx, &job.target_id).await.log_err();
    Ok(job)
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBackupJobParams {
    pub id: BackupJobId,
    pub name: String,
    pub services: BackupServiceScope,
    pub schedule: Schedule,
    pub default_retention: RetentionPolicy,
    pub retention_overrides: BTreeMap<PackageId, RetentionPolicy>,
}

pub async fn update(
    ctx: RpcContext,
    UpdateBackupJobParams {
        id,
        name,
        services,
        schedule,
        default_retention,
        retention_overrides,
    }: UpdateBackupJobParams,
) -> Result<BackupJob, Error> {
    validate_job_input(&name, &schedule, &default_retention, &retention_overrides)?;
    let snapshot = ctx.db.peek().await;
    let mut job: BackupJob = snapshot
        .as_public()
        .as_scheduled_backups()
        .as_jobs()
        .as_idx(&id)
        .or_not_found(&id)?
        .de()?;
    let old_services = selected_installed_services(&snapshot, &job.services)?;
    let new_services = selected_installed_services(&snapshot, &services)?;
    let removed_services = old_services.difference(&new_services).cloned().collect();
    validate_remaining_coverage(&snapshot, &job.target_id, &removed_services, &id)?;
    validate_new_job_coverage(
        &snapshot,
        &job.target_id,
        &new_services,
        &schedule,
        &default_retention,
        &retention_overrides,
        Some(&id),
        job.enabled && job.pause.is_none(),
    )?;
    job.name = name;
    job.services = services;
    job.schedule = schedule;
    job.default_retention = default_retention;
    job.retention_overrides = retention_overrides;
    job.updated_at = Utc::now();
    job.status.next_run_at = job
        .enabled
        .then(|| job.schedule.next_after(Utc::now(), None))
        .transpose()?
        .map(|x| x.utc);

    ctx.db
        .mutate(|db| {
            disassociate_histories(db, &job, &removed_services)?;
            associate_histories(db, &job, &new_services)?;
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_jobs_mut()
                .insert(&id, &job)?;
            refresh_archive_state(db, &job.target_id)?;
            Ok(())
        })
        .await
        .result?;
    sync_archive_states(&ctx, &job.target_id).await.log_err();
    Ok(job)
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SetBackupJobEnabledParams {
    pub id: BackupJobId,
    pub enabled: bool,
}

pub async fn set_enabled(
    ctx: RpcContext,
    SetBackupJobEnabledParams { id, enabled }: SetBackupJobEnabledParams,
) -> Result<BackupJob, Error> {
    let job = ctx
        .db
        .mutate(|db| {
            let mut job: BackupJob = db
                .as_public()
                .as_scheduled_backups()
                .as_jobs()
                .as_idx(&id)
                .or_not_found(&id)?
                .de()?;
            if enabled
                && matches!(
                    job.pause,
                    Some(
                        BackupJobPause::TargetUnavailable { .. }
                            | BackupJobPause::TargetIdentityMismatch
                            | BackupJobPause::ReauthenticationRequired
                    )
                )
            {
                return Err(Error::new(
                    eyre!("{}", t!("backup.scheduled.retry-before-resume")),
                    ErrorKind::InvalidRequest,
                ));
            }
            let package_ids = selected_installed_services(db, &job.services)?;
            if enabled {
                validate_new_job_coverage(
                    db,
                    &job.target_id,
                    &package_ids,
                    &job.schedule,
                    &job.default_retention,
                    &job.retention_overrides,
                    Some(&job.id),
                    true,
                )?;
            } else {
                validate_remaining_coverage(db, &job.target_id, &package_ids, &job.id)?;
            }
            job.enabled = enabled;
            job.pause = match (&job.pause, enabled) {
                (Some(BackupJobPause::User), true) => None,
                (None, false) => Some(BackupJobPause::User),
                (pause, _) => pause.clone(),
            };
            job.updated_at = Utc::now();
            job.status.next_run_at = enabled
                .then(|| job.schedule.next_after(Utc::now(), None))
                .transpose()?
                .map(|x| x.utc);
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_jobs_mut()
                .insert(&id, &job)?;
            refresh_archive_state(db, &job.target_id)?;
            Ok(job)
        })
        .await
        .result?;
    sync_archive_states(&ctx, &job.target_id).await.log_err();
    Ok(job)
}

#[derive(Deserialize, Serialize, Parser, TS)]
#[group(skip)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct DeleteBackupJobParams {
    /// Automatic backup job ID.
    #[arg(help = "help.arg.automatic-backup-job-id")]
    pub id: BackupJobId,
}

#[derive(Deserialize, Serialize, Parser, TS)]
#[group(skip)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct RunBackupJobNowParams {
    /// Automatic backup job ID.
    #[arg(help = "help.arg.automatic-backup-job-id")]
    pub id: BackupJobId,
}

#[derive(Deserialize, Serialize, Parser)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
pub struct BackupJobIdCliParams {
    /// Automatic backup job ID.
    #[arg(help = "help.arg.automatic-backup-job-id")]
    pub id: BackupJobId,
}

pub async fn enable_cli(
    ctx: RpcContext,
    BackupJobIdCliParams { id }: BackupJobIdCliParams,
) -> Result<BackupJob, Error> {
    set_enabled(ctx, SetBackupJobEnabledParams { id, enabled: true }).await
}

pub async fn disable_cli(
    ctx: RpcContext,
    BackupJobIdCliParams { id }: BackupJobIdCliParams,
) -> Result<BackupJob, Error> {
    set_enabled(ctx, SetBackupJobEnabledParams { id, enabled: false }).await
}

pub async fn run_now(
    ctx: RpcContext,
    RunBackupJobNowParams { id }: RunBackupJobNowParams,
) -> Result<BackupRun, Error> {
    run_job(ctx, id, BackupRunTrigger::RunNow).await
}

pub async fn delete(
    ctx: RpcContext,
    DeleteBackupJobParams { id }: DeleteBackupJobParams,
) -> Result<(), Error> {
    let target_id = ctx
        .db
        .mutate(|db| {
            let job: BackupJob = db
                .as_public()
                .as_scheduled_backups()
                .as_jobs()
                .as_idx(&id)
                .or_not_found(&id)?
                .de()?;
            let package_ids = selected_installed_services(db, &job.services)?;
            validate_remaining_coverage(db, &job.target_id, &package_ids, &job.id)?;
            disassociate_histories(db, &job, &package_ids)?;
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_jobs_mut()
                .remove(&id)?;
            refresh_archive_state(db, &job.target_id)?;
            Ok(job.target_id)
        })
        .await
        .result?;
    sync_archive_states(&ctx, &target_id).await.log_err();
    Ok(())
}

fn validate_job_input(
    name: &str,
    schedule: &Schedule,
    default_retention: &RetentionPolicy,
    retention_overrides: &BTreeMap<PackageId, RetentionPolicy>,
) -> Result<(), Error> {
    if name.trim().is_empty() || name.len() > 80 {
        return Err(Error::new(
            eyre!("{}", t!("backup.scheduled.invalid-job-name")),
            ErrorKind::InvalidRequest,
        ));
    }
    schedule.next_after(Utc::now(), None)?;
    default_retention.validate()?;
    for policy in retention_overrides.values() {
        policy.validate()?;
    }
    Ok(())
}

pub(crate) fn validate_new_job_coverage(
    db: &DatabaseModel,
    target_id: &BackupTargetId,
    package_ids: &BTreeSet<PackageId>,
    schedule: &Schedule,
    default_retention: &RetentionPolicy,
    overrides: &BTreeMap<PackageId, RetentionPolicy>,
    replacing: Option<&BackupJobId>,
    candidate_active: bool,
) -> Result<(), Error> {
    let state = db.as_public().as_scheduled_backups();
    for package_id in package_ids {
        let key = history_key(target_id, package_id);
        let existing: Option<ServiceTargetHistory> = state
            .as_histories()
            .as_idx(&key)
            .map(|history| history.de())
            .transpose()?;
        let policy = existing
            .as_ref()
            .map(|history| history.policy.clone())
            .unwrap_or_else(|| {
                overrides
                    .get(package_id)
                    .unwrap_or(default_retention)
                    .clone()
            });
        let timezone: chrono_tz::Tz = existing
            .as_ref()
            .map(|history| history.timezone.as_str())
            .unwrap_or(&schedule.timezone)
            .parse()
            .map_err(|_| {
                Error::new(
                    eyre!("{}", t!("backup.scheduled.invalid-retention-timezone")),
                    ErrorKind::InvalidRequest,
                )
            })?;
        let mut schedules = Vec::new();
        if let Some(history) = &existing {
            for job_id in &history.feeding_jobs {
                if replacing == Some(job_id) {
                    continue;
                }
                let other: BackupJob = state.as_jobs().as_idx(job_id).or_not_found(job_id)?.de()?;
                if other.enabled && other.pause.is_none() {
                    schedules.push(other.schedule);
                }
            }
        }
        if candidate_active {
            schedules.push(schedule.clone());
        }
        if !schedules.is_empty() {
            validate_combined_schedule_coverage(&schedules, &policy, timezone, Utc::now())?;
        }
    }
    Ok(())
}

fn validate_remaining_coverage(
    db: &DatabaseModel,
    target_id: &BackupTargetId,
    package_ids: &BTreeSet<PackageId>,
    excluding: &BackupJobId,
) -> Result<(), Error> {
    for package_id in package_ids {
        let Some(history) = db
            .as_public()
            .as_scheduled_backups()
            .as_histories()
            .as_idx(&history_key(target_id, package_id))
        else {
            continue;
        };
        let history: ServiceTargetHistory = history.de()?;
        validate_history_policy_coverage(db, &history, &history.policy, Some(excluding))?;
    }
    Ok(())
}

fn validate_history_policy_coverage(
    db: &DatabaseModel,
    history: &ServiceTargetHistory,
    policy: &RetentionPolicy,
    excluding: Option<&BackupJobId>,
) -> Result<(), Error> {
    let state = db.as_public().as_scheduled_backups();
    let schedules = history
        .feeding_jobs
        .iter()
        .filter(|job_id| excluding != Some(*job_id))
        .filter_map(|job_id| state.as_jobs().as_idx(job_id))
        .map(|job| job.de())
        .collect::<Result<Vec<BackupJob>, Error>>()?
        .into_iter()
        .filter(|job| job.enabled && job.pause.is_none())
        .map(|job| job.schedule)
        .collect::<Vec<_>>();
    if schedules.is_empty() {
        return Ok(());
    }
    let timezone = history.timezone.parse().map_err(|_| {
        Error::new(
            eyre!("{}", t!("backup.scheduled.invalid-retention-timezone")),
            ErrorKind::InvalidRequest,
        )
    })?;
    validate_combined_schedule_coverage(&schedules, policy, timezone, Utc::now())
}

fn selected_installed_services(
    db: &DatabaseModel,
    scope: &BackupServiceScope,
) -> Result<BTreeSet<PackageId>, Error> {
    Ok(match scope {
        BackupServiceScope::All => db
            .as_public()
            .as_package_data()
            .as_entries()?
            .into_iter()
            .filter(|(_, package)| package.as_state_info().expect_installed().is_ok())
            .map(|(id, _)| id)
            .collect(),
        BackupServiceScope::AllExcept {
            excluded_package_ids,
        } => db
            .as_public()
            .as_package_data()
            .as_entries()?
            .into_iter()
            .filter(|(_, package)| package.as_state_info().expect_installed().is_ok())
            .map(|(id, _)| id)
            .filter(|id| !excluded_package_ids.contains(id))
            .collect(),
        BackupServiceScope::Selected { package_ids } => package_ids.clone(),
    })
}

pub(crate) fn associate_histories(
    db: &mut DatabaseModel,
    job: &BackupJob,
    package_ids: &BTreeSet<PackageId>,
) -> Result<(), Error> {
    let job_is_active = job.enabled && job.pause.is_none();
    let histories = db
        .as_public_mut()
        .as_scheduled_backups_mut()
        .as_histories_mut();
    for package_id in package_ids {
        let key = history_key(&job.target_id, package_id);
        if let Some(history) = histories.as_idx_mut(&key) {
            history
                .as_feeding_jobs_mut()
                .mutate(|jobs| Ok(jobs.insert(job.id.clone())))?;
            if job_is_active {
                history.as_archived_mut().ser(&false)?;
            }
        } else {
            let policy = job
                .retention_overrides
                .get(package_id)
                .unwrap_or(&job.default_retention)
                .clone();
            histories.insert(
                &key,
                &ServiceTargetHistory {
                    target_id: job.target_id.clone(),
                    target_instance_id: job.target_instance_id.clone(),
                    package_id: package_id.clone(),
                    timezone: job.schedule.timezone.clone(),
                    policy,
                    feeding_jobs: BTreeSet::from([job.id.clone()]),
                    snapshots: Vec::new(),
                    archived: !job_is_active,
                },
            )?;
        }
    }
    Ok(())
}

fn disassociate_histories(
    db: &mut DatabaseModel,
    job: &BackupJob,
    package_ids: &BTreeSet<PackageId>,
) -> Result<(), Error> {
    let histories = db
        .as_public_mut()
        .as_scheduled_backups_mut()
        .as_histories_mut();
    for package_id in package_ids {
        if let Some(history) = histories.as_idx_mut(&history_key(&job.target_id, package_id)) {
            history
                .as_feeding_jobs_mut()
                .mutate(|jobs| Ok(jobs.remove(&job.id)))?;
            if history.as_feeding_jobs().de()?.is_empty() {
                history.as_archived_mut().ser(&true)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn refresh_archive_state(
    db: &mut DatabaseModel,
    target_id: &BackupTargetId,
) -> Result<(), Error> {
    let jobs: Vec<BackupJob> = db
        .as_public()
        .as_scheduled_backups()
        .as_jobs()
        .as_entries()?
        .into_iter()
        .map(|(_, job)| job.de())
        .collect::<Result<_, _>>()?;
    let histories = db
        .as_public_mut()
        .as_scheduled_backups_mut()
        .as_histories_mut();
    for key in histories.keys()? {
        let history = histories.as_idx_mut(&key).expect("history key exists");
        if history.as_target_id().de()? != *target_id {
            continue;
        }
        let feeding_jobs: BTreeSet<BackupJobId> = history.as_feeding_jobs().de()?;
        let active = feeding_jobs.iter().any(|job_id| {
            jobs.iter()
                .any(|job| &job.id == job_id && job.enabled && job.pause.is_none())
        });
        let archived = !active;
        history.as_archived_mut().ser(&archived)?;
        if archived {
            let mut snapshots: Vec<ServiceSnapshot> = history.as_snapshots().de()?;
            for snapshot in &mut snapshots {
                snapshot.archived = true;
            }
            history.as_snapshots_mut().ser(&snapshots)?;
        }
    }
    Ok(())
}

pub fn history_key(target_id: &BackupTargetId, package_id: &PackageId) -> String {
    format!("{target_id}::{package_id}")
}

async fn sync_archive_states(ctx: &RpcContext, target_id: &BackupTargetId) -> Result<(), Error> {
    let db = ctx.db.peek().await;
    let archived: BTreeMap<PackageId, (bool, BTreeSet<ServiceSnapshotId>)> = db
        .as_public()
        .as_scheduled_backups()
        .as_histories()
        .as_entries()?
        .into_iter()
        .map(|(_, history)| history.de())
        .collect::<Result<Vec<ServiceTargetHistory>, Error>>()?
        .into_iter()
        .filter(|history| history.target_id == *target_id)
        .map(|history| {
            let archived_snapshots = history
                .snapshots
                .iter()
                .filter(|snapshot| snapshot.archived)
                .map(|snapshot| snapshot.id.clone())
                .collect();
            (history.package_id, (history.archived, archived_snapshots))
        })
        .collect();
    if archived.is_empty() {
        return Ok(());
    }
    let Some(credential) = db
        .as_private()
        .as_scheduled_backup_credentials()
        .as_idx(&target_id.to_string())
    else {
        return Ok(());
    };
    let credential: ScheduledBackupCredential = credential.de()?;
    let encryption_key =
        credential.open(&db.as_private().as_scheduled_backup_device_key().de()?)?;
    let server_id = db.as_public().as_server_info().as_id().de()?;
    let mut guard = ScheduledBackupMountGuard::mount_with_key(
        TmpMountGuard::mount(&target_id.clone().load(&db)?, ReadWrite).await?,
        &server_id,
        &credential.target_instance_id,
        &encryption_key,
    )
    .await?;
    guard.sync_archive_states(&archived).await?;
    guard.save_and_unmount().await
}

const fn default_true() -> bool {
    true
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn retention_tier_accepts_human_duration_suffixes() {
        assert_eq!(
            parse_retention_tier("1d:2w").unwrap(),
            RetentionTier {
                interval_seconds: 24 * 60 * 60,
                coverage_seconds: 14 * 24 * 60 * 60,
            }
        );
    }

    #[test]
    fn retention_tier_rejects_invalid_or_inverted_ranges() {
        assert!(parse_retention_tier("1d").is_err());
        assert!(parse_retention_tier("1w:1d").is_err());
        assert!(parse_retention_tier("0d:1d").is_err());
    }

    #[test]
    fn edit_job_cli_distinguishes_omitted_and_explicit_settings() {
        let id = BackupJobId::new().to_string();
        let params = EditBackupJobCliParams::try_parse_from([
            "test",
            id.as_str(),
            "--cron",
            "15 * * * *",
            "--all-services",
            "--latest-only",
            "--service-keep-rule",
            "bitcoind=1h:1d",
            "--service-latest-only",
            "lnd",
            "--use-default-retention",
            "electrs",
        ])
        .unwrap();

        assert_eq!(params.id.to_string(), id);
        assert_eq!(params.cron.as_deref(), Some("15 * * * *"));
        assert!(params.all_services);
        assert!(params.latest_only);
        assert!(params.retention_tiers.is_empty());
        assert_eq!(params.retention_override_tiers.len(), 1);
        assert_eq!(params.latest_only_overrides.len(), 1);
        assert_eq!(params.default_retention_packages.len(), 1);
    }

    #[test]
    fn policy_cli_requires_an_explicit_retention_policy() {
        let target = "cifs-0";
        let package = "bitcoind";
        assert!(
            PreviewRetentionPolicyCliParams::try_parse_from(["test", target, package]).is_err()
        );

        let params = PreviewRetentionPolicyCliParams::try_parse_from([
            "test",
            target,
            package,
            "--keep-rule",
            "1h:1d",
            "--keep-rule",
            "1d:1w",
        ])
        .unwrap();
        assert_eq!(params.retention_tiers.len(), 2);
        assert!(!params.latest_only);

        let params = ApplyRetentionPolicyCliParams::try_parse_from([
            "test",
            target,
            package,
            "--latest-only",
            "--confirm-removal",
            ServiceSnapshotId::new().to_string().as_str(),
        ])
        .unwrap();
        assert!(params.latest_only);
        assert_eq!(params.confirmed_removals.len(), 1);
    }

    #[test]
    fn capacity_estimate_cli_accepts_service_scope_and_retention() {
        let params = EstimateBackupCapacityCliParams::try_parse_from([
            "test",
            "cifs-0",
            "--package-ids",
            "bitcoind,lnd",
            "--keep-rule",
            "1h:1d",
            "--service-latest-only",
            "lnd",
        ])
        .unwrap();

        assert_eq!(params.package_ids.len(), 2);
        assert!(params.exclude_package_ids.is_empty());
        assert_eq!(params.retention_tiers.len(), 1);
        assert_eq!(params.latest_only_overrides.len(), 1);
    }

    #[test]
    fn retention_override_cli_groups_tiers_and_rejects_conflicts() {
        let first = parse_retention_override_tier("bitcoind=1h:1d").unwrap();
        let second = parse_retention_override_tier("bitcoind=1d:1w").unwrap();
        let lnd: PackageId = "lnd".parse().unwrap();
        let overrides =
            retention_overrides_from_cli(vec![first.clone(), second], vec![lnd.clone()]).unwrap();

        assert_eq!(overrides[&first.0].tiers.len(), 2);
        assert_eq!(overrides[&lnd], RetentionPolicy::latest_only());
        assert!(
            retention_overrides_from_cli(vec![first], vec!["bitcoind".parse().unwrap()]).is_err()
        );
    }

    #[test]
    fn checkpoint_selection_accepts_package_and_snapshot_ids() {
        let snapshot_id = ServiceSnapshotId::new();
        let (package_id, parsed_snapshot) =
            parse_checkpoint_selection(&format!("bitcoind={snapshot_id}")).unwrap();

        assert_eq!(package_id, "bitcoind".parse().unwrap());
        assert_eq!(parsed_snapshot, snapshot_id);
    }

    #[test]
    fn review_decision_accepts_add_and_skip_actions() {
        let job_id = BackupJobId::new();
        assert_eq!(
            parse_review_decision(&format!("{job_id}=add")).unwrap(),
            (job_id.clone(), true)
        );
        assert_eq!(
            parse_review_decision(&format!("{job_id}=skip")).unwrap(),
            (job_id, false)
        );
    }
}
