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
    /// Native background-task manager. When set, `run_in_background` Bash
    /// calls are claimed and driven entirely in Rust (spawn, ring buffer,
    /// settle) instead of falling back to the host's process domain.
    pub background: Option<Arc<std::sync::Mutex<crate::background::manager::BackgroundManager>>>,
    /// Native permission gate. When set, write-class / Bash approval is
    /// decided in Rust: `Approve` runs without a host round-trip, `Deny`
    /// blocks locally, and `Ask` (interactive) still defers to the host —
    /// the documented permission exemption. When `None`, every gated call
    /// defers to the host approval hooks (backward-compatible default).
    pub permission: Option<crate::permission::gate::PermissionGate>,
    /// External lifecycle hooks (optional). When set, PermissionRequest /
    /// PermissionResult fire around each gated decision (a blocking
    /// PermissionRequest vetoes the call locally).
    pub hooks: Option<Arc<crate::hooks::external::HookManager>>,
    /// Pending-approval store (optional). When set, deferred approvals
    /// register a pending entry, publish `session.approval.requested`, and
    /// wait on a decision from either the host authorize callback or the
    /// `session/approval_resolve` RPC (web).
    pub approval: Option<crate::approval::SharedApprovalStore>,
}

/// Outcome of consulting the native permission gate for a gated tool call.
enum NativeAuth {
    /// Approved locally — skip the host authorize round-trip.
    Approved,
    /// Denied locally with a reason — block without touching the host.
    Denied(String),
    /// Interactive approval required (or no native gate) — defer to the host.
    Defer,
}

/// Consult the optional native permission gate for a prospective tool call.
/// When a hook manager is present, `PermissionRequest` fires first (a
/// blocking hook vetoes the call locally, mirroring the TS permission-request
/// veto) and `PermissionResult` fires after the decision (fire-and-forget).
async fn native_authorize(
    gate: &Option<crate::permission::gate::PermissionGate>,
    hooks: &Option<Arc<crate::hooks::external::HookManager>>,
    tool_name: &str,
    tool_call_id: &str,
    args: &serde_json::Value,
) -> NativeAuth {
    use crate::permission::types::PermissionPolicyResult;

    // PermissionRequest: a blocking hook denies the call before the gate.
    if let Some(manager) = hooks {
        if manager.has_hooks_for(crate::hooks::external::HookEventType::PermissionRequest) {
            let input = serde_json::json!({
                "tool_name": tool_name,
                "tool_call_id": tool_call_id,
                "arguments": args,
            });
            let blocked = manager
                .run_matching(
                    crate::hooks::external::HookEventType::PermissionRequest,
                    Some(tool_name),
                    &input,
                )
                .await;
            if let Some(result) = blocked {
                let reason = result.stdout.clone().unwrap_or_default().trim().to_string();
                return NativeAuth::Denied(if reason.is_empty() {
                    format!("Permission denied by PermissionRequest hook for {tool_name}")
                } else {
                    reason
                });
            }
        }
    }

    let Some(gate) = gate else {
        return NativeAuth::Defer;
    };
    let decision = gate.evaluate(tool_name, tool_call_id, args);

    // PermissionResult: fire-and-forget after the decision.
    if let Some(manager) = hooks {
        if manager.has_hooks_for(crate::hooks::external::HookEventType::PermissionResult) {
            let outcome = match &decision {
                PermissionPolicyResult::Approve => "allow",
                PermissionPolicyResult::Deny { .. } => "deny",
                PermissionPolicyResult::Ask { .. } => "ask",
            };
            let input = serde_json::json!({
                "tool_name": tool_name,
                "tool_call_id": tool_call_id,
                "decision": outcome,
            });
            manager
                .run_all(crate::hooks::external::HookEventType::PermissionResult, Some(tool_name), &input)
                .await;
        }
    }

    match decision {
        PermissionPolicyResult::Approve => NativeAuth::Approved,
        PermissionPolicyResult::Deny { reason } => NativeAuth::Denied(reason),
        // Interactive approval is the host's job (permission exemption).
        PermissionPolicyResult::Ask { .. } => NativeAuth::Defer,
    }
}

