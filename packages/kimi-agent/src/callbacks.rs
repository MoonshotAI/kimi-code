/// Host callback trait for LLM chat and tool execution.
///
/// This trait abstracts the transport layer — whether it's JSON-RPC over
/// stdio (the RpcServer-based implementation) or direct napi-rs
/// ThreadsafeFunction calls. The turn loop uses this trait to call back
/// to the JS host for LLM inference and tool execution.
use std::sync::Arc;

use crate::rpc::types::{
    AuthorizeToolRequest, AuthorizeToolResponse, BoxFuture,
    ExecutableToolResultData, FinalizeToolRequest, FinalizeToolResponse, LlmChatRequest,
    LlmChatResponse, PrepareToolRequest, PrepareToolResponse, ToolExecuteRequest,
    ToolExecuteResponse,
};

/// Host-provided callbacks that the turn loop needs to call back to JS.
pub trait HostCallbacks: Send + Sync {
    /// Whether this transport actually delivers the tool lifecycle hooks
    /// (prepare / authorize / finalize) to the host, rather than answering
    /// them with the pass-through defaults below. Write-class native
    /// execution is only allowed when this is true — otherwise the approval
    /// gate would be silently skipped — and falls back to full host
    /// execution when it is not.
    fn supports_tool_lifecycle(&self) -> bool {
        false
    }

    /// Send an LLM chat request to the JS host and return the response.
    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>>;

    /// Send a tool execution request to the JS host and return the response.
    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>>;

    /// Fire-and-forget event notification to the JS host. Used by the
    /// native LLM / native tool paths to report step boundaries, streaming
    /// deltas, and natively-executed tool results so the host can record
    /// them in the transcript. The default implementation drops the event.
    fn emit_event(&self, event: serde_json::Value) {
        let _ = event;
    }

    // ── Tool lifecycle hooks (tool_call.rs) ─────────────────────────────────

    /// Prepare tool execution hook — analogous to TS `prepareToolExecution`.
    /// Called before a tool is executed. May block, return a synthetic result,
    /// or modify arguments. Return `None` to allow the call unchanged.
    fn prepare_tool_execution(
        &self,
        request: PrepareToolRequest,
    ) -> BoxFuture<'static, Result<Option<PrepareToolResponse>, String>> {
        // Default: allow the call unchanged.
        let _ = request;
        Box::pin(async { Ok(None) })
    }

    /// Authorize tool execution hook — analogous to TS `authorizeToolExecution`.
    /// Called after execution resolution, may block or return a synthetic result.
    /// Return `None` to allow the call.
    fn authorize_tool_execution(
        &self,
        request: AuthorizeToolRequest,
    ) -> BoxFuture<'static, Result<Option<AuthorizeToolResponse>, String>> {
        // Default: allow the call unchanged.
        let _ = request;
        Box::pin(async { Ok(None) })
    }

    /// Finalize tool result hook — analogous to TS `finalizeToolResult`.
    /// Allows post-execution transformation (redaction, truncation).
    /// Return `None` to use the result as-is.
    fn finalize_tool_result(
        &self,
        request: FinalizeToolRequest,
    ) -> BoxFuture<'static, Result<FinalizeToolResponse, String>> {
        // Default: use the result as-is.
        let _ = request;
        Box::pin(async { Ok(None) })
    }
}

/// A concrete implementation of [`HostCallbacks`] backed by the stdio
/// JSON-RPC server. Used in the CLI binary mode.
pub struct RpcHostCallbacks {
    pub server: Arc<crate::rpc::server::RpcServer>,
}

