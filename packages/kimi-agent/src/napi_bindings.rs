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

use crate::callbacks::HostCallbacks;
use crate::llm::proxy::HostLlmProxy;
use crate::rpc::types::{LlmChatRequest, LlmChatResponse, ToolExecuteRequest, ToolExecuteResponse};
use crate::turn_loop::{
    run_turn::run_turn,
    types::*,
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

/// Called by JS to fetch the payload for a given callback ID.
/// Returns the JSON-serialized request payload, or null if not found.
#[napi]
pub fn get_callback_payload(id: u32) -> napi::Result<Option<String>> {
    let payload = PAYLOAD_REGISTRY.lock().unwrap().remove(&id);
    Ok(payload)
}

/// Called by JS to resolve a pending host callback.
///
/// * `id` — the callback ID that was passed to the JS function
/// * `error` — if present, the callback failed with this error message
/// * `result` — if present (and `error` is absent), the JSON-serialized response
#[napi]
pub fn resolve_callback(id: u32, error: Option<String>, result: Option<String>) -> napi::Result<()> {
    eprintln!("[RUST] resolve_callback: id={id}, has_error={}, has_result={}",
        error.is_some(), result.is_some());
    if let Some(tx) = CALLBACK_REGISTRY.lock().unwrap().remove(&id) {
        let outcome = match (error, result) {
            (Some(err), _) => Err(err),
            (_, Some(res)) => Ok(res),
            (None, None) => Err("callback resolved with no result".to_string()),
        };
        eprintln!("[RUST] resolve_callback: id={id} found, sending outcome");
        let _ = tx.send(outcome);
    } else {
        eprintln!("[RUST] resolve_callback: id={id} NOT FOUND in registry!");
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
}

impl HostCallbacks for NapiHostCallbacks {
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

    eprintln!("[RUST] {label}: assigned callback_id={id}, input_len={}", input.len());

    // Store the payload so JS can fetch it via getCallbackPayload(id).
    PAYLOAD_REGISTRY.lock().unwrap().insert(id, input);

    // Register the sender so resolve_callback can find it.
    CALLBACK_REGISTRY.lock().unwrap().insert(id, tx);

    // Fire the JS function with just the callback ID (a number).
    // ErrorStrategy::Fatal: no error-first null prepended, JS receives the id directly.
    let status = tsfn.call(id, ThreadsafeFunctionCallMode::NonBlocking);
    if status != napi::Status::Ok {
        // Clean up on failure.
        PAYLOAD_REGISTRY.lock().unwrap().remove(&id);
        CALLBACK_REGISTRY.lock().unwrap().remove(&id);
        eprintln!("[RUST] {label}: tsfn.call failed: {status:?}");
        return Err(format!("{label} call: {status:?}"));
    }

    eprintln!("[RUST] {label}: tsfn.call OK, awaiting rx...");

    // Await the oneshot receiver. The sender is triggered by resolve_callback.
    rx.await
        .map_err(|e| {
            eprintln!("[RUST] {label}: rx closed: {e}");
            format!("{label} closed: {e}")
        })?
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
}

#[napi(object)]
#[derive(Clone)]
pub struct JsMessage {
    pub role: String,
    pub content: String,
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
) -> napi::Result<JsObject> {
    // ── Convert JsFunction → ThreadsafeFunction synchronously ──────────
    // The TSFN passes only the callback ID (u32). The JS side fetches
    // the payload via getCallbackPayload(id) and resolves via resolveCallback.
    // ErrorStrategy::Fatal: no error-first null prepended, JS receives the id directly.
    let llm_chat_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal> =
        llm_chat_cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
            let id = ctx.value;
            eprintln!("[RUST] TSFN closure: llm_chat, id={id}");
            let js_num = ctx.env.create_uint32(id)?;
            let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
            Ok(args)
        })?;

    let execute_tool_tsfn: ThreadsafeFunction<u32, ErrorStrategy::Fatal> =
        execute_tool_cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<u32>| {
            let id = ctx.value;
            eprintln!("[RUST] TSFN closure: execute_tool, id={id}");
            let js_num = ctx.env.create_uint32(id)?;
            let args: Vec<napi::JsUnknown> = vec![js_num.into_unknown()];
            Ok(args)
        })?;

    // ── Dispatch async work via execute_tokio_future ───────────────────
    // The future is Send because JsFunction has been converted to TSFN
    // and dropped from scope before the async block.
    env.execute_tokio_future(
        async move {
            run_turn_rust_impl(params, llm_chat_tsfn, execute_tool_tsfn).await
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
) -> napi::Result<JsRunTurnResult> {
    let callbacks: Arc<dyn HostCallbacks> = Arc::new(NapiHostCallbacks {
        llm_chat_fn: Arc::new(llm_chat_tsfn),
        execute_tool_fn: Arc::new(execute_tool_tsfn),
    });

    let llm = HostLlmProxy::new(params.system_prompt.clone(), params.model_name.clone())
        .with_callbacks(callbacks.clone());

    let messages: Vec<LLMMessage> = params
        .messages
        .iter()
        .map(|m| LLMMessage {
            role: m.role.clone(),
            content: m.content.clone(),
            ..Default::default()
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

    let input = RunTurnInput {
        turn_id: params.turn_id,
        llm: &llm,
        messages,
        tools: &[],
        tool_defs,
        hooks: None,
        max_steps: params.max_steps.unwrap_or(10),
        goal,
        cancellation: None,
    };

    let result = run_turn(input, &callbacks)
        .await
        .map_err(|e| napi::Error::from_reason(format!("run_turn failed: {e}")))?;

    Ok(JsRunTurnResult {
        stop_reason: format!("{:?}", result.stop_reason),
        steps: result.steps,
        input_tokens: result.usage.input_tokens as u32,
        output_tokens: result.usage.output_tokens as u32,
        total_tokens: result.usage.total_tokens as u32,
    })
}