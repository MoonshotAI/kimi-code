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
use crate::llm::{anthropic, google_genai, openai};
use crate::rpc::types::{BoxFuture, NativeLlmConfig};
use crate::turn_loop::types::{LLMChatParams, LLMChatResponse, LLM};

/// Default `max_tokens` for the Anthropic Messages API when the host does
/// not configure one (the field is mandatory there).
const DEFAULT_ANTHROPIC_MAX_TOKENS: u32 = 8192;

/// Per-request timeout. Generous because streaming responses for long
/// completions can take minutes; the read is still bounded per-chunk by
/// the connect/idle behavior of the pool.
const REQUEST_TIMEOUT_SECS: u64 = 600;

/// Product token for the stable `User-Agent` sent on every outbound
/// request, mirroring the JS host's `kimi-code-cli/<version>` UA so
/// upstream traffic classification sees one host identity.
const USER_AGENT_PRODUCT: &str = "kimi-code-cli";

/// Environment variable naming the client identity sent as an
/// `X-Kimi-Client` header. When unset (or empty), the header is omitted.
const CLIENT_IDENTITY_ENV: &str = "KIMI_CODE_CLIENT_IDENTITY";

/// Stable client identity headers attached to every request: a
/// `kimi-code-cli/<version>` User-Agent plus, when `KIMI_CODE_CLIENT_IDENTITY`
/// is set, an `X-Kimi-Client` value. Cheap enough to recompute per request;
/// the env value is read at call time so a host identity can be injected
/// without rebuilding the transport.
fn identity_headers() -> Vec<(String, String)> {
    let mut headers = vec![(
        "User-Agent".to_string(),
        format!("{USER_AGENT_PRODUCT}/{}", env!("CARGO_PKG_VERSION")),
    )];
    if let Ok(identity) = std::env::var(CLIENT_IDENTITY_ENV) {
        let identity = identity.trim();
        if !identity.is_empty() {
            headers.push(("X-Kimi-Client".to_string(), identity.to_string()));
        }
    }
    headers
}

/// Attach a header with replace semantics. `RequestBuilder::header` appends
/// to an existing name, which would emit both a default and a user-supplied
/// value (e.g. two `User-Agent`s); merging a one-entry map replaces instead,
/// so user-supplied headers win over the identity defaults above.
fn set_header(req: reqwest::RequestBuilder, name: &str, value: &str) -> reqwest::RequestBuilder {
    let Ok(name) = reqwest::header::HeaderName::try_from(name) else {
        return req;
    };
    let Ok(value) = reqwest::header::HeaderValue::try_from(value) else {
        return req;
    };
    let mut map = reqwest::header::HeaderMap::new();
    map.insert(name, value);
    req.headers(map)
}

/// Fire-and-forget sink for streaming events (text deltas). The value is a
/// JSON event object; the receiver forwards it to the JS host transcript.
pub type EventSink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

/// An [`LLM`] implementation that talks to an OpenAI-compatible, Anthropic,
/// or Google Gemini endpoint over HTTPS with SSE streaming.
pub struct NativeHttpLlm {
    config: NativeLlmConfig,
    system_prompt: String,
    client: reqwest::Client,
    sink: Option<EventSink>,
}