impl HostCallbacks for RpcHostCallbacks {
    // The stdio host registers real handlers for prepare/authorize/finalize
    // (rust-loop.ts `setPrepareToolHandler` & co.), so the approval gate is
    // reachable over this transport.
    fn supports_tool_lifecycle(&self) -> bool {
        true
    }

    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("LLM chat serialize error: {e}"))?;
            let response_value = server
                .invoke(crate::rpc::types::methods::HOST_LLM_CHAT, params)
                .await
                .map_err(|e| format!("LLM chat error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("LLM chat response parse error: {e}"))
        })
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Tool execute serialize error: {e}"))?;
            let response_value = server
                .invoke(crate::rpc::types::methods::HOST_EXECUTE_TOOL, params)
                .await
                .map_err(|e| format!("Tool execute error: {e}"))?;
            serde_json::from_value(response_value)
                .map_err(|e| format!("Tool execute response parse error: {e}"))
        })
    }

    fn emit_event(&self, event: serde_json::Value) {
        // JSON-RPC notification over stdout — fire-and-forget by design.
        crate::rpc::server::RpcServer::notify_now(
            crate::rpc::types::methods::HOST_EVENT,
            &event,
        );
    }

    fn prepare_tool_execution(
        &self,
        request: PrepareToolRequest,
    ) -> BoxFuture<'static, Result<Option<PrepareToolResponse>, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Prepare tool serialize error: {e}"))?;
            let response_value = server
                .invoke(crate::rpc::types::methods::HOST_PREPARE_TOOL, params)
                .await
                .map_err(|e| format!("Prepare tool error: {e}"))?;
            let response: Option<PrepareToolResponse> = serde_json::from_value(response_value)
                .map_err(|e| format!("Prepare tool response parse error: {e}"))?;
            Ok(response)
        })
    }

    fn authorize_tool_execution(
        &self,
        request: AuthorizeToolRequest,
    ) -> BoxFuture<'static, Result<Option<AuthorizeToolResponse>, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Authorize tool serialize error: {e}"))?;
            let response_value = server
                .invoke(crate::rpc::types::methods::HOST_AUTHORIZE_TOOL, params)
                .await
                .map_err(|e| format!("Authorize tool error: {e}"))?;
            let response: Option<AuthorizeToolResponse> = serde_json::from_value(response_value)
                .map_err(|e| format!("Authorize tool response parse error: {e}"))?;
            Ok(response)
        })
    }

    fn finalize_tool_result(
        &self,
        request: FinalizeToolRequest,
    ) -> BoxFuture<'static, Result<FinalizeToolResponse, String>> {
        let server = self.server.clone();
        Box::pin(async move {
            let params = serde_json::to_value(&request)
                .map_err(|e| format!("Finalize tool serialize error: {e}"))?;
            let response_value = server
                .invoke(crate::rpc::types::methods::HOST_FINALIZE_TOOL, params)
                .await
                .map_err(|e| format!("Finalize tool error: {e}"))?;
            let response: FinalizeToolResponse = serde_json::from_value(response_value)
                .map_err(|e| format!("Finalize tool response parse error: {e}"))?;
            Ok(response)
        })
    }
}

/// A [`HostCallbacks`] decorator that executes read-only tools natively
/// (inside the Rust process, sandboxed to the workspace) and forwards
/// everything else to the wrapped callbacks.
///
/// Natively-executed calls are reported to the host via [`emit_event`]
/// (`type: "tool.native"`) so the transcript still records them.
pub struct NativeToolCallbacks {
    pub inner: Arc<dyn HostCallbacks>,
    pub toolset: Arc<crate::tools::NativeToolset>,
}

