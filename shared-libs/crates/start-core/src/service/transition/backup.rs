use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;

use crate::backup::PackageBackupOutput;
use crate::disk::mount::filesystem::ReadWrite;
use crate::prelude::*;
use crate::progress::PhaseProgressTrackerHandle;
use crate::rpc_continuations::Guid;
use crate::service::action::GetActionInput;
use crate::service::start_stop::StartStop;
use crate::service::transition::{Transition, TransitionKind};
use crate::service::{ServiceActor, ServiceActorSeed};
use crate::status::DesiredStatus;
use crate::util::actor::background::BackgroundJobQueue;
use crate::util::actor::{ConflictBuilder, Handler};

/// Maximum wall-clock time an installed package may hold backup resources.
const PACKAGE_BACKUP_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

async fn run_backup_procedure<T>(
    execute: impl Future<Output = Result<T, Error>>,
    stop_runtime: impl Future<Output = Result<(), Error>>,
    unmount: impl Future<Output = Result<(), Error>>,
    restart_runtime: impl Future<Output = Result<(), Error>>,
    timeout: Duration,
) -> Result<T, Error> {
    let (execute_result, timed_out) = match tokio::time::timeout(timeout, execute).await {
        Ok(result) => (result, false),
        Err(error) => (Err(error).with_kind(ErrorKind::Timeout), true),
    };
    // A modern package hook runs inside the persistent JavaScript runtime and
    // cannot be cancelled by dropping its Promise. Stop that runtime before
    // removing the bind so timed-out package code cannot keep writing.
    let stop_result = if timed_out {
        Some(stop_runtime.await)
    } else {
        None
    };
    let unmount_result = unmount.await;
    // Only restore the runtime after both cancellation and unmount completed.
    // Otherwise leave it stopped rather than let package code regain a target
    // whose cleanup failed.
    let restart_result =
        if timed_out && stop_result.as_ref().is_some_and(Result::is_ok) && unmount_result.is_ok() {
            Some(restart_runtime.await)
        } else {
            None
        };

    if let Some(Err(error)) = &stop_result {
        tracing::error!(%error, "failed to stop package runtime after backup timeout");
    }
    if let Err(error) = &unmount_result {
        tracing::error!(%error, "failed to unmount package backup");
    }
    if let Some(Err(error)) = &restart_result {
        tracing::error!(%error, "failed to restart package runtime after backup timeout");
    }

    match execute_result {
        Ok(output) => {
            unmount_result?;
            Ok(output)
        }
        Err(error) => Err(error),
    }
}

impl ServiceActorSeed {
    async fn leave_backing_up(&self) -> Result<(), Error> {
        let id = &self.id;
        self.ctx
            .db
            .mutate(|db| {
                db.as_public_mut()
                    .as_package_data_mut()
                    .as_idx_mut(id)
                    .or_not_found(id)?
                    .as_status_info_mut()
                    .as_desired_mut()
                    .map_mutate(|s| {
                        Ok(match s {
                            DesiredStatus::BackingUp {
                                on_complete: StartStop::Start,
                            } => DesiredStatus::Running,
                            DesiredStatus::BackingUp {
                                on_complete: StartStop::Stop,
                            } => DesiredStatus::Stopped,
                            x => x,
                        })
                    })?;
                Ok(())
            })
            .await
            .result
    }

    pub fn backup(&self) -> Transition<'_> {
        Transition {
            kind: TransitionKind::BackingUp,
            future: async {
                // The backup future clears BackingUp itself when it finishes, so
                // here we just drive it to completion. If there's nothing to
                // resume, recover the state so it can't get stuck, then report.
                if let Some(backup) = self.backup.replace(None) {
                    backup.await;
                    Ok(())
                } else {
                    self.leave_backing_up().await?;
                    Err(Error::new(
                        eyre!("{}", t!("service.transition.backup.no-backup-to-resume")),
                        ErrorKind::Cancelled,
                    ))
                }
            }
            .boxed(),
        }
    }
}

