//! Context wire types — moved from
//! `packages/kimi-agent/src/context/types.rs` (Rust-first migration, stage A3).
//! Pure serde types; engine logic (ProjectOptions/ProjectionAnomaly) stays in
//! kimi-core and re-exports these.

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