impl HostCallbacks for NativeToolCallbacks {
    fn supports_tool_lifecycle(&self) -> bool {
        self.inner.supports_tool_lifecycle()
    }

    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        self.inner.llm_chat(request)
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        // Bash: native execution only when the toolset opted in
        // (`with_shell`, the standalone agent path) — behind the same
        // approval gate as writes. Background runs, malformed args, and
        // transports without lifecycle hooks stay with the host, whose JS
        // Bash owns the background-task domain.
        if request.tool_name.eq_ignore_ascii_case("bash") {
            if self.toolset.shell().is_none()
                || !self.inner.supports_tool_lifecycle()
                || !crate::tools::bash::claims_bash(&request.arguments)
            {
                return self.inner.execute_tool(request);
            }
            let inner = self.inner.clone();
            let toolset = self.toolset.clone();
            return Box::pin(async move { execute_gated_bash(inner, toolset, request).await });
        }
        // Write-class tools mutate the filesystem, so native execution must
        // pass the host's approval gate first. Only take the native path when
        // the transport actually delivers the lifecycle hooks AND the call is
        // definitely handleable (`claims_write` — side-effect free); anything
        // else runs the full host lifecycle in JS, exactly as before.
        if crate::tools::NativeToolset::is_write_class(&request.tool_name) {
            if !self.inner.supports_tool_lifecycle()
                || !self.toolset.claims_write(&request.tool_name, &request.arguments)
            {
                return self.inner.execute_tool(request);
            }
            let inner = self.inner.clone();
            let toolset = self.toolset.clone();
            return Box::pin(async move { execute_gated_write(inner, toolset, request).await });
        }
        if let Some(result) = self.toolset.execute(&request.tool_name, &request.arguments) {
            self.inner.emit_event(serde_json::json!({
                "type": "tool.native",
                "turn_id": request.turn_id,
                "tool_call_id": request.tool_call_id,
                "tool_name": request.tool_name,
                "arguments": request.arguments,
                "content": result.content,
                "is_error": result.is_error,
            }));
            let response = ToolExecuteResponse {
                content: result.content,
                is_error: result.is_error,
                is_prediction: false,
                stop_turn: false,
            };
            return Box::pin(async move { Ok(response) });
        }
        self.inner.execute_tool(request)
    }

    fn emit_event(&self, event: serde_json::Value) {
        self.inner.emit_event(event);
    }

    fn prepare_tool_execution(
        &self,
        request: PrepareToolRequest,
    ) -> BoxFuture<'static, Result<Option<PrepareToolResponse>, String>> {
        self.inner.prepare_tool_execution(request)
    }

    fn authorize_tool_execution(
        &self,
        request: AuthorizeToolRequest,
    ) -> BoxFuture<'static, Result<Option<AuthorizeToolResponse>, String>> {
        self.inner.authorize_tool_execution(request)
    }

    fn finalize_tool_result(
        &self,
        request: FinalizeToolRequest,
    ) -> BoxFuture<'static, Result<FinalizeToolResponse, String>> {
        self.inner.finalize_tool_result(request)
    }
}

