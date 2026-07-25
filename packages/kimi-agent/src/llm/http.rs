//! Native HTTP LLM transport — calls the provider directly from Rust with
//! SSE streaming, instead of proxying `llm_chat` back to the JS host.
//!
//! Request projection and stream accumulation live in `openai.rs` /
//! `anthropic.rs` (pure functions); this module owns the transport:
//! reqwest client, credentials, SSE decoding, and delta forwarding.

use std::sync::Arc;

use futures_util::StreamExt;
use eventsource_stream::Eventsource;

use crate::llm::wire::to_wire;
use crate::llm::{anthropic, openai};
use crate::rpc::types::{BoxFuture, NativeLlmConfig};
use crate::turn_loop::types::{LLMChatParams, LLMChatResponse, LLM};

/// Default `max_tokens` for the Anthropic Messages API when the host does
/// not configure one (the field is mandatory there).
const DEFAULT_ANTHROPIC_MAX_TOKENS: u32 = 8192;

/// Per-request timeout. Generous because streaming responses for long
/// completions can take minutes; the read is still bounded per-chunk by
/// the connect/idle behavior of the pool.
const REQUEST_TIMEOUT_SECS: u64 = 600;

/// Fire-and-forget sink for streaming events (text deltas). The value is a
/// JSON event object; the receiver forwards it to the JS host transcript.
pub type EventSink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

/// An [`LLM`] implementation that talks to an OpenAI-compatible or
/// Anthropic endpoint over HTTPS with SSE streaming.
pub struct NativeHttpLlm {
    config: NativeLlmConfig,
    system_prompt: String,
    client: reqwest::Client,
    sink: Option<EventSink>,
}

impl NativeHttpLlm {
    pub fn new(config: NativeLlmConfig, system_prompt: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self {
            config,
            system_prompt,
            client,
            sink: None,
        }
    }

    /// Attach a streaming event sink. Text deltas are forwarded to it as
    /// `{ "type": "llm.delta", "part": { "type": "text", "text": ... } }`.
    pub fn with_sink(mut self, sink: EventSink) -> Self {
        self.sink = Some(sink);
        self
    }

    fn endpoint(&self) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        match self.config.protocol.as_str() {
            "anthropic" => format!("{base}/messages"),
            _ => format!("{base}/chat/completions"),
        }
    }

    fn emit_delta(&self, text: &str) {
        if let Some(ref sink) = self.sink {
            sink(serde_json::json!({
                "type": "llm.delta",
                "part": { "type": "text", "text": text },
            }));
        }
    }

    fn emit(&self, event: serde_json::Value) {
        if let Some(ref sink) = self.sink {
            sink(event);
        }
    }

    async fn chat_impl(&self, params: LLMChatParams) -> Result<LLMChatResponse, String> {
        let wire = to_wire(&params.messages);
        let is_anthropic = self.config.protocol == "anthropic";

        // Step boundary: the host mirrors these into transcript step events.
        self.emit(serde_json::json!({ "type": "llm.step.begin", "model": self.config.model }));

        let body = if is_anthropic {
            anthropic::build_request_with_options(
                &self.config.model,
                self.config.max_tokens.unwrap_or(DEFAULT_ANTHROPIC_MAX_TOKENS),
                &wire,
                &params.tools,
                true,
            )
        } else {
            openai::build_request_with_options(&self.config.model, &wire, &params.tools, true)
        };

        let mut req = self.client.post(self.endpoint()).json(&body);
        if is_anthropic {
            req = req
                .header("x-api-key", &self.config.api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
            req = req.header("authorization", format!("Bearer {}", self.config.api_key));
        }
        for (k, v) in &self.config.custom_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let response = req
            .send()
            .await
            .map_err(|e| format!("llm http request failed: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let brief: String = body.chars().take(500).collect();
            return Err(format!("llm http status {status}: {brief}"));
        }

        // Two accumulator shapes (different SSE grammars); drive whichever
        // matches the protocol over the same event stream.
        let mut openai_acc = (!is_anthropic).then(openai::StreamAccumulator::new);
        let mut anthropic_acc = is_anthropic.then(anthropic::StreamAccumulator::new);

        let mut stream = response.bytes_stream().eventsource();
        while let Some(event) = stream.next().await {
            let event = event.map_err(|e| format!("llm sse decode error: {e}"))?;
            if event.data == "[DONE]" {
                break;
            }
            let value: serde_json::Value = match serde_json::from_str(&event.data) {
                Ok(v) => v,
                // Tolerate non-JSON keep-alive payloads.
                Err(_) => continue,
            };
            let delta = if let Some(acc) = openai_acc.as_mut() {
                acc.feed(&value)
            } else if let Some(acc) = anthropic_acc.as_mut() {
                acc.feed(&value)
            } else {
                None
            };
            if let Some(text) = delta {
                self.emit_delta(&text);
            }
        }

        let response = match (openai_acc, anthropic_acc) {
            (Some(acc), _) => acc.finish(),
            (_, Some(acc)) => acc.finish(),
            _ => unreachable!("one accumulator is always constructed"),
        };

        // Report the finished step (content + tool calls + usage) so the
        // host can record the assistant message without owning the call.
        self.emit(serde_json::json!({
            "type": "llm.step.end",
            "content": response.content,
            "tool_calls": response.tool_calls.iter().map(|tc| serde_json::json!({
                "id": tc.id,
                "name": tc.name,
                "arguments": tc.arguments,
            })).collect::<Vec<_>>(),
            "finish_reason": response.finish_reason,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.total_tokens,
            },
        }));

        Ok(response)
    }
}

