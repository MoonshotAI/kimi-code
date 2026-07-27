/// MCP runtime — drives real transports from the connection-state machine.
///
/// This is the I/O layer the decision core (`connection_manager.rs`)
/// deliberately does not contain: it holds each server's full launch spec,
/// spawns/connects the matching transport, reports attempt outcomes back
/// into `McpConnectionState`, and dispatches `mcp__server__tool` calls to
/// the owning connection.
///
/// TS counterpart: the orchestration half of
/// `packages/agent-core/src/mcp/connection-manager.ts` (its decision half is
/// already ported as `McpConnectionState`).
///
/// Blocking note: stdio transports are synchronous; their connect and call
/// paths run inside `tokio::task::spawn_blocking` so the async runtime is
/// never starved by a slow server.
use std::collections::HashMap;

use crate::mcp::connection_manager::{
    ConnectAttempt, McpConfigSource, McpConnectionState, McpServerConfig, McpServerEntry,
    McpTransport, format_startup_error, is_unauthorized_like,
};
use crate::mcp::tool_naming::{build_mcp_tool_name, parse_mcp_tool_name};
use crate::mcp::transport_http::MCPHttpTransport;
use crate::mcp::transport_sse::{MCPSseTransport, SseConnectOptions};
use crate::mcp::transport_stdio::{MCPStdioTransport, StdioSpawnOptions};
use crate::mcp::types::{MCPTool, MCPToolCallResult};

/// Full launch spec for one MCP server: the decision-core subset plus the
/// I/O fields the transports need.
#[derive(Debug, Clone, Default)]
pub struct McpServerSpec {
    /// Decision-core view (transport kind, filters, timeouts, url).
    pub config: McpServerConfig,
    /// Stdio: executable to spawn. Required for stdio transports.
    pub command: Option<String>,
    /// Stdio: arguments.
    pub args: Vec<String>,
    /// Stdio: extra env from the server config (always wins, never filtered).
    pub env: Option<HashMap<String, String>>,
    /// Stdio: working directory; relative paths resolve against the
    /// runtime's `default_cwd`.
    pub cwd: Option<String>,
    /// Remote: static bearer token, already resolved by the host from
    /// `config.bearer_token_env_var`.
    pub bearer_token: Option<String>,
}

enum McpConnection {
    Stdio(MCPStdioTransport),
    Http(MCPHttpTransport),
    Sse(MCPSseTransport),
}

/// A prefixed, callable tool surfaced by a connected server.
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolDefinition {
    /// The engine-facing name (`mcp__server__tool`).
    pub name: String,
    /// The server's own definition (unprefixed `name` inside).
    pub tool: MCPTool,
}

pub struct McpRuntime {
    state: McpConnectionState,
    specs: HashMap<String, McpServerSpec>,
    connections: HashMap<String, McpConnection>,
    /// Discovered tool definitions per connected server (unfiltered; the
    /// enabled set lives in the state machine).
    discovered: HashMap<String, Vec<MCPTool>>,
    default_cwd: Option<String>,
    client_version: Option<String>,
}

impl McpRuntime {
    pub fn new(
        oauth_available: bool,
        default_cwd: Option<String>,
        client_version: Option<String>,
    ) -> Self {
        Self {
            state: McpConnectionState::new(oauth_available),
            specs: HashMap::new(),
            connections: HashMap::new(),
            discovered: HashMap::new(),
            default_cwd,
            client_version,
        }
    }

    /// Register a server and, unless it is disabled or held for approval,
    /// connect it now. Returns the resulting public entry.
    pub async fn register(
        &mut self,
        name: &str,
        spec: McpServerSpec,
        source: McpConfigSource,
    ) -> McpServerEntry {
        let attempt = self.state.register(name, spec.config.clone(), source);
        self.specs.insert(name.to_string(), spec);
        if let Some(attempt) = attempt {
            self.run_attempt(name, attempt).await;
        }
        self.state.get(name).expect("just registered")
    }

    /// Approve a `pending-approval` server and connect it.
    pub async fn approve(&mut self, name: &str) -> Result<McpServerEntry, String> {
        if let Some(attempt) = self.state.approve_server(name)? {
            self.run_attempt(name, attempt).await;
        }
        self.state
            .get(name)
            .ok_or_else(|| format!("Unknown MCP server: {name}"))
    }