/// Run a write-class tool through the host approval gate, then execute it
/// natively. Mirrors the JS loop's tool lifecycle (`tool-call.ts`):
/// prepare → authorize → execute → finalize. A block or synthetic result at
/// any hook short-circuits before the filesystem is touched; the native
/// write only runs after authorize allows it.
async fn execute_gated_write(
    inner: Arc<dyn HostCallbacks>,
    toolset: Arc<crate::tools::NativeToolset>,
    request: ToolExecuteRequest,
) -> Result<ToolExecuteResponse, String> {
    let approval_rule = write_approval_rule(&request.tool_name, &request.arguments);

    // ── Prepare ──────────────────────────────────────────────────────────
    let prepare = inner
        .prepare_tool_execution(PrepareToolRequest {
            turn_id: request.turn_id.clone(),
            step_number: 0,
            tool_call_id: request.tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: request.arguments.clone(),
            all_tool_calls: vec![],
            trace_id: None,
        })
        .await?;
    let mut effective_args = request.arguments.clone();
    if let Some(ref decision) = prepare {
        if decision.block {
            return Ok(blocked_response(decision.reason.clone(), &request.tool_name));
        }
        if let Some(ref synthetic) = decision.synthetic_result {
            return Ok(from_result_data(synthetic));
        }
        if let Some(ref updated) = decision.updated_args {
            effective_args = updated.clone();
        }
    }

    // ── Authorize (the permission gate) ────────────────────────────────────
    let authorize = inner
        .authorize_tool_execution(AuthorizeToolRequest {
            turn_id: request.turn_id.clone(),
            step_number: 0,
            tool_call_id: request.tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: effective_args.clone(),
            all_tool_calls: vec![],
            trace_id: None,
            approval_rule,
        })
        .await?;
    if let Some(ref decision) = authorize {
        if decision.block {
            return Ok(blocked_response(decision.reason.clone(), &request.tool_name));
        }
        if let Some(ref synthetic) = decision.synthetic_result {
            return Ok(from_result_data(synthetic));
        }
    }

    // ── Execute natively ───────────────────────────────────────────────────
    // `claims_write` already vetted the call, so `execute` handles it. The
    // residual race (file vanished / symlink appeared between admission and
    // execution) must NOT fall back to the host: prepare has already run
    // there, and a second full lifecycle for the same tool_call_id would
    // corrupt the host's dedupe bookkeeping. Fail the call instead.
    let native = match toolset.execute(&request.tool_name, &effective_args) {
        Some(result) => result,
        None => {
            return Ok(blocked_response(
                Some(format!(
                    "Native {} declined after approval (path no longer eligible); retry the call",
                    request.tool_name
                )),
                &request.tool_name,
            ));
        }
    };
    inner.emit_event(serde_json::json!({
        "type": "tool.native",
        "turn_id": request.turn_id,
        "tool_call_id": request.tool_call_id,
        "tool_name": request.tool_name,
        "arguments": effective_args,
        "content": native.content,
        "is_error": native.is_error,
    }));

    // ── Finalize (redaction / truncation) ──────────────────────────────────
    let finalized = inner
        .finalize_tool_result(FinalizeToolRequest {
            turn_id: request.turn_id.clone(),
            step_number: 0,
            tool_call_id: request.tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: effective_args,
            result: ExecutableToolResultData {
                content: native.content.clone(),
                is_error: native.is_error,
                note: None,
                is_prediction: false,
                stop_turn: false,
            },
            trace_id: None,
        })
        .await?;
    if let Some(data) = finalized {
        return Ok(ToolExecuteResponse {
            content: data.content,
            is_error: data.is_error,
            is_prediction: false,
            stop_turn: data.stop_turn,
        });
    }
    Ok(ToolExecuteResponse {
        content: native.content,
        is_error: native.is_error,
        is_prediction: false,
        stop_turn: false,
    })
}

fn blocked_response(reason: Option<String>, tool_name: &str) -> ToolExecuteResponse {
    ToolExecuteResponse {
        content: reason.unwrap_or_else(|| format!("Tool call \"{tool_name}\" was blocked")),
        is_error: true,
        is_prediction: false,
        stop_turn: false,
    }
}

