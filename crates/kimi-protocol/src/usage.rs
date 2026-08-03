//! Usage wire types — moved from `packages/kimi-agent/src/usage/mod.rs`
//! (Rust-first migration, stage A3). Pure serde types; the engine's
//! `UsageRecorder` stays in kimi-core and re-exports these.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::wire_types::TokenUsage;

/// Per-model usage summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageStatus {
    /// Usage broken down by model alias.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_model: Option<HashMap<String, TokenUsage>>,
    /// Total usage across all models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<TokenUsage>,
    /// Usage for the current turn (if any).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<TokenUsage>,
}
