//! Model catalog — fetch the provider/model directory from models.dev
//! (`https://models.dev/api.json`), mirroring node-sdk's `catalog.ts`.
//! Transport via reqwest (rustls), which avoids the Windows schannel
//! certificate-revocation check that blocks plain curl on some networks.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::CatalogFetchError;

/// The default catalog URL (models.dev provider directory).
pub const DEFAULT_CATALOG_URL: &str = "https://models.dev/api.json";

/// A provider entry from the catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogProvider {
    pub id: String,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub npm: Option<String>,
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub doc: Option<String>,
    /// Explicit wire-type extension (models.dev `type`); inferred from
    /// `npm`/`id` when absent.
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub models: HashMap<String, CatalogModel>,
}

/// A single model inside a provider entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub reasoning: Option<bool>,
    #[serde(default)]
    pub context_length: Option<u64>,
    #[serde(default)]
    pub cost: Option<CatalogCost>,
    /// Every field not modeled above (`limit`, `reasoning_options`,
    /// `modalities`, `tool_call`, `status`, `provider`, `interleaved`, …),
    /// preserved verbatim so normalization ([`catalog_model_to_capability`])
    /// sees the full models.dev entry.
    #[serde(flatten)]
    pub raw: serde_json::Map<String, Value>,
}

/// Pricing info for a model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogCost {
    #[serde(default)]
    pub input: Option<f64>,
    #[serde(default)]
    pub output: Option<f64>,
}

/// Fetch and parse the model catalog. A non-2xx response surfaces as
/// [`CatalogFetchError`] carrying the HTTP status (TS `fetchCatalog` parity —
/// reqwest's `error_for_status` drops the status code, so it is checked
/// manually).
pub async fn fetch_catalog(url: &str) -> anyhow::Result<HashMap<String, CatalogProvider>> {
    let response = reqwest::get(url).await?;
    let status = response.status();
    if !status.is_success() {
        return Err(CatalogFetchError {
            status: status.as_u16(),
        }
        .into());
    }
    let catalog: HashMap<String, CatalogProvider> = response.json().await?;
    Ok(catalog)
}

// ── Normalization (kosong `catalog.ts` parity) ─────────────────────────────

/// A normalized, importable model: identity plus its capability summary.
/// Built from a raw models.dev entry by [`catalog_model_to_capability`].
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedModel {
    pub id: String,
    pub name: Option<String>,
    pub max_output_size: Option<u64>,
    pub reasoning_key: Option<String>,
    /// Declared thinking-effort levels from `reasoning_options`.
    pub support_efforts: Option<Vec<String>>,
    /// The effort value encoding "thinking off" (`'none'`), when declared.
    pub off_effort: Option<String>,
    /// True when the model declares effort levels but cannot turn thinking
    /// off (no `toggle` and no `'none'` value).
    pub always_thinking: bool,
    /// Per-model protocol override from the entry's `provider` field.
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub capability: ModelCapability,
}

/// Model capability summary (kosong `ModelCapability` parity).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelCapability {
    pub image_in: bool,
    pub video_in: bool,
    pub audio_in: bool,
    pub thinking: bool,
    pub tool_use: bool,
    pub max_context_tokens: u64,
    pub max_input_tokens: Option<u64>,
    pub dynamically_loaded_tools: bool,
}

/// Whether the string carries an embedding marker (kosong
/// `hasEmbeddingMarker` parity — "embedding" or a word-boundary "embed").
fn has_embedding_marker(value: Option<&str>) -> bool {
    let Some(v) = value else { return false };
    let lower = v.to_lowercase();
    if lower.contains("embedding") {
        return true;
    }
    lower
        .split(['-', '_', '/'])
        .any(|part| part == "embed")
}

/// A chat model usable for new imports: not deprecated/alpha, no embedding
/// marker, and (when declared) text output (kosong `isUsableChatModel`).
fn is_usable_chat_model(entry: &Value) -> bool {
    let status = entry.get("status").and_then(|s| s.as_str()).unwrap_or("");
    if status == "deprecated" || status == "alpha" {
        return false;
    }
    let outputs = entry
        .pointer("/modalities/output")
        .and_then(|m| m.as_array());
    if let Some(outputs) = outputs {
        if !outputs.iter().any(|o| o.as_str() == Some("text")) {
            return false;
        }
    }
    !has_embedding_marker(entry.get("family").and_then(|f| f.as_str()))
        && !has_embedding_marker(entry.get("id").and_then(|i| i.as_str()))
        && !has_embedding_marker(entry.get("name").and_then(|n| n.as_str()))
}

