/// kimi-agent kosong module — model/provider/protocol configuration system.
///
/// Ported from `packages/agent-core-v2/src/kosong/` (TypeScript). This is
/// the authoritative model configuration registry, provider-definition system,
/// wire-protocol adapter framework, and thinking-effort resolution engine.
///
/// ## Layer architecture
///
/// - **L0 — `contract/`**: Provider-agnostic wire types (Message, ContentPart,
///   ToolCall, ChatProvider trait, TokenUsage, etc.). No dependency on other
///   kosong modules.
/// - **L1 — `protocol/`**: Wire protocol identity enum (anthropic, openai,
///   openai_responses, google-genai), the adapter registry contract, and the
///   declarative trait surface for vendor-specific deviations.
/// - **L2 — `provider/` + `model/`**: Provider configuration types, the
///   provider-definition registry (map of vendor id → protocol-level traits),
///   the model catalog, thinking-effort resolution, and the ModelRequester
///   (request executor that composes ChatProviders from the registry).
pub mod contract;
pub mod model;
pub mod protocol;
pub mod provider;