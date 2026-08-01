/// `mcp` connection manager — the per-session server orchestration state.
///
/// Port of `packages/agent-core-v2/src/agent/mcp/connection-manager.ts`.
///
/// The transports themselves (stdio / SSE / HTTP), the OAuth provider, and the
/// timers are host I/O; what lives here is the decision core the TS manager
/// wraps around them:
///
/// - the status machine (`pending` / `pending-approval` / `connected` /
///   `failed` / `disabled` / `needs-auth`) and every legal transition,
/// - the **attempt-id staleness guard**: every (re)connect bumps a counter,
///   and a completion belonging to an older attempt must be discarded —
///   without this, a slow first connect can clobber the state of the
///   reconnect that superseded it,
/// - stdio-from-`.mcp.json` approval gating (a checked-in file is untrusted
///   until the user approves it),
/// - the enabled-tool filter, the 401/unauthorized classification, and the
///   error strings.
use std::collections::{HashMap, HashSet};

pub const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 30_000;

/// Where a server's configuration came from (TS `McpConfigSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpConfigSource {
    /// `<repoRoot>/.mcp.json` — typically checked into git, untrusted.
    ProjectRoot,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpTransport {
    Stdio,
    Sse,
    Http,
}

impl McpTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            McpTransport::Stdio => "stdio",
            McpTransport::Sse => "sse",
            McpTransport::Http => "http",
        }
    }

    /// Remote transports may carry OAuth (TS `isRemoteMcpConfig`).
    pub fn is_remote(self) -> bool {
        matches!(self, McpTransport::Sse | McpTransport::Http)
    }
}

/// The subset of `McpServerConfig` the decision core reads.
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub transport: McpTransport,
    pub enabled: bool,
    pub url: Option<String>,
    pub startup_timeout_ms: Option<u64>,
    pub tool_timeout_ms: Option<u64>,
    pub enabled_tools: Option<Vec<String>>,
    pub disabled_tools: Option<Vec<String>>,
    pub bearer_token_env_var: Option<String>,
    pub has_headers: bool,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            transport: McpTransport::Stdio,
            enabled: true,
            url: None,
            startup_timeout_ms: None,
            tool_timeout_ms: None,
            enabled_tools: None,
            disabled_tools: None,
            bearer_token_env_var: None,
            has_headers: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpServerStatus {
    Pending,
    PendingApproval,
    Connected,
    Failed,
    Disabled,
    NeedsAuth,
}

impl McpServerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            McpServerStatus::Pending => "pending",
            McpServerStatus::PendingApproval => "pending-approval",
            McpServerStatus::Connected => "connected",
            McpServerStatus::Failed => "failed",
            McpServerStatus::Disabled => "disabled",
            McpServerStatus::NeedsAuth => "needs-auth",
        }
    }
}

/// The public per-server view (TS `McpServerEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerEntry {
    pub name: String,
    pub transport: McpTransport,
    pub status: McpServerStatus,
    pub tool_count: usize,
    pub error: Option<String>,
}

#[derive(Debug)]
struct InternalEntry {
    name: String,
    config: McpServerConfig,
    attempt_id: u64,
    status: McpServerStatus,
    tool_names: Option<Vec<String>>,
    enabled_names: Option<HashSet<String>>,
    error: Option<String>,
}

impl InternalEntry {
    fn clear_tools(&mut self) {
        self.tool_names = None;
        self.enabled_names = None;
    }
}

/// A handle for reporting one connect attempt's outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectAttempt {
    pub attempt_id: u64,
}

/// The decision core of the TS `McpConnectionManager`.
///
/// Registration and every attempt-outcome report happen synchronously here;
/// the caller performs the actual I/O between `begin_*` and `report_*`.
#[derive(Debug, Default)]
pub struct McpConnectionState {
    entries: HashMap<String, InternalEntry>,
    oauth_available: bool,
    /// Workspace trust (C6, upstream #2453). When `false` (default), stdio
    /// servers from the repo's own `.mcp.json` are held in `pending-approval`;
    /// a trusted workspace connects them immediately.
    workspace_trusted: bool,
}

