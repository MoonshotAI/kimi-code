/// Core configuration model types for Kimi Code CLI.
///
/// Mirrors the TS types in `packages/agent-core/src/config/schema.ts`.
/// Uses serde for direct TOML deserialization.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Provider types ────────────────────────────────────────────────────────────

/// Supported provider types.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProviderType {
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "openai")]
    OpenAI,
    #[serde(rename = "kimi")]
    Kimi,
    #[serde(rename = "google-genai")]
    GoogleGenAI,
    #[serde(rename = "openai_responses")]
    OpenAIResponses,
    #[serde(rename = "vertexai")]
    VertexAI,
    #[serde(rename = "astron")]
    Astron,
}

/// OAuth reference configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuthRef {
    pub storage: OAuthStorage,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum OAuthStorage {
    #[serde(rename = "file")]
    File,
    #[serde(rename = "keyring")]
    Keyring,
}

/// Provider configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderConfig {
    /// Provider type key in config.toml is `type` (not `provider`), matching
    /// the TS schema (`ProviderConfigSchema.type`).
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderType>,

    #[serde(
        rename = "apiKey",
        alias = "api_key",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub api_key: Option<String>,

    #[serde(
        rename = "baseUrl",
        alias = "base_url",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub base_url: Option<String>,

    /// TS `defaultModel` — the provider's default model id.
    #[serde(
        rename = "defaultModel",
        alias = "default_model",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub model: Option<String>,

    #[serde(
        rename = "maxTokens",
        alias = "max_tokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_tokens: Option<u32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthRef>,

    #[serde(rename = "customHeaders", default, skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<HashMap<String, String>>,

    /// Provider-scoped environment variables (e.g. `KIMI_API_KEY`). The
    /// presence of an `env` block means credentials/behavior are resolved at
    /// request time by the host — the native transport cannot replicate it,
    /// so auto-derivation must skip such providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<HashMap<String, serde_json::Value>>,
}

// ── Model alias ───────────────────────────────────────────────────────────────

/// A model alias mapping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelAlias {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

// ── Secondary model ─────────────────────────────────────────────────────────

/// TS `secondaryModel` — the secondary-model recipe: `model` points at a
/// `[models]` entry (or is used verbatim) and `default_effort` doubles as the
/// subagent thinking effort. On disk `[secondary_model]`; env
/// `KIMI_SECONDARY_MODEL` / `KIMI_SECONDARY_EFFORT`. Gated by the upstream
/// `secondary-model` experimental flag (default off) — see
/// `config/native_llm.rs::resolve_secondary_native_llm`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecondaryModelConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// TS `defaultEffort` — the subagent thinking effort for secondary-model
    /// spawns.
    #[serde(rename = "defaultEffort", default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
}

// ── Model catalog ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelCatalogConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_interval_minutes: Option<u32>,
}

// ── MCP config ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub servers: Option<HashMap<String, McpServerConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}

// ── Hook config ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookDefConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_tool_call: Option<Vec<String>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_tool_call: Option<Vec<String>>,
}

// ── Permission config ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

// ── Agent config ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,

    /// TS `agent.nativeLlmProvider` — provider name whose endpoint the Rust
    /// engine should call directly (SSE streaming) instead of the host proxy.
    #[serde(rename = "nativeLlmProvider", default, skip_serializing_if = "Option::is_none")]
    pub native_llm_provider: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_uses: Option<u32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<PermissionConfig>,
}

// ── Background task config ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackgroundConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_running_tasks: Option<u32>,
}

// ── Subagent config ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubagentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
}

// ── Services config ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServicesConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moonshot: Option<MoonshotServiceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoonshotServiceConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

// ── Top-level KimiConfig ──────────────────────────────────────────────────────

/// The top-level Kimi Code CLI configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KimiConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentConfig>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<HashMap<String, ProviderConfig>>,

    /// TS `models` — model alias map keyed by alias id.
    #[serde(rename = "models", default, skip_serializing_if = "Option::is_none")]
    pub model_aliases: Option<HashMap<String, ModelAlias>>,

    /// TS `defaultModel` — the alias id that the session uses by default.
    /// Accepts both `defaultModel` (TS serialized shape) and `default_model`
    /// (the snake_case TOML spelling) on deserialize.
    #[serde(
        rename = "defaultModel",
        alias = "default_model",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub default_model: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_catalog: Option<ModelCatalogConfig>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<McpConfig>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hooks: Option<HookDefConfig>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<BackgroundConfig>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<SubagentConfig>,

    /// TS `secondaryModel` — the secondary-model recipe for subagent spawns
    /// (model + thinking-effort override). Gated by the experimental flag.
    #[serde(rename = "secondaryModel", default, skip_serializing_if = "Option::is_none")]
    pub secondary_model: Option<SecondaryModelConfig>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub services: Option<ServicesConfig>,
}

