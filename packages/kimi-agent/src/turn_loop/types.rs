/// Core type definitions for the stateless turn loop.
///
/// These correspond to the types in `packages/agent-core/src/loop/types.ts`.

use serde::{Deserialize, Serialize};

use crate::rpc::types::TokenUsage;

pub use crate::rpc::types::ContentBlock;

// ── TurnResult ─────────────────────────────────────────────────────────────

/// The final result of a completed turn.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TurnResult {
    /// Why the turn stopped.
    pub stop_reason: LoopTurnStopReason,
    /// Number of steps taken.
    pub steps: u32,
    /// Token usage for the entire turn.
    pub usage: TokenUsage,
    /// Messages the loop appended this turn (assistant replies, tool results,
    /// and tool-media follow-ups) — everything after the synthetic system
    /// message and the caller's input. The session-owned driver writes these
    /// back into its `ContextMemory` so multi-turn history, persistence, and
    /// compaction see the assistant side. Empty on the RUN_TURN override path
    /// (the TS host owns that transcript) and serde-defaulted for wire
    /// compatibility.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub new_messages: Vec<LLMMessage>,
    /// True when the turn stopped because the per-turn step limit
    /// (`max_steps`) was reached — the loop ran every step without an early
    /// exit. Goal pursuit treats such a turn as a clean slice boundary and
    /// continues with a step-capped continuation prompt instead of pausing
    /// (upstream #2210).
    #[serde(default)]
    pub hit_step_cap: bool,
}

/// Reasons a turn can stop.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub enum LoopTurnStopReason {
    #[default]
    EndTurn,
    MaxTokens,
    Filtered,
    Paused,
    Unknown,
    Aborted,
    /// Goal budget exhausted (token, turn, or wall-clock).
    BudgetLimited,
}

// ── LLM interface ──────────────────────────────────────────────────────────

/// The LLM abstraction that the loop calls.
pub trait LLM: Send + Sync {
    /// The system prompt for this LLM.
    fn system_prompt(&self) -> &str;
    /// The model name.
    fn model_name(&self) -> &str;
    /// Whether the given error is retryable.
    fn is_retryable_error(&self, error: &str) -> bool;
    /// Send a chat request and get a response.
    fn chat(&self, params: LLMChatParams) -> crate::rpc::types::BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>>;
}

/// Parameters for an LLM chat call.
#[derive(Debug, Clone)]
pub struct LLMChatParams {
    pub messages: Vec<LLMMessage>,
    pub tools: Vec<ToolInfo>,
}

/// A message in the LLM conversation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LLMMessage {
    pub role: String,
    pub content: String,
    /// Optional multimodal content blocks (text/image). When non-empty,
    /// provider projections use these instead of the plain `content` text.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<ContentBlock>,
    /// Tool calls issued by an `assistant` message (empty otherwise). Carried
    /// structurally so multi-step tool turns project faithfully to a native
    /// provider instead of being flattened into `content`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// For a `tool` message: the id of the tool call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Information about an available tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// The LLM's response to a chat call.
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct LLMChatResponse {
    /// Assistant text content. Empty on the host-proxy path (the host owns
    /// the transcript there); filled by the native HTTP transport so the
    /// loop can thread assistant text into the message history.
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub usage: TokenUsage,
}

/// A tool call from the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

// ── ExecutableTool trait ───────────────────────────────────────────────────

/// The result of resolving a tool execution.
pub enum ToolExecution {
    Runnable(RunnableToolExecution),
    Error(ExecutableToolErrorResult),
}

/// A tool that can be executed.
pub struct RunnableToolExecution {
    pub accesses: ToolAccesses,
    pub approval_rule: String,
    /// The actual execution logic.
    pub execute: Box<dyn FnOnce(ToolExecContext) -> Result<ExecutableToolResult, Box<dyn std::error::Error>> + Send>,
}

/// Context passed to a tool's execute function.
#[derive(Debug, Clone)]
pub struct ToolExecContext {
    pub turn_id: String,
    pub tool_call_id: String,
}

