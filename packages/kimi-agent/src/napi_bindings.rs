/// napi-rs bindings for the kimi-agent Rust engine.
///
/// This module exposes the turn loop as a native Node.js addon via napi-rs,
/// enabling direct in-process communication between Node.js and Rust without
/// the stdio JSON-RPC bridge.
///
/// ## Callback architecture
///
/// napi-rs 2.16 `call_async` does not properly await JS Promises returned by
/// async callbacks (it tries to convert the Promise object directly to a
/// String, triggering `StringExpected`). To work around this, we use a
/// **callback registry** pattern:
///
/// 1. Rust assigns a unique `callback_id` + creates a `oneshot` channel.
/// 2. Rust calls the JS function via `tsfn.call()` (fire-and-forget), passing
///    the input payload and the `callback_id`.
/// 3. The JS function processes the request asynchronously, then calls the
///    exported `resolveCallback(id, error, result)` napi function.
/// 4. `resolveCallback` looks up the `oneshot` sender and sends the result.
/// 5. The Rust future (from step 1) awaits the `oneshot` receiver.
///
/// This avoids `call_async` entirely and works with both sync and async JS
/// callbacks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use napi::{
    bindgen_prelude::{Env, JsFunction},
    threadsafe_function::{
        ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction,
        ThreadsafeFunctionCallMode,
    },
    JsObject,
};
use napi_derive::napi;
use tokio::sync::oneshot;

use crate::callbacks::{HostCallbacks, NativeToolCallbacks};
use crate::llm::http::NativeHttpLlm;
use crate::llm::proxy::HostLlmProxy;
use crate::rpc::types::{LlmChatRequest, LlmChatResponse, NativeLlmConfig, ToolExecuteRequest, ToolExecuteResponse};
use crate::turn_loop::{
    run_turn::run_turn,
    types::*,
};
use crate::ws_transport::{
    WsClient, WsClientConfig, WsEvent,
    cursor::SessionCursor,
    reconnect::ReconnectConfig,
};

// ── Global callback registry ───────────────────────────────────────────────

/// Pending callbacks awaiting resolution from the JS side.
static CALLBACK_REGISTRY: LazyLock<Mutex<HashMap<u32, oneshot::Sender<std::result::Result<std::string::String, std::string::String>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Payload registry — stores the JSON request payloads by callback ID.
/// The JS side fetches the payload via `getCallbackPayload(id)` after
/// receiving the callback ID via TSFN.
static PAYLOAD_REGISTRY: LazyLock<Mutex<HashMap<u32, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Monotonically increasing callback ID. Wrapping is fine because the ID
/// space is large enough that collisions are impossible in practice.
static NEXT_CALLBACK_ID: AtomicU32 = AtomicU32::new(1);

