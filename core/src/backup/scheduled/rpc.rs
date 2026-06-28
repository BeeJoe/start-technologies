use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use chrono::Utc;
use rpc_toolkit::{Context, HandlerExt, ParentHandler, from_fn_async};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    BackupJob, BackupJobId, BackupJobPause, BackupJobStatus, BackupRun, BackupRunTrigger,
    BackupServiceScope, RetentionPolicy, RetentionPolicyChangePreview, Schedule,
    ScheduledBackupCredential, ScheduledBackupMountGuard, ServiceSnapshotId, ServiceTargetHistory,
    run_job, validate_combined_schedule_coverage,
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
use crate::volume::PKG_VOLUME_DIR;
use crate::{DATA_DIR, PackageId};

pub fn job<C: Context>() -> ParentHandler<C> {
    ParentHandler::new()
        .subcommand("list", from_fn_async(list).no_cli())
        .subcommand("create", from_fn_async(create).no_cli())
        .subcommand("update", from_fn_async(update).no_cli())
        .subcommand("set-enabled", from_fn_async(set_enabled).no_cli())
        .subcommand("delete", from_fn_async(delete).no_cli())
        .subcommand("run-now", from_fn_async(run_now).no_cli())
        .subcommand("retry-target", from_fn_async(retry_target).no_cli())
        .subcommand("reassign-target", from_fn_async(reassign_target).no_cli())
}

pub fn history<C: Context>() -> ParentHandler<C> {
    ParentHandler::new()
        .subcommand("list", from_fn_async(list_histories).no_cli())
        .subcommand("discover", from_fn_async(discover_histories).no_cli())
        .subcommand(
            "delete-archived-snapshots",
            from_fn_async(delete_archived_snapshots).no_cli(),
        )
}

pub fn policy<C: Context>() -> ParentHandler<C> {
    ParentHandler::new()
        .subcommand("estimate", from_fn_async(estimate_capacity).no_cli())
        .subcommand("preview", from_fn_async(preview_policy_change).no_cli())
        .subcommand("update", from_fn_async(update_policy).no_cli())
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
            .filter(|history| !history.archived)
            .map(|history| history.snapshots.as_slice())
            .unwrap_or_default();
        let archived = history
            .as_ref()
            .filter(|history| history.archived)
            .map(|history| history.snapshots.as_slice())
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

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverScheduledBackupsParams {
    pub target_id: BackupTargetId,
    pub server_id: String,
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
    if !history.archived {
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
    guard
        .sync_archive_states(&BTreeMap::from([(package_id.clone(), true)]))
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

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RetryBackupTargetParams {
    pub target_id: BackupTargetId,
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

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReassignBackupTargetParams {
    pub id: BackupJobId,
    pub target_id: BackupTargetId,
    pub password: PasswordType,
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

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRetentionPolicyParams {
    pub target_id: BackupTargetId,
    pub package_id: PackageId,
    pub policy: RetentionPolicy,
    pub confirmed_removals: BTreeSet<ServiceSnapshotId>,
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

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBackupJobParams {
    pub id: BackupJobId,
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RunBackupJobNowParams {
    pub id: BackupJobId,
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

fn refresh_archive_state(db: &mut DatabaseModel, target_id: &BackupTargetId) -> Result<(), Error> {
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
        history.as_archived_mut().ser(&!active)?;
    }
    Ok(())
}

pub fn history_key(target_id: &BackupTargetId, package_id: &PackageId) -> String {
    format!("{target_id}::{package_id}")
}

async fn sync_archive_states(ctx: &RpcContext, target_id: &BackupTargetId) -> Result<(), Error> {
    let db = ctx.db.peek().await;
    let archived: BTreeMap<PackageId, bool> = db
        .as_public()
        .as_scheduled_backups()
        .as_histories()
        .as_entries()?
        .into_iter()
        .map(|(_, history)| history.de())
        .collect::<Result<Vec<ServiceTargetHistory>, Error>>()?
        .into_iter()
        .filter(|history| history.target_id == *target_id)
        .map(|history| (history.package_id, history.archived))
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
