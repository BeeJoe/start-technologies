use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;
use rpc_toolkit::{Context, HandlerExt, ParentHandler, from_fn_async};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{BackupJob, BackupJobId, BackupServiceScope, NewServiceBackupReview};
use crate::context::RpcContext;
use crate::db::model::DatabaseModel;
use crate::db::model::package::{Task, TaskEntry, TaskSeverity};
use crate::notifications::{NotificationLevel, notify};
use crate::prelude::*;
use crate::util::serde::HandlerExtSerde;
use crate::{PackageId, SYSTEM_PACKAGE_ID};

pub const BACKUP_REVIEW_ACTION_ID: &str = "add-to-backup-schedule";
pub const BACKUP_REVIEW_REPLAY_ID: &str = "startos-add-to-backup-schedule";

pub fn review<C: Context>() -> ParentHandler<C> {
    ParentHandler::new()
        .subcommand(
            "list",
            from_fn_async(list)
                .with_display_serializable()
                .with_about("about.list-backup-service-reviews")
                .with_call_remote::<crate::context::CliContext>(),
        )
        .subcommand(
            "decide",
            from_fn_async(super::rpc::resolve_review_cli)
                .no_display()
                .with_about("about.resolve-backup-service-review")
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
            db.as_public_mut()
                .as_package_data_mut()
                .as_idx_mut(&package_id)
                .or_not_found(&package_id)?
                .as_tasks_mut()
                .remove(&BACKUP_REVIEW_REPLAY_ID.into())?;
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
    let has_jobs = !jobs.is_empty();
    let included_by_future_policy = jobs.iter().any(|job| match &job.services {
        BackupServiceScope::All => true,
        BackupServiceScope::AllExcept {
            excluded_package_ids,
        } => !excluded_package_ids.contains(package_id),
        BackupServiceScope::Selected { .. } => false,
    });

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
    if included_by_future_policy {
        return Ok(());
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
    if affected_jobs.is_empty() && has_jobs {
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
    db.as_public_mut()
        .as_package_data_mut()
        .as_idx_mut(package_id)
        .or_not_found(package_id)?
        .as_tasks_mut()
        .insert(
            &BACKUP_REVIEW_REPLAY_ID.into(),
            &TaskEntry {
                active: true,
                task: Task {
                    package_id: package_id.clone(),
                    action_id: BACKUP_REVIEW_ACTION_ID.parse()?,
                    severity: TaskSeverity::Important,
                    reason: Some(t!("backup.scheduled.review-task-reason").to_string()),
                    when: None,
                    input: None,
                },
            },
        )
        .map(|_| ())
}

pub(crate) fn pause_empty_selected_jobs(db: &mut DatabaseModel) -> Result<(), Error> {
    let mut installed: BTreeSet<PackageId> = db
        .as_public()
        .as_package_data()
        .as_entries()?
        .into_iter()
        .filter(|(_, package)| package.as_state_info().expect_installed().is_ok())
        .map(|(package_id, _)| package_id)
        .collect();
    installed.insert(SYSTEM_PACKAGE_ID.clone());
    pause_jobs_where(db, |job| {
        selected_scope_has_no_installed_services(&job.services, &installed)
    })
}

pub(crate) fn pause_job_without_services(
    db: &mut DatabaseModel,
    job_id: &BackupJobId,
) -> Result<(), Error> {
    pause_jobs_where(db, |job| &job.id == job_id)
}

fn pause_jobs_where(
    db: &mut DatabaseModel,
    should_pause: impl Fn(&BackupJob) -> bool,
) -> Result<(), Error> {
    let jobs = db
        .as_public()
        .as_scheduled_backups()
        .as_jobs()
        .as_entries()?
        .into_iter()
        .map(|(_, job)| job.de())
        .collect::<Result<Vec<BackupJob>, Error>>()?;
    let mut affected_targets = BTreeSet::new();

    for mut job in jobs {
        if !job.enabled || job.pause.is_some() || !should_pause(&job) {
            continue;
        }

        job.enabled = false;
        job.pause = Some(super::BackupJobPause::User);
        job.status.next_run_at = None;
        job.status.run_requested = false;
        job.updated_at = Utc::now();
        affected_targets.insert(job.target_id.clone());
        db.as_public_mut()
            .as_scheduled_backups_mut()
            .as_jobs_mut()
            .insert(&job.id, &job)?;
        notify(
            db,
            None,
            NotificationLevel::Warning,
            t!("backup.scheduled.no-installed-services-title").to_string(),
            t!(
                "backup.scheduled.no-installed-services-message",
                job = job.name
            )
            .to_string(),
            (),
        )?;
    }

    for target_id in affected_targets {
        super::rpc::refresh_archive_state(db, &target_id)?;
    }
    Ok(())
}

fn selected_scope_has_no_installed_services(
    scope: &BackupServiceScope,
    installed: &BTreeSet<PackageId>,
) -> bool {
    matches!(
        scope,
        BackupServiceScope::Selected { package_ids }
            if !package_ids.is_empty() && !installed.iter().any(|id| scope.includes(id))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_nonempty_selected_scopes_without_installed_services_are_empty() {
        let installed = BTreeSet::from(["installed".parse().unwrap()]);
        let selected = |ids: &[&str]| BackupServiceScope::Selected {
            package_ids: ids.iter().map(|id| id.parse().unwrap()).collect(),
        };

        let installed_with_system =
            BTreeSet::from(["installed".parse().unwrap(), SYSTEM_PACKAGE_ID.clone()]);
        assert!(!selected_scope_has_no_installed_services(
            &selected(&["removed"]),
            &installed_with_system,
        ));
        assert!(!selected_scope_has_no_installed_services(
            &selected(&["installed", "removed"]),
            &installed,
        ));
        assert!(!selected_scope_has_no_installed_services(
            &selected(&[]),
            &installed,
        ));
        assert!(!selected_scope_has_no_installed_services(
            &BackupServiceScope::All,
            &installed,
        ));
    }
}
