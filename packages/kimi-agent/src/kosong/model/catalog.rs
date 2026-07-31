/// Model catalog — the pure-data `Model` and `IModelCatalog` interface.
///
/// Corresponds to `kosong/model/catalog.ts`.
use std::collections::HashMap;

use crate::kosong::contract::capability::ModelCapability;
use crate::kosong::contract::provider::ProviderRequestAuth;
use crate::kosong::contract::usage::TokenUsage;
use crate::kosong::protocol::protocol::{Protocol, ProtocolProviderOptions};

use crate::kosong::provider::provider::ProviderConfig;

use super::model::{ModelRecord, ModelsSection};
use super::model_auth::effective_model_config;

/// Auth provider — resolves per-request wire credentials.
pub trait AuthProvider: Send + Sync {
    fn can_refresh(&self) -> bool;
    fn get_auth(&self, force: bool) -> Option<ProviderRequestAuth>;
}

/// Static API key credentials; never refreshes.
pub struct StaticAuthProvider {
    api_key: Option<String>,
}

impl StaticAuthProvider {
    pub fn new(api_key: Option<String>) -> Self {
        Self { api_key }
    }
}

impl AuthProvider for StaticAuthProvider {
    fn can_refresh(&self) -> bool {
        false
    }

    fn get_auth(&self, _force: bool) -> Option<ProviderRequestAuth> {
        self.api_key
            .as_ref()
            .filter(|k| !k.trim().is_empty())
            .map(|k| ProviderRequestAuth {
                api_key: Some(k.clone()),
                headers: None,
            })
    }
}

/// The configuration-derived data of one configured model.
pub struct Model {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub protocol: Protocol,
    pub base_url: Option<String>,
    pub headers: HashMap<String, String>,

    pub capabilities: ModelCapability,
    pub max_context_size: u32,
    pub max_input_size: Option<u32>,
    pub max_output_size: Option<u32>,
    pub display_name: Option<String>,
    pub reasoning_key: Option<String>,
    pub support_efforts: Option<Vec<String>>,
    pub default_effort: Option<String>,
    pub always_thinking: bool,
    pub provider_type: Option<String>,
    pub provider_name: String,

    pub auth_provider: Box<dyn AuthProvider>,
    pub provider_options: Option<ProtocolProviderOptions>,
}

impl std::fmt::Debug for Model {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Model")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("protocol", &self.protocol)
            .field("provider_name", &self.provider_name)
            .finish()
    }
}

/// Outcome of one live connectivity probe.
#[derive(Debug, Clone)]
pub struct ModelPingResult {
    pub ok: bool,
    pub duration_ms: u64,
    pub text: Option<String>,
    pub finish_reason: Option<String>,
    pub usage: Option<TokenUsage>,
    pub error: Option<String>,
}

/// Catalog item projection for wire display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelCatalogItem {
    pub provider: String,
    pub model: String,
    pub display_name: String,
    pub max_context_size: u32,
    pub capabilities: Option<Vec<String>>,
    pub support_efforts: Option<Vec<String>>,
    pub default_effort: Option<String>,
}

/// Provider catalog item projection for wire display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProviderCatalogItem {
    pub id: String,
    pub provider_type: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub has_api_key: bool,
    pub status: String,
    pub models: Option<Vec<String>>,
}

use serde::Serialize;

/// Project a Model into a ModelCatalogItem.
pub fn to_protocol_model(
    model: &Model,
    record: &ModelRecord,
    provider_type: Option<&str>,
) -> ModelCatalogItem {
    let effective = effective_model_config(record, provider_type);
    ModelCatalogItem {
        provider: model.provider_name.clone(),
        model: model.id.clone(),
        display_name: model
            .display_name
            .clone()
            .unwrap_or_else(|| model.name.clone()),
        max_context_size: model.max_context_size,
        capabilities: effective.capabilities,
        support_efforts: model.support_efforts.clone(),
        default_effort: model.default_effort.clone(),
    }
}

/// Config-only fallback projection for models whose materialization fails.
pub fn to_protocol_model_fallback(
    model_id: &str,
    record: &ModelRecord,
    provider_type: Option<&str>,
) -> ModelCatalogItem {
    let effective = effective_model_config(record, provider_type);
    ModelCatalogItem {
        provider: effective.provider.unwrap_or_default(),
        model: model_id.to_string(),
        display_name: effective
            .display_name
            .or_else(|| effective.model.clone())
            .unwrap_or_else(|| model_id.to_string()),
        max_context_size: effective.max_context_size.unwrap_or(0),
        capabilities: effective.capabilities,
        support_efforts: effective.support_efforts,
        default_effort: effective.default_effort,
    }
}

/// Project a provider into a ProviderCatalogItem.
pub fn to_protocol_provider(
    provider_id: &str,
    provider: &ProviderConfig,
    models: &ModelsSection,
    global_default_model: Option<&str>,
    credential_state: ProviderCredentialState,
) -> ProviderCatalogItem {
    let provider_models = model_ids_for_provider(models, provider_id);
    let default_model = provider
        .default_model
        .clone()
        .or_else(|| global_default_for_provider(models, global_default_model, provider_id));
    ProviderCatalogItem {
        id: provider_id.to_string(),
        provider_type: provider.provider_type.clone().unwrap_or_else(|| "openai".to_string()),
        base_url: provider.base_url.clone(),
        default_model,
        has_api_key: credential_state.has_api_key,
        status: if credential_state.has_api_key || credential_state.has_oauth_token {
            "connected".to_string()
        } else {
            "unconfigured".to_string()
        },
        models: if provider_models.is_empty() {
            None
        } else {
            Some(provider_models)
        },
    }
}

/// Get model ids that belong to a specific provider.
pub fn model_ids_for_provider(models: &ModelsSection, provider_id: &str) -> Vec<String> {
    models
        .iter()
        .filter(|(_, record)| record.provider.as_deref() == Some(provider_id))
        .map(|(id, _)| id.clone())
        .collect()
}

/// Get the global default model id for a provider.
pub fn global_default_for_provider(
    models: &ModelsSection,
    global_default_model: Option<&str>,
    provider_id: &str,
) -> Option<String> {
    let default_id = global_default_model?;
    let record = models.get(default_id)?;
    if record.provider.as_deref() == Some(provider_id) {
        Some(default_id.to_string())
    } else {
        None
    }
}

/// Credential state for a provider.
#[derive(Debug, Clone, Default)]
pub struct ProviderCredentialState {
    pub has_api_key: bool,
    pub has_oauth_token: bool,
}