/// Tool-call batch lifecycle — orchestrate execution of tool calls from one LLM response.
///
/// Corresponds to `packages/agent-core/src/loop/tool-call.ts`.
///
/// Phases (preserving provider order):
///   1. Preflight — validate tool exists, parse JSON args
///   2. Prepare — run `prepare_tool_execution` hook (may block/modify args)
///   3. Authorize — run `authorize_tool_execution` hook (may block/provide synthetic)
///   4. Execute — run the tool (delegates to `execute_fn` callback)
///   5. Finalize — run `finalize_tool_result` hook (redaction, truncation)
///   6. Emit — return results in provider order (caller dispatches events)

use crate::rpc::types::{
    AuthorizeToolRequest, ExecutableToolResultData,
    FinalizeToolRequest, PrepareToolRequest,
};
use crate::turn_loop::tool_scheduler::ScheduledToolCall;
use crate::turn_loop::types::*;

/// Result of a fully processed tool call batch.
#[derive(Debug, Clone)]
pub struct ToolCallBatchResult {
    /// Results in original provider order.
    pub results: Vec<ExecutableToolResult>,
    /// Whether any tool requested the turn to stop after this batch.
    pub stop_turn: bool,
}

/// Context for a tool call batch step.
pub struct ToolCallStepContext {
    pub turn_id: String,
    pub current_step: u32,
    pub step_uuid: String,
    pub tools: Vec<ToolDescriptor>,
    pub hooks: Option<LoopHooks>,
    /// Trace id from the LLM request that produced these tool calls.
    pub trace_id: Option<String>,
}

/// Descriptor of an available tool (name + validation).
#[derive(Debug, Clone)]
pub struct ToolDescriptor {
    pub name: String,
    /// Whether the tool allows predictions (fast-path).
    pub allow_predictions: bool,
}

/// A preflighted (validated) tool call, ready for hook processing.
enum PreflightedToolCall {
    Runnable {
        tool_call: ToolCall,
        tool_name: String,
        args: serde_json::Value,
    },
    Rejected {
        args: serde_json::Value,
        output: String,
    },
}

/// Decision from the prepare hook.
enum PrepareDecision {
    Allowed {
        args: serde_json::Value,
        metadata: Option<serde_json::Value>,
    },
    Synthetic {
        args: serde_json::Value,
        result: ExecutableToolResult,
    },
    Blocked {
        args: serde_json::Value,
        output: String,
    },
    /// The prepare hook itself failed (host callback error or local hook
    /// panic/error). Distinct from `Blocked` — a hook crash is an engine
    /// fault, not a policy decision.
    HookFailed {
        args: serde_json::Value,
        output: String,
    },
}

/// A pending tool result awaiting finalization.
#[derive(Debug, Clone)]
struct PendingToolResult {
    pub tool_call: ToolCall,
    pub tool_name: String,
    pub args: serde_json::Value,
    pub result: ExecutableToolResult,
    pub stop_turn: bool,
}

