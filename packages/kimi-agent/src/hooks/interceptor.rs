//! External-hooks tool interceptor — the engine-native execution point for
//! user-configured `PreToolUse` / `PostToolUse` / `PostToolUseFailure` hooks.
//!
//! Sits in the agent's `HostCallbacks` decorator chain (like the MCP / Skill /
//! Subagent interceptors), so it sees **every** tool call — native, MCP, goal,
//! and host-executed alike — with the tool name available for matcher
//! matching. This is the seam the TS side implements via
//! `toolExecutor.onBeforeExecuteTool` (`externalHooksService.ts`); the
//! step-level `LoopHooks` cannot host it because they fire without a tool name.
//!
//! Semantics (TS parity):
//! - `PreToolUse` blocks veto the call: the tool never runs and the model sees
//!   an error result carrying the hook's reason.
//! - `PostToolUse` / `PostToolUseFailure` are fire-and-forget: they run on a
//!   spawned task and never delay or fail the turn.

use std::sync::Arc;

use crate::callbacks::HostCallbacks;
use crate::hooks::external::{HookEventType, HookManager};
use crate::rpc::types::{
    AuthorizeToolRequest, AuthorizeToolResponse, BoxFuture, FinalizeToolRequest,
    FinalizeToolResponse, LlmChatRequest, LlmChatResponse, PrepareToolRequest,
    PrepareToolResponse, ToolExecuteRequest, ToolExecuteResponse,
};

/// Maximum tool output length forwarded to PostToolUse hooks (TS: 2000).
const POST_TOOL_OUTPUT_LIMIT: usize = 2000;

pub struct ExternalHooksInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
    pub manager: Arc<HookManager>,
    pub session_id: String,
    pub cwd: String,
}

impl ExternalHooksInterceptor {
    /// Base payload shared by every hook event, matching the TS runner's
    /// snake_case `toHookInputData` envelope.
    fn base_payload(&self, event: &str) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();
        map.insert("hook_event_name".into(), event.into());
        map.insert("session_id".into(), self.session_id.clone().into());
        map.insert("cwd".into(), self.cwd.clone().into());
        map
    }
}

impl HostCallbacks for ExternalHooksInterceptor {
    fn supports_tool_lifecycle(&self) -> bool {
        self.inner.supports_tool_lifecycle()
    }

    fn llm_chat(&self, r: LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
        self.inner.llm_chat(r)
    }

    fn execute_tool(
        &self,
        req: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if !self.manager.has_hooks_for(HookEventType::PreToolUse)
            && !self.manager.has_hooks_for(HookEventType::PostToolUse)
            && !self.manager.has_hooks_for(HookEventType::PostToolUseFailure)
        {
            return self.inner.execute_tool(req);
        }

        let inner = self.inner.clone();
        let manager = self.manager.clone();
        let mut pre_payload = self.base_payload("PreToolUse");
        let mut post_payload_base = self.base_payload("PostToolUse");
        for payload in [&mut pre_payload, &mut post_payload_base] {
            payload.insert("tool_name".into(), req.tool_name.clone().into());
            payload.insert("tool_input".into(), req.arguments.clone());
            payload.insert("tool_call_id".into(), req.tool_call_id.clone().into());
        }
        Box::pin(async move {
            // PreToolUse: a block vetoes the call before anything executes.
            if manager.has_hooks_for(HookEventType::PreToolUse) {
                let block = manager
                    .run_matching(
                        HookEventType::PreToolUse,
                        Some(&req.tool_name),
                        &serde_json::Value::Object(pre_payload),
                    )
                    .await;
                if let Some(result) = block {
                    let reason = result
                        .reason
                        .filter(|r| !r.trim().is_empty())
                        .unwrap_or_else(|| "Blocked by PreToolUse hook".to_string());
                    return Ok(ToolExecuteResponse {
                        content: reason,
                        is_error: true,
                        ..Default::default()
                    });
                }
            }

            let outcome = inner.execute_tool(req).await;

            // PostToolUse / PostToolUseFailure: fire-and-forget on a spawned
            // task, so a slow hook never extends the turn (TS parity).
            let (event, event_name) = match &outcome {
                Ok(resp) if resp.is_error => {
                    (HookEventType::PostToolUseFailure, "PostToolUseFailure")
                }
                Ok(_) => (HookEventType::PostToolUse, "PostToolUse"),
                Err(_) => (HookEventType::PostToolUseFailure, "PostToolUseFailure"),
            };
            if manager.has_hooks_for(event) {
                post_payload_base.insert("hook_event_name".into(), event_name.into());
                match &outcome {
                    Ok(resp) if !resp.is_error => {
                        let truncated: String =
                            resp.content.chars().take(POST_TOOL_OUTPUT_LIMIT).collect();
                        post_payload_base.insert("tool_output".into(), truncated.into());
                    }
                    Ok(resp) => {
                        post_payload_base.insert("error".into(), resp.content.clone().into());
                    }
                    Err(e) => {
                        post_payload_base.insert("error".into(), e.clone().into());
                    }
                }
                let tool_name = post_payload_base
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let payload = serde_json::Value::Object(post_payload_base);
                tokio::spawn(async move {
                    let _ = manager.run_matching(event, Some(&tool_name), &payload).await;
                });
            }

            outcome
        })
    }

