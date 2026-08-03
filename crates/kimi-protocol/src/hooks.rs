//! Hook wire types — moved from
//! `packages/kimi-agent/src/hooks/external.rs` (Rust-first migration, stage A3).
//! Pure serde types; hook execution (run_hook/hook_matches) stays in kimi-core.

use serde::{Deserialize, Serialize};

/// All lifecycle event types that can trigger hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookEventType {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionRequest,
    PermissionResult,
    UserPromptSubmit,
    Stop,
    StopFailure,
    Interrupt,
    SessionStart,
    SessionEnd,
    SubagentStart,
    SubagentStop,
    PreCompact,
    PostCompact,
    Notification,
}

impl HookEventType {
    /// Parse from a string matched to the TS `HOOK_EVENT_TYPES`.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "PreToolUse" => Some(Self::PreToolUse),
            "PostToolUse" => Some(Self::PostToolUse),
            "PostToolUseFailure" => Some(Self::PostToolUseFailure),
            "PermissionRequest" => Some(Self::PermissionRequest),
            "PermissionResult" => Some(Self::PermissionResult),
            "UserPromptSubmit" => Some(Self::UserPromptSubmit),
            "Stop" => Some(Self::Stop),
            "StopFailure" => Some(Self::StopFailure),
            "Interrupt" => Some(Self::Interrupt),
            "SessionStart" => Some(Self::SessionStart),
            "SessionEnd" => Some(Self::SessionEnd),
            "SubagentStart" => Some(Self::SubagentStart),
            "SubagentStop" => Some(Self::SubagentStop),
            "PreCompact" => Some(Self::PreCompact),
            "PostCompact" => Some(Self::PostCompact),
            "Notification" => Some(Self::Notification),
            _ => None,
        }
    }
}
/// A configured hook — parsed from the user's config.toml.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookDef {
    /// The event that triggers this hook.
    pub event: HookEventType,
    /// Optional regex pattern to match tool names (for PreToolUse/PostToolUse).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    /// The shell command to execute.
    pub command: String,
    /// Timeout in seconds (default: 30, max: 600).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u32>,
    /// Working directory for the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Environment variables for the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
}
