use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use clap::Parser;
use futures::{StreamExt, stream};
use patch_db::json_ptr::ROOT;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tracing::instrument;
use ts_rs::TS;

use super::PackageBackupReport;
use super::scheduled::{
    BackupActivityKind, BackupRunState, ScheduledBackupCredential, ScheduledBackupMountGuard,
    ServiceSnapshotId, complete_activity, insert_activity, running_activity,
};
use super::target::BackupTargetId;
use crate::PackageId;
use crate::backup::os::OsBackup;
use crate::context::setup::SetupResult;
use crate::context::{RpcContext, SetupContext};
use crate::db::model::Database;
use crate::disk::mount::backup::BackupMountGuard;
use crate::disk::mount::filesystem::ReadWrite;
use crate::disk::mount::guard::{GenericMountGuard, TmpMountGuard};
use crate::hostname::ServerHostnameInfo;
use crate::init::init;
use crate::prelude::*;
use crate::progress::ProgressUnits;
use crate::s9pk::S9pk;
use crate::service::service_map::DownloadInstallFuture;
use crate::setup::SetupExecuteProgress;
use crate::system::{save_language, sync_kiosk};
use crate::util::serde::{IoFormat, Pem};

#[derive(Deserialize, Serialize, Parser, TS)]
#[group(skip)]
#[serde(rename_all = "camelCase")]
#[command(rename_all = "kebab-case")]
#[ts(export)]
pub struct RestorePackageParams {
    #[arg(help = "help.arg.backup-target-id")]
    pub target_id: BackupTargetId,
    #[arg(help = "help.arg.backup-password")]
    pub password: String,
    #[arg(help = "help.arg.package-ids")]
    pub ids: Vec<PackageId>,
    #[arg(long, help = "help.arg.server-id")]
    pub server_id: Option<String>,
}

// #[command(rename = "restore", display(display_none))]
#[instrument(skip(ctx, password))]
pub async fn restore_packages_rpc(
    ctx: RpcContext,
    RestorePackageParams {
        ids,
        target_id,
        password,
        server_id,
    }: RestorePackageParams,
) -> Result<(), Error> {
    restore_selection_rpc(
        ctx,
        RestoreSelectionParams {
            target_id,
            manual_ids: ids,
            snapshots: BTreeMap::new(),
            server_id,
            password: Some(password),
        },
    )
    .await
}

#[derive(Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoreSelectionParams {
    pub target_id: BackupTargetId,
    #[serde(default)]
    pub manual_ids: Vec<PackageId>,
    #[serde(default)]
    pub snapshots: BTreeMap<PackageId, ServiceSnapshotId>,
    #[serde(default)]
    #[ts(optional)]
    pub server_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub password: Option<String>,
}

pub async fn restore_selection_rpc(
    ctx: RpcContext,
    RestoreSelectionParams {
        target_id,
        manual_ids,
        snapshots,
        server_id,
        password,
    }: RestoreSelectionParams,
) -> Result<(), Error> {
    if manual_ids.iter().any(|id| snapshots.contains_key(id)) {
        return Err(Error::new(
            eyre!("{}", t!("backup.restore.duplicate-checkpoint")),
            ErrorKind::InvalidRequest,
        ));
    }
    if manual_ids.is_empty() && snapshots.is_empty() {
        return Err(Error::new(
            eyre!("{}", t!("backup.restore.select-service")),
            ErrorKind::InvalidRequest,
        ));
    }

    let operation_coordinator =
        crate::backup::try_backup_coordinator(ctx.backup_coordinator.clone())?;
    crate::backup::scheduled::reconcile_interrupted_backup_state(&ctx).await?;

    let db = ctx.db.peek().await;
    let server_id = match server_id {
        Some(server_id) => server_id,
        None => db.as_public().as_server_info().as_id().de()?,
    };
    let target = target_id.clone().load(&db)?;
    let mut tasks = BTreeMap::new();

    if !manual_ids.is_empty() {
        let password = password.as_deref().ok_or_else(|| {
            Error::new(
                eyre!("{}", t!("backup.scheduled.reauth-required")),
                ErrorKind::InvalidRequest,
            )
        })?;
        let guard = BackupMountGuard::mount(
            TmpMountGuard::mount(&target, ReadWrite).await?,
            &server_id,
            password,
        )
        .await?;
        tasks.extend(restore_packages(&ctx, guard, manual_ids).await?);
    }

    if !snapshots.is_empty() {
        let credential: Option<ScheduledBackupCredential> = db
            .as_private()
            .as_scheduled_backup_credentials()
            .as_idx(&target_id.to_string())
            .map(|credential| credential.de())
            .transpose()?;
        let guard = if let Some(credential) = credential {
            let encryption_key =
                credential.open(&db.as_private().as_scheduled_backup_device_key().de()?)?;
            ScheduledBackupMountGuard::mount_with_key(
                TmpMountGuard::mount(&target, ReadWrite).await?,
                &server_id,
                &credential.target_instance_id,
                &encryption_key,
            )
            .await?
        } else {
            let password = password.as_deref().ok_or_else(|| {
                Error::new(
                    eyre!("{}", t!("backup.scheduled.reauth-required")),
                    ErrorKind::InvalidRequest,
                )
            })?;
            ScheduledBackupMountGuard::discover_with_password(
                TmpMountGuard::mount(&target, ReadWrite).await?,
                &server_id,
                password,
            )
            .await?
            .0
        };
        tasks.extend(restore_scheduled_packages(&ctx, guard, snapshots).await?);
    }
    drop(db);

    let intended_services = tasks.keys().cloned().collect();
    let activity = running_activity(
        BackupActivityKind::Restore,
        target_id,
        Some(server_id),
        None,
        None,
        intended_services,
    );
    ctx.db
        .mutate(|db| insert_activity(db, &activity))
        .await
        .result?;
    spawn_restore_activity(ctx, activity.id, tasks, operation_coordinator);
    Ok(())
}