impl McpConnectionState {
    pub fn new(oauth_available: bool) -> Self {
        Self { entries: HashMap::new(), oauth_available, workspace_trusted: false }
    }

    /// Set whether the workspace is trusted. Trusting the workspace lifts the
    /// approval gate on stdio servers from the project root (upstream
    /// workspace-trust, #2453).
    pub fn set_workspace_trusted(&mut self, trusted: bool) {
        self.workspace_trusted = trusted;
    }

    // ── Registration ──────────────────────────────────────────────────────

    /// Register a server (TS `connectAllNow`'s per-entry setup).
    ///
    /// Returns the attempt to run, or `None` when the server must not connect
    /// yet (disabled, or held in `pending-approval`).
    pub fn register(
        &mut self,
        name: &str,
        config: McpServerConfig,
        source: McpConfigSource,
    ) -> Option<ConnectAttempt> {
        let disabled = !config.enabled;
        // Stdio servers from the repo's own .mcp.json are untrusted: the file
        // is typically checked into git, so hold them until the user approves
        // the workspace (workspace trust, #2453) or approves this server.
        let needs_approval = !disabled
            && config.transport == McpTransport::Stdio
            && source == McpConfigSource::ProjectRoot
            && !self.workspace_trusted;
        let status = if disabled {
            McpServerStatus::Disabled
        } else if needs_approval {
            McpServerStatus::PendingApproval
        } else {
            McpServerStatus::Pending
        };
        let entry = InternalEntry {
            name: name.to_string(),
            config,
            attempt_id: 0,
            status,
            tool_names: None,
            enabled_names: None,
            error: None,
        };
        self.entries.insert(name.to_string(), entry);
        if status != McpServerStatus::Pending {
            return None;
        }
        Some(self.begin_attempt(name).expect("just inserted"))
    }

    /// Approve a `pending-approval` server. Returns the attempt to run, or an
    /// error for an unknown server; an already-approved server returns `None`.
    pub fn approve_server(&mut self, name: &str) -> Result<Option<ConnectAttempt>, String> {
        let entry =
            self.entries.get_mut(name).ok_or_else(|| format!("Unknown MCP server: {name}"))?;
        if entry.status != McpServerStatus::PendingApproval {
            return Ok(None);
        }
        entry.status = McpServerStatus::Pending;
        Ok(Some(self.begin_attempt(name).expect("entry exists")))
    }

    /// Begin a reconnect (TS `reconnect` before its awaits): bumps the attempt,
    /// clears tools, and returns the attempt to run.
    pub fn begin_reconnect(&mut self, name: &str) -> Result<ConnectAttempt, String> {
        let entry =
            self.entries.get_mut(name).ok_or_else(|| format!("Unknown MCP server: {name}"))?;
        if !entry.config.enabled {
            return Err(format!("MCP server is disabled: {name}"));
        }
        entry.attempt_id += 1;
        let attempt = ConnectAttempt { attempt_id: entry.attempt_id };
        entry.status = McpServerStatus::Pending;
        entry.clear_tools();
        entry.error = None;
        Ok(attempt)
    }

    fn begin_attempt(&mut self, name: &str) -> Option<ConnectAttempt> {
        let entry = self.entries.get_mut(name)?;
        entry.attempt_id += 1;
        Some(ConnectAttempt { attempt_id: entry.attempt_id })
    }

    /// Remove a server entirely. Returns whether it existed.
    pub fn remove(&mut self, name: &str) -> bool {
        self.entries.remove(name).is_some()
    }

    // ── Attempt outcomes ──────────────────────────────────────────────────

