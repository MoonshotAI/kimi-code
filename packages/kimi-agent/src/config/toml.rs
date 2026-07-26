/// TOML configuration loading and saving.
///
/// Mirrors the TS `packages/agent-core/src/config/toml.ts`.
/// Provides TOML serialization/deserialization for KimiConfig.

use crate::config::types::KimiConfig;

/// Parse a KimiConfig from a TOML string.
pub fn parse_config(toml_str: &str) -> Result<KimiConfig, String> {
    toml::from_str(toml_str).map_err(|e| format!("TOML parse error: {e}"))
}

/// Serialize a KimiConfig to a TOML string.
pub fn serialize_config(config: &KimiConfig) -> Result<String, String> {
    toml::to_string(config).map_err(|e| format!("TOML serialize error: {e}"))
}

/// Parse a config from a TOML file path.
/// Note: Actual file I/O should be done on the JS side.
/// This function exists for testing and simple use cases.
#[cfg(not(target_arch = "wasm32"))]
pub fn load_config_from_file(path: &str) -> Result<KimiConfig, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config file {path}: {e}"))?;
    parse_config(&content)
}

/// Get a provider config by name from the KimiConfig.
pub fn get_provider_config<'a>(
    config: &'a KimiConfig,
    provider_name: &str,
) -> Option<&'a crate::config::types::ProviderConfig> {
    config.providers.as_ref()?.get(provider_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_minimal_config() {
        let toml_str = r#"
[agent]
engine = "rust"
max_turns = 100
"#;
        let config = parse_config(toml_str).unwrap();
        assert_eq!(config.agent.as_ref().unwrap().engine, Some("rust".into()));
        assert_eq!(config.agent.as_ref().unwrap().max_turns, Some(100));
    }

    #[test]
    fn test_parse_full_config() {
        let toml_str = r#"
[agent]
engine = "rust"
max_turns = 100
max_steps = 10

[agent.permission]
mode = "yolo"

[providers.openai]
provider = "openai"
api_key = "sk-test-123"
model = "gpt-4"

[providers.anthropic]
provider = "anthropic"
api_key = "sk-ant-test"
model = "claude-3-opus"

[background]
max_running_tasks = 5

[subagent]
default_model = "gpt-4-mini"
max_turns = 20
"#;
        let config = parse_config(toml_str).unwrap();

        // Agent
        let agent = config.agent.as_ref().unwrap();
        assert_eq!(agent.engine, Some("rust".into()));
        assert_eq!(agent.permission.as_ref().unwrap().mode, Some("yolo".into()));

        // Providers
        let providers = config.providers.as_ref().unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers.get("openai").unwrap().api_key, Some("sk-test-123".into()));
        assert_eq!(providers.get("anthropic").unwrap().model, Some("claude-3-opus".into()));

        // Background
        assert_eq!(config.background.as_ref().unwrap().max_running_tasks, Some(5));

        // Subagent
        assert_eq!(config.subagent.as_ref().unwrap().default_model, Some("gpt-4-mini".into()));
    }

    #[test]
    fn test_serialize_roundtrip() {
        let config = parse_config(r#"
[agent]
engine = "rust"
max_turns = 50
"#).unwrap();

        let serialized = serialize_config(&config).unwrap();
        let deserialized = parse_config(&serialized).unwrap();
        assert_eq!(deserialized.agent.unwrap().engine, Some("rust".into()));
    }

    #[test]
    fn test_parse_invalid_toml() {
        let result = parse_config("invalid toml [[[ content");
        assert!(result.is_err());
    }

    #[test]
    fn test_get_provider_config() {
        let toml_str = r#"
[providers.openai]
api_key = "sk-test"
"#;
        let config = parse_config(toml_str).unwrap();
        let provider = get_provider_config(&config, "openai");
        assert!(provider.is_some());
        assert_eq!(provider.unwrap().api_key, Some("sk-test".into()));

        let missing = get_provider_config(&config, "nonexistent");
        assert!(missing.is_none());
    }
}