/// Parse a `reasoning_options` list: effort levels, the `'none'` pseudo-level
/// (encoded as the string `'none'` or JSON null), and the `toggle` boolean
/// form (kosong `catalogThinkingOptions` parity).
struct ThinkingOptions {
    efforts: Option<Vec<String>>,
    off_effort: Option<String>,
    has_toggle: bool,
    always_thinking: bool,
}

fn catalog_thinking_options(options: Option<&Value>) -> ThinkingOptions {
    let Some(options) = options.and_then(|o| o.as_array()) else {
        return ThinkingOptions {
            efforts: None,
            off_effort: None,
            has_toggle: false,
            always_thinking: false,
        };
    };
    let mut efforts: Option<Vec<String>> = None;
    let mut off_effort: Option<String> = None;
    let mut has_toggle = false;
    for option in options {
        let Some(ty) = option.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        if ty == "toggle" {
            has_toggle = true;
            continue;
        }
        if ty != "effort" {
            continue;
        }
        let Some(values) = option.get("values").and_then(|v| v.as_array()) else {
            continue;
        };
        // models.dev writes the disable tier as 'none' or JSON null.
        let has_null_tier = values.iter().any(|v| v.is_null());
        let levels: Vec<String> = values
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let off = levels.iter().find(|v| v.to_lowercase() == "none").cloned();
        if off.is_some() {
            off_effort = off;
        } else if has_null_tier {
            off_effort = Some("none".to_string());
        }
        let selectable: Vec<String> = levels
            .into_iter()
            .filter(|v| v.to_lowercase() != "none")
            .collect();
        if !selectable.is_empty() {
            efforts = Some(selectable);
        }
    }
    let always_thinking = efforts.is_some() && off_effort.is_none() && !has_toggle;
    ThinkingOptions {
        efforts,
        off_effort,
        has_toggle,
        always_thinking,
    }
}

/// The reasoning-key override from an `interleaved` object (kosong
/// `catalogReasoningKey` parity — the object form carries the field name).
fn catalog_reasoning_key(interleaved: Option<&Value>) -> Option<String> {
    let field = interleaved?
        .get("field")
        .and_then(|f| f.as_str())?
        .trim();
    (!field.is_empty()).then(|| field.to_string())
}

