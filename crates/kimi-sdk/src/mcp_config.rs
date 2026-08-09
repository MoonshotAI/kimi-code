//! User-global (host-side) MCP config store + OAuth flow + stdio probe —
//! local port of the retired node-sdk `legacy/global-mcp-config.ts` and
//! `legacy/mcp-host.ts`. The engine owns the session-scoped MCP runtime;
//! this store keeps the user-level `<KIMI_CODE_HOME>/mcp.json` editable from
//! any host (list / add / update / remove / authenticate / test).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// MCP server transport kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpTransport {
    #[serde(rename = "stdio")]
    Stdio,
    #[serde(rename = "http")]
    Http,
    /// Deprecated since MCP 2025-03-26, formally deprecated in 2026-07-28 —
    /// migrate to streamable HTTP. Kept for reading legacy `mcp.json`
    /// entries (the engine's session runtime still connects them).
    #[serde(rename = "sse")]
    Sse,
}

impl McpTransport {
    pub fn as_str(&self) -> &'static str {
        match self {
            McpTransport::Stdio => "stdio",
            McpTransport::Http => "http",
            McpTransport::Sse => "sse",
        }
    }
}

/// One MCP server entry stored under `mcpServers.<name>` in `mcp.json`.
/// Field names follow the node-sdk camelCase wire shape; only the fields
/// relevant to the declared transport are required.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub transport: McpTransport,
    // stdio
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Reserved for future kaos-backed stdio launchers; `None`/`"local"`
    /// both mean a direct spawn for now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    // remote
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    /// Backward-compatible UI marker (`oauth`); OAuth is still discovered
    /// from a remote server's 401 response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// Indirect secret reference: the bearer token is looked up from
    /// `process.env[bearerTokenEnvVar]` at connection time.
    #[serde(skip_serializing_if = "Option::is_none", rename = "bearerTokenEnvVar")]
    pub bearer_token_env_var: Option<String>,
    // common
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_tools: Option<Vec<String>>,
}

impl McpServerConfig {
    /// Validate the transport's required fields (node-sdk zod parity:
    /// stdio needs a non-empty `command`, http/sse a `url`).
    pub fn validate(&self) -> Result<(), String> {
        match self.transport {
            McpTransport::Stdio => {
                if self.command.as_deref().is_none_or(|c| c.is_empty()) {
                    return Err("MCP stdio server requires a command".to_string());
                }
            }
            McpTransport::Http | McpTransport::Sse => {
                if self.url.as_deref().is_none_or(|u| u.is_empty()) {
                    return Err(format!(
                        "MCP {} server requires a URL",
                        self.transport.as_str()
                    ));
                }
            }
        }
        Ok(())
    }

    fn is_remote(&self) -> bool {
        matches!(self.transport, McpTransport::Http | McpTransport::Sse)
    }
}

/// A named global MCP server (`name` is the `mcpServers` map key and never
/// part of the stored entry itself).
#[derive(Debug, Clone)]
pub struct GlobalMcpServerConfig {
    pub name: String,
    pub config: McpServerConfig,
}

/// Result of a host-side stdio probe (`test_global_mcp_server`).
#[derive(Debug, Clone)]
pub struct McpTestResult {
    pub success: bool,
    pub output: String,
}

/// Result of `begin_global_mcp_server_auth`.
#[derive(Debug, Clone)]
pub struct BeginGlobalMcpServerAuthResult {
    /// `"authorization-required"` (a new flow was started) or
    /// `"already-authorized"` (reserved; the host owns its token store).
    pub status: String,
    pub flow_id: String,
    pub authorization_url: String,
}

/// Parsed `mcp.json` (raw root object + the `mcpServers` map).
#[derive(Default)]
struct McpConfigFile {
    raw: serde_json::Map<String, serde_json::Value>,
    raw_servers: serde_json::Map<String, serde_json::Value>,
    servers: Vec<GlobalMcpServerConfig>,
}

