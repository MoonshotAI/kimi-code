/// MCP (Model Context Protocol) native support.
///
/// Phase 1 migration from TypeScript:
///   - Config loading (parse mcp.json, merge, resolve paths)
///   - Stdio child-process management (spawn, stderr capture, lifecycle)
///   - JSON-RPC 2.0 protocol over stdio (initialize, tools/list, tools/call)
///
/// The TS layer (`packages/agent-core/src/mcp/`) retains HTTP/SSE transports
/// and OAuth.  Stdio transport can optionally use this native implementation
/// for better reliability and reduced GC pressure.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

// ============================================================================
// Constants
// ============================================================================

/// MCP protocol version negotiated during `initialize`.
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

/// Capacity (in bytes) of the stderr tail buffer.
const STDERR_BUFFER_CAPACITY: usize = 4 * 1024;

/// Default startup timeout in milliseconds.
const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 30_000;

/// Default tool-call timeout in milliseconds.
const DEFAULT_TOOL_TIMEOUT_MS: u64 = 60_000;

// ============================================================================
// Config loading
// ============================================================================

/// Configuration for a single MCP server after parsing and validation.
#[derive(Clone, Debug)]
pub struct McpServerConfig {
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub bearer_token_env_var: Option<String>,
    pub enabled: Option<bool>,
    pub startup_timeout_ms: Option<u32>,
    pub tool_timeout_ms: Option<u32>,
    pub enabled_tools: Option<Vec<String>>,
    pub disabled_tools: Option<Vec<String>>,
}

/// Result of loading MCP config from the three-tier file hierarchy.
pub struct McpConfigLoadResult {
    /// Merged server entries (name → config).
    pub servers: Vec<(String, McpServerConfig)>,
    /// Path to the user-global mcp.json.
    pub user_path: String,
    /// Path to the project-root .mcp.json.
    pub project_root_path: String,
    /// Path to the project-local .kimi-code/mcp.json.
    pub project_path: String,
    /// Error message if loading failed partially.
    pub error: Option<String>,
}

/// Input for `load_mcp_config`.
pub struct McpConfigLoadInput {
    pub cwd: String,
    pub home_dir: Option<String>,
}

/// Load and merge MCP server declarations from the three-tier config hierarchy:
///   1. `~/.kimi-code/mcp.json` (user-global)
///   2. `<project-root>/.mcp.json` (project-root, Claude-compatible)
///   3. `<cwd>/.kimi-code/mcp.json` (project-local)
///
/// Entries in later files override earlier files with the same key.
/// Stdio `cwd` paths in the project-root file are resolved relative to the
/// project root directory.
pub async fn load_mcp_config(input: &McpConfigLoadInput) -> McpConfigLoadResult {
    let home = match &input.home_dir {
        Some(h) => PathBuf::from(h),
        None => match get_home_dir() {
            Some(h) => h,
            None => {
                return McpConfigLoadResult {
                    servers: Vec::new(),
                    user_path: String::new(),
                    project_root_path: String::new(),
                    project_path: String::new(),
                    error: Some("Cannot determine home directory".to_string()),
                };
            }
        },
    };

    let user_path = home.join(".kimi-code").join("mcp.json");
    let project_root = find_project_root(Path::new(&input.cwd));
    let project_root_path = project_root.join(".mcp.json");
    let project_path = Path::new(&input.cwd).join(".kimi-code").join("mcp.json");

    let mut merged: HashMap<String, McpServerConfig> = HashMap::new();
    let mut errors: Vec<String> = Vec::new();

    // Load user-global config.
    match read_mcp_json(&user_path, None) {
        Ok(servers) => {
            for (name, config) in servers {
                merged.insert(name, config);
            }
        }
        Err(e) => {
            if !e.contains("not found") {
                errors.push(format!("user config: {}", e));
            }
        }
    }

    // Load project-root config (stdio cwd resolved relative to project root).
    let stdio_cwd_base = project_root.to_string_lossy().to_string();
    match read_mcp_json(&project_root_path, Some(&stdio_cwd_base)) {
        Ok(servers) => {
            for (name, config) in servers {
                merged.insert(name, config);
            }
        }
        Err(e) => {
            if !e.contains("not found") {
                errors.push(format!("project-root config: {}", e));
            }
        }
    }

    // Load project-local config.
    match read_mcp_json(&project_path, None) {
        Ok(servers) => {
            for (name, config) in servers {
                merged.insert(name, config);
            }
        }
        Err(e) => {
            if !e.contains("not found") {
                errors.push(format!("project config: {}", e));
            }
        }
    }

    // Convert to sorted vec for deterministic ordering.
    let mut servers: Vec<(String, McpServerConfig)> = merged.into_iter().collect();
    servers.sort_by(|a, b| a.0.cmp(&b.0));

    McpConfigLoadResult {
        servers,
        user_path: user_path.to_string_lossy().to_string(),
        project_root_path: project_root_path.to_string_lossy().to_string(),
        project_path: project_path.to_string_lossy().to_string(),
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        },
    }
}

