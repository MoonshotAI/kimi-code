/// MCP legacy HTTP+SSE transport client.
///
/// Mirrors the TS `packages/agent-core/src/mcp/client-sse.ts` (which wraps
/// the SDK's deprecated `SSEClientTransport`). Exists for compatibility with
/// older MCP servers; new remote servers should prefer streamable HTTP.
///
/// Protocol: a GET to the server URL opens a long-lived `text/event-stream`.
/// The server's first `endpoint` event names the POST endpoint; JSON-RPC
/// requests are POSTed there (the server answers 202), and responses arrive
/// as `message` events over the open SSE stream, matched by id. The SDK's
/// same-origin check on the endpoint is ported — a server cannot redirect
/// POSTs (carrying the bearer token) to another origin.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;

use crate::mcp::transport_stdio::DEFAULT_REQUEST_TIMEOUT_MS;
use crate::mcp::types::*;

/// Options for connecting an MCP SSE server.
#[derive(Debug, Clone, Default)]
pub struct SseConnectOptions {
    /// Static bearer token for the `Authorization` header.
    pub api_key: Option<String>,
    /// Client version reported in `initialize`.
    pub client_version: Option<String>,
    /// Timeout for the endpoint event, `initialize`, and `tools/list`.
    pub startup_timeout_ms: Option<u64>,
    /// Timeout for `tools/call`.
    pub tool_call_timeout_ms: Option<u64>,
}

/// An MCP legacy HTTP+SSE transport client.
pub struct MCPSseTransport {
    client: reqwest::Client,
    /// POST endpoint announced by the server's `endpoint` event.
    endpoint: String,
    api_key: Option<String>,
    /// Messages parsed off the SSE stream by the reader task.
    messages: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    /// The reader task; aborted on drop so the stream closes with us.
    reader: tokio::task::JoinHandle<()>,
    next_id: AtomicU64,
    startup_timeout_ms: u64,
    tool_call_timeout_ms: u64,
    server_protocol_version: Option<String>,
}

impl MCPSseTransport {
    /// Open the SSE stream, resolve the POST endpoint, and perform the MCP
    /// `initialize` → `notifications/initialized` handshake.
    pub async fn connect(url: &str, options: SseConnectOptions) -> Result<Self, String> {
        let startup_timeout_ms = options
            .startup_timeout_ms
            .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
        let client = reqwest::Client::new();

        let mut request = client
            .get(url)
            .header(reqwest::header::ACCEPT, "text/event-stream");
        if let Some(ref api_key) = options.api_key
            && !api_key.is_empty()
        {
            request = request.header("Authorization", format!("Bearer {api_key}"));
        }
        // No reqwest timeout here: it would cover the whole (endless) body.
        // The connect phases below carry their own deadlines instead.
        let response =
            tokio::time::timeout(Duration::from_millis(startup_timeout_ms), request.send())
                .await
                .map_err(|_| format!("MCP SSE connect timed out after {startup_timeout_ms}ms"))?
                .map_err(|e| format!("MCP SSE connect failed: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let brief: String = body.chars().take(500).collect();
            return Err(format!("HTTP {}: {}", status.as_u16(), brief));
        }

        // Reader task: the first `endpoint` event resolves the POST target;
        // every `message` event feeds the response channel.
        let (endpoint_tx, endpoint_rx) = tokio::sync::oneshot::channel::<String>();
        let (message_tx, message_rx) = tokio::sync::mpsc::unbounded_channel();
        let reader = tokio::spawn(async move {
            let mut endpoint_tx = Some(endpoint_tx);
            let mut stream = response.bytes_stream().eventsource();
            while let Some(event) = stream.next().await {
                let Ok(event) = event else { break };
                if event.event == "endpoint" {
                    if let Some(tx) = endpoint_tx.take() {
                        let _ = tx.send(event.data);
                    }
                    continue;
                }
                // Default SSE event type is "message"; tolerate both.
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&event.data)
                    && message_tx.send(value).is_err()
                {
                    break;
                }
            }
        });

        let endpoint_data =
            tokio::time::timeout(Duration::from_millis(startup_timeout_ms), endpoint_rx)
                .await
                .map_err(|_| {
                    format!("MCP SSE endpoint event timed out after {startup_timeout_ms}ms")
                })
                .and_then(|received| {
                    received
                        .map_err(|_| "MCP SSE stream closed before the endpoint event".to_string())
                });
        let endpoint_data = match endpoint_data {
            Ok(data) => data,
            Err(error) => {
                reader.abort();
                return Err(error);
            }
        };
        let endpoint = match resolve_endpoint(url, &endpoint_data) {
            Ok(endpoint) => endpoint,
            Err(error) => {
                reader.abort();
                return Err(error);
            }
        };

        let mut transport = Self {
            client,
            endpoint,
            api_key: options.api_key,
            messages: message_rx,
            reader,
            next_id: AtomicU64::new(1),
            startup_timeout_ms,
            tool_call_timeout_ms: options
                .tool_call_timeout_ms
                .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS),
            server_protocol_version: None,
        };

