/// Environment variable model configuration.
///
/// Mirrors the TS `packages/agent-core/src/config/env-model.ts`.
/// Handles environment variable overrides for provider configuration
/// (e.g. `KIMI_OPENAI_API_KEY`, `KIMI_ANTHROPIC_BASE_URL`).

use std::collections::HashMap;

use crate::config::types::{KimiConfig, ProviderConfig};

/// Provider environment variable prefix.
const KIMI_PROVIDER_PREFIX: &str = "KIMI_PROVIDER_";
/// Suffixes for provider env vars.
const API_KEY_SUFFIX: &str = "_API_KEY";
const BASE_URL_SUFFIX: &str = "_BASE_URL";
const MODEL_SUFFIX: &str = "_MODEL";
const MAX_TOKENS_SUFFIX: &str = "_MAX_TOKENS";

/// Apply environment variable overrides to a KimiConfig.
/// Environment variables take precedence over config file values.
pub fn apply_env_overrides(config: &mut KimiConfig) {
    let env_vars: HashMap<String, String> = std::env::vars()
        .filter(|(key, _)| key.starts_with(KIMI_PROVIDER_PREFIX))
        .collect();

    if env_vars.is_empty() {
        return;
    }

    let providers = config.providers.get_or_insert(HashMap::new());

    for (key, value) in &env_vars {
        let suffix = key.strip_prefix(KIMI_PROVIDER_PREFIX).unwrap_or("");
        let (provider_name, field) = split_provider_env(suffix);

        if provider_name.is_empty() {
            continue;
        }

        let provider = providers
            .entry(provider_name.to_lowercase())
            .or_insert_with(|| ProviderConfig {
                provider: None,
                api_key: None,
                base_url: None,
                model: None,
                max_tokens: None,
                oauth: None,
                custom_headers: None,
                env: None,
                source: None,
            });

        match field {
            "API_KEY" => provider.api_key = Some(value.clone()),
            "BASE_URL" => provider.base_url = Some(value.clone()),
            "MODEL" => provider.model = Some(value.clone()),
            "MAX_TOKENS" => {
                if let Ok(num) = value.parse::<u32>() {
                    provider.max_tokens = Some(num);
                }
            }
            _ => {}
        }
    }
}

/// Split a provider env var suffix into (provider_name, field).
/// e.g. "OPENAI_API_KEY" → ("openai", "API_KEY")
fn split_provider_env(suffix: &str) -> (&str, &str) {
    let suffixes = [
        API_KEY_SUFFIX,
        BASE_URL_SUFFIX,
        MODEL_SUFFIX,
        MAX_TOKENS_SUFFIX,
    ];

    for s in &suffixes {
        if let Some(provider) = suffix.strip_suffix(s) {
            return (provider, s.trim_start_matches('_'));
        }
    }

    (suffix, "")
}

/// Check if a specific provider env var is set.
pub fn get_provider_env(provider: &str, field: &str) -> Option<String> {
    let key = format!("{}{}_{}", KIMI_PROVIDER_PREFIX, provider.to_uppercase(), field);
    std::env::var(key).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_provider_env() {
        let (provider, field) = split_provider_env("OPENAI_API_KEY");
        assert_eq!(provider, "OPENAI");
        assert_eq!(field, "API_KEY");

        let (provider, field) = split_provider_env("ANTHROPIC_BASE_URL");
        assert_eq!(provider, "ANTHROPIC");
        assert_eq!(field, "BASE_URL");
    }

    #[test]
    fn test_apply_env_overrides_empty() {
        let mut config = KimiConfig::empty();
        // No env vars set, should be a no-op
        apply_env_overrides(&mut config);
        assert!(config.providers.is_none());
    }
}