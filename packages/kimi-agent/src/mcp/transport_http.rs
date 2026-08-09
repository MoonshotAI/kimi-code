/// MCP streamable-HTTP transport client.
///
/// Mirrors the TS `packages/agent-core/src/mcp/client-http.ts` (which wraps
/// the SDK's `StreamableHTTPClientTransport`): JSON-RPC requests are POSTed
/// to the server endpoint, and responses arrive either as plain
/// `application/json` or as a `text/event-stream` carrying `message` events —
/// both are handled.
///
/// Protocol negotiation (2026-07-28): `connect` first probes with
/// `server/discover`; a server that supports `2026-07-28` runs stateless —
/// every request carries `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name`
/// headers plus `_meta` protocol metadata, and no session exists. Older
/// servers fail the probe (`-32601`/`-32022`, or an HTTP error with a
/// non-modern body) and the client falls back to the legacy `initialize`
/// handshake, echoing the server's `Mcp-Session-Id` on subsequent requests.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;

use crate::mcp::transport_stdio::DEFAULT_REQUEST_TIMEOUT_MS;
use crate::mcp::types::*;

/// An MCP streamable-HTTP transport client.
pub struct MCPHttpTransport {
    /// The MCP endpoint URL.
    base_url: String,
    /// Optional static bearer token.
    api_key: Option<String>,
    /// HTTP client (reused).
    client: reqwest::Client,
    /// Session id issued by the server on `initialize` (legacy mode only),
    /// echoed on every subsequent request per the old streamable-HTTP spec.
    session_id: Option<String>,
    /// Negotiated protocol revision.
    server_protocol_version: Option<String>,
    /// Negotiated protocol era; `None` until `connect` succeeds.
    mode: Option<McpProtocolMode>,
    /// Client version reported in `initialize`/`_meta`.
    client_version: String,
    /// Next JSON-RPC request id.
    next_id: AtomicU64,
    /// Per-request timeout.
    request_timeout_ms: u64,
    /// Last known tool `inputSchema`s per name (from `tools/list`), used to
    /// mirror `x-mcp-header` parameters into `Mcp-Param-*` headers.
    tools: RwLock<HashMap<String, serde_json::Value>>,
}

impl MCPHttpTransport {
    /// Create a new MCP HTTP transport. Protocol negotiation is a separate
    /// step — call `connect` before issuing requests.
    pub fn new(base_url: String, api_key: Option<String>) -> Self {
        Self {
            base_url,
            api_key,
            client: reqwest::Client::new(),
            session_id: None,
            server_protocol_version: None,
            mode: None,
            client_version: "0.0.0".to_string(),
            next_id: AtomicU64::new(1),
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            tools: RwLock::new(HashMap::new()),
        }
    }

    /// Override the client version reported in `initialize`/`_meta`.
    pub fn with_client_version(mut self, version: impl Into<String>) -> Self {
        self.client_version = version.into();
        self
    }

