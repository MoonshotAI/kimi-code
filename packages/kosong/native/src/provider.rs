//! Provider trait and shared types.
//! Mirrors `packages/kosong/src/provider.ts`.

use napi_derive::napi;

/// Thinking effort levels.
#[napi]
pub enum ThinkingEffort {
    Off,
    On,
    Low,
    Medium,
    High,
}

/// Finish reason for a generation.
#[napi]
pub enum FinishReason {
    Completed,
    ToolCalls,
    Truncated,
    Filtered,
    Paused,
    Other,
}

/// Response format constraint.
#[napi(object)]
pub struct ResponseFormat {
    pub format_type: String,
    pub json_schema: Option<String>,
}

/// Per-request authentication material.
#[napi(object)]
pub struct ProviderRequestAuth {
    pub api_key: Option<String>,
    pub bearer_token: Option<String>,
    pub headers: Option<String>, // JSON string of Record<string, string>
}

/// Options passed to a generation call.
#[napi(object)]
pub struct GenerateOptions {
    pub signal: Option<()>, // AbortSignal is not directly representable; handled via CancellationToken
    pub auth: Option<ProviderRequestAuth>,
    pub response_format: Option<ResponseFormat>,
}

/// Timing statistics for a generation.
#[napi(object)]
pub struct StreamDecodeStats {
    pub server_decode_ms: f64,
    pub client_consume_ms: f64,
}