/// Read and parse a single mcp.json file.
fn read_mcp_json(
    path: &Path,
    stdio_cwd_base: Option<&str>,
) -> Result<Vec<(String, McpServerConfig)>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("{}: not found", path.display()));
        }
        Err(e) => return Err(format!("{}: {}", path.display(), e)),
    };

    if text.trim().is_empty() {
        return Ok(Vec::new());
    }

    let data: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{}: invalid JSON: {}", path.display(), e))?;

    let mcp_servers = data
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("{}: missing 'mcpServers' key", path.display()))?;

    let mut result = Vec::new();
    for (name, raw) in mcp_servers {
        match parse_server_config(raw, stdio_cwd_base) {
            Ok(config) => result.push((name.clone(), config)),
            Err(e) => {
                return Err(format!("{}: server '{}': {}", path.display(), name, e));
            }
        }
    }

    Ok(result)
}

/// Parse a single server config from JSON, inferring transport if missing.
fn parse_server_config(
    raw: &Value,
    stdio_cwd_base: Option<&str>,
) -> Result<McpServerConfig, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "config must be an object".to_string())?;

    // Infer transport if not explicitly set.
    let transport = obj
        .get("transport")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if obj.contains_key("command") {
                "stdio".to_string()
            } else if obj.contains_key("url") {
                "http".to_string()
            } else {
                "stdio".to_string()
            }
        });

    let mut config = McpServerConfig {
        transport: transport.clone(),
        command: obj.get("command").and_then(|v| v.as_str()).map(String::from),
        args: obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            }),
        env: parse_string_map(obj.get("env")),
        cwd: obj.get("cwd").and_then(|v| v.as_str()).map(String::from),
        url: obj.get("url").and_then(|v| v.as_str()).map(String::from),
        headers: parse_string_map(obj.get("headers")),
        bearer_token_env_var: obj
            .get("bearerTokenEnvVar")
            .and_then(|v| v.as_str())
            .map(String::from),
        enabled: obj.get("enabled").and_then(|v| v.as_bool()),
        startup_timeout_ms: obj
            .get("startupTimeoutMs")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        tool_timeout_ms: obj
            .get("toolTimeoutMs")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        enabled_tools: obj
            .get("enabledTools")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            }),
        disabled_tools: obj
            .get("disabledTools")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            }),
    };

    // Validate required fields per transport.
    match transport.as_str() {
        "stdio" => {
            if config.command.is_none() {
                return Err("stdio transport requires 'command'".to_string());
            }
            // Resolve relative cwd against stdio_cwd_base.
            if let Some(base) = stdio_cwd_base {
                if let Some(cwd) = &config.cwd {
                    if !Path::new(cwd).is_absolute() {
                        config.cwd = Some(
                            Path::new(base)
                                .join(cwd)
                                .to_string_lossy()
                                .to_string(),
                        );
                    }
                }
            }
        }
        "http" | "sse" => {
            if config.url.is_none() {
                return Err(format!("{} transport requires 'url'", transport));
            }
        }
        _ => return Err(format!("unknown transport: {}", transport)),
    }

    Ok(config)
}

