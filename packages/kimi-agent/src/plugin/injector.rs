//! Plugin injector — extracts skills, MCP servers, and hooks from enabled
//! plugins and makes them available to the agent.
//!
//! Mirrors `packages/agent-core/src/plugin/manager.ts` injection logic.

use crate::plugin::store::PluginStore;
use crate::plugin::types::*;

/// Plugin injection result — what the plugin contributes to the session.
pub struct PluginInjection {
    pub skills: Vec<PluginSkill>,
    pub mcp_servers: Vec<PluginMcpServer>,
    pub hooks: Vec<PluginHook>,
}

/// Collect all contributions from enabled plugins.
pub fn collect_plugin_injections(store: &PluginStore) -> PluginInjection {
    let plugins = match store.list_enabled() {
        Ok(p) => p,
        Err(_) => return PluginInjection {
            skills: vec![],
            mcp_servers: vec![],
            hooks: vec![],
        },
    };

    let mut skills = Vec::new();
    let mut mcp_servers = Vec::new();
    let mut hooks = Vec::new();

    for plugin in &plugins {
        skills.extend(plugin.skills.iter().cloned());
        mcp_servers.extend(plugin.mcp_servers.iter().cloned());
        hooks.extend(plugin.hooks.iter().cloned());
    }

    PluginInjection { skills, mcp_servers, hooks }
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
        }).unwrap();

        let injection = collect_plugin_injections(&store);
        assert!(injection.skills.is_empty());
    }
}