impl KimiConfig {
    /// Create an empty default configuration.
    pub fn empty() -> Self {
        Self {
            agent: None,
            providers: None,
            model_aliases: None,
            default_model: None,
            model_catalog: None,
            mcp: None,
            hooks: None,
            background: None,
            subagent: None,
            secondary_model: None,
            services: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_config() {
        let config = KimiConfig::empty();
        assert!(config.agent.is_none());
        assert!(config.providers.is_none());
    }

    #[test]
    fn test_provider_config_serialize() {
        let config = ProviderConfig {
            provider: Some(ProviderType::OpenAI),
            api_key: Some("sk-test".into()),
            base_url: Some("https://api.openai.com/v1".into()),
            model: Some("gpt-4".into()),
            max_tokens: Some(4096),
            oauth: None,
            custom_headers: None,
            env: None,
            source: None,
        };
        let toml_str = toml::to_string(&config).unwrap();
        assert!(toml_str.contains("type = \"openai\""));
        assert!(toml_str.contains("apiKey = \"sk-test\""));

        // Deserialize back
        let deserialized: ProviderConfig = toml::from_str(&toml_str).unwrap();
        assert_eq!(deserialized.provider, Some(ProviderType::OpenAI));
        assert_eq!(deserialized.api_key, Some("sk-test".into()));
    }

    #[test]
    fn test_provider_config_accepts_snake_case_toml() {
        // config.toml uses snake_case (`api_key`/`base_url`/`default_model`);
        // the serde aliases must accept it so native_llm resolution works.
        let toml_str = r#"
type = "openai"
api_key = "sk-snake"
base_url = "https://api.example.com/v1"
default_model = "model-x"
max_tokens = 2048
"#;
        let deserialized: ProviderConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(deserialized.provider, Some(ProviderType::OpenAI));
        assert_eq!(deserialized.api_key, Some("sk-snake".into()));
        assert_eq!(deserialized.base_url, Some("https://api.example.com/v1".into()));
        assert_eq!(deserialized.model, Some("model-x".into()));
        assert_eq!(deserialized.max_tokens, Some(2048));
    }

    #[test]
    fn test_kimi_config_accepts_snake_case_default_model() {
        // config.toml writes `default_model` (snake); the KimiConfig alias
        // must map it onto `defaultModel`.
        let toml_str = r#"
default_model = "deepseek-v4-flash"
"#;
        let config: KimiConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.default_model, Some("deepseek-v4-flash".into()));
    }

    #[test]
    fn test_kimi_config_toml_roundtrip() {
        let config = KimiConfig {
            agent: Some(AgentConfig {
                engine: Some("rust".into()),
                native_llm_provider: None,
                max_turns: Some(100),
                max_steps: Some(10),
                max_tool_uses: None,
                permission: None,
            }),
            providers: Some(HashMap::from([(
                "openai".into(),
                ProviderConfig {
                    provider: Some(ProviderType::OpenAI),
                    api_key: Some("sk-test".into()),
                    base_url: None,
                    model: Some("gpt-4".into()),
                    max_tokens: None,
                    oauth: None,
                    custom_headers: None,
                    env: None,
                    source: None,
                },
            )])),
            model_aliases: None,
            default_model: None,
            model_catalog: None,
            mcp: None,
            hooks: None,
            background: None,
            subagent: None,
            secondary_model: None,
            services: None,
        };

        let toml_str = toml::to_string(&config).unwrap();
        assert!(toml_str.contains("engine = \"rust\""));
        assert!(toml_str.contains("max_turns = 100"));

        // Deserialize back
        let deserialized: KimiConfig = toml::from_str(&toml_str).unwrap();
        assert_eq!(deserialized.agent.as_ref().unwrap().engine, Some("rust".into()));
        assert_eq!(
            deserialized.providers.as_ref().unwrap().get("openai").unwrap().model,
            Some("gpt-4".into())
        );
    }

    #[test]
    fn test_provider_type_variants() {
        let variants = vec![
            ("anthropic", ProviderType::Anthropic),
            ("openai", ProviderType::OpenAI),
            ("kimi", ProviderType::Kimi),
            ("google-genai", ProviderType::GoogleGenAI),
            ("openai_responses", ProviderType::OpenAIResponses),
            ("vertexai", ProviderType::VertexAI),
            ("astron", ProviderType::Astron),
        ];
        for (name, expected) in variants {
            let toml_str = format!("type = \"{name}\"");
            let config: ProviderConfig = toml::from_str(&toml_str).unwrap();
            assert_eq!(config.provider, Some(expected));
        }
    }
}