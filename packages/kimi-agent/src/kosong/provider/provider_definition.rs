/// Provider-definition registry — the declarative answer to "who is this vendor".
///
/// Corresponds to `kosong/provider/providerDefinition.ts`.
use std::collections::HashMap;
use std::sync::Mutex;

use crate::kosong::protocol::protocol::Protocol;
use crate::kosong::protocol::protocol_trait::{ProtocolEndpoint, ProtocolTrait};

use super::provider::ModelSource;

/// A provider definition — one vendor × protocol pair registration.
#[derive(Clone)]
pub struct ProviderDefinition {
    pub id: String,
    pub base_protocol: Protocol,
    pub traits: Vec<ProtocolTrait>,
    pub endpoint: Option<ProtocolEndpoint>,
    pub host_headers: Option<HostHeadersLevel>,
    pub model_source: Option<ModelSource>,
}

impl std::fmt::Debug for ProviderDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderDefinition")
            .field("id", &self.id)
            .field("base_protocol", &self.base_protocol)
            .field("host_headers", &self.host_headers)
            .field("model_source", &self.model_source)
            .finish()
    }
}

/// How much of the host's request headers this vendor receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostHeadersLevel {
    Full,
    UserAgent,
}

/// Resolved provider endpoint (apiKey + baseUrl).
#[derive(Debug, Clone, Default)]
pub struct ResolvedProviderEndpoint {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

/// Provenance-preserving endpoint resolution.
#[derive(Debug, Clone, Default)]
pub struct ExplainedProviderEndpoint {
    pub api_key: Option<String>,
    pub api_key_env_name: Option<String>,
    pub base_url: Option<String>,
    pub base_url_env_name: Option<String>,
    pub base_url_is_default: Option<bool>,
}

// ---------------------------------------------------------------------------
// Global registry
// ---------------------------------------------------------------------------

static PROVIDER_DEFINITIONS: Mutex<Option<HashMap<String, HashMap<Protocol, ProviderDefinition>>>> =
    Mutex::new(None);

fn registry() -> &'static Mutex<Option<HashMap<String, HashMap<Protocol, ProviderDefinition>>>> {
    &PROVIDER_DEFINITIONS
}

fn with_registry<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, HashMap<Protocol, ProviderDefinition>>) -> R,
{
    let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

fn with_registry_read<F, R>(f: F) -> R
where
    F: FnOnce(&HashMap<String, HashMap<Protocol, ProviderDefinition>>) -> R,
{
    let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    f(guard.as_ref().unwrap())
}

/// Register a provider definition. Called once per vendor × protocol pair.
pub fn register_provider_definition(definition: ProviderDefinition) {
    with_registry(|map| {
        let by_protocol = map
            .entry(definition.id.clone())
            .or_insert_with(HashMap::new);
        if by_protocol.contains_key(&definition.base_protocol) {
            panic!(
                "provider definition '{}' is already registered for protocol '{:?}'",
                definition.id, definition.base_protocol
            );
        }
        by_protocol.insert(definition.base_protocol.clone(), definition);
    })
}

/// Get a provider definition by id and optional protocol.
pub fn get_provider_definition(
    id: &str,
    protocol: Option<&Protocol>,
) -> Option<ProviderDefinition> {
    with_registry_read(|map| {
        let by_protocol = map.get(id)?;
        match protocol {
            Some(p) => by_protocol.get(p).cloned(),
            None => by_protocol.values().next().cloned(),
        }
    })
}

/// Get all registrations of one vendor id.
pub fn get_provider_definitions(id: &str) -> Vec<ProviderDefinition> {
    with_registry_read(|map| {
        map.get(id)
            .map(|by_protocol| by_protocol.values().cloned().collect())
            .unwrap_or_default()
    })
}

/// Check if a vendor id has any registration.
pub fn has_provider_definition(id: &str) -> bool {
    with_registry_read(|map| map.contains_key(id))
}

/// Whether any registration of the vendor declares `model_source: OAuthCatalog`.
pub fn is_oauth_catalog_vendor(id: Option<&str>) -> bool {
    let id = match id {
        Some(id) => id,
        None => return false,
    };
    get_provider_definitions(id)
        .iter()
        .any(|d| d.model_source == Some(ModelSource::OAuthCatalog))
}

/// List all registered provider definitions.
pub fn list_provider_definitions() -> Vec<ProviderDefinition> {
    with_registry_read(|map| {
        map.values()
            .flat_map(|by_protocol| by_protocol.values().cloned())
            .collect()
    })
}

/// Resolve a vendor's endpoint from its definition.
pub fn resolve_provider_endpoint(
    provider_type: &str,
    env: &HashMap<String, String>,
) -> ResolvedProviderEndpoint {
    let explained = explain_provider_endpoint(provider_type, env);
    ResolvedProviderEndpoint {
        api_key: explained.api_key,
        base_url: explained.base_url,
    }
}

/// Provenance-preserving endpoint resolver.
pub fn explain_provider_endpoint(
    provider_type: &str,
    env: &HashMap<String, String>,
) -> ExplainedProviderEndpoint {
    let definition = get_provider_definition(provider_type, None);
    let definition = match definition {
        Some(d) => d,
        None => return ExplainedProviderEndpoint::default(),
    };

    let endpoint = definition.endpoint.as_ref();
    let api_key_hit = endpoint
        .and_then(|e| e.api_key_env.as_ref())
        .and_then(|name| env.get(name).map(|v| (name.clone(), v.clone())));
    let base_url_hit = endpoint
        .and_then(|e| e.base_url_env.as_ref())
        .and_then(|name| env.get(name).map(|v| (name.clone(), v.clone())));

    ExplainedProviderEndpoint {
        api_key: api_key_hit.as_ref().map(|(_, v)| v.clone()),
        api_key_env_name: api_key_hit.as_ref().map(|(n, _)| n.clone()),
        base_url: base_url_hit
            .as_ref()
            .map(|(_, v)| v.clone())
            .or_else(|| endpoint.and_then(|e| e.default_base_url.clone())),
        base_url_env_name: base_url_hit.as_ref().map(|(n, _)| n.clone()),
        base_url_is_default: if base_url_hit.is_none()
            && endpoint.and_then(|e| e.default_base_url.as_ref()).is_some()
        {
            Some(true)
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_and_get() {
        let def = ProviderDefinition {
            id: "test-vendor".to_string(),
            base_protocol: Protocol::OpenAI,
            traits: Vec::new(),
            endpoint: None,
            host_headers: None,
            model_source: None,
        };
        register_provider_definition(def);

        let retrieved = get_provider_definition("test-vendor", Some(&Protocol::OpenAI));
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, "test-vendor");
    }

    #[test]
    fn test_get_nonexistent() {
        let retrieved = get_provider_definition("nonexistent", None);
        assert!(retrieved.is_none());
    }

    #[test]
    #[should_panic(expected = "already registered")]
    fn test_duplicate_registration_panics() {
        let def = ProviderDefinition {
            id: "dup-vendor".to_string(),
            base_protocol: Protocol::Anthropic,
            traits: Vec::new(),
            endpoint: None,
            host_headers: None,
            model_source: None,
        };
        register_provider_definition(def.clone());
        register_provider_definition(def);
    }

    #[test]
    fn test_has_provider_definition() {
        let def = ProviderDefinition {
            id: "check-vendor".to_string(),
            base_protocol: Protocol::OpenAI,
            traits: Vec::new(),
            endpoint: None,
            host_headers: None,
            model_source: None,
        };
        register_provider_definition(def);
        assert!(has_provider_definition("check-vendor"));
        assert!(!has_provider_definition("missing"));
    }
}