/// User-global MCP server config store — reads/writes `<KIMI_CODE_HOME>/mcp.json`.
#[derive(Debug, Clone)]
pub struct GlobalMcpConfigStore {
    path: PathBuf,
}

impl GlobalMcpConfigStore {
    /// Create a store rooted at `home_dir` (or the resolved Kimi home when
    /// `None`).
    pub fn new(home_dir: Option<&str>) -> Self {
        let home = match home_dir {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => crate::config::resolve_kimi_home()
                .map(PathBuf::from)
                .unwrap_or_default(),
        };
        Self {
            path: home.join("mcp.json"),
        }
    }

    /// The `mcp.json` path this store manages.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// All global MCP servers (name-sorted by map order).
    pub fn list(&self) -> Result<Vec<GlobalMcpServerConfig>, String> {
        Ok(self.read()?.servers)
    }

    /// One server by name; errors when absent.
    pub fn get(&self, name: &str) -> Result<GlobalMcpServerConfig, String> {
        let normalized = normalize_server_name(name)?;
        let file = self.read()?;
        file.servers
            .into_iter()
            .find(|entry| entry.name == normalized)
            .ok_or_else(|| format!("MCP server \"{normalized}\" was not found"))
    }

    /// Add a server; errors when the name already exists. Returns the new
    /// full list.
    pub fn add(&self, server: GlobalMcpServerConfig) -> Result<Vec<GlobalMcpServerConfig>, String> {
        let normalized = parse_server_input(server)?;
        let file = self.read()?;
        if file.raw_servers.contains_key(&normalized.name) {
            return Err(format!("MCP server \"{}\" already exists", normalized.name));
        }
        let mut next = file.raw_servers.clone();
        next.insert(normalized.name.clone(), persisted_entry(&normalized));
        self.write(file, next)?;
        self.list()
    }

    /// Update an existing server; errors when absent. Returns the new full
    /// list.
    pub fn update(
        &self,
        server: GlobalMcpServerConfig,
    ) -> Result<Vec<GlobalMcpServerConfig>, String> {
        let normalized = parse_server_input(server)?;
        let file = self.read()?;
        if !file.raw_servers.contains_key(&normalized.name) {
            return Err(format!("MCP server \"{}\" was not found", normalized.name));
        }
        let mut next = file.raw_servers.clone();
        next.insert(normalized.name.clone(), persisted_entry(&normalized));
        self.write(file, next)?;
        self.list()
    }

    /// Remove a server by name (absent is a no-op). Returns the new full
    /// list.
    pub fn remove(&self, name: &str) -> Result<Vec<GlobalMcpServerConfig>, String> {
        let normalized = normalize_server_name(name)?;
        let file = self.read()?;
        let mut next = file.raw_servers.clone();
        next.remove(&normalized);
        self.write(file, next)?;
        self.list()
    }

    fn read(&self) -> Result<McpConfigFile, String> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(McpConfigFile::default());
            }
            Err(error) => {
                return Err(format!(
                    "Failed to read {}: {}",
                    self.path.display(),
                    error
                ));
            }
        };
        if text.trim().is_empty() {
            return Ok(McpConfigFile::default());
        }
        let parsed: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid JSON in {}: {e}", self.path.display()))?;
        let raw = parsed
            .as_object()
            .cloned()
            .ok_or_else(|| format!("Invalid MCP config in {}: expected a JSON object", self.path.display()))?;
        let raw_servers = match raw.get("mcpServers") {
            Some(value) => value.as_object().cloned().ok_or_else(|| {
                format!("Invalid MCP config in {}: \"mcpServers\" must be an object", self.path.display())
            })?,
            None => serde_json::Map::new(),
        };
        let servers = raw_servers
            .iter()
            .map(|(name, value)| parse_server(name, value))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(McpConfigFile {
            raw,
            raw_servers,
            servers,
        })
    }

    fn write(
        &self,
        file: McpConfigFile,
        raw_servers: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
        let mut root = file.raw;
        root.insert("mcpServers".to_string(), serde_json::Value::Object(raw_servers));
        let json = serde_json::to_string_pretty(&serde_json::Value::Object(root))
            .map_err(|e| e.to_string())?;
        // Atomic write: temp file in the same directory, then rename.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, format!("{json}\n")).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("rename {}: {e}", self.path.display()))?;
        Ok(())
    }
}

