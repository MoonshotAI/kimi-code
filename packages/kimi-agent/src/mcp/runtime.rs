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
use crate::mcp::transport_http::{ListenMessage, MCPHttpTransport};
use crate::mcp::transport_sse::{MCPSseTransport, SseConnectOptions};
use crate::mcp::transport_stdio::{MCPStdioTransport, StdioSpawnOptions};
use crate::mcp::types::{
    LISTEN_TOOLS_LIST_CHANGED, MCPTool, MCPToolCallResult, McpProtocolMode,
    NOTIFICATION_TOOLS_LIST_CHANGED,
};

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

/// Host-supplied MCP server definition on the `session/create` wire. The host
/// (TS) resolves config + secrets, then hands the engine a flat spec per
/// server. `into_registration` maps it to the runtime's `register` inputs.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct McpServerSpecInput {
    pub name: String,
    /// "stdio" | "sse" | "http". Inferred from `command`/`url` when absent.
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub enabled_tools: Option<Vec<String>>,
    #[serde(default)]
    pub disabled_tools: Option<Vec<String>>,
    /// Remote: pre-resolved static bearer token (host reads the env var).
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default)]
    pub bearer_token_env_var: Option<String>,
    #[serde(default)]
    pub startup_timeout_ms: Option<u64>,
    #[serde(default)]
    pub tool_timeout_ms: Option<u64>,
    #[serde(default)]
    pub has_headers: Option<bool>,
    /// From an untrusted `<repoRoot>/.mcp.json` (held for approval) vs a
    /// trusted host/user source (connects immediately).
    #[serde(default)]
    pub project_root: Option<bool>,
}

impl McpServerSpecInput {
    /// Resolve the wire DTO into `(name, spec, source)` for `register`.
    /// Transport falls back to inference: explicit → `command` → `url` → stdio.
    pub fn into_registration(self) -> (String, McpServerSpec, McpConfigSource) {
        let transport = match self.transport.as_deref() {
            Some("http") => McpTransport::Http,
            Some("sse") => McpTransport::Sse,
            Some("stdio") => McpTransport::Stdio,
            _ if self.url.is_some() && self.command.is_none() => McpTransport::Http,
            _ => McpTransport::Stdio,
        };
        let config = McpServerConfig {
            transport,
            enabled: self.enabled.unwrap_or(true),
            url: self.url.clone(),
            startup_timeout_ms: self.startup_timeout_ms,
            tool_timeout_ms: self.tool_timeout_ms,
            enabled_tools: self.enabled_tools,
            disabled_tools: self.disabled_tools,
            bearer_token_env_var: self.bearer_token_env_var,
            has_headers: self.has_headers.unwrap_or(false),
        };
        let spec = McpServerSpec {
            config,
            command: self.command,
            args: self.args,
            env: self.env,
            cwd: self.cwd,
            bearer_token: self.bearer_token,
        };
        let source = if self.project_root.unwrap_or(false) {
            McpConfigSource::ProjectRoot
        } else {
            McpConfigSource::Other
        };
        (self.name, spec, source)
    }
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
    /// The `ConnectAttempt` that last connected each server, retained so a
    /// `subscriptions/listen`-driven tool refresh can re-report through the
    /// same attempt (stale after a reconnect, which `is_current` guards).
    attempts: HashMap<String, ConnectAttempt>,
    /// Open `subscriptions/listen` streams per connected stateless HTTP
    /// server. Stdio subscriptions live inside their transport (shared
    /// channel) and are drained on poll.
    listen_streams: HashMap<String, crate::mcp::transport_http::MCPListenStream>,
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
            attempts: HashMap::new(),
            listen_streams: HashMap::new(),
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