pub(in crate::service) struct Backup {
    pub path: PathBuf,
    pub progress: PhaseProgressTrackerHandle,
}
impl Handler<Backup> for ServiceActor {
    type Response = Result<BoxFuture<'static, Result<PackageBackupOutput, Error>>, Error>;
    fn conflicts_with(_: &Backup) -> ConflictBuilder<Self> {
        ConflictBuilder::everything().except::<GetActionInput>()
    }
    async fn handle(
        &mut self,
        id: Guid,
        Backup { path, progress }: Backup,
        _: &BackgroundJobQueue,
    ) -> Self::Response {
        let seed = self.0.clone();
        seed.backup_phase.replace(Some(progress));

        // Split the backup into a driver (`remote`, stored for the actor to run
        // once the service has stopped) and a handle (returned to the caller).
        // Awaiting the handle only reads the result — it never drives the work —
        // so the backup can't start before the actor runs it, and the handle
        // doesn't resolve until the service has left the backing-up state.
        let (remote, handle) = async move {
            let res = async {
                let backup_guard = seed
                    .persistent_container
                    .mount_backup(path, ReadWrite)
                    .await?;
                let restart_id = id.clone();
                let output = run_backup_procedure(
                    seed.persistent_container
                        .execute_backup::<Option<PackageBackupOutput>>(
                            id,
                            Value::Null,
                            PACKAGE_BACKUP_TIMEOUT,
                        ),
                    seed.persistent_container
                        .stop_runtime_after_backup_timeout(),
                    backup_guard.unmount(true),
                    seed.persistent_container
                        .restart_runtime_after_backup_timeout(restart_id),
                    PACKAGE_BACKUP_TIMEOUT,
                )
                .await?;
                Ok::<_, Error>(output.unwrap_or_default())
            }
            .await;
            seed.leave_backing_up().await?;
            res
        }
        .remote_handle();

        self.0.backup.replace(Some(remote.boxed()));

        Ok(handle.boxed())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn package_backup_timeout_stops_unmounts_and_restarts_in_order() {
        let step = Arc::new(AtomicUsize::new(0));
        let stopped = step.clone();
        let unmounted = step.clone();
        let restarted = step.clone();
        let execute = std::future::pending::<Result<PackageBackupOutput, Error>>();
        let stop_runtime = async move {
            assert_eq!(stopped.fetch_add(1, Ordering::SeqCst), 0);
            Ok(())
        };
        let unmount = async move {
            assert_eq!(unmounted.fetch_add(1, Ordering::SeqCst), 1);
            Ok(())
        };
        let restart_runtime = async move {
            assert_eq!(restarted.fetch_add(1, Ordering::SeqCst), 2);
            Ok(())
        };

        let error = run_backup_procedure(
            execute,
            stop_runtime,
            unmount,
            restart_runtime,
            Duration::ZERO,
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Timeout);
        assert_eq!(step.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn package_backup_success_preserves_output_and_unmounts() {
        let unmounted = Arc::new(AtomicBool::new(false));
        let unmounted_after = unmounted.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_after = stopped.clone();
        let restarted = Arc::new(AtomicBool::new(false));
        let restarted_after = restarted.clone();
        let execute = async {
            Ok(PackageBackupOutput {
                changed_bytes: Some(42),
            })
        };
        let unmount = async move {
            unmounted_after.store(true, Ordering::SeqCst);
            Ok(())
        };
        let stop_runtime = async move {
            stopped_after.store(true, Ordering::SeqCst);
            Ok(())
        };
        let restart_runtime = async move {
            restarted_after.store(true, Ordering::SeqCst);
            Ok(())
        };

        let output = run_backup_procedure(
            execute,
            stop_runtime,
            unmount,
            restart_runtime,
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(output.changed_bytes, Some(42));
        assert!(unmounted.load(Ordering::SeqCst));
        assert!(!stopped.load(Ordering::SeqCst));
        assert!(!restarted.load(Ordering::SeqCst));
    }
}