/// The result of a tool execution.
#[derive(Debug, Clone, Default)]
pub struct ExecutableToolResult {
    pub content: String,
    pub is_error: bool,
    /// When true, this result is a fast prediction that should be replaced
    /// by a precise result when the background execution completes.
    pub is_prediction: bool,
    /// When true, executing this tool should stop the turn immediately.
    pub stop_turn: bool,
    /// Image parts the tool produced (e.g. ReadMediaFile, MCP image results).
    /// Delivered to the model as a follow-up `user` message with these blocks
    /// after the tool-result message, since tool-role image support is
    /// provider-divergent while user-message images are uniform.
    pub media: Vec<crate::rpc::types::ContentBlock>,
}

/// Error result from tool resolution.
#[derive(Debug, Clone)]
pub struct ExecutableToolErrorResult {
    pub message: String,
}

// ── ToolAccesses (resource conflict detection) ───────────────────────────────
//
// Matches `packages/agent-core/src/loop/tool-access.ts`.

/// File access operation type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileOperation {
    Read,
    Write,
    ReadWrite,
    Search,
}

/// Access to a single file or directory tree.
#[derive(Debug, Clone)]
pub struct ToolFileAccess {
    pub operation: FileOperation,
    pub path: String,
    pub recursive: bool,
}

/// A single resource access entry.
#[derive(Debug, Clone)]
pub enum ToolResourceAccess {
    File(ToolFileAccess),
    /// Global exclusive — conflicts with everything.
    All,
}

/// Collection of resource accesses for a tool call.
pub type ToolAccesses = Vec<ToolResourceAccess>;

impl ToolResourceAccess {
    fn file_operation_writes(op: FileOperation) -> bool {
        matches!(op, FileOperation::Write | FileOperation::ReadWrite)
    }

    fn file_operations_conflict(left: FileOperation, right: FileOperation) -> bool {
        Self::file_operation_writes(left) || Self::file_operation_writes(right)
    }

    fn normalize_path(path: &str) -> String {
        let normalized = path.replace('\\', "/");
        let folded = normalized.to_lowercase();
        if folded.len() > 1 && folded.ends_with('/') {
            folded[..folded.len() - 1].to_string()
        } else {
            folded
        }
    }

    fn file_accesses_overlap(left: &ToolFileAccess, right: &ToolFileAccess) -> bool {
        let left_path = Self::normalize_path(&left.path);
        let right_path = Self::normalize_path(&right.path);
        if left_path == right_path {
            return true;
        }
        let left_prefix = if left_path.ends_with('/') {
            left_path.clone()
        } else {
            format!("{left_path}/")
        };
        let right_prefix = if right_path.ends_with('/') {
            right_path.clone()
        } else {
            format!("{right_path}/")
        };
        (left.recursive && right_path.starts_with(&left_prefix))
            || (right.recursive && left_path.starts_with(&right_prefix))
    }

    /// Returns true if this access conflicts with another.
    pub fn conflicts_with(&self, other: &ToolResourceAccess) -> bool {
        match (self, other) {
            (ToolResourceAccess::All, _) | (_, ToolResourceAccess::All) => true,
            (ToolResourceAccess::File(l), ToolResourceAccess::File(r)) => {
                Self::file_operations_conflict(l.operation, r.operation)
                    && Self::file_accesses_overlap(l, r)
            }
        }
    }
}

/// Returns true if any access in `left` conflicts with any in `right`.
pub fn tool_accesses_conflict(left: &ToolAccesses, right: &ToolAccesses) -> bool {
    left.iter()
        .any(|l| right.iter().any(|r| l.conflicts_with(r)))
}

/// Helper to construct a read-file access.
pub fn read_file_access(path: &str) -> ToolResourceAccess {
    ToolResourceAccess::File(ToolFileAccess {
        operation: FileOperation::Read,
        path: path.to_string(),
        recursive: false,
    })
}

/// Helper to construct a write-file access.
pub fn write_file_access(path: &str) -> ToolResourceAccess {
    ToolResourceAccess::File(ToolFileAccess {
        operation: FileOperation::Write,
        path: path.to_string(),
        recursive: false,
    })
}

