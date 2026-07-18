/// Tool call execution within a step.
///
/// Proxies tool execution to the JS host via `host/execute_tool` JSON-RPC.

use crate::rpc::server::RpcServer;
use crate::rpc::types::{self, ToolExecuteRequest, ToolExecuteResponse};

/// Execute a batch of tool calls by proxying to the JS host.
pub fn execute_tool_calls(
    turn_id: &str,
    _step: u32,
    tool_calls: &[super::types::ToolCall],
    _tools: &[&dyn super::types::ExecutableTool],
) -> Result<(), Box<dyn std::error::Error>> {
    for tc in tool_calls {
        let request = ToolExecuteRequest {
            turn_id: turn_id.to_string(),
            tool_call_id: tc.id.clone(),
            tool_name: tc.name.clone(),
            arguments: tc.arguments.clone(),
        };

        // Proxy to JS host
        let response_value = RpcServer::call_host(types::methods::HOST_EXECUTE_TOOL, &request)
            .map_err(|e| format!("Tool execution proxy error: {e}"))?;

        let response: ToolExecuteResponse = serde_json::from_value(response_value)
            .map_err(|e| format!("Tool execution response parse error: {e}"))?;

        if response.is_error {
            eprintln!(
                "Tool {} ({}) error: {}",
                tc.name, tc.id, response.content
            );
        }
    }
    Ok(())
}