    /// Tear down any live connection and connect again.
    pub async fn reconnect(&mut self, name: &str) -> Result<McpServerEntry, String> {
        let attempt = self.state.begin_reconnect(name)?;
        self.drop_connection(name).await;
        self.run_attempt(name, attempt).await;
        self.state
            .get(name)
            .ok_or_else(|| format!("Unknown MCP server: {name}"))
    }

    /// Remove a server entirely, closing its connection.
    pub async fn remove(&mut self, name: &str) -> bool {
        self.drop_connection(name).await;
        self.specs.remove(name);
        self.discovered.remove(name);
        self.state.remove(name)
    }

    /// Public per-server views, sorted by name.
    pub fn list(&self) -> Vec<McpServerEntry> {
        self.state.list()
    }

    pub fn get(&self, name: &str) -> Option<McpServerEntry> {
        self.state.get(name)
    }

    /// All enabled tools across connected servers, with engine-facing
    /// `mcp__server__tool` names.
    pub fn tool_definitions(&self) -> Vec<McpToolDefinition> {
        let mut definitions = Vec::new();
        for (server, tools) in &self.discovered {
            let Some(enabled) = self.state.enabled_tool_names(server) else {
                continue;
            };
            for tool in tools {
                if enabled.contains(&tool.name) {
                    definitions.push(McpToolDefinition {
                        name: build_mcp_tool_name(server, &tool.name),
                        tool: tool.clone(),
                    });
                }
            }
        }
        definitions.sort_by(|a, b| a.name.cmp(&b.name));
        definitions
    }

    /// Dispatch an `mcp__server__tool` call to the owning connection.
    pub async fn call_tool(
        &mut self,
        prefixed_name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let (server, tool) = parse_mcp_tool_name(prefixed_name)
            .ok_or_else(|| format!("Not an MCP tool name: {prefixed_name}"))?;
        let enabled = self
            .state
            .enabled_tool_names(server)
            .ok_or_else(|| format!("MCP server is not connected: {server}"))?;
        if !enabled.contains(tool) {
            return Err(format!("MCP tool is not enabled: {prefixed_name}"));
        }
        let server = server.to_string();
        let tool = tool.to_string();
        match self.connections.remove(&server) {
            Some(McpConnection::Stdio(mut transport)) => {
                // Move the transport into the blocking pool for the call and
                // put it back after — stdio is serial by nature, so exclusive
                // access is the correct semantics, not a limitation.
                let result = tokio::task::spawn_blocking(move || {
                    let result = transport.call_tool(&tool, arguments);
                    (transport, result)
                })
                .await;
                match result {
                    Ok((transport, call_result)) => {
                        self.connections
                            .insert(server, McpConnection::Stdio(transport));
                        call_result
                    }
                    Err(join_error) => Err(format!("MCP call panicked: {join_error}")),
                }
            }
            Some(McpConnection::Http(transport)) => {
                let call_result = transport.call_tool(&tool, arguments).await;
                self.connections
                    .insert(server, McpConnection::Http(transport));
                call_result
            }
            Some(McpConnection::Sse(mut transport)) => {
                let call_result = transport.call_tool(&tool, arguments).await;
                self.connections
                    .insert(server, McpConnection::Sse(transport));
                call_result
            }
            None => Err(format!("MCP server is not connected: {server}")),
        }
    }

    /// Run one connect attempt: spawn/connect the transport, discover tools,
    /// and report the outcome into the state machine. A stale attempt's
    /// report is discarded by the state machine; its connection is dropped.
    async fn run_attempt(&mut self, name: &str, attempt: ConnectAttempt) {
        let Some(spec) = self.specs.get(name).cloned() else {
            return;
        };
        let startup_timeout_ms = Some(self.state.startup_timeout_ms(name, None));
        let outcome = match spec.config.transport {
            McpTransport::Stdio => self.connect_stdio(&spec, startup_timeout_ms).await,
            McpTransport::Http => self.connect_http(&spec, startup_timeout_ms).await,
            McpTransport::Sse => self.connect_sse(&spec, startup_timeout_ms).await,
        };
        match outcome {
            Ok((connection, tools)) => {
                let tool_names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();
                if self.state.report_connected(name, attempt, tool_names) {
                    self.connections.insert(name.to_string(), connection);
                    self.discovered.insert(name.to_string(), tools);
                } else {
                    // Superseded by a newer attempt: close, keep the winner.
                    drop_connection_value(connection).await;
                }
            }
            Err(message) => {
                let unauthorized = is_unauthorized_like(None, None, &message);
                self.state
                    .report_failed(name, attempt, &message, unauthorized);
            }
        }
    }