/// Helper to construct a read-tree access.
pub fn read_tree_access(path: &str) -> ToolResourceAccess {
    ToolResourceAccess::File(ToolFileAccess {
        operation: FileOperation::Read,
        path: path.to_string(),
        recursive: true,
    })
}

/// Helper to construct a write-tree access.
pub fn write_tree_access(path: &str) -> ToolResourceAccess {
    ToolResourceAccess::File(ToolFileAccess {
        operation: FileOperation::Write,
        path: path.to_string(),
        recursive: true,
    })
}

/// Helper to construct an all-access (globally exclusive).
pub fn all_access() -> ToolResourceAccess {
    ToolResourceAccess::All
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_read_no_conflict() {
        let a = read_file_access("/tmp/a.txt");
        let b = read_file_access("/tmp/a.txt");
        assert!(!a.conflicts_with(&b));
    }

    #[test]
    fn test_read_write_same_file_conflict() {
        let a = read_file_access("/tmp/a.txt");
        let b = write_file_access("/tmp/a.txt");
        assert!(a.conflicts_with(&b));
        assert!(b.conflicts_with(&a));
    }

    #[test]
    fn test_write_write_same_file_conflict() {
        let a = write_file_access("/tmp/a.txt");
        let b = write_file_access("/tmp/a.txt");
        assert!(a.conflicts_with(&b));
    }

    #[test]
    fn test_different_files_no_conflict() {
        let a = write_file_access("/tmp/a.txt");
        let b = write_file_access("/tmp/b.txt");
        assert!(!a.conflicts_with(&b));
    }

    #[test]
    fn test_recursive_overlap() {
        let a = read_tree_access("/tmp/project");
        let b = write_file_access("/tmp/project/src/main.rs");
        assert!(a.conflicts_with(&b));
        assert!(b.conflicts_with(&a));
    }

    #[test]
    fn test_recursive_no_overlap() {
        let a = read_tree_access("/tmp/project-a");
        let b = write_file_access("/tmp/project-b/main.rs");
        assert!(!a.conflicts_with(&b));
        assert!(!b.conflicts_with(&a));
    }

    #[test]
    fn test_all_access_conflicts_with_everything() {
        let all = all_access();
        let read = read_file_access("/tmp/x.txt");
        assert!(all.conflicts_with(&read));
        assert!(read.conflicts_with(&all));
        let write = write_file_access("/tmp/y.txt");
        assert!(all.conflicts_with(&write));
        assert!(write.conflicts_with(&all));
        let recursive = read_tree_access("/tmp");
        assert!(all.conflicts_with(&recursive));
    }

    #[test]
    fn test_all_access_self_conflict() {
        let all1 = all_access();
        let all2 = all_access();
        assert!(all1.conflicts_with(&all2));
    }

    #[test]
    fn test_readwrite_conflicts_with_both() {
        let rw = ToolResourceAccess::File(ToolFileAccess {
            operation: FileOperation::ReadWrite,
            path: "/tmp/x.txt".into(),
            recursive: false,
        });
        let read = read_file_access("/tmp/x.txt");
        let write = write_file_access("/tmp/x.txt");
        assert!(rw.conflicts_with(&read));
        assert!(read.conflicts_with(&rw));
        assert!(rw.conflicts_with(&write));
        assert!(write.conflicts_with(&rw));
    }

    #[test]
    fn test_read_read_different_dirs_no_conflict() {
        let a = read_tree_access("/a");
        let b = read_tree_access("/b");
        assert!(!a.conflicts_with(&b));
    }

    #[test]
    fn test_tool_accesses_conflict_detects() {
        let left = vec![read_file_access("/a.txt")];
        let right = vec![write_file_access("/a.txt")];
        assert!(tool_accesses_conflict(&left, &right));
    }

    #[test]
    fn test_tool_accesses_no_conflict() {
        let left = vec![read_file_access("/a.txt")];
        let right = vec![write_file_access("/b.txt")];
        assert!(!tool_accesses_conflict(&left, &right));
    }

    #[test]
    fn test_tool_accesses_mixed_conflict() {
        let left = vec![read_file_access("/a.txt"), read_file_access("/b.txt")];
        let right = vec![read_file_access("/c.txt"), write_file_access("/b.txt")];
        assert!(tool_accesses_conflict(&left, &right));
    }

    #[test]
    fn test_tool_accesses_empty_sides() {
        let left: ToolAccesses = Vec::new();
        let right = vec![write_file_access("/a.txt")];
        assert!(!tool_accesses_conflict(&left, &right));
        assert!(!tool_accesses_conflict(&right, &left));
        assert!(!tool_accesses_conflict(&left, &left));
    }

    #[test]
    fn test_normalize_path_backslashes() {
        let path = "C:\\\\Users\\\\test\\\\file.txt";
        let normalized = ToolResourceAccess::normalize_path(path);
        assert_eq!(normalized, "c://users//test//file.txt");
    }

    #[test]
    fn test_normalize_path_trailing_slash() {
        let path = "/tmp/project/";
        let normalized = ToolResourceAccess::normalize_path(path);
        assert_eq!(normalized, "/tmp/project");
    }

    #[test]
    fn test_normalize_path_no_change() {
        let path = "/home/user/file.rs";
        let normalized = ToolResourceAccess::normalize_path(path);
        assert_eq!(normalized, "/home/user/file.rs");
    }

    #[test]
    fn test_normalize_path_empty() {
        let normalized = ToolResourceAccess::normalize_path("");
        assert_eq!(normalized, "");
    }

    #[test]
    fn test_normalize_path_case_folding() {
        let path = "/TMP/PROJECT/File.Rs";
        let normalized = ToolResourceAccess::normalize_path(path);
        assert_eq!(normalized, "/tmp/project/file.rs");
    }

    #[test]
    fn test_search_does_not_conflict_with_read() {
        let search = ToolResourceAccess::File(ToolFileAccess {
            operation: FileOperation::Search,
            path: "/tmp/project".to_string(),
            recursive: true,
        });
        let read = read_file_access("/tmp/project/main.rs");
        assert!(!search.conflicts_with(&read));
        assert!(!read.conflicts_with(&search));
    }

    #[test]
    fn test_search_conflicts_with_write() {
        let search = ToolResourceAccess::File(ToolFileAccess {
            operation: FileOperation::Search,
            path: "/tmp/project".to_string(),
            recursive: true,
        });
        let write = write_file_access("/tmp/project/main.rs");
        assert!(search.conflicts_with(&write));
        assert!(write.conflicts_with(&search));
    }

    #[test]
    fn test_file_operation_writes() {
        assert!(!ToolResourceAccess::file_operation_writes(FileOperation::Read));
        assert!(ToolResourceAccess::file_operation_writes(FileOperation::Write));
        assert!(ToolResourceAccess::file_operation_writes(FileOperation::ReadWrite));
        assert!(!ToolResourceAccess::file_operation_writes(FileOperation::Search));
    }

    #[test]
    fn test_file_operations_conflict() {
        assert!(!ToolResourceAccess::file_operations_conflict(FileOperation::Read, FileOperation::Read));
        assert!(ToolResourceAccess::file_operations_conflict(FileOperation::Read, FileOperation::Write));
        assert!(ToolResourceAccess::file_operations_conflict(FileOperation::Write, FileOperation::Read));
        assert!(ToolResourceAccess::file_operations_conflict(FileOperation::Write, FileOperation::Write));
        assert!(ToolResourceAccess::file_operations_conflict(FileOperation::Read, FileOperation::ReadWrite));
        assert!(!ToolResourceAccess::file_operations_conflict(FileOperation::Search, FileOperation::Read));
        assert!(ToolResourceAccess::file_operations_conflict(FileOperation::Search, FileOperation::Write));
    }

    #[test]
    fn test_file_accesses_overlap_identical() {
        let a = ToolFileAccess {
            operation: FileOperation::Read,
            path: "/tmp/x.rs".into(),
            recursive: false,
        };
        let b = ToolFileAccess {
            operation: FileOperation::Write,
            path: "/tmp/x.rs".into(),
            recursive: false,
        };
        assert!(ToolResourceAccess::file_accesses_overlap(&a, &b));
    }

    #[test]
    fn test_file_accesses_recursive_contains_child() {
        let a = ToolFileAccess {
            operation: FileOperation::Read,
            path: "/tmp/project".into(),
            recursive: true,
        };
        let b = ToolFileAccess {
            operation: FileOperation::Write,
            path: "/tmp/project/src/main.rs".into(),
            recursive: false,
        };
        assert!(ToolResourceAccess::file_accesses_overlap(&a, &b));
    }

    #[test]
    fn test_file_accesses_both_recursive_no_overlap() {
        let a = ToolFileAccess {
            operation: FileOperation::Read,
            path: "/tmp/a".into(),
            recursive: true,
        };
        let b = ToolFileAccess {
            operation: FileOperation::Write,
            path: "/tmp/b".into(),
            recursive: true,
        };
        assert!(!ToolResourceAccess::file_accesses_overlap(&a, &b));
    }

    #[test]
    fn test_file_accesses_non_recursive_no_overlap() {
        let a = ToolFileAccess {
            operation: FileOperation::Read,
            path: "/tmp/a.rs".into(),
            recursive: false,
        };
        let b = ToolFileAccess {
            operation: FileOperation::Write,
            path: "/tmp/b.rs".into(),
            recursive: false,
        };
        assert!(!ToolResourceAccess::file_accesses_overlap(&a, &b));
    }

    #[test]
    fn test_conflicts_with_recursive_child_write() {
        let a = write_tree_access("/project");
        let b = write_tree_access("/project/sub");
        assert!(a.conflicts_with(&b));
        assert!(b.conflicts_with(&a));
    }

    #[test]
    fn test_file_accesses_overlap_with_trailing_slash() {
        let a = ToolFileAccess {
            operation: FileOperation::Read,
            path: "/project/".into(),
            recursive: true,
        };
        let b = ToolFileAccess {
            operation: FileOperation::Write,
            path: "/project/src".into(),
            recursive: false,
        };
        assert!(ToolResourceAccess::file_accesses_overlap(&a, &b));
    }
}