/// Normalize one raw models.dev model entry; `None` when the entry is not an
/// importable chat model (kosong `catalogModelToCapability` parity).
pub fn catalog_model_to_capability(model: &Value) -> Option<NormalizedModel> {
    let id = model.get("id").and_then(|i| i.as_str())?;
    if id.is_empty() {
        return None;
    }
    let context = model.pointer("/limit/context").and_then(|c| c.as_u64())?;
    if context == 0 {
        return None;
    }
    if !is_usable_chat_model(model) {
        return None;
    }
    let inputs: Vec<&str> = model
        .pointer("/modalities/input")
        .and_then(|m| m.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    let output = model.pointer("/limit/output").and_then(|o| o.as_u64());
    let thinking = catalog_thinking_options(model.get("reasoning_options"));
    // `limit.input` is the true prompt cap when declared; tracked separately
    // from the total window so prompt-budget checks use the cap.
    let input = model.pointer("/limit/input").and_then(|i| i.as_u64());
    let max_input_tokens = match input {
        Some(i) if i > 0 => Some(i.min(context)),
        _ => None,
    };
    let reasoning = model.get("reasoning").and_then(|r| r.as_bool()).unwrap_or(false);
    let provider_override = model.get("provider");
    let has_efforts = thinking.efforts.is_some();
    Some(NormalizedModel {
        id: id.to_string(),
        name: model
            .get("name")
            .and_then(|n| n.as_str())
            .filter(|n| !n.is_empty())
            .map(str::to_string),
        max_output_size: output.filter(|o| *o > 0),
        reasoning_key: catalog_reasoning_key(model.get("interleaved")),
        support_efforts: thinking.efforts,
        off_effort: thinking.off_effort,
        always_thinking: thinking.always_thinking,
        protocol: provider_override
            .and_then(|p| p.get("npm"))
            .and_then(|n| n.as_str())
            .filter(|n| *n == "anthropic")
            .map(str::to_string),
        base_url: provider_override
            .and_then(|p| p.get("api"))
            .and_then(|a| a.as_str())
            .map(str::to_string),
        capability: ModelCapability {
            image_in: inputs.contains(&"image"),
            video_in: inputs.contains(&"video"),
            audio_in: inputs.contains(&"audio"),
            // Declaring effort levels (or a toggle) implies thinking support
            // even when the `reasoning` boolean is absent.
            thinking: reasoning || has_efforts || thinking.has_toggle,
            tool_use: model
                .get("tool_call")
                .and_then(|t| t.as_bool())
                .unwrap_or(true),
            max_context_tokens: context,
            max_input_tokens,
            dynamically_loaded_tools: model
                .get("dynamically_loaded_tools")
                .and_then(|d| d.as_bool())
                .unwrap_or(false),
        },
    })
}

/// The valid, normalized models of a catalog provider (kosong
/// `catalogProviderModels` parity). The raw entry fields ride in each
/// model's flattened `raw` map, so normalization sees the full models.dev
/// shape.
pub fn catalog_provider_models(provider: &CatalogProvider) -> Vec<NormalizedModel> {
    provider
        .models
        .values()
        .filter_map(|entry| serde_json::to_value(entry).ok())
        .filter_map(|v| catalog_model_to_capability(&v))
        .collect()
}

/// Build the engine-config model alias JSON for a normalized model (node-sdk
/// `catalogModelToAlias` parity, written in the engine's on-disk shape:
/// `max_tokens` carries the context window; capabilities ride as an array
/// string list the engine understands).
pub fn catalog_model_to_alias(provider_id: &str, model: &NormalizedModel) -> Value {
    let mut alias = serde_json::Map::new();
    alias.insert("provider".into(), Value::String(provider_id.to_string()));
    alias.insert("model".into(), Value::String(model.id.clone()));
    if model.capability.max_context_tokens > 0 {
        alias.insert(
            "max_tokens".into(),
            Value::from(model.capability.max_context_tokens),
        );
    }
    if let Some(name) = &model.name {
        alias.insert("displayName".into(), Value::String(name.clone()));
    }
    if let Some(key) = &model.reasoning_key {
        alias.insert("reasoningKey".into(), Value::String(key.clone()));
    }
    if let Some(efforts) = &model.support_efforts {
        alias.insert(
            "supportEfforts".into(),
            Value::Array(efforts.iter().map(|e| Value::String(e.clone())).collect()),
        );
    }
    if let Some(off) = &model.off_effort {
        alias.insert("offEffort".into(), Value::String(off.clone()));
    }
    if let Some(protocol) = &model.protocol {
        alias.insert("protocol".into(), Value::String(protocol.clone()));
    }
    if let Some(base_url) = &model.base_url {
        alias.insert("baseUrl".into(), Value::String(base_url.clone()));
    }
    let mut caps: Vec<String> = Vec::new();
    if model.capability.image_in {
        caps.push("image_in".into());
    }
    if model.capability.video_in {
        caps.push("video_in".into());
    }
    if model.capability.audio_in {
        caps.push("audio_in".into());
    }
    if model.capability.thinking {
        caps.push(if model.always_thinking {
            "always_thinking".into()
        } else {
            "thinking".into()
        });
    }
    if model.capability.tool_use {
        caps.push("tool_use".into());
    }
    if model.capability.dynamically_loaded_tools {
        caps.push("dynamically_loaded_tools".into());
    }
    if !caps.is_empty() {
        alias.insert(
            "capabilities".into(),
            Value::Array(caps.into_iter().map(Value::String).collect()),
        );
    }
    Value::Object(alias)
}

/// Write a catalog-selected provider and its model aliases into a config
/// JSON, marking the selected model default (node-sdk `applyCatalogProvider`
/// parity, engine on-disk shape). The same-provider cleanup removes stale
/// aliases whose key starts with `<providerId>/`. Returns the default model
/// key.
// 8 positional args mirror the node-sdk `applyCatalogProvider` options shape.
#[allow(clippy::too_many_arguments)]
pub fn apply_catalog_provider(
    config: &mut Value,
    provider_id: &str,
    wire: &str,
    base_url: Option<&str>,
    api_key: Option<&str>,
    models: &[NormalizedModel],
    selected_model_id: &str,
    thinking: bool,
) -> String {
    let mut provider = serde_json::Map::new();
    provider.insert("type".into(), Value::String(wire.to_string()));
    if let Some(base_url) = base_url.filter(|u| !u.is_empty()) {
        provider.insert("baseUrl".into(), Value::String(base_url.to_string()));
    }
    if let Some(api_key) = api_key.filter(|k| !k.is_empty()) {
        provider.insert("apiKey".into(), Value::String(api_key.to_string()));
    }
    config
        .get_mut("providers")
        .and_then(|p| p.as_object_mut())
        .map(|providers| providers.insert(provider_id.into(), Value::Object(provider)));

    // Drop stale aliases for this provider, then write the fresh ones.
    let prefix = format!("{provider_id}/");
    if let Some(models_map) = config.get_mut("models").and_then(|m| m.as_object_mut()) {
        models_map.retain(|key, _| !key.starts_with(&prefix));
        for model in models {
            let key = format!("{prefix}{}", model.id);
            models_map.insert(key, catalog_model_to_alias(provider_id, model));
        }
    } else {
        let mut models_map = serde_json::Map::new();
        for model in models {
            let key = format!("{prefix}{}", model.id);
            models_map.insert(key, catalog_model_to_alias(provider_id, model));
        }
        config
            .as_object_mut()
            .map(|o| o.insert("models".into(), Value::Object(models_map)));
    }

    let default_model = format!("{prefix}{selected_model_id}");
    if let Some(obj) = config.as_object_mut() {
        obj.insert("defaultModel".into(), Value::String(default_model.clone()));
        let thinking_config = obj
            .get("thinking")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let mut thinking_map = thinking_config
            .as_object()
            .cloned()
            .unwrap_or_default();
        thinking_map.insert("enabled".into(), Value::Bool(thinking));
        obj.insert("thinking".into(), Value::Object(thinking_map));
    }
    default_model
}

// ── Import resolution (kosong `resolveCatalogImport` parity) ────────────────

/// Why a catalog import cannot proceed at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogImportInvalidReason {
    /// `type` is present but names a protocol this version does not know.
    UnknownExplicitType,
    /// SDK known to be non-OpenAI proprietary (Amazon Bedrock, Cohere).
    ProprietarySdk,
    /// A base URL was supplied but is blank.
    EmptyBaseUrl,
    /// The endpoint contains an env placeholder (`${VAR}`) the config
    /// cannot express.
    PlaceholderBaseUrl,
}

