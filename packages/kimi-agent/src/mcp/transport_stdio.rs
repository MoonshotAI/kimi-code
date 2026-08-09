/// MCP stdio transport client.
///
/// Mirrors the TS `packages/agent-core/src/mcp/client-stdio.ts` (which wraps
/// the official MCP SDK): spawns the server as a child process, then speaks
/// line-delimited JSON-RPC over stdin/stdout.
///
/// Protocol negotiation (2026-07-28): `connect` first probes with
/// `server/discover`; a server that supports `2026-07-28` runs stateless
/// (no handshake, `_meta` protocol metadata on every request). Older servers
/// answer the probe with `-32601`/`-32022` and the client falls back to the
/// `initialize` → `notifications/initialized` handshake.
///
/// Protocol correctness notes ported from the SDK client:
/// - A dedicated reader thread owns stdout, so buffered bytes are never lost
///   between requests, and responses are matched by JSON-RPC `id` — server
///   notifications and interleaved messages are skipped, `ping` requests from
///   the server are answered.
/// - The child env is rebuilt from an allowlist (plus the config's own `env`,
///   which always wins) so API keys and tokens never leak into MCP servers.
/// - The last few KB of the child's stderr are retained so connection
///   failures can carry a diagnostic tail (see
///   `connection_manager::format_startup_error`).
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::mcp::types::*;

/// Default per-request timeout (TS SDK: `DEFAULT_REQUEST_TIMEOUT_MSEC`).
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;

/// Capacity of the retained stderr tail (TS: `STDERR_BUFFER_CAPACITY`).
const STDERR_BUFFER_CAPACITY: usize = 4 * 1024;

/// Environment variables inherited from the parent process verbatim.
/// Everything else — API keys, tokens, secrets — is excluded unless the
/// server config's own `env` sets it (TS: `ALLOWED_ENV_EXACT`).
const ALLOWED_ENV_EXACT: &[&str] = &[
    "HOME",
    "LANG",
    "NODE_PATH",
    "PATH",
    "SHELL",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "USERNAME",
];

/// Inherited prefixes (TS: `ALLOWED_ENV_PREFIXES`).
const ALLOWED_ENV_PREFIXES: &[&str] = &["KIMI_", "LC_"];

/// Windows system variables a child process cannot function without (Node's
/// CSPRNG needs `SYSTEMROOT`, for one). libuv re-adds these to every spawned
/// child even when an explicit env is given — which is why the TS client's
/// allowlist works on Windows — but Rust's `std::process` does not, so the
/// port inherits them explicitly. Mirrors libuv's `required_vars`
/// (src/win/process.c); case-insensitive like the Windows environment itself.
#[cfg(windows)]
const WINDOWS_REQUIRED_ENV: &[&str] = &[
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];

/// Options for spawning an MCP stdio server.
#[derive(Debug, Clone, Default)]
pub struct StdioSpawnOptions {
    /// Extra environment from the server config; always wins over inherited
    /// values and is never filtered.
    pub env: Option<HashMap<String, String>>,
    /// Working directory from the server config; relative paths resolve
    /// against `default_cwd`.
    pub cwd: Option<String>,
    /// Fallback working directory (the session workspace).
    pub default_cwd: Option<String>,
    /// Client version reported in `initialize` (the host package version).
    pub client_version: Option<String>,
    /// Timeout for `initialize` and `tools/list` (TS: `startupTimeoutMs`).
    pub startup_timeout_ms: Option<u64>,
    /// Timeout for `tools/call` (TS: `toolCallTimeoutMs`).
    pub tool_call_timeout_ms: Option<u64>,
}

/// An MCP stdio transport client. Lifecycle is explicit: `spawn` starts the
/// child, `connect` performs the MCP handshake, `shutdown` (or drop) kills it.
pub struct MCPStdioTransport {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// Parsed JSON messages from the reader thread that owns stdout.
    messages: Option<Receiver<serde_json::Value>>,
    /// Bounded tail of the child's stderr, drained by its own thread.
    stderr_tail: Arc<Mutex<String>>,
    next_id: u64,
    startup_timeout_ms: u64,
    tool_call_timeout_ms: u64,
    client_version: String,
    /// Set by `connect` from the server's `initialize` response (legacy
    /// mode) or the negotiated `2026-07-28` revision (stateless mode).
    server_protocol_version: Option<String>,
    /// Negotiated protocol era; `None` until `connect` succeeds.
    mode: Option<McpProtocolMode>,
    /// Active `subscriptions/listen` subscription ids (the JSON-RPC id of
    /// each `subscriptions/listen` request).
    listen_subscriptions: HashSet<u64>,
    /// Notifications received for active subscriptions, consumed by
    /// `drain_listen` (stdio shares one message channel, so listen traffic is
    /// collected as requests come and go and delivered on demand).
    listen_queue: VecDeque<(String, serde_json::Value)>,
}