/// Normalize + validate a server entry for add/update.
fn parse_server_input(server: GlobalMcpServerConfig) -> Result<GlobalMcpServerConfig, String> {
    let name = normalize_server_name(&server.name)?;
    server.config.validate()?;
    Ok(GlobalMcpServerConfig {
        name,
        config: server.config,
    })
}

/// Parse one `mcpServers.<name>` value, inferring the transport when the
/// entry predates the explicit `transport` field (node-sdk zod preprocess
/// parity: `command` → stdio, `url` → http).
fn parse_server(name: &str, value: &serde_json::Value) -> Result<GlobalMcpServerConfig, String> {
    let mut obj = match value.as_object() {
        Some(obj) => obj.clone(),
        None => {
            return Err(format!(
                "Invalid MCP server \"{name}\" in global config: expected an object"
            ));
        }
    };
    if !obj.contains_key("transport") {
        if obj.contains_key("command") {
            obj.insert("transport".to_string(), serde_json::json!("stdio"));
        } else if obj.contains_key("url") {
            obj.insert("transport".to_string(), serde_json::json!("http"));
        }
    }
    let config: McpServerConfig = serde_json::from_value(serde_json::Value::Object(obj)).map_err(
        |e| format!("Invalid MCP server \"{name}\" in global config: {e}"),
    )?;
    config.validate()?;
    Ok(GlobalMcpServerConfig {
        name: name.to_string(),
        config,
    })
}

/// The stored entry omits the name (it is the `mcpServers` map key).
fn persisted_entry(server: &GlobalMcpServerConfig) -> serde_json::Value {
    serde_json::to_value(&server.config).expect("serializable MCP config")
}

fn normalize_server_name(name: &str) -> Result<String, String> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return Err("MCP server name cannot be empty".to_string());
    }
    Ok(normalized.to_string())
}

// ── Host-side OAuth flow facade ────────────────────────────────────────────

/// In-memory OAuth flow registry (node-sdk `activeFlows` parity). The host
/// owns the actual token store; the SDK only mints `?oauth=begin` URLs and
/// tracks begin → complete/cancel.
#[derive(Default)]
pub struct GlobalMcpAuthFlows {
    flows: Mutex<HashMap<String, (String, String)>>,
}

impl GlobalMcpAuthFlows {
    pub fn new() -> Self {
        Self::default()
    }

    /// Begin a flow for a remote server; returns the `authorizationUrl` the
    /// host should open in a browser.
    pub fn begin(
        &self,
        server: &GlobalMcpServerConfig,
    ) -> Result<BeginGlobalMcpServerAuthResult, String> {
        if !server.config.is_remote() {
            return Err(format!(
                "MCP server \"{}\" does not use a remote transport",
                server.name
            ));
        }
        let url = server
            .config
            .url
            .as_deref()
            .filter(|u| !u.is_empty())
            .ok_or_else(|| format!("MCP server \"{}\" has no URL", server.name))?;
        let authorization_url = append_query_param(url, "oauth", "begin");
        let flow_id = ulid::Ulid::new().to_string();
        self.flows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(flow_id.clone(), (server.name.clone(), authorization_url.clone()));
        Ok(BeginGlobalMcpServerAuthResult {
            status: "authorization-required".to_string(),
            flow_id,
            authorization_url,
        })
    }

    /// Complete a flow (the browser flow finished). Errors on an unknown id.
    pub fn complete(&self, flow_id: &str) -> Result<(), String> {
        if self.flows.lock().unwrap_or_else(|e| e.into_inner()).remove(flow_id).is_none() {
            return Err(format!("Unknown MCP OAuth flow: {flow_id}"));
        }
        Ok(())
    }

