/// Provider configuration contract — the "endpoint + model-enumeration" boundary.
///
/// Corresponds to `kosong/provider/provider.ts`.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Free-form vendor identity (e.g. "kimi"). Not an enum, by design.
pub type ProviderType = String;

/// OAuth reference for credential storage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OAuthRef {
    pub storage: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_host: Option<String>,
}

/// How models are discovered for a provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource {
    Static,
    Discover,
    #[serde(rename = "oauth-catalog")]
    OAuthCatalog,
}

/// A single provider configuration entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_source: Option<ModelSource>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<HashMap<String, String>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,

    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub provider_type: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthRef>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<HashMap<String, serde_json::Value>>,
}

/// A section of provider configs keyed by id.
pub type ProvidersSection = HashMap<String, ProviderConfig>;