use std::time::Duration;

use chrono::Utc;

use super::{BackupJob, BackupRunTrigger, run_job};
use crate::context::RpcContext;
use crate::prelude::*;

pub fn start_scheduler(ctx: &RpcContext) {
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