    /// Cancel a flow (idempotent).
    pub fn cancel(&self, flow_id: &str) {
        self.flows.lock().unwrap_or_else(|e| e.into_inner()).remove(flow_id);
    }

    /// Validate the server is remote (clearing stored credentials is the
    /// host's job — it owns the OAuth token store).
    pub fn reset(&self, server: &GlobalMcpServerConfig) -> Result<(), String> {
        if !server.config.is_remote() {
            return Err(format!(
                "MCP server \"{}\" does not use a remote transport",
                server.name
            ));
        }
        Ok(())
    }
}

/// Append a query parameter to a URL (preserving an existing query string).
fn append_query_param(url: &str, key: &str, value: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}{key}={value}")
}

// ── Host-side stdio probe ──────────────────────────────────────────────────

/// Connect a user-global server once and report its discovered tools. Only
/// stdio is supported by the host-side probe (node-sdk parity); remote
/// transports report a failure (the engine's session runtime connects those).
pub async fn test_global_mcp_server(server: &GlobalMcpServerConfig) -> Result<McpTestResult, String> {
    if !matches!(server.config.transport, McpTransport::Stdio) {
        return Ok(McpTestResult {
            success: false,
            output: format!(
                "MCP server \"{}\" uses \"{}\" transport; only stdio is supported for host-side testing",
                server.name,
                server.config.transport.as_str()
            ),
        });
    }
    let command = server.config.command.clone().unwrap_or_default();
    if command.is_empty() {
        return Ok(McpTestResult {
            success: false,
            output: format!("MCP server \"{}\" has no command", server.name),
        });
    }
    // Pre-flight the executable: a missing absolute/relative path spawns and
    // immediately closes, which hides the ENOENT the probe should surface.
    if command.contains('/') || command.contains('\\') {
        if !Path::new(&command).exists() {
            return Ok(McpTestResult {
                success: false,
                output: format!("spawn {command} ENOENT"),
            });
        }
    }
    let args = server.config.args.clone().unwrap_or_default();
    let mut transport = kimi_agent::mcp::transport_stdio::MCPStdioTransport::spawn(
        &command,
        &args,
        kimi_agent::mcp::transport_stdio::StdioSpawnOptions {
            env: server.config.env.clone(),
            cwd: server.config.cwd.clone(),
            default_cwd: None,
            client_version: None,
            startup_timeout_ms: server.config.startup_timeout_ms,
            tool_call_timeout_ms: None,
        },
    )
    .map_err(|e| format!("spawn {command}: {e}"))?;
    let result = match transport.connect() {
        Ok(()) => {
            match transport.list_tools() {
                Ok(list) => {
                    let mut lines = vec![
                        format!("Connected to MCP server \"{}\".", server.name),
                        format!("Available tools: {}", list.tools.len()),
                    ];
                    for tool in &list.tools {
                        match &tool.description {
                            Some(desc) if !desc.is_empty() => {
                                lines.push(format!("- {}{}", tool.name, format!(": {desc}")));
                            }
                            _ => lines.push(format!("- {}", tool.name)),
                        }
                    }
                    McpTestResult {
                        success: true,
                        output: lines.join("\n"),
                    }
                }
                Err(error) => McpTestResult {
                    success: false,
                    output: error,
                },
            }
        }
        Err(error) => McpTestResult {
            success: false,
            output: error,
        },
    };
    let _ = transport.shutdown();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store(tag: &str) -> GlobalMcpConfigStore {
        let dir = std::env::temp_dir().join(format!("kimi-sdk-mcp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        GlobalMcpConfigStore::new(Some(dir.to_str().unwrap()))
    }

    fn stdio_server(name: &str) -> GlobalMcpServerConfig {
        GlobalMcpServerConfig {
            name: name.to_string(),
            config: McpServerConfig {
                transport: McpTransport::Stdio,
                command: Some("echo".to_string()),
                args: None,
                env: None,
                cwd: None,
                executor: None,
                url: None,
                headers: None,
                auth: None,
                bearer_token_env_var: None,
                enabled: None,
                startup_timeout_ms: None,
                tool_timeout_ms: None,
                enabled_tools: None,
                disabled_tools: None,
            },
        }
    }

    #[test]
    fn empty_store_lists_nothing() {
        let store = tmp_store("empty");
        assert!(store.list().expect("list").is_empty());
    }

    #[test]
    fn add_update_remove_roundtrip() {
        let store = tmp_store("roundtrip");
        let all = store.add(stdio_server("srv-a")).expect("add");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "srv-a");

        // Duplicate add errors.
        assert!(store.add(stdio_server("srv-a")).is_err());

        // Update rewrites the entry.
        let mut updated = stdio_server("srv-a");
        updated.config.command = Some("cat".to_string());
        let all = store.update(updated).expect("update");
        assert_eq!(all[0].config.command.as_deref(), Some("cat"));

        // Remove drops it; absent remove is a no-op.
        let all = store.remove("srv-a").expect("remove");
        assert!(all.is_empty());
        assert!(store.remove("srv-a").expect("remove no-op").is_empty());

        // get on an absent name errors.
        assert!(store.get("srv-a").is_err());
    }

    #[test]
    fn legacy_entry_without_transport_infers_stdio() {
        let store = tmp_store("legacy");
        std::fs::create_dir_all(store.path().parent().unwrap()).expect("mkdir");
        std::fs::write(
            &store.path,
            r#"{
  "mcpServers": {
    "old": { "command": "npx", "args": ["-y", "server"] }
  }
}
"#,
        )
        .expect("write mcp.json");
        let all = store.list().expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "old");
        assert_eq!(all[0].config.transport, McpTransport::Stdio);
        assert_eq!(all[0].config.command.as_deref(), Some("npx"));
    }

    #[test]
    fn invalid_json_reports_clear_error() {
        let store = tmp_store("badjson");
        std::fs::create_dir_all(store.path().parent().unwrap()).expect("mkdir");
        std::fs::write(&store.path, "{ not json").expect("write");
        let err = store.list().expect_err("must fail");
        assert!(err.contains("Invalid JSON"), "error: {err}");
    }

    #[test]
    fn validation_requires_command_for_stdio() {
        let mut server = stdio_server("bad");
        server.config.command = None;
        let err = store_add_err(server);
        assert!(err.contains("requires a command"), "error: {err}");
    }

    fn store_add_err(server: GlobalMcpServerConfig) -> String {
        let store = tmp_store("validate");
        store.add(server).expect_err("must fail")
    }

    #[test]
    fn auth_flow_begin_complete_cancel() {
        let flows = GlobalMcpAuthFlows::new();
        let mut server = stdio_server("remote");
        server.config.transport = McpTransport::Http;
        server.config.url = Some("https://example.com/mcp".to_string());
        server.config.command = None;

        // Non-remote servers are rejected.
        let mut local = server.clone();
        local.config.transport = McpTransport::Stdio;
        assert!(flows.begin(&local).is_err());

        let started = flows.begin(&server).expect("begin");
        assert_eq!(started.status, "authorization-required");
        assert_eq!(started.authorization_url, "https://example.com/mcp?oauth=begin");

        // Unknown flow id errors on complete; known one resolves.
        assert!(flows.complete("nope").is_err());
        flows.complete(&started.flow_id).expect("complete");

        // Cancel is idempotent.
        let started = flows.begin(&server).expect("begin again");
        flows.cancel(&started.flow_id);
        flows.cancel(&started.flow_id);
    }

    #[test]
    fn append_query_param_handles_existing_query() {
        assert_eq!(
            append_query_param("https://example.com/mcp?x=1", "oauth", "begin"),
            "https://example.com/mcp?x=1&oauth=begin"
        );
        assert_eq!(
            append_query_param("https://example.com/mcp", "oauth", "begin"),
            "https://example.com/mcp?oauth=begin"
        );
    }
}