    async fn connect_stdio(
        &self,
        spec: &McpServerSpec,
        startup_timeout_ms: Option<u64>,
    ) -> Result<(McpConnection, Vec<MCPTool>), String> {
        let command = spec
            .command
            .clone()
            .ok_or_else(|| "MCP stdio command must not be empty".to_string())?;
        let options = StdioSpawnOptions {
            env: spec.env.clone(),
            cwd: spec.cwd.clone(),
            default_cwd: self.default_cwd.clone(),
            client_version: self.client_version.clone(),
            startup_timeout_ms,
            tool_call_timeout_ms: spec.config.tool_timeout_ms,
        };
        let args = spec.args.clone();
        tokio::task::spawn_blocking(move || {
            let mut transport = MCPStdioTransport::spawn(&command, &args, options)?;
            if let Err(error) = transport.connect() {
                let stderr = transport.stderr_snapshot();
                return Err(format_startup_error(
                    &error,
                    (!stderr.is_empty()).then_some(stderr.as_str()),
                ));
            }
            let tools = transport.list_tools()?.tools;
            Ok((McpConnection::Stdio(transport), tools))
        })
        .await
        .map_err(|join_error| format!("MCP connect panicked: {join_error}"))?
    }

    async fn connect_http(
        &self,
        spec: &McpServerSpec,
        startup_timeout_ms: Option<u64>,
    ) -> Result<(McpConnection, Vec<MCPTool>), String> {
        let url = spec
            .config
            .url
            .clone()
            .ok_or_else(|| "MCP http server has no url".to_string())?;
        let mut transport = MCPHttpTransport::new(url, spec.bearer_token.clone());
        if let Some(version) = &self.client_version {
            transport = transport.with_client_version(version.clone());
        }
        if let Some(timeout) = startup_timeout_ms {
            transport = transport.with_request_timeout_ms(timeout);
        }
        transport.connect().await?;
        let tools = transport.list_tools().await?.tools;
        Ok((McpConnection::Http(transport), tools))
    }

    async fn connect_sse(
        &self,
        spec: &McpServerSpec,
        startup_timeout_ms: Option<u64>,
    ) -> Result<(McpConnection, Vec<MCPTool>), String> {
        let url = spec
            .config
            .url
            .clone()
            .ok_or_else(|| "MCP sse server has no url".to_string())?;
        let mut transport = MCPSseTransport::connect(
            &url,
            SseConnectOptions {
                api_key: spec.bearer_token.clone(),
                client_version: self.client_version.clone(),
                startup_timeout_ms,
                tool_call_timeout_ms: spec.config.tool_timeout_ms,
            },
        )
        .await?;
        let tools = transport.list_tools().await?.tools;
        Ok((McpConnection::Sse(transport), tools))
    }

    async fn drop_connection(&mut self, name: &str) {
        if let Some(connection) = self.connections.remove(name) {
            drop_connection_value(connection).await;
        }
        self.discovered.remove(name);
    }
}

