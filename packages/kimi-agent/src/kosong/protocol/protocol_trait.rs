/// Declarative trait surface for vendor-specific deviations.
///
/// Corresponds to `kosong/protocol/protocolTrait.ts`.
use serde_json::Value;
use std::collections::HashMap;

use crate::kosong::contract::capability::ModelCapability;
use crate::kosong::contract::message::{Message, VideoUrlValue};
use crate::kosong::contract::provider::{
    GenerateOptions, ThinkingEffort, ToolCallIdPolicy, VideoUploadInput,
};
use crate::kosong::contract::tool::Tool;

use super::protocol::ProtocolAdapterConfig;

/// Everything a trait hook may read.
#[derive(Debug, Clone)]
pub struct TraitContext {
    pub config: ProtocolAdapterConfig,
    pub provider_id: Option<String>,
}

/// Construction-time endpoint fallback-chain declaration.
#[derive(Debug, Clone)]
pub struct ProtocolEndpoint {
    pub api_key_env: Option<String>,
    pub base_url_env: Option<String>,
    pub default_base_url: Option<String>,
}

/// A single, stateless declaration of how one vendor deviates from a wire base.
#[derive(Clone)]
pub struct ProtocolTrait {
    /// Metadata: strict thinking validation.
    pub strict_thinking_validation: bool,

    // ---- Construction-time hooks ----

    /// Extra options the trait provides to the base adapter.
    pub provides: Option<fn(&TraitContext) -> Option<HashMap<String, Value>>>,

    /// Endpoint fallback-chain declaration.
    pub endpoint: Option<fn(&TraitContext) -> Option<ProtocolEndpoint>>,

    /// Default request headers.
    pub default_headers: Option<fn(&TraitContext) -> Option<HashMap<String, String>>>,

    // ---- Per-request hooks ----

    /// Convert one tool definition to its wire shape.
    pub convert_tool: Option<fn(&Tool, &TraitContext) -> Option<Value>>,

    /// Pipeline: post-process one base-converted wire message.
    pub convert_message:
        Option<fn(&Message, &Value, &TraitContext) -> Option<Result<Value, ()>>>,

    /// Pipeline: reshape the whole converted wire history.
    pub merge_history: Option<fn(&[Value], &TraitContext) -> Option<Vec<Value>>>,

    /// Pipeline: post-process fully assembled request params.
    pub build_params: Option<fn(&Value, &TraitContext) -> Option<Value>>,

    /// Tool-call id rewrite policy.
    pub tool_call_id_policy: Option<fn(&TraitContext) -> Option<ToolCallIdPolicy>>,

    /// Per-turn thinking intent → generation-kwargs patch.
    pub with_thinking:
        Option<fn(ThinkingEffort, &Value, &TraitContext) -> Option<Value>>,

    /// Whether the current request must replay reasoning fields.
    pub preserve_thinking: Option<fn(&Value, &TraitContext) -> Option<bool>>,

    /// Completion-token budget → generation-kwargs patch.
    pub with_max_completion_tokens: Option<fn(u32, &TraitContext) -> Option<Value>>,

    /// Prompt-cache key → generation-kwargs patch.
    pub cache_key: Option<fn(&str, &TraitContext) -> Option<Value>>,

    /// Locate usage payload inside one raw stream chunk.
    pub extract_usage: Option<fn(&Value, &TraitContext) -> Option<Option<Value>>>,

    /// The wire field name carrying reasoning content.
    pub reasoning_key: Option<fn(&TraitContext) -> Option<String>>,

    /// Declared capability for one model.
    pub capability: Option<fn(&str, &TraitContext) -> Option<ModelCapability>>,

    /// Video upload facility.
    pub upload_video:
        Option<fn(&VideoUploadInput, &GenerateOptions, &TraitContext) -> Option<VideoUrlValue>>,
}

impl std::fmt::Debug for ProtocolTrait {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtocolTrait")
            .field("strict_thinking_validation", &self.strict_thinking_validation)
            .finish()
    }
}

/// A trait plus its bound context.
#[derive(Debug, Clone)]
pub struct ResolvedTrait {
    pub trait_def: ProtocolTrait,
    pub context: TraitContext,
}

/// Aggregate the defaultHeaders declarations of resolved traits in order.
pub fn trait_default_headers(traits: &[ResolvedTrait]) -> Option<HashMap<String, String>> {
    let mut headers: Option<HashMap<String, String>> = None;
    for rt in traits {
        if let Some(ref decl) = rt.trait_def.default_headers {
            if let Some(declared) = (decl)(&rt.context) {
                let h = headers.get_or_insert_with(HashMap::new);
                h.extend(declared);
            }
        }
    }
    headers
}