    fn emit_event(&self, e: serde_json::Value) {
        self.inner.emit_event(e);
    }

    fn prepare_tool_execution(
        &self,
        r: PrepareToolRequest,
    ) -> BoxFuture<'static, Result<Option<PrepareToolResponse>, String>> {
        self.inner.prepare_tool_execution(r)
    }

    fn authorize_tool_execution(
        &self,
        r: AuthorizeToolRequest,
    ) -> BoxFuture<'static, Result<Option<AuthorizeToolResponse>, String>> {
        self.inner.authorize_tool_execution(r)
    }

    fn finalize_tool_result(
        &self,
        r: FinalizeToolRequest,
    ) -> BoxFuture<'static, Result<FinalizeToolResponse, String>> {
        self.inner.finalize_tool_result(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::external::HookDef;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Inner callbacks that count executions and return a fixed result.
    struct CountingCallbacks {
        executed: AtomicU32,
        is_error: bool,
    }
    impl HostCallbacks for CountingCallbacks {
        fn llm_chat(
            &self,
            _r: LlmChatRequest,
        ) -> BoxFuture<'static, Result<LlmChatResponse, String>> {
            Box::pin(async { Err("not used".into()) })
        }
        fn execute_tool(
            &self,
            _r: ToolExecuteRequest,
        ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            self.executed.fetch_add(1, Ordering::SeqCst);
            let is_error = self.is_error;
            Box::pin(async move {
                Ok(ToolExecuteResponse {
                    content: "tool output".into(),
                    is_error,
                    ..Default::default()
                })
            })
        }
    }

    fn block_cmd() -> String {
        if cfg!(windows) {
            "echo denied 1>&2 & exit /b 2".to_string()
        } else {
            "echo denied 1>&2; exit 2".to_string()
        }
    }

    fn request(tool: &str) -> ToolExecuteRequest {
        ToolExecuteRequest {
            session_id: None,
            turn_id: "t1".into(),
            tool_call_id: "tc1".into(),
            tool_name: tool.into(),
            arguments: serde_json::json!({"path": "/x"}),
            force_precise: false,
        }
    }

    fn interceptor(
        hooks: Vec<HookDef>,
        inner: Arc<CountingCallbacks>,
    ) -> ExternalHooksInterceptor {
        ExternalHooksInterceptor {
            inner,
            manager: Arc::new(HookManager::new(hooks)),
            session_id: "s1".into(),
            cwd: ".".into(),
        }
    }

    #[tokio::test]
    async fn pre_tool_use_block_vetoes_execution() {
        let inner = Arc::new(CountingCallbacks { executed: AtomicU32::new(0), is_error: false });
        let hooks = vec![HookDef {
            event: HookEventType::PreToolUse,
            matcher: Some("^Write$".into()),
            command: block_cmd(),
            timeout: Some(10),
            cwd: None,
            env: None,
        }];
        let it = interceptor(hooks, inner.clone());

        let resp = it.execute_tool(request("Write")).await.unwrap();
        assert!(resp.is_error);
        assert_eq!(resp.content, "denied");
        assert_eq!(inner.executed.load(Ordering::SeqCst), 0, "tool must not run");
    }

    #[tokio::test]
    async fn pre_tool_use_matcher_miss_lets_tool_run() {
        let inner = Arc::new(CountingCallbacks { executed: AtomicU32::new(0), is_error: false });
        let hooks = vec![HookDef {
            event: HookEventType::PreToolUse,
            matcher: Some("^Write$".into()),
            command: block_cmd(),
            timeout: Some(10),
            cwd: None,
            env: None,
        }];
        let it = interceptor(hooks, inner.clone());

        let resp = it.execute_tool(request("Read")).await.unwrap();
        assert!(!resp.is_error);
        assert_eq!(resp.content, "tool output");
        assert_eq!(inner.executed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn no_hooks_is_a_transparent_passthrough() {
        let inner = Arc::new(CountingCallbacks { executed: AtomicU32::new(0), is_error: false });
        let it = interceptor(vec![], inner.clone());
        let resp = it.execute_tool(request("Read")).await.unwrap();
        assert!(!resp.is_error);
        assert_eq!(inner.executed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn post_tool_use_never_blocks_the_result() {
        // A blocking PostToolUse hook must not turn a success into an error —
        // it is fire-and-forget by contract.
        let inner = Arc::new(CountingCallbacks { executed: AtomicU32::new(0), is_error: false });
        let hooks = vec![HookDef {
            event: HookEventType::PostToolUse,
            matcher: None,
            command: block_cmd(),
            timeout: Some(10),
            cwd: None,
            env: None,
        }];
        let it = interceptor(hooks, inner.clone());
        let resp = it.execute_tool(request("Read")).await.unwrap();
        assert!(!resp.is_error);
        assert_eq!(resp.content, "tool output");
    }
}
