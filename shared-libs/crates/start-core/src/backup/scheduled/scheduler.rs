use std::collections::BTreeMap;
use std::time::Duration;

use chrono::Utc;

use super::{
    BackupJob, BackupJobId, BackupRunState, BackupRunTrigger, ScheduledBackupState,
    activity_from_run,
};
use crate::context::RpcContext;
use crate::prelude::*;

pub async fn start_scheduler(ctx: &RpcContext) -> Result<(), Error> {
    reconcile_interrupted_backup_state(ctx).await?;

    let scheduler_ctx = ctx.clone();
    ctx.add_cron(async move {
        loop {
            let ready = scheduler_ctx
                .db
                .peek()
                .await
                .as_public()
                .as_server_info()
                .as_ntp_synced()
                .de()
                .unwrap_or(false);
            if ready {
                break;
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }

        loop {
            if let Err(error) = reconcile_if_idle(&scheduler_ctx).await {
                tracing::error!("interrupted backup reconciliation failed: {error}");
                tracing::debug!("{error:?}");
            }
            if let Err(error) = dispatch_due_jobs(&scheduler_ctx).await {
                tracing::error!("scheduled backup dispatcher failed: {error}");
                tracing::debug!("{error:?}");
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
    Ok(())
}

pub(crate) async fn reconcile_interrupted_backup_state(ctx: &RpcContext) -> Result<usize, Error> {
    let interrupted_error = t!("backup.activity.interrupted").to_string();
    let repaired = ctx
        .db
        .mutate(|db| {
            let scheduled = db.as_public_mut().as_scheduled_backups_mut();
            let mut state: ScheduledBackupState = scheduled.de()?;
            let repaired =
                reconcile_interrupted_activities(&mut state, Utc::now(), &interrupted_error);
            if repaired > 0 {
                scheduled.ser(&state)?;
            }
            db.as_public_mut()
                .as_server_info_mut()
                .as_status_info_mut()
                .as_backup_progress_mut()
                .ser(&None)?;
            Ok(repaired)
        })
        .await
        .result?;
    if repaired > 0 {
        tracing::warn!(repaired, "reconciled interrupted backup activities");
    }
    Ok(repaired)
}

async fn reconcile_if_idle(ctx: &RpcContext) -> Result<(), Error> {
    let Some(_coordinator) = try_scheduler_slot(ctx.backup_coordinator.clone()) else {
        return Ok(());
    };
    reconcile_interrupted_backup_state(ctx).await?;
    Ok(())
}

fn reconcile_interrupted_activities(
    state: &mut ScheduledBackupState,
    now: chrono::DateTime<Utc>,
    interrupted_error: &str,
) -> usize {
    let ScheduledBackupState {
        activities,
        runs,
        jobs,
        ..
    } = state;
    let mut repaired = 0;

    let mut interrupted = activities
        .iter()
        .filter(|(_, activity)| activity.state == BackupRunState::Running)
        .map(|(id, activity)| (activity.started_at, id.clone()))
        .collect::<Vec<_>>();
    interrupted.sort_by(|left, right| left.cmp(right));

    for (_, activity_id) in interrupted {
        let activity = activities
            .get_mut(&activity_id)
            .expect("interrupted activity exists");

        if let Some(run) = runs
            .get(&activity.id)
            .filter(|run| run.state != BackupRunState::Running)
        {
            *activity = activity_from_run(run);
            repaired += 1;
            continue;
        }

        let completed_at = std::cmp::max(now, activity.started_at);
        activity.state = BackupRunState::Failed;
        activity.completed_at = Some(completed_at);
        activity.error = Some(interrupted_error.to_owned());
        repaired += 1;

        if let Some(run) = runs.get_mut(&activity.id) {
            run.state = BackupRunState::Failed;
            run.completed_at = Some(completed_at);
            run.error = Some(interrupted_error.to_owned());
        }

        if let Some(job) = activity.job_id.as_ref().and_then(|id| jobs.get_mut(id)) {
            if job
                .status
                .last_attempted_at
                .is_none_or(|attempted| attempted < activity.started_at)
            {
                job.status.last_attempted_at = Some(activity.started_at);
                job.status.consecutive_failures = job.status.consecutive_failures.saturating_add(1);
                job.status.last_result = Some(BackupRunState::Failed);
            }
        }
    }

    repaired
}

async fn dispatch_due_jobs(ctx: &RpcContext) -> Result<(), Error> {
    let now = Utc::now();
    let has_due_job = ctx
        .db
        .mutate(|db| {
            let model = db.as_public_mut().as_scheduled_backups_mut().as_jobs_mut();
            let mut jobs: BTreeMap<BackupJobId, BackupJob> = model.de()?;
            let initialized = initialize_next_runs(&mut jobs, now)?;
            let has_due_job = oldest_due_job(&jobs, now).is_some();
            if initialized {
                model.ser(&jobs)?;
            }
            Ok(has_due_job)
        })
        .await
        .result?;
    if !has_due_job {
        return Ok(());
    }

    let coordinator = match try_scheduler_slot(ctx.backup_coordinator.clone()) {
        Some(coordinator) => coordinator,
        None => return Ok(()),
    };
    let due_job = ctx
        .db
        .mutate(|db| {
            let model = db.as_public_mut().as_scheduled_backups_mut().as_jobs_mut();
            let mut jobs: BTreeMap<BackupJobId, BackupJob> = model.de()?;
            let due_job = claim_oldest_due_job(&mut jobs, now)?;
            if due_job.is_some() {
                model.ser(&jobs)?;
            }
            Ok(due_job)
        })
        .await
        .result?;

    if let Some((job_id, trigger)) = due_job {
        let run_ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(error) =
                super::runner::run_job_with_coordinator(run_ctx, job_id, trigger, coordinator).await
            {
                tracing::error!("scheduled backup run failed: {error}");
                tracing::debug!("{error:?}");
            }
        });
    }
    Ok(())
}

fn try_scheduler_slot(
    coordinator: std::sync::Arc<tokio::sync::Mutex<()>>,
) -> Option<tokio::sync::OwnedMutexGuard<()>> {
    crate::backup::try_backup_coordinator(coordinator).ok()
}

fn initialize_next_runs(
    jobs: &mut BTreeMap<BackupJobId, BackupJob>,
    now: chrono::DateTime<Utc>,
) -> Result<bool, Error> {
    let mut changed = false;
    for job in jobs.values_mut() {
        if !job.enabled || job.pause.is_some() || job.status.next_run_at.is_some() {
            continue;
        }
        job.status.next_run_at = Some(
            job.schedule
                .next_after_cursor(now, job.status.last_scheduled_at)?
                .utc,
        );
        changed = true;
    }
    Ok(changed)
}

fn oldest_due_job(
    jobs: &BTreeMap<BackupJobId, BackupJob>,
    now: chrono::DateTime<Utc>,
) -> Option<(BackupJobId, chrono::DateTime<Utc>)> {
    jobs.iter()
        .filter(|(_, job)| job.enabled && job.pause.is_none())
        .filter_map(|(id, job)| {
            job.status
                .next_run_at
                .filter(|scheduled_at| *scheduled_at <= now)
                .map(|scheduled_at| (id.clone(), scheduled_at))
        })
        .min_by(|(left_id, left_at), (right_id, right_at)| {
            left_at.cmp(right_at).then_with(|| left_id.cmp(right_id))
        })
}

fn claim_oldest_due_job(
    jobs: &mut BTreeMap<BackupJobId, BackupJob>,
    now: chrono::DateTime<Utc>,
) -> Result<Option<(BackupJobId, BackupRunTrigger)>, Error> {
    let Some((job_id, scheduled_at)) = oldest_due_job(jobs, now) else {
        return Ok(None);
    };
    let job = jobs.get_mut(&job_id).expect("selected backup job exists");
    let trigger = if now - scheduled_at > chrono::Duration::minutes(1) {
        BackupRunTrigger::CatchUp
    } else {
        BackupRunTrigger::Scheduled
    };
    job.status.last_scheduled_at = Some(scheduled_at);
    job.status.next_run_at = Some(job.schedule.next_after_cursor(now, Some(scheduled_at))?.utc);
    Ok(Some((job_id, trigger)))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    use super::*;

    fn job_with_next_run(id: &str, next_run_at: chrono::DateTime<Utc>) -> BackupJob {
        serde_json::from_value(json!({
            "id": id,
            "name": "Automatic backups",
            "enabled": true,
            "pause": null,
            "targetId": "cifs-0",
            "targetInstanceId": "MF7VAXKAMQ7LB5JBWNSW7OFAY3XWIZ5S",
            "services": {
                "type": "allExcept",
                "excludedPackageIds": []
            },
            "schedule": {
                "cron": "0 * * * *",
                "timezone": "UTC"
            },
            "defaultRetention": { "tiers": [] },
            "retentionOverrides": {},
            "status": {
                "lastScheduledAt": null,
                "lastAttemptedAt": null,
                "lastSucceededAt": null,
                "nextRunAt": next_run_at,
                "consecutiveFailures": 0,
                "lastResult": null
            },
            "createdAt": "2026-07-10T03:25:37Z",
            "updatedAt": "2026-07-10T03:25:37Z"
        }))
        .unwrap()
    }

    fn due_jobs(now: chrono::DateTime<Utc>) -> BTreeMap<BackupJobId, BackupJob> {
        let first_id = "2BY2ABKG4HN5F75DNPPL54ALW4PFXPLD";
        let oldest_id = "WO4IBGDJGLOERNNYUQ5EDOXUMSUWU2VH";
        let first = job_with_next_run(first_id, now - chrono::Duration::minutes(2));
        let oldest = job_with_next_run(oldest_id, now - chrono::Duration::hours(1));
        [(first.id.clone(), first), (oldest.id.clone(), oldest)]
            .into_iter()
            .collect()
    }

    #[test]
    fn scheduler_claims_only_the_oldest_due_job() {
        let now = Utc.with_ymd_and_hms(2026, 7, 10, 12, 0, 0).unwrap();
        let mut jobs = due_jobs(now);
        let first_id: BackupJobId =
            serde_json::from_value(json!("2BY2ABKG4HN5F75DNPPL54ALW4PFXPLD")).unwrap();
        let oldest_id: BackupJobId =
            serde_json::from_value(json!("WO4IBGDJGLOERNNYUQ5EDOXUMSUWU2VH")).unwrap();
        let first_status = jobs.get(&first_id).unwrap().status.clone();

        let claimed = claim_oldest_due_job(&mut jobs, now).unwrap().unwrap();

        assert_eq!(claimed, (oldest_id.clone(), BackupRunTrigger::CatchUp));
        assert_eq!(jobs.get(&first_id).unwrap().status, first_status);
        let claimed_status = &jobs.get(&oldest_id).unwrap().status;
        assert_eq!(
            claimed_status.last_scheduled_at,
            Some(now - chrono::Duration::hours(1))
        );
        assert!(claimed_status.next_run_at.is_some_and(|next| next > now));
    }

    #[test]
    fn busy_scheduler_slot_leaves_due_jobs_unchanged() {
        let now = Utc.with_ymd_and_hms(2026, 7, 10, 12, 0, 0).unwrap();
        let mut jobs = due_jobs(now);
        let before = jobs.clone();
        let coordinator = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let _active_operation = crate::backup::try_backup_coordinator(coordinator.clone()).unwrap();

        let claimed = try_scheduler_slot(coordinator)
            .map(|_slot| claim_oldest_due_job(&mut jobs, now).unwrap());

        assert!(claimed.is_none());
        assert_eq!(jobs, before);
    }

    #[test]
    fn interrupted_running_activity_and_run_are_failed_on_startup() {
        let activity_id = "7ANO3T72PSPP6NFBQMVBQH6XPCGQS3BY";
        let job_id = "WO4IBGDJGLOERNNYUQ5EDOXUMSUWU2VH";
        let mut state: ScheduledBackupState = serde_json::from_value(json!({
            "jobs": {},
            "histories": {},
            "runs": {
                (activity_id): {
                    "id": activity_id,
                    "jobId": job_id,
                    "jobName": "Automatic backups",
                    "targetId": "cifs-0",
                    "trigger": "runNow",
                    "state": "running",
                    "startedAt": "2026-07-02T11:13:09Z",
                    "completedAt": null,
                    "intendedServices": [],
                    "services": {},
                    "error": null
                }
            },
            "activities": {
                (activity_id): {
                    "id": activity_id,
                    "kind": "automatic",
                    "state": "running",
                    "targetId": "cifs-0",
                    "sourceServerId": null,
                    "jobId": job_id,
                    "jobName": "Automatic backups",
                    "trigger": "runNow",
                    "startedAt": "2026-07-02T11:13:09Z",
                    "completedAt": null,
                    "intendedServices": [],
                    "services": {},
                    "error": null
                }
            },
            "targetFailures": {},
            "pendingServiceReviews": {}
        }))
        .unwrap();
        let now = Utc.with_ymd_and_hms(2026, 7, 2, 12, 0, 0).unwrap();

        assert_eq!(
            reconcile_interrupted_activities(&mut state, now, "interrupted"),
            1
        );
        let activity = state.activities.values().next().unwrap();
        let run = state.runs.values().next().unwrap();
        assert_eq!(activity.state, BackupRunState::Failed);
        assert_eq!(activity.completed_at, Some(now));
        assert_eq!(activity.error.as_deref(), Some("interrupted"));
        assert_eq!(run.state, BackupRunState::Failed);
        assert_eq!(run.completed_at, Some(now));
        assert_eq!(run.error.as_deref(), Some("interrupted"));
    }

    #[test]
    fn running_restore_is_reconciled_after_the_coordinator_is_acquired() {
        let activity_id = "7ANO3T72PSPP6NFBQMVBQH6XPCGQS3BY";
        let mut state: ScheduledBackupState = serde_json::from_value(json!({
            "jobs": {},
            "histories": {},
            "runs": {},
            "activities": {
                (activity_id): {
                    "id": activity_id,
                    "kind": "restore",
                    "state": "running",
                    "targetId": "cifs-0",
                    "sourceServerId": null,
                    "jobId": null,
                    "jobName": null,
                    "trigger": null,
                    "startedAt": "2026-07-10T03:25:39Z",
                    "completedAt": null,
                    "intendedServices": [],
                    "services": {},
                    "error": null
                }
            },
            "targetFailures": {},
            "pendingServiceReviews": {}
        }))
        .unwrap();
        let now = Utc.with_ymd_and_hms(2026, 7, 10, 3, 30, 0).unwrap();

        assert_eq!(
            reconcile_interrupted_activities(&mut state, now, "interrupted"),
            1
        );
        assert_eq!(
            state.activities.values().next().unwrap().state,
            BackupRunState::Failed
        );
    }

    #[test]
    fn older_interrupted_activity_does_not_regress_newer_job_result() {
        let interrupted_id = "KVFLSMZBCX6B77ADCCHNNJANX776HB6W";
        let failed_id = "SKGRMZBCX6B77ADCCHNNJANX776HB6W";
        let job_id = "KNDOMJVFGZPTSVSZA56OPIBLWUQ3ZK6X";
        let newer_attempt = Utc.with_ymd_and_hms(2026, 7, 10, 3, 29, 12).unwrap();
        let mut state: ScheduledBackupState = serde_json::from_value(json!({
            "jobs": {
                (job_id): {
                    "id": job_id,
                    "name": "Automatic backups",
                    "enabled": true,
                    "pause": null,
                    "targetId": "cifs-0",
                    "targetInstanceId": "MF7VAXKAMQ7LB5JBWNSW7OFAY3XWIZ5S",
                    "services": {
                        "type": "allExcept",
                        "excludedPackageIds": []
                    },
                    "schedule": {
                        "cron": "0 3 * * *",
                        "timezone": "America/New_York"
                    },
                    "defaultRetention": { "tiers": [] },
                    "retentionOverrides": {},
                    "status": {
                        "lastScheduledAt": null,
                        "lastAttemptedAt": newer_attempt,
                        "lastSucceededAt": null,
                        "nextRunAt": "2026-07-10T07:00:00Z",
                        "consecutiveFailures": 1,
                        "lastResult": "failed"
                    },
                    "createdAt": "2026-07-10T03:25:37Z",
                    "updatedAt": "2026-07-10T03:25:37Z"
                }
            },
            "histories": {},
            "runs": {
                (interrupted_id): {
                    "id": interrupted_id,
                    "jobId": job_id,
                    "jobName": "Automatic backups",
                    "targetId": "cifs-0",
                    "trigger": "runNow",
                    "state": "running",
                    "startedAt": "2026-07-10T03:25:39Z",
                    "completedAt": null,
                    "intendedServices": [],
                    "services": {},
                    "error": null
                },
                (failed_id): {
                    "id": failed_id,
                    "jobId": job_id,
                    "jobName": "Automatic backups",
                    "targetId": "cifs-0",
                    "trigger": "runNow",
                    "state": "failed",
                    "startedAt": newer_attempt,
                    "completedAt": newer_attempt,
                    "intendedServices": [],
                    "services": {},
                    "error": "insufficient capacity"
                }
            },
            "activities": {
                (interrupted_id): {
                    "id": interrupted_id,
                    "kind": "automatic",
                    "state": "running",
                    "targetId": "cifs-0",
                    "sourceServerId": null,
                    "jobId": job_id,
                    "jobName": "Automatic backups",
                    "trigger": "runNow",
                    "startedAt": "2026-07-10T03:25:39Z",
                    "completedAt": null,
                    "intendedServices": [],
                    "services": {},
                    "error": null
                },
                (failed_id): {
                    "id": failed_id,
                    "kind": "automatic",
                    "state": "failed",
                    "targetId": "cifs-0",
                    "sourceServerId": null,
                    "jobId": job_id,
                    "jobName": "Automatic backups",
                    "trigger": "runNow",
                    "startedAt": newer_attempt,
                    "completedAt": newer_attempt,
                    "intendedServices": [],
                    "services": {},
                    "error": "insufficient capacity"
                }
            },
            "targetFailures": {},
            "pendingServiceReviews": {}
        }))
        .unwrap();
        let mut multiple_interrupted = state.clone();
        let now = Utc.with_ymd_and_hms(2026, 7, 10, 3, 30, 0).unwrap();

        assert_eq!(
            reconcile_interrupted_activities(&mut state, now, "interrupted"),
            1
        );
        let activity = state
            .activities
            .values()
            .find(|activity| activity.id.as_ref() == interrupted_id)
            .unwrap();
        assert_eq!(activity.state, BackupRunState::Failed);
        assert_eq!(activity.completed_at, Some(now));

        let job = state
            .jobs
            .values()
            .find(|job| job.id.as_ref() == job_id)
            .unwrap();
        assert_eq!(job.status.last_attempted_at, Some(newer_attempt));
        assert_eq!(job.status.consecutive_failures, 1);
        assert_eq!(job.status.last_result, Some(BackupRunState::Failed));

        multiple_interrupted
            .activities
            .retain(|_, activity| activity.state == BackupRunState::Running);
        multiple_interrupted
            .runs
            .retain(|_, run| run.state == BackupRunState::Running);
        let second_id: crate::backup::scheduled::BackupActivityId =
            serde_json::from_value(json!("2BY2ABKG4HN5F75DNPPL54ALW4PFXPLD")).unwrap();
        let second_started = Utc.with_ymd_and_hms(2026, 7, 10, 3, 26, 0).unwrap();
        let mut second_activity = multiple_interrupted
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
        second_activity.id = second_id.clone();
        second_activity.started_at = second_started;
        let mut second_run = multiple_interrupted.runs.values().next().unwrap().clone();
        second_run.id = second_id.clone();
        second_run.started_at = second_started;
        multiple_interrupted
            .activities
            .insert(second_id.clone(), second_activity);
        multiple_interrupted.runs.insert(second_id, second_run);
        let job = multiple_interrupted.jobs.values_mut().next().unwrap();
        job.status.last_attempted_at = None;
        job.status.consecutive_failures = 0;
        job.status.last_result = None;

        assert_eq!(
            reconcile_interrupted_activities(&mut multiple_interrupted, now, "interrupted"),
            2
        );
        let job = multiple_interrupted.jobs.values().next().unwrap();
        assert_eq!(job.status.last_attempted_at, Some(second_started));
        assert_eq!(job.status.consecutive_failures, 2);
        assert_eq!(job.status.last_result, Some(BackupRunState::Failed));
    }
}
