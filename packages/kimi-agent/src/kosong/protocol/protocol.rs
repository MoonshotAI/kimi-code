/// Wire protocol identity and the adapter registry contract.
///
/// Corresponds to `kosong/protocol/protocol.ts`.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::kosong::contract::capability::ModelCapability;
use crate::kosong::contract::inspection::InspectionSource;
use crate::kosong::contract::provider::ChatProvider;

use super::protocol_base::{ProtocolBaseId, ResolvedAdapterIdentity};

/// The four real wire formats.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Anthropic,
    OpenAI,
    #[serde(rename = "openai_responses")]
    OpenaiResponses,
    #[serde(rename = "google-genai")]
    GoogleGenAI,
}

impl Protocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            Protocol::Anthropic => "anthropic",
            Protocol::OpenAI => "openai",
            Protocol::OpenaiResponses => "openai_responses",
            Protocol::GoogleGenAI => "google-genai",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "anthropic" => Some(Protocol::Anthropic),
            "openai" => Some(Protocol::OpenAI),
            "openai_responses" => Some(Protocol::OpenaiResponses),
            "google-genai" => Some(Protocol::GoogleGenAI),
            _ => None,
        }
    }
}

/// Construction knobs carried by adapter configuration.
#[derive(Debug, Clone, Default)]
pub struct ProtocolProviderOptions {
    pub reasoning_key: Option<String>,
    pub default_max_tokens: Option<u32>,
    pub support_efforts: Option<Vec<String>>,
    pub off_effort: Option<String>,
    pub adaptive_thinking: Option<bool>,
    pub beta_api: Option<bool>,
    pub metadata: Option<HashMap<String, String>>,
    pub vertexai: Option<bool>,
    pub project: Option<String>,
    pub location: Option<String>,
}

/// Configuration for creating a protocol adapter.
#[derive(Debug, Clone)]
pub struct ProtocolAdapterConfig {
    pub protocol: Protocol,
    pub provider_type: Option<String>,
    pub base_url: Option<String>,
    pub model_name: String,
    pub api_key: Option<String>,
    pub default_headers: Option<HashMap<String, String>>,
    pub provider_options: Option<ProtocolProviderOptions>,
}

/// The capability answer plus which level of the fallback chain produced it.
#[derive(Debug, Clone)]
pub struct ExplainedCapability {
    pub capability: ModelCapability,
    pub source: InspectionSource,
}

/// The protocol adapter registry — resolves (protocol, providerType) → adapter.
pub trait ProtocolAdapterRegistry: Send + Sync {
    /// The wire protocols with a registered base.
    fn supported_protocols(&self) -> Vec<Protocol>;

    /// Resolve which base + which traits serve this (protocol, providerType) pair.
    fn resolve_adapter_identity(
        &self,
        protocol: &Protocol,
        provider_type: Option<&str>,
    ) -> ResolvedAdapterIdentity;

    /// The base component without materializing traits.
    fn resolve_provider_base_id(
        &self,
        protocol: &Protocol,
        provider_type: Option<&str>,
    ) -> ProtocolBaseId;

    /// Capability resolution with fixed fallback chain.
    fn resolve_capability(
        &self,
        protocol: &Protocol,
        model_name: &str,
        provider_type: Option<&str>,
    ) -> ModelCapability;

    /// Provenance-preserving twin of `resolve_capability`.
    fn explain_capability(
        &self,
        protocol: &Protocol,
        model_name: &str,
        provider_type: Option<&str>,
    ) -> ExplainedCapability;

    /// Construct the composed, immutable ChatProvider.
    fn create_chat_provider(&self, config: ProtocolAdapterConfig) -> Box<dyn ChatProvider>;
}