//! Native HTTP LLM resolution from the on-disk config.
//!
//! Port of `apps/kimi-code/src/cli/rust-engine.ts` (`extractNativeLlm` /
//! `resolveNativeLlm`, 2026-07-31) so the standalone `kimi-agent-cli` binary
//! can self-serve its LLM endpoint from `config.toml` + `KIMI_MODEL_*` env
//! without a host round-trip.
//!
//! Resolution order:
//!   1. `agent.nativeLlmProvider` names a provider explicitly — its endpoint
//!      is used unconditionally (modulo protocol/credential eligibility).
//!   2. Otherwise the session's `defaultModel` alias's provider is derived —
//!      skipping providers carrying an `env` block (host-side request
//!      semantics the native transport does not replicate).
//!   3. `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` synthesize a static `kimi`
//!      provider, the last-resort for a fully env-driven setup.

use std::collections::HashMap;

use crate::config::types::{KimiConfig, ProviderType};
use crate::rpc::types::NativeLlmConfig;

/// Gemini's well-known public endpoint. A missing `baseUrl` means "the
/// official API", unlike the other protocols where it must be explicit.
pub const GOOGLE_DEFAULT_BASE_URL: &str =
    "https://generativelanguage.googleapis.com/v1beta";

/// Map a provider type to the wire protocol the native transport speaks.
/// `None` means the type is not supported by the native transport.
fn protocol_for_type(provider_type: Option<&ProviderType>) -> Option<&'static str> {
    match provider_type {
        Some(ProviderType::Anthropic) => Some("anthropic"),
        Some(ProviderType::OpenAI) | Some(ProviderType::Kimi) => Some("openai"),
        Some(ProviderType::GoogleGenAI) => Some("google"),
        _ => None,
    }
}

/// Resolve the model for a provider: the invoking alias first (auto-
/// derivation), then the provider default, then any alias pointing at it.
///
/// The alias fallback iterates in deterministic (key-sorted) order — the TS
/// original relies on `Object.entries` insertion order, which Rust's HashMap
/// does not preserve.
fn resolve_model(
    config: &KimiConfig,
    name: &str,
    alias_model: Option<&str>,
) -> Option<String> {
    if let Some(m) = alias_model {
        return Some(m.to_string());
    }
    let provider = config.providers.as_ref()?.get(name)?;
    if let Some(m) = provider.model.as_deref() {
        return Some(m.to_string());
    }
    if let Some(aliases) = config.model_aliases.as_ref() {
        let mut entries: Vec<_> = aliases.iter().collect();
        entries.sort_by(|(a, _), (b, _)| a.cmp(b));
        if let Some((_, alias)) = entries.iter().find(|(_, a)| a.provider == name) {
            return Some(alias.model.clone());
        }
    }
    None
}

/// Resolve a named provider into a `NativeLlmConfig`. Faithful to the TS
/// `resolveNativeLlm`: static `baseUrl` + `apiKey` are required, and the
/// provider type must be one of anthropic / openai / kimi / google-genai.
pub fn resolve_native_llm(
    config: &KimiConfig,
    name: &str,
    alias_model: Option<&str>,
) -> Option<NativeLlmConfig> {
    let provider = config.providers.as_ref()?.get(name)?;
    let protocol = protocol_for_type(provider.provider.as_ref())?;
    let base_url = provider
        .base_url
        .clone()
        .or_else(|| (protocol == "google").then(|| GOOGLE_DEFAULT_BASE_URL.to_string()))?;
    let api_key = provider.api_key.clone()?;
    let model = resolve_model(config, name, alias_model)?;
    Some(NativeLlmConfig {
        protocol: protocol.to_string(),
        base_url,
        api_key,
        model,
        max_tokens: provider.max_tokens,
        reasoning_effort: None,
        custom_headers: provider.custom_headers.clone().unwrap_or_default(),
    })
}

