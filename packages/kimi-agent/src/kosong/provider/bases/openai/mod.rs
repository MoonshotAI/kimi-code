/// OpenAI Chat Completions ChatProvider implementation (contrib module).
///
/// This file registers the OpenAI protocol base and builds the ChatProvider.
/// The actual HTTP transport is delegated to the existing `src/llm/openai.rs`
/// and `src/llm/http.rs` native implementations.
use crate::kosong::contract::provider::{ChatProvider, ThinkingEffort};
use crate::kosong::protocol::protocol::Protocol;
use crate::kosong::protocol::protocol_base::{register_protocol_base, ProtocolBaseDefinition, ProtocolBaseContext};
use crate::rpc::types::BoxFuture;

pub struct OpenAIChatProvider {
    pub name: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    pub max_completion_tokens: Option<u32>,
}

impl ChatProvider for OpenAIChatProvider {
    fn name(&self) -> &str { &self.name }
    fn model_name(&self) -> &str { &self.model_name }
    fn thinking_effort(&self) -> Option<&ThinkingEffort> { None }
    fn max_completion_tokens(&self) -> Option<u32> { self.max_completion_tokens }

    fn generate(
        &self,
        _system_prompt: &str,
        _tools: &[crate::kosong::contract::tool::Tool],
        _history: &[crate::kosong::contract::message::Message],
        _options: &crate::kosong::contract::provider::GenerateOptions,
    ) -> BoxFuture<'_, Result<crate::kosong::contract::provider::StreamedMessage, crate::kosong::contract::errors::ChatProviderError>> {
        Box::pin(async {
            Err(crate::kosong::contract::errors::ChatProviderError::Provider(
                "OpenAI ChatProvider: native HTTP transport not yet implemented; use NativeHttpLlm".to_string()
            ))
        })
    }
}

/// Register the OpenAI protocol base.
pub fn register() {
    register_protocol_base(ProtocolBaseDefinition {
        id: Protocol::OpenAI,
        capability: None,
        create_chat_provider: |ctx: ProtocolBaseContext| {
            let config = &ctx.config;
            let base_url = config.base_url.clone()
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            let api_key = config.api_key.clone().unwrap_or_default();
            Box::new(OpenAIChatProvider {
                name: config.provider_type.clone().unwrap_or_else(|| "openai".to_string()),
                model_name: config.model_name.clone(),
                base_url,
                api_key,
                max_completion_tokens: config.provider_options.as_ref().and_then(|po| po.default_max_tokens),
            })
        },
    });
}