/// Execute a batch of tool calls from one LLM response.
///
/// Runs the full lifecycle: preflight → prepare → authorize → execute → finalize.
/// Results are returned in the original provider order.
///
/// The `execute_fn` callback is called once per tool call and should perform
/// the actual tool execution (typically via `callbacks.execute_tool`).
///
/// When `host_callbacks` is provided, the hooks (prepare/authorize/finalize)
/// are delegated to the JS host; otherwise the `step.hooks` LoopHooks are used.
pub async fn run_tool_call_batch<F, Fut>(
    step: &ToolCallStepContext,
    tool_calls: &[ToolCall],
    host_callbacks: Option<&dyn crate::callbacks::HostCallbacks>,
    execute_fn: F,
) -> Result<ToolCallBatchResult, Box<dyn std::error::Error>>
where
    F: Fn(&ToolCall) -> Fut,
    Fut: std::future::Future<Output = Result<ExecutableToolResult, Box<dyn std::error::Error>>>,
{
    if tool_calls.is_empty() {
        return Ok(ToolCallBatchResult {
            results: vec![],
            stop_turn: false,
        });
    }

    // Phase 1: Preflight every call in provider order.
    let mut preflighted: Vec<PreflightedToolCall> = Vec::with_capacity(tool_calls.len());
    for tc in tool_calls {
        preflighted.push(preflight_tool_call(step, tc));
    }

    // Phase 2-3: Prepare + authorize + schedule.
    let mut scheduled: Vec<ScheduledToolCall> = Vec::with_capacity(tool_calls.len());
    let mut pending_results: Vec<PendingToolResult> = Vec::with_capacity(tool_calls.len());
    let mut stop_turn = false;

    for (index, call) in preflighted.into_iter().enumerate() {
        let prepared = prepare_tool_call(step, &call, index, tool_calls, host_callbacks).await?;

        match prepared {
            PrepareDecision::Blocked { .. } | PrepareDecision::HookFailed { .. } => {
                // Error result, no execution needed.
                let (tool_call, tool_name, args, output) = match &prepared {
                    PrepareDecision::Blocked { args, output, .. }
                    | PrepareDecision::HookFailed { args, output, .. } => {
                        let tc = &tool_calls[index];
                        (tc.clone(), tc.name.clone(), args.clone(), output.clone())
                    }
                    _ => unreachable!(),
                };
                let result = PendingToolResult {
                    tool_call: tool_call.clone(),
                    tool_name: tool_name.clone(),
                    args: args.clone(),
                    result: ExecutableToolResult {
                        content: output,
                        is_error: true,
                        is_prediction: false,
                        ..Default::default()
                    },
                    stop_turn: false,
                };
                // No resource accesses for error results — they can run in parallel.
                scheduled.push(ScheduledToolCall {
                    tool_call: tool_call.clone(),
                    accesses: vec![],
                });
                pending_results.push(result);
            }
            PrepareDecision::Synthetic { args, result } => {
                let tc = &tool_calls[index];
                let coerced = coerce_tool_result(result, &tc.name);
                let pending_stop = tool_result_stops_turn(&coerced);
                let pending = PendingToolResult {
                    tool_call: tc.clone(),
                    tool_name: tc.name.clone(),
                    args,
                    result: coerced,
                    stop_turn: pending_stop,
                };
                scheduled.push(ScheduledToolCall {
                    tool_call: tc.clone(),
                    accesses: vec![],
                });
                stop_turn = stop_turn || pending_stop;
                pending_results.push(pending);

                // Skip remaining calls if this tool requested stop batch.
                if stop_turn && pending_stop {
                    for skipped in &tool_calls[index + 1..] {
                        let output = "Tool skipped because a previous tool call stopped the turn.".to_string();
                        pending_results.push(PendingToolResult {
                            tool_call: skipped.clone(),
                            tool_name: skipped.name.clone(),
                            args: serde_json::Value::Null,
                            result: ExecutableToolResult {
                                content: output,
                                is_error: true,
                                is_prediction: false,
                                ..Default::default()
                            },
                            stop_turn: false,
                        });
                        scheduled.push(ScheduledToolCall {
                            tool_call: skipped.clone(),
                            accesses: vec![],
                        });
                    }
                    break;
                }
            }
            PrepareDecision::Allowed { args, metadata } => {
                let tc = &tool_calls[index];
                // Phase 4: Execute the tool.
                let result = run_runnable_tool_call(step, tc, &args, &metadata, host_callbacks, &execute_fn).await?;
                let pending_stop = tool_result_stops_turn(&result);
                let pending = PendingToolResult {
                    tool_call: tc.clone(),
                    tool_name: tc.name.clone(),
                    args,
                    result,
                    stop_turn: pending_stop,
                };
                stop_turn = stop_turn || pending_stop;
                pending_results.push(pending);

                // Skip remaining calls if this tool requested stop batch.
                if stop_turn && pending_stop {
                    for skipped in &tool_calls[index + 1..] {
                        let output = "Tool skipped because a previous tool call stopped the turn.".to_string();
                        pending_results.push(PendingToolResult {
                            tool_call: skipped.clone(),
                            tool_name: skipped.name.clone(),
                            args: serde_json::Value::Null,
                            result: ExecutableToolResult {
                                content: output,
                                is_error: true,
                                is_prediction: false,
                                ..Default::default()
                            },
                            stop_turn: false,
                        });
                    }
                    break;
                }
            }
        }
    }

    // Phase 5: Finalize every result in provider order.
    let mut final_results: Vec<ExecutableToolResult> = Vec::with_capacity(pending_results.len());
    for pending in &pending_results {
        let finalized = finalize_pending_tool_result(step, host_callbacks, pending).await?;
        stop_turn = stop_turn || finalized.stop_turn;
        final_results.push(finalized.result);
    }

    Ok(ToolCallBatchResult {
        results: final_results,
        stop_turn,
    })
}

