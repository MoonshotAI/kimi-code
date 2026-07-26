/// Context message types — the history format used by ContextMemory.
///
/// Corresponds to `packages/agent-core/src/agent/context/types.ts`.

use serde::{Deserialize, Serialize};

/// A content part in a message (text, image, audio, video, thinking).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text {
        text: String,
    },
    #[serde(rename = "think")]
    Think {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        think: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    #[serde(rename = "image_url")]
    ImageUrl {
        image_url: MediaContainer,
    },
    #[serde(rename = "audio_url")]
    AudioUrl {
        audio_url: MediaContainer,
    },
    #[serde(rename = "video_url")]
    VideoUrl {
        video_url: MediaContainer,
    },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: Vec<ContentPart>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// Media container (image/audio/video URL).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MediaContainer {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// A tool call in a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub r#type: String,
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<serde_json::Value>,
}

/// Origin of a message (how it entered the context).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum MessageOrigin {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "injection")]
    Injection {
        variant: String,
    },
    #[serde(rename = "compaction_summary")]
    CompactionSummary,
    #[serde(rename = "system_trigger")]
    SystemTrigger {
        name: String,
    },
    #[serde(rename = "shell_command")]
    ShellCommand {
        phase: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    #[serde(rename = "hook_result")]
    HookResult {
        event: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blocked: Option<bool>,
    },
    #[serde(rename = "retry")]
    Retry {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trigger: Option<String>,
    },
    #[serde(rename = "background_task")]
    BackgroundTask {
        task_id: String,
        status: String,
        notification_id: String,
    },
    #[serde(rename = "cron_job")]
    CronJob {
        job_id: String,
        cron: String,
        recurring: bool,
        coalesced_count: u32,
        #[serde(default)]
        stale: bool,
    },
    #[serde(rename = "cron_missed")]
    CronMissed {
        count: u32,
    },
    #[serde(rename = "skill_activation")]
    SkillActivation {
        activation_id: String,
        skill_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill_args: Option<String>,
        trigger: String,
    },
    #[serde(rename = "plugin_command")]
    PluginCommand {
        activation_id: String,
        plugin_id: String,
        command_name: String,
        trigger: String,
    },
}

/// A message in the context history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMessage {
    pub role: String,
    #[serde(default)]
    pub content: Vec<ContentPart>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<MessageOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Tool definitions for dynamic-tool-schema messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
}

impl Default for ContextMessage {
    fn default() -> Self {
        Self {
            role: String::new(),
            content: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            origin: None,
            is_error: None,
            partial: None,
            name: None,
            note: None,
            tools: None,
        }
    }
}

/// A tool definition (for dynamic-tool-schema messages).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
}

/// Context data snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentContextData {
    pub history: Vec<ContextMessage>,
    pub token_count: u64,
}

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

/// Media strip snapshot — set of media content digests.
pub type MediaStripSnapshot = Vec<String>;

/// Compaction result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionResult {
    pub summary: String,
    pub context_summary: String,
    pub compacted_count: usize,
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub kept_user_message_count: usize,
    pub kept_head_user_message_count: Option<usize>,
    pub dropped_count: u32,
}

/// Compaction input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionInput {
    pub summary: String,
    pub context_summary: Option<String>,
    pub compacted_count: usize,
    pub tokens_before: u64,
    pub tokens_after: Option<u64>,
    pub kept_user_message_count: Option<usize>,
    pub kept_head_user_message_count: Option<usize>,
    pub dropped_count: u32,
}

/// Synthetic tool result text for unresolved tool calls.
pub const SYNTHETIC_TOOL_RESULT_TEXT: &str =
    "Tool result is not available in the current context. Do not assume the tool completed successfully.";