/// Per-turn cancellation flags, keyed by turn id, so `cancelTurnRust` can
/// stop a running turn before its next step — the napi twin of the stdio
/// server's `agent/cancel_turn` map (see `main.rs`).
static CANCEL_REGISTRY: LazyLock<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Cancel a running turn: sets the per-turn cancellation flag that the loop
/// checks before every step (`RunTurnInput.cancellation`). Returns true when
/// a running turn matched the id, false when no such turn is active.
#[napi]
pub fn cancel_turn_rust(turn_id: String) -> napi::Result<bool> {
    let flag = CANCEL_REGISTRY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&turn_id)
        .cloned();
    match flag {
        Some(f) => {
            f.store(true, Ordering::Relaxed);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Called by JS to fetch the payload for a given callback ID.
/// Returns the JSON-serialized request payload, or null if not found.
#[napi]
pub fn get_callback_payload(id: u32) -> napi::Result<Option<String>> {
    let payload = PAYLOAD_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    Ok(payload)
}

/// Called by JS to resolve a pending host callback.
///
/// * `id` — the callback ID that was passed to the JS function
/// * `error` — if present, the callback failed with this error message
/// * `result` — if present (and `error` is absent), the JSON-serialized response
#[napi]
pub fn resolve_callback(id: u32, error: Option<String>, result: Option<String>) -> napi::Result<()> {
    if let Some(tx) = CALLBACK_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        let outcome = match (error, result) {
            (Some(err), _) => Err(err),
            (_, Some(res)) => Ok(res),
            (None, None) => Err("callback resolved with no result".to_string()),
        };
        let _ = tx.send(outcome);
    }
    Ok(())
}

// ── NapiHostCallbacks ──────────────────────────────────────────────────────

/// Implements [`HostCallbacks`] using napi [`ThreadsafeFunction`]s so the
/// Rust turn loop can call back into JS for LLM chat and tool execution.
///
/// The TSFN passes only the callback ID (u32). The JS side fetches the
/// payload via `getCallbackPayload(id)` and resolves via `resolveCallback`.
///
/// Uses `ErrorStrategy::Fatal` so the JS callback receives just the callback ID
/// without the error-first `null` argument that `CalleeHandled` prepends.
struct NapiHostCallbacks {
    llm_chat_fn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    execute_tool_fn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    /// Optional fire-and-forget event channel. The JS side fetches the
    /// payload via `getCallbackPayload(id)` but must NOT resolve it.
    emit_event_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    /// Optional tool-lifecycle channels (prepare / authorize / finalize).
    /// When all three are wired, `supports_tool_lifecycle` reports true and
    /// write-class native execution can run behind the host approval gate;
    /// otherwise write-class calls fall back to full host execution.
    prepare_tool_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    authorize_tool_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
    finalize_tool_fn: Option<Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>>,
}

impl HostCallbacks for NapiHostCallbacks {
    fn supports_tool_lifecycle(&self) -> bool {
        self.prepare_tool_fn.is_some()
            && self.authorize_tool_fn.is_some()
            && self.finalize_tool_fn.is_some()
    }

    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> crate::rpc::types::BoxFuture<'static, std::result::Result<LlmChatResponse, std::string::String>> {
        let tsfn = self.llm_chat_fn.clone();
        let input = serde_json::to_string(&request).unwrap_or_else(|e| {
            format!(r#"{{"error":"serialize: {}"}}"#, e)
        });
        Box::pin(napi_llm_chat(tsfn, input))
    }

    fn execute_tool(
        &self,
        request: ToolExecuteRequest,
    ) -> crate::rpc::types::BoxFuture<'static, std::result::Result<ToolExecuteResponse, std::string::String>> {
        let tsfn = self.execute_tool_fn.clone();
        let input = serde_json::to_string(&request).unwrap_or_else(|e| {
            format!(r#"{{"error":"serialize: {}"}}"#, e)
        });
        Box::pin(napi_execute_tool(tsfn, input))
    }

    fn emit_event(&self, event: serde_json::Value) {
        let Some(ref tsfn) = self.emit_event_fn else { return };
        let Ok(payload) = serde_json::to_string(&event) else { return };
        let id = NEXT_CALLBACK_ID.fetch_add(1, Ordering::SeqCst);
        // Payload-only registration: no oneshot — JS fetches and forgets.
        PAYLOAD_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).insert(id, payload);
        let status = tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
        if status != napi::Status::Ok {
            PAYLOAD_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        }
    }

    fn prepare_tool_execution(
        &self,
        request: crate::rpc::types::PrepareToolRequest,
    ) -> crate::rpc::types::BoxFuture<'static, std::result::Result<Option<crate::rpc::types::PrepareToolResponse>, std::string::String>> {
        let Some(ref tsfn) = self.prepare_tool_fn else {
            return Box::pin(async { Ok(None) });
        };
        let tsfn = tsfn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        Box::pin(async move {
            let output = invoke_via_registry(&tsfn, input, "prepare_tool").await?;
            serde_json::from_str(&output).map_err(|e| format!("prepare_tool parse: {e}"))
        })
    }

    fn authorize_tool_execution(
        &self,
        request: crate::rpc::types::AuthorizeToolRequest,
    ) -> crate::rpc::types::BoxFuture<'static, std::result::Result<Option<crate::rpc::types::AuthorizeToolResponse>, std::string::String>> {
        let Some(ref tsfn) = self.authorize_tool_fn else {
            return Box::pin(async { Ok(None) });
        };
        let tsfn = tsfn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        Box::pin(async move {
            let output = invoke_via_registry(&tsfn, input, "authorize_tool").await?;
            serde_json::from_str(&output).map_err(|e| format!("authorize_tool parse: {e}"))
        })
    }

    fn finalize_tool_result(
        &self,
        request: crate::rpc::types::FinalizeToolRequest,
    ) -> crate::rpc::types::BoxFuture<'static, std::result::Result<crate::rpc::types::FinalizeToolResponse, std::string::String>> {
        let Some(ref tsfn) = self.finalize_tool_fn else {
            return Box::pin(async { Ok(None) });
        };
        let tsfn = tsfn.clone();
        let input = serde_json::to_string(&request)
            .unwrap_or_else(|e| format!(r#"{{"error":"serialize: {}"}}"#, e));
        Box::pin(async move {
            let output = invoke_via_registry(&tsfn, input, "finalize_tool").await?;
            serde_json::from_str(&output).map_err(|e| format!("finalize_tool parse: {e}"))
        })
    }
}

