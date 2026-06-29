use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;
use rpc_toolkit::{Context, HandlerExt, ParentHandler, from_fn_async};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{BackupJob, BackupJobId, BackupServiceScope, NewServiceBackupReview};
use crate::PackageId;
use crate::context::RpcContext;
use crate::notifications::{NotificationLevel, notify};
use crate::prelude::*;
use crate::util::serde::HandlerExtSerde;

pub fn review<C: Context>() -> ParentHandler<C> {
    ParentHandler::new()
        .subcommand(
            "list",
            from_fn_async(list)
                .with_display_serializable()
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand("resolve", from_fn_async(resolve).no_cli())
}

pub async fn list(ctx: RpcContext) -> Result<Vec<NewServiceBackupReview>, Error> {
    ctx.db
        .peek()
        .await
        .as_public()
        .as_scheduled_backups()
        .as_pending_service_reviews()
        .as_entries()?
        .into_iter()
        .map(|(_, review)| review.de())
        .collect()
}

#[derive(Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ResolveNewServiceBackupReviewParams {
    pub package_id: PackageId,
    /// Every affected job must be present. `true` adds the service; `false`
    /// explicitly skips it for that job.
    pub decisions: BTreeMap<BackupJobId, bool>,
}

pub async fn resolve(
    ctx: RpcContext,
    ResolveNewServiceBackupReviewParams {
        package_id,
        decisions,
    }: ResolveNewServiceBackupReviewParams,
) -> Result<(), Error> {
    ctx.db
        .mutate(|db| {
            let review: NewServiceBackupReview = db
                .as_public()
                .as_scheduled_backups()
                .as_pending_service_reviews()
                .as_idx(&package_id)
                .or_not_found(&package_id)?
                .de()?;
            let provided: BTreeSet<_> = decisions.keys().cloned().collect();
            if provided != review.affected_jobs {
                return Err(Error::new(
                    eyre!("{}", t!("backup.scheduled.review-incomplete")),
                    ErrorKind::InvalidRequest,
                ));
            }

            for (job_id, add) in decisions {
                if !add {
                    continue;
                }
                let mut job: BackupJob = db
                    .as_public()
                    .as_scheduled_backups()
                    .as_jobs()
                    .as_idx(&job_id)
                    .or_not_found(&job_id)?
                    .de()?;
                if !matches!(job.services, BackupServiceScope::Selected { .. }) {
                    continue;
                }
                super::rpc::validate_new_job_coverage(
                    db,
                    &job.target_id,
                    &BTreeSet::from([package_id.clone()]),
                    &job.schedule,
                    &job.default_retention,
                    &job.retention_overrides,
                    Some(&job.id),
                    job.enabled && job.pause.is_none(),
                )?;
                let BackupServiceScope::Selected { package_ids } = &mut job.services else {
                    unreachable!("service scope was checked above")
                };
                package_ids.insert(package_id.clone());
                job.updated_at = Utc::now();
                db.as_public_mut()
                    .as_scheduled_backups_mut()
                    .as_jobs_mut()
                    .insert(&job_id, &job)?;
                super::rpc::associate_histories(db, &job, &BTreeSet::from([package_id.clone()]))?;
            }
            db.as_public_mut()
                .as_scheduled_backups_mut()
                .as_pending_service_reviews_mut()
                .remove(&package_id)?;
            Ok(())
        })
        .await
        .result
}

pub(crate) fn create_review_for_new_service(
    db: &mut crate::db::model::DatabaseModel,
    package_id: &PackageId,
) -> Result<(), Error> {
    let mut jobs = db
        .as_public()
        .as_scheduled_backups()
        .as_jobs()
        .as_entries()?
        .into_iter()
        .map(|(_, job)| job.de())
        .collect::<Result<Vec<BackupJob>, Error>>()?;
    jobs.sort_by_key(|job| job.created_at);

    let package_ids = BTreeSet::from([package_id.clone()]);
    let configured_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| match &job.services {
            BackupServiceScope::All => true,
            BackupServiceScope::AllExcept {
                excluded_package_ids,
            } => !excluded_package_ids.contains(package_id),
            BackupServiceScope::Selected { package_ids } => package_ids.contains(package_id),
        })
        .cloned()
        .collect();
    for job in &configured_jobs {
        super::rpc::associate_histories(db, job, &package_ids)?;
    }
    for job in &configured_jobs {
        super::rpc::validate_new_job_coverage(
            db,
            &job.target_id,
            &package_ids,
            &job.schedule,
            &job.default_retention,
            &job.retention_overrides,
            Some(&job.id),
            job.enabled && job.pause.is_none(),
        )?;
        super::rpc::refresh_archive_state(db, &job.target_id)?;
    }

    let affected_jobs: BTreeSet<BackupJobId> = jobs
        .into_iter()
        .filter_map(|job| match job.services {
            BackupServiceScope::Selected { package_ids } if !package_ids.contains(package_id) => {
                Some(job.id)
            }
            _ => None,
        })
        .collect();
    if affected_jobs.is_empty() {
        return Ok(());
    }

    db.as_public_mut()
        .as_scheduled_backups_mut()
        .as_pending_service_reviews_mut()
        .insert(
            package_id,
            &NewServiceBackupReview {
                package_id: package_id.clone(),
                affected_jobs,
                created_at: Utc::now(),
            },
        )?;
    notify(
        db,
        None,
        NotificationLevel::Warning,
        t!("backup.scheduled.review-title").to_string(),
        t!("backup.scheduled.review-message", package = package_id).to_string(),
        package_id.to_string(),
    )
}

pub(crate) fn ensure_review_resolved(
    db: &crate::db::model::DatabaseModel,
    package_id: &PackageId,
) -> Result<(), Error> {
    if db
        .as_public()
        .as_scheduled_backups()
        .as_pending_service_reviews()
        .as_idx(package_id)
        .is_some()
    {
        Err(Error::new(
            eyre!(
                "{}",
                t!("backup.scheduled.review-required", package = package_id)
            ),
            ErrorKind::InvalidRequest,
        ))
    } else {
        Ok(())
    }
}
