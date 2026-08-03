//! Request processors — one module per method family (mirrors codex
//! `app-server/src/request_processors/`).

pub mod health;

pub use health::HealthProcessor;