#[derive(Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoreScheduledPackagesParams {
    pub target_id: BackupTargetId,
    pub snapshots: BTreeMap<PackageId, ServiceSnapshotId>,
    #[serde(default)]
    #[ts(optional)]
    pub server_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub password: Option<String>,
}

pub async fn restore_scheduled_packages_rpc(
    ctx: RpcContext,
    RestoreScheduledPackagesParams {
        target_id,
        snapshots,
        server_id,
        password,
    }: RestoreScheduledPackagesParams,
) -> Result<(), Error> {
    restore_selection_rpc(
        ctx,
        RestoreSelectionParams {
            target_id,
            manual_ids: Vec::new(),
            snapshots,
            server_id,
            password,
        },
    )
    .await
}

async fn restore_scheduled_packages(
    ctx: &RpcContext,
    guard: ScheduledBackupMountGuard<TmpMountGuard>,
    snapshots: BTreeMap<PackageId, ServiceSnapshotId>,
) -> Result<BTreeMap<PackageId, DownloadInstallFuture>, Error> {
    let guard = Arc::new(guard);
    let mut tasks = BTreeMap::new();
    for (package_id, snapshot_id) in snapshots {
        let snapshot = guard.snapshot(&package_id, &snapshot_id);
        if tokio::fs::metadata(snapshot.path()).await.is_err() {
            return Err(Error::new(
                eyre!("{}", t!("backup.scheduled.snapshot-not-found")),
                ErrorKind::NotFound,
            ));
        }
        let s9pk_path = snapshot.path().join(&package_id).with_extension("s9pk");
        let task = ctx
            .services
            .install(
                ctx.clone(),
                || S9pk::open(s9pk_path, Some(&package_id)),
                None,
                Some(snapshot),
                None,
            )
            .await?;
        tasks.insert(package_id, task);
    }

    Ok(tasks)
}

fn spawn_restore_activity(
    ctx: RpcContext,
    activity_id: super::scheduled::BackupActivityId,
    tasks: BTreeMap<PackageId, DownloadInstallFuture>,
    operation_coordinator: OwnedMutexGuard<()>,
) {
    tokio::spawn(async move {
        let _operation_coordinator = operation_coordinator;
        let reports = Arc::new(Mutex::new(BTreeMap::new()));
        stream::iter(tasks)
            .for_each_concurrent(5, |(id, result)| {
                let reports = reports.clone();
                async move {
                    let started = Instant::now();
                    let error = async { result.await?.await }.await.err();
                    if let Some(error) = &error {
                        tracing::error!(
                            "{}",
                            t!("backup.restore.package-error", id = id, error = error)
                        );
                        tracing::debug!("{error:?}");
                    }
                    reports.lock().await.insert(
                        id,
                        PackageBackupReport {
                            error: error.map(|error| error.to_string()),
                            duration_ms: started.elapsed().as_millis() as u64,
                            logical_size: None,
                            physical_size: None,
                            changed_bytes: None,
                            measured_at: None,
                        },
                    );
                }
            })
            .await;
        let reports = Arc::try_unwrap(reports).unwrap().into_inner();
        let failures = reports
            .values()
            .filter(|report| report.error.is_some())
            .count();
        let state = if failures == 0 {
            BackupRunState::Succeeded
        } else if failures == reports.len() {
            BackupRunState::Failed
        } else {
            BackupRunState::PartiallyFailed
        };
        ctx.db
            .mutate(|db| complete_activity(db, &activity_id, state, reports, None))
            .await
            .result
            .log_err();
    });
}