/// Full-resolution entry point, mirroring the TS `extractNativeLlm`.
///
/// - `agent.nativeLlmProvider` set → resolve it explicitly.
/// - else `defaultModel` → its alias's provider (skipping `env`-carrying
///   providers, which need host-side request semantics).
/// - else env-synthesized `kimi` provider from `KIMI_MODEL_NAME` /
///   `KIMI_MODEL_API_KEY` / `KIMI_MODEL_BASE_URL`.
pub fn extract_native_llm(config: &KimiConfig) -> Option<NativeLlmConfig> {
    if let Some(explicit) = config
        .agent
        .as_ref()
        .and_then(|a| a.native_llm_provider.as_deref())
        .filter(|s| !s.is_empty())
    {
        return resolve_native_llm(config, explicit, None);
    }

    // Derive from the session default model.
    let alias_id = config.default_model.as_deref()?;
    let alias = config.model_aliases.as_ref()?.get(alias_id)?;
    let derived = alias.provider.clone();
    // A provider carrying an `env` block (proxies, runtime environment)
    // relies on host-side request semantics the native transport does not
    // replicate; auto-derivation skips it. Naming it explicitly still opts in.
    if config
        .providers
        .as_ref()
        .and_then(|p| p.get(&derived))
        .is_some_and(|p| p.env.is_some())
    {
        return None;
    }
    resolve_native_llm(config, &derived, Some(&alias.model))
}

/// Synthesize a static `kimi` provider from the `KIMI_MODEL_*` env block.
/// This is the Rust counterpart of `applyEnvModelConfig`'s provider part:
/// `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` are required; `KIMI_MODEL_BASE_URL`
/// defaults to the Moonshot public endpoint. The synthesized config exists
/// only in memory and is never serialized.
pub fn native_llm_from_env(env: &std::collections::HashMap<String, String>) -> Option<NativeLlmConfig> {
    let model = env.get("KIMI_MODEL_NAME").filter(|s| !s.trim().is_empty())?;
    let api_key = env.get("KIMI_MODEL_API_KEY").filter(|s| !s.trim().is_empty())?;
    let base_url = env
        .get("KIMI_MODEL_BASE_URL")
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "https://api.moonshot.ai/v1".to_string());
    Some(NativeLlmConfig {
        protocol: "openai".to_string(),
        base_url,
        api_key: api_key.trim().to_string(),
        model: model.trim().to_string(),
        max_tokens: env
            .get("KIMI_MODEL_MAX_TOKENS")
            .and_then(|v| v.trim().parse::<u32>().ok()),
        reasoning_effort: env
            .get("KIMI_MODEL_THINKING_EFFORT")
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string()),
        custom_headers: HashMap::new(),
    })
}

