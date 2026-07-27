/// MCP streamable-HTTP transport client.
///
/// Mirrors the TS `packages/agent-core/src/mcp/client-http.ts` (which wraps
/// the SDK's `StreamableHTTPClientTransport`): JSON-RPC requests are POSTed
/// to the server endpoint, and responses arrive either as plain
/// `application/json` or as a `text/event-stream` carrying `message` events —
/// both are handled. The `initialize` handshake captures the server's
/// `Mcp-Session-Id`, which (with the negotiated `MCP-Protocol-Version`) rides
/// on every subsequent request.
use std::sync::atomic::{AtomicU64, Ordering};

use eventsource_stream::Eventsource;
use futures_util::StreamExt;

use crate::mcp::transport_stdio::{
    DEFAULT_REQUEST_TIMEOUT_MS, MCP_CLIENT_NAME, MCP_PROTOCOL_VERSION,
};
use crate::mcp::types::*;

/// An MCP streamable-HTTP transport client.
pub struct MCPHttpTransport {
    /// The MCP endpoint URL.
    base_url: String,
    /// Optional static bearer token.
    api_key: Option<String>,
    /// HTTP client (reused).
    client: reqwest::Client,
    /// Session id issued by the server on `initialize`, echoed on every
    /// subsequent request per the streamable-HTTP spec.
    session_id: Option<String>,
    /// Protocol revision the server answered `initialize` with.
    server_protocol_version: Option<String>,
    /// Client version reported in `initialize`.
    client_version: String,
    /// Next JSON-RPC request id.
    next_id: AtomicU64,
    /// Per-request timeout.
    request_timeout_ms: u64,
}

impl MCPHttpTransport {
    /// Create a new MCP HTTP transport. The MCP handshake is a separate
    /// step — call `connect` before issuing requests.
    pub fn new(base_url: String, api_key: Option<String>) -> Self {
        Self {
            base_url,
            api_key,
            client: reqwest::Client::new(),
            session_id: None,
            server_protocol_version: None,
            client_version: "0.0.0".to_string(),
            next_id: AtomicU64::new(1),
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
        }
    }

    /// Override the client version reported in `initialize`.
    pub fn with_client_version(mut self, version: impl Into<String>) -> Self {
        self.client_version = version.into();
        self
    }

    /// Override the per-request timeout.
    pub fn with_request_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.request_timeout_ms = timeout_ms;
        self
    }

    /// Perform the MCP `initialize` → `notifications/initialized` handshake.
    /// Idempotent: a second call is a no-op once the handshake succeeded.
    pub async fn connect(&mut self) -> Result<(), String> {
        if self.server_protocol_version.is_some() {
            return Ok(());
        }
        let params = serde_json::json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
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
        // Per spec the session id arrives on the initialize response; adopt
        // it before the initialized notification so the notification carries
        // it.
        self.session_id = session_id;
        self.server_protocol_version = Some(protocol_version);
        self.post_notification("notifications/initialized", serde_json::json!({}))
            .await?;
        Ok(())
    }

    /// The protocol revision the server answered `initialize` with; `None`
    /// until `connect` succeeds.
    pub fn server_protocol_version(&self) -> Option<&str> {
        self.server_protocol_version.as_deref()
    }

    /// Call the MCP `tools/list` endpoint.
    pub async fn list_tools(&self) -> Result<MCPToolsListResult, String> {
        let (response, _) = self
            .post_request("tools/list", serde_json::json!({}))
            .await?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/list response: {e}"))
    }

    /// Call the MCP `tools/call` endpoint.
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });
        let (response, _) = self.post_request("tools/call", params).await?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// POST a JSON-RPC request and return `(result, mcp-session-id header)`.
    /// Handles both plain-JSON and SSE-framed responses.
    async fn post_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(serde_json::Value, Option<String>), String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(id),
            method: method.into(),
            params: Some(params),
        };

        let response = self
            .build_post(&serde_json::to_value(&request).map_err(|e| e.to_string())?)?
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
            .build_post(&notification)?
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

    fn build_post(&self, body: &serde_json::Value) -> Result<reqwest::RequestBuilder, String> {
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
        if let Some(ref session_id) = self.session_id {
            req = req.header("Mcp-Session-Id", session_id.clone());
        }
        if let Some(ref version) = self.server_protocol_version {
            req = req.header("MCP-Protocol-Version", version.clone());
        }
        Ok(req)
    }
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

    /// End-to-end handshake + requests against a scripted streamable-HTTP
    /// server (Node inline): issues a session id on initialize, expects it
    /// echoed back, answers tools/list as SSE and tools/call as plain JSON.
    /// Skipped when `node` is unavailable.
    #[tokio::test(flavor = "multi_thread")]
    async fn handshake_and_tool_calls_against_scripted_http_server() {
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
        outcome.expect("scripted http flow");
    }
}
