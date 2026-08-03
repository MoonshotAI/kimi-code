//! External lifecycle hooks — executes user-configured shell commands at
//! agent lifecycle events (PreToolUse, PostToolUse, UserPromptSubmit, etc.).
//!
//! Mirrors `packages/agent-core/src/session/hooks/types.ts` and
//! `packages/agent-core/src/session/hooks/runner.ts`.

use std::time::Duration;

pub use kimi_protocol::hooks::*;

// ── Hook result ─────────────────────────────────────────────────────────

/// The result of executing a hook.
#[derive(Debug, Clone)]
pub struct HookResult {
    /// Whether the hook allows or blocks the action.
    pub action: HookAction,
    /// Optional message from the hook.
    pub message: Option<String>,
    /// Optional reason for blocking.
    pub reason: Option<String>,
    /// Command stdout.
    pub stdout: Option<String>,
    /// Command stderr.
    pub stderr: Option<String>,
    /// Command exit code.
    pub exit_code: Option<i32>,
    /// Whether the command timed out.
    pub timed_out: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookAction {
    Allow,
    Block,
}

// ── Hook manager ────────────────────────────────────────────────────────

/// Manages a collection of hooks and executes them when events match.
pub struct HookManager {
    hooks: Vec<HookDef>,
}

impl HookManager {
    /// Create a new hook manager from a list of hook definitions.
    pub fn new(hooks: Vec<HookDef>) -> Self {
        Self { hooks }
    }

    /// Run all hooks matching the given event and matcher value, feeding each
    /// the JSON `input` payload on stdin (TS: `runMatchedHooks`). Duplicate
    /// `(cwd, command)` pairs run once. Returns every result in hook order.
    pub async fn run_all(
        &self,
        event: HookEventType,
        matcher_value: Option<&str>,
        input: &serde_json::Value,
    ) -> Vec<HookResult> {
        let value = matcher_value.unwrap_or("");
        let mut seen: Vec<(String, String)> = Vec::new();
        let mut results: Vec<HookResult> = Vec::new();
        for def in &self.hooks {
            if def.event != event {
                continue;
            }
            if !hook_matches(def, value) {
                continue;
            }
            let key = (def.cwd.clone().unwrap_or_default(), def.command.clone());
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            results.push(run_hook(def, input).await);
        }
        results
    }

    /// Like `run_all`, but returns only the first blocking result (or `None`
    /// if every hook allows) — the common veto shape.
    pub async fn run_matching(
        &self,
        event: HookEventType,
        matcher_value: Option<&str>,
        input: &serde_json::Value,
    ) -> Option<HookResult> {
        self.run_all(event, matcher_value, input)
            .await
            .into_iter()
            .find(|r| matches!(r.action, HookAction::Block))
    }

    /// Check if there are any hooks registered for a given event.
    pub fn has_hooks_for(&self, event: HookEventType) -> bool {
        self.hooks.iter().any(|h| h.event == event)
    }

    /// Number of registered hooks.
    pub fn len(&self) -> usize {
        self.hooks.len()
    }

    /// Whether there are no hooks.
    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }
}

// ── Hook runner ─────────────────────────────────────────────────────────