/// Load the config from disk (`KIMI_CONFIG_PATH` / project / user paths with
/// `KIMI_PROVIDER_*` overrides), then derive a native LLM config. Returns
/// `None` when no config file exists, no provider qualifies, or the
/// `KIMI_MODEL_*` env block is incomplete — the caller falls back to the host
/// proxy in that case.
pub fn load_native_llm_from_config() -> Option<NativeLlmConfig> {
    // Env-synthesized provider wins: it is explicit by definition.
    let env_map: HashMap<String, String> = std::env::vars().collect();
    if let Some(cfg) = native_llm_from_env(&env_map) {
        return Some(cfg);
    }

    let config = crate::config::loader::load_config_with_env().ok()?;
    extract_native_llm(&config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::types::{AgentConfig, ModelAlias, ProviderConfig};

    fn kimi_provider() -> ProviderConfig {
        ProviderConfig {
            provider: Some(ProviderType::Kimi),
            api_key: Some("sk-env".into()),
            base_url: Some("https://api.moonshot.ai/v1".into()),
            model: None,
            max_tokens: None,
            oauth: None,
            custom_headers: None,
            env: None,
            source: None,
        }
    }

    fn alias(provider: &str, model: &str) -> ModelAlias {
        ModelAlias {
            provider: provider.into(),
            model: model.into(),
            max_tokens: None,
        }
    }

    fn config_with(agent: Option<AgentConfig>, provider: Option<ProviderConfig>) -> KimiConfig {
        KimiConfig {
            agent,
            providers: provider.map(|p| HashMap::from([("kimi".to_string(), p)])),
            model_aliases: Some(HashMap::from([
                ("default".to_string(), alias("kimi", "kimi-k2-turbo")),
                ("other".to_string(), alias("kimi", "kimi-latest")),
            ])),
            default_model: Some("default".into()),
            model_catalog: None,
            mcp: None,
            hooks: None,
            background: None,
            subagent: None,
            services: None,
        }
    }

    #[test]
    fn explicit_provider_wins() {
        let config = config_with(
            Some(AgentConfig {
                engine: None,
                native_llm_provider: Some("kimi".into()),
                max_turns: None,
                max_steps: None,
                max_tool_uses: None,
                permission: None,
            }),
            Some(kimi_provider()),
        );
        let cfg = extract_native_llm(&config).unwrap();
        assert_eq!(cfg.protocol, "openai");
        assert_eq!(cfg.model, "kimi-k2-turbo");
        assert_eq!(cfg.api_key, "sk-env");
    }

    #[test]
    fn derives_from_default_model_alias() {
        let config = config_with(None, Some(kimi_provider()));
        let cfg = extract_native_llm(&config).unwrap();
        // Invoking alias model wins over provider default.
        assert_eq!(cfg.model, "kimi-k2-turbo");
    }

    #[test]
    fn skips_provider_with_env_block_for_auto_derivation() {
        let mut provider = kimi_provider();
        provider.env = Some(HashMap::from([("KIMI_API_KEY".to_string(), "x".to_string())]));
        let config = config_with(None, Some(provider));
        assert!(extract_native_llm(&config).is_none());
    }

    #[test]
    fn explicit_provider_still_works_with_env_block() {
        let mut provider = kimi_provider();
        provider.env = Some(HashMap::from([("KIMI_API_KEY".to_string(), "x".to_string())]));
        let config = config_with(
            Some(AgentConfig {
                engine: None,
                native_llm_provider: Some("kimi".into()),
                max_turns: None,
                max_steps: None,
                max_tool_uses: None,
                permission: None,
            }),
            Some(provider),
        );
        assert!(extract_native_llm(&config).is_some());
    }

    #[test]
    fn falls_back_to_provider_default_model() {
        let mut provider = kimi_provider();
        provider.model = Some("kimi-k2-0905".into());
        let config = KimiConfig {
            agent: Some(AgentConfig {
                engine: None,
                native_llm_provider: Some("kimi".into()),
                max_turns: None,
                max_steps: None,
                max_tool_uses: None,
                permission: None,
            }),
            providers: Some(HashMap::from([("kimi".to_string(), provider)])),
            model_aliases: None,
            default_model: None,
            model_catalog: None,
            mcp: None,
            hooks: None,
            background: None,
            subagent: None,
            services: None,
        };
        let cfg = extract_native_llm(&config).unwrap();
        assert_eq!(cfg.model, "kimi-k2-0905");
    }

    #[test]
    fn google_defaults_base_url_when_missing() {
        let provider = ProviderConfig {
            provider: Some(ProviderType::GoogleGenAI),
            api_key: Some("goog".into()),
            base_url: None,
            model: None,
            max_tokens: None,
            oauth: None,
            custom_headers: None,
            env: None,
            source: None,
        };
        let config = KimiConfig {
            agent: None,
            providers: Some(HashMap::from([("gemini".to_string(), provider)])),
            model_aliases: Some(HashMap::from([("default".to_string(), alias("gemini", "gemini-3-pro"))])),
            default_model: Some("default".into()),
            model_catalog: None,
            mcp: None,
            hooks: None,
            background: None,
            subagent: None,
            services: None,
        };
        let cfg = extract_native_llm(&config).unwrap();
        assert_eq!(cfg.protocol, "google");
        assert_eq!(cfg.base_url, GOOGLE_DEFAULT_BASE_URL);
    }

    #[test]
    fn unsupported_type_falls_back() {
        let mut provider = kimi_provider();
        provider.provider = Some(ProviderType::VertexAI);
        let config = config_with(None, Some(provider));
        assert!(extract_native_llm(&config).is_none());
    }

    #[test]
    fn missing_static_api_key_falls_back() {
        let mut provider = kimi_provider();
        provider.api_key = None;
        let config = config_with(None, Some(provider));
        assert!(extract_native_llm(&config).is_none());
    }

    #[test]
    fn env_synthesis_minimal() {
        let env = HashMap::from([
            ("KIMI_MODEL_NAME".to_string(), "kimi-k2".to_string()),
            ("KIMI_MODEL_API_KEY".to_string(), "sk-x".to_string()),
        ]);
        let cfg = native_llm_from_env(&env).unwrap();
        assert_eq!(cfg.model, "kimi-k2");
        assert_eq!(cfg.base_url, "https://api.moonshot.ai/v1");
    }

    #[test]
    fn env_synthesis_requires_key() {
        let env = HashMap::from([("KIMI_MODEL_NAME".to_string(), "kimi-k2".to_string())]);
        assert!(native_llm_from_env(&env).is_none());
    }
}