        let params = serde_json::json!({
            "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": MCP_CLIENT_NAME,
                "version": options.client_version.unwrap_or_else(|| "0.0.0".to_string()),
            },
        });
        let result = transport
            .request("initialize", params, startup_timeout_ms)
            .await?;
        let protocol_version = result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "MCP initialize response has no protocolVersion".to_string())?
            .to_string();
        transport
            .notify("notifications/initialized", serde_json::json!({}))
            .await?;
        transport.server_protocol_version = Some(protocol_version);
        Ok(transport)
    }

    /// The protocol revision the server answered `initialize` with.
    pub fn server_protocol_version(&self) -> Option<&str> {
        self.server_protocol_version.as_deref()
    }

    /// Call the MCP `tools/list` endpoint.
    pub async fn list_tools(&mut self) -> Result<MCPToolsListResult, String> {
        let timeout = self.startup_timeout_ms;
        let response = self
            .request("tools/list", serde_json::json!({}), timeout)
            .await?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/list response: {e}"))
    }

    /// Call the MCP `tools/call` endpoint.
    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });
        let timeout = self.tool_call_timeout_ms;
        let response = self.request("tools/call", params, timeout).await?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// POST a request, then await the id-matching message off the SSE stream.
    async fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(id),
            method: method.into(),
            params: Some(params),
        };
        self.post(&serde_json::to_value(&request).map_err(|e| e.to_string())?)
            .await?;

        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let message = tokio::time::timeout_at(deadline, self.messages.recv())
                .await
                .map_err(|_| format!("MCP request '{method}' timed out after {timeout_ms}ms"))?
                .ok_or_else(|| format!("MCP SSE stream closed during '{method}'"))?;
            // Server requests/notifications are not handled at this layer.
            if message.get("method").is_some() {
                continue;
            }
            if message.get("id").map(|v| v == &serde_json::json!(id)) != Some(true) {
                continue;
            }
            let rpc_response: MCPJsonRpcResponse = serde_json::from_value(message)
                .map_err(|e| format!("Failed to parse JSON-RPC response: {e}"))?;
            if let Some(error) = rpc_response.error {
                return Err(format!("MCP error [{}]: {}", error.code, error.message));
            }
            return rpc_response
                .result
                .ok_or_else(|| "MCP response has no result".into());
        }
    }

    /// POST a notification; any 2xx (typically 202) is success.
    async fn notify(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.post(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn post(&self, body: &serde_json::Value) -> Result<(), String> {
        let mut request = self
            .client
            .post(&self.endpoint)
            .timeout(Duration::from_millis(self.startup_timeout_ms))
            .json(body);
        if let Some(ref api_key) = self.api_key
            && !api_key.is_empty()
        {
            request = request.header("Authorization", format!("Bearer {api_key}"));
        }
        let response = request
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
}

impl Drop for MCPSseTransport {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

/// `scheme://host[:port]` of a URL, lowercased scheme/host.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    Some(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase()
    ))
}

