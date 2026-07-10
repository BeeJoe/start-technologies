use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use color_eyre::eyre::eyre;
use imbl_value::InternedString;
use tokio::sync::OwnedMutexGuard;

use super::{
    BackupJob, BackupJobId, BackupJobPause, BackupRun, BackupRunState, BackupRunTrigger,
    BackupServiceScope, BackupTargetFailureState, ScheduledBackupCredential,
    ScheduledBackupMountGuard, ServiceSnapshot, ServiceSnapshotId, activity_from_run,
    insert_activity,
};
use crate::backup::PackageBackupReport;
use crate::backup::os::OsBackup;
use crate::backup::scheduled::rpc::history_key;
use crate::backup::target::{BackupTargetFS, BackupTargetId};
use crate::context::RpcContext;
use crate::disk::mount::filesystem::ReadWrite;
use crate::disk::mount::guard::{GenericMountGuard, TmpMountGuard};
use crate::notifications::{NotificationLevel, notify};
use crate::prelude::*;
use crate::progress::{FullProgress, FullProgressTracker};
use crate::rpc_continuations::Guid;
use crate::util::future::NonDetachingJoinHandle;
use crate::util::io::{delete_dir, dir_size};
use crate::volume::PKG_VOLUME_DIR;
use crate::{DATA_DIR, PackageId};

const PREFLIGHT_MARGIN_PERCENT: u64 = 10;
const PREFLIGHT_METADATA_BYTES: u64 = 1024 * 1024;
const TARGET_MOUNT_RETRY_DELAYS: [Duration; 2] =
    [Duration::from_millis(500), Duration::from_millis(1500)];

async fn retry_mount<T, F, Fut>(mut mount: F, retry_delays: &[Duration]) -> Result<T, Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, Error>>,
{
    let mut result = mount().await;
    for delay in retry_delays {
        if result.is_ok() {
            return result;
        }
        tokio::time::sleep(*delay).await;
        result = mount().await;
    }
    result
}

async fn mount_target(target: &BackupTargetFS) -> Result<TmpMountGuard, Error> {
    retry_mount(
        || TmpMountGuard::mount(target, ReadWrite),
        &TARGET_MOUNT_RETRY_DELAYS,
    )
    .await
}

pub async fn run_job(
    ctx: RpcContext,
    job_id: BackupJobId,
    trigger: BackupRunTrigger,
) -> Result<BackupRun, Error> {
    let coordinator = crate::backup::try_backup_coordinator(ctx.backup_coordinator.clone())?;
    run_job_with_coordinator(ctx, job_id, trigger, coordinator).await
}

pub(super) async fn run_job_with_coordinator(
    ctx: RpcContext,
    job_id: BackupJobId,
    trigger: BackupRunTrigger,
    _coordinator: OwnedMutexGuard<()>,
) -> Result<BackupRun, Error> {
    super::reconcile_interrupted_backup_state(&ctx).await?;
    let result = run_job_inner(&ctx, &job_id, trigger).await;
    ctx.db
        .mutate(|db| {
            db.as_public_mut()
                .as_server_info_mut()
                .as_status_info_mut()
                .as_backup_progress_mut()
                .ser(&None)
        })
        .await
        .result?;
    result
}