/// Execute a hook definition and return the result.
///
/// Protocol (mirrors TS `runner.ts`):
/// - the JSON `input` payload is written to the hook's stdin, then closed
/// - exit code 2 = block, with trimmed stderr as the reason
/// - exit code 0 may carry structured JSON on stdout
///   (`hookSpecificOutput.permissionDecision === "deny"` blocks)
/// - every other outcome — other exit codes, timeout, spawn failure — allows
pub async fn run_hook(def: &HookDef, input: &serde_json::Value) -> HookResult {
    let timeout_s = def.timeout.unwrap_or(30).min(600);
    let timeout = Duration::from_secs(timeout_s as u64);

    // Shell-mode spawn, like the TS runner's `shell: true`. On Windows the
    // command line must go through `raw_arg`: `arg()` would re-quote the
    // whole command string, which mangles quotes/spaces under `cmd /C`.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.raw_arg("/C");
        c.raw_arg(&def.command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(&def.command);
        c
    };

    // Set working directory
    if let Some(ref cwd) = def.cwd {
        cmd.current_dir(cwd);
    }

    // Set environment variables
    if let Some(ref env) = def.env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    // Non-interactive environment
    cmd.env("NO_COLOR", "1");
    cmd.env("TERM", "dumb");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — hook commands must never flash a console.
        cmd.creation_flags(0x0800_0000);
    }

    let payload = serde_json::to_vec(input).unwrap_or_else(|_| b"{}".to_vec());
    let run = async {
        let mut child = cmd.spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            // A hook that never reads stdin closes the pipe; that is fine.
            let _ = stdin.write_all(&payload).await;
            let _ = stdin.shutdown().await;
        }
        child.wait_with_output().await
    };

    let output = match tokio::time::timeout(timeout, run).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            // Spawn/IO failure is allow (TS parity): a broken hook must not
            // brick the agent.
            return HookResult {
                action: HookAction::Allow,
                message: None,
                reason: None,
                stdout: None,
                stderr: Some(format!("hook execution error: {e}")),
                exit_code: None,
                timed_out: false,
            };
        }
        Err(_elapsed) => {
            // Timeout is allow (TS parity), flagged via `timed_out`.
            return HookResult {
                action: HookAction::Allow,
                message: None,
                reason: None,
                stdout: None,
                stderr: None,
                exit_code: None,
                timed_out: true,
            };
        }
    };

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = (!stdout_text.is_empty()).then(|| stdout_text.clone());
    let stderr = (!stderr_text.is_empty()).then(|| stderr_text.clone());

    // Exit code 2 = block, stderr is the reason (TS `resultFromExitCode`).
    if exit_code == 2 {
        let message = stderr_text.trim().to_string();
        return HookResult {
            action: HookAction::Block,
            message: Some(message.clone()),
            reason: Some(message),
            stdout,
            stderr,
            exit_code: Some(exit_code),
            timed_out: false,
        };
    }

    // Exit code 0 may carry structured JSON output on stdout.
    if exit_code == 0 {
        if let Some(structured) = parse_structured_output(&stdout_text) {
            if structured.block {
                return HookResult {
                    action: HookAction::Block,
                    message: structured.message.clone().or(structured.reason.clone()),
                    reason: structured.reason,
                    stdout,
                    stderr,
                    exit_code: Some(exit_code),
                    timed_out: false,
                };
            }
            return HookResult {
                action: HookAction::Allow,
                message: structured.message,
                reason: None,
                stdout,
                stderr,
                exit_code: Some(exit_code),
                timed_out: false,
            };
        }
    }

    // Anything else — including non-zero, non-2 exit codes — allows.
    HookResult {
        action: HookAction::Allow,
        message: None,
        reason: None,
        stdout,
        stderr,
        exit_code: Some(exit_code),
        timed_out: false,
    }
}

/// Parsed structured hook output (exit-0 stdout JSON, TS `structuredOutput`).
struct StructuredHookOutput {
    block: bool,
    message: Option<String>,
    reason: Option<String>,
}