    /// Override the per-request timeout.
    pub fn with_request_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.request_timeout_ms = timeout_ms;
        self
    }

    /// Negotiate the protocol era: probe with `server/discover`, adopt the
    /// stateless `2026-07-28` mode when supported, otherwise fall back to the
    /// legacy `initialize` → `notifications/initialized` handshake (with
    /// `Mcp-Session-Id`). Idempotent: a second call is a no-op once
    /// negotiation succeeded.
    pub async fn connect(&mut self) -> Result<(), String> {
        if self.server_protocol_version.is_some() {
            return Ok(());
        }
        match self.try_stateless_discover().await {
            Ok(()) => {
                self.server_protocol_version = Some(MCP_PROTOCOL_VERSION.to_string());
                self.mode = Some(McpProtocolMode::Stateless2026);
                Ok(())
            }
            Err(error) if is_discover_fallback(&error) || is_http_legacy_fallback(&error) => {
                self.legacy_initialize().await.map_err(|error| {
                    if is_http_sse_like(&error) {
                        format!(
                            "{error}\nHint: this looks like a legacy HTTP+SSE server; configure the server with transport: \"sse\""
                        )
                    } else {
                        error
                    }
                })
            }
            Err(error) => Err(error),
        }
    }

    /// Probe with `server/discover`. Success requires the server to advertise
    /// `2026-07-28` in `supportedProtocolVersions`. Older servers return a
    /// JSON-RPC error (`-32601` method not found), an unsupported-version
    /// error, or an HTTP error with a non-modern body — all treated as
    /// fallback signals by `connect`.
    async fn try_stateless_discover(&mut self) -> Result<(), String> {
        let (response, _) = self.post_request("server/discover", serde_json::json!({})).await?;
        let supports = response
            .get("supportedProtocolVersions")
            .and_then(|v| v.as_array())
            .map(|versions| versions.iter().any(|v| v.as_str() == Some(MCP_PROTOCOL_VERSION)))
            .unwrap_or(false);
        if supports {
            Ok(())
        } else {
            Err(format!(
                "MCP server does not support protocol version {MCP_PROTOCOL_VERSION}"
            ))
        }
    }

    /// Perform the legacy `initialize` → `notifications/initialized`
    /// handshake. The server negotiates down to its own revision and may
    /// issue an `Mcp-Session-Id`; both are adopted for subsequent requests.
    async fn legacy_initialize(&mut self) -> Result<(), String> {
        let params = serde_json::json!({
            "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": MCP_CLIENT_NAME,
                "version": self.client_version,
            },
        });
        let (result, session_id) = self.post_request("initialize", params).await?;
        let protocol_version = result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "MCP initialize response has no protocolVersion".to_string())?
            .to_string();
        // Per the old spec the session id arrives on the initialize response;
        // adopt it before the initialized notification so the notification
        // carries it.
        self.session_id = session_id;
        self.server_protocol_version = Some(protocol_version);
        self.mode = Some(McpProtocolMode::Legacy);
        self.post_notification("notifications/initialized", serde_json::json!({}))
            .await?;
        Ok(())
    }

    /// The negotiated protocol revision; `None` until `connect` succeeds.
    pub fn server_protocol_version(&self) -> Option<&str> {
        self.server_protocol_version.as_deref()
    }

    /// The negotiated protocol era; `None` until `connect` succeeds.
    pub fn mode(&self) -> Option<McpProtocolMode> {
        self.mode
    }

    /// Call the MCP `tools/list` endpoint. Tools whose `inputSchema`
    /// violates the `x-mcp-header` constraints are excluded (spec: clients
    /// MUST reject invalid tool definitions), and the surviving schemas are
    /// cached for `Mcp-Param-*` header mirroring on `tools/call`.
    pub async fn list_tools(&self) -> Result<MCPToolsListResult, String> {
        let (response, _) = self
            .post_request("tools/list", serde_json::json!({}))
            .await?;
        let mut result: MCPToolsListResult = serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/list response: {e}"))?;
        let mut cache: HashMap<String, serde_json::Value> = HashMap::new();
        result.tools.retain(|tool| match &tool.input_schema {
            Some(schema) => match validate_x_mcp_headers(schema) {
                Ok(()) => {
                    cache.insert(tool.name.clone(), schema.clone());
                    true
                }
                Err(reason) => {
                    eprintln!(
                        "[kimi-agent] excluding MCP tool {} from tools/list: {reason}",
                        tool.name
                    );
                    false
                }
            },
            None => true,
        });
        if let Ok(mut tools) = self.tools.write() {
            *tools = cache;
        }
        Ok(result)
    }

    /// Call the MCP `tools/call` endpoint. In stateless mode the request
    /// carries `_meta` protocol metadata, `Mcp-Method`/`Mcp-Name` headers,
    /// and `Mcp-Param-*` headers mirrored from `x-mcp-header` annotations;
    /// an `input_required` result (MRTR, 2026-07-28) is resolved as follows:
    /// an empty `inputRequests` list is a retry signal and is retried once;
    /// a non-empty list asks the client for input this engine cannot gather
    /// mid-call, so it becomes a descriptive error.
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });
        let header_args = self.mcp_param_headers(name, arguments.as_ref());
        let response = match self
            .post_request_with_headers("tools/call", params, &header_args)
            .await
        {
            // A HeaderMismatch (missing/mismatched Mcp-Param-* headers) may
            // mean the tool's schema changed: refresh tools/list and retry
            // the original request once (spec client behavior).
            Err(error) if error_code_of(&error) == Some(ERROR_HEADER_MISMATCH) => {
                let _ = self.list_tools().await;
                let params = serde_json::json!({
                    "name": name,
                    "arguments": arguments,
                });
                let header_args = self.mcp_param_headers(name, arguments.as_ref());
                let (response, _) = self
                    .post_request_with_headers("tools/call", params, &header_args)
                    .await?;
                response
            }
            other => other?.0,
        };
        if result_type_of(&response) == RESULT_TYPE_INPUT_REQUIRED {
            return self.resolve_input_required(&response, name, arguments).await;
        }
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// The `Mcp-Param-*` headers for a `tools/call`, mirrored from the
    /// cached tool schema's `x-mcp-header` annotations (stateless mode only).
    fn mcp_param_headers(
        &self,
        name: &str,
        arguments: Option<&serde_json::Value>,
    ) -> Vec<(String, String)> {
        if self.mode != Some(McpProtocolMode::Stateless2026) {
            return Vec::new();
        }
        let (Some(schema), Some(args)) = (
            self.tools.read().ok().and_then(|tools| tools.get(name).cloned()),
            arguments,
        ) else {
            return Vec::new();
        };
        x_mcp_header_args(&schema, args)
    }

    /// Open a long-lived `subscriptions/listen` stream (2026-07-28 stateless
    /// mode only). The returned stream yields subscription notifications as
    /// they arrive and ends on graceful or abrupt closure.
    pub async fn start_listen(
        &self,
        notifications: &serde_json::Value,
    ) -> Result<MCPListenStream, String> {
        if self.mode != Some(McpProtocolMode::Stateless2026) {
            return Err(
                "subscriptions/listen requires the 2026-07-28 protocol (stateless mode)".to_string(),
            );
        }
        let mut params = serde_json::json!({ "notifications": notifications });
        inject_protocol_meta(&mut params, &self.client_version);
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(id),
            method: "subscriptions/listen".into(),
            params: Some(params),
        };
        // Deliberately no reqwest timeout here: `build_post`'s timeout would
        // cover the whole (endless) response body and sever the long-lived
        // stream. The request/response is a stream; the caller controls how
        // long to wait for notifications.
        let mut req = self
            .client
            .post(&self.base_url)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
            .header("Mcp-Method", "subscriptions/listen")
            .json(&serde_json::to_value(&request).map_err(|e| e.to_string())?);
        if let Some(ref api_key) = self.api_key
            && !api_key.is_empty()
        {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
        let response = req
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let brief: String = body.chars().take(500).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), brief));
        }
        let is_event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));
        if !is_event_stream {
            // A non-streaming body is a JSON-RPC error (e.g. -32601 when the
            // server does not implement listen).
            let body = response.text().await.unwrap_or_default();
            let brief: String = body.chars().take(500).collect();
            return Err(format!(
                "subscriptions/listen was not answered with an event stream: {brief}"
            ));
        }

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut stream = response.bytes_stream().eventsource();
            while let Some(event) = stream.next().await {
                let Ok(event) = event else { break };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&event.data) else {
                    continue;
                };
                // The id-matched response ends the subscription gracefully.
                if value.get("id").is_some() {
                    let _ = tx.send(ListenMessage::Closed { graceful: true });
                    return;
                }
                let Some(method) = value.get("method").and_then(|m| m.as_str()) else {
                    continue;
                };
                let params = value.get("params").cloned().unwrap_or(serde_json::json!({}));
                if tx
                    .send(ListenMessage::Notification {
                        method: method.to_string(),
                        params,
                    })
                    .is_err()
                {
                    return;
                }
            }
            let _ = tx.send(ListenMessage::Closed { graceful: false });
        });
        Ok(MCPListenStream { messages: rx, task })
    }

    /// Resolve an MRTR `input_required` result: retry once — answering
    /// auto-answerable `inputRequests` (`roots/list`) with their responses,
    /// or re-issuing verbatim when the server asked for no input (an empty
    /// `inputRequests` map, e.g. load shedding). Any request type the engine
    /// cannot answer mid-call (sampling, elicitation) surfaces a descriptive
    /// error instead of guessing.
    async fn resolve_input_required(
        &self,
        response: &serde_json::Value,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let required: MCPInputRequiredResult = serde_json::from_value(response.clone())
            .map_err(|e| format!("Failed to parse input_required result: {e}"))?;
        let mut params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });
        if let Some(state) = &required.request_state {
            params["requestState"] = serde_json::json!(state);
        }
        if !required.input_requests.is_empty() {
            match build_auto_input_responses(&required.input_requests) {
                Ok(responses) => {
                    params["inputResponses"] = responses;
                }
                Err(error) => {
                    return Err(format!(
                        "{error} — {}",
                        input_required_error(&required, false)
                    ));
                }
            }
        }
        let (retry, _) = self.post_request("tools/call", params).await?;
        if result_type_of(&retry) == RESULT_TYPE_INPUT_REQUIRED {
            let required: MCPInputRequiredResult = serde_json::from_value(retry.clone())
                .map_err(|e| format!("Failed to parse input_required result: {e}"))?;
            return Err(input_required_error(&required, true));
        }
        serde_json::from_value(retry)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// POST a JSON-RPC request and return `(result, mcp-session-id header)`.
    /// Handles both plain-JSON and SSE-framed responses. In stateless mode
    /// (or while probing `server/discover` before the mode is known) the
    /// request carries `_meta` protocol metadata and the
    /// `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers.
    async fn post_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(serde_json::Value, Option<String>), String> {
        self.post_request_with_headers(method, params, &[]).await
    }

    /// `post_request` plus extra request headers (e.g. mirrored
    /// `Mcp-Param-*` values).
    async fn post_request_with_headers(
        &self,
        method: &str,
        params: serde_json::Value,
        extra_headers: &[(String, String)],
    ) -> Result<(serde_json::Value, Option<String>), String> {
        let mut params = params;
        if self.mode == Some(McpProtocolMode::Stateless2026) || method == "server/discover" {
            // The probe is sent as a modern request: the spec requires the
            // `MCP-Protocol-Version` header to match the body's `_meta`
            // protocol version, so even before the mode is known the probe
            // must carry both.
            inject_protocol_meta(&mut params, &self.client_version);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(id),
            method: method.into(),
            params: Some(params),
        };
        let stateless_headers =
            self.mode == Some(McpProtocolMode::Stateless2026) || method == "server/discover";

        let response = self
            .build_post(
                method,
                &serde_json::to_value(&request).map_err(|e| e.to_string())?,
                stateless_headers,
                extra_headers,
            )?
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {e}"))?;

        let status = response.status();
        let session_id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let brief: String = body.chars().take(500).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), brief));
        }

        let is_event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));

        let rpc_response = if is_event_stream {
            self.read_sse_response(response, id).await?
        } else {
            let body = response
                .text()
                .await
                .map_err(|e| format!("Failed to read response body: {e}"))?;
            serde_json::from_str::<MCPJsonRpcResponse>(&body)
                .map_err(|e| format!("Failed to parse JSON-RPC response: {e}"))?
        };

        if let Some(error) = rpc_response.error {
            return Err(format!("MCP error [{}]: {}", error.code, error.message));
        }
        let result = rpc_response
            .result
            .ok_or_else(|| "MCP response has no result".to_string())?;
        Ok((result, session_id))
    }

    /// Drain a `text/event-stream` response until the message matching `id`
    /// arrives; notifications and unrelated messages are skipped.
    async fn read_sse_response(
        &self,
        response: reqwest::Response,
        id: u64,
    ) -> Result<MCPJsonRpcResponse, String> {
        let mut stream = response.bytes_stream().eventsource();
        while let Some(event) = stream.next().await {
            let event = event.map_err(|e| format!("MCP sse decode error: {e}"))?;
            let value: serde_json::Value = match serde_json::from_str(&event.data) {
                Ok(v) => v,
                // Tolerate keep-alive / non-JSON payloads.
                Err(_) => continue,
            };
            // Server → client requests and notifications are not handled at
            // this layer; only the response to our request ends the read.
            if value.get("method").is_some() {
                continue;
            }
            if value.get("id").map(|v| v == &serde_json::json!(id)) != Some(true) {
                continue;
            }
            return serde_json::from_value(value)
                .map_err(|e| format!("Failed to parse JSON-RPC response: {e}"));
        }
        Err("MCP event stream ended without a response".to_string())
    }

    /// POST a JSON-RPC notification; any 2xx (typically 202) is success.
    async fn post_notification(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), String> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let response = self
            .build_post(method, &notification, false, &[])?
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let brief: String = body.chars().take(500).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), brief));
        }
        Ok(())
    }

    /// Build the POST request. In stateless mode the request carries the
    /// mirrored headers the 2026-07-28 revision requires: `MCP-Protocol-Version`
    /// (matching the body's `_meta`), `Mcp-Method`, and — for `tools/call`,
    /// `resources/read`, `prompts/get` — `Mcp-Name` taken from the body's
    /// `params.name`/`params.uri`. `extra_headers` (mirrored `Mcp-Param-*`
    /// values) are appended in stateless mode. In legacy mode the negotiated
    /// session id and protocol version ride along.
    fn build_post(
        &self,
        method: &str,
        body: &serde_json::Value,
        stateless: bool,
        extra_headers: &[(String, String)],
    ) -> Result<reqwest::RequestBuilder, String> {
        let mut req = self
            .client
            .post(&self.base_url)
            .timeout(std::time::Duration::from_millis(self.request_timeout_ms))
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(body);
        if let Some(ref api_key) = self.api_key
            && !api_key.is_empty()
        {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
        if stateless {
            req = req.header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
            req = req.header("Mcp-Method", method);
            if let Some(name) = mcp_name_for(method, body) {
                req = req.header("Mcp-Name", name);
            }
            for (name, value) in extra_headers {
                req = req.header(name, value);
            }
        } else {
            if let Some(ref session_id) = self.session_id {
                req = req.header("Mcp-Session-Id", session_id.clone());
            }
            if let Some(ref version) = self.server_protocol_version {
                req = req.header("MCP-Protocol-Version", version.clone());
            }
        }
        Ok(req)
    }
}