    /// Whether `attempt` is still the entry's current attempt.
    pub fn is_current(&self, name: &str, attempt: ConnectAttempt) -> bool {
        self.entries.get(name).is_some_and(|entry| entry.attempt_id == attempt.attempt_id)
    }

    /// Report a successful connect + tool discovery.
    ///
    /// A stale attempt is discarded (returns `false`), which is the guard that
    /// keeps a slow first connect from clobbering the reconnect that
    /// superseded it.
    pub fn report_connected(
        &mut self,
        name: &str,
        attempt: ConnectAttempt,
        tool_names: Vec<String>,
    ) -> bool {
        if !self.is_current(name, attempt) {
            return false;
        }
        let Some(entry) = self.entries.get_mut(name) else { return false };
        entry.enabled_names = Some(compute_enabled_names(&entry.config, &tool_names));
        entry.tool_names = Some(tool_names);
        entry.status = McpServerStatus::Connected;
        entry.error = None;
        true
    }

    /// Report a failed connect. Classifies 401-like failures into `needs-auth`
    /// when OAuth could actually help.
    pub fn report_failed(
        &mut self,
        name: &str,
        attempt: ConnectAttempt,
        error_message: &str,
        unauthorized_like: bool,
    ) -> bool {
        if !self.is_current(name, attempt) {
            return false;
        }
        let oauth_available = self.oauth_available;
        let Some(entry) = self.entries.get_mut(name) else { return false };
        if should_mark_needs_auth(&entry.config, oauth_available, unauthorized_like) {
            entry.status = McpServerStatus::NeedsAuth;
            entry.error =
                Some(format!("{name} requires OAuth — run /mcp-config login {name}"));
        } else {
            entry.status = McpServerStatus::Failed;
            entry.error = Some(error_message.to_string());
        }
        entry.clear_tools();
        true
    }

    /// Report an unexpected close of a connected client.
    pub fn report_unexpected_close(
        &mut self,
        name: &str,
        attempt: ConnectAttempt,
        reason_error: Option<&str>,
        stderr: Option<&str>,
    ) -> bool {
        if !self.is_current(name, attempt) {
            return false;
        }
        let Some(entry) = self.entries.get_mut(name) else { return false };
        entry.status = McpServerStatus::Failed;
        entry.error = Some(format_unexpected_close_error(name, reason_error, stderr));
        entry.clear_tools();
        true
    }

    // ── Views ─────────────────────────────────────────────────────────────

    pub fn list(&self) -> Vec<McpServerEntry> {
        let mut entries: Vec<McpServerEntry> =
            self.entries.values().map(to_public_entry).collect();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        entries
    }

    pub fn get(&self, name: &str) -> Option<McpServerEntry> {
        self.entries.get(name).map(to_public_entry)
    }

    /// The enabled tool names of a connected server (TS `resolved().enabledNames`).
    pub fn enabled_tool_names(&self, name: &str) -> Option<HashSet<String>> {
        let entry = self.entries.get(name)?;
        if entry.status != McpServerStatus::Connected {
            return None;
        }
        match &entry.enabled_names {
            Some(names) => Some(names.clone()),
            None => entry.tool_names.as_ref().map(|all| all.iter().cloned().collect()),
        }
    }

    /// The remote URL of a server, when its transport is remote.
    pub fn remote_server_url(&self, name: &str) -> Option<&str> {
        let entry = self.entries.get(name)?;
        if !entry.config.transport.is_remote() {
            return None;
        }
        entry.config.url.as_deref()
    }

    /// The startup timeout to apply for a connect attempt.
    pub fn startup_timeout_ms(&self, name: &str, default_timeout_ms: Option<u64>) -> u64 {
        self.entries
            .get(name)
            .and_then(|entry| entry.config.startup_timeout_ms)
            .or(default_timeout_ms)
            .unwrap_or(DEFAULT_STARTUP_TIMEOUT_MS)
    }
}