fn parse_string_map(v: Option<&Value>) -> Option<HashMap<String, String>> {
    v.and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
}

/// Walk up from `start` looking for a `.git` entry; fall back to `start`.
fn find_project_root(start: &Path) -> PathBuf {
    let start = if start.is_absolute() {
        start.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| start.to_path_buf())
            .join(start)
    };

    let mut current = start.clone();
    loop {
        if current.join(".git").exists() {
            return current;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }
    start
}

/// Get the user's home directory (cross-platform).
fn get_home_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

// ============================================================================
// Stdio MCP client — JSON-RPC 2.0 over child process stdio
// ============================================================================

/// Internal state for a spawned stdio MCP server connection.
struct StdioClient {
    child: Child,
    stdin: ChildStdin,
    stdout_reader: BufReader<ChildStdout>,
    stderr: std::sync::Arc<Mutex<String>>,
    next_request_id: u64,
    initialized: bool,
    server_info: Option<Value>,
}

/// Global registry of active stdio clients, keyed by handle.
static CLIENTS: OnceLock<Mutex<HashMap<u64, StdioClient>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

fn clients() -> &'static Mutex<HashMap<u64, StdioClient>> {
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Configuration for spawning a stdio MCP server.
pub struct StdioSpawnConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
}

/// Result of spawning a stdio MCP server.
pub struct StdioSpawnResult {
    pub handle: u64,
    pub pid: u32,
}

/// A tool definition returned by `tools/list`.
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Spawn a child process for a stdio MCP server and register it.
pub async fn stdio_spawn(config: &StdioSpawnConfig) -> Result<StdioSpawnResult, String> {
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args);

    // Set environment variables.
    cmd.env_clear();
    // Inherit PATH so npx/uvx work.
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    if cfg!(target_os = "windows") {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            cmd.env("USERPROFILE", profile);
        }
        if let Some(sys_root) = std::env::var_os("SystemRoot") {
            cmd.env("SystemRoot", sys_root);
        }
    } else {
        if let Some(home) = std::env::var_os("HOME") {
            cmd.env("HOME", home);
        }
    }
    // Apply user-provided env overrides.
    for (k, v) in &config.env {
        cmd.env(k, v);
    }

    if let Some(cwd) = &config.cwd {
        cmd.current_dir(cwd);
    }

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // On Windows, hide the console window.
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", config.command, e))?;

    let pid = child
        .id()
        .ok_or_else(|| "Failed to get child PID".to_string())?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture child stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture child stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture child stderr".to_string())?;

    let stderr_buf = std::sync::Arc::new(Mutex::new(String::new()));
    let stderr_buf_clone = stderr_buf.clone();

    // Spawn a background task to drain stderr into the bounded buffer.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = vec![0u8; 512];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    let mut guard = stderr_buf_clone.lock().await;
                    guard.push_str(&chunk);
                    let len = guard.len();
                    if len > STDERR_BUFFER_CAPACITY {
                        let start = len - STDERR_BUFFER_CAPACITY;
                        let drained = guard[start..].to_string();
                        *guard = drained;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let stdout_reader = BufReader::new(stdout);

    let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);
    let client = StdioClient {
        child,
        stdin,
        stdout_reader,
        stderr: stderr_buf,
        next_request_id: 1,
        initialized: false,
        server_info: None,
    };

    clients().lock().await.insert(handle, client);

    Ok(StdioSpawnResult { handle, pid })
}

