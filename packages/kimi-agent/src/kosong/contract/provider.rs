/// L0 contract — the ChatProvider wire contract.
///
/// Corresponds to `kosong/contract/provider.ts`.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::rpc::types::BoxFuture;

use super::errors::ChatProviderError;
use super::message::{Message, StreamedMessagePart};
use super::tool::Tool;
use super::usage::TokenUsage;

// ---------------------------------------------------------------------------
// ThinkingEffort
// ---------------------------------------------------------------------------

/// Thinking effort for one generation.
///
/// `"off"` and `"on"` are local control signals. Other strings are concrete
/// model effort values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThinkingEffort(pub String);

impl ThinkingEffort {
    pub const OFF: &'static str = "off";
    pub const ON: &'static str = "on";

    pub fn is_off(&self) -> bool {
        self.0 == Self::OFF
    }

    pub fn is_on(&self) -> bool {
        self.0 == Self::ON
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for ThinkingEffort {
    fn from(s: &str) -> Self {
        ThinkingEffort(s.to_string())
    }
}

// ---------------------------------------------------------------------------
// FinishReason
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Completed,
    #[serde(rename = "tool_calls")]
    ToolCalls,
    Truncated,
    Filtered,
    Paused,
    Other,
}

// ---------------------------------------------------------------------------
// SamplingOptions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplingOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
}

// ---------------------------------------------------------------------------
// ThinkingRequestOptions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThinkingRequestOptions {
    pub effort: ThinkingEffort,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep: Option<String>,
}

// ---------------------------------------------------------------------------
// ResponseFormat
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseFormat {
    #[serde(rename = "json_object")]
    JsonObject,
    #[serde(rename = "json_schema")]
    JsonSchema {
        #[serde(rename = "jsonSchema")]
        json_schema: JsonSchemaDefinition,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonSchemaDefinition {
    pub name: String,
    pub schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// ---------------------------------------------------------------------------
// ProviderRequestAuth
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderRequestAuth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
}

// ---------------------------------------------------------------------------
// ToolCallIdPolicy
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ToolCallIdPolicy {
    pub normalize: fn(&str) -> String,
    pub max_length: Option<usize>,
}

// ---------------------------------------------------------------------------
// StreamDecodeStats
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StreamDecodeStats {
    pub server_decode_ms: u64,
    pub client_consume_ms: u64,
}

// ---------------------------------------------------------------------------
// VideoUploadInput
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct VideoUploadInput {
    pub data: Vec<u8>,
    pub mime_type: String,
    pub filename: Option<String>,
}

// ---------------------------------------------------------------------------
// GenerateOptions
// ---------------------------------------------------------------------------

/// Per-call settings for one `ChatProvider::generate()`.
pub struct GenerateOptions {
    pub signal: Option<tokio::sync::watch::Receiver<bool>>,
    pub auth: Option<ProviderRequestAuth>,
    pub response_format: Option<ResponseFormat>,
    pub cache_key: Option<String>,
    pub sampling: Option<SamplingOptions>,
    pub thinking: Option<ThinkingRequestOptions>,
    pub max_completion_tokens: Option<u32>,
    pub used_context_tokens: Option<u32>,
    pub max_context_tokens: Option<u32>,
    pub on_request_start: Option<Box<dyn Fn() + Send + Sync>>,
    pub on_request_sent: Option<Box<dyn Fn() + Send + Sync>>,
    pub on_stream_end: Option<Box<dyn Fn(Option<StreamDecodeStats>) + Send + Sync>>,
    pub on_trace_id: Option<Box<dyn Fn(Option<String>) + Send + Sync>>,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            signal: None,
            auth: None,
            response_format: None,
            cache_key: None,
            sampling: None,
            thinking: None,
            max_completion_tokens: None,
            used_context_tokens: None,
            max_context_tokens: None,
            on_request_start: None,
            on_request_sent: None,
            on_stream_end: None,
            on_trace_id: None,
        }
    }
}

// ---------------------------------------------------------------------------
// StreamedMessage
// ---------------------------------------------------------------------------

/// A streaming message from a provider.
pub struct StreamedMessage {
    pub id: Option<String>,
    pub usage: Option<TokenUsage>,
    pub finish_reason: Option<FinishReason>,
    pub raw_finish_reason: Option<String>,
    pub trace_id: Option<String>,
    pub stream: Pin<Box<dyn futures_util::Stream<Item = StreamedMessagePart> + Send>>,
}

impl StreamedMessage {
    pub fn new(
        stream: Pin<Box<dyn futures_util::Stream<Item = StreamedMessagePart> + Send>>,
    ) -> Self {
        Self {
            id: None,
            usage: None,
            finish_reason: None,
            raw_finish_reason: None,
            trace_id: None,
            stream,
        }
    }

    pub fn with_id(mut self, id: String) -> Self {
        self.id = Some(id);
        self
    }

    pub fn with_usage(mut self, usage: TokenUsage) -> Self {
        self.usage = Some(usage);
        self
    }

    pub fn with_finish_reason(mut self, reason: FinishReason) -> Self {
        self.finish_reason = Some(reason);
        self
    }

    pub fn with_trace_id(mut self, id: String) -> Self {
        self.trace_id = Some(id);
        self
    }
}

impl futures_util::Stream for StreamedMessage {
    type Item = StreamedMessagePart;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.stream.as_mut().poll_next(cx)
    }
}

// ---------------------------------------------------------------------------
// ChatProvider trait
// ---------------------------------------------------------------------------

/// A constructed, immutable wire adapter.
pub trait ChatProvider: Send + Sync {
    fn name(&self) -> &str;
    fn model_name(&self) -> &str;
    fn thinking_effort(&self) -> Option<&ThinkingEffort>;
    fn max_completion_tokens(&self) -> Option<u32>;

    fn generate(
        &self,
        system_prompt: &str,
        tools: &[Tool],
        history: &[Message],
        options: &GenerateOptions,
    ) -> BoxFuture<'_, Result<StreamedMessage, ChatProviderError>>;

    fn upload_video(
        &self,
        _input: &VideoUploadInput,
        _options: &GenerateOptions,
    ) -> BoxFuture<'_, Result<super::message::VideoUrlValue, ChatProviderError>> {
        Box::pin(async {
            Err(ChatProviderError::VideoUploadUnsupported(
                "video upload not supported by this provider".to_string(),
            ))
        })
    }
}