/// The trait that all executable tools must implement.
pub trait ExecutableTool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn resolve_execution(
        &self,
        input: serde_json::Value,
    ) -> Result<ToolExecution, Box<dyn std::error::Error>>;
}

// ── LoopHooks ──────────────────────────────────────────────────────────────

/// Possible results from the before_step hook.
#[derive(Debug, Clone)]
pub enum BeforeStepResult {
    /// Stop the turn with this reason.
    StopTurn(LoopTurnStopReason),
    /// Continue normally.
    Continue,
}

/// Possible results from the after_step hook.
#[derive(Debug, Clone)]
pub enum AfterStepResult {
    /// Stop the turn.
    StopTurn(LoopTurnStopReason),
    /// Continue to the next step.
    Continue,
}

/// Context passed to hooks.
#[derive(Debug, Clone)]
pub struct StepContext {
    pub turn_id: String,
    pub step: u32,
}

/// Context passed to after_step hook.
#[derive(Debug, Clone)]
pub struct AfterStepContext {
    pub turn_id: String,
    pub step: u32,
    pub tool_results: Vec<ExecutableToolResult>,
}

// ── Tool-level hook types (analogous to TS tool-call.ts hooks) ────────────

/// Context for tool execution hooks (prepare, authorize).
#[derive(Debug, Clone)]
pub struct ToolExecutionHookContext {
    pub turn_id: String,
    pub step_number: u32,
    pub tool_call: ToolCall,
    /// All tool calls in the current batch (provider order).
    pub tool_calls: Vec<ToolCall>,
    pub args: serde_json::Value,
    pub trace_id: Option<String>,
}

