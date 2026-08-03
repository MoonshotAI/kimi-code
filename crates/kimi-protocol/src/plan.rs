//! Plan wire types — moved from `packages/kimi-agent/src/plan/mod.rs`
//! (Rust-first migration, stage A3). Pure serde types.

use serde::{Deserialize, Serialize};

/// Plan data returned by `data()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanData {
    pub id: String,
    pub content: String,
    pub path: String,
}

/// A plan file path, or null when no plan is active.
pub type PlanFilePath = Option<String>;