/// Preflight validation: check the tool exists and args are valid JSON.
fn preflight_tool_call(
    step: &ToolCallStepContext,
    tool_call: &ToolCall,
) -> PreflightedToolCall {
    let tool_name = &tool_call.name;
    let args = tool_call.arguments.clone();

    // Check tool exists in the available tools list.
    let tool_exists = step.tools.iter().any(|t| t.name == *tool_name);
    if !tool_exists {
        return PreflightedToolCall::Rejected {
            args: args.clone(),
            output: format!("Tool \"{tool_name}\" not found"),
        };
    }

    PreflightedToolCall::Runnable {
        tool_call: tool_call.clone(),
        tool_name: tool_name.clone(),
        args,
    }
}

/// Run the prepare + authorize phase for a single tool call.
async fn prepare_tool_call(
    step: &ToolCallStepContext,
    call: &PreflightedToolCall,
    _index: usize,
    _all_calls: &[ToolCall],
    host_callbacks: Option<&dyn crate::callbacks::HostCallbacks>,
) -> Result<PrepareDecision, Box<dyn std::error::Error>> {
    match call {
        PreflightedToolCall::Rejected { args, output } => {
            return Ok(PrepareDecision::Blocked {
                args: args.clone(),
                output: output.clone(),
            });
        }
        PreflightedToolCall::Runnable { tool_call, tool_name, args } => {
            // Try host callbacks first (napi bridge → JS), then local hooks.
            let prepare_result = if let Some(cb) = host_callbacks {
                let req = PrepareToolRequest {
                    turn_id: step.turn_id.clone(),
                    step_number: step.current_step,
                    tool_call_id: tool_call.id.clone(),
                    tool_name: tool_name.clone(),
                    arguments: args.clone(),
                    all_tool_calls: vec![],
                    trace_id: step.trace_id.clone(),
                };
                match cb.prepare_tool_execution(req).await {
                    Ok(Some(decision)) => Some(decision),
                    Ok(None) => None,
                    // The host hook itself failed — surface it as a distinct
                    // decision rather than silently treating it as "no hook".
                    Err(e) => {
                        return Ok(PrepareDecision::HookFailed {
                            args: args.clone(),
                            output: format!("Prepare hook failed: {e}"),
                        });
                    }
                }
            } else {
                None
            };

            if let Some(decision) = prepare_result {
                if decision.resolved {
                    if decision.block {
                        return Ok(PrepareDecision::Blocked {
                            args: decision.updated_args.unwrap_or_else(|| args.clone()),
                            output: decision.reason.unwrap_or_else(|| format!("Tool call \"{tool_name}\" was blocked")),
                        });
                    }
                    if let Some(synthetic) = decision.synthetic_result {
                        return Ok(PrepareDecision::Synthetic {
                            args: decision.updated_args.unwrap_or_else(|| args.clone()),
                            result: ExecutableToolResult {
                                content: synthetic.content,
                                is_error: synthetic.is_error,
                                is_prediction: false,
                                ..Default::default()
                            },
                        });
                    }
                    return Ok(PrepareDecision::Allowed {
                        args: decision.updated_args.unwrap_or_else(|| args.clone()),
                        metadata: decision.execution_metadata,
                    });
                }
            }

            // Fall back to local LoopHooks closures.
            if let Some(ref hooks) = step.hooks {
                if let Some(ref prepare) = hooks.prepare_tool_execution {
                    let ctx = ToolExecutionHookContext {
                        turn_id: step.turn_id.clone(),
                        step_number: step.current_step,
                        tool_call: tool_call.clone(),
                        tool_calls: step.tools.iter().map(|t| ToolCall {
                            id: t.name.clone(),
                            name: t.name.clone(),
                            arguments: serde_json::Value::Null,
                        }).collect(),
                        args: args.clone(),
                        trace_id: step.trace_id.clone(),
                    };
                    let result = match prepare(&ctx) {
                        Ok(result) => result,
                        Err(e) => {
                            return Ok(PrepareDecision::HookFailed {
                                args: args.clone(),
                                output: format!("Prepare hook failed: {e}"),
                            });
                        }
                    };
                    if let Some(local_decision) = result {
                        if local_decision.block {
                            return Ok(PrepareDecision::Blocked {
                                args: local_decision.updated_args.unwrap_or_else(|| args.clone()),
                                output: local_decision.reason.unwrap_or_else(|| format!("Tool call \"{tool_name}\" was blocked")),
                            });
                        }
                        if let Some(synthetic) = local_decision.synthetic_result {
                            return Ok(PrepareDecision::Synthetic {
                                args: local_decision.updated_args.unwrap_or_else(|| args.clone()),
                                result: synthetic,
                            });
                        }
                        return Ok(PrepareDecision::Allowed {
                            args: local_decision.updated_args.unwrap_or_else(|| args.clone()),
                            metadata: local_decision.execution_metadata,
                        });
                    }
                }
            }

            // No hook or hook returned None — allow the call.
            Ok(PrepareDecision::Allowed {
                args: args.clone(),
                metadata: None,
            })
        }
    }
}