/// Extended context for resolved tool execution (with RunnableToolExecution).
#[derive(Debug, Clone)]
pub struct ResolvedToolExecutionHookContext {
    pub turn_id: String,
    pub step_number: u32,
    pub tool_call: ToolCall,
    pub tool_calls: Vec<ToolCall>,
    pub args: serde_json::Value,
    pub trace_id: Option<String>,
    /// The resolved execution (never an error result at this point).
    pub execution: RunnableToolExecutionInfo,
}

/// Serializable info about a `RunnableToolExecution` for hook contexts.
#[derive(Debug, Clone)]
pub struct RunnableToolExecutionInfo {
    pub approval_rule: String,
    pub stop_batch_after_this: bool,
}

/// Result from the authorize_tool_execution hook.
#[derive(Debug, Clone)]
pub struct AuthorizeToolExecutionResult {
    pub block: bool,
    pub reason: Option<String>,
    pub synthetic_result: Option<ExecutableToolResult>,
    pub execution_metadata: Option<serde_json::Value>,
}

/// Result from the prepare_tool_execution hook.
#[derive(Debug, Clone)]
pub struct PrepareToolExecutionResult {
    pub block: bool,
    pub reason: Option<String>,
    pub synthetic_result: Option<ExecutableToolResult>,
    pub updated_args: Option<serde_json::Value>,
    pub execution_metadata: Option<serde_json::Value>,
}