fn to_public_entry(entry: &InternalEntry) -> McpServerEntry {
    McpServerEntry {
        name: entry.name.clone(),
        transport: entry.config.transport,
        status: entry.status,
        tool_count: match (&entry.status, &entry.enabled_names) {
            (McpServerStatus::Connected, Some(names)) => names.len(),
            _ => 0,
        },
        error: entry.error.clone(),
    }
}

/// Apply the per-server allow/deny tool filters (TS `computeEnabledNames`).
pub fn compute_enabled_names(config: &McpServerConfig, tool_names: &[String]) -> HashSet<String> {
    let enabled_filter: Option<HashSet<&String>> =
        config.enabled_tools.as_ref().map(|names| names.iter().collect());
    let disabled_filter: Option<HashSet<&String>> =
        config.disabled_tools.as_ref().map(|names| names.iter().collect());
    tool_names
        .iter()
        .filter(|name| enabled_filter.as_ref().is_none_or(|filter| filter.contains(name)))
        .filter(|name| disabled_filter.as_ref().is_none_or(|filter| !filter.contains(name)))
        .cloned()
        .collect()
}

/// Whether a failed connect should park in `needs-auth` instead of `failed`
/// (TS `shouldMarkNeedsAuth`): only when OAuth is available, the transport is
/// remote, and no explicit credential mechanism is already configured.
pub fn should_mark_needs_auth(
    config: &McpServerConfig,
    oauth_available: bool,
    unauthorized_like: bool,
) -> bool {
    oauth_available
        && config.transport.is_remote()
        && config.bearer_token_env_var.is_none()
        && !config.has_headers
        && unauthorized_like
}

/// TS `isUnauthorizedLikeError`, over an error name/code/message projection.
pub fn is_unauthorized_like(
    error_name: Option<&str>,
    error_code: Option<&str>,
    message: &str,
) -> bool {
    if error_name == Some("UnauthorizedError") {
        return true;
    }
    if error_code == Some("401") {
        return true;
    }
    has_word_401(message) || message.to_lowercase().contains("unauthorized")
}

/// `/\b401\b/` — 401 bounded by non-alphanumerics.
fn has_word_401(message: &str) -> bool {
    let bytes = message.as_bytes();
    let mut search_from = 0;
    while let Some(found) = message[search_from..].find("401") {
        let start = search_from + found;
        let end = start + 3;
        let left_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let right_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if left_ok && right_ok {
            return true;
        }
        search_from = start + 1;
    }
    false
}

/// TS `formatStartupError`: base message plus an optional stderr tail.
pub fn format_startup_error(base: &str, stderr_tail: Option<&str>) -> String {
    match stderr_tail.filter(|tail| !tail.is_empty()) {
        Some(tail) => format!("{base}\nstderr: {}", tail.trim_end()),
        None => base.to_string(),
    }
}