/// Run a Bash call through the host approval gate, then execute it in the
/// native shell (foreground only). Same single-lifecycle contract as
/// `execute_gated_write`. The approval rule follows the TS BashTool:
/// dangerous commands map to `Bash(__dangerous__)` so they never match a
/// broad session rule; everything else uses the literal command rule.
async fn execute_gated_bash(
    inner: Arc<dyn HostCallbacks>,
    toolset: Arc<crate::tools::NativeToolset>,
    request: ToolExecuteRequest,
) -> Result<ToolExecuteResponse, String> {
    // ── Prepare ──────────────────────────────────────────────────────────
    let prepare = inner
        .prepare_tool_execution(PrepareToolRequest {
            turn_id: request.turn_id.clone(),
            step_number: 0,
            tool_call_id: request.tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: request.arguments.clone(),
            all_tool_calls: vec![],
            trace_id: None,
        })
        .await?;
    let mut effective_args = request.arguments.clone();
    if let Some(ref decision) = prepare {
        if decision.block {
            return Ok(blocked_response(decision.reason.clone(), &request.tool_name));
        }
        if let Some(ref synthetic) = decision.synthetic_result {
            return Ok(from_result_data(synthetic));
        }
        if let Some(ref updated) = decision.updated_args {
            effective_args = updated.clone();
        }
    }
    // Re-admit after a possible args rewrite; a no-longer-claimable call
    // fails closed — the host lifecycle must not run twice for one call.
    if !crate::tools::bash::claims_bash(&effective_args) {
        return Ok(blocked_response(
            Some("Bash call is no longer natively executable after prepare".into()),
            &request.tool_name,
        ));
    }
    let command = effective_args
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // ── Authorize (the permission gate) ────────────────────────────────────
    let approval_rule = if crate::tools::bash::is_dangerous_command(&command) {
        format!("Bash({})", crate::tools::bash::DANGEROUS_COMMAND_MARKER)
    } else {
        format!("Bash({})", escape_rule_subject_literal(&command))
    };
    let authorize = inner
        .authorize_tool_execution(AuthorizeToolRequest {
            turn_id: request.turn_id.clone(),
            step_number: 0,
            tool_call_id: request.tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: effective_args.clone(),
            all_tool_calls: vec![],
            trace_id: None,
            approval_rule,
        })
        .await?;
    if let Some(ref decision) = authorize {
        if decision.block {
            return Ok(blocked_response(decision.reason.clone(), &request.tool_name));
        }
        if let Some(ref synthetic) = decision.synthetic_result {
            return Ok(from_result_data(synthetic));
        }
    }

    // ── Execute in the native shell ─────────────────────────────────────────
    let cwd = match effective_args.get("cwd").and_then(|v| v.as_str()) {
        Some(dir) if !dir.trim().is_empty() => {
            let path = std::path::PathBuf::from(dir);
            if path.is_absolute() { path } else { toolset.root().join(path) }
        }
        _ => toolset.root().to_path_buf(),
    };
    let timeout_s = effective_args.get("timeout").and_then(|v| v.as_u64());
    let Some(runner) = toolset.shell().cloned() else {
        return Ok(blocked_response(Some("Native shell unavailable".into()), &request.tool_name));
    };
    let native = runner.run(&command, &cwd, timeout_s).await;
    inner.emit_event(serde_json::json!({
        "type": "tool.native",
        "turn_id": request.turn_id,
        "tool_call_id": request.tool_call_id,
        "tool_name": request.tool_name,
        "arguments": effective_args,
        "content": native.content,
        "is_error": native.is_error,
    }));

    // ── Finalize (redaction / truncation) ──────────────────────────────────
    let finalized = inner
        .finalize_tool_result(FinalizeToolRequest {
            turn_id: request.turn_id.clone(),
            step_number: 0,
            tool_call_id: request.tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: effective_args,
            result: ExecutableToolResultData {
                content: native.content.clone(),
                is_error: native.is_error,
                note: None,
                is_prediction: false,
                stop_turn: false,
            },
            trace_id: None,
        })
        .await?;
    if let Some(data) = finalized {
        return Ok(ToolExecuteResponse {
            content: data.content,
            is_error: data.is_error,
            is_prediction: false,
            stop_turn: data.stop_turn,
        });
    }
    Ok(ToolExecuteResponse {
        content: native.content,
        is_error: native.is_error,
        is_prediction: false,
        stop_turn: false,
    })
}

fn from_result_data(data: &ExecutableToolResultData) -> ToolExecuteResponse {
    ToolExecuteResponse {
        content: data.content.clone(),
        is_error: data.is_error,
        is_prediction: false,
        stop_turn: data.stop_turn,
    }
}

/// Build the session approval rule for a write-class call, matching the TS
/// tools' `literalRulePattern(name, path)` (native-tools.ts / write.ts /
/// edit.ts): `Name(escaped-path)`, where the path's glob metacharacters are
/// backslash-escaped (rule-match.ts `GLOB_LITERAL_SPECIAL`).
fn write_approval_rule(tool_name: &str, args: &serde_json::Value) -> String {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or_default();
    format!("{tool_name}({})", escape_rule_subject_literal(path))
}