/// Context for the finalize_tool_result hook.
#[derive(Debug, Clone)]
pub struct FinalizeToolResultContext {
    pub turn_id: String,
    pub step_number: u32,
    pub tool_call: ToolCall,
    pub tool_calls: Vec<ToolCall>,
    pub args: serde_json::Value,
    pub result: ExecutableToolResult,
    pub trace_id: Option<String>,
}

/// Context for the should_continue_after_stop hook.
#[derive(Debug, Clone)]
pub struct LoopStoppedStepContext {
    pub turn_id: String,
    pub step_number: u32,
    pub usage: TokenUsage,
    pub stop_reason: LoopStepStopReason,
}

/// Result from the should_continue_after_stop hook.
#[derive(Debug, Clone)]
pub struct ShouldContinueAfterStopResult {
    pub continue_turn: bool,
}

/// The hook system for the turn loop.
/// Each hook is optional.
#[derive(Default)]
pub struct LoopHooks {
    pub before_step: Option<Box<dyn Fn(&StepContext) -> Result<Option<BeforeStepResult>, Box<dyn std::error::Error>> + Send + Sync>>,
    pub after_step: Option<Box<dyn Fn(&AfterStepContext) -> Result<Option<AfterStepResult>, Box<dyn std::error::Error>> + Send + Sync>>,
    /// Prepare tool execution hook — analogous to TS `prepareToolExecution`.
    /// Receives the tool call context and may block, return a synthetic result,
    /// or modify arguments. Return `None` to allow the call unchanged.
    pub prepare_tool_execution:
        Option<Box<dyn Fn(&ToolExecutionHookContext) -> Result<Option<PrepareToolExecutionResult>, Box<dyn std::error::Error>> + Send + Sync>>,
    /// Authorize tool execution hook — analogous to TS `authorizeToolExecution`.
    /// Runs after execution resolution, may block or return a synthetic result.
    /// Return `None` to allow the call.
    pub authorize_tool_execution:
        Option<
            Box<
                dyn Fn(&ResolvedToolExecutionHookContext) -> Result<Option<AuthorizeToolExecutionResult>, Box<dyn std::error::Error>>
                    + Send
                    + Sync,
            >,
        >,
    /// Finalize tool result hook — analogous to TS `finalizeToolResult`.
    /// Allows post-execution transformation (redaction, truncation).
    /// Return `None` to use the result as-is.
    pub finalize_tool_result:
        Option<
            Box<
                dyn Fn(&FinalizeToolResultContext) -> Result<Option<ExecutableToolResult>, Box<dyn std::error::Error>> + Send + Sync,
            >,
        >,
    /// Should-continue-after-stop hook — analogous to TS `shouldContinueAfterStop`.
    /// Decides whether the turn continues after a terminal stop reason.
    pub should_continue_after_stop:
        Option<Box<dyn Fn(&LoopStoppedStepContext) -> Result<Option<ShouldContinueAfterStopResult>, Box<dyn std::error::Error>> + Send + Sync>>,
}

