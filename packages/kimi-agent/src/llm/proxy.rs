/// LLM proxy implementation that forwards chat requests to the JS host
/// via the [`HostCallbacks`] trait (abstracting over stdio JSON-RPC and
/// napi-rs ThreadsafeFunction transports).

use std::sync::Arc;

use crate::callbacks::HostCallbacks;
use crate::rpc::types::{self, LlmChatMessage};
use crate::turn_loop::types::*;

/// An LLM implementation that proxies requests to the JS host via
/// [`HostCallbacks::llm_chat`].
pub struct HostLlmProxy {
    system_prompt: String,
    model_name: String,
    callbacks: Option<Arc<dyn HostCallbacks>>,
}

impl HostLlmProxy {
    pub fn new(system_prompt: String, model_name: String) -> Self {
        Self {
            system_prompt,
            model_name,
            callbacks: None,
        }
    }

    pub fn with_callbacks(mut self, callbacks: Arc<dyn HostCallbacks>) -> Self {
        self.callbacks = Some(callbacks);
        self
    }

    /// Legacy: accept an RPC server and wrap it in [`RpcHostCallbacks`].
    pub fn with_server(self, server: Arc<crate::rpc::server::RpcServer>) -> Self {
        let cb = Arc::new(crate::callbacks::RpcHostCallbacks { server });
        self.with_callbacks(cb)
    }
}

impl LLM for HostLlmProxy {
    fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_retryable_error(&self, error: &str) -> bool {
        // Only transient failures (rate limit / overload / connection) are
        // worth retrying. A deterministic error from the host (e.g. "llm_chat
        // not implemented") must fail fast — retrying it with exponential
        // backoff just hangs the turn for the full retry budget.
        matches!(
            crate::turn_loop::retry::classify_error(error),
            crate::turn_loop::retry::ErrorClass::RateLimit
                | crate::turn_loop::retry::ErrorClass::Overload
                | crate::turn_loop::retry::ErrorClass::Transient
        )
    }

    fn chat(&self, params: LLMChatParams) -> crate::rpc::types::BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
        let system_prompt = self.system_prompt.clone();
        let model_name = self.model_name.clone();
        let callbacks = self.callbacks.clone();

        Box::pin(async move {
            let callbacks = callbacks.expect("HostLlmProxy: callbacks not set");

            // Convert messages
            let messages: Vec<LlmChatMessage> = params
                .messages
                .iter()
                .map(|m| LlmChatMessage {
                    role: m.role.clone(),
                    content: m.content.clone(),
                    blocks: m.blocks.clone(),
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
                session_id: None,
                system_prompt,
                model_name,
                messages,
                tools,
            };

            let response = callbacks.llm_chat(request).await
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                    Box::new(std::io::Error::new(std::io::ErrorKind::Other, e))
                })?;

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
                content: response.content,
                tool_calls,
                finish_reason: response.finish_reason,
                usage,
            })
        })
    }
}