async fn run_job_inner(
    ctx: &RpcContext,
    job_id: &BackupJobId,
    trigger: BackupRunTrigger,
) -> Result<BackupRun, Error> {
    let db = ctx.db.peek().await;
    let job: BackupJob = db
        .as_public()
        .as_scheduled_backups()
        .as_jobs()
        .as_idx(job_id)
        .or_not_found(job_id)?
        .de()?;
    if !job.enabled || job.pause.is_some() {
        return Err(Error::new(
            eyre!("{}", t!("backup.scheduled.job-paused")),
            ErrorKind::InvalidRequest,
        ));
    }
    let target_name = job.target_id.user_facing_name(&db);
    let package_ids = selected_services(&db, &job.services)?;
    let encryption_key = (|| {
        let credential: ScheduledBackupCredential = db
            .as_private()
            .as_scheduled_backup_credentials()
            .as_idx(&job.target_id.to_string())
            .or_not_found(job.target_id.to_string())?
            .de()?;
        let device_key = db.as_private().as_scheduled_backup_device_key().de()?;
        credential.open(&device_key)
    })();
    let encryption_key = match encryption_key {
        Ok(key) => key,
        Err(error) => {
            let message = error.to_string();
            pause_for_intervention(
                ctx,
                &job,
                BackupJobPause::ReauthenticationRequired,
                t!("backup.scheduled.reauth-title").to_string(),
                t!(
                    "backup.scheduled.reauth-message",
                    job = job.name,
                    target = target_name.as_str()
                )
                .to_string(),
            )
            .await?;
            record_failed_run(ctx, &job, &package_ids, trigger, message).await?;
            return Err(error);
        }
    };
    let server_id = db.as_public().as_server_info().as_id().de()?;
    let target_fs = match job.target_id.clone().load(&db) {
        Ok(target) => target,
        Err(error) => {
            let message = error.to_string();
            record_connectivity_failure(ctx, &job).await?;
            record_failed_run(ctx, &job, &package_ids, trigger, message).await?;
            return Err(error);
        }
    };
    let target_guard = match mount_target(&target_fs).await {
        Ok(guard) => guard,
        Err(error) => {
            let message = error.to_string();
            record_connectivity_failure(ctx, &job).await?;
            record_failed_run(ctx, &job, &package_ids, trigger, message).await?;
            return Err(error);
        }
    };

    let scheduled_guard = match ScheduledBackupMountGuard::mount_with_key(
        target_guard,
        &server_id,
        &job.target_instance_id,
        &encryption_key,
    )
    .await
    {
        Ok(guard) => guard,
        Err(error) => {
            let message = error.to_string();
            pause_for_intervention(
                ctx,
                &job,
                BackupJobPause::TargetIdentityMismatch,
                t!("backup.scheduled.identity-title").to_string(),
                t!(
                    "backup.scheduled.identity-message",
                    job = job.name,
                    target = target_name.as_str()
                )
                .to_string(),
            )
            .await?;
            record_failed_run(ctx, &job, &package_ids, trigger, message).await?;
            return Err(error);
        }
    };
    mark_target_connected(ctx, &job.target_id).await?;
    let target_available = match crate::disk::util::get_available(scheduled_guard.path()).await {
        Ok(available) => available,
        Err(error) => {
            let message = error.to_string();
            record_connectivity_failure(ctx, &job).await?;
            record_failed_run(ctx, &job, &package_ids, trigger, message).await?;
            return Err(error);
        }
    };
    if let Err(error) =
        preflight_capacity(&db, &job, &package_ids, &scheduled_guard, target_available).await
    {
        let message = error.to_string();
        record_failed_run(ctx, &job, &package_ids, trigger, message).await?;
        ctx.db
            .mutate(|db| {
                notify(
                    db,
                    None,
                    NotificationLevel::Error,
                    t!("backup.scheduled.capacity-title").to_string(),
                    t!(
                        "backup.scheduled.capacity-message",
                        job = job.name,
                        target = target_name.as_str()
                    )
                    .to_string(),
                    (),
                )
            })
            .await
            .result?;
        return Err(error);
    }
    let mut scheduled_guard = Arc::new(scheduled_guard);

    let now = Utc::now();
    let mut run = BackupRun {
        id: Guid::new(),
        job_id: job.id.clone(),
        job_name: job.name.clone(),
        target_id: job.target_id.clone(),
        trigger,
        state: BackupRunState::Running,
        started_at: now,
        completed_at: None,
        intended_services: package_ids.clone(),
        services: BTreeMap::new(),
        error: None,
    };

    let ui = ctx.db.peek().await.into_public().into_ui().de()?;
    if let Err(error) = async {
        scheduled_guard
            .save_os_backup(
                &run.id,
                &OsBackup {
                    account: ctx.account.peek(|account| account.clone()),
                    ui,
                },
            )
            .await?;
        scheduled_guard.save_run(&run).await
    }
    .await
    {
        let message = error.to_string();
        record_failed_run(ctx, &job, &package_ids, trigger, message).await?;
        notify_run_failure(ctx, &job, &package_ids).await?;
        return Err(error);
    }

    ctx.db
        .mutate(|db| {
            db.as_public_mut()
                .as_server_info_mut()
                .as_status_info_mut()
                .as_backup_progress_mut()
                .ser(&Some(FullProgress::new()))?;
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_runs_mut()
                .insert(&run.id, &run)?;
            insert_activity(db, &activity_from_run(&run))?;
            Ok(())
        })
        .await
        .result?;

    let progress = FullProgressTracker::new();
    let mut phases: BTreeMap<PackageId, _> = package_ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                progress.add_phase(InternedString::from(id.clone()), Some(1)),
            )
        })
        .collect();
    let _progress_sync = NonDetachingJoinHandle::from(tokio::spawn(progress.clone().sync_to_db(
        ctx.db.clone(),
        |db| {
            db.as_public_mut()
                .as_server_info_mut()
                .as_status_info_mut()
                .as_backup_progress_mut()
                .transpose_mut()
        },
        Some(std::time::Duration::from_millis(300)),
    )));

    for package_id in &package_ids {
        let started = Instant::now();
        let mut phase = phases.remove(package_id).expect("backup phase exists");
        phase.start();
        let report = if let Some(service) = &*ctx.services.get(package_id).await {
            match scheduled_guard.staging(&run.id, package_id).await {
                Ok(staging) => match service.backup(staging, phase).await {
                    Ok(output) => {
                        let manifest = db
                            .as_public()
                            .as_package_data()
                            .as_idx(package_id)
                            .or_not_found(package_id)?
                            .as_state_info()
                            .expect_installed()?
                            .as_manifest();
                        let package_version = manifest.as_version().de()?.to_string();
                        let completed_at = Utc::now();
                        let snapshot = ServiceSnapshot {
                            id: ServiceSnapshotId::new(),
                            package_id: package_id.clone(),
                            package_version,
                            source: super::BackupSource::Scheduled,
                            job_id: job.id.clone(),
                            job_name: job.name.clone(),
                            run_id: run.id.clone(),
                            completed_at,
                            logical_size: 0,
                            physical_size: None,
                            changed_bytes: output.changed_bytes,
                            measured_at: completed_at,
                            archived: false,
                        };
                        let history: super::ServiceTargetHistory = db
                            .as_public()
                            .as_scheduled_backups()
                            .as_histories()
                            .as_idx(&history_key(&job.target_id, package_id))
                            .or_not_found(package_id)?
                            .de()?;
                        let mut owned = Arc::try_unwrap(scheduled_guard).map_err(|_| {
                            Error::new(
                                eyre!("{}", t!("backup.scheduled.leaked-reference")),
                                ErrorKind::Incoherent,
                            )
                        })?;
                        let promotion = owned
                            .promote(&run.id, snapshot, history.timezone, history.policy)
                            .await;
                        scheduled_guard = Arc::new(owned);
                        match promotion {
                            Ok(snapshot) => PackageBackupReport {
                                error: None,
                                duration_ms: started.elapsed().as_millis() as u64,
                                logical_size: Some(snapshot.logical_size),
                                physical_size: snapshot.physical_size,
                                changed_bytes: snapshot.changed_bytes,
                                measured_at: Some(snapshot.measured_at),
                            },
                            Err(error) => failed_report(started, error),
                        }
                    }
                    Err(error) => {
                        delete_dir(
                            &scheduled_guard
                                .path()
                                .join("staging")
                                .join(run.id.as_ref())
                                .join(&**package_id),
                        )
                        .await
                        .log_err();
                        failed_report(started, error)
                    }
                },
                Err(error) => {
                    delete_dir(
                        &scheduled_guard
                            .path()
                            .join("staging")
                            .join(run.id.as_ref())
                            .join(&**package_id),
                    )
                    .await
                    .log_err();
                    phase.complete();
                    failed_report(started, error)
                }
            }
        } else {
            phase.complete();
            PackageBackupReport {
                error: Some(t!("backup.scheduled.service-not-ready").to_string()),
                duration_ms: started.elapsed().as_millis() as u64,
                logical_size: None,
                physical_size: None,
                changed_bytes: None,
                measured_at: None,
            }
        };
        run.services.insert(package_id.clone(), report);
    }
    progress.complete();

    let failed = run
        .services
        .values()
        .filter(|report| report.error.is_some())
        .count();
    run.state = if failed == 0 {
        BackupRunState::Succeeded
    } else if failed == run.services.len() {
        BackupRunState::Failed
    } else {
        BackupRunState::PartiallyFailed
    };
    run.completed_at = Some(Utc::now());

    delete_dir(&scheduled_guard.path().join("staging").join(run.id.as_ref()))
        .await
        .log_err();

    let owned = Arc::try_unwrap(scheduled_guard).map_err(|_| {
        Error::new(
            eyre!("{}", t!("backup.scheduled.leaked-reference")),
            ErrorKind::Incoherent,
        )
    })?;
    let target_metadata = owned.metadata.clone();
    let run_save_error = owned.save_run(&run).await.err();
    let unmount_error = owned.save_and_unmount().await.err();
    if let Some(error) = run_save_error.or(unmount_error) {
        run.error = Some(error.to_string());
        run.state = if run.services.values().any(|report| report.error.is_none()) {
            BackupRunState::PartiallyFailed
        } else {
            BackupRunState::Failed
        };
    }

    ctx.db
        .mutate(|db| {
            let state = db.as_public_mut().as_scheduled_backups_mut();
            state.as_runs_mut().insert(&run.id, &run)?;
            state
                .as_activities_mut()
                .insert(&run.id, &activity_from_run(&run))?;
            for (package_id, history) in target_metadata.services {
                let key = history_key(&job.target_id, &package_id);
                if let Some(public_history) = state.as_histories_mut().as_idx_mut(&key) {
                    public_history.as_snapshots_mut().ser(&history.snapshots)?;
                    public_history.as_archived_mut().ser(&history.archived)?;
                }
            }
            let mut persisted_job: BackupJob = state
                .as_jobs()
                .as_idx(&job.id)
                .or_not_found(&job.id)?
                .de()?;
            persisted_job.status.last_attempted_at = Some(run.started_at);
            if run.state == BackupRunState::Succeeded {
                persisted_job.status.last_succeeded_at = run.completed_at;
                persisted_job.status.consecutive_failures = 0;
            } else {
                persisted_job.status.consecutive_failures =
                    persisted_job.status.consecutive_failures.saturating_add(1);
            }
            persisted_job.status.last_result = Some(run.state);
            state.as_jobs_mut().insert(&job.id, &persisted_job)?;
            Ok(())
        })
        .await
        .result?;
    if run.state != BackupRunState::Succeeded {
        let mut affected = run
            .services
            .iter()
            .filter(|(_, report)| report.error.is_some())
            .map(|(package, _)| package.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        if affected.is_empty() {
            affected = package_ids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
        }
        ctx.db
            .mutate(|db| {
                notify(
                    db,
                    None,
                    NotificationLevel::Warning,
                    t!("backup.scheduled.run-failed-title").to_string(),
                    t!(
                        "backup.scheduled.run-failed-message",
                        job = job.name,
                        target = target_name.as_str(),
                        services = affected
                    )
                    .to_string(),
                    (),
                )
            })
            .await
            .result?;
    }
    Ok(run)
}

