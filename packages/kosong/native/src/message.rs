//! Core message types for LLM provider communication.
//! Mirrors `packages/kosong/src/message.ts`.

use napi_derive::napi;

/// The role of a message participant.
#[napi]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

/// A content part that is plain text.
#[napi(object)]
pub struct TextPart {
    pub text: String,
}

/// A content part that references an image URL.
#[napi(object)]
pub struct ImageUrlPart {
    pub url: String,
    pub id: Option<String>,
}

/// A content part that references an audio URL.
#[napi(object)]
pub struct AudioUrlPart {
    pub url: String,
    pub id: Option<String>,
}

/// A content part that references a video URL.
#[napi(object)]
pub struct VideoUrlPart {
    pub url: String,
    pub id: Option<String>,
}

/// A content part representing thinking/reasoning content.
#[napi(object)]
pub struct ThinkPart {
    pub think: String,
    pub encrypted: Option<String>,
}

/// A single content part within a message.
#[napi(object)]
pub struct ContentPart {
    pub part_type: String,
    pub text: Option<String>,
    pub image_url: Option<ImageUrlPart>,
    pub audio_url: Option<AudioUrlPart>,
    pub video_url: Option<VideoUrlPart>,
    pub think: Option<String>,
    pub encrypted: Option<String>,
}

/// A tool call within an assistant message.
#[napi(object)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Option<String>,
}

/// A single message in the conversation history.
#[napi(object)]
pub struct Message {
    pub role: String,
    pub content: Vec<ContentPart>,
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
}

/// A streamed message part emitted during streaming responses.
#[napi(object)]
pub struct StreamedMessagePart {
    pub part_type: String,
    pub text: Option<String>,
    pub think: Option<String>,
    pub encrypted: Option<String>,
    pub image_url: Option<ImageUrlPart>,
    pub audio_url: Option<AudioUrlPart>,
    pub video_url: Option<VideoUrlPart>,
    /// For tool_call_part: partial JSON arguments
    pub arguments_part: Option<String>,
    /// For tool_call: the tool call id
    pub id: Option<String>,
    /// For tool_call: the tool name
    pub name: Option<String>,
    /// For tool_call: accumulated arguments
    pub arguments: Option<String>,
    /// Stream index for parallel tool calls
    pub stream_index: Option<i32>,
    /// Index for routing tool_call_part deltas
    pub index: Option<i32>,
}

/// Finished (non-streaming) message returned from a provider.
#[napi(object)]
pub struct StreamedMessage {
    pub id: Option<String>,
    pub content: Vec<StreamedMessagePart>,
    pub usage: TokenUsage,
    pub finish_reason: Option<String>,
    pub raw_finish_reason: Option<String>,
    pub trace_id: Option<String>,
}

impl StreamedMessagePart {
    pub fn text(text: String) -> Self {
        StreamedMessagePart {
            part_type: "text".to_string(),
            text: Some(text),
            think: None,
            encrypted: None,
            image_url: None,
            audio_url: None,
            video_url: None,
            arguments_part: None,
            id: None,
            name: None,
            arguments: None,
            stream_index: None,
            index: None,
        }
    }

    pub fn think(think: String, encrypted: Option<String>) -> Self {
        StreamedMessagePart {
            part_type: "think".to_string(),
            text: None,
            think: Some(think),
            encrypted,
            image_url: None,
            audio_url: None,
            video_url: None,
            arguments_part: None,
            id: None,
            name: None,
            arguments: None,
            stream_index: None,
            index: None,
        }
    }

    pub fn tool_call(id: String, name: String, arguments: String) -> Self {
        StreamedMessagePart {
            part_type: "function".to_string(),
            text: None,
            think: None,
            encrypted: None,
            image_url: None,
            audio_url: None,
            video_url: None,
            arguments_part: None,
            id: Some(id),
            name: Some(name),
            arguments: Some(arguments),
            stream_index: None,
            index: None,
        }
    }

    pub fn tool_call_part(arguments_part: String, index: i32) -> Self {
        StreamedMessagePart {
            part_type: "tool_call_part".to_string(),
            text: None,
            think: None,
            encrypted: None,
            image_url: None,
            audio_url: None,
            video_url: None,
            arguments_part: Some(arguments_part),
            id: None,
            name: None,
            arguments: None,
            stream_index: None,
            index: Some(index),
        }
    }
}

/// Token usage statistics.
#[napi(object)]
pub struct TokenUsage {
    pub input_other: i64,
    pub output: i64,
    pub input_cache_read: i64,
    pub input_cache_creation: i64,
}

impl TokenUsage {
    pub fn new() -> Self {
        TokenUsage {
            input_other: 0,
            output: 0,
            input_cache_read: 0,
            input_cache_creation: 0,
        }
    }
}