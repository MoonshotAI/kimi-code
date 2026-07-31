/// Standard provider definitions — the four canonical vendors.
///
/// Corresponds to `kosong/provider/providers/standard.contrib.ts`.
use crate::kosong::protocol::protocol::Protocol;
use crate::kosong::protocol::protocol_trait::{ProtocolEndpoint, ProtocolTrait, TraitContext};
use crate::kosong::provider::provider_definition::{register_provider_definition, ProviderDefinition};

/// Register the standard provider definitions.
pub fn register() {
    // Anthropic
    register_provider_definition(ProviderDefinition {
        id: "anthropic".to_string(),
        base_protocol: Protocol::Anthropic,
        traits: vec![],
        endpoint: Some(ProtocolEndpoint {
            api_key_env: Some("ANTHROPIC_API_KEY".to_string()),
            base_url_env: Some("ANTHROPIC_BASE_URL".to_string()),
            default_base_url: None,
        }),
        host_headers: None,
        model_source: None,
    });

    // OpenAI
    register_provider_definition(ProviderDefinition {
        id: "openai".to_string(),
        base_protocol: Protocol::OpenAI,
        traits: vec![],
        endpoint: Some(ProtocolEndpoint {
            api_key_env: Some("OPENAI_API_KEY".to_string()),
            base_url_env: Some("OPENAI_BASE_URL".to_string()),
            default_base_url: None,
        }),
        host_headers: None,
        model_source: None,
    });

    // OpenAI Responses
    register_provider_definition(ProviderDefinition {
        id: "openai_responses".to_string(),
        base_protocol: Protocol::OpenaiResponses,
        traits: vec![],
        endpoint: Some(ProtocolEndpoint {
            api_key_env: Some("OPENAI_API_KEY".to_string()),
            base_url_env: Some("OPENAI_BASE_URL".to_string()),
            default_base_url: None,
        }),
        host_headers: None,
        model_source: None,
    });

    // Google GenAI
    register_provider_definition(ProviderDefinition {
        id: "google-genai".to_string(),
        base_protocol: Protocol::GoogleGenAI,
        endpoint: None,
        traits: vec![
            // Vertex AI fallback chain
            ProtocolTrait {
                strict_thinking_validation: false,
                provides: None,
                endpoint: Some(|_: &TraitContext| -> Option<ProtocolEndpoint> {
                    Some(ProtocolEndpoint {
                        api_key_env: Some("VERTEXAI_API_KEY".to_string()),
                        base_url_env: Some("GOOGLE_VERTEX_BASE_URL".to_string()),
                        default_base_url: None,
                    })
                }),
                default_headers: None,
                convert_tool: None,
                convert_message: None,
                merge_history: None,
                build_params: None,
                tool_call_id_policy: None,
                with_thinking: None,
                preserve_thinking: None,
                with_max_completion_tokens: None,
                cache_key: None,
                extract_usage: None,
                reasoning_key: None,
                capability: None,
                upload_video: None,
            },
            // Plain Gemini fallback
            ProtocolTrait {
                strict_thinking_validation: false,
                provides: None,
                endpoint: Some(|_: &TraitContext| -> Option<ProtocolEndpoint> {
                    Some(ProtocolEndpoint {
                        api_key_env: Some("GOOGLE_API_KEY".to_string()),
                        base_url_env: Some("GOOGLE_GEMINI_BASE_URL".to_string()),
                        default_base_url: None,
                    })
                }),
                default_headers: None,
                convert_tool: None,
                convert_message: None,
                merge_history: None,
                build_params: None,
                tool_call_id_policy: None,
                with_thinking: None,
                preserve_thinking: None,
                with_max_completion_tokens: None,
                cache_key: None,
                extract_usage: None,
                reasoning_key: None,
                capability: None,
                upload_video: None,
            },
        ],
        host_headers: None,
        model_source: None,
    });
}