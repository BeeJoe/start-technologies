use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use color_eyre::eyre::eyre;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::{BackupRun, RetentionPolicy, ServiceSnapshot, ServiceSnapshotId};
use crate::PackageId;
use crate::auth::check_password;
use crate::disk::BACKUP_DIR_NAME;
use crate::disk::mount::filesystem::ReadWrite;
use crate::disk::mount::filesystem::backupfs::BackupFS;
use crate::disk::mount::guard::{GenericMountGuard, SubPath, TmpMountGuard};
use crate::hostname::ServerHostname;
use crate::prelude::*;
use crate::rpc_continuations::Guid;
use crate::util::crypto::{decrypt_slice, encrypt_slice};
use crate::util::io::{AtomicFile, delete_dir, dir_copy, dir_size, rename};
use crate::util::serde::IoFormat;
use crate::version::VersionT;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackupRecoveryInfo {
    pub target_instance_id: String,
    pub hostname: ServerHostname,
    pub version: exver::Version,
    pub timestamp: DateTime<Utc>,
    pub password_hash: String,
    pub wrapped_key: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackupOnTargetMetadata {
    pub target_instance_id: String,
    pub services: BTreeMap<PackageId, OnTargetServiceHistory>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnTargetServiceHistory {
    pub timezone: String,
    pub policy: RetentionPolicy,
    pub archived: bool,
    pub snapshots: Vec<ServiceSnapshot>,
}

#[derive(Debug)]
pub struct ScheduledBackupMountGuard<G: GenericMountGuard> {
    target_guard: Option<G>,
    encrypted_guard: Option<TmpMountGuard>,
    recovery_path: PathBuf,
    pub recovery: ScheduledBackupRecoveryInfo,
    pub metadata: ScheduledBackupOnTargetMetadata,
}

impl<G: GenericMountGuard> ScheduledBackupMountGuard<G> {
    pub async fn initialize(
        target_guard: G,
        server_id: &str,
        hostname: ServerHostname,
        password: &str,
    ) -> Result<(Self, String), Error> {
        let root = scheduled_root(target_guard.path(), server_id);
        let recovery_path = root.join("unencrypted-metadata.json");
        let (recovery, encryption_key) = if tokio::fs::metadata(&recovery_path).await.is_ok() {
            let recovery: ScheduledBackupRecoveryInfo = read_json(&recovery_path).await?;
            check_password(&recovery.password_hash, password)?;
            let wrapped_key = base32::decode(
                base32::Alphabet::Rfc4648 { padding: true },
                &recovery.wrapped_key,
            )
            .ok_or_else(|| {
                Error::new(
                    eyre!("{}", t!("backup.scheduled.decode-key-failed")),
                    ErrorKind::Backup,
                )
            })?;
            let key = String::from_utf8(decrypt_slice(wrapped_key, password))?;
            (recovery, key)
        } else {
            let encryption_key = base32::encode(
                base32::Alphabet::Rfc4648 { padding: false },
                &rand::random::<[u8; 32]>(),
            );
            let recovery = ScheduledBackupRecoveryInfo {
                target_instance_id: Guid::new().to_string(),
                hostname,
                version: crate::version::Current::default().semver(),
                timestamp: Utc::now(),
                password_hash: argon2::hash_encoded(
                    password.as_bytes(),
                    &rand::random::<[u8; 16]>(),
                    &argon2::Config::rfc9106_low_mem(),
                )
                .with_kind(ErrorKind::PasswordHashGeneration)?,
                wrapped_key: base32::encode(
                    base32::Alphabet::Rfc4648 { padding: true },
                    &encrypt_slice(&encryption_key, password),
                ),
            };
            (recovery, encryption_key)
        };
        let guard = Self::mount_inner(
            target_guard,
            server_id,
            recovery,
            recovery_path,
            &encryption_key,
        )
        .await?;
        Ok((guard, encryption_key))
    }

    pub async fn mount_with_key(
        target_guard: G,
        server_id: &str,
        expected_target_instance_id: &str,
        encryption_key: &str,
    ) -> Result<Self, Error> {
        let recovery_path =
            scheduled_root(target_guard.path(), server_id).join("unencrypted-metadata.json");
        let recovery: ScheduledBackupRecoveryInfo = read_json(&recovery_path).await?;
        if recovery.target_instance_id != expected_target_instance_id {
            return Err(Error::new(
                eyre!("{}", t!("backup.scheduled.target-identity-mismatch")),
                ErrorKind::InvalidRequest,
            ));
        }
        Self::mount_inner(
            target_guard,
            server_id,
            recovery,
            recovery_path,
            encryption_key,
        )
        .await
    }

    pub async fn mount_with_password(
        target_guard: G,
        server_id: &str,
        expected_target_instance_id: &str,
        password: &str,
    ) -> Result<(Self, String), Error> {
        let (guard, encryption_key) =
            Self::discover_with_password(target_guard, server_id, password).await?;
        if guard.recovery.target_instance_id != expected_target_instance_id {
            return Err(Error::new(
                eyre!("{}", t!("backup.scheduled.target-identity-mismatch")),
                ErrorKind::InvalidRequest,
            ));
        }
        Ok((guard, encryption_key))
    }

    pub async fn discover_with_password(
        target_guard: G,
        server_id: &str,
        password: &str,
    ) -> Result<(Self, String), Error> {
        let recovery_path =
            scheduled_root(target_guard.path(), server_id).join("unencrypted-metadata.json");
        let recovery: ScheduledBackupRecoveryInfo = read_json(&recovery_path).await?;
        check_password(&recovery.password_hash, password)?;
        let wrapped_key = base32::decode(
            base32::Alphabet::Rfc4648 { padding: true },
            &recovery.wrapped_key,
        )
        .ok_or_else(|| {
            Error::new(
                eyre!("{}", t!("backup.scheduled.decode-key-failed")),
                ErrorKind::Backup,
            )
        })?;
        let encryption_key = String::from_utf8(decrypt_slice(wrapped_key, password))?;
        let guard = Self::mount_inner(
            target_guard,
            server_id,
            recovery,
            recovery_path,
            &encryption_key,
        )
        .await?;
        Ok((guard, encryption_key))
    }

    async fn mount_inner(
        target_guard: G,
        server_id: &str,
        recovery: ScheduledBackupRecoveryInfo,
        recovery_path: PathBuf,
        encryption_key: &str,
    ) -> Result<Self, Error> {
        let crypt_path = scheduled_root(target_guard.path(), server_id).join("crypt");
        tokio::fs::create_dir_all(&crypt_path)
            .await
            .with_ctx(|_| (ErrorKind::Filesystem, crypt_path.display()))?;
        let encrypted_guard =
            TmpMountGuard::mount(&BackupFS::new(&crypt_path, encryption_key), ReadWrite).await?;
        let metadata_path = encrypted_guard.path().join("metadata.json");
        let metadata = if tokio::fs::metadata(&metadata_path).await.is_ok() {
            read_json(&metadata_path).await?
        } else {
            ScheduledBackupOnTargetMetadata {
                target_instance_id: recovery.target_instance_id.clone(),
                services: BTreeMap::new(),
            }
        };
        if metadata.target_instance_id != recovery.target_instance_id {
            return Err(Error::new(
                eyre!("{}", t!("backup.scheduled.metadata-identity-mismatch")),
                ErrorKind::InvalidRequest,
            ));
        }
        Ok(Self {
            target_guard: Some(target_guard),
            encrypted_guard: Some(encrypted_guard),
            recovery_path,
            recovery,
            metadata,
        })
    }

    pub async fn staging(
        self: &Arc<Self>,
        run_id: &Guid,
        package_id: &PackageId,
    ) -> Result<SubPath<Arc<Self>>, Error> {
        let relative = PathBuf::from("staging")
            .join(run_id.as_ref())
            .join(&**package_id);
        let staging_path = self.path().join(&relative);
        delete_dir(&staging_path).await?;
        if let Some(previous) = self.latest_snapshot(package_id) {
            dir_copy(
                self.snapshot_path(package_id, &previous.id),
                &staging_path,
                None,
            )
            .await?;
        } else {
            tokio::fs::create_dir_all(&staging_path).await?;
        }
        Ok(SubPath::new(self.clone(), relative))
    }

    pub fn latest_snapshot(&self, package_id: &PackageId) -> Option<&ServiceSnapshot> {
        self.metadata.services.get(package_id).and_then(|history| {
            history
                .snapshots
                .iter()
                .filter(|s| !s.archived)
                .max_by_key(|s| s.completed_at)
        })
    }

    pub fn snapshot_path(
        &self,
        package_id: &PackageId,
        snapshot_id: &ServiceSnapshotId,
    ) -> PathBuf {
        self.path()
            .join("services")
            .join(&**package_id)
            .join("snapshots")
            .join(snapshot_id.as_ref())
    }

    pub fn snapshot(
        self: &Arc<Self>,
        package_id: &PackageId,
        snapshot_id: &ServiceSnapshotId,
    ) -> SubPath<Arc<Self>> {
        SubPath::new(
            self.clone(),
            PathBuf::from("services")
                .join(&**package_id)
                .join("snapshots")
                .join(snapshot_id.as_ref()),
        )
    }

    pub async fn promote(
        &mut self,
        run_id: &Guid,
        mut snapshot: ServiceSnapshot,
        timezone: String,
        policy: RetentionPolicy,
    ) -> Result<ServiceSnapshot, Error> {
        let staging_path = self
            .path()
            .join("staging")
            .join(run_id.as_ref())
            .join(&*snapshot.package_id);
        snapshot.logical_size = dir_size(&staging_path, None).await?;
        let destination = self.snapshot_path(&snapshot.package_id, &snapshot.id);
        rename(&staging_path, &destination).await?;

        self.recovery.timestamp = snapshot.completed_at;
        self.recovery.version = crate::version::Current::default().semver();

        let history = self
            .metadata
            .services
            .entry(snapshot.package_id.clone())
            .or_insert_with(|| OnTargetServiceHistory {
                timezone,
                policy: policy.clone(),
                archived: false,
                snapshots: Vec::new(),
            });
        history.policy = policy;
        history.snapshots.push(snapshot.clone());

        // Persist the replacement before pruning. A pruning failure therefore
        // leaves extra valid snapshots instead of losing the last checkpoint.
        self.save().await?;
        self.prune(&snapshot.package_id).await?;
        self.remove_unreferenced_runs().await?;
        self.save().await?;
        Ok(snapshot)
    }

    async fn prune(&mut self, package_id: &PackageId) -> Result<(), Error> {
        let Some(history) = self.metadata.services.get(package_id) else {
            return Ok(());
        };
        if history.archived {
            return Ok(());
        }
        let timezone = history.timezone.parse().map_err(|_| {
            Error::new(
                eyre!("{}", t!("backup.scheduled.stored-timezone-invalid")),
                ErrorKind::Backup,
            )
        })?;
        let retained = history
            .policy
            .retained_snapshot_ids(&history.snapshots, timezone)?;
        let removed: Vec<_> = history
            .snapshots
            .iter()
            .filter(|snapshot| !snapshot.archived && !retained.contains(&snapshot.id))
            .map(|snapshot| snapshot.id.clone())
            .collect();
        for snapshot_id in &removed {
            delete_dir(&self.snapshot_path(package_id, snapshot_id)).await?;
        }
        self.metadata
            .services
            .get_mut(package_id)
            .expect("history exists")
            .snapshots
            .retain(|snapshot| !removed.contains(&snapshot.id));
        Ok(())
    }

    pub async fn apply_policy(
        &mut self,
        package_id: &PackageId,
        timezone: String,
        policy: RetentionPolicy,
    ) -> Result<Vec<ServiceSnapshot>, Error> {
        let history = self
            .metadata
            .services
            .get_mut(package_id)
            .or_not_found(package_id)?;
        history.timezone = timezone;
        history.policy = policy;
        self.prune(package_id).await?;
        self.remove_unreferenced_runs().await?;
        self.save().await?;
        Ok(self
            .metadata
            .services
            .get(package_id)
            .expect("history exists")
            .snapshots
            .clone())
    }

    pub async fn delete_archived_snapshots(
        &mut self,
        package_id: &PackageId,
        snapshot_ids: &std::collections::BTreeSet<ServiceSnapshotId>,
    ) -> Result<Vec<ServiceSnapshot>, Error> {
        let history = self
            .metadata
            .services
            .get(package_id)
            .or_not_found(package_id)?;
        let existing: std::collections::BTreeSet<_> = history
            .snapshots
            .iter()
            .filter(|snapshot| snapshot.archived)
            .map(|snapshot| snapshot.id.clone())
            .collect();
        if !snapshot_ids.is_subset(&existing) {
            return Err(Error::new(
                eyre!("{}", t!("backup.scheduled.snapshot-delete-stale")),
                ErrorKind::InvalidRequest,
            ));
        }
        for snapshot_id in snapshot_ids {
            delete_dir(&self.snapshot_path(package_id, snapshot_id)).await?;
        }
        let history = self
            .metadata
            .services
            .get_mut(package_id)
            .expect("history exists");
        history
            .snapshots
            .retain(|snapshot| !snapshot_ids.contains(&snapshot.id));
        let remaining = history.snapshots.clone();
        self.remove_unreferenced_runs().await?;
        self.save().await?;
        Ok(remaining)
    }

    pub async fn sync_archive_states(
        &mut self,
        archived: &BTreeMap<PackageId, (bool, std::collections::BTreeSet<ServiceSnapshotId>)>,
    ) -> Result<(), Error> {
        for (package_id, (history_archived, archived_snapshots)) in archived {
            if let Some(history) = self.metadata.services.get_mut(package_id) {
                set_archive_state(history, *history_archived);
                for snapshot in &mut history.snapshots {
                    if archived_snapshots.contains(&snapshot.id) {
                        snapshot.archived = true;
                    }
                }
            }
        }
        self.save().await
    }

    async fn remove_unreferenced_runs(&self) -> Result<(), Error> {
        let referenced: std::collections::BTreeSet<_> = self
            .metadata
            .services
            .values()
            .flat_map(|history| history.snapshots.iter())
            .map(|snapshot| snapshot.run_id.to_string())
            .collect();
        let runs_path = self.path().join("runs");
        let mut entries = match tokio::fs::read_dir(&runs_path).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let run_id = name.split('.').next().unwrap_or_default();
            if !referenced.contains(run_id) {
                tokio::fs::remove_file(entry.path()).await?;
            }
        }
        Ok(())
    }

    pub async fn save_run(&self, run: &BackupRun) -> Result<(), Error> {
        write_json(
            &self.path().join("runs").join(format!("{}.json", run.id)),
            run,
        )
        .await
    }

    pub async fn save_os_backup(
        &self,
        run_id: &Guid,
        backup: &crate::backup::os::OsBackup,
    ) -> Result<(), Error> {
        write_json(
            &self
                .path()
                .join("runs")
                .join(format!("{run_id}.os-backup.json")),
            backup,
        )
        .await
    }

    pub async fn save(&self) -> Result<(), Error> {
        write_json(&self.path().join("metadata.json"), &self.metadata).await?;
        write_json(&self.recovery_path, &self.recovery).await
    }

    pub async fn save_and_unmount(self) -> Result<(), Error> {
        self.save().await?;
        self.unmount().await
    }
}

impl<G: GenericMountGuard> GenericMountGuard for ScheduledBackupMountGuard<G> {
    fn path(&self) -> &Path {
        self.encrypted_guard
            .as_ref()
            .expect("scheduled backup is mounted")
            .path()
    }

    async fn unmount(mut self) -> Result<(), Error> {
        if let Some(guard) = self.encrypted_guard.take() {
            crate::disk::mount::util::sync_directory(guard.path()).await?;
            guard.unmount().await?;
        }
        if let Some(guard) = self.target_guard.take() {
            guard.unmount().await?;
        }
        Ok(())
    }
}

impl<G: GenericMountGuard> Drop for ScheduledBackupMountGuard<G> {
    fn drop(&mut self) {
        let encrypted = self.encrypted_guard.take();
        let target = self.target_guard.take();
        tokio::spawn(async move {
            if let Some(guard) = encrypted {
                crate::disk::mount::util::sync_directory(guard.path())
                    .await
                    .log_err();
                guard.unmount().await.log_err();
            }
            if let Some(guard) = target {
                guard.unmount().await.log_err();
            }
        });
    }
}

fn scheduled_root(target_path: &Path, server_id: &str) -> PathBuf {
    target_path
        .join(BACKUP_DIR_NAME)
        .join(format!("{server_id}.automatic"))
}

fn set_archive_state(history: &mut OnTargetServiceHistory, archived: bool) {
    history.archived = archived;
    if archived {
        for snapshot in &mut history.snapshots {
            snapshot.archived = true;
        }
    }
}

async fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, Error> {
    IoFormat::Json.from_slice(
        &tokio::fs::read(path)
            .await
            .with_ctx(|_| (ErrorKind::Filesystem, path.display()))?,
    )
}

async fn write_json(path: &Path, value: &impl Serialize) -> Result<(), Error> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = AtomicFile::new(path, None::<PathBuf>).await?;
    file.write_all(&IoFormat::Json.to_vec(value)?).await?;
    file.save().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::scheduled::BackupSource;

    #[test]
    fn scheduled_root_is_separate_from_the_manual_backup_set() {
        let target = Path::new("/target");
        let manual = target.join(BACKUP_DIR_NAME).join("server-id");
        let scheduled = scheduled_root(target, "server-id");
        assert_eq!(
            scheduled,
            target.join(BACKUP_DIR_NAME).join("server-id.automatic")
        );
        assert_ne!(scheduled, manual);
    }

    #[test]
    fn reactivating_history_does_not_unarchive_old_snapshots() {
        let now = Utc::now();
        let mut history = OnTargetServiceHistory {
            timezone: "UTC".into(),
            policy: RetentionPolicy::latest_only(),
            archived: true,
            snapshots: vec![ServiceSnapshot {
                id: ServiceSnapshotId::new(),
                package_id: "test-service".parse().unwrap(),
                package_version: "1.0.0".into(),
                source: BackupSource::Scheduled,
                job_id: Guid::new(),
                job_name: "Nightly".into(),
                run_id: Guid::new(),
                completed_at: now,
                logical_size: 1,
                physical_size: None,
                changed_bytes: None,
                measured_at: now,
                archived: true,
            }],
        };

        set_archive_state(&mut history, false);
        assert!(!history.archived);
        assert!(history.snapshots[0].archived);

        history.snapshots[0].archived = false;
        set_archive_state(&mut history, true);
        assert!(history.snapshots[0].archived);
    }
}
