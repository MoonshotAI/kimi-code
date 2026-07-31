/// ProtocolAdapterRegistry — the single production implementation.
///
/// Corresponds to `kosong/provider/protocolAdapterRegistry.ts`.
use crate::kosong::contract::capability::{ModelCapability, UNKNOWN_CAPABILITY};
use crate::kosong::contract::inspection::{InspectionSource, InspectionSourceKind};
use crate::kosong::contract::provider::ChatProvider;
use crate::kosong::protocol::protocol::{Protocol, ProtocolAdapterConfig, ProtocolAdapterRegistry};
use crate::kosong::protocol::protocol_base::{
    get_protocol_base, list_protocol_bases, ProtocolBaseContext, ResolvedAdapterIdentity,
};
use crate::kosong::protocol::protocol_trait::{ProtocolTrait, ResolvedTrait, TraitContext};
use crate::kosong::provider::provider_definition::get_provider_definition;

/// The trailing synthetic trait that lets config `defaultHeaders` win.
fn config_default_headers_trait() -> ProtocolTrait {
    ProtocolTrait {
        strict_thinking_validation: false,
        provides: None,
        endpoint: None,
        default_headers: Some(|ctx: &TraitContext| {
            ctx.config.default_headers.clone()
        }),
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
    }
}

/// The production protocol adapter registry.
pub struct ProtocolAdapterRegistryImpl;

impl ProtocolAdapterRegistry for ProtocolAdapterRegistryImpl {
    fn supported_protocols(&self) -> Vec<Protocol> {
        list_protocol_bases().into_iter().map(|b| b.id).collect()
    }

    fn resolve_adapter_identity(
        &self,
        protocol: &Protocol,
        provider_type: Option<&str>,
    ) -> ResolvedAdapterIdentity {
        let definition = provider_type
            .and_then(|pt| get_provider_definition(pt, Some(protocol)));
        let base_id = protocol.clone();
        let traits: Vec<ProtocolTrait> = definition
            .map(|d| d.traits.clone())
            .unwrap_or_default();

        // Identity resolution has no live adapter config, so contexts are stubs
        let stub_config = ProtocolAdapterConfig {
            protocol: protocol.clone(),
            provider_type: provider_type.map(|s| s.to_string()),
            base_url: None,
            model_name: String::new(),
            api_key: None,
            default_headers: None,
            provider_options: None,
        };
        let context = TraitContext {
            config: stub_config,
            provider_id: provider_type.map(|s| s.to_string()),
        };
        let mut resolved: Vec<ResolvedTrait> = traits
            .into_iter()
            .map(|t| ResolvedTrait {
                trait_def: t,
                context: context.clone(),
            })
            .collect();

        // Append config default headers synthetic trait
        resolved.push(ResolvedTrait {
            trait_def: config_default_headers_trait(),
            context: context.clone(),
        });

        ResolvedAdapterIdentity { base_id, traits: resolved }
    }

    fn resolve_provider_base_id(
        &self,
        protocol: &Protocol,
        provider_type: Option<&str>,
    ) -> Protocol {
        let definition = provider_type
            .and_then(|pt| get_provider_definition(pt, Some(protocol)));
        definition
            .map(|d| d.base_protocol.clone())
            .unwrap_or_else(|| protocol.clone())
    }

    fn resolve_capability(
        &self,
        protocol: &Protocol,
        model_name: &str,
        provider_type: Option<&str>,
    ) -> ModelCapability {
        self.explain_capability(protocol, model_name, provider_type).capability
    }

    fn explain_capability(
        &self,
        protocol: &Protocol,
        model_name: &str,
        provider_type: Option<&str>,
    ) -> crate::kosong::protocol::protocol::ExplainedCapability {
        let identity = self.resolve_adapter_identity(protocol, provider_type);

        // Trait capability hooks (last declarer wins)
        let mut trait_capability: Option<ModelCapability> = None;
        for rt in &identity.traits {
            if let Some(ref cap_fn) = rt.trait_def.capability {
                if let Some(cap) = (cap_fn)(model_name, &rt.context) {
                    trait_capability = Some(cap);
                }
            }
        }
        if let Some(cap) = trait_capability {
            return crate::kosong::protocol::protocol::ExplainedCapability {
                capability: cap,
                source: InspectionSource::with_detail(
                    InspectionSourceKind::Builtin,
                    &format!("trait capability hook (provider '{}')", provider_type.unwrap_or("unregistered")),
                ),
            };
        }

        // Base capability catalog
        if let Some(base) = get_protocol_base(&identity.base_id) {
            if let Some(cap_fn) = base.capability {
                if let Some(cap) = (cap_fn)(model_name) {
                    return crate::kosong::protocol::protocol::ExplainedCapability {
                        capability: cap,
                        source: InspectionSource::with_detail(
                            InspectionSourceKind::Builtin,
                            &format!("protocol base '{:?}' catalog", identity.base_id),
                        ),
                    };
                }
            }
        }

        crate::kosong::protocol::protocol::ExplainedCapability {
            capability: UNKNOWN_CAPABILITY,
            source: InspectionSource::with_detail(InspectionSourceKind::None, "no capability source knew this model"),
        }
    }

    fn create_chat_provider(&self, config: ProtocolAdapterConfig) -> Box<dyn ChatProvider> {
        let identity = self.resolve_adapter_identity(
            &config.protocol,
            config.provider_type.as_deref(),
        );

        // Re-bind traits with the real adapter config
        let traits: Vec<ResolvedTrait> = identity
            .traits
            .into_iter()
            .map(|rt| ResolvedTrait {
                trait_def: rt.trait_def,
                context: TraitContext {
                    config: config.clone(),
                    provider_id: config.provider_type.clone(),
                },
            })
            .collect();

        let base = get_protocol_base(&identity.base_id)
            .unwrap_or_else(|| {
                panic!(
                    "No protocol base registered for '{:?}'. Import the base's contrib module first.",
                    identity.base_id
                )
            });

        (base.create_chat_provider)(ProtocolBaseContext {
            config,
            traits,
        })
    }
}