/// The wire types this client recognizes (kosong `KNOWN_WIRE_TYPES`).
const KNOWN_WIRE_TYPES: &[&str] = &[
    "anthropic",
    "openai",
    "kimi",
    "google-genai",
    "openai_responses",
    "vertexai",
    "astron",
];

fn is_wire_type(value: &str) -> bool {
    KNOWN_WIRE_TYPES.contains(&value)
}

/// Infer the wire from `npm`/`id` heuristics (kosong
/// `inferDeclaredWireType` parity).
fn infer_declared_wire_type(provider: &CatalogProvider) -> Option<&'static str> {
    if let Some(ty) = provider.r#type.as_deref() {
        if is_wire_type(ty) {
            return Some(match ty {
                "anthropic" => "anthropic",
                "openai" => "openai",
                "kimi" => "kimi",
                "google-genai" => "google-genai",
                "openai_responses" => "openai_responses",
                "vertexai" => "vertexai",
                "astron" => "astron",
                _ => unreachable!(),
            });
        }
    }
    let npm = provider.npm.as_deref().unwrap_or("").to_lowercase();
    let id = provider.id.to_lowercase();
    if npm.contains("anthropic") || id.contains("anthropic") || id.contains("claude") {
        return Some("anthropic");
    }
    if id.contains("vertex") {
        return Some("vertexai");
    }
    if npm.contains("google") || id.contains("google") || id.contains("gemini") {
        return Some("google-genai");
    }
    if npm.contains("openai") || id.contains("openai") {
        return Some("openai");
    }
    None
}

/// The wire of a catalog provider entry; `None` when not importable: an
/// explicit type this client does not know, or a proprietary non-OpenAI SDK
/// (Bedrock, Cohere) (kosong `resolveCatalogWire` parity).
fn resolve_catalog_wire(provider: &CatalogProvider) -> Option<&'static str> {
    if let Some(ty) = provider.r#type.as_deref() {
        return is_wire_type(ty).then(|| match ty {
            "anthropic" => "anthropic",
            "openai" => "openai",
            "kimi" => "kimi",
            "google-genai" => "google-genai",
            "openai_responses" => "openai_responses",
            "vertexai" => "vertexai",
            "astron" => "astron",
            _ => unreachable!(),
        });
    }
    if let Some(declared) = infer_declared_wire_type(provider) {
        return Some(declared);
    }
    let npm = provider.npm.as_deref().unwrap_or("").to_lowercase();
    if npm.contains("amazon-bedrock") || npm.contains("cohere") {
        return None;
    }
    Some("openai")
}

/// Adapt a base URL to the wire's SDK convention: the Anthropic SDK appends
/// `/v1/messages` itself, so a trailing `/v1` is stripped (kosong
/// `adaptBaseUrlForWire` parity); other wires pass through unchanged.
pub fn adapt_base_url_for_wire(base_url: &str, wire: &str) -> String {
    if wire == "anthropic" {
        // Strip one trailing `/v1` (with optional trailing slash).
        let trimmed = base_url.trim_end_matches('/');
        if let Some(stripped) = trimmed.strip_suffix("/v1") {
            return stripped.to_string();
        }
        base_url.to_string()
    } else {
        base_url.to_string()
    }
}

