/// Shared pure-data types for the model layer.
///
/// Corresponds to `kosong/model/model.types.ts`.
use serde::{Deserialize, Serialize};

use crate::kosong::contract::capability::ModelCapability;
use crate::kosong::provider::provider::OAuthRef;

/// Resolved model overrides from environment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ModelOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_keep: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u32>,
}

/// Completion budget configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CompletionBudgetConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hard_cap: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<u32>,
}

/// Completion budget params for computation.
#[derive(Debug, Clone, Default)]
pub struct CompletionBudgetParams {
    pub max_completion_tokens: Option<u32>,
    pub used_context_tokens: Option<u32>,
    pub max_context_tokens: Option<u32>,
}

/// Resolved auth material for a model.
#[derive(Debug, Clone, Default)]
pub struct ResolvedModelAuthMaterial {
    pub api_key: Option<String>,
    pub oauth: Option<OAuthRef>,
    pub oauth_provider_key: Option<String>,
}

/// Thinking defaults for a model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ThinkingDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// Model thinking metadata from the catalog or provider definition.
#[derive(Debug, Clone, Default)]
pub struct ModelThinkingMetadata {
    pub capabilities: Option<ModelThinkingCapabilities>,
    pub adaptive_thinking: Option<bool>,
    pub always_thinking: Option<bool>,
    pub support_efforts: Option<Vec<String>>,
    pub default_effort: Option<String>,
}

/// Model capability types for thinking resolution.
#[derive(Debug, Clone)]
pub enum ModelThinkingCapabilities {
    Flags(ModelCapability),
    List(Vec<String>),
}