/// Register a callback with the global registry, store the payload for
/// JS-side retrieval, fire the JS function with just the callback ID,
/// and await the result.
///
/// Returns the JSON-serialized response string, or an error message.
async fn invoke_via_registry(
    tsfn: &Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
    label: &str,
) -> std::result::Result<std::string::String, std::string::String> {
    let id = NEXT_CALLBACK_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();

    // Store the payload so JS can fetch it via getCallbackPayload(id).
    PAYLOAD_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).insert(id, input);

    // Register the sender so resolve_callback can find it.
    CALLBACK_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);

    // Fire the JS function with just the callback ID (a number).
    // ErrorStrategy::Fatal: no error-first null prepended, JS receives the id directly.
    let status = tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
    if status != napi::Status::Ok {
        // Clean up on failure.
        PAYLOAD_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        CALLBACK_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return Err(format!("{label} call: {status:?}"));
    }

    // Await the oneshot receiver. The sender is triggered by resolve_callback.
    rx.await
        .map_err(|e| format!("{label} closed: {e}"))?
}

/// Standalone async function for LLM chat via callback registry.
async fn napi_llm_chat(
    tsfn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
) -> std::result::Result<LlmChatResponse, std::string::String> {
    let output = invoke_via_registry(&tsfn, input, "llm_chat").await?;
    serde_json::from_str(&output).map_err(|e| format!("llm_chat parse: {e}"))
}

/// Standalone async function for tool execution via callback registry.
async fn napi_execute_tool(
    tsfn: Arc<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    input: String,
) -> std::result::Result<ToolExecuteResponse, std::string::String> {
    let output = invoke_via_registry(&tsfn, input, "execute_tool").await?;
    serde_json::from_str(&output).map_err(|e| format!("execute_tool parse: {e}"))
}

// ── napi JS-side types ─────────────────────────────────────────────────────

