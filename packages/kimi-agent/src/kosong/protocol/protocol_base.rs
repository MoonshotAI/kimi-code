/// Protocol base definition and module-level registry.
///
/// Corresponds to `kosong/protocol/protocolBase.ts`.
use std::collections::HashMap;
use std::sync::Mutex;

use crate::kosong::contract::capability::ModelCapability;
use crate::kosong::contract::provider::ChatProvider;

use super::protocol::{Protocol, ProtocolAdapterConfig};
use super::protocol_trait::ResolvedTrait;

/// Identifies a registered protocol base. Currently the protocol itself.
pub type ProtocolBaseId = Protocol;

/// What a contrib factory receives from the adapter registry.
#[derive(Debug, Clone)]
pub struct ProtocolBaseContext {
    pub config: ProtocolAdapterConfig,
    pub traits: Vec<ResolvedTrait>,
}

/// A registered protocol base definition.
pub struct ProtocolBaseDefinition {
    pub id: ProtocolBaseId,
    /// The base's own capability catalog — final fallback for capability resolution.
    pub capability: Option<fn(&str) -> Option<ModelCapability>>,
    /// Factory function to create a ChatProvider from context.
    pub create_chat_provider: fn(ProtocolBaseContext) -> Box<dyn ChatProvider>,
}

impl Clone for ProtocolBaseDefinition {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            capability: self.capability,
            create_chat_provider: self.create_chat_provider,
        }
    }
}

impl std::fmt::Debug for ProtocolBaseDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtocolBaseDefinition")
            .field("id", &self.id)
            .finish()
    }
}

/// Resolved adapter identity.
#[derive(Debug, Clone)]
pub struct ResolvedAdapterIdentity {
    pub base_id: ProtocolBaseId,
    pub traits: Vec<ResolvedTrait>,
}

// ---------------------------------------------------------------------------
// Global protocol base registry
// ---------------------------------------------------------------------------

static PROTOCOL_BASES: Mutex<Option<HashMap<ProtocolBaseId, ProtocolBaseDefinition>>> =
    Mutex::new(None);

fn with_bases<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<ProtocolBaseId, ProtocolBaseDefinition>) -> R,
{
    let mut guard = PROTOCOL_BASES.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

fn with_bases_read<F, R>(f: F) -> R
where
    F: FnOnce(&HashMap<ProtocolBaseId, ProtocolBaseDefinition>) -> R,
{
    let mut guard = PROTOCOL_BASES.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// Register a protocol base. Called from contrib modules at init time.
pub fn register_protocol_base(definition: ProtocolBaseDefinition) {
    with_bases(|map| {
        if map.contains_key(&definition.id) {
            panic!("protocol base '{:?}' is already registered", definition.id);
        }
        map.insert(definition.id.clone(), definition);
    })
}

/// Get a registered protocol base by id.
pub fn get_protocol_base(id: &ProtocolBaseId) -> Option<ProtocolBaseDefinition> {
    with_bases_read(|map| map.get(id).cloned())
}

/// List all registered bases in registration order.
pub fn list_protocol_bases() -> Vec<ProtocolBaseDefinition> {
    with_bases_read(|map| map.values().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kosong::contract::provider::{ChatProvider, GenerateOptions, StreamedMessage};
    use crate::kosong::contract::message::Message;
    use crate::kosong::contract::tool::Tool;
    use crate::kosong::contract::errors::ChatProviderError;
    use crate::kosong::contract::provider::ThinkingEffort;
    use crate::rpc::types::BoxFuture;

    struct MockProvider;

    impl ChatProvider for MockProvider {
        fn name(&self) -> &str { "mock" }
        fn model_name(&self) -> &str { "mock" }
        fn thinking_effort(&self) -> Option<&ThinkingEffort> { None }
        fn max_completion_tokens(&self) -> Option<u32> { None }
        fn generate(&self, _: &str, _: &[Tool], _: &[Message], _: &GenerateOptions) -> BoxFuture<'_, Result<StreamedMessage, ChatProviderError>> {
            Box::pin(async { unimplemented!() })
        }
    }

    fn mock_factory(_ctx: ProtocolBaseContext) -> Box<dyn ChatProvider> {
        Box::new(MockProvider)
    }

    #[test]
    fn test_register_and_get_base() {
        let def = ProtocolBaseDefinition {
            id: Protocol::OpenAI,
            capability: None,
            create_chat_provider: mock_factory,
        };
        register_protocol_base(def);
        let retrieved = get_protocol_base(&Protocol::OpenAI);
        assert!(retrieved.is_some());
    }

    #[test]
    #[should_panic(expected = "already registered")]
    fn test_duplicate_registration_panics() {
        let def = ProtocolBaseDefinition {
            id: Protocol::Anthropic,
            capability: None,
            create_chat_provider: mock_factory,
        };
        register_protocol_base(def.clone());
        register_protocol_base(def);
    }
}