impl MCPStdioTransport {
    /// Spawn the MCP server process. The MCP handshake is a separate step —
    /// call `connect` before issuing requests.
    pub fn spawn(
        command: &str,
        args: &[String],
        options: StdioSpawnOptions,
    ) -> Result<Self, String> {
        if command.is_empty() {
            return Err("MCP stdio command must not be empty".to_string());
        }
        let mut cmd = Command::new(command);
        cmd.args(args)
            .env_clear()
            .envs(merge_stdio_env(options.env.as_ref(), &parent_env()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = resolve_stdio_cwd(options.cwd.as_deref(), options.default_cwd.as_deref())
        {
            cmd.current_dir(cwd);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP server: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture stderr".to_string())?;

        // Reader thread: owns stdout so buffered bytes survive across
        // requests. Unparseable lines are skipped (stray server logging on
        // stdout must not poison the stream).
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed)
                            && tx.send(value).is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });

        // Stderr thread: the pipe MUST be drained (a full pipe blocks the
        // child); keep only the last few KB for diagnostics.
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buf = [0u8; 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]);
                        if let Ok(mut guard) = tail.lock() {
                            guard.push_str(&chunk);
                            if guard.len() > STDERR_BUFFER_CAPACITY {
                                let cut = guard.len() - STDERR_BUFFER_CAPACITY;
                                // Cut on a char boundary to keep the tail valid UTF-8.
                                let boundary =
                                    (cut..guard.len()).find(|i| guard.is_char_boundary(*i));
                                if let Some(boundary) = boundary {
                                    guard.drain(..boundary);
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            messages: Some(rx),
            stderr_tail,
            next_id: 1,
            startup_timeout_ms: options
                .startup_timeout_ms
                .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS),
            tool_call_timeout_ms: options
                .tool_call_timeout_ms
                .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS),
            client_version: options
                .client_version
                .unwrap_or_else(|| "0.0.0".to_string()),
            server_protocol_version: None,
            mode: None,
            listen_subscriptions: HashSet::new(),
            listen_queue: VecDeque::new(),
        })
    }

    /// Negotiate the protocol era: probe with `server/discover`, adopt the
    /// stateless `2026-07-28` mode when supported, otherwise fall back to the
    /// legacy `initialize` → `notifications/initialized` handshake.
    /// Idempotent: a second call is a no-op once negotiation succeeded.
    pub fn connect(&mut self) -> Result<(), String> {
        if self.server_protocol_version.is_some() {
            return Ok(());
        }
        match self.try_stateless_discover() {
            Ok(()) => {
                self.server_protocol_version = Some(MCP_PROTOCOL_VERSION.to_string());
                self.mode = Some(McpProtocolMode::Stateless2026);
                Ok(())
            }
            Err(error) if is_discover_fallback(&error) => {
                self.legacy_initialize()?;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    /// Probe with `server/discover`. Success requires the server to advertise
    /// `2026-07-28` in `supportedProtocolVersions`. Older servers return a
    /// JSON-RPC error (`-32601` method not found) or an unsupported-version
    /// error, which `connect` treats as a fallback signal.
    fn try_stateless_discover(&mut self) -> Result<(), String> {
        let response = self.send_request("server/discover", serde_json::json!({}), self.startup_timeout_ms)?;
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
    /// handshake. The server negotiates down to its own revision; the client
    /// accepts whatever it answers with.
    fn legacy_initialize(&mut self) -> Result<(), String> {
        let params = serde_json::json!({
            "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": MCP_CLIENT_NAME,
                "version": self.client_version,
            },
        });
        let result = self.send_request("initialize", params, self.startup_timeout_ms)?;
        let protocol_version = result
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "MCP initialize response has no protocolVersion".to_string())?
            .to_string();
        self.send_notification("notifications/initialized", serde_json::json!({}))?;
        self.server_protocol_version = Some(protocol_version);
        self.mode = Some(McpProtocolMode::Legacy);
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

    /// Call the MCP `tools/list` endpoint.
    pub fn list_tools(&mut self) -> Result<MCPToolsListResult, String> {
        let response =
            self.send_request("tools/list", serde_json::json!({}), self.startup_timeout_ms)?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/list response: {e}"))
    }

    /// Call the MCP `tools/call` endpoint. In stateless mode the request
    /// carries `_meta` protocol metadata; an `input_required` result
    /// (MRTR, 2026-07-28) is resolved as follows: an empty `inputRequests`
    /// list is a retry signal and is retried once; a non-empty list asks the
    /// client for input this engine cannot gather mid-call, so it becomes a
    /// descriptive error.
    pub fn call_tool(
        &mut self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });
        let response = self.send_request("tools/call", params, self.tool_call_timeout_ms)?;
        if result_type_of(&response) == RESULT_TYPE_INPUT_REQUIRED {
            return self.resolve_input_required(&response, name, arguments);
        }
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// Resolve an MRTR `input_required` result: retry once — answering
    /// auto-answerable `inputRequests` (`roots/list`) with their responses,
    /// or re-issuing verbatim when the server asked for no input (an empty
    /// `inputRequests` map, e.g. load shedding). Any request type the engine
    /// cannot answer mid-call (sampling, elicitation) surfaces a descriptive
    /// error instead of guessing.
    fn resolve_input_required(
        &mut self,
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
        let retry = self.send_request("tools/call", params, self.tool_call_timeout_ms)?;
        if result_type_of(&retry) == RESULT_TYPE_INPUT_REQUIRED {
            let required: MCPInputRequiredResult = serde_json::from_value(retry.clone())
                .map_err(|e| format!("Failed to parse input_required result: {e}"))?;
            return Err(input_required_error(&required, true));
        }
        serde_json::from_value(retry)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// The retained tail of the child's stderr — attach to startup and
    /// unexpected-close diagnostics.
    pub fn stderr_snapshot(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Open a `subscriptions/listen` subscription (2026-07-28 stateless mode
    /// only). Stdio shares one message channel, so the server's
    /// acknowledgment and subsequent notifications are captured by the next
    /// request's read loop and collected for `drain_listen`. Returns the
    /// subscription id (the request id) on success.
    pub fn start_listen(&mut self, notifications: &serde_json::Value) -> Result<u64, String> {
        if self.mode != Some(McpProtocolMode::Stateless2026) {
            return Err(
                "subscriptions/listen requires the 2026-07-28 protocol (stateless mode)".to_string(),
            );
        }
        let mut params = serde_json::json!({ "notifications": notifications });
        inject_protocol_meta(&mut params, &self.client_version);
        let id = self.next_id;
        self.next_id += 1;
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(id),
            method: "subscriptions/listen".into(),
            params: Some(params),
        };
        self.write_message(&serde_json::to_value(&request).map_err(|e| e.to_string())?)?;
        self.listen_subscriptions.insert(id);
        Ok(id)
    }

    /// Drain the notifications collected for active subscriptions as
    /// `(method, params)` pairs. A `Closed` marker is not surfaced — callers
    /// discover closure via the transport itself; a vanished server is
    /// detected by the next request's failure.
    pub fn drain_listen(&mut self) -> Vec<(String, serde_json::Value)> {
        self.listen_queue.drain(..).collect()
    }

    /// The active subscription id a message belongs to, if any: read from
    /// `params._meta` (notifications) or `result._meta` (graceful-close
    /// responses to the `subscriptions/listen` request).
    fn listen_subscription_of(&self, message: &serde_json::Value) -> Option<u64> {
        let meta = message
            .get("params")
            .and_then(|p| p.get("_meta"))
            .or_else(|| message.get("result").and_then(|r| r.get("_meta")))?;
        let id = meta.get(META_SUBSCRIPTION_ID)?;
        let id: u64 = serde_json::from_value(id.clone()).ok()?;
        self.listen_subscriptions.contains(&id).then_some(id)
    }

    /// Send a JSON-RPC request and await the response matching its id.
    /// Notifications and interleaved messages are skipped; `ping` requests
    /// from the server are answered inline. In stateless mode the request
    /// params carry `_meta` protocol metadata.
    fn send_request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        let mut params = params;
        if self.mode == Some(McpProtocolMode::Stateless2026) || method == "server/discover" {
            // The probe is sent as a modern request and must carry the
            // `_meta` protocol metadata like any other stateless request.
            inject_protocol_meta(&mut params, &self.client_version);
        }
        let id = self.next_id;
        self.next_id += 1;
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(id),
            method: method.into(),
            params: Some(params),
        };
        self.write_message(&serde_json::to_value(&request).map_err(|e| e.to_string())?)?;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "MCP request '{method}' timed out after {timeout_ms}ms"
                ));
            }
            let recv_result = {
                let receiver = self
                    .messages
                    .as_ref()
                    .ok_or_else(|| "Transport not connected".to_string())?;
                receiver.recv_timeout(remaining)
            };
            let message = match recv_result {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "MCP request '{method}' timed out after {timeout_ms}ms"
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.with_stderr_tail(format!(
                        "MCP server closed the connection during '{method}'"
                    )));
                }
            };

            if let Some(server_method) = message.get("method").and_then(|m| m.as_str()) {
                // With an id it is a server → client request: answer pings,
                // reject the rest. Without one it is a notification: capture
                // it when it belongs to an active subscription.
                if let Some(server_id) = message.get("id") {
                    let reply = if server_method == "ping" {
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": server_id,
                            "result": {},
                        })
                    } else {
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": server_id,
                            "error": { "code": -32601, "message": "Method not found" },
                        })
                    };
                    self.write_message(&reply)?;
                } else if server_method != NOTIFICATION_SUBSCRIPTIONS_ACKNOWLEDGED
                    && self.listen_subscription_of(&message).is_some()
                {
                    let params = message
                        .get("params")
                        .cloned()
                        .unwrap_or(serde_json::json!({}));
                    self.listen_queue
                        .push_back((server_method.to_string(), params));
                }
                continue;
            }

            // A response to a `subscriptions/listen` request (graceful close):
            // the subscription ended on the server's initiative.
            if let Some(subscription_id) = self.listen_subscription_of(&message) {
                self.listen_subscriptions.remove(&subscription_id);
                continue;
            }

            let matches_id = message.get("id").map(|v| v == &serde_json::json!(id)) == Some(true);
            if !matches_id {
                // A response to some other (stale) request: skip.
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

    /// Send a JSON-RPC notification (no id, no response expected).
    fn send_notification(&mut self, method: &str, params: serde_json::Value) -> Result<(), String> {
        self.write_message(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn write_message(&mut self, message: &serde_json::Value) -> Result<(), String> {
        let json = serde_json::to_string(message).map_err(|e| format!("Serialize error: {e}"))?;
        let result = {
            let stdin = self
                .stdin
                .as_mut()
                .ok_or_else(|| "Transport not connected".to_string())?;
            writeln!(stdin, "{json}").and_then(|()| stdin.flush())
        };
        // A broken pipe here means the child died; attach its stderr tail so
        // the failure carries the actual diagnostic, not just EPIPE.
        result.map_err(|e| self.with_stderr_tail(format!("Failed to write to stdin: {e}")))
    }

    /// Format a dead-child error with the stderr tail attached. Waits briefly
    /// for the child to exit and its stderr drain to finish so the tail is
    /// complete — whichever syscall noticed the death first (read EOF or
    /// write EPIPE), the user sees the server's own last words.
    fn with_stderr_tail(&mut self, base: String) -> String {
        if let Some(child) = self.child.as_mut() {
            for _ in 0..25 {
                match child.try_wait() {
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    Ok(Some(_)) | Err(_) => break,
                }
            }
        }
        // One extra beat for the stderr thread to push its final chunk.
        std::thread::sleep(Duration::from_millis(20));
        let stderr = self.stderr_snapshot();
        if stderr.is_empty() {
            base
        } else {
            format!("{base}\nServer stderr:\n{}", stderr.trim_end())
        }
    }

    /// Close the transport, killing the child process.
    pub fn shutdown(&mut self) -> Result<(), String> {
        self.stdin = None;
        self.messages = None;
        if let Some(mut child) = self.child.take() {
            child
                .kill()
                .map_err(|e| format!("Failed to kill process: {e}"))?;
            child
                .wait()
                .map_err(|e| format!("Failed to wait for process: {e}"))?;
        }
        Ok(())
    }
}

impl Drop for MCPStdioTransport {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn parent_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

fn is_allowed_env_var(key: &str) -> bool {
    ALLOWED_ENV_EXACT.contains(&key)
        || ALLOWED_ENV_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

/// Merge parent and config environment for an MCP stdio child process
/// (TS: `mergeStdioEnv`). Only allowlisted parent variables are inherited;
/// config values always win. When the merged env carries an HTTP(S) proxy —
/// which can only come from config, proxy vars are not allowlisted —
/// `NODE_USE_ENV_PROXY=1` is injected so Node-based servers honour it
/// (TS: `proxyEnvForChild`; the `ALL_PROXY` synthesis is not ported).
pub fn merge_stdio_env(
    config_env: Option<&HashMap<String, String>>,
    parent_env: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut merged: HashMap<String, String> = parent_env
        .iter()
        .filter(|(key, _)| is_allowed_env_var(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    #[cfg(windows)]
    for (key, value) in parent_env {
        if WINDOWS_REQUIRED_ENV
            .iter()
            .any(|req| req.eq_ignore_ascii_case(key))
        {
            merged.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    if let Some(config_env) = config_env {
        for (key, value) in config_env {
            merged.insert(key.clone(), value.clone());
        }
    }
    let has_http_proxy = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]
        .iter()
        .any(|key| merged.get(*key).is_some_and(|v| !v.is_empty()));
    if has_http_proxy && !merged.contains_key("NODE_USE_ENV_PROXY") {
        merged.insert("NODE_USE_ENV_PROXY".to_string(), "1".to_string());
    }
    merged
}

/// Resolve the child working directory (TS: `resolveStdioCwd`): the config
/// `cwd` wins, resolving relative paths against the session workspace.
pub fn resolve_stdio_cwd(config_cwd: Option<&str>, default_cwd: Option<&str>) -> Option<String> {
    match config_cwd {
        None => default_cwd.map(|s| s.to_string()),
        Some(cwd) => {
            if Path::new(cwd).is_absolute() {
                return Some(cwd.to_string());
            }
            match default_cwd {
                Some(base) => Some(Path::new(base).join(cwd).to_string_lossy().into_owned()),
                None => Some(cwd.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn env_merge_inherits_only_allowlisted_parent_vars() {
        let parent = env_map(&[
            ("PATH", "/bin"),
            ("KIMI_HOME", "/kimi"),
            ("LC_ALL", "C"),
            ("OPENAI_API_KEY", "sk-secret"),
            ("AWS_SECRET_ACCESS_KEY", "aws-secret"),
        ]);
        let merged = merge_stdio_env(None, &parent);
        assert_eq!(merged.get("PATH").map(String::as_str), Some("/bin"));
        assert_eq!(merged.get("KIMI_HOME").map(String::as_str), Some("/kimi"));
        assert_eq!(merged.get("LC_ALL").map(String::as_str), Some("C"));
        assert!(!merged.contains_key("OPENAI_API_KEY"));
        assert!(!merged.contains_key("AWS_SECRET_ACCESS_KEY"));
    }

    #[test]
    fn env_merge_config_values_always_win_and_are_never_filtered() {
        let parent = env_map(&[("PATH", "/bin")]);
        let config = env_map(&[("MY_TOKEN", "t"), ("PATH", "/custom")]);
        let merged = merge_stdio_env(Some(&config), &parent);
        assert_eq!(merged.get("MY_TOKEN").map(String::as_str), Some("t"));
        assert_eq!(merged.get("PATH").map(String::as_str), Some("/custom"));
    }

    #[test]
    fn env_merge_injects_node_use_env_proxy_for_config_proxies() {
        let parent = env_map(&[]);
        let config = env_map(&[("HTTPS_PROXY", "http://proxy:8080")]);
        let merged = merge_stdio_env(Some(&config), &parent);
        assert_eq!(
            merged.get("NODE_USE_ENV_PROXY").map(String::as_str),
            Some("1")
        );

        let no_proxy = merge_stdio_env(None, &parent);
        assert!(!no_proxy.contains_key("NODE_USE_ENV_PROXY"));
    }

    #[test]
    fn cwd_resolution_prefers_config_and_resolves_relative_against_default() {
        assert_eq!(
            resolve_stdio_cwd(None, Some("/ws")),
            Some("/ws".to_string())
        );
        assert_eq!(resolve_stdio_cwd(None, None), None);
        let resolved = resolve_stdio_cwd(Some("sub"), Some("/ws")).unwrap();
        assert!(resolved.replace('\\', "/").ends_with("ws/sub"));
        #[cfg(windows)]
        assert_eq!(
            resolve_stdio_cwd(Some(r"C:\abs"), Some(r"C:\ws")),
            Some(r"C:\abs".to_string())
        );
        #[cfg(not(windows))]
        assert_eq!(
            resolve_stdio_cwd(Some("/abs"), Some("/ws")),
            Some("/abs".to_string())
        );
    }

    /// End-to-end negotiation + request matching against a scripted MCP server
    /// (Node inline): a legacy server that answers `server/discover` with
    /// `-32601` (method not found), forcing the initialize-handshake fallback.
    /// Skipped when `node` is unavailable.
    #[test]
    fn legacy_server_falls_back_to_initialize_handshake() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node not available");
            return;
        }
        // The server rejects discover, answers initialize, emits a stray
        // notification and an unparseable log line (both must be skipped),
        // then serves tools/list and tools/call.
        let script = r#"
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
  } else if (msg.method === 'notifications/initialized') {
    // notification: no response
  } else if (msg.method === 'tools/list') {
    process.stdout.write('this line is not JSON and must be skipped\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    } }) + '\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: 'echo:' + msg.params.arguments.value }],
    } }) + '\n');
  }
});
"#;
        let mut transport = MCPStdioTransport::spawn(
            "node",
            &["-e".to_string(), script.to_string()],
            StdioSpawnOptions {
                startup_timeout_ms: Some(15_000),
                tool_call_timeout_ms: Some(15_000),
                ..Default::default()
            },
        )
        .expect("spawn");

        transport.connect().expect("handshake");
        assert_eq!(transport.mode(), Some(McpProtocolMode::Legacy));
        assert_eq!(
            transport.server_protocol_version(),
            Some(MCP_LEGACY_PROTOCOL_VERSION)
        );

        let tools = transport.list_tools().expect("tools/list");
        assert_eq!(tools.tools.len(), 1);
        assert_eq!(tools.tools[0].name, "echo");

        let result = transport
            .call_tool("echo", Some(serde_json::json!({ "value": "hi" })))
            .expect("tools/call");
        let text = mcp_content_to_text(&result.content);
        assert_eq!(text, "echo:hi");

        transport.shutdown().expect("shutdown");
    }

    /// End-to-end stateless negotiation + request matching against a
    /// scripted 2026-07-28 server: `server/discover` is answered, no
    /// initialize handshake happens, and every request carries `_meta`
    /// protocol metadata.
    #[test]
    fn stateless_discover_negotiation_and_meta_carry() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let sawInitialize = false;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') { sawInitialize = true; }
  if (msg.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2026-07-28',
      capabilities: {}, serverInfo: { name: 'scripted-modern', version: '1.0.0' },
      supportedProtocolVersions: ['2026-07-28'],
    } }) + '\n');
  } else if (msg.method === 'tools/list') {
    const meta = (msg.params && msg.params._meta) || {};
    if (meta['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
      process.stderr.write('tools/list missing _meta protocolVersion\n');
    }
    if (!meta['io.modelcontextprotocol/clientInfo']) {
      process.stderr.write('tools/list missing _meta clientInfo\n');
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'complete',
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    } }) + '\n');
  } else if (msg.method === 'tools/call') {
    const meta = (msg.params && msg.params._meta) || {};
    if (meta['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
      process.stderr.write('tools/call missing _meta protocolVersion\n');
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'complete',
      content: [{ type: 'text', text: 'echo:' + msg.params.arguments.value }],
    } }) + '\n');
  } else if (msg.method === 'notifications/initialized') {
    sawInitialize = true;
  }
  if (sawInitialize) {
    process.stderr.write('client must not run the initialize handshake in stateless mode\n');
  }
});
"#;
        let mut transport = MCPStdioTransport::spawn(
            "node",
            &["-e".to_string(), script.to_string()],
            StdioSpawnOptions {
                startup_timeout_ms: Some(15_000),
                tool_call_timeout_ms: Some(15_000),
                ..Default::default()
            },
        )
        .expect("spawn");

        transport.connect().expect("negotiation");
        assert_eq!(transport.mode(), Some(McpProtocolMode::Stateless2026));
        assert_eq!(transport.server_protocol_version(), Some(MCP_PROTOCOL_VERSION));

        let tools = transport.list_tools().expect("tools/list");
        assert_eq!(tools.tools.len(), 1);
        assert_eq!(tools.tools[0].name, "echo");

        let result = transport
            .call_tool("echo", Some(serde_json::json!({ "value": "hi" })))
            .expect("tools/call");
        let text = mcp_content_to_text(&result.content);
        assert_eq!(text, "echo:hi");

        transport.shutdown().expect("shutdown");
    }

    /// MRTR (2026-07-28): a `tools/call` answered with an `input_required`
    /// result carrying an empty `inputRequests` list is a retry signal; the
    /// client retries once and gets the final result. A non-empty list
    /// becomes a descriptive error (the engine cannot gather input).
    #[test]
    fn input_required_retry_signal_is_retried_once() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let callCount = 0;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2026-07-28',
      capabilities: {}, serverInfo: { name: 'scripted-mrtr', version: '1.0.0' },
      supportedProtocolVersions: ['2026-07-28'],
    } }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'complete',
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    } }) + '\n');
  } else if (msg.method === 'tools/call') {
    callCount += 1;
    if (callCount === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        resultType: 'input_required', inputRequests: {},
      } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'echo:' + msg.params.arguments.value }],
      } }) + '\n');
    }
  }
});
"#;
        let mut transport = MCPStdioTransport::spawn(
            "node",
            &["-e".to_string(), script.to_string()],
            StdioSpawnOptions {
                startup_timeout_ms: Some(15_000),
                tool_call_timeout_ms: Some(15_000),
                ..Default::default()
            },
        )
        .expect("spawn");

        transport.connect().expect("negotiation");
        let result = transport
            .call_tool("echo", Some(serde_json::json!({ "value": "hi" })))
            .expect("tools/call");
        assert_eq!(mcp_content_to_text(&result.content), "echo:hi");
        transport.shutdown().expect("shutdown");
    }

    /// MRTR (2026-07-28): a non-empty `inputRequests` list asks the client
    /// for input the engine cannot gather — the call becomes a descriptive
    /// error.
    #[test]
    fn input_required_with_requests_is_a_descriptive_error() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2026-07-28',
      capabilities: {}, serverInfo: { name: 'scripted-mrtr', version: '1.0.0' },
      supportedProtocolVersions: ['2026-07-28'],
    } }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'complete',
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    } }) + '\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'input_required',
      inputRequests: { 'req-1': { method: 'sampling/createMessage', description: 'pick a number' } },
    } }) + '\n');
  }
});
"#;
        let mut transport = MCPStdioTransport::spawn(
            "node",
            &["-e".to_string(), script.to_string()],
            StdioSpawnOptions {
                startup_timeout_ms: Some(15_000),
                tool_call_timeout_ms: Some(15_000),
                ..Default::default()
            },
        )
        .expect("spawn");

        transport.connect().expect("negotiation");
        let error = transport
            .call_tool("echo", Some(serde_json::json!({ "value": "hi" })))
            .expect_err("input_required must not dispatch");
        assert!(error.contains("pick a number"), "got: {error}");
        assert!(error.contains("cannot answer automatically"), "got: {error}");
        transport.shutdown().expect("shutdown");
    }

    /// `subscriptions/listen` on stdio (2026-07-28): the server acknowledges
    /// and delivers a `notifications/tools/list_changed` on the shared
    /// channel; the client captures it during the next request's read loop
    /// and surfaces it via `drain_listen`.
    #[test]
    fn listen_subscription_captures_notifications() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2026-07-28',
      capabilities: {}, serverInfo: { name: 'scripted-listen', version: '1.0.0' },
      supportedProtocolVersions: ['2026-07-28'],
    } }) + '\n');
  } else if (msg.method === 'subscriptions/listen') {
    const ack = { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
      params: { notifications: { toolsListChanged: true },
        _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id } } };
    process.stdout.write(JSON.stringify(ack) + '\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed',
        params: { _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id } } }) + '\n');
    }, 100);
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'complete',
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    } }) + '\n');
  }
});
"#;
        let mut transport = MCPStdioTransport::spawn(
            "node",
            &["-e".to_string(), script.to_string()],
            StdioSpawnOptions {
                startup_timeout_ms: Some(15_000),
                tool_call_timeout_ms: Some(15_000),
                ..Default::default()
            },
        )
        .expect("spawn");

        transport.connect().expect("negotiation");
        assert_eq!(transport.mode(), Some(McpProtocolMode::Stateless2026));

        // Open the subscription, then run another request so the read loop
        // collects the acknowledgment and the delayed notification.
        let subscription_id = transport
            .start_listen(&serde_json::json!({ LISTEN_TOOLS_LIST_CHANGED: true }))
            .expect("start_listen");
        let tools = transport.list_tools().expect("tools/list");
        assert_eq!(tools.tools.len(), 1);

        // The notification arrives asynchronously (100ms delay in the
        // script); keep polling the channel with short reads until it lands.
        let mut drained: Vec<(String, serde_json::Value)> = Vec::new();
        for _ in 0..50 {
            drained = transport.drain_listen();
            if drained.iter().any(|(m, _)| m == NOTIFICATION_TOOLS_LIST_CHANGED) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
            // Pump the channel by re-running a (cheap) request.
            let _ = transport.list_tools();
        }
        assert!(
            drained
                .iter()
                .any(|(m, _)| m == NOTIFICATION_TOOLS_LIST_CHANGED),
            "expected tools_list_changed, got: {drained:?}"
        );
        let _ = subscription_id;
        transport.shutdown().expect("shutdown");
    }

    #[test]
    fn reports_server_exit_as_disconnect_with_stderr_tail() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"process.stderr.write('boom: bad config\n'); process.exit(1);"#;
        let mut transport = MCPStdioTransport::spawn(
            "node",
            &["-e".to_string(), script.to_string()],
            StdioSpawnOptions {
                startup_timeout_ms: Some(15_000),
                ..Default::default()
            },
        )
        .expect("spawn");
        let error = transport.connect().expect_err("handshake must fail");
        // Depending on timing the death surfaces as a read EOF ("closed the
        // connection") or a write EPIPE; either way the stderr tail must ride
        // along.
        assert!(error.contains("Server stderr:"), "got: {error}");
        assert!(error.contains("boom: bad config"), "got: {error}");
    }
}

    /// MRTR (2026-07-28): a `roots/list` input request is auto-answered with
    /// an empty roots list, and the original `tools/call` is retried with
    /// the `inputResponses` map.
    #[test]
    fn input_required_roots_request_is_answered_and_retried() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipping: node not available");
            return;
        }
        let script = r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2026-07-28',
      capabilities: {}, serverInfo: { name: 'scripted-roots', version: '1.0.0' },
      supportedProtocolVersions: ['2026-07-28'],
    } }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'complete',
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    } }) + '\n');
  } else if (msg.method === 'tools/call') {
    if (msg.params && msg.params.inputResponses) {
      const answers = msg.params.inputResponses['req-1'];
      if (answers && Array.isArray(answers.roots) && answers.roots.length === 0) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          resultType: 'complete', content: [{ type: 'text', text: 'roots answered' }],
        } }) + '\n');
        return;
      }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      resultType: 'input_required',
      inputRequests: { 'req-1': { method: 'roots/list', description: 'workspace roots' } },
      requestState: 'rs-1',
    } }) + '\n');
  }
});
"#;
        let mut transport = MCPStdioTransport::spawn(
            "node",
            &["-e".to_string(), script.to_string()],
            StdioSpawnOptions {
                startup_timeout_ms: Some(15_000),
                tool_call_timeout_ms: Some(15_000),
                ..Default::default()
            },
        )
        .expect("spawn");

        transport.connect().expect("negotiation");
        let result = transport
            .call_tool("echo", Some(serde_json::json!({ "value": "hi" })))
            .expect("tools/call retried with inputResponses");
        assert_eq!(mcp_content_to_text(&result.content), "roots answered");
        transport.shutdown().expect("shutdown");
    }