#[napi(object)]
#[derive(Clone)]
pub struct JsRunTurnParams {
    pub turn_id: String,
    pub system_prompt: String,
    pub model_name: String,
    pub messages: Vec<JsMessage>,
    pub tools: Vec<JsToolDef>,
    pub max_steps: Option<u32>,
    pub goal: Option<JsGoalContext>,
    /// Native HTTP LLM transport. When present, Rust calls the provider
    /// directly (SSE streaming) instead of proxying through the host.
    pub native_llm: Option<JsNativeLlmConfig>,
    /// Workspace root used to sandbox native tool execution.
    pub workspace_root: Option<String>,
    /// When true (with `workspace_root`), Read/Grep/Glob run in-process.
    pub native_tools: Option<bool>,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsNativeLlmConfig {
    /// "openai" (Chat Completions) or "anthropic" (Messages).
    pub protocol: String,
    /// API base URL including the version segment (e.g. `.../v1`).
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: Option<u32>,
    /// Reasoning effort (`"low"|"medium"|"high"`), mapped per protocol.
    pub reasoning_effort: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsMessage {
    pub role: String,
    pub content: String,
    /// JSON-serialized `ContentBlock[]` for multimodal messages
    /// (`[{"type":"text",...},{"type":"image_url",...}]`). Optional.
    pub blocks_json: Option<String>,
    /// JSON-serialized tool calls (`[{id,name,arguments}]`) for an
    /// assistant history message. Optional.
    pub tool_calls_json: Option<String>,
    /// For a `tool` history message: the tool call id it answers.
    pub tool_call_id: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsToolDef {
    pub name: String,
    pub description: String,
    /// JSON string of the tool's input schema (e.g. `{"type":"object",...}`).
    /// serde_json::Value does not implement napi ToNapiValue/FromNapiValue,
    /// so we pass the schema as a serialized JSON string.
    pub input_schema: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsGoalContext {
    pub goal_id: String,
    pub objective: String,
    pub status: String,
    pub token_budget: Option<i64>,
    pub turn_budget: Option<i64>,
    pub tokens_used: i64,
    pub turns_used: i64,
}

#[napi(object)]
pub struct JsRunTurnResult {
    pub stop_reason: String,
    pub steps: u32,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
}

// ── napi exported functions ────────────────────────────────────────────────

/// Run a single turn of the agent loop via napi.
///
/// The two JS callbacks follow the **callback registry** pattern:
/// each receives a single `callbackId: number`. The JS side must:
/// 1. Call `getCallbackPayload(id)` to fetch the JSON request payload
/// 2. Process the request
/// 3. Call `resolveCallback(id, error?, result?)` to resolve
///
/// * `llm_chat_cb` — receives callback ID, fetches `LlmChatRequest` JSON
/// * `execute_tool_cb` — receives callback ID, fetches `ToolExecuteRequest` JSON
/// * `emit_event_cb` — optional; receives callback ID, fetches a JSON event
///   payload. Fire-and-forget: the JS side must NOT call `resolveCallback`.
///
/// JsFunction is converted to ThreadsafeFunction synchronously, then the
/// async work is dispatched via `env.execute_tokio_future` so the JS event
/// loop stays alive to process TSFN callbacks.
#[napi]
pub fn run_turn_rust(
    env: Env,
    params: JsRunTurnParams,
    #[napi(ts_arg_type = "(callbackId: number) => void")] llm_chat_cb: JsFunction,
    #[napi(ts_arg_type = "(callbackId: number) => void")] execute_tool_cb: JsFunction,
    #[napi(ts_arg_type = "(callbackId: number) => void")] emit_event_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] prepare_tool_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] authorize_tool_cb: Option<JsFunction>,
    #[napi(ts_arg_type = "(callbackId: number) => void")] finalize_tool_cb: Option<JsFunction>,
) -> napi::Result<JsObject> {
    // ── Convert JsFunction → ThreadsafeFunction synchronously ──────────
    // The TSFN passes only the callback ID (u32). The JS side fetches
    // the payload via getCallbackPayload(id) and resolves via resolveCallback.
    // ErrorStrategy::Fatal: no error-first null prepended, JS receives the id directly.
    fn to_id_tsfn(
        cb: JsFunction,
    ) -> napi::Result<ThreadsafeFunction<u32, ErrorStrategy::Fatal>> {
        cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
            let js_num = ctx.env.create_uint32(ctx.value)?;
            let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
            Ok(args)
        })
    }
    let llm_chat_tsfn = to_id_tsfn(llm_chat_cb)?;
    let execute_tool_tsfn = to_id_tsfn(execute_tool_cb)?;
    let emit_event_tsfn = emit_event_cb.map(to_id_tsfn).transpose()?;
    let prepare_tool_tsfn = prepare_tool_cb.map(to_id_tsfn).transpose()?;
    let authorize_tool_tsfn = authorize_tool_cb.map(to_id_tsfn).transpose()?;
    let finalize_tool_tsfn = finalize_tool_cb.map(to_id_tsfn).transpose()?;

    // ── Dispatch async work via execute_tokio_future ───────────────────
    // The future is Send because JsFunction has been converted to TSFN
    // and dropped from scope before the async block.
    env.execute_tokio_future(
        async move {
            run_turn_rust_impl(
                params,
                llm_chat_tsfn,
                execute_tool_tsfn,
                emit_event_tsfn,
                prepare_tool_tsfn,
                authorize_tool_tsfn,
                finalize_tool_tsfn,
            )
            .await
        },
        |env: &mut Env, val: JsRunTurnResult| {
            let mut obj = env.create_object()?;
            obj.set_named_property("stopReason", env.create_string_from_std(val.stop_reason)?)?;
            obj.set_named_property("steps", env.create_uint32(val.steps)?)?;
            obj.set_named_property("inputTokens", env.create_uint32(val.input_tokens)?)?;
            obj.set_named_property("outputTokens", env.create_uint32(val.output_tokens)?)?;
            obj.set_named_property("totalTokens", env.create_uint32(val.total_tokens)?)?;
            Ok(obj)
        },
    )
}

/// Inner async implementation — all captured values are `Send`.
async fn run_turn_rust_impl(
    params: JsRunTurnParams,
    llm_chat_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    execute_tool_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    emit_event_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    prepare_tool_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    authorize_tool_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
    finalize_tool_tsfn: Option<ThreadsafeFunction<u32, ErrorStrategy::Fatal>>,
) -> napi::Result<JsRunTurnResult> {
    let base_callbacks: Arc<dyn HostCallbacks> = Arc::new(NapiHostCallbacks {
        llm_chat_fn: Arc::new(llm_chat_tsfn),
        execute_tool_fn: Arc::new(execute_tool_tsfn),
        emit_event_fn: emit_event_tsfn.map(Arc::new),
        prepare_tool_fn: prepare_tool_tsfn.map(Arc::new),
        authorize_tool_fn: authorize_tool_tsfn.map(Arc::new),
        finalize_tool_fn: finalize_tool_tsfn.map(Arc::new),
    });

    // Native tool execution: wrap the callbacks so Read/Grep/Glob run
    // in-process (sandboxed to the workspace) and everything else — and
    // anything that escapes the sandbox — still round-trips to the host.
    let callbacks: Arc<dyn HostCallbacks> = match (
        params.native_tools.unwrap_or(false),
        params.workspace_root.as_deref(),
    ) {
        (true, Some(root)) => match crate::tools::NativeToolset::new(root) {
            Some(toolset) => Arc::new(NativeToolCallbacks {
                inner: base_callbacks.clone(),
                toolset: Arc::new(toolset),
                // Host-driven path: the JS side owns the background-task
                // domain, so background Bash keeps falling back to the host.
                background: None,
                // JS host owns permission approval on this path.
                permission: None,
                hooks: None,
            }),
            None => base_callbacks.clone(),
        },
        _ => base_callbacks.clone(),
    };

    // Native HTTP LLM (streaming) when configured; host proxy otherwise.
    let llm: Box<dyn LLM> = match params.native_llm {
        Some(cfg) => {
            let sink_callbacks = callbacks.clone();
            let native = NativeHttpLlm::new(
                NativeLlmConfig {
                    protocol: cfg.protocol,
                    base_url: cfg.base_url,
                    api_key: cfg.api_key,
                    model: cfg.model,
                    max_tokens: cfg.max_tokens,
                    reasoning_effort: cfg.reasoning_effort,
                    custom_headers: Default::default(),
                },
                params.system_prompt.clone(),
            )
            .with_sink(Arc::new(move |event| sink_callbacks.emit_event(event)));
            Box::new(native)
        }
        None => Box::new(
            HostLlmProxy::new(params.system_prompt.clone(), params.model_name.clone())
                .with_callbacks(callbacks.clone()),
        ),
    };

    let messages: Vec<LLMMessage> = params
        .messages
        .iter()
        .map(|m| LLMMessage {
            role: m.role.clone(),
            content: m.content.clone(),
            blocks: m
                .blocks_json
                .as_deref()
                .and_then(|j| serde_json::from_str(j).ok())
                .unwrap_or_default(),
            tool_calls: m
                .tool_calls_json
                .as_deref()
                .and_then(|j| serde_json::from_str(j).ok())
                .unwrap_or_default(),
            tool_call_id: m.tool_call_id.clone(),
        })
        .collect();

    let tool_defs: Vec<ToolInfo> = params
        .tools
        .iter()
        .map(|t| ToolInfo {
            name: t.name.clone(),
            description: t.description.clone(),
            input_schema: serde_json::from_str(&t.input_schema).unwrap_or_default(),
        })
        .collect();

    let goal = params.goal.map(|g| GoalContext {
        goal_id: g.goal_id,
        objective: g.objective,
        status: match g.status.as_str() {
            "active" => GoalStatus::Active,
            "paused" => GoalStatus::Paused,
            "blocked" => GoalStatus::Blocked,
            "complete" => GoalStatus::Complete,
            "budgetLimited" => GoalStatus::BudgetLimited,
            "usageLimited" => GoalStatus::UsageLimited,
            _ => GoalStatus::Active,
        },
        token_budget: g.token_budget,
        turn_budget: g.turn_budget,
        tokens_used: g.tokens_used,
        turns_used: g.turns_used,
    });

    // Register the per-turn cancellation flag so `cancelTurnRust` can stop
    // this turn at its next step boundary. Removed again below — also on the
    // error path — so the registry never leaks finished turns.
    let turn_id_key = params.turn_id.clone();
    let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    CANCEL_REGISTRY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(turn_id_key.clone(), cancel_flag.clone());

    let input = RunTurnInput {
        turn_id: params.turn_id,
        llm: &*llm,
        messages,
        tools: &[],
        tool_defs,
        hooks: None,
        max_steps: params.max_steps.unwrap_or(10),
        goal,
        cancellation: Some(cancel_flag),
        steer_queue: None,
    };

    let result = run_turn(input, &callbacks).await;
    CANCEL_REGISTRY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&turn_id_key);
    let result = result.map_err(|e| napi::Error::from_reason(format!("run_turn failed: {e}")))?;

    Ok(JsRunTurnResult {
        stop_reason: format!("{:?}", result.stop_reason),
        steps: result.steps,
        input_tokens: result.usage.input_tokens as u32,
        output_tokens: result.usage.output_tokens as u32,
        total_tokens: result.usage.total_tokens as u32,
    })
}

// ── WS Transport NAPI bindings ─────────────────────────────────────────────

/// JS-visible WS client handle.
///
/// Wraps the Rust WsClient in a napi struct so JS can hold a reference
/// and call methods on it.
#[napi(js_name = "WsClient")]
pub struct JsWsClient {
    inner: WsClient,
}

#[napi(object)]
pub struct JsWsClientConfig {
    pub url: String,
    pub auth_token: Option<String>,
    /// Initial backoff in milliseconds.
    pub reconnect_initial_backoff_ms: Option<u32>,
    /// Maximum backoff in milliseconds.
    pub reconnect_max_backoff_ms: Option<u32>,
    /// Maximum reconnection attempts (None = unlimited).
    pub reconnect_max_attempts: Option<u32>,
    /// Heartbeat interval in milliseconds (None = no heartbeat).
    pub heartbeat_interval_ms: Option<u32>,
    /// Connection timeout in milliseconds.
    pub connect_timeout_ms: Option<u32>,
    /// Event buffer size.
    pub event_buffer_size: Option<u32>,
}

#[napi(object)]
pub struct JsSessionCursor {
    pub seq: i64,
    pub epoch: Option<String>,
}

#[napi(object)]
pub struct JsWsEventEnvelope {
    pub event_type: String,
    pub seq: Option<i64>,
    pub epoch: Option<String>,
    pub volatile: bool,
    pub offset: Option<i64>,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// JSON-serialized payload.
    pub payload_json: String,
}

#[napi(object)]
pub struct JsConnectionState {
    pub connected: bool,
    pub state: String, // "disconnected" | "connecting" | "connected" | "reconnecting" | "failed"
}

fn ws_client_config_from_js(cfg: JsWsClientConfig) -> WsClientConfig {
    let mut config = WsClientConfig::new(cfg.url);
    if let Some(token) = cfg.auth_token {
        config.auth_token = Some(token);
    }
    config.reconnect = ReconnectConfig {
        initial_backoff: std::time::Duration::from_millis(cfg.reconnect_initial_backoff_ms.unwrap_or(1000) as u64),
        max_backoff: std::time::Duration::from_millis(cfg.reconnect_max_backoff_ms.unwrap_or(60000) as u64),
        backoff_multiplier: 2.0,
        max_attempts: cfg.reconnect_max_attempts,
        jitter: true,
    };
    config.heartbeat_interval = cfg.heartbeat_interval_ms.map(|ms| std::time::Duration::from_millis(ms as u64));
    config.connect_timeout = std::time::Duration::from_millis(cfg.connect_timeout_ms.unwrap_or(10000) as u64);
    config.event_buffer_size = cfg.event_buffer_size.unwrap_or(10000) as usize;
    config
}

#[napi]
impl JsWsClient {
    /// Create a new WS client with the given config.
    #[napi(constructor)]
    pub fn new(cfg: JsWsClientConfig) -> Self {
        let config = ws_client_config_from_js(cfg);
        Self {
            inner: WsClient::new(config),
        }
    }