// ── GoalContext (budget-aware turn execution) ──────────────────────────────

/// Goal status, matching the 6-state machine in `kimi-native-tools::goal::state`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub enum GoalStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "budgetLimited")]
    BudgetLimited,
    #[serde(rename = "usageLimited")]
    UsageLimited,
}

impl GoalStatus {
    /// Returns true if the goal is actively being pursued.
    pub fn is_active(self) -> bool {
        matches!(self, GoalStatus::Active)
    }
}

/// Goal context passed from the host for budget-aware turn execution.
///
/// The host owns the durable goal state; this struct carries a snapshot
/// so the Rust loop can check budgets locally and render steering text
/// without an extra round-trip per step.
#[derive(Debug, Clone, Deserialize)]
pub struct GoalContext {
    pub goal_id: String,
    pub objective: String,
    pub status: GoalStatus,
    /// Optional token budget (total tokens allowed).
    pub token_budget: Option<i64>,
    /// Optional turn budget (max turns).
    pub turn_budget: Option<i64>,
    /// Cumulative tokens consumed so far (before this turn).
    pub tokens_used: i64,
    /// Cumulative turns run so far (before this turn).
    pub turns_used: i64,
}

impl GoalContext {
    /// Returns true if adding `turn_tokens` and one more turn would exceed
    /// any configured budget.
    pub fn would_exceed_budget(&self, turn_tokens: i64, turns_this_turn: i64) -> bool {
        if let Some(budget) = self.token_budget {
            if self.tokens_used + turn_tokens >= budget {
                return true;
            }
        }
        if let Some(budget) = self.turn_budget {
            if self.turns_used + turns_this_turn >= budget {
                return true;
            }
        }
        false
    }

    /// Maximum fraction of any budget dimension currently consumed
    /// (0.0 when no budgets configured).
    pub fn budget_fraction(&self, turn_tokens: i64, turns_this_turn: i64) -> f64 {
        let mut fractions = Vec::new();
        if let Some(budget) = self.token_budget {
            if budget > 0 {
                fractions.push((self.tokens_used + turn_tokens) as f64 / budget as f64);
            }
        }
        if let Some(budget) = self.turn_budget {
            if budget > 0 {
                fractions.push((self.turns_used + turns_this_turn) as f64 / budget as f64);
            }
        }
        fractions.iter().cloned().fold(0.0_f64, f64::max)
    }
}

// ── RunTurnInput ───────────────────────────────────────────────────────────

/// Input to the `run_turn` function.
pub struct RunTurnInput<'a> {
    pub turn_id: String,
    pub llm: &'a dyn LLM,
    pub messages: Vec<LLMMessage>,
    pub tools: &'a [&'a dyn ExecutableTool],
    /// Tool definitions passed from the JS side. These are sent to the
    /// LLM proxy so the JS host can include them in the actual LLM call.
    pub tool_defs: Vec<ToolInfo>,
    pub hooks: Option<&'a LoopHooks>,
    pub max_steps: u32,
    /// Optional goal context for budget-aware execution and steering.
    /// When present, the loop checks budgets before each step and injects
    /// steering text into the system prompt.
    pub goal: Option<GoalContext>,
    /// Optional cancellation flag. When set to true, the loop aborts
    /// before the next step with `LoopTurnStopReason::Aborted`.
    pub cancellation: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// Optional steer queue (shared with the session driver). Drained at the
    /// start of every step and injected as a user message, so a steer issued
    /// mid-turn redirects the NEXT step — not just the next turn.
    pub steer_queue: Option<std::sync::Arc<std::sync::Mutex<Vec<crate::context::types::ContentPart>>>>,
}

// ── Step-level types ───────────────────────────────────────────────────────

/// Result of a single step.
#[derive(Debug, Clone)]
pub struct StepResult {
    pub usage: TokenUsage,
    pub stop_reason: LoopStepStopReason,
    /// Assistant text produced in this step (may be empty on the host-proxy
    /// path, where the host owns the transcript).
    pub content: String,
}