/// Execute a single runnable tool call, delegating to the `execute_fn` callback.
async fn run_runnable_tool_call<F, Fut>(
    step: &ToolCallStepContext,
    tool_call: &ToolCall,
    _args: &serde_json::Value,
    _metadata: &Option<serde_json::Value>,
    host_callbacks: Option<&dyn crate::callbacks::HostCallbacks>,
    execute_fn: F,
) -> Result<ExecutableToolResult, Box<dyn std::error::Error>>
where
    F: Fn(&ToolCall) -> Fut,
    Fut: std::future::Future<Output = Result<ExecutableToolResult, Box<dyn std::error::Error>>>,
{
    // Try host callbacks first (napi bridge → JS), then local hooks.
    let authorize_result = if let Some(cb) = host_callbacks {
        let req = AuthorizeToolRequest {
            turn_id: step.turn_id.clone(),
            step_number: step.current_step,
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            arguments: tool_call.arguments.clone(),
            all_tool_calls: vec![],
            trace_id: step.trace_id.clone(),
            approval_rule: String::new(),
        };
        match cb.authorize_tool_execution(req).await {
            Ok(Some(decision)) => Some(decision),
            Ok(None) | Err(_) => None,
        }
    } else {
        None
    };

    if let Some(auth) = authorize_result {
        if auth.resolved {
            if auth.block {
                return Ok(ExecutableToolResult {
                    content: auth.reason.unwrap_or_else(|| format!("Tool call \"{}\" was blocked", tool_call.name)),
                    is_error: true,
                    is_prediction: false,
                    ..Default::default()
                });
            }
            if let Some(synthetic) = auth.synthetic_result {
                return Ok(ExecutableToolResult {
                    content: synthetic.content,
                    is_error: synthetic.is_error,
                    is_prediction: false,
                    ..Default::default()
                });
            }
        }
    }

    // Fall back to local LoopHooks closures.
    if let Some(ref hooks) = step.hooks {
        if let Some(ref authorize) = hooks.authorize_tool_execution {
            let ctx = ResolvedToolExecutionHookContext {
                turn_id: step.turn_id.clone(),
                step_number: step.current_step,
                tool_call: tool_call.clone(),
                tool_calls: step.tools.iter().map(|t| ToolCall {
                    id: t.name.clone(),
                    name: t.name.clone(),
                    arguments: serde_json::Value::Null,
                }).collect(),
                args: tool_call.arguments.clone(),
                trace_id: step.trace_id.clone(),
                execution: RunnableToolExecutionInfo {
                    approval_rule: String::new(),
                    stop_batch_after_this: false,
                },
            };
            let result = authorize(&ctx)?;
            if let Some(auth) = result {
                if auth.block {
                    return Ok(ExecutableToolResult {
                        content: auth.reason.unwrap_or_else(|| format!("Tool call \"{}\" was blocked", tool_call.name)),
                        is_error: true,
                        is_prediction: false,
                        ..Default::default()
                    });
                }
                if let Some(synthetic) = auth.synthetic_result {
                    return Ok(synthetic);
                }
            }
        }
    }

    // Execute the tool via the callback.
    let result = execute_fn(tool_call).await?;
    Ok(result)
}