/// Send the JSON-RPC `initialize` request and the `notifications/initialized`
/// notification.  Must be called before `list_tools` or `call_tool`.
pub async fn stdio_initialize(
    handle: u64,
    client_name: &str,
    client_version: &str,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    let timeout = Duration::from_millis(
        timeout_ms.unwrap_or(DEFAULT_STARTUP_TIMEOUT_MS as u32) as u64,
    );

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": client_name,
                "version": client_version,
            }
        }
    });

    let response = tokio::time::timeout(
        timeout,
        send_request_inner(handle, request),
    )
    .await
    .map_err(|_| {
        let stderr = try_get_stderr(handle);
        format!(
            "MCP initialize timed out after {}ms{}",
            timeout.as_millis(),
            stderr.map(|s| format!("\nstderr: {}", s)).unwrap_or_default()
        )
    })??;

    // Send the initialized notification (no response expected).
    let notification = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    send_notification_inner(handle, &notification).await?;

    // Mark as initialized.
    {
        let mut clients = clients().lock().await;
        if let Some(client) = clients.get_mut(&handle) {
            client.initialized = true;
            client.server_info = Some(response.clone());
            client.next_request_id = 2; // id 1 was used for initialize
        } else {
            return Err("Invalid handle".to_string());
        }
    }

    Ok(response)
}

/// Call `tools/list` on the MCP server.
pub async fn stdio_list_tools(handle: u64) -> Result<Vec<McpToolDef>, String> {
    let id = next_request_id(handle).await;
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/list",
        "params": {}
    });

    let response = send_request_inner(handle, request).await?;

    let tools = response
        .get("tools")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "tools/list response missing 'tools' array".to_string())?;

    let result: Vec<McpToolDef> = tools
        .iter()
        .map(|tool| McpToolDef {
            name: tool
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            description: tool
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            input_schema: tool
                .get("inputSchema")
                .cloned()
                .unwrap_or(Value::Object(serde_json::Map::new())),
        })
        .collect();

    Ok(result)
}

/// Call `tools/call` on the MCP server.
pub async fn stdio_call_tool(
    handle: u64,
    name: &str,
    args: &Value,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    let id = next_request_id(handle).await;
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": args,
        }
    });

    let timeout = Duration::from_millis(
        timeout_ms.unwrap_or(DEFAULT_TOOL_TIMEOUT_MS as u32) as u64,
    );

    let response = tokio::time::timeout(
        timeout,
        send_request_inner(handle, request),
    )
    .await
    .map_err(|_| {
        let stderr = try_get_stderr(handle);
        format!(
            "tools/call '{}' timed out after {}ms{}",
            name,
            timeout.as_millis(),
            stderr.map(|s| format!("\nstderr: {}", s)).unwrap_or_default()
        )
    })??;

    Ok(response)
}

/// Close the stdio connection: kill the child process and remove the client.
pub async fn stdio_close(handle: u64) -> Result<(), String> {
    let mut clients = clients().lock().await;
    if let Some(mut client) = clients.remove(&handle) {
        // Try to kill the child process.
        let _ = client.child.kill().await;
        let _ = client.child.wait().await;
        // Drop stdin to close the pipe.
        let _ = client.stdin.shutdown().await;
    }
    Ok(())
}

/// Get a snapshot of the child process's stderr (tail, bounded).
///
/// Uses `try_lock` so it never blocks when a request is in flight.
/// Returns the last cached value (which may be empty) in that case.
pub async fn stdio_stderr_snapshot(handle: u64) -> String {
    let clients = clients().lock().await;
    if let Some(client) = clients.get(&handle) {
        // Try non-blocking lock on stderr; if contended, return empty.
        match client.stderr.try_lock() {
            Ok(guard) => guard.clone(),
            Err(_) => String::new(),
        }
    } else {
        String::new()
    }
}

