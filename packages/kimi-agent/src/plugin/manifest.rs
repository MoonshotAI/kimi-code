//! Plugin manifest parsing — reads `plugin.json` from a plugin directory
//! and extracts the declared skills, MCP servers, hooks, and commands.
//!
//! Mirrors `packages/agent-core/src/plugin/manifest.ts`.

use crate::plugin::types::*;

/// Parsed plugin manifest (the `plugin.json` file).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub skills: Vec<PluginManifestSkill>,
    #[serde(default)]
    pub mcp_servers: Vec<PluginManifestMcpServer>,
    #[serde(default)]
    pub hooks: Vec<PluginManifestHook>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PluginManifestSkill {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub file: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PluginManifestMcpServer {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PluginManifestHook {
    pub event: String,
    pub command: String,
    pub matcher: Option<String>,
}

impl PluginManifest {
    /// Parse a plugin manifest from a JSON string.
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("Invalid plugin manifest: {e}"))
    }

    /// Parse a plugin manifest from a file path.
    pub fn from_file(path: &std::path::Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Cannot read plugin manifest at {path:?}: {e}"))?;
        Self::from_json(&content)
    }

    /// Convert to a PluginRecord, given a source and plugin ID.
    pub fn to_record(&self, id: PluginId, source: PluginSource) -> PluginRecord {
        PluginRecord {
            id,
            name: self.name.clone(),
            version: self.version.clone(),
            description: self.description.clone(),
            source,
            state: PluginState::Enabled,
            installed_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .to_string(),
            skills: self.skills.iter().map(|s| PluginSkill {
                name: s.name.clone(),
                description: s.description.clone(),
                file: s.file.clone(),
            }).collect(),
            mcp_servers: self.mcp_servers.iter().map(|m| PluginMcpServer {
                name: m.name.clone(),
                transport: m.transport.clone(),
                command: m.command.clone(),
                url: m.url.clone(),
            }).collect(),
            hooks: self.hooks.iter().map(|h| PluginHook {
                event: h.event.clone(),
                command: h.command.clone(),
                matcher: h.matcher.clone(),
            }).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_minimal_manifest() {
        let json = r#"{
            "name": "test-plugin",
            "version": "1.0.0",
            "description": "A test plugin"
        }"#;
        let manifest = PluginManifest::from_json(json).unwrap();
        assert_eq!(manifest.name, "test-plugin");
        assert_eq!(manifest.version, "1.0.0");
        assert!(manifest.skills.is_empty());
        assert!(manifest.mcp_servers.is_empty());
        assert!(manifest.hooks.is_empty());
    }

    #[test]
    fn test_parse_manifest_with_skills() {
        let json = r#"{
            "name": "plugin-with-skills",
            "version": "0.1.0",
            "description": "Has skills",
            "skills": [
                {"name": "review-code", "description": "Review code for quality", "file": "review.skill.md"},
                {"name": "generate-test", "description": "Generate tests", "file": "test.skill.md"}
            ]
        }"#;
        let manifest = PluginManifest::from_json(json).unwrap();
        assert_eq!(manifest.skills.len(), 2);
        assert_eq!(manifest.skills[0].name, "review-code");
        assert_eq!(manifest.skills[1].file, "test.skill.md");
    }

    #[test]
    fn test_parse_manifest_with_mcp_and_hooks() {
        let json = r#"{
            "name": "full-plugin",
            "version": "2.0.0",
            "description": "Full featured",
            "mcp_servers": [
                {"name": "my-server", "transport": "stdio", "command": "node server.js"}
            ],
            "hooks": [
                {"event": "PreToolUse", "command": "echo hook triggered", "matcher": "^Read$"}
            ]
        }"#;
        let manifest = PluginManifest::from_json(json).unwrap();
        assert_eq!(manifest.mcp_servers.len(), 1);
        assert_eq!(manifest.mcp_servers[0].name, "my-server");
        assert_eq!(manifest.hooks.len(), 1);
        assert_eq!(manifest.hooks[0].event, "PreToolUse");
    }

    #[test]
    fn test_to_record() {
        let json = r#"{
            "name": "my-plugin",
            "version": "1.0.0",
            "description": "A plugin",
            "skills": [
                {"name": "my-skill", "description": "Does something", "file": "skill.md"}
            ]
        }"#;
        let manifest = PluginManifest::from_json(json).unwrap();
        let record = manifest.to_record(
            "my-org/my-plugin".into(),
            PluginSource::Github { repo: "my-org/my-plugin".into(), tag: None },
        );
        assert_eq!(record.id, "my-org/my-plugin");
        assert_eq!(record.skills.len(), 1);
        assert_eq!(record.skills[0].name, "my-skill");
        assert_eq!(record.state, PluginState::Enabled);
    }
}