/// Finalize a pending tool result through the finalize_tool_result hook.
async fn finalize_pending_tool_result(
    step: &ToolCallStepContext,
    host_callbacks: Option<&dyn crate::callbacks::HostCallbacks>,
    pending: &PendingToolResult,
) -> Result<PendingToolResult, Box<dyn std::error::Error>> {
    let raw_result = &pending.result;
    let mut result = raw_result.clone();

    // Try host callbacks first (napi bridge → JS), then local hooks.
    let finalized_from_host = if let Some(cb) = host_callbacks {
        let req = FinalizeToolRequest {
            turn_id: step.turn_id.clone(),
            step_number: step.current_step,
            tool_call_id: pending.tool_call.id.clone(),
            tool_name: pending.tool_name.clone(),
            arguments: pending.args.clone(),
            result: ExecutableToolResultData {
                content: result.content.clone(),
                is_error: result.is_error,
                note: None,
                is_prediction: result.is_prediction,
                stop_turn: pending.stop_turn,
            },
            trace_id: step.trace_id.clone(),
        };
        match cb.finalize_tool_result(req).await {
            Ok(Some(data)) => {
                result = normalize_tool_result(ExecutableToolResult {
                    content: data.content,
                    is_error: data.is_error,
                    is_prediction: false,
                    ..Default::default()
                });
                Some(())
            }
            Ok(None) | Err(_) => None,
        }
    } else {
        None
    };

    if finalized_from_host.is_none() {
        // Fall back to local LoopHooks closures.
        if let Some(ref hooks) = step.hooks {
            if let Some(ref finalize) = hooks.finalize_tool_result {
                let ctx = FinalizeToolResultContext {
                    turn_id: step.turn_id.clone(),
                    step_number: step.current_step,
                    tool_call: pending.tool_call.clone(),
                    tool_calls: step.tools.iter().map(|t| ToolCall {
                        id: t.name.clone(),
                        name: t.name.clone(),
                        arguments: serde_json::Value::Null,
                    }).collect(),
                    args: pending.args.clone(),
                    result: result.clone(),
                    trace_id: step.trace_id.clone(),
                };
                let hook_result = finalize(&ctx)?;
                if let Some(finalized) = hook_result {
                    result = normalize_tool_result(coerce_tool_result(finalized, &pending.tool_name));
                } else {
                    result = normalize_tool_result(result);
                }
            } else {
                result = normalize_tool_result(result);
            }
        } else {
            result = normalize_tool_result(result);
        }
    }

    let stop_turn = pending.stop_turn || tool_result_stops_turn(&result);
    Ok(PendingToolResult {
        result,
        stop_turn,
        tool_call: pending.tool_call.clone(),
        tool_name: pending.tool_name.clone(),
        args: pending.args.clone(),
    })
}

/// Coerce a raw tool result into the canonical `ExecutableToolResult` shape.
fn coerce_tool_result(value: ExecutableToolResult, _tool_name: &str) -> ExecutableToolResult {
    value
}

/// Normalize a tool result: ensure output is non-empty, handle edge cases.
fn normalize_tool_result(r: ExecutableToolResult) -> ExecutableToolResult {
    let output = if r.content.is_empty() {
        "Tool output is empty.".to_string()
    } else {
        r.content
    };
    ExecutableToolResult {
        content: output,
        is_error: r.is_error,
        is_prediction: r.is_prediction,
        stop_turn: r.stop_turn,
        media: r.media,
    }
}

/// Check if a tool result requests the turn to stop.
fn tool_result_stops_turn(_result: &ExecutableToolResult) -> bool {
    // In the TS version, this is driven by `result.stopTurn === true`.
    // The Rust `ExecutableToolResult` doesn't have a `stop_turn` field yet,
    // so this is a placeholder. Extend when needed.
    false
}

