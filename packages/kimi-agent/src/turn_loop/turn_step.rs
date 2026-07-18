/// Single step execution within a turn.

use super::types::*;
use crate::rpc::types::TokenUsage;

/// Execute a single LLM step: call the LLM using the current messages,
/// return the response with any tool calls.
pub fn execute_loop_step(
    _turn_id: &str,
    _step: u32,
    llm: &dyn LLM,
    messages: &[LLMMessage],
    _tools: &[&dyn ExecutableTool],
    tool_defs: &[ToolInfo],
) -> Result<StepResult, Box<dyn std::error::Error>> {
    let params = LLMChatParams {
        messages: messages.to_vec(),
        tools: tool_defs.to_vec(),
    };

    match llm.chat(params) {
        Ok(response) => {
            let usage = response.usage.clone();
            if response.tool_calls.is_empty() {
                Ok(StepResult {
                    usage,
                    stop_reason: LoopStepStopReason::Complete,
                })
            } else {
                Ok(StepResult {
                    usage,
                    stop_reason: LoopStepStopReason::ToolCalls(response.tool_calls),
                })
            }
        }
        Err(e) => {
            let msg = format!("{e}");
            Ok(StepResult {
                usage: TokenUsage::default(),
                stop_reason: LoopStepStopReason::Error(msg),
            })
        }
    }
}