impl LLM for NativeHttpLlm {
    fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    fn model_name(&self) -> &str {
        &self.config.model
    }

    fn is_retryable_error(&self, error: &str) -> bool {
        // Transport-level and throttling/server errors are retryable;
        // auth and request-shape errors are not.
        const RETRYABLE: &[&str] = &[
            "status 429",
            "status 500",
            "status 502",
            "status 503",
            "status 504",
            "status 529",
            "overloaded",
            "timed out",
            "timeout",
            "connect",
            "connection",
            "sse decode error",
        ];
        let lower = error.to_lowercase();
        RETRYABLE.iter().any(|s| lower.contains(s))
    }

    fn chat(
        &self,
        params: LLMChatParams,
    ) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
        Box::pin(async move {
            self.chat_impl(params)
                .await
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                    Box::new(std::io::Error::new(std::io::ErrorKind::Other, e))
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(protocol: &str, base_url: &str) -> NativeLlmConfig {
        NativeLlmConfig {
            protocol: protocol.into(),
            base_url: base_url.into(),
            api_key: "test-key".into(),
            model: "test-model".into(),
            max_tokens: None,
            custom_headers: HashMap::new(),
        }
    }

    #[test]
    fn endpoint_joins_openai_and_anthropic_paths() {
        let llm = NativeHttpLlm::new(config("openai", "https://api.example.com/v1/"), String::new());
        assert_eq!(llm.endpoint(), "https://api.example.com/v1/chat/completions");

        let llm = NativeHttpLlm::new(config("anthropic", "https://api.example.com/v1"), String::new());
        assert_eq!(llm.endpoint(), "https://api.example.com/v1/messages");
    }

    #[test]
    fn retryable_error_classification() {
        let llm = NativeHttpLlm::new(config("openai", "https://api.example.com/v1"), String::new());
        assert!(llm.is_retryable_error("llm http status 429 Too Many Requests: slow down"));
        assert!(llm.is_retryable_error("llm http status 503 Service Unavailable: busy"));
        assert!(llm.is_retryable_error("llm http request failed: connection reset"));
        assert!(llm.is_retryable_error("operation timed out"));
        assert!(!llm.is_retryable_error("llm http status 401 Unauthorized: bad key"));
        assert!(!llm.is_retryable_error("llm http status 400 Bad Request: invalid schema"));
    }

    #[test]
    fn model_name_and_system_prompt_come_from_config() {
        let llm = NativeHttpLlm::new(config("openai", "https://api.example.com/v1"), "sys".into());
        assert_eq!(llm.model_name(), "test-model");
        assert_eq!(llm.system_prompt(), "sys");
    }

    #[tokio::test]
    async fn chat_fails_cleanly_on_unreachable_endpoint() {
        // Port 1 on loopback is essentially never listening — the connect
        // is refused immediately without reaching any real server.
        let mut cfg = config("openai", "http://127.0.0.1:1/v1");
        cfg.custom_headers.insert("x-test".into(), "1".into());
        let llm = NativeHttpLlm::new(cfg, String::new());
        let result = llm
            .chat(LLMChatParams { messages: vec![], tools: vec![] })
            .await;
        assert!(result.is_err());
        let msg = result.err().unwrap().to_string();
        assert!(msg.contains("llm http request failed"), "unexpected error: {msg}");
    }
}
