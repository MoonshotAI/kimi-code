/// Agent-specific types — the AgentOptions, AgentConfig, and related contracts.
///
/// Corresponds to the types and interfaces in `packages/agent-core/src/agent/index.ts`.

use std::sync::Arc;

use crate::turn_loop::types as loop_types;

/// Configuration for the Agent.
#[derive(Clone)]
pub struct AgentConfig {
    /// Current working directory.
    pub cwd: String,
    /// Model alias (e.g. "kimi").
    pub model_alias: Option<String>,
    /// System prompt text.
    pub system_prompt: String,
    /// Whether the agent has a provider configured.
    pub has_provider: bool,
    /// Whether the agent has a model configured.
    pub has_model: bool,
}

/// Options for creating a new Agent.
pub struct AgentOptions {
    pub session_id: Option<String>,
    pub homedir: Option<String>,
    pub config: Option<AgentConfig>,
    /// Optional override for the turn loop runner.
    /// When None, the built-in Rust turn loop is used.
    pub run_turn_override: Option<Arc<dyn AgentTurnOverride + Send + Sync>>,
    /// Whether to enable goal mode.
    pub goal_enabled: bool,
    /// Whether to enable plan mode.
    pub plan_enabled: bool,
    /// Native HTTP LLM config for direct provider calls.
    pub native_llm: Option<crate::rpc::types::NativeLlmConfig>,
    /// Maximum steps per turn.
    pub max_steps_per_turn: u32,
    /// Maximum retries per step.
    pub max_retries_per_step: u32,
}

impl Default for AgentOptions {
    fn default() -> Self {
        Self {
            session_id: None,
            homedir: None,
            config: None,
            run_turn_override: None,
            goal_enabled: false,
            plan_enabled: false,
            native_llm: None,
            max_steps_per_turn: 50,
            max_retries_per_step: 3,
        }
    }
}

/// Turn override — allows the JS host to override the turn loop execution.
pub trait AgentTurnOverride: Send + Sync {
    fn run_turn(
        &self,
        input: loop_types::RunTurnInput,
        callbacks: &dyn crate::callbacks::HostCallbacks,
    ) -> crate::rpc::types::BoxFuture<'static, Result<loop_types::TurnResult, Box<dyn std::error::Error + Send + Sync>>>;
}

/// Result of a single turn.
#[derive(Debug, Clone)]
pub struct TurnResult {
    pub stop_reason: loop_types::LoopTurnStopReason,
    pub steps: u32,
    pub usage: crate::rpc::types::TokenUsage,
}

/// Reason for a turn to end.
#[derive(Debug, Clone)]
pub enum TurnEndReason {
    Completed,
    Cancelled,
    Failed(TurnError),
    Blocked,
}

/// Turn error information.
#[derive(Debug, Clone)]
pub struct TurnError {
    pub message: String,
    pub code: String,
    pub retryable: bool,
}

/// Turn end event.
#[derive(Debug, Clone)]
pub struct TurnEndedEvent {
    pub turn_id: u32,
    pub reason: TurnEndReason,
    pub duration_ms: u64,
}

/// Hook execution context.
#[derive(Debug, Clone)]
pub struct HookContext {
    pub turn_id: String,
    pub step_number: u32,
}

/// Hook result — whether to continue or stop.
#[derive(Debug, Clone)]
pub enum HookResult {
    Continue,
    StopTurn(loop_types::LoopTurnStopReason),
}

/// The hook system for the agent turn loop.
/// Mirrors the TS `LoopHooks` interface with all tool-level hooks.
#[derive(Default)]
pub struct AgentHooks {
    /// before_step: runs before each LLM step.
    pub before_step: Option<Box<dyn Fn(&HookContext) -> Result<HookResult, Box<dyn std::error::Error>> + Send + Sync>>,
    /// after_step: runs after each LLM step.
    pub after_step: Option<Box<dyn Fn(&HookContext) -> Result<HookResult, Box<dyn std::error::Error>> + Send + Sync>>,
    /// should_continue_after_stop: decides whether to continue after a terminal stop.
    pub should_continue_after_stop: Option<Box<dyn Fn(&HookContext) -> Result<bool, Box<dyn std::error::Error>> + Send + Sync>>,
}