/// Wire protocol family, derived from `NativeLlmConfig.protocol`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Protocol {
    OpenAi,
    Anthropic,
    Google,
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

    fn protocol(&self) -> Protocol {
        match self.config.protocol.as_str() {
            "anthropic" => Protocol::Anthropic,
            "google" | "google-genai" | "gemini" => Protocol::Google,
            _ => Protocol::OpenAi,
        }
    }

    fn endpoint(&self) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        match self.protocol() {
            Protocol::Anthropic => format!("{base}/messages"),
            Protocol::Google => format!(
                "{base}/models/{}:streamGenerateContent?alt=sse",
                self.config.model
            ),
            Protocol::OpenAi => format!("{base}/chat/completions"),
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

    fn emit_thinking(&self, thinking: &str) {
        if let Some(ref sink) = self.sink {
            sink(serde_json::json!({
                "type": "llm.delta",
                "part": { "type": "think", "think": thinking },
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
        let protocol = self.protocol();

        // Step boundary: the host mirrors these into transcript step events.
        self.emit(serde_json::json!({ "type": "llm.step.begin", "model": self.config.model }));

        let body = match protocol {
            Protocol::Anthropic => anthropic::build_request_with_options(
                &self.config.model,
                self.config.max_tokens.unwrap_or(DEFAULT_ANTHROPIC_MAX_TOKENS),
                &wire,
                &params.tools,
                true,
                self.config.reasoning_effort.as_deref(),
            ),
            Protocol::Google => {
                // Streaming is selected by the endpoint; the model lives in
                // the URL, not the body.
                google_genai::build_request(
                    &wire,
                    &params.tools,
                    self.config.max_tokens,
                    self.config.reasoning_effort.as_deref(),
                )
            }
            Protocol::OpenAi => {
                let mut b =
                    openai::build_request_with_options(&self.config.model, &wire, &params.tools, true);
                // Reasoning models: emit `reasoning_effort` when configured
                // (set at create or via `session/set_thinking`).
                if let Some(effort) = self.config.reasoning_effort.as_deref() {
                    b["reasoning_effort"] = serde_json::json!(effort);
                }
                b
            }
        };

        let mut req = self.client.post(self.endpoint()).json(&body);
        // Stable client identity first; custom_headers below may override.
        for (name, value) in identity_headers() {
            req = req.header(name, value);
        }
        match protocol {
            Protocol::Anthropic => {
                req = req
                    .header("x-api-key", &self.config.api_key)
                    .header("anthropic-version", "2023-06-01");
            }
            Protocol::Google => {
                // The Generative Language API authenticates via x-goog-api-key.
                req = req.header("x-goog-api-key", &self.config.api_key);
            }
            Protocol::OpenAi => {
                req = req.header("authorization", format!("Bearer {}", self.config.api_key));
            }
        }
        for (k, v) in &self.config.custom_headers {
            // Replace rather than append so user-supplied headers win over
            // the identity defaults (e.g. a custom `User-Agent`).
            req = set_header(req, k.as_str(), v.as_str());
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

        // Three accumulator shapes (different SSE grammars); drive whichever
        // matches the protocol over the same event stream.
        let mut openai_acc =
            (protocol == Protocol::OpenAi).then(openai::StreamAccumulator::new);
        let mut anthropic_acc =
            (protocol == Protocol::Anthropic).then(anthropic::StreamAccumulator::new);
        let mut google_acc =
            (protocol == Protocol::Google).then(google_genai::StreamAccumulator::new);

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
            } else if let Some(acc) = google_acc.as_mut() {
                acc.feed(&value)
            } else {
                None
            };
            if let Some(delta) = delta {
                match delta {
                    crate::llm::StreamDelta::Text(text) => self.emit_delta(&text),
                    crate::llm::StreamDelta::Thinking(thinking) => self.emit_thinking(&thinking),
                }
            }
        }

        let response = match (openai_acc, anthropic_acc, google_acc) {
            (Some(acc), _, _) => acc.finish(),
            (_, Some(acc), _) => acc.finish(),
            (_, _, Some(acc)) => acc.finish(),
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
        // A quota-exhausted 429 (billing/balance) can never succeed on
        // retry — fail fast instead of walking the backoff ladder.
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
        const QUOTA: &[&str] = &[
            "quota",
            "insufficient_balance",
            "billing",
            "account balance",
        ];
        let lower = error.to_lowercase();
        if lower.contains("status 429") && QUOTA.iter().any(|s| lower.contains(s)) {
            return false;
        }
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
            reasoning_effort: None,
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
    fn endpoint_builds_google_stream_url_with_model_in_path() {
        for proto in ["google", "google-genai", "gemini"] {
            let llm = NativeHttpLlm::new(
                config(proto, "https://generativelanguage.googleapis.com/v1beta/"),
                String::new(),
            );
            assert_eq!(
                llm.endpoint(),
                "https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent?alt=sse"
            );
        }
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
        // Quota-exhausted 429 fails fast instead of retrying.
        assert!(!llm.is_retryable_error(
            "llm http status 429 Too Many Requests: exceeded_current_quota_error"
        ));
        assert!(!llm.is_retryable_error(
            "llm http status 429 Too Many Requests: insufficient_quota"
        ));
        assert!(!llm.is_retryable_error(
            "llm http status 429 Too Many Requests: Quota exceeded for the account"
        ));
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

    /// Run one chat round-trip against a one-shot loopback HTTP server and
    /// return the request headers it observed. The server answers with a
    /// minimal SSE stream (`[DONE]`) so the transport drains cleanly.
    async fn capture_request_headers(cfg: NativeLlmConfig) -> HashMap<String, String> {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Read until the end of the request head.
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let head = String::from_utf8_lossy(&buf);
            let headers = head
                .lines()
                .skip(1)
                .filter_map(|line| {
                    let (k, v) = line.split_once(':')?;
                    Some((k.trim().to_ascii_lowercase(), v.trim().to_string()))
                })
                .collect::<HashMap<_, _>>();
            let body = "data: [DONE]\n\n";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            headers
        });

        // Point the client at the listener's ACTUAL port — the passed-in
        // base_url uses a literal `:0` which the OS would never route to the
        // bound listener (it is not a valid connect target), leaving
        // `handle.join()` below waiting forever.
        let mut cfg = cfg;
        cfg.base_url = format!("http://127.0.0.1:{port}/v1");

        let llm = NativeHttpLlm::new(cfg, String::new());
        let _ = llm
            .chat(LLMChatParams { messages: vec![], tools: vec![] })
            .await;
        handle.join().unwrap()
    }

    #[tokio::test]
    async fn outbound_requests_carry_kimi_code_cli_user_agent() {
        let headers = capture_request_headers(config("openai", "http://127.0.0.1:0/v1")).await;
        let ua = headers.get("user-agent").expect("User-Agent header present");
        assert!(
            ua.starts_with("kimi-code-cli/"),
            "unexpected User-Agent: {ua}"
        );
    }

    #[tokio::test]
    async fn client_identity_header_follows_env() {
        // Single test owning the env var so parallel tests cannot race it.
        // Edition 2024 marks set_var/remove_var unsafe: they are only safe
        // when no other thread is concurrently reading the variable, which
        // holds here because no other test touches KIMI_CODE_CLIENT_IDENTITY.
        unsafe {
            std::env::set_var(CLIENT_IDENTITY_ENV, "kimi-desktop/9.9");
        }
        let headers = capture_request_headers(config("anthropic", "http://127.0.0.1:0/v1")).await;
        assert_eq!(
            headers.get("x-kimi-client").map(String::as_str),
            Some("kimi-desktop/9.9"),
            "X-Kimi-Client should echo the env identity"
        );

        unsafe {
            std::env::remove_var(CLIENT_IDENTITY_ENV);
        }
        let headers = capture_request_headers(config("anthropic", "http://127.0.0.1:0/v1")).await;
        assert!(
            !headers.contains_key("x-kimi-client"),
            "X-Kimi-Client must be omitted when the env var is unset"
        );
    }

    #[tokio::test]
    async fn custom_user_agent_overrides_the_default() {
        let mut cfg = config("openai", "http://127.0.0.1:0/v1");
        cfg.custom_headers.insert("user-agent".into(), "my-agent/1.2".into());
        let headers = capture_request_headers(cfg).await;
        let ua = headers.get("user-agent").expect("User-Agent header present");
        assert_eq!(ua, "my-agent/1.2", "custom UA must replace the default, not append");
    }
}