/// Record unexecuted tool calls (when the provider stream broke off).
/// Each call is recorded with a synthetic error result so the exchange stays
/// wire-valid and the model learns the calls never ran.
pub async fn record_unexecuted_tool_calls<F, Fut>(
    _step: &ToolCallStepContext,
    tool_calls: &[ToolCall],
    emit_fn: F,
) -> Result<(), Box<dyn std::error::Error>>
where
    F: Fn(&ToolCall, &ExecutableToolResult) -> Fut,
    Fut: std::future::Future<Output = Result<(), Box<dyn std::error::Error>>>,
{
    let output = "This tool call was not executed: the model response ended before tool execution could start \
                  (the provider stream was interrupted). Do not assume the tool ran — \
                  re-issue the call if it is still needed.";

    for tc in tool_calls {
        let result = ExecutableToolResult {
            content: output.to_string(),
            is_error: true,
            is_prediction: false,
            ..Default::default()
        };
        emit_fn(tc, &result).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    

    fn make_tool_call(id: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: serde_json::json!({}),
        }
    }

    fn make_step_context(tools: Vec<&str>) -> ToolCallStepContext {
        ToolCallStepContext {
            turn_id: "test-turn".into(),
            current_step: 0,
            step_uuid: "test-step".into(),
            tools: tools.into_iter().map(|name| ToolDescriptor {
                name: name.into(),
                allow_predictions: true,
            }).collect(),
            hooks: None,
            trace_id: None,
        }
    }

    #[tokio::test]
    async fn test_empty_tool_calls() {
        let step = make_step_context(vec![]);
        let result = run_tool_call_batch(&step, &[], None, |_| async {
            Err("unexpected call".into())
        }).await.unwrap();
        assert!(result.results.is_empty());
        assert!(!result.stop_turn);
    }

    #[tokio::test]
    async fn test_single_tool_call() {
        let step = make_step_context(vec!["read"]);
        let calls = vec![make_tool_call("c1", "read")];

        let result = run_tool_call_batch(&step, &calls, None, |tc| {
            let tc = tc.clone();
            async move {
                Ok(ExecutableToolResult {
                    content: format!("result for {}", tc.name),
                    is_error: false,
                    is_prediction: false,
                    ..Default::default()
                })
            }
        }).await.unwrap();

        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].content, "result for read");
        assert!(!result.results[0].is_error);
    }

    #[tokio::test]
    async fn test_missing_tool_rejected() {
        let step = make_step_context(vec!["read"]); // only "read" is available
        let calls = vec![make_tool_call("c1", "write")]; // "write" is not available

        let result = run_tool_call_batch(&step, &calls, None, |_| async {
            Err("unexpected call".into())
        }).await.unwrap();

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].is_error);
        assert!(result.results[0].content.contains("not found"));
    }

    #[tokio::test]
    async fn test_multiple_tool_calls_in_order() {
        let step = make_step_context(vec!["read", "write"]);
        let calls = vec![
            make_tool_call("c1", "read"),
            make_tool_call("c2", "write"),
        ];

        let call_order = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let call_order_clone = call_order.clone();

        let result = run_tool_call_batch(&step, &calls, None, move |tc| {
            let co = call_order_clone.clone();
            let tc = tc.clone();
            async move {
                co.lock().unwrap().push(tc.name.clone());
                Ok(ExecutableToolResult {
                    content: format!("result for {}", tc.name),
                    is_error: false,
                    is_prediction: false,
                    ..Default::default()
                })
            }
        }).await.unwrap();

        assert_eq!(result.results.len(), 2);
        // Both calls should have been made (order may vary due to concurrency).
        let order = call_order.lock().unwrap();
        assert!(order.contains(&"read".to_string()));
        assert!(order.contains(&"write".to_string()));
    }

    #[tokio::test]
    async fn test_prepare_hook_can_block() {
        let step = ToolCallStepContext {
            turn_id: "test-turn".into(),
            current_step: 0,
            step_uuid: "test-step".into(),
            tools: vec![ToolDescriptor { name: "read".into(), allow_predictions: true }],
            hooks: Some(LoopHooks {
                prepare_tool_execution: Some(Box::new(|ctx: &ToolExecutionHookContext| {
                    if ctx.tool_call.name == "read" {
                        Ok(Some(PrepareToolExecutionResult {
                            block: true,
                            reason: Some("Blocked by test".to_string()),
                            synthetic_result: None,
                            updated_args: None,
                            execution_metadata: None,
                        }))
                    } else {
                        Ok(None)
                    }
                })),
                ..Default::default()
            }),
            trace_id: None,
        };

        let calls = vec![make_tool_call("c1", "read")];
        let result = run_tool_call_batch(&step, &calls, None, |_| async {
            Err("should not be called".into())
        }).await.unwrap();

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].is_error);
        assert!(result.results[0].content.contains("Blocked by test"));
    }

    #[tokio::test]
    async fn test_prepare_hook_synthetic_result() {
        let step = ToolCallStepContext {
            turn_id: "test-turn".into(),
            current_step: 0,
            step_uuid: "test-step".into(),
            tools: vec![ToolDescriptor { name: "read".into(), allow_predictions: true }],
            hooks: Some(LoopHooks {
                prepare_tool_execution: Some(Box::new(|_ctx: &ToolExecutionHookContext| {
                    Ok(Some(PrepareToolExecutionResult {
                        block: false,
                        reason: None,
                        synthetic_result: Some(ExecutableToolResult {
                            content: "synthetic result".to_string(),
                            is_error: false,
                            is_prediction: false,
                            ..Default::default()
                        }),
                        updated_args: None,
                        execution_metadata: None,
                    }))
                })),
                ..Default::default()
            }),
            trace_id: None,
        };

        let calls = vec![make_tool_call("c1", "read")];
        let result = run_tool_call_batch(&step, &calls, None, |_| async {
            Err("should not be called".into())
        }).await.unwrap();

        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].content, "synthetic result");
        assert!(!result.results[0].is_error);
    }

    #[tokio::test]
    async fn test_record_unexecuted_tool_calls() {
        let step = make_step_context(vec!["read"]);
        let calls = vec![make_tool_call("c1", "read")];

        let emitted = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let emitted_clone = emitted.clone();

        record_unexecuted_tool_calls(&step, &calls, move |tc, result| {
            let e = emitted_clone.clone();
            let tc = tc.clone();
            let result = result.clone();
            async move {
                e.lock().unwrap().push((tc.name, result.content));
                Ok(())
            }
        }).await.unwrap();

        let events = emitted.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "read");
        assert!(events[0].1.contains("not executed"));
    }

    #[tokio::test]
    async fn test_finalize_hook_transforms_result() {
        let step = ToolCallStepContext {
            turn_id: "test-turn".into(),
            current_step: 0,
            step_uuid: "test-step".into(),
            tools: vec![ToolDescriptor { name: "read".into(), allow_predictions: true }],
            hooks: Some(LoopHooks {
                finalize_tool_result: Some(Box::new(|ctx: &FinalizeToolResultContext| {
                    // Append "(redacted)" to the content.
                    let mut modified = ctx.result.clone();
                    modified.content = format!("{} (redacted)", modified.content);
                    Ok(Some(modified))
                })),
                ..Default::default()
            }),
            trace_id: None,
        };

        let calls = vec![make_tool_call("c1", "read")];
        let result = run_tool_call_batch(&step, &calls, None, |_| async {
            Ok(ExecutableToolResult {
                content: "raw output".to_string(),
                is_error: false,
                is_prediction: false,
                ..Default::default()
            })
        }).await.unwrap();

        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].content, "raw output (redacted)");
    }

    #[tokio::test]
    async fn test_normalize_empty_output() {
        let step = make_step_context(vec!["read"]);
        let calls = vec![make_tool_call("c1", "read")];

        let result = run_tool_call_batch(&step, &calls, None, |_| async {
            Ok(ExecutableToolResult {
                content: String::new(),
                is_error: false,
                is_prediction: false,
                ..Default::default()
            })
        }).await.unwrap();

        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].content, "Tool output is empty.");
    }

    #[tokio::test]
    async fn test_authorize_hook_blocks() {
        let step = ToolCallStepContext {
            turn_id: "test-turn".into(),
            current_step: 0,
            step_uuid: "test-step".into(),
            tools: vec![ToolDescriptor { name: "dangerous".into(), allow_predictions: true }],
            hooks: Some(LoopHooks {
                authorize_tool_execution: Some(Box::new(|ctx: &ResolvedToolExecutionHookContext| {
                    if ctx.tool_call.name == "dangerous" {
                        Ok(Some(AuthorizeToolExecutionResult {
                            block: true,
                            reason: Some("Not authorized".to_string()),
                            synthetic_result: None,
                            execution_metadata: None,
                        }))
                    } else {
                        Ok(None)
                    }
                })),
                ..Default::default()
            }),
            trace_id: None,
        };

        let calls = vec![make_tool_call("c1", "dangerous")];
        let result = run_tool_call_batch(&step, &calls, None, |_| async {
            Err("should not be called".into())
        }).await.unwrap();

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].is_error);
        assert!(result.results[0].content.contains("Not authorized"));
    }
}