/// Close a connection without blocking the async runtime (stdio shutdown
/// kills and waits on the child).
async fn drop_connection_value(connection: McpConnection) {
    match connection {
        McpConnection::Stdio(transport) => {
            let _ = tokio::task::spawn_blocking(move || drop(transport)).await;
        }
        McpConnection::Http(transport) => drop(transport),
        // Drop aborts the SSE reader task; nothing blocking to offload.
        McpConnection::Sse(transport) => drop(transport),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::connection_manager::McpServerStatus;
    use crate::mcp::types::mcp_content_to_text;

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok()
    }

    /// The scripted stdio MCP server used by the transport tests, with two
    /// tools so the enable-filter path is observable.
    const SCRIPTED_SERVER: &str = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: {}, serverInfo: { name: 'scripted', version: '1.0.0' },
    } }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      tools: [
        { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
        { name: 'secret', description: 'Disabled', inputSchema: { type: 'object' } },
      ],
    } }) + '\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: msg.params.name + ':' + msg.params.arguments.value }],
    } }) + '\n');
  }
});
"#;

    fn scripted_spec() -> McpServerSpec {
        McpServerSpec {
            config: McpServerConfig {
                disabled_tools: Some(vec!["secret".to_string()]),
                startup_timeout_ms: Some(15_000),
                tool_timeout_ms: Some(15_000),
                ..Default::default()
            },
            command: Some("node".to_string()),
            args: vec!["-e".to_string(), SCRIPTED_SERVER.to_string()],
            ..Default::default()
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn registers_connects_filters_and_dispatches_stdio() {
        if !node_available() {
            eprintln!("skipping: node not available");
            return;
        }
        let mut runtime = McpRuntime::new(false, None, None);
        let entry = runtime
            .register("scripted", scripted_spec(), McpConfigSource::Other)
            .await;
        assert_eq!(
            entry.status,
            McpServerStatus::Connected,
            "{:?}",
            entry.error
        );
        assert_eq!(entry.tool_count, 1, "disabled tool must not count");

        let definitions = runtime.tool_definitions();
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].name, "mcp__scripted__echo");
        assert_eq!(definitions[0].tool.name, "echo");

        let result = runtime
            .call_tool(
                "mcp__scripted__echo",
                Some(serde_json::json!({ "value": "hi" })),
            )
            .await
            .expect("call");
        assert_eq!(mcp_content_to_text(&result.content), "echo:hi");

        // The filtered tool is rejected at dispatch even though the server
        // would serve it.
        let denied = runtime
            .call_tool(
                "mcp__scripted__secret",
                Some(serde_json::json!({ "value": "x" })),
            )
            .await
            .expect_err("disabled tool must not dispatch");
        assert!(denied.contains("not enabled"), "got: {denied}");

        assert!(runtime.remove("scripted").await);
        assert!(runtime.list().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn project_root_stdio_holds_for_approval_then_connects() {
        if !node_available() {
            eprintln!("skipping: node not available");
            return;
        }
        let mut runtime = McpRuntime::new(false, None, None);
        let entry = runtime
            .register("scripted", scripted_spec(), McpConfigSource::ProjectRoot)
            .await;
        assert_eq!(entry.status, McpServerStatus::PendingApproval);
        assert!(runtime.tool_definitions().is_empty());

        let entry = runtime.approve("scripted").await.expect("approve");
        assert_eq!(
            entry.status,
            McpServerStatus::Connected,
            "{:?}",
            entry.error
        );
        assert_eq!(runtime.tool_definitions().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failed_spawn_reports_failed_with_diagnostic() {
        let mut runtime = McpRuntime::new(false, None, None);
        let spec = McpServerSpec {
            command: Some("definitely-not-a-real-binary-kimi".to_string()),
            ..Default::default()
        };
        let entry = runtime
            .register("broken", spec, McpConfigSource::Other)
            .await;
        assert_eq!(entry.status, McpServerStatus::Failed);
        assert!(entry.error.is_some());
        assert!(runtime.call_tool("mcp__broken__x", None).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unreachable_sse_server_reports_failed() {
        let mut runtime = McpRuntime::new(false, None, None);
        let spec = McpServerSpec {
            config: McpServerConfig {
                transport: McpTransport::Sse,
                // Unroutable port on loopback: fails fast, no external I/O.
                url: Some("http://127.0.0.1:1/sse".to_string()),
                startup_timeout_ms: Some(3_000),
                ..Default::default()
            },
            ..Default::default()
        };
        let entry = runtime
            .register("legacy", spec, McpConfigSource::Other)
            .await;
        assert_eq!(entry.status, McpServerStatus::Failed);
        assert!(entry.error.is_some());
    }
}