fn failed_report(started: Instant, error: Error) -> PackageBackupReport {
    PackageBackupReport {
        error: Some(error.to_string()),
        duration_ms: started.elapsed().as_millis() as u64,
        logical_size: None,
        physical_size: None,
        changed_bytes: None,
        measured_at: None,
    }
}

async fn notify_run_failure(
    ctx: &RpcContext,
    job: &BackupJob,
    package_ids: &BTreeSet<PackageId>,
) -> Result<(), Error> {
    let services = package_ids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    ctx.db
        .mutate(|db| {
            let target_name = job.target_id.user_facing_name(db);
            notify(
                db,
                None,
                NotificationLevel::Warning,
                t!("backup.scheduled.run-failed-title").to_string(),
                t!(
                    "backup.scheduled.run-failed-message",
                    job = job.name,
                    target = target_name.as_str(),
                    services = services
                )
                .to_string(),
                (),
            )
        })
        .await
        .result
}

fn selected_services(
    db: &crate::db::model::DatabaseModel,
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

pub(crate) async fn preflight_new_target_capacity(
    package_ids: &BTreeSet<PackageId>,
    available: u64,
) -> Result<(), Error> {
    let mut required = PREFLIGHT_METADATA_BYTES;
    for package_id in package_ids {
        let path = std::path::Path::new(DATA_DIR)
            .join(PKG_VOLUME_DIR)
            .join(package_id);
        let logical = if tokio::fs::metadata(&path).await.is_ok() {
            dir_size(&path, None).await?
        } else {
            0
        };
        required = required
            .checked_add(logical.saturating_mul(100 + PREFLIGHT_MARGIN_PERCENT) / 100)
            .ok_or_else(|| {
                Error::new(
                    eyre!("{}", t!("backup.scheduled.capacity-overflow")),
                    ErrorKind::InvalidRequest,
                )
            })?;
    }
    if required > available {
        return Err(Error::new(
            eyre!(
                "{}",
                t!(
                    "backup.scheduled.insufficient-capacity",
                    required = required,
                    available = available
                )
            ),
            ErrorKind::InvalidRequest,
        ));
    }
    Ok(())
}

async fn preflight_capacity<G: GenericMountGuard>(
    db: &crate::db::model::DatabaseModel,
    job: &BackupJob,
    package_ids: &BTreeSet<PackageId>,
    guard: &ScheduledBackupMountGuard<G>,
    available: u64,
) -> Result<(), Error> {
    let mut requirements = Vec::with_capacity(package_ids.len());

    for package_id in package_ids {
        let live_path = std::path::Path::new(DATA_DIR)
            .join(PKG_VOLUME_DIR)
            .join(package_id);
        let live_logical = if tokio::fs::metadata(&live_path).await.is_ok() {
            dir_size(&live_path, None).await?
        } else {
            0
        };
        let public_history: super::ServiceTargetHistory = db
            .as_public()
            .as_scheduled_backups()
            .as_histories()
            .as_idx(&history_key(&job.target_id, package_id))
            .or_not_found(package_id)?
            .de()?;
        let maximum_count = public_history.policy.maximum_projected_snapshot_count()?;
        let on_target = guard.metadata.services.get(package_id);
        let active: Vec<_> = on_target
            .into_iter()
            .flat_map(|history| history.snapshots.iter())
            .filter(|snapshot| !snapshot.archived)
            .collect();
        let copy_bytes = active
            .iter()
            .max_by_key(|snapshot| snapshot.completed_at)
            .map(|snapshot| snapshot.physical_size.unwrap_or(snapshot.logical_size))
            .unwrap_or(live_logical)
            .max(live_logical);
        requirements.push((copy_bytes, active.len() as u64, maximum_count));
    }

    let required = complete_run_required_capacity(requirements)?;
    if required > available {
        return Err(Error::new(
            eyre!(
                "{}",
                t!(
                    "backup.scheduled.insufficient-capacity",
                    required = required,
                    available = available
                )
            ),
            ErrorKind::InvalidRequest,
        ));
    }
    Ok(())
}

fn complete_run_required_capacity(
    requirements: impl IntoIterator<Item = (u64, u64, u64)>,
) -> Result<u64, Error> {
    let mut retained_growth = 0u64;
    let mut temporary_headroom = 0u64;
    for (copy_bytes, current_count, maximum_count) in requirements {
        let growth = if current_count < maximum_count {
            copy_bytes
        } else {
            0
        };
        retained_growth = retained_growth
            .checked_add(growth)
            .ok_or_else(capacity_overflow)?;
        let staging = copy_bytes
            .checked_mul(100 + PREFLIGHT_MARGIN_PERCENT)
            .and_then(|bytes| bytes.checked_add(99))
            .map(|bytes| bytes / 100)
            .ok_or_else(capacity_overflow)?;
        // Staging becomes the retained-growth copy on promotion, so only its
        // excess over that growth is temporary additional capacity.
        temporary_headroom = temporary_headroom.max(staging.saturating_sub(growth));
    }
    PREFLIGHT_METADATA_BYTES
        .checked_add(retained_growth)
        .and_then(|bytes| bytes.checked_add(temporary_headroom))
        .ok_or_else(capacity_overflow)
}

fn capacity_overflow() -> Error {
    Error::new(
        eyre!("{}", t!("backup.scheduled.capacity-overflow")),
        ErrorKind::InvalidRequest,
    )
}

async fn record_failed_run(
    ctx: &RpcContext,
    job: &BackupJob,
    package_ids: &BTreeSet<PackageId>,
    trigger: BackupRunTrigger,
    error: String,
) -> Result<BackupRun, Error> {
    let now = Utc::now();
    let run = BackupRun {
        id: Guid::new(),
        job_id: job.id.clone(),
        job_name: job.name.clone(),
        target_id: job.target_id.clone(),
        trigger,
        state: BackupRunState::Failed,
        started_at: now,
        completed_at: Some(now),
        intended_services: package_ids.clone(),
        services: BTreeMap::new(),
        error: Some(error),
    };
    ctx.db
        .mutate(|db| {
            let state = db.as_public_mut().as_scheduled_backups_mut();
            state.as_runs_mut().insert(&run.id, &run)?;
            state
                .as_activities_mut()
                .insert(&run.id, &activity_from_run(&run))?;
            let mut persisted: BackupJob = state
                .as_jobs()
                .as_idx(&job.id)
                .or_not_found(&job.id)?
                .de()?;
            persisted.status.last_attempted_at = Some(now);
            persisted.status.consecutive_failures =
                persisted.status.consecutive_failures.saturating_add(1);
            persisted.status.last_result = Some(BackupRunState::Failed);
            state.as_jobs_mut().insert(&job.id, &persisted)?;
            Ok(())
        })
        .await
        .result?;
    Ok(run)
}

async fn record_connectivity_failure(ctx: &RpcContext, job: &BackupJob) -> Result<(), Error> {
    let target_key = job.target_id.to_string();
    ctx.db
        .mutate(|db| {
            let target_name = job.target_id.user_facing_name(db);
            let state = db.as_public_mut().as_scheduled_backups_mut();
            let affected: Vec<BackupJob> = state
                .as_jobs()
                .as_entries()?
                .into_iter()
                .map(|(_, job)| job.de())
                .collect::<Result<Vec<BackupJob>, Error>>()?
                .into_iter()
                .filter(|candidate| {
                    candidate.target_id == job.target_id
                        && candidate.enabled
                        && !matches!(candidate.pause, Some(super::BackupJobPause::User))
                })
                .collect();
            let mut failure: BackupTargetFailureState = state
                .as_target_failures()
                .as_idx(&target_key)
                .map(|failure| failure.de())
                .transpose()?
                .unwrap_or_default();
            let notify_user = failure.record_failure(affected.iter().map(|job| job.id.clone()));
            if failure.consecutive_connectivity_failures >= 3 {
                for mut affected_job in affected {
                    affected_job.pause = Some(super::BackupJobPause::TargetUnavailable {
                        failures: failure.consecutive_connectivity_failures,
                    });
                    affected_job.status.next_run_at = None;
                    affected_job.updated_at = Utc::now();
                    state
                        .as_jobs_mut()
                        .insert(&affected_job.id, &affected_job)?;
                }
            }
            state
                .as_target_failures_mut()
                .insert(&target_key, &failure)?;
            if notify_user {
                notify(
                    db,
                    None,
                    NotificationLevel::Error,
                    t!("backup.scheduled.target-unavailable-title").to_string(),
                    t!(
                        "backup.scheduled.target-unavailable-message",
                        target = target_name.as_str()
                    )
                    .to_string(),
                    (),
                )?;
            }
            Ok(())
        })
        .await
        .result
}

async fn mark_target_connected(ctx: &RpcContext, target_id: &BackupTargetId) -> Result<(), Error> {
    let key = target_id.to_string();
    ctx.db
        .mutate(|db| {
            let failures = db
                .as_public_mut()
                .as_scheduled_backups_mut()
                .as_target_failures_mut();
            let Some(existing) = failures.as_idx(&key) else {
                return Ok(());
            };
            let mut state: BackupTargetFailureState = existing.de()?;
            // Crossing the threshold requires an explicit user retry before
            // jobs are resumed. Sub-threshold successful connections reset it.
            if state.jobs_paused.is_empty() {
                state.reset();
                failures.insert(&key, &state)?;
            }
            Ok(())
        })
        .await
        .result
}

async fn pause_for_intervention(
    ctx: &RpcContext,
    job: &BackupJob,
    reason: super::BackupJobPause,
    title: String,
    message: String,
) -> Result<(), Error> {
    ctx.db
        .mutate(|db| {
            let state = db.as_public_mut().as_scheduled_backups_mut();
            let affected: Vec<BackupJob> = state
                .as_jobs()
                .as_entries()?
                .into_iter()
                .map(|(_, job)| job.de())
                .collect::<Result<Vec<BackupJob>, Error>>()?
                .into_iter()
                .filter(|candidate| {
                    candidate.target_id == job.target_id
                        && candidate.enabled
                        && !matches!(candidate.pause, Some(super::BackupJobPause::User))
                })
                .collect();
            let should_notify = affected
                .iter()
                .any(|candidate| candidate.pause.as_ref() != Some(&reason));
            for mut affected_job in affected {
                affected_job.pause = Some(reason.clone());
                affected_job.status.next_run_at = None;
                affected_job.updated_at = Utc::now();
                state
                    .as_jobs_mut()
                    .insert(&affected_job.id, &affected_job)?;
            }
            if should_notify {
                notify(db, None, NotificationLevel::Error, title, message, ())?;
            }
            Ok(())
        })
        .await
        .result
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn complete_preflight_is_order_independent_and_uses_full_copies() {
        let first = complete_run_required_capacity([(100, 0, 1), (200, 1, 1)]).unwrap();
        let reversed = complete_run_required_capacity([(200, 1, 1), (100, 0, 1)]).unwrap();
        assert_eq!(first, reversed);
        assert_eq!(first, PREFLIGHT_METADATA_BYTES + 100 + 220);
    }

    #[tokio::test]
    async fn transient_mount_failure_is_retried() {
        let attempts = AtomicUsize::new(0);
        let result = retry_mount(
            || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err(Error::new(
                            eyre!("transient mount failure"),
                            ErrorKind::Filesystem,
                        ))
                    } else {
                        Ok(())
                    }
                }
            },
            &[Duration::ZERO],
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn persistent_mount_failure_stops_after_bounded_retries() {
        let attempts = AtomicUsize::new(0);
        let result: Result<(), Error> = retry_mount(
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                async {
                    Err(Error::new(
                        eyre!("persistent mount failure"),
                        ErrorKind::Filesystem,
                    ))
                }
            },
            &[Duration::ZERO, Duration::ZERO],
        )
        .await;

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }
}
