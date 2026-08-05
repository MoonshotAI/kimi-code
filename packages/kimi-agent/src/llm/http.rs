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

/// Text deltas below this cumulative length are coalesced into a single
/// `llm.delta` event before being forwarded to the host.
const TEXT_COALESCE_MAX_CHARS: usize = 64;

/// Streaming stall budget: when no SSE event arrives within this window,
/// pending coalesced text is flushed so trickle streams keep rendering.
/// Also bounds the coalesce latency for slow producers.
const TEXT_COALESCE_IDLE: std::time::Duration = std::time::Duration::from_millis(8);

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

/// Net prompt tokens for the host's `inputOther` accounting.
///
/// OpenAI/Moonshot `prompt_tokens` and Gemini `promptTokenCount` already
/// include the cached portion; Anthropic `input_tokens` does not (it reports
/// cache reads separately). kosong parity (`openai-common.ts` extractUsage):
/// `inputOther = max(prompt - cached, 0)` — without the subtraction a cache
/// hit would be billed twice.
fn net_input_other(protocol: Protocol, input_tokens: u32, cache_read: u32) -> u32 {
    match protocol {
        Protocol::Anthropic => input_tokens,
        _ => input_tokens.saturating_sub(cache_read),
    }
}

/// Process-wide HTTP client shared by every `NativeHttpLlm` instance.
///
/// A `reqwest::Client` owns a connection pool keyed by (host, port, scheme,
/// TLS config). Building a fresh client per instance — as this transport used
/// to — discarded the pool on every turn, forcing a new TCP + TLS + DNS round
/// on each LLM call. Sharing one client keeps provider connections warm across
/// turns and sessions. The timeouts mirror the old per-instance configuration.
static SHARED_LLM_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn shared_llm_client() -> &'static reqwest::Client {
    SHARED_LLM_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

impl NativeHttpLlm {
    pub fn new(config: NativeLlmConfig, system_prompt: String) -> Self {
        Self {
            config,
            system_prompt,
            // Clone of the shared client — reqwest clients are `Arc` inside,
            // so cloning is cheap and every clone draws from the same pool.
            client: shared_llm_client().clone(),
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
                self.config.session_id.as_deref(),
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
                let mut b = openai::build_request_with_options(
                    &self.config.model,
                    &wire,
                    &params.tools,
                    true,
                );
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
        // Coalesce consecutive text deltas into fewer, larger `llm.delta`
        // events: providers stream text as many tiny chunks, and forwarding
        // each one individually multiplies the host-side event volume. Text
        // is flushed when it reaches TEXT_COALESCE_MAX_CHARS, when a thinking
        // delta interrupts the text run, when the stream stalls past
        // TEXT_COALESCE_IDLE_MS (trickle streams stay responsive), or at
        // stream end.
        let mut text_buf = String::new();
        let mut last_text_flush = std::time::Instant::now();
        loop {
            if !text_buf.is_empty() && last_text_flush.elapsed() >= TEXT_COALESCE_IDLE {
                self.emit_delta(&text_buf);
                text_buf.clear();
                last_text_flush = std::time::Instant::now();
            }

            match tokio::time::timeout(TEXT_COALESCE_IDLE, stream.next()).await {
                Ok(Some(Ok(event))) => {
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
                            crate::llm::StreamDelta::Text(text) => {
                                text_buf.push_str(&text);
                                if text_buf.len() >= TEXT_COALESCE_MAX_CHARS {
                                    self.emit_delta(&text_buf);
                                    text_buf.clear();
                                    last_text_flush = std::time::Instant::now();
                                }
                            }
                            crate::llm::StreamDelta::Thinking(thinking) => {
                                // Channel switch — flush pending text first so
                                // stream ordering is preserved, then surface
                                // the thinking delta immediately.
                                if !text_buf.is_empty() {
                                    self.emit_delta(&text_buf);
                                    text_buf.clear();
                                }
                                last_text_flush = std::time::Instant::now();
                                self.emit_thinking(&thinking);
                            }
                        }
                    }
                }
                Ok(Some(Err(e))) => {
                    if !text_buf.is_empty() {
                        self.emit_delta(&text_buf);
                        text_buf.clear();
                    }
                    return Err(format!("llm sse decode error: {e}"));
                }
                Ok(None) => break,
                Err(_elapsed) => {
                    // Idle read: nothing arrived within the coalesce budget.
                    // Flush pending text NOW so trickle/stalled streams keep
                    // rendering (the earlier "top of loop flushes next pass"
                    // was dead — resetting the timer there suppressed it).
                    if !text_buf.is_empty() {
                        self.emit_delta(&text_buf);
                        text_buf.clear();
                    }
                    last_text_flush = std::time::Instant::now();
                }
            }
        }
        if !text_buf.is_empty() {
            self.emit_delta(&text_buf);
        }

