/// The main `run_turn` function — the stateless turn loop.
///
/// This is the Rust equivalent of `packages/agent-core/src/loop/run-turn.ts`.
/// It runs a single turn (multiple steps) until a stop condition is met.
///
/// The loop maintains a mutable message list that grows with each step:
///   1. Build messages: [system prompt, user messages]
///   2. Call LLM → get response with optional tool calls
///   3. If tool calls: execute them, append results to messages, go to step 2
///   4. If no tool calls: turn complete, return

use super::types::*;
use crate::rpc::types::TokenUsage;

/// Run a single turn with the given input.
pub fn run_turn(input: RunTurnInput<'_>) -> Result<TurnResult, Box<dyn std::error::Error>> {
    let turn_id = input.turn_id.clone();
    let max_steps = input.max_steps.max(1);

    let mut total_usage = TokenUsage::default();
    let mut steps: u32 = 0;

    // Build the mutable message list: system prompt + user messages
    let mut messages = vec![LLMMessage {
        role: "system".into(),
        content: input.llm.system_prompt().to_string(),
    }];
    messages.extend_from_slice(&input.messages);

    for step_num in 0..max_steps {
        steps = step_num + 1;

        // Check hooks: before_step
        if let Some(ref hooks) = input.hooks {
            if let Some(ref before_step) = hooks.before_step {
                let ctx = StepContext {
                    turn_id: turn_id.clone(),
                    step: step_num,
                };
                match before_step(&ctx)? {
                    Some(BeforeStepResult::StopTurn(reason)) => {
                        return Ok(TurnResult {
                            stop_reason: reason,
                            steps,
                            usage: total_usage,
                        });
                    }
                    Some(BeforeStepResult::Continue) | None => {}
                }
            }
        }

        // Call LLM with current messages
        let step_result = super::turn_step::execute_loop_step(
            &turn_id,
            step_num,
            input.llm,
            &messages,
            input.tools,
            &input.tool_defs,
        )?;

        // Accumulate usage
        total_usage.input_tokens += step_result.usage.input_tokens;
        total_usage.output_tokens += step_result.usage.output_tokens;
        total_usage.total_tokens += step_result.usage.total_tokens;

        // Check hooks: after_step
        if let Some(ref hooks) = input.hooks {
            if let Some(ref after_step) = hooks.after_step {
                let ctx = AfterStepContext {
                    turn_id: turn_id.clone(),
                    step: step_num,
                    tool_results: vec![],
                };
                match after_step(&ctx)? {
                    Some(AfterStepResult::StopTurn(reason)) => {
                        return Ok(TurnResult {
                            stop_reason: reason,
                            steps,
                            usage: total_usage,
                        });
                    }
                    Some(AfterStepResult::Continue) | None => {}
                }
            }
        }

        // Determine if we should continue based on stop reason
        match step_result.stop_reason {
            LoopStepStopReason::Complete => {
                return Ok(TurnResult {
                    stop_reason: LoopTurnStopReason::EndTurn,
                    steps,
                    usage: total_usage,
                });
            }
            LoopStepStopReason::ToolCalls(tool_calls) => {
                // Execute tool calls and get results
                let tool_results = super::tool_call::execute_tool_calls(
                    &turn_id,
                    step_num,
                    &tool_calls,
                    input.tools,
                )?;

                // Append tool results to messages so the LLM sees them in the next step
                for tc in &tool_calls {
                    messages.push(LLMMessage {
                        role: "assistant".into(),
                        content: serde_json::json!({
                            "tool_call_id": tc.id,
                            "name": tc.name,
                            "arguments": tc.arguments,
                        })
                        .to_string(),
                    });
                }
                for tr in &tool_results {
                    messages.push(LLMMessage {
                        role: "tool".into(),
                        content: tr.content.clone(),
                    });
                }
            }
            LoopStepStopReason::Aborted => {
                return Ok(TurnResult {
                    stop_reason: LoopTurnStopReason::Aborted,
                    steps,
                    usage: total_usage,
                });
            }
            LoopStepStopReason::Error(_msg) => {
                continue;
            }
        }
    }

    Ok(TurnResult {
        stop_reason: LoopTurnStopReason::EndTurn,
        steps,
        usage: total_usage,
    })
}