/// Resolve the `endpoint` event's URI against the SSE URL, enforcing the
/// SDK's same-origin check: the endpoint must share the SSE URL's origin so
/// a compromised server cannot bounce authenticated POSTs elsewhere.
fn resolve_endpoint(base: &str, data: &str) -> Result<String, String> {
    let base_origin = origin_of(base).ok_or_else(|| format!("Invalid MCP SSE base URL: {base}"))?;
    let resolved = if data.contains("://") {
        data.to_string()
    } else if let Some(path) = data.strip_prefix('/') {
        format!("{base_origin}/{path}")
    } else {
        // Relative: resolve against the base URL's directory.
        let without_query = base.split(['?', '#']).next().unwrap_or(base);
        let directory = match without_query[base_origin.len()..].rfind('/') {
            Some(last_slash) => &without_query[..base_origin.len() + last_slash],
            None => &without_query[..base_origin.len()],
        };
        format!("{directory}/{data}")
    };
    let resolved_origin =
        origin_of(&resolved).ok_or_else(|| format!("Invalid MCP SSE endpoint: {data}"))?;
    if resolved_origin != base_origin {
        return Err(format!(
            "MCP SSE endpoint origin {resolved_origin} does not match the server origin {base_origin}"
        ));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_extraction() {
        assert_eq!(
            origin_of("https://Example.com:8443/a/b?c").as_deref(),
            Some("https://example.com:8443")
        );
        assert_eq!(origin_of("http://h/x").as_deref(), Some("http://h"));
        assert!(origin_of("not-a-url").is_none());
    }

    #[test]
    fn endpoint_resolution_and_same_origin_check() {
        let base = "https://mcp.example.com/v1/sse?key=1";
        assert_eq!(
            resolve_endpoint(base, "/messages?session=abc").unwrap(),
            "https://mcp.example.com/messages?session=abc"
        );
        assert_eq!(
            resolve_endpoint(base, "messages").unwrap(),
            "https://mcp.example.com/v1/messages"
        );
        assert_eq!(
            resolve_endpoint(base, "https://mcp.example.com/direct").unwrap(),
            "https://mcp.example.com/direct"
        );
        let cross = resolve_endpoint(base, "https://evil.example.net/messages");
        assert!(cross.is_err(), "cross-origin endpoint must be rejected");
    }

    /// End-to-end legacy HTTP+SSE flow against a scripted Node server:
    /// endpoint event, 202-answered POSTs, responses over the SSE stream.
    /// Skipped when `node` is unavailable.
    #[tokio::test(flavor = "multi_thread")]
    async fn handshake_and_tool_calls_against_scripted_sse_server() {
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
let sse = null;
const send = (msg) => sse.write('event: message\ndata: ' + JSON.stringify(msg) + '\n\n');
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    sse = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: endpoint\ndata: /messages?session=abc\n\n');
    return;
  }
  if (!req.url.startsWith('/messages')) { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(202); res.end();
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: {}, serverInfo: { name: 'scripted-sse', version: '1.0.0' },
      } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
      send({ jsonrpc: '2.0', id: msg.id, result: {
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      } });
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'echo:' + msg.params.arguments.value }],
      } });
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
            .expect("spawn sse server");
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

        let outcome = async {
            let mut transport = MCPSseTransport::connect(
                &format!("http://127.0.0.1:{port}/v1/sse"),
                SseConnectOptions {
                    startup_timeout_ms: Some(15_000),
                    tool_call_timeout_ms: Some(15_000),
                    ..Default::default()
                },
            )
            .await?;
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
        outcome.expect("scripted sse flow");
    }
}