#[instrument(skip_all)]
pub async fn recover_full_server(
    ctx: &SetupContext,
    disk_guid: InternedString,
    password: Option<String>,
    recovery_source: TmpMountGuard,
    server_id: &str,
    recovery_password: &str,
    kiosk: bool,
    hostname: Option<ServerHostnameInfo>,
    SetupExecuteProgress {
        init_phases,
        restore_phase,
        rpc_ctx_phases,
    }: SetupExecuteProgress,
) -> Result<(SetupResult, RpcContext), Error> {
    let mut restore_phase = restore_phase.or_not_found("restore progress")?;

    let backup_guard =
        BackupMountGuard::mount(recovery_source, server_id, recovery_password).await?;

    let os_backup_path = backup_guard.path().join("os-backup.json");
    let mut os_backup: OsBackup = IoFormat::Json.from_slice(
        &tokio::fs::read(&os_backup_path)
            .await
            .with_ctx(|_| (ErrorKind::Filesystem, os_backup_path.display().to_string()))?,
    )?;

    if let Some(password) = password {
        os_backup.account.password = argon2::hash_encoded(
            password.as_bytes(),
            &rand::random::<[u8; 16]>()[..],
            &argon2::Config::rfc9106_low_mem(),
        )
        .with_kind(ErrorKind::PasswordHashGeneration)?;
    }

    if let Some(h) = hostname {
        os_backup.account.hostname = h;
    }

    sync_kiosk(kiosk).await?;

    let language = ctx.language.peek(|a| a.clone());
    let keyboard = ctx.keyboard.peek(|a| a.clone());

    if let Some(language) = &language {
        save_language(&**language).await?;
    }

    if let Some(keyboard) = &keyboard {
        keyboard.save().await?;
    }

    let db = ctx.db().await?;
    db.put(
        &ROOT,
        &Database::init(&os_backup.account, kiosk, language, keyboard)?,
    )
    .await?;
    drop(db);

    let config = ctx.config.peek(|c| c.clone());

    let init_result = init(&ctx.webserver, &config, init_phases).await?;

    let rpc_ctx = RpcContext::init(
        &ctx.webserver,
        &config,
        disk_guid.clone(),
        Some(init_result),
        rpc_ctx_phases,
    )
    .await?;

    restore_phase.start();
    let ids: Vec<_> = backup_guard
        .metadata
        .package_backups
        .keys()
        .cloned()
        .collect();
    let tasks = restore_packages(&rpc_ctx, backup_guard, ids).await?;
    restore_phase.set_total(tasks.len() as u64);
    restore_phase.set_units(Some(ProgressUnits::Steps));
    let restore_phase = Arc::new(Mutex::new(restore_phase));
    stream::iter(tasks)
        .for_each_concurrent(5, |(id, res)| {
            let restore_phase = restore_phase.clone();
            async move {
                match async { res.await?.await }.await {
                    Ok(_) => (),
                    Err(err) => {
                        tracing::error!(
                            "{}",
                            t!("backup.restore.package-error", id = id, error = err)
                        );
                        tracing::debug!("{:?}", err);
                    }
                }
                *restore_phase.lock().await += 1;
            }
        })
        .await;
    restore_phase.lock().await.complete();

    Ok((
        SetupResult {
            hostname: os_backup.account.hostname.hostname,
            root_ca: Pem(os_backup.account.root_ca_cert),
            needs_restart: ctx.install_rootfs.peek(|a| a.is_some()),
        },
        rpc_ctx,
    ))
}

#[instrument(skip(ctx, backup_guard))]
async fn restore_packages(
    ctx: &RpcContext,
    backup_guard: BackupMountGuard<TmpMountGuard>,
    ids: Vec<PackageId>,
) -> Result<BTreeMap<PackageId, DownloadInstallFuture>, Error> {
    let backup_guard = Arc::new(backup_guard);
    let mut tasks = BTreeMap::new();
    for id in ids {
        let backup_dir = backup_guard.clone().package_backup(&id).await?;
        let s9pk_path = backup_dir.path().join(&id).with_extension("s9pk");
        let task = ctx
            .services
            .install(
                ctx.clone(),
                || S9pk::open(s9pk_path, Some(&id)),
                None, // TODO: pull from metadata?
                Some(backup_dir),
                None,
            )
            .await?;
        tasks.insert(id, task);
    }

    Ok(tasks)
}