/// The base URL to store for a catalog provider, adapting the catalog `api`
/// to the wire's SDK convention; `None` when the entry declares no usable
/// endpoint (missing, blank, or an env placeholder) (kosong
/// `catalogBaseUrl` parity).
pub fn catalog_base_url(provider: &CatalogProvider, wire: &str) -> Option<String> {
    let api = provider.api.as_deref()?;
    if api.is_empty() || api.contains("${") {
        return None;
    }
    Some(adapt_base_url_for_wire(api, wire))
}

/// True when a missing catalog endpoint cannot fall back to a built-in
/// default (kosong `catalogEndpointRequired` parity): an explicitly declared
/// endpoint the config cannot express always requires asking; without a
/// declaration, the wire's default endpoint only belongs to the vendor's
/// official SDK package (`@ai-sdk/openai` / `@ai-sdk/anthropic`); vertex /
/// google wires resolve from env coordinates and official SDKs, so they
/// never need the prompt.
fn catalog_endpoint_required(provider: &CatalogProvider, wire: &str) -> bool {
    if provider.api.as_deref().is_some_and(|a| !a.is_empty()) {
        return true;
    }
    let npm = provider.npm.as_deref().unwrap_or("").to_lowercase();
    match wire {
        "openai" | "openai_responses" => npm != "@ai-sdk/openai",
        "anthropic" => npm != "@ai-sdk/anthropic",
        _ => false,
    }
}

/// The outcome of resolving a catalog provider for import — the single
/// decision point for "which wire, which endpoint, or exactly why not"
/// (kosong `resolveCatalogImport` parity).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogImportResolution {
    pub kind: CatalogImportKind,
    pub wire: Option<String>,
    /// The protocol came from the OpenAI-compatible fallback.
    pub guessed: bool,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogImportKind {
    Ok,
    NeedsBaseUrl,
    Invalid(CatalogImportInvalidReason),
}