fn escape_rule_subject_literal(subject: &str) -> String {
    // Mirror of the TS regex /[\\*?[\]{}()!+@|]/g.
    const SPECIAL: &[char] = &[
        '\\', '*', '?', '[', ']', '{', '}', '(', ')', '!', '+', '@', '|',
    ];
    let mut out = String::with_capacity(subject.len());
    for ch in subject.chars() {
        if SPECIAL.contains(&ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Mock host: counts lifecycle-hook calls, optionally blocks authorize.
    struct MockHost {
        lifecycle: bool,
        authorize_block: bool,
        prepare_calls: AtomicU32,
        authorize_calls: AtomicU32,
        finalize_calls: AtomicU32,
        host_execute_calls: AtomicU32,
    }

    impl MockHost {
        fn new(lifecycle: bool, authorize_block: bool) -> Self {
            Self {
                lifecycle,
                authorize_block,
                prepare_calls: AtomicU32::new(0),
                authorize_calls: AtomicU32::new(0),
                finalize_calls: AtomicU32::new(0),
                host_execute_calls: AtomicU32::new(0),
            }
        }
    }

    impl HostCallbacks for MockHost {
        fn supports_tool_lifecycle(&self) -> bool {
            self.lifecycle
        }
        fn llm_chat(
            &self,
            _request: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("llm_chat not used in this test".into()) })
        }
        fn execute_tool(
            &self,
            _request: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            self.host_execute_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Ok(ToolExecuteResponse {
                    content: "host executed".into(),
                    is_error: false,
                    is_prediction: false,
                    stop_turn: false,
                })
            })
        }
        fn emit_event(&self, _event: serde_json::Value) {}
        fn prepare_tool_execution(
            &self,
            _request: PrepareToolRequest,
        ) -> BoxFuture<'static, Result<Option<PrepareToolResponse>, String>> {
            self.prepare_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(None) })
        }
        fn authorize_tool_execution(
            &self,
            _request: AuthorizeToolRequest,
        ) -> BoxFuture<'static, Result<Option<AuthorizeToolResponse>, String>> {
            self.authorize_calls.fetch_add(1, Ordering::SeqCst);
            let block = self.authorize_block;
            Box::pin(async move {
                if block {
                    Ok(Some(AuthorizeToolResponse {
                        block: true,
                        reason: Some("denied by test gate".into()),
                        synthetic_result: None,
                        execution_metadata: None,
                        resolved: true,
                    }))
                } else {
                    Ok(None)
                }
            })
        }
        fn finalize_tool_result(
            &self,
            _request: FinalizeToolRequest,
        ) -> BoxFuture<'static, Result<FinalizeToolResponse, String>> {
            self.finalize_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(None) })
        }
    }

    fn setup(
        lifecycle: bool,
        authorize_block: bool,
    ) -> (tempfile::TempDir, Arc<MockHost>, NativeToolCallbacks) {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = Arc::new(MockHost::new(lifecycle, authorize_block));
        let toolset = crate::tools::NativeToolset::new(dir.path().to_str().unwrap()).unwrap();
        let callbacks = NativeToolCallbacks {
            inner: host.clone(),
            toolset: Arc::new(toolset),
        };
        (dir, host, callbacks)
    }

    fn write_request(path: &str) -> ToolExecuteRequest {
        ToolExecuteRequest {
            turn_id: "t".into(),
            tool_call_id: "c1".into(),
            tool_name: "Write".into(),
            arguments: serde_json::json!({ "path": path, "content": "hello" }),
            force_precise: false,
        }
    }

    #[tokio::test]
    async fn write_without_lifecycle_support_falls_back_to_the_host() {
        let (dir, host, callbacks) = setup(false, false);
        let response = callbacks.execute_tool(write_request("a.txt")).await.unwrap();
        assert_eq!(response.content, "host executed");
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 1);
        // The approval gate was never skipped: nothing was written natively.
        assert!(!dir.path().join("a.txt").exists());
    }

    #[tokio::test]
    async fn write_with_lifecycle_runs_the_gate_then_writes_natively() {
        let (dir, host, callbacks) = setup(true, false);
        let response = callbacks.execute_tool(write_request("a.txt")).await.unwrap();
        assert!(!response.is_error, "{}", response.content);
        assert_eq!(response.content, "Wrote 5 bytes to a.txt");
        assert_eq!(host.prepare_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.finalize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "hello");
    }

    #[tokio::test]
    async fn blocked_write_never_touches_the_filesystem() {
        let (dir, host, callbacks) = setup(true, true);
        let response = callbacks.execute_tool(write_request("a.txt")).await.unwrap();
        assert!(response.is_error);
        assert_eq!(response.content, "denied by test gate");
        assert!(!dir.path().join("a.txt").exists());
        assert_eq!(host.finalize_calls.load(Ordering::SeqCst), 0);
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn read_fast_path_stays_hook_free() {
        let (dir, host, callbacks) = setup(true, false);
        std::fs::write(dir.path().join("r.txt"), "data").unwrap();
        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c2".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({ "path": "r.txt" }),
                force_precise: true,
            })
            .await
            .unwrap();
        assert!(!response.is_error);
        assert_eq!(host.prepare_calls.load(Ordering::SeqCst), 0);
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn approval_rule_matches_the_ts_literal_pattern() {
        let rule = write_approval_rule(
            "Write",
            &serde_json::json!({ "path": "src/a(1)*.txt", "content": "" }),
        );
        assert_eq!(rule, "Write(src/a\\(1\\)\\*.txt)");
    }

    fn setup_with_shell(
        authorize_block: bool,
    ) -> Option<(tempfile::TempDir, Arc<MockHost>, NativeToolCallbacks)> {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = Arc::new(MockHost::new(true, authorize_block));
        let toolset = crate::tools::NativeToolset::new(dir.path().to_str().unwrap())?
            .with_shell();
        // No shell on this host — the caller skips.
        toolset.shell()?;
        let callbacks = NativeToolCallbacks {
            inner: host.clone(),
            toolset: Arc::new(toolset),
        };
        Some((dir, host, callbacks))
    }

    fn bash_request(command: &str) -> ToolExecuteRequest {
        ToolExecuteRequest {
            turn_id: "t".into(),
            tool_call_id: "b1".into(),
            tool_name: "Bash".into(),
            arguments: serde_json::json!({ "command": command }),
            force_precise: false,
        }
    }

    #[tokio::test]
    async fn approved_bash_runs_natively_through_the_full_lifecycle() {
        let Some((_dir, host, callbacks)) = setup_with_shell(false) else {
            eprintln!("no shell available; skipping");
            return;
        };
        let response = callbacks.execute_tool(bash_request("echo gated-hello")).await.unwrap();
        assert!(!response.is_error, "{}", response.content);
        assert!(response.content.contains("gated-hello"));
        assert_eq!(host.prepare_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.finalize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn blocked_bash_never_runs_the_command() {
        let Some((dir, host, callbacks)) = setup_with_shell(true) else {
            eprintln!("no shell available; skipping");
            return;
        };
        // A command whose only effect would be a file — proves it never ran.
        let marker = dir.path().join("ran.txt");
        let cmd = format!("echo x > {}", marker.to_string_lossy().replace('\\', "/"));
        let response = callbacks.execute_tool(bash_request(&cmd)).await.unwrap();
        assert!(response.is_error);
        assert_eq!(response.content, "denied by test gate");
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.finalize_calls.load(Ordering::SeqCst), 0);
        assert!(!marker.exists(), "blocked command must not run");
    }

    #[tokio::test]
    async fn background_bash_falls_back_to_the_host() {
        let Some((_dir, host, callbacks)) = setup_with_shell(false) else {
            eprintln!("no shell available; skipping");
            return;
        };
        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "b2".into(),
                tool_name: "Bash".into(),
                arguments: serde_json::json!({
                    "command": "sleep 1",
                    "run_in_background": true,
                    "description": "bg"
                }),
                force_precise: false,
            })
            .await
            .unwrap();
        // Background semantics belong to the host: no native gate ran.
        assert_eq!(response.content, "host executed");
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 0);
    }
}

