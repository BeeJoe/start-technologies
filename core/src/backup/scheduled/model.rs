use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use patch_db::HasModel;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{RetentionPolicy, Schedule};
use crate::PackageId;
use crate::backup::PackageBackupReport;
use crate::backup::target::BackupTargetId;
use crate::prelude::Model;
use crate::rpc_continuations::Guid;

pub type BackupJobId = Guid;
pub type BackupRunId = Guid;
pub type ServiceSnapshotId = Guid;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum BackupServiceScope {
    All,
    Selected {
        #[serde(rename = "packageIds")]
        #[ts(rename = "packageIds")]
        package_ids: BTreeSet<PackageId>,
    },
}

impl BackupServiceScope {
    pub fn includes(&self, package_id: &PackageId) -> bool {
        match self {
            Self::All => true,
            Self::Selected { package_ids } => package_ids.contains(package_id),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "reason")]
#[ts(export)]
pub enum BackupJobPause {
    User,
    TargetUnavailable { failures: u8 },
    TargetIdentityMismatch,
    ReauthenticationRequired,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupJobStatus {
    #[ts(type = "string | null")]
    pub last_scheduled_at: Option<DateTime<Utc>>,
    #[ts(type = "string | null")]
    pub last_attempted_at: Option<DateTime<Utc>>,
    #[ts(type = "string | null")]
    pub last_succeeded_at: Option<DateTime<Utc>>,
    #[ts(type = "string | null")]
    pub next_run_at: Option<DateTime<Utc>>,
    pub consecutive_failures: u8,
    pub last_result: Option<BackupRunState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupJob {
    pub id: BackupJobId,
    pub name: String,
    pub enabled: bool,
    pub pause: Option<BackupJobPause>,
    pub target_id: BackupTargetId,
    pub target_instance_id: String,
    pub services: BackupServiceScope,
    pub schedule: Schedule,
    pub default_retention: RetentionPolicy,
    pub retention_overrides: BTreeMap<PackageId, RetentionPolicy>,
    pub status: BackupJobStatus,
    #[ts(type = "string")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "string")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BackupRunTrigger {
    Scheduled,
    CatchUp,
    RunNow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BackupRunState {
    Running,
    Succeeded,
    PartiallyFailed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupRun {
    pub id: BackupRunId,
    pub job_id: BackupJobId,
    pub job_name: String,
    pub target_id: BackupTargetId,
    pub trigger: BackupRunTrigger,
    pub state: BackupRunState,
    #[ts(type = "string")]
    pub started_at: DateTime<Utc>,
    #[ts(type = "string | null")]
    pub completed_at: Option<DateTime<Utc>>,
    pub intended_services: BTreeSet<PackageId>,
    pub services: BTreeMap<PackageId, PackageBackupReport>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BackupSource {
    Manual,
    Scheduled,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServiceSnapshot {
    pub id: ServiceSnapshotId,
    pub package_id: PackageId,
    pub package_version: String,
    pub source: BackupSource,
    pub job_id: BackupJobId,
    pub job_name: String,
    pub run_id: BackupRunId,
    #[ts(type = "string")]
    pub completed_at: DateTime<Utc>,
    #[ts(type = "number")]
    pub logical_size: u64,
    #[ts(type = "number | null")]
    pub physical_size: Option<u64>,
    #[ts(type = "number | null")]
    pub changed_bytes: Option<u64>,
    #[ts(type = "string")]
    pub measured_at: DateTime<Utc>,
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServiceTargetRetentionPolicy {
    pub target_id: BackupTargetId,
    pub package_id: PackageId,
    /// Local timezone used to form retention buckets. It is initialized by the
    /// first job that creates this shared service-target history.
    pub timezone: String,
    pub policy: RetentionPolicy,
    pub feeding_jobs: BTreeSet<BackupJobId>,
    pub archived: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, HasModel, TS)]
#[serde(rename_all = "camelCase")]
#[model = "Model<Self>"]
#[ts(export)]
pub struct ScheduledBackupState {
    pub jobs: BTreeMap<BackupJobId, BackupJob>,
    pub histories: BTreeMap<String, ServiceTargetHistory>,
    pub runs: BTreeMap<BackupRunId, BackupRun>,
    pub target_failures: BTreeMap<String, BackupTargetFailureState>,
    pub pending_service_reviews: BTreeMap<PackageId, NewServiceBackupReview>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, HasModel, TS)]
#[serde(rename_all = "camelCase")]
#[model = "Model<Self>"]
#[ts(export)]
pub struct ServiceTargetHistory {
    pub target_id: BackupTargetId,
    pub target_instance_id: String,
    pub package_id: PackageId,
    pub timezone: String,
    pub policy: RetentionPolicy,
    pub feeding_jobs: BTreeSet<BackupJobId>,
    pub snapshots: Vec<ServiceSnapshot>,
    pub archived: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, HasModel, TS)]
#[serde(rename_all = "camelCase")]
#[model = "Model<Self>"]
#[ts(export)]
pub struct BackupTargetFailureState {
    pub consecutive_connectivity_failures: u8,
    pub jobs_paused: BTreeSet<BackupJobId>,
    pub notification_sent: bool,
}

impl BackupTargetFailureState {
    /// Records one failed target connection. Returns true exactly once when
    /// the failure threshold is crossed and user intervention is required.
    pub fn record_failure(&mut self, affected_jobs: impl IntoIterator<Item = BackupJobId>) -> bool {
        self.consecutive_connectivity_failures =
            self.consecutive_connectivity_failures.saturating_add(1);
        if self.consecutive_connectivity_failures < 3 {
            return false;
        }
        self.jobs_paused.extend(affected_jobs);
        if self.notification_sent {
            false
        } else {
            self.notification_sent = true;
            true
        }
    }

    pub fn reset(&mut self) {
        self.consecutive_connectivity_failures = 0;
        self.jobs_paused.clear();
        self.notification_sent = false;
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, HasModel, TS)]
#[serde(rename_all = "camelCase")]
#[model = "Model<Self>"]
#[ts(export)]
pub struct NewServiceBackupReview {
    pub package_id: PackageId,
    pub affected_jobs: BTreeSet<BackupJobId>,
    #[ts(type = "string")]
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RetentionPolicyChangePreview {
    pub removed: Vec<ServiceSnapshot>,
    #[ts(type = "number")]
    pub estimated_reclaimed_bytes: u64,
    pub affected_jobs: Vec<String>,
}

/// Credential material is private database state and must never be exported to
/// PatchDB clients. `sealed_key` contains only the target encryption key, not a
/// user password.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackupCredential {
    pub target_instance_id: String,
    pub sealed_key: Vec<u8>,
    #[serde(default)]
    pub requires_reauthentication: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_failure_threshold_notifies_and_pauses_once() {
        let job = BackupJobId::new();
        let mut state = BackupTargetFailureState::default();
        assert!(!state.record_failure([job.clone()]));
        assert!(!state.record_failure([job.clone()]));
        assert!(state.record_failure([job.clone()]));
        assert!(!state.record_failure([job.clone()]));
        assert!(state.jobs_paused.contains(&job));
        state.reset();
        assert_eq!(state, BackupTargetFailureState::default());
    }
}