/// Deferred interactive approval with the pending-approval surface.
///
/// Without a store this is a plain host `authorize_tool_execution` round-trip
/// (RUN_TURN path, single-session). With one, the call registers a pending
/// entry, publishes `session.approval.requested`, and waits on the decision
/// channel — fed by either the host authorize callback (TUI / vscode panels)
/// or `session/approval_resolve` (web). The first decision wins; the other
/// channel's result is discarded.
async fn defer_to_host(
    inner: &Arc<dyn HostCallbacks>,
    approval: &Option<crate::approval::SharedApprovalStore>,
    req: AuthorizeToolRequest,
) -> Result<Option<AuthorizeToolResponse>, String> {
    let Some(store) = approval else {
        return inner.authorize_tool_execution(req).await;
    };

    use crate::approval::{ApprovalDecision, ApprovalEntry};
    let rx = store.request(
        req.session_id.clone(),
        req.tool_call_id.clone(),
        req.tool_name.clone(),
        req.arguments.clone(),
        req.approval_rule.clone(),
    );
    // Publish the pending entry so web UIs can render the approval card.
    let entry: Option<ApprovalEntry> = store
        .list(req.session_id.as_deref())
        .into_iter()
        .find(|e| e.tool_call_id == req.tool_call_id);
    if let Some(ref e) = entry {
        inner.emit_event(crate::approval::approval_requested_event(e));
    }

    // Second decision channel: the host authorize callback (TUI panels keep
    // their existing flow). Its outcome is injected into the store; the wait
    // below consumes whichever decision arrives first.
    let store_cb = store.clone();
    let inner_cb = inner.clone();
    let cb_req = req.clone();
    let tool_call_id = req.tool_call_id.clone();
    tokio::spawn(async move {
        match inner_cb.authorize_tool_execution(cb_req).await {
            Ok(Some(decision)) => {
                let injected = if decision.block {
                    ApprovalDecision::Deny {
                        reason: decision.reason,
                    }
                } else if let Some(synthetic) = decision.synthetic_result {
                    ApprovalDecision::Synthetic {
                        content: synthetic.content,
                        is_error: synthetic.is_error,
                        note: synthetic.note,
                    }
                } else {
                    ApprovalDecision::Allow
                };
                let _ = store_cb.resolve_by_tool_call(&tool_call_id, injected);
            }
            Ok(None) => {
                let _ = store_cb.resolve_by_tool_call(&tool_call_id, ApprovalDecision::Allow);
            }
            // A failed callback leaves the entry pending for `approval_resolve`.
            Err(_) => {}
        }
    });

    match rx.await {
        Ok(ApprovalDecision::Allow) => Ok(None),
        Ok(ApprovalDecision::Deny { reason }) => Ok(Some(AuthorizeToolResponse {
            block: true,
            reason,
            synthetic_result: None,
            execution_metadata: None,
            resolved: true,
        })),
        Ok(ApprovalDecision::Synthetic {
            content,
            is_error,
            note,
        }) => Ok(Some(AuthorizeToolResponse {
            block: false,
            reason: None,
            synthetic_result: Some(ExecutableToolResultData {
                content,
                is_error,
                note,
                is_prediction: false,
                stop_turn: false,
            }),
            execution_metadata: None,
            resolved: true,
        })),
        // The store dropped the entry (turn torn down) — allow unchanged.
        Err(_) => Ok(None),
    }
}