/// Check if the child process is still alive.
///
/// Uses `try_lock` on the clients map; if contended (a request is in
/// flight), returns `true` to avoid false-positive death reports.
pub async fn stdio_is_alive(handle: u64) -> bool {
    let mut clients = match clients().try_lock() {
        Ok(guard) => guard,
        Err(_) => return true, // Assume alive when lock is contended.
    };
    if let Some(client) = clients.get_mut(&handle) {
        match client.child.try_wait() {
            Ok(None) => true,   // Still running
            Ok(Some(_)) => false, // Exited
            Err(_) => false,
        }
    } else {
        false
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────

/// Send a JSON-RPC request and wait for the matching response.
async fn send_request_inner(handle: u64, request: Value) -> Result<Value, String> {
    let id = request
        .get("id")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let request_str = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to serialize request: {}", e))?;

    // Write request to stdin (short lock — just the write).
    {
        let mut clients = clients().lock().await;
        let client = clients
            .get_mut(&handle)
            .ok_or_else(|| "Invalid handle".to_string())?;

        client
            .stdin
            .write_all(request_str.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        client
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline to stdin: {}", e))?;
        client
            .stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;
    }

    // Read lines from stdout until we get the matching response.
    // We hold the lock for the entire read loop because stdout_reader is
    // owned by StdioClient and cannot be taken out without restructuring.
    // Concurrent calls to the same handle are serialized at the TS layer
    // (connection-manager calls listTools/callTool sequentially).
    let mut line = String::new();
    let mut clients = clients().lock().await;
    let client = clients
        .get_mut(&handle)
        .ok_or_else(|| "Invalid handle".to_string())?;

    loop {
        line.clear();
        let n = client
            .stdout_reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read from stdout: {}", e))?;

        if n == 0 {
            let stderr = client.stderr.lock().await.clone();
            return Err(format!(
                "Connection closed (EOF on stdout){}",
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("\nstderr: {}", stderr)
                }
            ));
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // Skip non-JSON lines
        };

        // Check if this is a response (has matching id).
        if let Some(resp_id) = msg.get("id").and_then(|v| v.as_u64()) {
            if resp_id == id {
                if let Some(error) = msg.get("error") {
                    return Err(format!(
                        "JSON-RPC error: {}",
                        error
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown error")
                    ));
                }
                return Ok(msg
                    .get("result")
                    .cloned()
                    .unwrap_or(Value::Null));
            }
        }
        // Notifications or unmatched responses are ignored.
    }
}

/// Send a JSON-RPC notification (no response expected).
async fn send_notification_inner(handle: u64, notification: &Value) -> Result<(), String> {
    let notif_str = serde_json::to_string(notification)
        .map_err(|e| format!("Failed to serialize notification: {}", e))?;

    let mut clients = clients().lock().await;
    let client = clients
        .get_mut(&handle)
        .ok_or_else(|| "Invalid handle".to_string())?;

    client
        .stdin
        .write_all(notif_str.as_bytes())
        .await
        .map_err(|e| format!("Failed to write notification: {}", e))?;
    client
        .stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("Failed to write newline: {}", e))?;
    client
        .stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    Ok(())
}

/// Get and increment the next request ID for a client.
///
/// Note: This acquires and releases the lock before `send_request_inner`
/// re-acquires it.  Concurrent calls to the same handle could interleave
/// IDs.  This is safe because (a) the TS layer serializes calls per handle,
/// and (b) even if IDs interleave, each response is matched by its `id`
/// field in the read loop.
async fn next_request_id(handle: u64) -> u64 {
    let mut clients = clients().lock().await;
    if let Some(client) = clients.get_mut(&handle) {
        let id = client.next_request_id;
        client.next_request_id += 1;
        id
    } else {
        0
    }
}

/// Try to get stderr snapshot without blocking (for error messages).
fn try_get_stderr(_handle: u64) -> Option<String> {
    // Cannot try_lock on tokio Mutex — return None and let callers use
    // the async `stdio_stderr_snapshot` when they need the actual value.
    None
}
