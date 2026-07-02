use std::time::Duration;

use chrono::Utc;

use super::{
    BackupJob, BackupRunState, BackupRunTrigger, ScheduledBackupState, activity_from_run, run_job,
};
use crate::context::RpcContext;
use crate::prelude::*;

pub async fn start_scheduler(ctx: &RpcContext) -> Result<(), Error> {
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
            Ok(repaired)
        })
        .await
        .result?;
    if repaired > 0 {
        tracing::warn!(repaired, "reconciled interrupted backup activities");
    }

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
            if let Err(error) = dispatch_due_jobs(&scheduler_ctx).await {
                tracing::error!("scheduled backup dispatcher failed: {error}");
                tracing::debug!("{error:?}");
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
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

    for activity in activities.values_mut() {
        if activity.state != BackupRunState::Running {
            continue;
        }

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
            }
            job.status.consecutive_failures = job.status.consecutive_failures.saturating_add(1);
            job.status.last_result = Some(BackupRunState::Failed);
        }
    }

    repaired
}

async fn dispatch_due_jobs(ctx: &RpcContext) -> Result<(), Error> {
    let now = Utc::now();
    let due_jobs = ctx
        .db
        .mutate(|db| {
            let mut due = Vec::new();
            let jobs = db.as_public_mut().as_scheduled_backups_mut().as_jobs_mut();
            for id in jobs.keys()? {
                let model = jobs.as_idx_mut(&id).expect("job key exists");
                let mut job: BackupJob = model.de()?;
                if !job.enabled || job.pause.is_some() {
                    continue;
                }
                let Some(scheduled_at) = job.status.next_run_at else {
                    job.status.next_run_at = Some(
                        job.schedule
                            .next_after_cursor(now, job.status.last_scheduled_at)?
                            .utc,
                    );
                    model.ser(&job)?;
                    continue;
                };
                if scheduled_at > now {
                    continue;
                }
                let trigger = if now - scheduled_at > chrono::Duration::minutes(1) {
                    BackupRunTrigger::CatchUp
                } else {
                    BackupRunTrigger::Scheduled
                };
                job.status.last_scheduled_at = Some(scheduled_at);
                job.status.next_run_at =
                    Some(job.schedule.next_after_cursor(now, Some(scheduled_at))?.utc);
                model.ser(&job)?;
                due.push((id, trigger));
            }
            Ok(due)
        })
        .await
        .result?;

    for (job_id, trigger) in due_jobs {
        let run_ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(error) = run_job(run_ctx, job_id, trigger).await {
                tracing::error!("scheduled backup run failed: {error}");
                tracing::debug!("{error:?}");
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    use super::*;

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
}