/// Resolve a catalog provider entry into an import decision: wire
/// resolution (explicit `type` authoritative, `npm`/`id` heuristics
/// otherwise, OpenAI-compatible fallback with `guessed: true`, proprietary
/// SDKs refused) and endpoint resolution (user URL wins after trim, then the
/// catalog `api`, then `needs-base-url` unless the wire's official-SDK
/// default endpoint applies).
pub fn resolve_catalog_import(
    provider: &CatalogProvider,
    user_base_url: Option<&str>,
) -> CatalogImportResolution {
    let Some(wire) = resolve_catalog_wire(provider) else {
        let reason = if provider.r#type.as_deref().is_some_and(|t| !t.is_empty()) {
            CatalogImportInvalidReason::UnknownExplicitType
        } else {
            CatalogImportInvalidReason::ProprietarySdk
        };
        return CatalogImportResolution {
            kind: CatalogImportKind::Invalid(reason),
            wire: None,
            guessed: false,
            base_url: None,
        };
    };
    let wire = wire.to_string();
    let guessed = infer_declared_wire_type(provider).is_none();

    if let Some(user) = user_base_url {
        let trimmed = user.trim();
        if trimmed.is_empty() {
            return CatalogImportResolution {
                kind: CatalogImportKind::Invalid(CatalogImportInvalidReason::EmptyBaseUrl),
                wire: Some(wire.clone()),
                guessed,
                base_url: None,
            };
        }
        if trimmed.contains("${") {
            return CatalogImportResolution {
                kind: CatalogImportKind::Invalid(CatalogImportInvalidReason::PlaceholderBaseUrl),
                wire: Some(wire.clone()),
                guessed,
                base_url: None,
            };
        }
        let base_url = adapt_base_url_for_wire(trimmed, &wire);
        return CatalogImportResolution {
            kind: CatalogImportKind::Ok,
            wire: Some(wire),
            guessed,
            base_url: Some(base_url),
        };
    }

    if let Some(base_url) = catalog_base_url(provider, &wire) {
        return CatalogImportResolution {
            kind: CatalogImportKind::Ok,
            wire: Some(wire),
            guessed,
            base_url: Some(base_url),
        };
    }
    if catalog_endpoint_required(provider, &wire) {
        return CatalogImportResolution {
            kind: CatalogImportKind::NeedsBaseUrl,
            wire: Some(wire),
            guessed,
            base_url: None,
        };
    }
    CatalogImportResolution {
        kind: CatalogImportKind::Ok,
        wire: Some(wire),
        guessed,
        base_url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_provider_fixture() {
        let json = r#"{
            "acme": {
                "id": "acme",
                "env": ["ACME_API_KEY"],
                "api": "https://acme.example/v1",
                "name": "Acme",
                "models": {
                    "acme-1": {
                        "id": "acme-1",
                        "name": "Acme 1",
                        "reasoning": true,
                        "context_length": 128000,
                        "cost": { "input": 0.5, "output": 1.5 }
                    }
                }
            }
        }"#;
        let catalog: HashMap<String, CatalogProvider> = serde_json::from_str(json).unwrap();
        let provider = &catalog["acme"];
        assert_eq!(provider.name, "Acme");
        assert_eq!(provider.env, vec!["ACME_API_KEY"]);
        let model = &provider.models["acme-1"];
        assert_eq!(model.id, "acme-1");
        assert_eq!(model.reasoning, Some(true));
        assert_eq!(model.context_length, Some(128000));
        assert_eq!(model.cost.as_ref().unwrap().input, Some(0.5));
    }

    #[tokio::test]
    async fn fetch_live_catalog() {
        // Network-dependent: the model directory must be reachable. Skipped
        // when the fetch fails (offline CI / revocation-blocked networks).
        match fetch_catalog(DEFAULT_CATALOG_URL).await {
            Ok(catalog) => {
                assert!(catalog.len() >= 50, "catalog has providers: {}", catalog.len());
                assert!(
                    catalog.values().any(|p| !p.models.is_empty()),
                    "at least one provider lists models"
                );
            }
            Err(e) => eprintln!("skipping live catalog test (network): {e}"),
        }
    }

    /// Spawn a one-shot HTTP server answering with `status`/`body`, returning
    /// its URL. The request is fully read before responding and the stream is
    /// drained after shutdown — dropping a TcpStream with unread data sends
    /// RST on Windows, which surfaces in the client as "error sending
    /// request" (same pattern as kimi-cli's `provider_catalog_add` tests).
    fn fixture_server(status: u16, body: &str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("fixture bind");
        let addr = listener.local_addr().expect("addr");
        let body = body.to_string();
        std::thread::spawn(move || {
            if let Ok((mut stream, _peer)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let reason = reqwest::StatusCode::from_u16(status)
                    .ok()
                    .and_then(|s| s.canonical_reason())
                    .unwrap_or("OK");
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let mut drain = [0u8; 1024];
                let _ = stream.read(&mut drain);
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn fetch_catalog_http_error_carries_status() {
        for status in [404u16, 500u16] {
            let url = fixture_server(status, "not found");
            let error = fetch_catalog(&url).await.expect_err("non-2xx must fail");
            let catalog_error = error
                .downcast_ref::<CatalogFetchError>()
                .expect("CatalogFetchError");
            assert_eq!(catalog_error.status, status);
            assert_eq!(
                catalog_error.to_string(),
                format!("Failed to fetch catalog (HTTP {status}).")
            );
        }
    }

    #[tokio::test]
    async fn fetch_catalog_ok_parses_providers() {
        let url = fixture_server(200, r#"{"acme": {"id": "acme", "name": "Acme"}}"#);
        let catalog = fetch_catalog(&url).await.expect("catalog");
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog["acme"].name, "Acme");
    }

    /// A models.dev-style model entry carrying the full raw shape.
    fn model_fixture(id: &str, extra: &Value) -> Value {
        serde_json::json!({
            "id": id,
            "name": id,
            "family": "chat",
            "status": "active",
            "limit": { "context": 128000, "input": 100000, "output": 8192 },
            "tool_call": true,
            "modalities": { "input": ["text", "image"], "output": ["text"] },
        })
        .pipe(|mut v: Value| {
            if let Some(obj) = v.as_object_mut() {
                for (k, val) in extra.as_object().unwrap_or(&serde_json::Map::new()) {
                    obj.insert(k.clone(), val.clone());
                }
            }
            v
        })
    }

    trait JsonPipe {
        fn pipe(self, f: impl FnOnce(Value) -> Value) -> Value;
    }
    impl JsonPipe for Value {
        fn pipe(self, f: impl FnOnce(Value) -> Value) -> Value {
            f(self)
        }
    }

    #[test]
    fn normalizes_usable_chat_model() {
        let entry = model_fixture("acme-1", &serde_json::json!({
            "reasoning": true,
            "reasoning_options": [{ "type": "effort", "values": ["low", "high", "none"] }],
            "dynamically_loaded_tools": true,
        }));
        let model = catalog_model_to_capability(&entry).expect("usable model");
        assert_eq!(model.id, "acme-1");
        assert_eq!(model.capability.max_context_tokens, 128000);
        assert_eq!(model.capability.max_input_tokens, Some(100000));
        assert!(model.capability.image_in);
        assert!(!model.capability.video_in);
        assert!(model.capability.thinking);
        assert!(model.capability.tool_use);
        assert!(model.capability.dynamically_loaded_tools);
        assert_eq!(model.support_efforts, Some(vec!["low".to_string(), "high".to_string()]));
        assert_eq!(model.off_effort, Some("none".to_string()));
        assert!(!model.always_thinking);
    }

    #[test]
    fn normalizes_always_thinking_without_off_tier() {
        // Effort levels with neither toggle nor 'none' → always thinking.
        let entry = model_fixture("acme-2", &serde_json::json!({
            "reasoning_options": [{ "type": "effort", "values": ["low", "high"] }],
        }));
        let model = catalog_model_to_capability(&entry).expect("usable");
        assert!(model.always_thinking);
        assert_eq!(model.off_effort, None);
        assert_eq!(model.support_efforts, Some(vec!["low".to_string(), "high".to_string()]));
    }

    #[test]
    fn rejects_unusable_and_embedding_models() {
        // Deprecated status → not importable.
        let deprecated = model_fixture("old", &serde_json::json!({ "status": "deprecated" }));
        assert!(catalog_model_to_capability(&deprecated).is_none());
        // Embedding family → not a chat model.
        let embedding = model_fixture("vec", &serde_json::json!({ "family": "embedding" }));
        assert!(catalog_model_to_capability(&embedding).is_none());
        // Non-text output → not usable.
        let audio_only = serde_json::json!({
            "id": "tts",
            "limit": { "context": 32000 },
            "modalities": { "output": ["audio"] },
        });
        assert!(catalog_model_to_capability(&audio_only).is_none());
        // Missing context limit → not importable.
        let no_limit = serde_json::json!({ "id": "x", "name": "x" });
        assert!(catalog_model_to_capability(&no_limit).is_none());
    }

    #[test]
    fn alias_uses_engine_on_disk_shape() {
        let entry = model_fixture("acme-1", &serde_json::json!({
            "reasoning": true,
            "reasoning_options": [{ "type": "effort", "values": ["low", "high", "none"] }],
        }));
        let model = catalog_model_to_capability(&entry).expect("usable");
        let alias = catalog_model_to_alias("acme", &model);
        assert_eq!(alias["provider"], "acme");
        assert_eq!(alias["model"], "acme-1");
        assert_eq!(alias["max_tokens"], 128000);
        assert_eq!(alias["capabilities"][0], "image_in");
        assert!(alias["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == "thinking"));
        assert_eq!(alias["supportEfforts"][1], "high");
    }

    #[test]
    fn apply_catalog_provider_writes_full_config() {
        let model = catalog_model_to_capability(
            &model_fixture("acme-1", &serde_json::json!({ "reasoning": true })),
        )
        .expect("usable");
        let mut config = serde_json::json!({
            "providers": {},
            "models": { "acme/old-model": { "provider": "acme", "model": "old" } },
            "thinking": { "enabled": false },
        });
        let default = apply_catalog_provider(
            &mut config,
            "acme",
            "openai",
            Some("https://acme.example/v1"),
            Some("sk-test"),
            &[model],
            "acme-1",
            true,
        );
        assert_eq!(default, "acme/acme-1");
        assert_eq!(config["providers"]["acme"]["type"], "openai");
        assert_eq!(config["providers"]["acme"]["apiKey"], "sk-test");
        assert_eq!(config["providers"]["acme"]["baseUrl"], "https://acme.example/v1");
        // Stale alias for the same provider is dropped; the fresh one is set.
        assert!(config["models"].get("acme/old-model").is_none());
        assert_eq!(config["models"]["acme/acme-1"]["model"], "acme-1");
        assert_eq!(config["defaultModel"], "acme/acme-1");
        assert_eq!(config["thinking"]["enabled"], true);
    }

    #[test]
    fn provider_models_normalizes_all_entries() {
        let provider = CatalogProvider {
            id: "acme".into(),
            env: Vec::new(),
            npm: None,
            api: Some("https://acme.example/v1".into()),
            name: "Acme".into(),
            doc: None,
            r#type: None,
            models: [
                (
                    "acme-1".into(),
                    serde_json::from_value(model_fixture(
                        "acme-1",
                        &serde_json::json!({ "reasoning": true }),
                    ))
                    .expect("model"),
                ),
                (
                    "old".into(),
                    serde_json::from_value(model_fixture(
                        "old",
                        &serde_json::json!({ "status": "deprecated" }),
                    ))
                    .expect("model"),
                ),
            ]
            .into_iter()
            .collect(),
        };
        let models = catalog_provider_models(&provider);
        assert_eq!(models.len(), 1, "deprecated model is filtered out");
        assert_eq!(models[0].id, "acme-1");
    }

    fn provider_fixture(
        id: &str,
        npm: Option<&str>,
        api: Option<&str>,
        ty: Option<&str>,
    ) -> CatalogProvider {
        CatalogProvider {
            id: id.into(),
            env: Vec::new(),
            npm: npm.map(str::to_string),
            api: api.map(str::to_string),
            name: id.into(),
            doc: None,
            r#type: ty.map(str::to_string),
            models: HashMap::new(),
        }
    }

    #[test]
    fn resolves_wire_from_type_npm_and_fallback() {
        // Explicit known type wins the wire decision, but with no endpoint
        // and a non-official npm the import still asks for a base URL.
        let p = provider_fixture("x", None, None, Some("anthropic"));
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.kind, CatalogImportKind::NeedsBaseUrl);
        assert_eq!(r.wire.as_deref(), Some("anthropic"));
        assert!(!r.guessed);
        // With an endpoint declared, the explicit type resolves fully.
        let p = provider_fixture("x", None, Some("https://acme.example"), Some("anthropic"));
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.kind, CatalogImportKind::Ok);
        assert_eq!(r.wire.as_deref(), Some("anthropic"));
        // Unknown explicit type is refused.
        let p = provider_fixture("x", None, None, Some("weird-protocol"));
        let r = resolve_catalog_import(&p, None);
        assert_eq!(
            r.kind,
            CatalogImportKind::Invalid(CatalogImportInvalidReason::UnknownExplicitType)
        );
        // npm heuristics infer the wire.
        let p = provider_fixture("x", Some("@ai-sdk/anthropic"), None, None);
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.wire.as_deref(), Some("anthropic"));
        // Proprietary SDKs (bedrock) are refused.
        let p = provider_fixture("x", Some("amazon-bedrock"), None, None);
        let r = resolve_catalog_import(&p, None);
        assert_eq!(
            r.kind,
            CatalogImportKind::Invalid(CatalogImportInvalidReason::ProprietarySdk)
        );
        // Unknown npm falls back to OpenAI-compatible (guessed) — and asks
        // for a base URL (the fallback default would point at the wrong
        // host for a non-official SDK).
        let p = provider_fixture("mystery", None, None, None);
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.kind, CatalogImportKind::NeedsBaseUrl);
        assert_eq!(r.wire.as_deref(), Some("openai"));
        assert!(r.guessed);
    }

    #[test]
    fn resolves_endpoint_from_user_then_catalog() {
        // User URL wins and is adapted to the wire.
        let p = provider_fixture("x", None, Some("https://acme.example/v1"), None);
        let r = resolve_catalog_import(&p, Some(" https://user.example/v1/ "));
        assert_eq!(r.kind, CatalogImportKind::Ok);
        assert_eq!(r.base_url.as_deref(), Some("https://user.example/v1/"));
        // Catalog api applies otherwise.
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.base_url.as_deref(), Some("https://acme.example/v1"));
        // Anthropic wire strips the trailing /v1 (SDK appends it itself).
        let p = provider_fixture("x", None, Some("https://acme.example/v1"), Some("anthropic"));
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.base_url.as_deref(), Some("https://acme.example"));
        // Blank user URL is invalid; placeholder URLs are refused.
        let r = resolve_catalog_import(&p, Some("  "));
        assert_eq!(
            r.kind,
            CatalogImportKind::Invalid(CatalogImportInvalidReason::EmptyBaseUrl)
        );
        let r = resolve_catalog_import(&p, Some("https://acme.example/${REGION}"));
        assert_eq!(
            r.kind,
            CatalogImportKind::Invalid(CatalogImportInvalidReason::PlaceholderBaseUrl)
        );
    }

    #[test]
    fn endpoint_required_asks_for_unknown_npm_only() {
        // No api, unknown npm → needs-base-url (default endpoint would point
        // at the wrong host).
        let p = provider_fixture("x", Some("acme-sdk"), None, None);
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.kind, CatalogImportKind::NeedsBaseUrl);
        // Official-SDK npm resolves without asking (built-in default).
        let p = provider_fixture("x", Some("@ai-sdk/openai"), None, None);
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.kind, CatalogImportKind::Ok);
        assert_eq!(r.base_url, None);
        // Declared api with a placeholder → asks for a URL.
        let p = provider_fixture("x", None, Some("https://acme.example/${KEY}"), None);
        let r = resolve_catalog_import(&p, None);
        assert_eq!(r.kind, CatalogImportKind::NeedsBaseUrl);
    }
}