/// A message delivered on a `subscriptions/listen` stream.
#[derive(Debug, Clone)]
pub enum ListenMessage {
    /// A subscription-scoped notification (`method` + `params`).
    Notification {
        method: String,
        params: serde_json::Value,
    },
    /// The listen stream ended — gracefully (server sent the id-matched
    /// response) or abruptly (transport closed).
    Closed { graceful: bool },
}

/// A long-lived `subscriptions/listen` stream. Notifications are received
/// from a background reader task; dropping the stream aborts it.
pub struct MCPListenStream {
    messages: tokio::sync::mpsc::UnboundedReceiver<ListenMessage>,
    task: tokio::task::JoinHandle<()>,
}

impl MCPListenStream {
    /// The next notification, awaiting the stream's closure when drained.
    pub async fn next(&mut self) -> Option<ListenMessage> {
        self.messages.recv().await
    }

    /// Whether a notification was received without waiting for new ones.
    pub fn try_next(&mut self) -> Option<ListenMessage> {
        self.messages.try_recv().ok()
    }
}

impl Drop for MCPListenStream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The `Mcp-Name` header value for a request body: the `params.name`
/// (`tools/call`, `prompts/get`) or `params.uri` (`resources/read`), encoded
/// per the value-encoding rules.
fn mcp_name_for(method: &str, body: &serde_json::Value) -> Option<String> {
    if !matches!(method, "tools/call" | "resources/read" | "prompts/get") {
        return None;
    }
    body.pointer("/params/name")
        .or_else(|| body.pointer("/params/uri"))
        .and_then(|v| v.as_str())
        .map(encode_header_value)
}