        let (cache_read, cache_creation) = match (
            openai_acc.as_ref(),
            anthropic_acc.as_ref(),
            google_acc.as_ref(),
        ) {
            (Some(acc), _, _) => (acc.cache_read, acc.cache_creation),
            (_, Some(acc), _) => (acc.cache_read, acc.cache_creation),
            (_, _, Some(acc)) => (acc.cache_read, acc.cache_creation),
            _ => (0, 0),
        };
        let response = match (openai_acc, anthropic_acc, google_acc) {
            (Some(acc), _, _) => acc.finish(),
            (_, Some(acc), _) => acc.finish(),
            (_, _, Some(acc)) => acc.finish(),
            _ => unreachable!("one accumulator is always constructed"),
        };

        // Prompt token counts from OpenAI/Moonshot (`prompt_tokens`) and
        // Gemini (`promptTokenCount`) INCLUDE the cached portion. The host
        // maps them to `inputOther`, which must exclude cache reads (kosong
        // `extractUsage` parity); reporting the gross count would double-count
        // cache hits. Anthropic's `input_tokens` already excludes cache reads.
        let input_other = net_input_other(protocol, response.usage.input_tokens, cache_read);

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
                "input_tokens": input_other,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.total_tokens,
            },
            // Cache accounting rides as top-level event fields: the wire
            // `TokenUsage` carries no cache counts, and the host maps these
            // into `inputCacheRead` / `inputCacheCreation`.
            "input_cache_read": cache_read,
            "input_cache_creation": cache_creation,
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
            session_id: None,
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
    fn net_input_other_excludes_cache_for_openai_and_google() {
        // OpenAI/Moonshot: prompt_tokens includes cached → net subtracts.
        assert_eq!(net_input_other(Protocol::OpenAi, 100, 90), 10);
        assert_eq!(net_input_other(Protocol::OpenAi, 100, 100), 0);
        assert_eq!(net_input_other(Protocol::Google, 100, 90), 10);
        // No cache reported → gross unchanged.
        assert_eq!(net_input_other(Protocol::OpenAi, 100, 0), 100);
        // Anthropic: input_tokens already excludes cache reads → gross.
        assert_eq!(net_input_other(Protocol::Anthropic, 100, 90), 100);
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

    /// Streaming OpenAI-style SSE chunks are forwarded to the event sink as
    /// `llm.delta` text events, and the accumulated transcript text matches.
    /// This pins the native-LLM streaming path the TUI renders from
    /// (`llm.delta` → transcript) — the host-callback path owns its own stream
    /// and never goes through `with_sink`.
    #[tokio::test]
    async fn streaming_openai_chat_emits_text_deltas() {
        use std::sync::Arc;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("accept");
            let (reader, mut writer) = sock.split();
            let mut lines = tokio::io::BufReader::new(reader).lines();
            // Drain request headers up to the blank line.
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    break;
                }
            }
            writer
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n")
                .await
                .expect("status");
            writer
                .write_all(
                    b"data: {\"id\":\"1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello \"},\"finish_reason\":null}]}\n\n\
                      data: {\"id\":\"2\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"world\"},\"finish_reason\":null}]}\n\n\
                      data: {\"id\":\"3\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
                      data: [DONE]\n\n",
                )
                .await
                .expect("body");
            writer.flush().await.expect("flush");
        });

        let deltas: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_deltas = deltas.clone();
        let llm = NativeHttpLlm::new(
            config("openai", &format!("http://{addr}/v1")),
            String::new(),
        )
        .with_sink(Arc::new(move |event: serde_json::Value| {
            if event["type"] == "llm.delta" {
                sink_deltas.lock().unwrap_or_else(|e| e.into_inner()).push(event);
            }
        }));

        let response = llm
            .chat_impl(LLMChatParams {
                messages: vec![crate::turn_loop::types::LLMMessage {
                    role: "user".into(),
                    content: "hi".into(),
                    ..Default::default()
                }],
                tools: vec![],
            })
            .await
            .expect("chat");

        assert_eq!(response.content, "hello world", "accumulated text");
        let _ = server.await;

        // Coalescing may merge the two chunks into one event, so assert on the
        // concatenated delta text rather than the event count.
        let deltas = deltas.lock().unwrap_or_else(|e| e.into_inner());
        assert!(!deltas.is_empty(), "expected llm.delta events");
        let text: String = deltas
            .iter()
            .filter_map(|e| e["part"]["text"].as_str())
            .collect();
        assert_eq!(text, "hello world", "delta text: {text}");
        assert!(
            deltas.iter().all(|e| e["part"]["type"] == "text"),
            "deltas are text parts: {deltas:?}"
        );
    }
}