/// TS `formatUnexpectedCloseError`.
pub fn format_unexpected_close_error(
    name: &str,
    reason_error: Option<&str>,
    stderr: Option<&str>,
) -> String {
    let mut parts = vec![format!("MCP server \"{name}\" closed unexpectedly")];
    if let Some(error) = reason_error {
        parts.push(error.to_string());
    }
    if let Some(stderr) = stderr.filter(|tail| !tail.is_empty()) {
        parts.push(format!("stderr: {}", stderr.trim_end()));
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_config() -> McpServerConfig {
        McpServerConfig::default()
    }

    fn http_config(url: &str) -> McpServerConfig {
        McpServerConfig {
            transport: McpTransport::Http,
            url: Some(url.to_string()),
            ..Default::default()
        }
    }

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    // ── registration ──────────────────────────────────────────────────────

    #[test]
    fn a_normal_server_registers_pending_with_an_attempt() {
        let mut state = McpConnectionState::new(false);
        let attempt = state.register("srv", stdio_config(), McpConfigSource::Other);
        assert!(attempt.is_some());
        assert_eq!(state.get("srv").unwrap().status, McpServerStatus::Pending);
    }

    #[test]
    fn a_disabled_server_registers_disabled_with_no_attempt() {
        let mut state = McpConnectionState::new(false);
        let config = McpServerConfig { enabled: false, ..stdio_config() };
        assert!(state.register("srv", config, McpConfigSource::Other).is_none());
        assert_eq!(state.get("srv").unwrap().status, McpServerStatus::Disabled);
    }

    #[test]
    fn a_project_root_stdio_server_is_held_for_approval() {
        // A checked-in .mcp.json must not auto-launch processes.
        let mut state = McpConnectionState::new(false);
        assert!(state.register("srv", stdio_config(), McpConfigSource::ProjectRoot).is_none());
        assert_eq!(state.get("srv").unwrap().status, McpServerStatus::PendingApproval);
    }

    #[test]
    fn a_trusted_workspace_connects_project_root_stdio_immediately() {
        // Workspace trust (C6, #2453) lifts the approval gate on the repo's
        // own .mcp.json stdio servers.
        let mut state = McpConnectionState::new(false);
        state.set_workspace_trusted(true);
        let attempt = state.register("srv", stdio_config(), McpConfigSource::ProjectRoot);
        assert!(attempt.is_some());
        assert_eq!(state.get("srv").unwrap().status, McpServerStatus::Pending);
    }

    #[test]
    fn trust_is_off_by_default_and_can_be_revoked() {
        let mut state = McpConnectionState::new(false);
        state.set_workspace_trusted(true);
        state.set_workspace_trusted(false);
        assert!(state.register("srv", stdio_config(), McpConfigSource::ProjectRoot).is_none());
        assert_eq!(state.get("srv").unwrap().status, McpServerStatus::PendingApproval);
    }

    #[test]
    fn a_project_root_remote_server_connects_without_approval() {
        // Only stdio (process-launching) servers are gated.
        let mut state = McpConnectionState::new(false);
        let attempt =
            state.register("srv", http_config("https://x"), McpConfigSource::ProjectRoot);
        assert!(attempt.is_some());
    }

    #[test]
    fn approval_moves_the_server_to_pending_and_returns_an_attempt() {
        let mut state = McpConnectionState::new(false);
        state.register("srv", stdio_config(), McpConfigSource::ProjectRoot);
        let attempt = state.approve_server("srv").unwrap();
        assert!(attempt.is_some());
        assert_eq!(state.get("srv").unwrap().status, McpServerStatus::Pending);
        // A second approval is inert.
        assert!(state.approve_server("srv").unwrap().is_none());
        assert!(state.approve_server("nope").is_err());
    }

    // ── attempt outcomes ──────────────────────────────────────────────────

    #[test]
    fn a_successful_connect_reports_tools() {
        let mut state = McpConnectionState::new(false);
        let attempt = state.register("srv", stdio_config(), McpConfigSource::Other).unwrap();
        assert!(state.report_connected("srv", attempt, names(&["a", "b"])));
        let entry = state.get("srv").unwrap();
        assert_eq!(entry.status, McpServerStatus::Connected);
        assert_eq!(entry.tool_count, 2);
        assert_eq!(entry.error, None);
    }

    #[test]
    fn a_stale_attempt_cannot_clobber_a_newer_one() {
        // Regression guard for the attempt-id race: the slow first connect
        // completes after a reconnect superseded it, and must be discarded.
        let mut state = McpConnectionState::new(false);
        let first = state.register("srv", stdio_config(), McpConfigSource::Other).unwrap();
        let second = state.begin_reconnect("srv").unwrap();
        assert!(!state.report_connected("srv", first, names(&["stale"])));
        assert_eq!(state.get("srv").unwrap().status, McpServerStatus::Pending);
        assert!(state.report_connected("srv", second, names(&["fresh"])));
        assert_eq!(state.get("srv").unwrap().tool_count, 1);
    }

    #[test]
    fn a_failed_connect_records_the_error() {
        let mut state = McpConnectionState::new(false);
        let attempt = state.register("srv", stdio_config(), McpConfigSource::Other).unwrap();
        assert!(state.report_failed("srv", attempt, "spawn ENOENT", false));
        let entry = state.get("srv").unwrap();
        assert_eq!(entry.status, McpServerStatus::Failed);
        assert_eq!(entry.error.as_deref(), Some("spawn ENOENT"));
        assert_eq!(entry.tool_count, 0);
    }

    #[test]
    fn a_401_on_a_remote_server_parks_in_needs_auth() {
        let mut state = McpConnectionState::new(true);
        let attempt =
            state.register("srv", http_config("https://x"), McpConfigSource::Other).unwrap();
        assert!(state.report_failed("srv", attempt, "HTTP 401", true));
        let entry = state.get("srv").unwrap();
        assert_eq!(entry.status, McpServerStatus::NeedsAuth);
        assert_eq!(
            entry.error.as_deref(),
            Some("srv requires OAuth — run /mcp-config login srv")
        );
    }

    #[test]
    fn needs_auth_requires_oauth_and_no_explicit_credentials() {
        // No OAuth service → plain failure.
        assert!(!should_mark_needs_auth(&http_config("https://x"), false, true));
        // Stdio is never OAuth.
        assert!(!should_mark_needs_auth(&stdio_config(), true, true));
        // An explicit bearer token or headers mean OAuth would not help.
        let with_token = McpServerConfig {
            bearer_token_env_var: Some("TOKEN".to_string()),
            ..http_config("https://x")
        };
        assert!(!should_mark_needs_auth(&with_token, true, true));
        let with_headers = McpServerConfig { has_headers: true, ..http_config("https://x") };
        assert!(!should_mark_needs_auth(&with_headers, true, true));
        // And the error must actually look unauthorized.
        assert!(!should_mark_needs_auth(&http_config("https://x"), true, false));
        assert!(should_mark_needs_auth(&http_config("https://x"), true, true));
    }

    #[test]
    fn an_unexpected_close_fails_the_server_with_a_composed_message() {
        let mut state = McpConnectionState::new(false);
        let attempt = state.register("srv", stdio_config(), McpConfigSource::Other).unwrap();
        state.report_connected("srv", attempt, names(&["a"]));
        assert!(state.report_unexpected_close(
            "srv",
            attempt,
            Some("read EPIPE"),
            Some("panic: boom\n")
        ));
        let entry = state.get("srv").unwrap();
        assert_eq!(entry.status, McpServerStatus::Failed);
        assert_eq!(
            entry.error.as_deref(),
            Some("MCP server \"srv\" closed unexpectedly\nread EPIPE\nstderr: panic: boom")
        );
        assert_eq!(entry.tool_count, 0);
    }

    #[test]
    fn reconnect_on_a_disabled_server_is_refused() {
        let mut state = McpConnectionState::new(false);
        let config = McpServerConfig { enabled: false, ..stdio_config() };
        state.register("srv", config, McpConfigSource::Other);
        assert_eq!(
            state.begin_reconnect("srv").unwrap_err(),
            "MCP server is disabled: srv"
        );
        assert!(state.begin_reconnect("nope").is_err());
    }

    #[test]
    fn remove_forgets_the_server() {
        let mut state = McpConnectionState::new(false);
        state.register("srv", stdio_config(), McpConfigSource::Other);
        assert!(state.remove("srv"));
        assert!(!state.remove("srv"));
        assert!(state.get("srv").is_none());
    }

    // ── enabled-name filtering ────────────────────────────────────────────

    #[test]
    fn without_filters_every_tool_is_enabled() {
        let enabled = compute_enabled_names(&stdio_config(), &names(&["a", "b"]));
        assert_eq!(enabled.len(), 2);
    }

    #[test]
    fn the_allow_list_restricts_and_the_deny_list_subtracts() {
        let config = McpServerConfig {
            enabled_tools: Some(names(&["a", "b"])),
            disabled_tools: Some(names(&["b", "c"])),
            ..stdio_config()
        };
        let enabled = compute_enabled_names(&config, &names(&["a", "b", "c", "d"]));
        assert_eq!(enabled, HashSet::from(["a".to_string()]));
    }

    #[test]
    fn enabled_tool_names_default_to_all_discovered() {
        let mut state = McpConnectionState::new(false);
        let attempt = state.register("srv", stdio_config(), McpConfigSource::Other).unwrap();
        state.report_connected("srv", attempt, names(&["x", "y"]));
        assert_eq!(state.enabled_tool_names("srv").unwrap().len(), 2);
        assert!(state.enabled_tool_names("nope").is_none());
    }

    #[test]
    fn tool_count_reflects_the_filtered_set() {
        let config = McpServerConfig {
            disabled_tools: Some(names(&["hidden"])),
            ..stdio_config()
        };
        let mut state = McpConnectionState::new(false);
        let attempt = state.register("srv", config, McpConfigSource::Other).unwrap();
        state.report_connected("srv", attempt, names(&["visible", "hidden"]));
        assert_eq!(state.get("srv").unwrap().tool_count, 1);
    }

    // ── misc views ────────────────────────────────────────────────────────

    #[test]
    fn remote_urls_are_exposed_only_for_remote_transports() {
        let mut state = McpConnectionState::new(false);
        state.register("http", http_config("https://x/mcp"), McpConfigSource::Other);
        state.register("local", stdio_config(), McpConfigSource::Other);
        assert_eq!(state.remote_server_url("http"), Some("https://x/mcp"));
        assert_eq!(state.remote_server_url("local"), None);
    }

    #[test]
    fn startup_timeouts_resolve_config_then_default_then_constant() {
        let mut state = McpConnectionState::new(false);
        let config = McpServerConfig { startup_timeout_ms: Some(5_000), ..stdio_config() };
        state.register("tuned", config, McpConfigSource::Other);
        state.register("plain", stdio_config(), McpConfigSource::Other);
        assert_eq!(state.startup_timeout_ms("tuned", Some(9_000)), 5_000);
        assert_eq!(state.startup_timeout_ms("plain", Some(9_000)), 9_000);
        assert_eq!(state.startup_timeout_ms("plain", None), DEFAULT_STARTUP_TIMEOUT_MS);
    }

    #[test]
    fn the_listing_is_sorted_by_name() {
        let mut state = McpConnectionState::new(false);
        state.register("zeta", stdio_config(), McpConfigSource::Other);
        state.register("alpha", stdio_config(), McpConfigSource::Other);
        let listed: Vec<String> = state.list().into_iter().map(|entry| entry.name).collect();
        assert_eq!(listed, vec!["alpha", "zeta"]);
    }

    // ── classification helpers ────────────────────────────────────────────

    #[test]
    fn unauthorized_detection_matches_ts() {
        assert!(is_unauthorized_like(Some("UnauthorizedError"), None, "x"));
        assert!(is_unauthorized_like(None, Some("401"), "x"));
        assert!(is_unauthorized_like(None, None, "HTTP 401 returned"));
        assert!(is_unauthorized_like(None, None, "Request Unauthorized"));
        assert!(!is_unauthorized_like(None, None, "code 4011 returned"), "word boundary");
        assert!(!is_unauthorized_like(None, None, "connection refused"));
    }

    #[test]
    fn startup_errors_append_the_stderr_tail() {
        assert_eq!(format_startup_error("boom", None), "boom");
        assert_eq!(format_startup_error("boom", Some("")), "boom");
        assert_eq!(format_startup_error("boom", Some("trace\n")), "boom\nstderr: trace");
    }
}
