//! Request processors — one module per method family (mirrors codex
//! `app-server/src/request_processors/`).

pub mod approval;
pub mod config;
pub mod cron;
pub mod fs;
pub mod git;
pub mod health;
pub mod permission;
pub mod plugin;
pub mod session;

pub use approval::ApprovalProcessor;
pub use config::ConfigProcessor;
pub use cron::CronProcessor;
pub use fs::FsProcessor;
pub use git::GitProcessor;
pub use health::HealthProcessor;
pub use permission::PermissionProcessor;
pub use plugin::PluginProcessor;
pub use session::SessionProcessor;