/// Whether a discover-probe failure came as an HTTP error with a non-modern
/// body (a legacy-era server that rejects the modern request at the HTTP
/// layer instead of answering JSON-RPC). Modern servers answer 400 with a
/// recognizable JSON-RPC error, which `is_discover_fallback` handles.
fn is_http_legacy_fallback(error: &str) -> bool {
    error.starts_with("HTTP 400")
        || error.starts_with("HTTP 404")
        || error.starts_with("HTTP 405")
}

/// Whether an error suggests the server is a legacy HTTP+SSE endpoint
/// (POST to its GET-only URL fails with 404/405 rather than a JSON-RPC body).
fn is_http_sse_like(error: &str) -> bool {
    error.starts_with("HTTP 404") || error.starts_with("HTTP 405")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_transport_creation() {
        let transport =
            MCPHttpTransport::new("http://localhost:8080/mcp".into(), Some("sk-test".into()));
        assert_eq!(transport.base_url, "http://localhost:8080/mcp");
        assert_eq!(transport.api_key, Some("sk-test".into()));
        assert!(transport.session_id.is_none());
        assert!(transport.server_protocol_version().is_none());
    }

    #[test]
    fn test_http_transport_no_auth() {
        let transport = MCPHttpTransport::new("http://localhost:8080/mcp".into(), None);
        assert!(transport.api_key.is_none());
    }

    /// End-to-end negotiation + requests against a scripted streamable-HTTP
    /// server (Node inline): a legacy server that rejects `server/discover`
    /// with `-32601`, forcing the initialize-handshake fallback; it issues a
    /// session id on initialize, expects it echoed back, answers tools/list
    /// as SSE and tools/call as plain JSON. Skipped when `node` is
    /// unavailable.
    #[tokio::test(flavor = "multi_thread")]
    async fn legacy_server_falls_back_to_initialize_with_session() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const http = require('node:http');
const SESSION = 'sess-123';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const msg = JSON.parse(body);
    if (msg.method === 'server/discover') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: {
        code: -32601, message: 'Method not found',
      } }));
      return;
    }
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: {}, serverInfo: { name: 'scripted-http', version: '1.0.0' },
      } }));
      return;
    }
    if (req.headers['mcp-session-id'] !== SESSION) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('missing session');
      return;
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202); res.end();
    } else if (msg.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n\n');
      res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      } }) + '\n\n');
      res.end();
    } else if (msg.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'echo:' + msg.params.arguments.value }],
      } }));
    } else {
      res.writeHead(404); res.end();
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
"#;
        let mut child = std::process::Command::new("node")
            .args(["-e", script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn http server");
        // Read the bound port from the server's first stdout line.
        let port = {
            use std::io::{BufRead, BufReader};
            let stdout = child.stdout.take().expect("stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read port");
            line.trim()
                .strip_prefix("PORT=")
                .expect("PORT= line")
                .to_string()
        };

        let mut transport = MCPHttpTransport::new(format!("http://127.0.0.1:{port}/mcp"), None)
            .with_request_timeout_ms(15_000);
        let outcome = async {
            transport.connect().await?;
            if transport.mode() != Some(McpProtocolMode::Legacy) {
                return Err("expected legacy mode".to_string());
            }
            if transport.server_protocol_version() != Some(MCP_LEGACY_PROTOCOL_VERSION) {
                return Err("unexpected protocol version".to_string());
            }
            let tools = transport.list_tools().await?;
            if tools.tools.len() != 1 || tools.tools[0].name != "echo" {
                return Err("unexpected tools".to_string());
            }
            let result = transport
                .call_tool("echo", Some(serde_json::json!({ "value": "hi" })))
                .await?;
            let text = mcp_content_to_text(&result.content);
            if text != "echo:hi" {
                return Err(format!("unexpected call result: {text}"));
            }
            Ok(())
        }
        .await;
        let _ = child.kill();
        let _ = child.wait();
        outcome.expect("scripted http flow");
    }

    /// End-to-end stateless negotiation + requests against a scripted
    /// 2026-07-28 streamable-HTTP server: `server/discover` is answered, no
    /// initialize handshake happens, and every request carries the
    /// `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers plus `_meta`
    /// protocol metadata.
    #[tokio::test(flavor = "multi_thread")]
    async fn stateless_discover_negotiation_and_headers() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const http = require('node:http');
let sawInitialize = false;
let sawSessionHeader = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') { sawInitialize = true; }
    if (req.headers['mcp-session-id']) { sawSessionHeader = true; }
    if (msg.method === 'server/discover') {
      const meta = (msg.params && msg.params._meta) || {};
      const metaOk = meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'
        && !!meta['io.modelcontextprotocol/clientInfo'];
      const headerOk = req.headers['mcp-protocol-version'] === '2026-07-28';
      if (!metaOk || !headerOk) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: {
          code: -32020, message: 'Header mismatch',
        } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2026-07-28',
        capabilities: {}, serverInfo: { name: 'scripted-modern-http', version: '1.0.0' },
        supportedProtocolVersions: ['2026-07-28'],
      } }));
      return;
    }
    const expectVersion = req.headers['mcp-protocol-version'] === '2026-07-28';
    const expectMethod = req.headers['mcp-method'] === msg.method;
    const meta = (msg.params && msg.params._meta) || {};
    const expectMeta = meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
    if (!expectVersion || !expectMethod || !expectMeta || sawInitialize || sawSessionHeader) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: {
        code: -32020, message: 'Header mismatch',
      } }));
      return;
    }
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        resultType: 'complete',
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      } }));
    } else if (msg.method === 'tools/call') {
      const expectName = req.headers['mcp-name'] === msg.params.name;
      if (!expectName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: {
          code: -32020, message: 'Mcp-Name mismatch',
        } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'echo:' + msg.params.arguments.value }],
      } }));
    } else {
      res.writeHead(404); res.end();
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
"#;
        let mut child = std::process::Command::new("node")
            .args(["-e", script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn http server");
        let port = {
            use std::io::{BufRead, BufReader};
            let stdout = child.stdout.take().expect("stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read port");
            line.trim()
                .strip_prefix("PORT=")
                .expect("PORT= line")
                .to_string()
        };

        let mut transport = MCPHttpTransport::new(format!("http://127.0.0.1:{port}/mcp"), None)
            .with_request_timeout_ms(15_000);
        let outcome = async {
            transport.connect().await?;
            if transport.mode() != Some(McpProtocolMode::Stateless2026) {
                return Err("expected stateless mode".to_string());
            }
            if transport.server_protocol_version() != Some(MCP_PROTOCOL_VERSION) {
                return Err("unexpected protocol version".to_string());
            }
            let tools = transport.list_tools().await?;
            if tools.tools.len() != 1 || tools.tools[0].name != "echo" {
                return Err("unexpected tools".to_string());
            }
            let result = transport
                .call_tool("echo", Some(serde_json::json!({ "value": "hi" })))
                .await?;
            let text = mcp_content_to_text(&result.content);
            if text != "echo:hi" {
                return Err(format!("unexpected call result: {text}"));
            }
            Ok(())
        }
        .await;
        let _ = child.kill();
        let _ = child.wait();
        outcome.expect("scripted stateless http flow");
    }

    /// `subscriptions/listen` on streamable HTTP (2026-07-28): the request
    /// opens a long-lived SSE stream carrying the acknowledgment and then a
    /// `notifications/tools/list_changed`; the stream yields both and closes
    /// gracefully when the server ends it.
    #[tokio::test(flavor = "multi_thread")]
    async fn listen_stream_receives_change_notifications() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const http = require('node:http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const msg = JSON.parse(body);
    if (msg.method === 'server/discover') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2026-07-28',
        capabilities: {}, serverInfo: { name: 'scripted-listen-http', version: '1.0.0' },
        supportedProtocolVersions: ['2026-07-28'],
      } }));
      return;
    }
    if (msg.method === 'subscriptions/listen') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      const ack = { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
        params: { notifications: { toolsListChanged: true },
          _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id } } };
      res.write('event: message\ndata: ' + JSON.stringify(ack) + '\n\n');
      setTimeout(() => {
        res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed',
          params: { _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id } } }) + '\n\n');
        res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          resultType: 'complete',
          _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id },
        } }) + '\n\n');
      }, 100);
      return;
    }
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        resultType: 'complete',
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      } }));
      return;
    }
    res.writeHead(404); res.end();
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
"#;
        let mut child = std::process::Command::new("node")
            .args(["-e", script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn http server");
        let port = {
            use std::io::{BufRead, BufReader};
            let stdout = child.stdout.take().expect("stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read port");
            line.trim()
                .strip_prefix("PORT=")
                .expect("PORT= line")
                .to_string()
        };

        let mut transport = MCPHttpTransport::new(format!("http://127.0.0.1:{port}/mcp"), None)
            .with_request_timeout_ms(15_000);
        let outcome = async {
            transport.connect().await?;
            let mut stream = transport
                .start_listen(&serde_json::json!({ LISTEN_TOOLS_LIST_CHANGED: true }))
                .await?;
            // First message: the acknowledgment; then the change notification;
            // then a graceful close.
            let mut saw_changed = false;
            for _ in 0..3 {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    stream.next(),
                )
                .await
                .map_err(|_| "listen stream timed out")?
                {
                    Some(ListenMessage::Notification { method, .. }) => {
                        if method == NOTIFICATION_TOOLS_LIST_CHANGED {
                            saw_changed = true;
                        }
                    }
                    Some(ListenMessage::Closed { graceful }) => {
                        return if saw_changed && graceful {
                            Ok(())
                        } else {
                            Err(format!(
                                "closed before change notification (saw_changed={saw_changed}, graceful={graceful})"
                            ))
                        };
                    }
                    None => return Err("listen stream ended".to_string()),
                }
            }
            Err("listen stream did not close gracefully".to_string())
        }
        .await;
        let _ = child.kill();
        let _ = child.wait();
        outcome.expect("scripted listen http flow");
    }

    /// `x-mcp-header` mirroring (2026-07-28): `tools/call` carries
    /// `Mcp-Param-*` headers extracted from the tool's annotated inputSchema
    /// and the call arguments; a tool with an invalid annotation (a `number`
    /// property) is excluded from `tools/list`.
    #[tokio::test(flavor = "multi_thread")]
    async fn x_mcp_header_mirroring_and_invalid_tool_filtering() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const http = require('node:http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const msg = JSON.parse(body);
    if (msg.method === 'server/discover') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2026-07-28',
        capabilities: {}, serverInfo: { name: 'scripted-header', version: '1.0.0' },
        supportedProtocolVersions: ['2026-07-28'],
      } }));
      return;
    }
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        resultType: 'complete',
        tools: [
          { name: 'sql', description: 'Run SQL',
            inputSchema: { type: 'object', properties: {
              region: { type: 'string', 'x-mcp-header': 'Region' },
              query: { type: 'string' },
            }, required: ['region', 'query'] } },
          { name: 'bad', description: 'Invalid',
            inputSchema: { type: 'object', properties: {
              ratio: { type: 'number', 'x-mcp-header': 'Ratio' },
            } } },
        ],
      } }));
      return;
    }
    if (msg.method === 'tools/call') {
      const expected = req.headers['mcp-param-region'] === 'us-west1';
      if (!expected) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: {
          code: -32020, message: 'Missing Mcp-Param-Region',
        } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'ok:' + msg.params.arguments.query }],
      } }));
      return;
    }
    res.writeHead(404); res.end();
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
"#;
        let mut child = std::process::Command::new("node")
            .args(["-e", script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn http server");
        let port = {
            use std::io::{BufRead, BufReader};
            let stdout = child.stdout.take().expect("stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read port");
            line.trim()
                .strip_prefix("PORT=")
                .expect("PORT= line")
                .to_string()
        };

        let mut transport = MCPHttpTransport::new(format!("http://127.0.0.1:{port}/mcp"), None)
            .with_request_timeout_ms(15_000);
        let outcome = async {
            transport.connect().await?;
            let tools = transport.list_tools().await?;
            // The invalid tool (number-typed x-mcp-header) must be excluded.
            assert_eq!(tools.tools.len(), 1, "invalid tool must be filtered");
            assert_eq!(tools.tools[0].name, "sql");
            let result = transport
                .call_tool(
                    "sql",
                    Some(serde_json::json!({ "region": "us-west1", "query": "SELECT 1" })),
                )
                .await?;
            let text = mcp_content_to_text(&result.content);
            if text != "ok:SELECT 1" {
                return Err(format!("unexpected call result: {text}"));
            }
            Ok(())
        }
        .await;
        let _ = child.kill();
        let _ = child.wait();
        outcome.expect("scripted x-mcp-header http flow");
    }
}