/// Reasons a single step can stop.
#[derive(Debug, Clone)]
pub enum LoopStepStopReason {
    /// The LLM returned a complete response (no more tool calls).
    Complete,
    /// The LLM made tool calls that need to be executed.
    ToolCalls(Vec<ToolCall>),
    /// The step was aborted.
    Aborted,
    /// An error occurred.
    Error(String),
}

#[cfg(test)]
mod goal_tests {
    use super::*;

    fn active_goal() -> GoalContext {
        GoalContext {
            goal_id: "g".into(),
            objective: "test".into(),
            status: GoalStatus::Active,
            token_budget: Some(1000),
            turn_budget: Some(10),
            tokens_used: 0,
            turns_used: 0,
        }
    }

    #[test]
    fn test_is_active() {
        assert!(GoalStatus::Active.is_active());
        assert!(!GoalStatus::Paused.is_active());
        assert!(!GoalStatus::Blocked.is_active());
        assert!(!GoalStatus::Complete.is_active());
        assert!(!GoalStatus::BudgetLimited.is_active());
        assert!(!GoalStatus::UsageLimited.is_active());
    }

    #[test]
    fn test_would_exceed_budget_token_at_limit() {
        let mut g = active_goal();
        g.tokens_used = 1000;
        assert!(g.would_exceed_budget(0, 0), "at limit should exceed");
    }

    #[test]
    fn test_would_exceed_budget_token_near_limit() {
        let mut g = active_goal();
        g.tokens_used = 900;
        // 900 + 50 = 950 < 1000, should NOT exceed
        assert!(!g.would_exceed_budget(50, 0));
        // 900 + 100 = 1000 >= 1000, should exceed
        assert!(g.would_exceed_budget(100, 0));
    }

    #[test]
    fn test_would_exceed_budget_turn_at_limit() {
        let mut g = active_goal();
        g.turns_used = 10;
        assert!(g.would_exceed_budget(0, 0));
    }

    #[test]
    fn test_would_exceed_budget_turn_near_limit() {
        let mut g = active_goal();
        g.turns_used = 8;
        assert!(!g.would_exceed_budget(0, 1), "8+1=9 < 10, should not exceed");
        assert!(g.would_exceed_budget(0, 2), "8+2=10 >= 10, should exceed");
    }

    #[test]
    fn test_would_exceed_budget_no_budgets() {
        let g = GoalContext {
            goal_id: "g".into(),
            objective: "test".into(),
            status: GoalStatus::Active,
            token_budget: None,
            turn_budget: None,
            tokens_used: 99999,
            turns_used: 99999,
        };
        assert!(!g.would_exceed_budget(99999, 99999));
    }

    #[test]
    fn test_budget_fraction_no_budgets() {
        let g = GoalContext {
            goal_id: "g".into(),
            objective: "test".into(),
            status: GoalStatus::Active,
            token_budget: None,
            turn_budget: None,
            tokens_used: 0,
            turns_used: 0,
        };
        assert_eq!(g.budget_fraction(100, 5), 0.0);
    }

    #[test]
    fn test_budget_fraction_half() {
        let g = active_goal(); // token_budget=1000, turn_budget=10
        // 500/1000 = 0.5, 5/10 = 0.5 → max = 0.5
        assert_eq!(g.budget_fraction(500, 5), 0.5);
    }

    #[test]
    fn test_budget_fraction_near_limit() {
        let g = active_goal();
        // 750/1000 = 0.75, 5/10 = 0.5 → max = 0.75
        assert!(g.budget_fraction(750, 5) >= 0.75);
    }

    #[test]
    fn test_budget_fraction_over_limit() {
        let g = active_goal();
        // 1500/1000 = 1.5
        assert!(g.budget_fraction(1500, 0) > 1.0);
    }

    #[test]
    fn test_budget_fraction_picks_max() {
        let g = active_goal(); // token=1000, turn=10
        // tokens: 100/1000 = 0.1, turns: 9/10 = 0.9 → max = 0.9
        let frac = g.budget_fraction(100, 9);
        assert!((frac - 0.9).abs() < 0.001, "expected 0.9, got {frac}");
    }
}