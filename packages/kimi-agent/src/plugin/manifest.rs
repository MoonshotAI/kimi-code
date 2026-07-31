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
    /// Inline system-prompt contribution (upstream #2314). Capped at 32 KiB.
    #[serde(default, rename = "systemPrompt")]
    pub system_prompt: Option<String>,
    /// Path to a file whose contents contribute to the system prompt
    /// (upstream #2314).
    #[serde(default, rename = "systemPromptPath")]
    pub system_prompt_path: Option<String>,
    /// Agent directories (relative paths, resolved against the plugin root);
    /// defaults to `agents/` (upstream #2365).
    #[serde(default)]
    pub agents: Vec<String>,
    /// Plugin root directory, set by `from_file` so relative agent paths and
    /// `systemPromptPath` resolve correctly.
    #[serde(skip)]
    pub root: Option<std::path::PathBuf>,
}

/// Per-plugin system-prompt cap (bytes), matching upstream
/// `PLUGIN_SYSTEM_PROMPT_MAX_BYTES`.
pub const PLUGIN_SYSTEM_PROMPT_MAX_BYTES: usize = 32 * 1024;

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
        let mut manifest = Self::from_json(&content)?;
        manifest.root = path.parent().map(|p| p.to_path_buf());
        Ok(manifest)
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
            system_prompt: self.resolve_system_prompt(),
            agents: self.resolve_agent_roots(),
        }
    }

    /// Resolve the plugin's system-prompt contribution: the inline
    /// `systemPrompt` field, or the contents of `systemPromptPath` (both
    /// honored, concatenated, upstream #2314). The per-plugin cap is 32 KiB.
    fn resolve_system_prompt(&self) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        if let Some(ref inline) = self.system_prompt {
            if inline.len() <= PLUGIN_SYSTEM_PROMPT_MAX_BYTES {
                parts.push(inline.clone());
            }
        }
        if let Some(ref path) = self.system_prompt_path {
            if let Some(ref root) = self.root {
                let full = root.join(path);
                if let Ok(content) = std::fs::read_to_string(&full) {
                    if content.len() <= PLUGIN_SYSTEM_PROMPT_MAX_BYTES {
                        parts.push(content);
                    }
                }
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n\n"))
        }
    }

    /// Resolve the agent directories contributed by the plugin (upstream
    /// #2365): explicit `agents` entries, or the default `agents/` directory.
    fn resolve_agent_roots(&self) -> Vec<PluginAgent> {
        let candidates: Vec<String> = if !self.agents.is_empty() {
            self.agents.clone()
        } else if self.root.is_some() && self.root.as_ref().unwrap().join("agents").is_dir() {
            vec!["./agents".to_string()]
        } else {
            Vec::new()
        };
        let mut out = Vec::new();
        let Some(ref root) = self.root else {
            return out;
        };
        for (i, entry) in candidates.iter().enumerate() {
            let full = if entry.starts_with("./") {
                root.join(&entry[2..])
            } else {
                root.join(entry)
            };
            if full.is_dir() {
                out.push(PluginAgent {
                    name: full
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| format!("agents-{i}")),
                    path: full.to_string_lossy().to_string(),
                });
            }
        }
        out
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