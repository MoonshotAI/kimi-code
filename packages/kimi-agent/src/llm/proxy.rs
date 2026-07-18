/// LLM proxy implementation that forwards chat requests to the JS host
/// via JSON-RPC over stdio.

use crate::rpc::server::RpcServer;
use crate::rpc::types::{self, LlmChatMessage};
use crate::turn_loop::types::*;

/// An LLM implementation that proxies requests to the JS host via `host/llm_chat`.
pub struct HostLlmProxy {
    system_prompt: String,
    model_name: String,
}

impl HostLlmProxy {
    pub fn new(system_prompt: String, model_name: String) -> Self {
        Self {
            system_prompt,
            model_name,
        }
    }
}

impl LLM for HostLlmProxy {
    fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_retryable_error(&self, _error: &str) -> bool {
        // Most network errors are retryable
        true
    }

    fn chat(&self, params: LLMChatParams) -> Result<LLMChatResponse, Box<dyn std::error::Error>> {
        // Convert messages
        let messages: Vec<LlmChatMessage> = params
            .messages
            .iter()
            .map(|m| LlmChatMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect();

        // Convert tools
        let tools: Vec<types::ToolDef> = params
            .tools
            .iter()
            .map(|t| types::ToolDef {
                name: t.name.clone(),
                description: t.description.clone(),
                input_schema: t.input_schema.clone(),
            })
            .collect();

        let request = types::LlmChatRequest {
            system_prompt: self.system_prompt.clone(),
            model_name: self.model_name.clone(),
            messages,
            tools,
        };

        // Call the host via JSON-RPC
        let response_value =
            RpcServer::call_host(types::methods::HOST_LLM_CHAT, &request)
                .map_err(|e| format!("LLM proxy error: {e}"))?;

        // Parse the response
        let response: types::LlmChatResponse = serde_json::from_value(response_value)
            .map_err(|e| format!("LLM proxy response parse error: {e}"))?;

        // Convert to turn_loop types
        let tool_calls: Vec<ToolCall> = response
            .tool_calls
            .into_iter()
            .map(|tc| ToolCall {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            })
            .collect();

        let usage = crate::rpc::types::TokenUsage {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            total_tokens: response.usage.total_tokens,
        };

        Ok(LLMChatResponse {
            tool_calls,
            finish_reason: response.finish_reason,
            usage,
        })
    }
}