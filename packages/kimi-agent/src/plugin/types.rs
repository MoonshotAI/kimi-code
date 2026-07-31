//! Plugin type definitions.

use serde::{Deserialize, Serialize};

/// Unique identifier for a plugin (e.g. `"my-org/cool-plugin"`).
pub type PluginId = String;

/// Source of a plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PluginSource {
    /// GitHub repository: `owner/repo` (optionally `owner/repo@tag`).
    Github { repo: String, tag: Option<String> },
    /// Local filesystem path.
    Local { path: String },
    /// Remote zip URL.
    Url { url: String },
}

/// State of a plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PluginState {
    /// Plugin is installed and enabled.
    Enabled,
    /// Plugin is installed but disabled.
    Disabled,
}

/// Skill contributed by a plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSkill {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub file: String,
}

/// MCP server configuration contributed by a plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMcpServer {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub url: Option<String>,
}

/// Hook contributed by a plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginHook {
    pub event: String,
    pub command: String,
    pub matcher: Option<String>,
}

/// A plugin record stored in the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRecord {
    pub id: PluginId,
    pub name: String,
    pub version: String,
    pub description: String,
    pub source: PluginSource,
    pub state: PluginState,
    pub installed_at: String,
    pub skills: Vec<PluginSkill>,
    pub mcp_servers: Vec<PluginMcpServer>,
    pub hooks: Vec<PluginHook>,
}

impl PluginRecord {
    /// Whether the plugin is enabled.
    pub fn is_enabled(&self) -> bool {
        self.state == PluginState::Enabled
    }
}