/// Bash variant of [`native_authorize`]: a dangerous command must reach host
/// approval unless a user-configured allow rule explicitly matches it. This
/// stops a session approval — or auto/yolo mode — from blanket-approving
/// destructive commands locally; an explicit deny still wins. The `approval_rule`
/// the host sees for dangerous commands is `Bash(__dangerous__)`, which never
/// globs a real command, so a host-side session grant also cannot unlock
/// later shell access.
async fn bash_native_authorize(
    permission: &Option<crate::permission::gate::PermissionGate>,
    hooks: &Option<Arc<crate::hooks::external::HookManager>>,
    tool_name: &str,
    tool_call_id: &str,
    args: &serde_json::Value,
    dangerous: bool,
) -> NativeAuth {
    let mut auth = native_authorize(permission, hooks, tool_name, tool_call_id, args).await;
    if dangerous
        && matches!(auth, NativeAuth::Approved)
        && !permission.as_ref().map_or(false, |gate| {
            gate.user_allow_matches(tool_name, tool_call_id, args)
        })
    {
        auth = NativeAuth::Defer;
    }
    auth
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
        // approval gate as writes. Background runs are claimed when a native
        // BackgroundManager is attached (engine-owned paths); otherwise they
        // — like malformed args and transports without lifecycle hooks —
        // stay with the host, whose JS Bash owns the background-task domain.
        if request.tool_name.eq_ignore_ascii_case("bash") {
            if self.toolset.shell().is_some()
                && self.inner.supports_tool_lifecycle()
                && crate::tools::bash::claims_background_bash(&request.arguments)
            {
                if let Some(ref manager) = self.background {
                    let inner = self.inner.clone();
                    let toolset = self.toolset.clone();
                    let manager = manager.clone();
                    let permission = self.permission.clone();
                    let self_hooks = self.hooks.clone();
                    let self_approval = self.approval.clone();
                    return Box::pin(async move {
                        execute_gated_background_bash(inner, toolset, manager, permission, self_hooks, self_approval, request).await
                    });
                }
            }
            if self.toolset.shell().is_none()
                || !self.inner.supports_tool_lifecycle()
                || !crate::tools::bash::claims_bash(&request.arguments)
            {
                return self.inner.execute_tool(request);
            }
            let inner = self.inner.clone();
            let toolset = self.toolset.clone();
            let permission = self.permission.clone();
            let self_hooks = self.hooks.clone();
            let self_approval = self.approval.clone();
            return Box::pin(async move { execute_gated_bash(inner, toolset, permission, self_hooks, self_approval, request).await });
        }
        // Network read tools (WebSearch / FetchURL): executed natively via
        // reqwest, gated by the permission gate because they cause network
        // egress. Only when the transport delivers lifecycle hooks; otherwise
        // fall to the host. A Deny short-circuits before any network call.
        if request.tool_name.eq_ignore_ascii_case("websearch")
            || request.tool_name.eq_ignore_ascii_case("fetchurl")
        {
            if !self.inner.supports_tool_lifecycle() {
                return self.inner.execute_tool(request);
            }
            let inner = self.inner.clone();
            let permission = self.permission.clone();
            let self_hooks = self.hooks.clone();
            let self_approval = self.approval.clone();
            return Box::pin(async move { execute_gated_network(inner, permission, self_hooks, self_approval, request).await });
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
            let permission = self.permission.clone();
            let self_hooks = self.hooks.clone();
            let self_approval = self.approval.clone();
            return Box::pin(async move { execute_gated_write(inner, toolset, permission, self_hooks, self_approval, request).await });
        }
        // TaskOutput: read-only snapshot of a NATIVE background task. Only
        // claimed when the task id lives in the native manager — host-spawned
        // tasks (JS background domain) keep flowing to the host tool.
        if request.tool_name.eq_ignore_ascii_case("taskoutput") {
            if let Some(ref manager) = self.background {
                let task_id = request
                    .arguments
                    .get("task_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let snapshot = {
                    let mgr = manager.lock().unwrap_or_else(|e| e.into_inner());
                    mgr.get(&task_id).map(|task| {
                        let status = task.status;
                        let stop_reason = task.stop_reason.clone();
                        let output = mgr
                            .get_output_snapshot(&task_id)
                            .map(|s| s.preview)
                            .unwrap_or_default();
                        (status, stop_reason, output)
                    })
                };
                if let Some((status, stop_reason, output)) = snapshot {
                    let mut content = format!("status: {:?}\n", status).to_lowercase();
                    if let Some(reason) = stop_reason {
                        content.push_str(&format!("stop_reason: {reason}\n"));
                    }
                    content.push_str("--- output ---\n");
                    content.push_str(&output);
                    self.inner.emit_event(serde_json::json!({
                        "type": "tool.native",
                        "turn_id": request.turn_id,
                        "tool_call_id": request.tool_call_id,
                        "tool_name": request.tool_name,
                        "arguments": request.arguments,
                        "content": content,
                        "is_error": false,
                    }));
                    let response = ToolExecuteResponse {
                        content,
                        is_error: false,
                        is_prediction: false,
                        stop_turn: false,
                                    media: Vec::new(),
                    };
                    return Box::pin(async move { Ok(response) });
                }
            }
            return self.inner.execute_tool(request);
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
                media: result.media,
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
    permission: Option<crate::permission::gate::PermissionGate>,
    hooks: Option<Arc<crate::hooks::external::HookManager>>,
    approval: Option<crate::approval::SharedApprovalStore>,
    request: ToolExecuteRequest,
) -> Result<ToolExecuteResponse, String> {
    let approval_rule = write_approval_rule(&request.tool_name, &request.arguments);

    // ── Prepare ──────────────────────────────────────────────────────────
    let prepare = inner
        .prepare_tool_execution(PrepareToolRequest {
            session_id: request.session_id.clone(),
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
    // Native gate first: Approve runs without a host round-trip, Deny blocks
    // locally; only interactive Ask defers to the host authorize hook.
    match native_authorize(&permission, &hooks, &request.tool_name, &request.tool_call_id, &effective_args).await {
        NativeAuth::Approved => {}
        NativeAuth::Denied(reason) => {
            return Ok(blocked_response(Some(reason), &request.tool_name));
        }
        NativeAuth::Defer => {
            let authorize = defer_to_host(
                &inner,
                &approval,
                AuthorizeToolRequest {
                    session_id: request.session_id.clone(),
                    turn_id: request.turn_id.clone(),
                    step_number: 0,
                    tool_call_id: request.tool_call_id.clone(),
                    tool_name: request.tool_name.clone(),
                    arguments: effective_args.clone(),
                    all_tool_calls: vec![],
                    trace_id: None,
                    approval_rule,
                },
            )
            .await?;
            if let Some(ref decision) = authorize {
                if decision.block {
                    return Ok(blocked_response(decision.reason.clone(), &request.tool_name));
                }
                if let Some(ref synthetic) = decision.synthetic_result {
                    return Ok(from_result_data(synthetic));
                }
            }
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
            session_id: request.session_id.clone(),
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
            stop_turn: data.stop_turn, media: Vec::new(),
        });
    }
    Ok(ToolExecuteResponse {
        content: native.content,
        is_error: native.is_error,
        is_prediction: false,
        stop_turn: false,
                    media: Vec::new(),
    })
}

fn blocked_response(reason: Option<String>, tool_name: &str) -> ToolExecuteResponse {
    ToolExecuteResponse {
        content: reason.unwrap_or_else(|| format!("Tool call \"{tool_name}\" was blocked")),
        is_error: true,
        is_prediction: false,
        stop_turn: false,
                    media: Vec::new(),
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
    permission: Option<crate::permission::gate::PermissionGate>,
    hooks: Option<Arc<crate::hooks::external::HookManager>>,
    approval: Option<crate::approval::SharedApprovalStore>,
    request: ToolExecuteRequest,
) -> Result<ToolExecuteResponse, String> {
    // ── Prepare ──────────────────────────────────────────────────────────
    let prepare = inner
        .prepare_tool_execution(PrepareToolRequest {
            session_id: request.session_id.clone(),
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
    let dangerous = crate::tools::bash::is_dangerous_command(&command);
    let approval_rule = if dangerous {
        format!("Bash({})", crate::tools::bash::DANGEROUS_COMMAND_MARKER)
    } else {
        format!("Bash({})", escape_rule_subject_literal(&command))
    };
    match bash_native_authorize(&permission, &hooks, &request.tool_name, &request.tool_call_id, &effective_args, dangerous).await {
        NativeAuth::Approved => {}
        NativeAuth::Denied(reason) => {
            return Ok(blocked_response(Some(reason), &request.tool_name));
        }
        NativeAuth::Defer => {
            let authorize = defer_to_host(
                &inner,
                &approval,
                AuthorizeToolRequest {
                    session_id: request.session_id.clone(),
                    turn_id: request.turn_id.clone(),
                    step_number: 0,
                    tool_call_id: request.tool_call_id.clone(),
                    tool_name: request.tool_name.clone(),
                    arguments: effective_args.clone(),
                    all_tool_calls: vec![],
                    trace_id: None,
                    approval_rule,
                },
            )
            .await?;
            if let Some(ref decision) = authorize {
                if decision.block {
                    return Ok(blocked_response(decision.reason.clone(), &request.tool_name));
                }
                if let Some(ref synthetic) = decision.synthetic_result {
                    return Ok(from_result_data(synthetic));
                }
            }
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
            session_id: request.session_id.clone(),
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
            stop_turn: data.stop_turn, media: Vec::new(),
        });
    }
    Ok(ToolExecuteResponse {
        content: native.content,
        is_error: native.is_error,
        is_prediction: false,
        stop_turn: false,
                    media: Vec::new(),
    })
}

/// Run a `run_in_background` Bash call through the host approval gate, then
/// spawn it as a fully native background task (`NativeBashTask` driven by
/// `BackgroundManager::spawn_on`). Returns immediately with the task id;
/// output accumulates in the manager's ring buffer and is read back with
/// `TaskOutput`. Same single-lifecycle contract as `execute_gated_bash`.
async fn execute_gated_background_bash(
    inner: Arc<dyn HostCallbacks>,
    toolset: Arc<crate::tools::NativeToolset>,
    manager: Arc<std::sync::Mutex<crate::background::manager::BackgroundManager>>,
    permission: Option<crate::permission::gate::PermissionGate>,
    hooks: Option<Arc<crate::hooks::external::HookManager>>,
    approval: Option<crate::approval::SharedApprovalStore>,
    request: ToolExecuteRequest,
) -> Result<ToolExecuteResponse, String> {
    // ── Prepare ──────────────────────────────────────────────────────────
    let prepare = inner
        .prepare_tool_execution(PrepareToolRequest {
            session_id: request.session_id.clone(),
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
    // Re-admit after a possible args rewrite; fails closed (same contract as
    // the foreground path — the host lifecycle must not run twice).
    if !crate::tools::bash::claims_background_bash(&effective_args) {
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
    let dangerous = crate::tools::bash::is_dangerous_command(&command);
    let approval_rule = if dangerous {
        format!("Bash({})", crate::tools::bash::DANGEROUS_COMMAND_MARKER)
    } else {
        format!("Bash({})", escape_rule_subject_literal(&command))
    };
    match bash_native_authorize(&permission, &hooks, &request.tool_name, &request.tool_call_id, &effective_args, dangerous).await {
        NativeAuth::Approved => {}
        NativeAuth::Denied(reason) => {
            return Ok(blocked_response(Some(reason), &request.tool_name));
        }
        NativeAuth::Defer => {
            let authorize = defer_to_host(
                &inner,
                &approval,
                AuthorizeToolRequest {
                    session_id: request.session_id.clone(),
                    turn_id: request.turn_id.clone(),
                    step_number: 0,
                    tool_call_id: request.tool_call_id.clone(),
                    tool_name: request.tool_name.clone(),
                    arguments: effective_args.clone(),
                    all_tool_calls: vec![],
                    trace_id: None,
                    approval_rule,
                },
            )
            .await?;
            if let Some(ref decision) = authorize {
                if decision.block {
                    return Ok(blocked_response(decision.reason.clone(), &request.tool_name));
                }
                if let Some(ref synthetic) = decision.synthetic_result {
                    return Ok(from_result_data(synthetic));
                }
            }
        }
    }

    // ── Spawn the native background task ───────────────────────────────────
    let cwd = match effective_args.get("cwd").and_then(|v| v.as_str()) {
        Some(dir) if !dir.trim().is_empty() => {
            let path = std::path::PathBuf::from(dir);
            if path.is_absolute() { path } else { toolset.root().join(path) }
        }
        _ => toolset.root().to_path_buf(),
    };
    let Some(runner) = toolset.shell().cloned() else {
        return Ok(blocked_response(Some("Native shell unavailable".into()), &request.tool_name));
    };
    let description = effective_args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or(&command)
        .to_string();
    let timeout_ms = effective_args
        .get("timeout")
        .and_then(|v| v.as_u64())
        .map(|s| s * 1000);
    let task = Box::new(crate::background::native_bash_task::NativeBashTask::new(
        runner,
        command,
        cwd.to_string_lossy().into_owned(),
        description,
    ));
    let options = crate::background::types::RegisterOptions {
        detached: true,
        timeout_ms,
        ..Default::default()
    };
    let Some(task_id) = crate::background::manager::BackgroundManager::spawn_on(
        &manager,
        "bash",
        task,
        Some(options),
    ) else {
        return Ok(blocked_response(
            Some("Background task limit reached — run the command in the foreground or stop an existing task".into()),
            &request.tool_name,
        ));
    };

    let content = format!(
        "Command started in background.\ntask_id: {task_id}\nUse TaskOutput(task_id=\"{task_id}\") to read its output."
    );
    inner.emit_event(serde_json::json!({
        "type": "tool.native",
        "turn_id": request.turn_id,
        "tool_call_id": request.tool_call_id,
        "tool_name": request.tool_name,
        "arguments": effective_args,
        "content": content,
        "is_error": false,
    }));

    // ── Finalize (redaction / truncation) ──────────────────────────────────
    let finalized = inner
        .finalize_tool_result(FinalizeToolRequest {
            session_id: request.session_id.clone(),
            turn_id: request.turn_id.clone(),
            step_number: 0,
            tool_call_id: request.tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: effective_args,
            result: ExecutableToolResultData {
                content: content.clone(),
                is_error: false,
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
            stop_turn: data.stop_turn, media: Vec::new(),
        });
    }
    Ok(ToolExecuteResponse {
        content,
        is_error: false,
        is_prediction: false,
        stop_turn: false,
                    media: Vec::new(),
    })
}

fn from_result_data(data: &ExecutableToolResultData) -> ToolExecuteResponse {
    ToolExecuteResponse {
        content: data.content.clone(),
        is_error: data.is_error,
        is_prediction: false,
        stop_turn: data.stop_turn, media: Vec::new(),
    }
}

/// Render web-search / fetch-url results into tool output text.
fn render_web_search(results: &crate::tools::web_search::WebSearchResult) -> String {
    if results.is_empty() {
        return "No results.".to_string();
    }
    let mut out = String::new();
    for (i, r) in results.iter().enumerate() {
        out.push_str(&format!("{}. {}\n   {}\n", i + 1, r.title, r.url));
        if !r.snippet.is_empty() {
            out.push_str(&format!("   {}\n", r.snippet));
        }
    }
    out
}

/// Run a network read tool (WebSearch / FetchURL) through the permission gate,
/// then execute it natively with reqwest. Mirrors the single-lifecycle
/// contract of `execute_gated_bash`; a Deny short-circuits before any network
/// call. The workspace sandbox is irrelevant here (no filesystem access).
async fn execute_gated_network(
    inner: Arc<dyn HostCallbacks>,
    permission: Option<crate::permission::gate::PermissionGate>,
    hooks: Option<Arc<crate::hooks::external::HookManager>>,
    approval: Option<crate::approval::SharedApprovalStore>,
    request: ToolExecuteRequest,
) -> Result<ToolExecuteResponse, String> {
    // ── Prepare ──────────────────────────────────────────────────────────
    let prepare = inner
        .prepare_tool_execution(PrepareToolRequest {
            session_id: request.session_id.clone(),
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

    let is_search = request.tool_name.eq_ignore_ascii_case("websearch");
    // WebSearch takes `query`; FetchURL takes `url`.
    let subject = effective_args
        .get(if is_search { "query" } else { "url" })
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if subject.trim().is_empty() {
        return Ok(blocked_response(
            Some(format!("{} requires a non-empty {}", request.tool_name, if is_search { "query" } else { "url" })),
            &request.tool_name,
        ));
    }

    // ── Authorize (permission gate) ────────────────────────────────────────
    let approval_rule = format!("{}({})", request.tool_name, escape_rule_subject_literal(&subject));
    match native_authorize(&permission, &hooks, &request.tool_name, &request.tool_call_id, &effective_args).await {
        NativeAuth::Approved => {}
        NativeAuth::Denied(reason) => {
            return Ok(blocked_response(Some(reason), &request.tool_name));
        }
        NativeAuth::Defer => {
            let authorize = defer_to_host(
                &inner,
                &approval,
                AuthorizeToolRequest {
                    session_id: request.session_id.clone(),
                    turn_id: request.turn_id.clone(),
                    step_number: 0,
                    tool_call_id: request.tool_call_id.clone(),
                    tool_name: request.tool_name.clone(),
                    arguments: effective_args.clone(),
                    all_tool_calls: vec![],
                    trace_id: None,
                    approval_rule,
                },
            )
            .await?;
            if let Some(ref decision) = authorize {
                if decision.block {
                    return Ok(blocked_response(decision.reason.clone(), &request.tool_name));
                }
                if let Some(ref synthetic) = decision.synthetic_result {
                    return Ok(from_result_data(synthetic));
                }
            }
        }
    }

    // ── Execute natively (network) ──────────────────────────────────────────
    let (content, is_error) = if is_search {
        match crate::tools::web_search::web_search(&subject).await {
            Ok(results) => (render_web_search(&results), false),
            Err(e) => (format!("WebSearch failed: {e}"), true),
        }
    } else {
        match crate::tools::fetch_url::fetch_url(&subject).await {
            Ok(r) => {
                let mut body = r.content;
                if r.truncated {
                    body.push_str("\n\n[content truncated]");
                }
                (body, false)
            }
            Err(e) => (format!("FetchURL failed: {e}"), true),
        }
    };
    inner.emit_event(serde_json::json!({
        "type": "tool.native",
        "turn_id": request.turn_id,
        "tool_call_id": request.tool_call_id,
        "tool_name": request.tool_name,
        "arguments": effective_args,
        "content": content,
        "is_error": is_error,
    }));

    // ── Finalize ─────────────────────────────────────────────────────────────
    let finalized = inner
        .finalize_tool_result(FinalizeToolRequest {
            session_id: request.session_id.clone(),
            turn_id: request.turn_id.clone(),
            step_number: 0,
            tool_call_id: request.tool_call_id.clone(),
            tool_name: request.tool_name.clone(),
            arguments: effective_args,
            result: ExecutableToolResultData {
                content: content.clone(),
                is_error,
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
            stop_turn: data.stop_turn, media: Vec::new(),
        });
    }
    Ok(ToolExecuteResponse { content, is_error, is_prediction: false, stop_turn: false, media: Vec::new() })
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
                                media: Vec::new(),
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
            background: None,
            permission: None,
            hooks: None,
            approval: None,
        };
        (dir, host, callbacks)
    }

    fn write_request(path: &str) -> ToolExecuteRequest {
        ToolExecuteRequest {
            session_id: None,
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
                session_id: None,
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
            background: None,
            permission: None,
            hooks: None,
            approval: None,
        };
        Some((dir, host, callbacks))
    }

    /// Like [`setup_with_shell`], but with an explicit permission gate —
    /// used by the dangerous-Bash tests, which must exercise the native
    /// approval gate while the shell is present.
    fn setup_with_gate_and_shell(
        gate: PermissionGate,
    ) -> Option<(tempfile::TempDir, Arc<MockHost>, NativeToolCallbacks)> {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = Arc::new(MockHost::new(true, true));
        let toolset = crate::tools::NativeToolset::new(dir.path().to_str().unwrap())?
            .with_shell();
        toolset.shell()?;
        let callbacks = NativeToolCallbacks {
            inner: host.clone(),
            toolset: Arc::new(toolset),
            background: None,
            permission: Some(gate),
            hooks: None,
            approval: None,
        };
        Some((dir, host, callbacks))
    }

    fn bash_request(command: &str) -> ToolExecuteRequest {
        ToolExecuteRequest {
            session_id: None,
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
                session_id: None,
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
        // Without a native BackgroundManager the background domain still
        // belongs to the host: no native gate ran.
        assert_eq!(response.content, "host executed");
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn background_bash_with_a_manager_spawns_natively_and_reads_back() {
        let Some((_dir, host, mut callbacks)) = setup_with_shell(false) else {
            eprintln!("no shell available; skipping");
            return;
        };
        let manager = Arc::new(std::sync::Mutex::new(
            crate::background::manager::BackgroundManager::new(None),
        ));
        callbacks.background = Some(manager.clone());

        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "b3".into(),
                tool_name: "Bash".into(),
                arguments: serde_json::json!({
                    "command": "echo native-bg-done",
                    "run_in_background": true,
                    "description": "bg echo"
                }),
                force_precise: false,
            })
            .await
            .unwrap();

        // Immediate return with the task id, gated by the full lifecycle.
        assert!(!response.is_error, "{}", response.content);
        assert!(response.content.contains("task_id: bash-"), "{}", response.content);
        assert_eq!(host.prepare_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.finalize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 0);

        let task_id = response
            .content
            .lines()
            .find_map(|l| l.strip_prefix("task_id: "))
            .expect("task id line")
            .to_string();

        // The spawned process settles and its output lands in the ring buffer.
        for _ in 0..300 {
            let done = {
                let mgr = manager.lock().unwrap();
                mgr.get(&task_id).map(|t| t.status.is_terminal()).unwrap_or(false)
            };
            if done {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // TaskOutput claims the native task and returns status + output.
        let output = callbacks
            .execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "b4".into(),
                tool_name: "TaskOutput".into(),
                arguments: serde_json::json!({ "task_id": task_id }),
                force_precise: false,
            })
            .await
            .unwrap();
        assert!(!output.is_error, "{}", output.content);
        assert!(output.content.contains("status: completed"), "{}", output.content);
        assert!(output.content.contains("native-bg-done"), "{}", output.content);
        // Read-only snapshot: no extra host lifecycle, no host execution.
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn task_output_for_an_unknown_task_goes_to_the_host() {
        let (_dir, host, mut callbacks) = setup(true, false);
        callbacks.background = Some(Arc::new(std::sync::Mutex::new(
            crate::background::manager::BackgroundManager::new(None),
        )));
        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "b5".into(),
                tool_name: "TaskOutput".into(),
                arguments: serde_json::json!({ "task_id": "bash-not-ours" }),
                force_precise: false,
            })
            .await
            .unwrap();
        // Host-spawned tasks keep flowing to the host tool.
        assert_eq!(response.content, "host executed");
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 1);
    }

    // ── Native permission gate on the write path ──────────────────────────────

    use crate::permission::gate::PermissionGate;
    use crate::permission::manager::PermissionManager;
    use crate::permission::types::{
        PermissionMode, PermissionRule, PermissionRuleDecision, PermissionRuleScope,
    };

    /// Build a native-write toolset wired with a specific permission gate.
    fn setup_with_gate(gate: PermissionGate) -> (tempfile::TempDir, Arc<MockHost>, NativeToolCallbacks) {
        let dir = tempfile::tempdir().expect("tempdir");
        // lifecycle=true so the gated write path is taken; authorize_block=true
        // so IF the host authorize hook ran it would deny — proving the native
        // gate short-circuited when the write actually lands on disk.
        let host = Arc::new(MockHost::new(true, true));
        let toolset = crate::tools::NativeToolset::new(dir.path().to_str().unwrap()).unwrap();
        let callbacks = NativeToolCallbacks {
            inner: host.clone(),
            toolset: Arc::new(toolset),
            background: None,
            permission: Some(gate),
            hooks: None,
            approval: None,
        };
        (dir, host, callbacks)
    }

    #[tokio::test]
    async fn yolo_gate_approves_write_without_host_authorize() {
        let mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo);
        let (dir, host, callbacks) = setup_with_gate(PermissionGate::new(mgr));

        let response = callbacks.execute_tool(write_request("y.txt")).await.unwrap();
        assert!(!response.is_error, "{}", response.content);
        // Native approval → host authorize never consulted, yet the write ran.
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read_to_string(dir.path().join("y.txt")).unwrap(), "hello");
    }

    #[tokio::test]
    async fn deny_rule_blocks_write_without_host_authorize() {
        let mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo); // even under yolo, an explicit deny wins
        mgr.add_rule(PermissionRule {
            decision: PermissionRuleDecision::Deny,
            scope: PermissionRuleScope::User,
            pattern: "Write".into(),
            reason: Some("blocked by policy".into()),
        });
        let (dir, host, callbacks) = setup_with_gate(PermissionGate::new(mgr));

        let response = callbacks.execute_tool(write_request("d.txt")).await.unwrap();
        assert!(response.is_error);
        // Denied locally: no host round-trip and nothing written.
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 0);
        assert!(!dir.path().join("d.txt").exists());
    }

    #[tokio::test]
    async fn manual_gate_defers_write_to_host_authorize() {
        // Manual mode → Ask → defers to the host authorize hook, which here
        // blocks (authorize_block=true), so the write must not land.
        let (dir, host, callbacks) = setup_with_gate(PermissionGate::new(PermissionManager::new()));

        let response = callbacks.execute_tool(write_request("m.txt")).await.unwrap();
        assert!(response.is_error);
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 1);
        assert!(!dir.path().join("m.txt").exists());
    }

    #[tokio::test]
    async fn deny_rule_blocks_websearch_natively_before_any_network() {
        // A deny rule for WebSearch under yolo → the native gate denies
        // locally, short-circuiting before the reqwest call and before any
        // host authorize round-trip. Deterministic (no network reached).
        let mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo);
        mgr.add_rule(PermissionRule {
            decision: PermissionRuleDecision::Deny,
            scope: PermissionRuleScope::User,
            pattern: "WebSearch".into(),
            reason: Some("web search disabled in test".into()),
        });
        let (_dir, host, callbacks) = setup_with_gate(PermissionGate::new(mgr));

        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "w1".into(),
                tool_name: "WebSearch".into(),
                arguments: serde_json::json!({ "query": "anything" }),
                force_precise: false,
            })
            .await
            .unwrap();
        assert!(response.is_error);
        // Denied locally: no host authorize, no host execution, no network.
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 0);
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn dangerous_bash_reaches_host_approval_even_under_yolo() {
        // Even in yolo mode (which approves everything locally) a dangerous
        // command without an explicit user allow rule defers to the host
        // approve hook — a session approval or auto/yolo mode must never
        // blanket-approve destructive commands. authorize_block=true here:
        // the host hook runs and blocks, so nothing executes.
        let mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo);
        let Some((_dir, host, callbacks)) = setup_with_gate_and_shell(PermissionGate::new(mgr))
        else {
            eprintln!("no shell available; skipping");
            return;
        };

        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "d1".into(),
                tool_name: "Bash".into(),
                arguments: serde_json::json!({ "command": "chmod 777 no-such-file" }),
                force_precise: false,
            })
            .await
            .unwrap();
        // The host authorize hook was consulted (and blocked) → dangerous
        // commands are never approved locally under a broad grant.
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 0);
        assert!(response.is_error);
    }

    #[tokio::test]
    async fn dangerous_bash_with_explicit_allow_is_approved_locally() {
        // An explicit user-configured allow rule that matches the command
        // exempts it from host approval, even when the command is dangerous.
        let mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo);
        mgr.add_rule(PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Bash(chmod 777 *)".into(),
            reason: None,
        });
        let Some((dir, host, callbacks)) = setup_with_gate_and_shell(PermissionGate::new(mgr))
        else {
            eprintln!("no shell available; skipping");
            return;
        };
        std::fs::write(dir.path().join("perm.txt"), "x").unwrap();

        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "d2".into(),
                tool_name: "Bash".into(),
                arguments: serde_json::json!({ "command": "chmod 777 perm.txt" }),
                force_precise: false,
            })
            .await
            .unwrap();
        assert!(!response.is_error, "{}", response.content);
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn dangerous_bash_session_approval_does_not_skip_host() {
        // A session approval granted for a dangerous command (`Bash(__dangerous__)`)
        // must not unlock later shell access: the same dangerous command still
        // reaches host approval.
        let mgr = PermissionManager::new();
        mgr.set_mode(PermissionMode::Yolo);
        mgr.state().record_session_approval(PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::SessionRuntime,
            pattern: "Bash(__dangerous__)".into(),
            reason: None,
        });
        let Some((_dir, host, callbacks)) = setup_with_gate_and_shell(PermissionGate::new(mgr))
        else {
            eprintln!("no shell available; skipping");
            return;
        };

        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "d3".into(),
                tool_name: "Bash".into(),
                arguments: serde_json::json!({ "command": "chmod 777 no-such-file" }),
                force_precise: false,
            })
            .await
            .unwrap();
        assert_eq!(host.authorize_calls.load(Ordering::SeqCst), 1);
        assert!(response.is_error);
    }

    #[tokio::test]
    async fn websearch_without_lifecycle_falls_back_to_host() {
        // No lifecycle hooks → the native network branch is not taken; the
        // call flows to the host tool (the JS side owns it).
        let dir = tempfile::tempdir().expect("tempdir");
        let host = Arc::new(MockHost::new(false, false));
        let toolset = crate::tools::NativeToolset::new(dir.path().to_str().unwrap()).unwrap();
        let callbacks = NativeToolCallbacks {
            inner: host.clone(),
            toolset: Arc::new(toolset),
            background: None,
            approval: None,
            permission: None,
            hooks: None,
        };
        let response = callbacks
            .execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "w2".into(),
                tool_name: "WebSearch".into(),
                arguments: serde_json::json!({ "query": "x" }),
                force_precise: false,
            })
            .await
            .unwrap();
        assert_eq!(response.content, "host executed");
        assert_eq!(host.host_execute_calls.load(Ordering::SeqCst), 1);
    }
}


    /// PermissionRequest hooks: a blocking hook vetoes the gated call before
    /// the gate is consulted; PermissionResult fires after the decision.
    #[tokio::test]
    async fn permission_hooks_veto_and_notify() {
        let gate = crate::permission::gate::PermissionGate::from_env();
        // A PermissionRequest hook that blocks with a reason.
        let hooks = crate::hooks::external::HookManager::new(vec![
            crate::hooks::external::HookDef {
                event: crate::hooks::external::HookEventType::PermissionRequest,
                matcher: None,
                command: "exit 2".into(),
                timeout: None,
                cwd: None,
                env: None,
            },
        ]);
        let decision = native_authorize(
            &Some(gate.clone()),
            &Some(Arc::new(hooks)),
            "Bash",
            "c1",
            &serde_json::json!({ "command": "ls" }),
        )
        .await;
        assert!(
            matches!(&decision, NativeAuth::Denied(reason) if reason.contains("Permission denied by PermissionRequest hook")),
            "PermissionRequest veto must deny locally"
        );

        // PermissionResult hooks fire (fire-and-forget) after the decision:
        // run one explicitly and verify the event reaches a blocking-aware
        // path — here just the gate decision with no hooks (defer to host).
        let gate = gate;
        let decision = native_authorize(
            &Some(gate),
            &None,
            "Bash",
            "c2",
            &serde_json::json!({ "command": "ls" }),
        )
        .await;
        assert!(matches!(decision, NativeAuth::Defer), "manual Bash defers to host");
    }
