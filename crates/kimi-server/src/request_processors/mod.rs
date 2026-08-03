//! Request processors — one module per method family (mirrors codex
//! `app-server/src/request_processors/`).

pub mod approval;
pub mod config;
pub mod fs;
pub mod git;
pub mod health;
pub mod session;

pub use approval::ApprovalProcessor;
pub use config::ConfigProcessor;
pub use fs::FsProcessor;
pub use git::GitProcessor;
pub use health::HealthProcessor;
pub use session::SessionProcessor;
