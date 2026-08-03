//! Request processors — one module per method family (mirrors codex
//! `app-server/src/request_processors/`).

pub mod config;
pub mod health;
pub mod session;

pub use config::ConfigProcessor;
pub use health::HealthProcessor;
pub use session::SessionProcessor;