    /// Subscribe to a session's events.
    ///
    /// `event_callback` receives a JSON-serialized `JsWsEventEnvelope`.
    /// Uses the callback registry pattern (same as `run_turn_rust`).
    #[napi]
    pub fn subscribe(
        &self,
        _env: Env,
        session_id: String,
        cursor: Option<JsSessionCursor>,
        #[napi(ts_arg_type = "(callbackId: number) => void")] event_callback: JsFunction,
    ) -> napi::Result<()> {
        let cursor = cursor.map(|c| SessionCursor {
            seq: u64::try_from(c.seq).unwrap_or(0),
            epoch: c.epoch,
        });

        // Create a TSFN that fires the callback with the event payload ID.
        let tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal> =
            event_callback.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
                let js_num = ctx.env.create_uint32(ctx.value)?;
                let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
                Ok(args)
            })?;

        let tsfn = Arc::new(tsfn);
        let inner = self.inner.clone();

        // We need to spawn a task that sets up the subscription.
        // The handler stores events and fires the TSFN.
        let handler: Arc<dyn Fn(WsEvent) + Send + Sync> = Arc::new(move |event| {
            let id = NEXT_CALLBACK_ID.fetch_add(1, Ordering::SeqCst);
            let payload = match ws_event_to_js_raw(&event) {
                Ok(p) => p,
                Err(_) => return,
            };
            PAYLOAD_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).insert(id, payload);
            let status = tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
            if status != napi::Status::Ok {
                PAYLOAD_REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            }
        });

        // Use a blocking approach for the subscribe call.
        let rt = tokio::runtime::Handle::current();
        let result = rt.block_on(async {
            inner.subscribe(&session_id, cursor, handler).await
        });

        match result {
            Ok(()) => Ok(()),
            Err(e) => Err(napi::Error::from_reason(format!("subscribe failed: {e}"))),
        }
    }

    /// Unsubscribe from a session's events.
    #[napi]
    pub fn unsubscribe(&self, session_id: String) -> napi::Result<()> {
        let inner = self.inner.clone();
        let rt = tokio::runtime::Handle::current();
        match rt.block_on(async { inner.unsubscribe(&session_id).await }) {
            Ok(()) => Ok(()),
            Err(e) => Err(napi::Error::from_reason(format!("unsubscribe failed: {e}"))),
        }
    }

    /// Check if the client is currently connected.
    #[napi]
    pub fn is_connected(&self) -> bool {
        let inner = self.inner.clone();
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async { inner.is_connected().await })
    }

    /// Get the current cursor for a session.
    #[napi]
    pub fn get_cursor(&self, session_id: String) -> Option<JsSessionCursor> {
        self.inner
            .cursor_store()
            .get(&session_id)
            .map(|c| JsSessionCursor {
                seq: c.seq as i64,
                epoch: c.epoch,
            })
    }

    /// Get all cursors as a map.
    #[napi]
    pub fn get_all_cursors(&self) -> std::collections::HashMap<String, JsSessionCursor> {
        self.inner
            .cursor_store()
            .get_all()
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    JsSessionCursor {
                        seq: v.seq as i64,
                        epoch: v.epoch,
                    },
                )
            })
            .collect()
    }

    /// Shutdown the client.
    #[napi]
    pub fn shutdown(&self) -> napi::Result<()> {
        let inner = self.inner.clone();
        let rt = tokio::runtime::Handle::current();
        match rt.block_on(async { inner.shutdown().await }) {
            Ok(()) => Ok(()),
            Err(e) => Err(napi::Error::from_reason(format!("shutdown failed: {e}"))),
        }
    }
}

