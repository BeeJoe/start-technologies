//! Scheduled backup domain models and policy engines.
//!
//! Scheduled storage deliberately lives beside, rather than inside, the manual
//! backup set. The execution layer uses these types to keep the two histories
//! independent while presenting one restore history to clients.

mod activity;
mod credential;
mod model;
mod retention;
mod review;
mod rpc;
mod runner;
mod schedule;
mod scheduler;
mod storage;

pub use activity::activity;
pub(crate) use activity::{
    complete as complete_activity, from_run as activity_from_run, insert as insert_activity,
    running as running_activity,
};
pub use credential::*;
pub use model::*;
pub use retention::*;
pub use review::*;
pub use rpc::{estimate_capacity_cli, history, job, policy, restore_automatic_checkpoint_cli};
pub(crate) use rpc::parse_checkpoint_selection;
pub use runner::run_job;
pub use schedule::*;
pub(crate) use scheduler::reconcile_interrupted_backup_state;
pub use scheduler::start_scheduler;
pub use storage::*;
