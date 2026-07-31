/// Model configuration registry types.
///
/// Corresponds to `kosong/model/model.ts`.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::kosong::provider::provider::OAuthRef;

/// The per-model `overrides` sub-record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ModelOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_input_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_efforts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off_effort: Option<String>,
}

/// A persisted model configuration entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ModelRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthRef>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_input_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beta_api: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_efforts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off_effort: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<ModelOverride>,
}

/// A section of model configs keyed by id.
pub type ModelsSection = HashMap<String, ModelRecord>;

/// Event for model changes.
#[derive(Debug, Clone)]
pub struct ModelsChangedEvent {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
}

/// Event for default model changes.
#[derive(Debug, Clone)]
pub struct DefaultModelChangedEvent {
    pub id: Option<String>,
}