/// Helper: serialize a WsEvent to a JSON string for the callback payload.
fn ws_event_to_js_raw(event: &WsEvent) -> napi::Result<String> {
    let envelope = &event.envelope;
    let payload = serde_json::json!({
        "eventType": envelope.event_type,
        "seq": envelope.seq,
        "epoch": envelope.epoch,
        "volatile": envelope.volatile,
        "offset": envelope.offset,
        "sessionId": envelope.session_id,
        "timestamp": envelope.timestamp,
        "payload": envelope.payload,
    });
    serde_json::to_string(&payload)
        .map_err(|e| napi::Error::from_reason(format!("serialize event: {e}")))
}

/// Create a WS client builder (fluent API).
#[napi]
pub fn create_ws_client_builder(url: String) -> JsWsClientBuilder {
    JsWsClientBuilder {
        url,
        auth_token: None,
        reconnect: ReconnectConfig::default(),
        heartbeat_interval: Some(std::time::Duration::from_secs(30)),
        connect_timeout: std::time::Duration::from_secs(10),
        event_buffer_size: 10000,
    }
}

/// Builder pattern for WsClient (JS-friendly).
#[napi(js_name = "WsClientBuilder")]
pub struct JsWsClientBuilder {
    url: String,
    auth_token: Option<String>,
    reconnect: ReconnectConfig,
    heartbeat_interval: Option<std::time::Duration>,
    connect_timeout: std::time::Duration,
    event_buffer_size: usize,
}

#[napi]
impl JsWsClientBuilder {
    #[napi]
    pub fn auth_token(&mut self, token: String) {
        self.auth_token = Some(token);
    }

    #[napi]
    pub fn heartbeat_ms(&mut self, ms: u32) {
        self.heartbeat_interval = Some(std::time::Duration::from_millis(ms as u64));
    }

    #[napi]
    pub fn no_heartbeat(&mut self) {
        self.heartbeat_interval = None;
    }

    #[napi]
    pub fn reconnect_max_attempts(&mut self, max: u32) {
        self.reconnect.max_attempts = Some(max);
    }

    #[napi]
    pub fn build(&self) -> JsWsClient {
        let config = WsClientConfig {
            url: self.url.clone(),
            auth_token: self.auth_token.clone(),
            reconnect: self.reconnect.clone(),
            heartbeat_interval: self.heartbeat_interval,
            connect_timeout: self.connect_timeout,
            event_buffer_size: self.event_buffer_size,
            headers: std::collections::HashMap::new(),
        };
        JsWsClient {
            inner: WsClient::new(config),
        }
    }
}