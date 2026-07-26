/// Host callback trait for LLM chat and tool execution.
///
/// This trait abstracts the transport layer — whether it's JSON-RPC over
/// stdio (the RpcServer-based implementation) or direct napi-rs
/// ThreadsafeFunction calls. The turn loop uses this trait to call back
/// to the JS host for LLM inference and tool execution.
use std::sync::Arc;

use crate::rpc::types::{
    AuthorizeToolRequest, AuthorizeToolResponse, BoxFuture, ExecutableToolResultData,
    FinalizeToolRequest, FinalizeToolResponse, LlmChatRequest, LlmChatResponse,
    PrepareToolRequest, PrepareToolResponse, ToolExecuteRequest, ToolExecuteResponse,
};

/// Host-provided callbacks that the turn loop needs to call back to JS.
pub trait HostCallbacks: Send + Sync {
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