    /// Set workspace trust (C6, #2453): a trusted workspace connects stdio
    /// servers from the project root immediately instead of holding them for
    /// approval. Must be called before registering those servers.
    pub fn set_workspace_trusted(&mut self, trusted: bool) {
        self.state.set_workspace_trusted(trusted);
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
        self.attempts.remove(name);
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
    /// Polls `subscriptions/listen` events first so a server-side tool
    /// change is reflected before the dispatch decision.
    pub async fn call_tool(
        &mut self,
        prefixed_name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        self.poll_mcp_updates().await;
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
                    self.attempts.insert(name.to_string(), attempt);
                    self.connections.insert(name.to_string(), connection);
                    self.discovered.insert(name.to_string(), tools);
                    self.start_listen_for(name).await;
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

    /// Collect `subscriptions/listen` events (HTTP streams and stdio queues)
    /// and refresh the tool sets of servers that announced a tools-list
    /// change. Also resyncs once when a listen stream closed, since the
    /// server state may have moved on while the stream was down.
    pub async fn poll_mcp_updates(&mut self) {
        let mut changed: Vec<String> = Vec::new();
        let mut closed: Vec<String> = Vec::new();
        for (name, stream) in self.listen_streams.iter_mut() {
            loop {
                match stream.try_next() {
                    Some(ListenMessage::Notification { method, .. })
                        if method == NOTIFICATION_TOOLS_LIST_CHANGED
                            && !changed.contains(name) =>
                    {
                        changed.push(name.clone());
                    }
                    Some(ListenMessage::Notification { .. }) => {}
                    Some(ListenMessage::Closed { .. }) => {
                        closed.push(name.clone());
                        break;
                    }
                    None => break,
                }
            }
        }
        for name in closed {
            // Dropping the stream aborts its reader task.
            self.listen_streams.remove(&name);
            if !changed.contains(&name) {
                changed.push(name.clone());
            }
        }

        // Stdio transports keep their subscription state; drain the queued
        // notifications from each connection.
        let names: Vec<String> = self.connections.keys().cloned().collect();
        for name in names {
            let Some(connection) = self.connections.remove(&name) else {
                continue;
            };
            let mut connection = connection;
            if let McpConnection::Stdio(transport) = &mut connection
                && transport.mode() == Some(McpProtocolMode::Stateless2026)
                && !changed.contains(&name)
                && transport
                    .drain_listen()
                    .iter()
                    .any(|(method, _)| method == NOTIFICATION_TOOLS_LIST_CHANGED)
            {
                changed.push(name.clone());
            }            self.connections.insert(name, connection);
        }

        for name in changed {
            self.refresh_tools(&name).await;
        }
    }

    /// Re-discover a connected server's tools and re-report them through the
    /// attempt that connected it (a `subscriptions/listen` change or a
    /// re-sync after the stream closed). Failures keep the previous tool set.
    async fn refresh_tools(&mut self, name: &str) {
        let Some(attempt) = self.attempts.get(name).copied() else {
            return;
        };
        let Some(connection) = self.connections.remove(name) else {
            return;
        };
        let (connection, tools) = match connection {
            McpConnection::Stdio(mut transport) => {
                let result = tokio::task::spawn_blocking(move || {
                    let tools = transport.list_tools().map(|r| r.tools);
                    (transport, tools)
                })
                .await;
                match result {
                    Ok((transport, Ok(tools))) => (McpConnection::Stdio(transport), Some(tools)),
                    Ok((transport, Err(_))) => (McpConnection::Stdio(transport), None),
                    Err(join_error) => {
                        // The transport was moved into the blocking closure and
                        // is lost with the panic; mark the server failed so the
                        // state machine no longer claims it is connected.
                        eprintln!(
                            "[kimi-agent] MCP {name}: tools refresh panicked: {join_error}"
                        );
                        self.state.report_failed(
                            name,
                            attempt,
                            "MCP tools refresh panicked; reconnect the server",
                            false,
                        );
                        self.discovered.remove(name);
                        self.attempts.remove(name);
                        return;
                    }
                }
            }
            McpConnection::Http(transport) => match transport.list_tools().await {
                Ok(result) => (McpConnection::Http(transport), Some(result.tools)),
                Err(_) => (McpConnection::Http(transport), None),
            },
            McpConnection::Sse(mut transport) => match transport.list_tools().await {
                Ok(result) => (McpConnection::Sse(transport), Some(result.tools)),
                Err(_) => (McpConnection::Sse(transport), None),
            },
        };
        match tools {
            Some(tools) => {
                let tool_names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();
                if self.state.report_connected(name, attempt, tool_names) {
                    self.discovered.insert(name.to_string(), tools);
                }
            }
            None => {
                eprintln!(
                    "[kimi-agent] MCP {name}: tools refresh failed; keeping the previous tool set"
                );
            }
        }
        self.connections.insert(name.to_string(), connection);
    }

    /// Open a `subscriptions/listen` subscription (tools-list changes) on a
    /// connected stateless server. HTTP uses a long-lived stream; stdio
    /// queues notifications on its shared channel. Failures are logged and
    /// ignored — the server simply refreshes tools less eagerly.
    async fn start_listen_for(&mut self, name: &str) {
        let Some(connection) = self.connections.remove(name) else {
            return;
        };
        let notifications = serde_json::json!({ LISTEN_TOOLS_LIST_CHANGED: true });
        let connection = match connection {
            McpConnection::Stdio(mut transport) => {
                if transport.mode() == Some(McpProtocolMode::Stateless2026)
                    && let Err(error) = transport.start_listen(&notifications)
                {
                    eprintln!("[kimi-agent] MCP {name}: failed to open subscriptions/listen: {error}");
                }
                McpConnection::Stdio(transport)
            }
            McpConnection::Http(transport) => {
                if transport.mode() == Some(McpProtocolMode::Stateless2026) {
                    match transport.start_listen(&notifications).await {
                        Ok(stream) => {
                            self.listen_streams.insert(name.to_string(), stream);
                        }
                        Err(error) => {
                            eprintln!(
                                "[kimi-agent] MCP {name}: failed to open subscriptions/listen: {error}"
                            );
                        }
                    }
                }
                McpConnection::Http(transport)
            }
            other => other,
        };
        self.connections.insert(name.to_string(), connection);
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
        self.listen_streams.remove(name);
        self.discovered.remove(name);
        self.attempts.remove(name);
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

    #[test]
    fn spec_input_maps_stdio_and_remote_registrations() {
        // Stdio: command present, no transport → inferred stdio; trusted source.
        let stdio = McpServerSpecInput {
            name: "fs".into(),
            transport: None,
            enabled: None,
            command: Some("node".into()),
            args: vec!["server.js".into()],
            env: None,
            cwd: Some("/repo".into()),
            url: None,
            enabled_tools: Some(vec!["read".into()]),
            disabled_tools: None,
            bearer_token: None,
            bearer_token_env_var: None,
            startup_timeout_ms: Some(5000),
            tool_timeout_ms: None,
            has_headers: None,
            project_root: None,
        };
        let (name, spec, source) = stdio.into_registration();
        assert_eq!(name, "fs");
        assert_eq!(spec.config.transport, McpTransport::Stdio);
        assert!(spec.config.enabled, "defaults to enabled");
        assert_eq!(spec.command.as_deref(), Some("node"));
        assert_eq!(spec.args, vec!["server.js".to_string()]);
        assert_eq!(spec.cwd.as_deref(), Some("/repo"));
        assert_eq!(spec.config.enabled_tools.as_deref(), Some(&["read".to_string()][..]));
        assert_eq!(spec.config.startup_timeout_ms, Some(5000));
        assert!(matches!(source, McpConfigSource::Other), "host source is trusted");

        // Remote: url present, no command, from project root → http + untrusted.
        let remote = McpServerSpecInput {
            name: "gh".into(),
            transport: None,
            enabled: Some(false),
            command: None,
            args: vec![],
            env: None,
            cwd: None,
            url: Some("https://mcp.example.com".into()),
            enabled_tools: None,
            disabled_tools: None,
            bearer_token: Some("tok".into()),
            bearer_token_env_var: Some("GH_TOKEN".into()),
            startup_timeout_ms: None,
            tool_timeout_ms: None,
            has_headers: Some(true),
            project_root: Some(true),
        };
        let (name, spec, source) = remote.into_registration();
        assert_eq!(name, "gh");
        assert_eq!(spec.config.transport, McpTransport::Http);
        assert!(!spec.config.enabled);
        assert_eq!(spec.config.url.as_deref(), Some("https://mcp.example.com"));
        assert_eq!(spec.bearer_token.as_deref(), Some("tok"));
        assert!(spec.config.has_headers);
        assert!(matches!(source, McpConfigSource::ProjectRoot), "project root is untrusted");
    }

    #[test]
    fn spec_input_explicit_transport_wins_over_inference() {
        let sse = McpServerSpecInput {
            name: "s".into(),
            transport: Some("sse".into()),
            enabled: None,
            command: Some("node".into()), // command present, but explicit sse wins
            args: vec![],
            env: None,
            cwd: None,
            url: Some("https://x".into()),
            enabled_tools: None,
            disabled_tools: None,
            bearer_token: None,
            bearer_token_env_var: None,
            startup_timeout_ms: None,
            tool_timeout_ms: None,
            has_headers: None,
            project_root: None,
        };
        assert_eq!(sse.into_registration().1.config.transport, McpTransport::Sse);
    }

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok()
    }

    /// The scripted stdio MCP server used by the transport tests, with two
    /// tools so the enable-filter path is observable. Legacy-era: rejects
    /// `server/discover` so the client falls back to the initialize
    /// handshake.
    const SCRIPTED_SERVER: &str = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: {
      code: -32601, message: 'Method not found',
    } }) + '\n');
  } else if (msg.method === 'initialize') {
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

    /// A stateless (2026-07-28) stdio server that answers `server/discover`,
    /// subscribes to `subscriptions/listen`, announces a tools-list change
    /// shortly after, and grows its tool set between `tools/list` calls.
    const LISTEN_SERVER: &str = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let listCount = 0;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2026-07-28',
      capabilities: {}, serverInfo: { name: 'listen-server', version: '1.0.0' },
      supportedProtocolVersions: ['2026-07-28'],
    } }) + '\n');
  } else if (msg.method === 'subscriptions/listen') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
      params: { notifications: { toolsListChanged: true },
        _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id } } }) + '\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed',
        params: { _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id } } }) + '\n');
    }, 50);
  } else if (msg.method === 'tools/list') {
    listCount += 1;
    const tools = listCount === 1
      ? [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }]
      : [
          { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
          { name: 'alpha', description: 'Added later', inputSchema: { type: 'object' } },
        ];
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'complete', tools,
    } }) + '\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'complete',
      content: [{ type: 'text', text: msg.params.name + ':' + msg.params.arguments.value }],
    } }) + '\n');
  }
});
"#;

    /// `subscriptions/listen`-driven tool refresh: after the server announces
    /// a tools-list change, `poll_mcp_updates` re-discovers the tool set and
    /// the new tool becomes dispatchable.
    #[tokio::test(flavor = "multi_thread")]
    async fn listen_driven_tool_refresh_updates_discovered_tools() {
        if !node_available() {
            eprintln!("skipping: node not available");
            return;
        }
        let mut runtime = McpRuntime::new(false, None, None);
        let spec = McpServerSpec {
            config: McpServerConfig {
                startup_timeout_ms: Some(15_000),
                tool_timeout_ms: Some(15_000),
                ..Default::default()
            },
            command: Some("node".to_string()),
            args: vec!["-e".to_string(), LISTEN_SERVER.to_string()],
            ..Default::default()
        };
        let entry = runtime
            .register("listen", spec, McpConfigSource::Other)
            .await;
        assert_eq!(
            entry.status,
            McpServerStatus::Connected,
            "{:?}",
            entry.error
        );
        assert_eq!(entry.tool_count, 1);

        // Stdio delivers listen notifications inside request read loops, so
        // pump the channel with calls, let the delayed notification land,
        // then poll to trigger the refresh.
        let _ = runtime
            .call_tool(
                "mcp__listen__echo",
                Some(serde_json::json!({ "value": "x" })),
            )
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let _ = runtime
            .call_tool(
                "mcp__listen__echo",
                Some(serde_json::json!({ "value": "x" })),
            )
            .await;
        runtime.poll_mcp_updates().await;

        let names: Vec<String> = runtime
            .tool_definitions()
            .iter()
            .map(|definition| definition.name.clone())
            .collect();
        assert!(
            names.contains(&"mcp__listen__echo".to_string()),
            "echo missing: {names:?}"
        );
        assert!(
            names.contains(&"mcp__listen__alpha".to_string()),
            "refreshed tool missing: {names:?}"
        );

        let result = runtime
            .call_tool(
                "mcp__listen__alpha",
                Some(serde_json::json!({ "value": "y" })),
            )
            .await
            .expect("newly discovered tool must dispatch");
        assert_eq!(mcp_content_to_text(&result.content), "alpha:y");
    }
}
