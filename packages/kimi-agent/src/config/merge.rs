/// Configuration merge logic.
///
/// Mirrors the TS `packages/agent-core/src/config/merge.ts`.
/// Provides deep merge for nested configuration structures.

use std::collections::HashMap;

use crate::config::types::*;

/// Merge two KimiConfigs. `overrides` takes precedence over `base`.
/// Fields set to `None` in `overrides` do NOT clear the `base` value.
pub fn merge_configs(base: KimiConfig, overrides: KimiConfig) -> KimiConfig {
    KimiConfig {
        agent: merge_agent(base.agent, overrides.agent),
        providers: merge_providers(base.providers, overrides.providers),
        model_aliases: merge_model_aliases(base.model_aliases, overrides.model_aliases),
        model_catalog: overrides.model_catalog.or(base.model_catalog),
        mcp: overrides.mcp.or(base.mcp),
        hooks: overrides.hooks.or(base.hooks),
        background: overrides.background.or(base.background),
        subagent: overrides.subagent.or(base.subagent),
        services: overrides.services.or(base.services),
    }
}

fn merge_agent(base: Option<AgentConfig>, overrides: Option<AgentConfig>) -> Option<AgentConfig> {
    match (base, overrides) {
        (None, None) => None,
        (Some(b), None) => Some(b),
        (None, Some(o)) => Some(o),
        (Some(b), Some(o)) => Some(AgentConfig {
            engine: o.engine.or(b.engine),
            max_turns: o.max_turns.or(b.max_turns),
            max_steps: o.max_steps.or(b.max_steps),
            max_tool_uses: o.max_tool_uses.or(b.max_tool_uses),
            permission: o.permission.or(b.permission),
        }),
    }
}

fn merge_providers(
    base: Option<HashMap<String, ProviderConfig>>,
    overrides: Option<HashMap<String, ProviderConfig>>,
) -> Option<HashMap<String, ProviderConfig>> {
    match (base, overrides) {
        (None, None) => None,
        (Some(b), None) => Some(b),
        (None, Some(o)) => Some(o),
        (Some(mut b), Some(o)) => {
            for (key, val) in o {
                b.insert(key, val);
            }
            Some(b)
        }
    }
}

fn merge_model_aliases(
    base: Option<HashMap<String, ModelAlias>>,
    overrides: Option<HashMap<String, ModelAlias>>,
) -> Option<HashMap<String, ModelAlias>> {
    match (base, overrides) {
        (None, None) => None,
        (Some(b), None) => Some(b),
        (None, Some(o)) => Some(o),
        (Some(mut b), Some(o)) => {
            for (key, val) in o {
                b.insert(key, val);
            }
            Some(b)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_empty() {
        let base = KimiConfig::empty();
        let overrides = KimiConfig::empty();
        let result = merge_configs(base, overrides);
        assert!(result.agent.is_none());
    }

    #[test]
    fn test_merge_overrides_agent() {
        let base = KimiConfig {
            agent: Some(AgentConfig {
                engine: Some("js".into()),
                max_turns: Some(50),
                max_steps: None,
                max_tool_uses: None,
                permission: None,
            }),
            ..KimiConfig::empty()
        };
        let overrides = KimiConfig {
            agent: Some(AgentConfig {
                engine: Some("rust".into()),
                max_turns: None,
                max_steps: Some(20),
                max_tool_uses: None,
                permission: None,
            }),
            ..KimiConfig::empty()
        };
        let result = merge_configs(base, overrides);
        let agent = result.agent.unwrap();
        assert_eq!(agent.engine, Some("rust".into())); // overridden
        assert_eq!(agent.max_turns, Some(50)); // preserved from base
        assert_eq!(agent.max_steps, Some(20)); // from overrides
    }

    #[test]
    fn test_merge_providers() {
        let mut base_providers = HashMap::new();
        base_providers.insert(
            "openai".into(),
            ProviderConfig {
                provider: Some(ProviderType::OpenAI),
                api_key: Some("base-key".into()),
                base_url: None,
                model: None,
                max_tokens: None,
                oauth: None,
                custom_headers: None,
            },
        );

        let mut override_providers = HashMap::new();
        override_providers.insert(
            "openai".into(),
            ProviderConfig {
                provider: Some(ProviderType::OpenAI),
                api_key: Some("override-key".into()),
                base_url: None,
                model: Some("gpt-4".into()),
                max_tokens: None,
                oauth: None,
                custom_headers: None,
            },
        );
        override_providers.insert(
            "anthropic".into(),
            ProviderConfig {
                provider: Some(ProviderType::Anthropic),
                api_key: Some("sk-ant".into()),
                base_url: None,
                model: None,
                max_tokens: None,
                oauth: None,
                custom_headers: None,
            },
        );

        let base = KimiConfig {
            providers: Some(base_providers),
            ..KimiConfig::empty()
        };
        let overrides = KimiConfig {
            providers: Some(override_providers),
            ..KimiConfig::empty()
        };

        let result = merge_configs(base, overrides);
        let providers = result.providers.unwrap();
        assert_eq!(providers.len(), 2);
        // openai api_key should be overridden
        assert_eq!(
            providers.get("openai").unwrap().api_key,
            Some("override-key".into())
        );
        // anthropic should be added
        assert!(providers.contains_key("anthropic"));
    }

    #[test]
    fn test_merge_base_only() {
        let base = KimiConfig {
            background: Some(BackgroundConfig {
                max_running_tasks: Some(5),
            }),
            ..KimiConfig::empty()
        };
        let overrides = KimiConfig::empty();
        let result = merge_configs(base, overrides);
        assert_eq!(
            result.background.unwrap().max_running_tasks,
            Some(5)
        );
    }
}