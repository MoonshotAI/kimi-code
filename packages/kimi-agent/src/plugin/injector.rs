//! Plugin injector — extracts skills, MCP servers, hooks, system-prompt
//! contributions, and agent directories from enabled plugins and makes them
//! available to the agent.
//!
//! Mirrors `packages/agent-core/src/plugin/manager.ts` injection logic.

use crate::plugin::store::PluginStore;
use crate::plugin::types::*;

/// A plugin system-prompt contribution, ready to be composed into the
/// session system prompt (upstream #2314).
#[derive(Debug, Clone)]
pub struct PluginSystemPrompt {
    pub plugin_id: String,
    pub content: String,
}

/// Plugin injection result — what the plugin contributes to the session.
pub struct PluginInjection {
    pub skills: Vec<PluginSkill>,
    pub mcp_servers: Vec<PluginMcpServer>,
    pub hooks: Vec<PluginHook>,
    pub system_prompts: Vec<PluginSystemPrompt>,
    pub agent_roots: Vec<PluginAgent>,
}

/// Aggregate budget for composed plugin system-prompt sections (bytes),
/// matching upstream `PLUGIN_SECTIONS_MAX_BYTES`.
pub const PLUGIN_SECTIONS_MAX_BYTES: usize = 64 * 1024;

/// Compose the plugin system-prompt contributions into one block, skipping
/// contributions that would exceed the aggregate budget.
///
/// Returns the composed block and the ids of plugins whose contributions
/// were skipped, mirroring upstream `composePluginSections`.
pub fn compose_plugin_sections(sections: &[PluginSystemPrompt]) -> (String, Vec<String>) {
    let mut parts: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut total_bytes = 0usize;
    for section in sections {
        let block = format!("<!-- From: plugin {} -->\n{}", section.plugin_id, section.content);
        let bytes = block.len();
        if total_bytes + bytes > PLUGIN_SECTIONS_MAX_BYTES {
            skipped.push(section.plugin_id.clone());
            continue;
        }
        total_bytes += bytes;
        parts.push(block);
    }
    (parts.join("\n\n"), skipped)
}

/// Collect all contributions from enabled plugins.
pub fn collect_plugin_injections(store: &PluginStore) -> PluginInjection {
    let plugins = match store.list_enabled() {
        Ok(p) => p,
        Err(_) => return PluginInjection {
            skills: vec![],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompts: vec![],
            agent_roots: vec![],
        },
    };

    let mut skills = Vec::new();
    let mut mcp_servers = Vec::new();
    let mut hooks = Vec::new();
    let mut system_prompts = Vec::new();
    let mut agent_roots = Vec::new();

    for plugin in &plugins {
        skills.extend(plugin.skills.iter().cloned());
        mcp_servers.extend(plugin.mcp_servers.iter().cloned());
        hooks.extend(plugin.hooks.iter().cloned());
        if let Some(ref content) = plugin.system_prompt {
            system_prompts.push(PluginSystemPrompt {
                plugin_id: plugin.id.clone(),
                content: content.clone(),
            });
        }
        agent_roots.extend(plugin.agents.iter().cloned());
    }

    PluginInjection {
        skills,
        mcp_servers,
        hooks,
        system_prompts,
        agent_roots,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::SqliteStore;

    fn make_store() -> PluginStore {
        let store = PluginStore::new(SqliteStore::in_memory().unwrap());
        store.init().unwrap();
        store
    }

    #[test]
    fn test_empty_plugins_produce_empty_injection() {
        let store = make_store();
        let injection = collect_plugin_injections(&store);
        assert!(injection.skills.is_empty());
        assert!(injection.mcp_servers.is_empty());
        assert!(injection.hooks.is_empty());
    }

    #[test]
    fn test_enabled_plugin_contributes_skills() {
        let store = make_store();
        store.upsert(&PluginRecord {
            id: "test/my-plugin".into(),
            name: "My Plugin".into(),
            version: "1.0.0".into(),
            description: "Test".into(),
            source: PluginSource::Local { path: "/tmp/plugin".into() },
            state: PluginState::Enabled,
            installed_at: "0".into(),
            skills: vec![PluginSkill {
                name: "test-skill".into(),
                description: "A test skill".into(),
                file: "test.skill.md".into(),
            }],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompt: None,
            agents: vec![],
        }).unwrap();

        let injection = collect_plugin_injections(&store);
        assert_eq!(injection.skills.len(), 1);
        assert_eq!(injection.skills[0].name, "test-skill");
    }

    #[test]
    fn test_disabled_plugin_does_not_contribute() {
        let store = make_store();
        store.upsert(&PluginRecord {
            id: "test/disabled".into(),
            name: "Disabled".into(),
            version: "1.0.0".into(),
            description: "Should not contribute".into(),
            source: PluginSource::Local { path: "/tmp/plugin".into() },
            state: PluginState::Disabled,
            installed_at: "0".into(),
            skills: vec![PluginSkill {
                name: "disabled-skill".into(),
                description: "Should not appear".into(),
                file: "skill.md".into(),
            }],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompt: None,
            agents: vec![],
        }).unwrap();

        let injection = collect_plugin_injections(&store);
        assert!(injection.skills.is_empty());
    }

    #[test]
    fn test_enabled_plugin_contributes_system_prompt_and_agents() {
        let store = make_store();
        store.upsert(&PluginRecord {
            id: "test/sys".into(),
            name: "Sys".into(),
            version: "1.0.0".into(),
            description: "Contributes system prompt + agents".into(),
            source: PluginSource::Local { path: "/tmp/plugin".into() },
            state: PluginState::Enabled,
            installed_at: "0".into(),
            skills: vec![],
            mcp_servers: vec![],
            hooks: vec![],
            system_prompt: Some("You always speak in haiku.".into()),
            agents: vec![PluginAgent {
                name: "my-agents".into(),
                path: "/tmp/plugin/agents".into(),
            }],
        })
        .unwrap();

        let injection = collect_plugin_injections(&store);
        assert_eq!(injection.system_prompts.len(), 1);
        assert_eq!(injection.system_prompts[0].plugin_id, "test/sys");
        assert_eq!(injection.system_prompts[0].content, "You always speak in haiku.");
        assert_eq!(injection.agent_roots.len(), 1);
        assert_eq!(injection.agent_roots[0].path, "/tmp/plugin/agents");
    }

    #[test]
    fn test_compose_plugin_sections_budgets_and_marks_skipped() {
        // Fits comfortably.
        let (content, skipped) = compose_plugin_sections(&[
            PluginSystemPrompt { plugin_id: "a".into(), content: "short".into() },
            PluginSystemPrompt { plugin_id: "b".into(), content: "also short".into() },
        ]);
        assert!(skipped.is_empty());
        assert!(content.contains("<!-- From: plugin a -->"));
        assert!(content.contains("<!-- From: plugin b -->"));

        // One oversized contribution blows the aggregate budget → skipped.
        let huge = "x".repeat(PLUGIN_SECTIONS_MAX_BYTES + 10);
        let (_, skipped) = compose_plugin_sections(&[PluginSystemPrompt {
            plugin_id: "big".into(),
            content: huge,
        }]);
        assert_eq!(skipped, vec!["big".to_string()]);
    }
}