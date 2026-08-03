/// Context message types — the history format used by ContextMemory.
///
/// Corresponds to `packages/agent-core/src/agent/context/types.ts`.

pub use kimi_protocol::context::*;



/// Projection options.
pub struct ProjectOptions {
    /// Synthesize missing tool results for mid-history gaps.
    pub synthesize_missing: bool,
    /// Drop orphan tool results with no matching call.
    pub drop_orphan_results: bool,
    /// Drop leading non-user messages.
    pub drop_leading_non_user: bool,
    /// Merge consecutive assistant messages.
    pub merge_consecutive_assistants: bool,
    /// Deduplicate duplicate tool call ids.
    pub dedupe_duplicate_tool_calls: bool,
    /// Callback for projection anomalies.
    pub on_anomaly: Option<Box<dyn Fn(ProjectionAnomaly) + Send + Sync>>,
}

impl Default for ProjectOptions {
    fn default() -> Self {
        Self {
            synthesize_missing: false,
            drop_orphan_results: false,
            drop_leading_non_user: false,
            merge_consecutive_assistants: false,
            dedupe_duplicate_tool_calls: false,
            on_anomaly: None,
        }
    }
}

/// A repair the projector applied to make the history wire-valid.
#[derive(Debug, Clone)]
pub enum ProjectionAnomaly {
    ToolResultReordered { tool_call_id: String },
    ToolResultSynthesized { tool_call_id: String, trailing: bool },
    OrphanToolResultDropped { tool_call_id: String },
    DuplicateToolCallDropped { tool_call_id: String },
    DuplicateToolResultDropped { tool_call_id: String },
    LeadingNonUserDropped { role: String },
    ConsecutiveAssistantsMerged,
    WhitespaceTextDropped { role: String },
    VacuousMessageDropped { role: String },
}




/// Synthetic tool result text for unresolved tool calls.
pub const SYNTHETIC_TOOL_RESULT_TEXT: &str =
    "Tool result is not available in the current context. Do not assume the tool completed successfully.";