/// Parse the TS structured-output shape: `{ message?, hookSpecificOutput?:
/// { message?, permissionDecision?, permissionDecisionReason? } }`. Only
/// `permissionDecision === "deny"` blocks. Non-JSON stdout returns `None`.
fn parse_structured_output(stdout: &str) -> Option<StructuredHookOutput> {
    let text = stdout.trim();
    if text.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(text).ok()?;
    if !parsed.is_object() {
        return None;
    }
    let specific = parsed.get("hookSpecificOutput").filter(|v| v.is_object());
    let message = value_to_opt_string(parsed.get("message"))
        .or_else(|| value_to_opt_string(specific.and_then(|s| s.get("message"))));
    let deny = specific
        .and_then(|s| s.get("permissionDecision"))
        .and_then(|v| v.as_str())
        == Some("deny");
    if !deny {
        return Some(StructuredHookOutput { block: false, message, reason: None });
    }
    let reason = specific
        .and_then(|s| s.get("permissionDecisionReason"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Some(StructuredHookOutput { block: true, message, reason })
}

/// TS `OptionalStringSchema`: strings pass through, numbers/bools stringify,
/// everything else is `None`.
fn value_to_opt_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Check whether a hook definition matches a matcher value via its `matcher`.
/// An absent or empty pattern matches everything; an invalid regex matches
/// nothing (TS `matches()` parity).
pub fn hook_matches(def: &HookDef, matcher_value: &str) -> bool {
    match &def.matcher {
        None => true,
        Some(pattern) if pattern.is_empty() => true,
        Some(pattern) => regex::Regex::new(pattern)
            .map(|re| re.is_match(matcher_value))
            .unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hook_event_type_from_str() {
        assert_eq!(HookEventType::from_str("PreToolUse"), Some(HookEventType::PreToolUse));
        assert_eq!(HookEventType::from_str("PostToolUse"), Some(HookEventType::PostToolUse));
        assert_eq!(HookEventType::from_str("Unknown"), None);
    }

    #[test]
    fn test_hook_matches_no_matcher() {
        let def = HookDef {
            event: HookEventType::PreToolUse,
            matcher: None,
            command: "echo hello".into(),
            timeout: None,
            cwd: None,
            env: None,
        };
        assert!(hook_matches(&def, "Read"));
        assert!(hook_matches(&def, "Bash"));
        assert!(hook_matches(&def, "anything"));
    }

    #[test]
    fn test_hook_matches_with_matcher() {
        let def = HookDef {
            event: HookEventType::PreToolUse,
            matcher: Some("^Read$|^Write$".into()),
            command: "echo hello".into(),
            timeout: None,
            cwd: None,
            env: None,
        };
        assert!(hook_matches(&def, "Read"));
        assert!(hook_matches(&def, "Write"));
        assert!(!hook_matches(&def, "Bash"));
        assert!(!hook_matches(&def, "Edit"));
    }

    #[test]
    fn test_hook_matches_invalid_regex() {
        let def = HookDef {
            event: HookEventType::PreToolUse,
            matcher: Some("([unclosed".into()),
            command: "echo hello".into(),
            timeout: None,
            cwd: None,
            env: None,
        };
        // Invalid regex should not match
        assert!(!hook_matches(&def, "anything"));
    }

    #[test]
    fn test_hook_matches_empty_matcher_matches_all() {
        let def = HookDef {
            event: HookEventType::PreToolUse,
            matcher: Some(String::new()),
            command: "echo hello".into(),
            timeout: None,
            cwd: None,
            env: None,
        };
        assert!(hook_matches(&def, "Read"));
        assert!(hook_matches(&def, ""));
    }

    #[test]
    fn test_hook_manager_empty() {
        let manager = HookManager::new(vec![]);
        assert!(manager.is_empty());
        assert_eq!(manager.len(), 0);
        assert!(!manager.has_hooks_for(HookEventType::PreToolUse));
    }

    #[test]
    fn test_hook_manager_has_hooks() {
        let def = HookDef {
            event: HookEventType::PreToolUse,
            matcher: None,
            command: "echo hello".into(),
            timeout: None,
            cwd: None,
            env: None,
        };
        let manager = HookManager::new(vec![def]);
        assert!(!manager.is_empty());
        assert!(manager.has_hooks_for(HookEventType::PreToolUse));
        assert!(!manager.has_hooks_for(HookEventType::PostToolUse));
    }

    #[test]
    fn test_hook_manager_run_matching_no_hooks() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let manager = HookManager::new(vec![]);
        let result = rt.block_on(manager.run_matching(
            HookEventType::PreToolUse,
            Some("Read"),
            &serde_json::json!({}),
        ));
        assert!(result.is_none());
    }

    /// A shell command that exits with the given code, portable across
    /// `sh -c` (POSIX) and `cmd /C` (Windows).
    fn exit_cmd(code: i32) -> String {
        if cfg!(windows) { format!("exit /b {code}") } else { format!("exit {code}") }
    }

    fn def_with_command(command: &str) -> HookDef {
        HookDef {
            event: HookEventType::PreToolUse,
            matcher: None,
            command: command.into(),
            timeout: Some(10),
            cwd: None,
            env: None,
        }
    }

    #[tokio::test]
    async fn test_run_hook_exit_zero_allows() {
        let result = run_hook(&def_with_command(&exit_cmd(0)), &serde_json::json!({})).await;
        assert_eq!(result.action, HookAction::Allow);
        assert_eq!(result.exit_code, Some(0));
    }

    #[tokio::test]
    async fn test_run_hook_exit_two_blocks_with_stderr_reason() {
        // `echo … 1>&2` sends the reason to stderr on both shells.
        let cmd = if cfg!(windows) {
            "echo nope 1>&2 & exit /b 2".to_string()
        } else {
            "echo nope 1>&2; exit 2".to_string()
        };
        let result = run_hook(&def_with_command(&cmd), &serde_json::json!({})).await;
        assert_eq!(result.action, HookAction::Block);
        assert_eq!(result.exit_code, Some(2));
        assert_eq!(result.reason.as_deref(), Some("nope"));
    }

    #[tokio::test]
    async fn test_run_hook_other_nonzero_exit_allows() {
        // TS parity: only exit code 2 blocks — 1 must allow.
        let result = run_hook(&def_with_command(&exit_cmd(1)), &serde_json::json!({})).await;
        assert_eq!(result.action, HookAction::Allow);
        assert_eq!(result.exit_code, Some(1));
    }

    #[tokio::test]
    async fn test_run_hook_receives_stdin_payload() {
        // Echo stdin back to stdout; the payload must round-trip.
        let cmd = if cfg!(windows) { "findstr .".to_string() } else { "cat".to_string() };
        let payload = serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Read"});
        let result = run_hook(&def_with_command(&cmd), &payload).await;
        assert_eq!(result.action, HookAction::Allow);
        let stdout = result.stdout.unwrap_or_default();
        assert!(stdout.contains("PreToolUse"), "stdout should carry the payload: {stdout}");
        assert!(stdout.contains("tool_name"), "stdout should carry the payload: {stdout}");
    }

    /// A command that prints the given text to stdout verbatim, avoiding
    /// shell quote mangling by round-tripping through a temp file.
    fn print_cmd(text: &str) -> (String, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("out.json");
        std::fs::write(&path, text).expect("write");
        let cmd = if cfg!(windows) {
            format!("type \"{}\"", path.display())
        } else {
            format!("cat \"{}\"", path.display())
        };
        (cmd, dir)
    }

    #[tokio::test]
    async fn test_run_hook_structured_deny_blocks() {
        let json = r#"{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"policy"}}"#;
        let (cmd, _dir) = print_cmd(json);
        let result = run_hook(&def_with_command(&cmd), &serde_json::json!({})).await;
        assert_eq!(result.action, HookAction::Block);
        assert_eq!(result.reason.as_deref(), Some("policy"));
    }

    #[tokio::test]
    async fn test_run_hook_structured_allow_carries_message() {
        let json = r#"{"message":"context note"}"#;
        let (cmd, _dir) = print_cmd(json);
        let result = run_hook(&def_with_command(&cmd), &serde_json::json!({})).await;
        assert_eq!(result.action, HookAction::Allow);
        assert_eq!(result.message.as_deref(), Some("context note"));
    }

    #[tokio::test]
    async fn test_run_hook_timeout_allows() {
        // TS parity: a timed-out hook allows, flagged via timed_out.
        let cmd = if cfg!(windows) {
            "ping -n 30 127.0.0.1 > NUL".to_string()
        } else {
            "sleep 30".to_string()
        };
        let def = HookDef { timeout: Some(1), ..def_with_command(&cmd) };
        let result = run_hook(&def, &serde_json::json!({})).await;
        assert_eq!(result.action, HookAction::Allow);
        assert!(result.timed_out);
    }

    #[tokio::test]
    async fn test_run_matching_dedupes_and_returns_first_block() {
        let block_cmd = exit_cmd(2);
        let manager = HookManager::new(vec![
            def_with_command(&exit_cmd(0)),
            def_with_command(&block_cmd),
            // Duplicate (cwd, command) — must run once.
            def_with_command(&block_cmd),
        ]);
        let result = manager
            .run_matching(HookEventType::PreToolUse, Some("Read"), &serde_json::json!({}))
            .await;
        assert!(matches!(result, Some(ref r) if r.action == HookAction::Block));
    }

    #[tokio::test]
    async fn test_run_matching_matcher_filters_by_value() {
        let mut def = def_with_command(&exit_cmd(2));
        def.matcher = Some("^Write$".into());
        let manager = HookManager::new(vec![def]);
        // Non-matching tool: hook skipped, no block.
        let miss = manager
            .run_matching(HookEventType::PreToolUse, Some("Read"), &serde_json::json!({}))
            .await;
        assert!(miss.is_none());
        // Matching tool: hook runs and blocks.
        let hit = manager
            .run_matching(HookEventType::PreToolUse, Some("Write"), &serde_json::json!({}))
            .await;
        assert!(hit.is_some());
    }

    #[test]
    fn test_parse_structured_output_shapes() {
        // Non-JSON → None.
        assert!(parse_structured_output("plain text").is_none());
        // Empty → None.
        assert!(parse_structured_output("  ").is_none());
        // Deny decision → block with reason.
        let deny = parse_structured_output(
            r#"{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"r"}}"#,
        )
        .unwrap();
        assert!(deny.block);
        assert_eq!(deny.reason.as_deref(), Some("r"));
        // Allow decision → message passthrough.
        let allow = parse_structured_output(r#"{"message":"m"}"#).unwrap();
        assert!(!allow.block);
        assert_eq!(allow.message.as_deref(), Some("m"));
        // Non-"deny" permissionDecision → allow.
        let ask = parse_structured_output(
            r#"{"hookSpecificOutput":{"permissionDecision":"ask"}}"#,
        )
        .unwrap();
        assert!(!ask.block);
    }
}
    #[test]
    fn test_has_hooks_for_and_run_all_event_filtering() {
        // run_all with no matching hook of the requested event returns empty.
        let manager = HookManager::new(vec![HookDef {
            event: HookEventType::PreToolUse,
            matcher: None,
            command: "exit 0".into(),
            timeout: None,
            cwd: None,
            env: None,
        }]);
        assert!(manager.has_hooks_for(HookEventType::PreToolUse));
        assert!(!manager.has_hooks_for(HookEventType::SessionStart));
        assert!(!manager.has_hooks_for(HookEventType::Interrupt));
        assert!(!manager.has_hooks_for(HookEventType::PreCompact));
        assert!(!manager.has_hooks_for(HookEventType::PostCompact));
    }

    #[test]
    fn test_session_level_event_types_parse() {
        // The session-level lifecycle events must round-trip their wire names.
        for name in ["SessionStart", "SessionEnd", "Interrupt", "PreCompact", "PostCompact", "PermissionRequest", "PermissionResult"] {
            let parsed = HookEventType::from_str(name).unwrap_or_else(|| panic!("{name} must parse"));
            assert_eq!(format!("{parsed:?}"), name);
        }
    }
