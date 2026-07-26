/// ToolManager — tool registration, lifecycle, and loop tool builder.
///
/// Corresponds to `packages/agent-core/src/agent/tool/index.ts`.
///
/// Manages three tool registries (builtin, user, MCP) and builds the
/// sorted, deduped tool list that the loop sends to the LLM each step.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::turn_loop::types::ToolInfo;

// ── Public types ──────────────────────────────────────────────────────────

/// Source of a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolSource {
    Builtin,
    User,
    Mcp,
}

/// Disclosure mode for a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolDisclosure {
    Inline,
    Deferred,
}

/// Registration payload for a user tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserToolRegistration {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    pub disclosure: Option<ToolDisclosure>,
}

/// Info about a tool for the tool list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolEntry {
    pub name: String,
    pub active: bool,
    pub source: ToolSource,
}

/// A registered tool (simplified — holds schema info, execution is delegated).
#[derive(Debug, Clone)]
struct RegisteredTool {
    name: String,
    description: String,
    parameters: serde_json::Value,
    source: ToolSource,
    disclosure: ToolDisclosure,
}

/// Result of registering an MCP server's tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerRegistrationResult {
    pub registered: Vec<String>,
    pub collisions: Vec<McpToolCollision>,
}

/// A tool name collision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCollision {
    pub qualified: String,
    pub tool_name: String,
    pub collides_with: McpCollisionKind,
}

/// Kind of collision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum McpCollisionKind {
    SameServer { tool_name: String },
    OtherServer { server_name: String },
}

// ── ToolManager ──────────────────────────────────────────────────────────

/// ToolManager — manages tool registries and builds the loop tool list.
pub struct ToolManager {
    /// Builtin tools (initialized once).
    builtin_tools: HashMap<String, RegisteredTool>,
    /// User-registered tools.
    user_tools: HashMap<String, RegisteredTool>,
    /// Tools with deferred disclosure.
    deferred_user_tools: HashSet<String>,
    /// MCP tools (server name → list of qualified names).
    mcp_tools: HashMap<String, RegisteredTool>,
    mcp_tools_by_server: HashMap<String, Vec<String>>,
    /// Enabled tool names (exact names for builtin/user, glob patterns for MCP).
    enabled_tools: HashSet<String>,
    /// MCP access patterns (glob patterns).
    mcp_access_patterns: Vec<String>,
    /// Loaded dynamic tool names (defer-window pending set).
    pending_loaded_dynamic_tools: HashSet<String>,
}

impl ToolManager {
    /// Create a new empty ToolManager.
    pub fn new() -> Self {
        Self {
            builtin_tools: HashMap::new(),
            user_tools: HashMap::new(),
            deferred_user_tools: HashSet::new(),
            mcp_tools: HashMap::new(),
            mcp_tools_by_server: HashMap::new(),
            enabled_tools: HashSet::new(),
            mcp_access_patterns: Vec::new(),
            pending_loaded_dynamic_tools: HashSet::new(),
        }
    }

    // ── Registration ─────────────────────────────────────────────────────

    /// Register a builtin tool (called during initialization).
    pub fn register_builtin(&mut self, name: &str, description: &str, parameters: serde_json::Value) {
        self.builtin_tools.insert(name.to_string(), RegisteredTool {
            name: name.to_string(),
            description: description.to_string(),
            parameters,
            source: ToolSource::Builtin,
            disclosure: ToolDisclosure::Inline,
        });
        self.enabled_tools.insert(name.to_string());
    }

    /// Register a user tool.
    pub fn register_user_tool(&mut self, input: UserToolRegistration) {
        let disclosure = input.disclosure.unwrap_or(ToolDisclosure::Inline);
        let name = input.name.clone();
        self.user_tools.insert(name.clone(), RegisteredTool {
            name: name.clone(),
            description: input.description,
            parameters: input.parameters,
            source: ToolSource::User,
            disclosure,
        });
        if matches!(disclosure, ToolDisclosure::Deferred) {
            self.deferred_user_tools.insert(name.clone());
        } else {
            self.deferred_user_tools.remove(&name);
        }
        self.enabled_tools.insert(name);
    }

    /// Unregister a user tool.
    pub fn unregister_user_tool(&mut self, name: &str) {
        self.user_tools.remove(name);
        self.deferred_user_tools.remove(name);
        self.pending_loaded_dynamic_tools.remove(name);
        self.enabled_tools.remove(name);
    }

    /// Register tools from an MCP server.
    pub fn register_mcp_server(
        &mut self,
        server_name: &str,
        tools: &[(String, String, serde_json::Value)],
        enabled_tools: Option<&HashSet<String>>,
    ) -> McpServerRegistrationResult {
        self.unregister_mcp_server(server_name);

        let mut qualified_names: Vec<String> = Vec::new();
        let mut collisions: Vec<McpToolCollision> = Vec::new();
        let mut seen_in_this_call: HashMap<String, String> = HashMap::new();

        for (tool_name, description, parameters) in tools {
            if let Some(enabled) = enabled_tools {
                if !enabled.contains(tool_name) {
                    continue;
                }
            }

            let qualified = qualify_mcp_tool_name(server_name, tool_name);

            if let Some(first) = seen_in_this_call.get(&qualified) {
                collisions.push(McpToolCollision {
                    qualified: qualified.clone(),
                    tool_name: tool_name.clone(),
                    collides_with: McpCollisionKind::SameServer {
                        tool_name: first.clone(),
                    },
                });
                continue;
            }

            if self.mcp_tools.contains_key(&qualified) {
                // Find which server it belongs to
                let existing_server = self.find_mcp_server_for_tool(&qualified);
                collisions.push(McpToolCollision {
                    qualified: qualified.clone(),
                    tool_name: tool_name.clone(),
                    collides_with: McpCollisionKind::OtherServer {
                        server_name: existing_server.unwrap_or_else(|| "unknown".to_string()),
                    },
                });
                continue;
            }

            seen_in_this_call.insert(qualified.clone(), tool_name.clone());
            self.mcp_tools.insert(qualified.clone(), RegisteredTool {
                name: qualified.clone(),
                description: description.clone(),
                parameters: parameters.clone(),
                source: ToolSource::Mcp,
                disclosure: ToolDisclosure::Deferred,
            });
            qualified_names.push(qualified);
        }

        self.mcp_tools_by_server.insert(server_name.to_string(), qualified_names.clone());

        McpServerRegistrationResult {
            registered: qualified_names,
            collisions,
        }
    }

    /// Unregister all tools from an MCP server.
    pub fn unregister_mcp_server(&mut self, server_name: &str) -> bool {
        let existing = self.mcp_tools_by_server.remove(server_name);
        if let Some(names) = existing {
            for name in &names {
                self.mcp_tools.remove(name);
            }
            true
        } else {
            false
        }
    }

    // ── Active tools ─────────────────────────────────────────────────────

    /// Set the active tool set.
    pub fn set_active_tools(&mut self, names: &[String]) {
        // Remove names not in the new list from enabled_tools
        let new_set: HashSet<String> = names.iter()
            .filter(|n| !is_mcp_tool_name(n))
            .cloned()
            .collect();
        self.enabled_tools = new_set;
        self.mcp_access_patterns = names.iter()
            .filter(|n| is_mcp_tool_name(n))
            .cloned()
            .collect();
    }

    // ── Dynamic tool management ──────────────────────────────────────────

    /// Mark tool names as loaded (defer-window lead).
    pub fn mark_dynamic_tools_loaded(&mut self, names: &[String]) {
        for name in names {
            self.pending_loaded_dynamic_tools.insert(name.clone());
        }
    }

    /// Called when context is cleared.
    pub fn on_context_cleared(&mut self) {
        self.pending_loaded_dynamic_tools.clear();
    }

    /// Called when context is compacted.
    pub fn on_context_compacted(&mut self) {
        self.pending_loaded_dynamic_tools.clear();
    }

    // ── Tool list builders ───────────────────────────────────────────────

    /// Build the list of tools to send to the LLM on each step.
    pub fn loop_tools(&self) -> Vec<ToolInfo> {
        let mut names: Vec<String> = Vec::new();

        // Enabled builtin/user tools
        for name in &self.enabled_tools {
            if self.builtin_tools.contains_key(name) || self.user_tools.contains_key(name) {
                names.push(name.clone());
            }
        }

        // Enabled MCP tools (filtered by access patterns)
        for name in self.mcp_tools.keys() {
            if self.is_mcp_tool_enabled(name) {
                names.push(name.clone());
            }
        }

        // Deferred user tools: only include if loaded
        let loaded = self.loaded_dynamic_tool_names();
        names.retain(|name| {
            if self.deferred_user_tools.contains(name) {
                loaded.contains(name)
            } else {
                true
            }
        });

        names.sort();
        names.dedup();

        names.into_iter().filter_map(|name| {
            self.get_tool_info(&name)
        }).collect()
    }

    /// Get a single tool's ToolInfo for the loop.
    fn get_tool_info(&self, name: &str) -> Option<ToolInfo> {
        let tool = self.builtin_tools.get(name)
            .or_else(|| self.user_tools.get(name))
            .or_else(|| self.mcp_tools.get(name))?;

        Some(ToolInfo {
            name: tool.name.clone(),
            description: tool.description.clone(),
            input_schema: tool.parameters.clone(),
        })
    }

    /// Get loaded dynamic tool names.
    fn loaded_dynamic_tool_names(&self) -> HashSet<String> {
        // A tool is "loaded" only if it's in the pending loaded set.
        // The pending set acts as a defer-window lead: names marked as loaded
        // whose schema message may still be en route to the context history.
        // Without history access in Rust, this is the sole source of truth.
        self.pending_loaded_dynamic_tools.iter()
            .filter(|name| {
                self.deferred_user_tools.contains(*name)
                    && self.user_tools.contains_key(*name)
                    && self.enabled_tools.contains(*name)
            })
            .cloned()
            .collect()
    }

    /// Check if an MCP tool is enabled (matches any access pattern).
    fn is_mcp_tool_enabled(&self, name: &str) -> bool {
        self.mcp_access_patterns.iter().any(|pattern| {
            native_glob_match(name, pattern)
        })
    }

    /// Find which MCP server owns a qualified tool name.
    fn find_mcp_server_for_tool(&self, qualified: &str) -> Option<String> {
        for (server_name, names) in &self.mcp_tools_by_server {
            if names.contains(&qualified.to_string()) {
                return Some(server_name.clone());
            }
        }
        None
    }

    // ── Data ─────────────────────────────────────────────────────────────

    /// List all info entries.
    pub fn data(&self) -> Vec<ToolEntry> {
        let mut entries = Vec::new();

        for tool in self.builtin_tools.values() {
            entries.push(ToolEntry {
                name: tool.name.clone(),
                active: self.enabled_tools.contains(&tool.name),
                source: ToolSource::Builtin,
            });
        }
        for tool in self.user_tools.values() {
            entries.push(ToolEntry {
                name: tool.name.clone(),
                active: self.enabled_tools.contains(&tool.name),
                source: ToolSource::User,
            });
        }
        for tool in self.mcp_tools.values() {
            entries.push(ToolEntry {
                name: tool.name.clone(),
                active: self.is_mcp_tool_enabled(&tool.name),
                source: ToolSource::Mcp,
            });
        }

        entries
    }

    /// List all registered user tools (for UserToolService).
    pub fn list_user_tools(&self) -> Vec<UserToolRegistration> {
        self.user_tools
            .values()
            .map(|t| UserToolRegistration {
                name: t.name.clone(),
                description: t.description.clone(),
                parameters: t.parameters.clone(),
                disclosure: Some(t.disclosure),
            })
            .collect()
    }

    /// Get a message for a missing tool (disclosure mode).
    pub fn missing_tool_message(&self, name: &str) -> Option<String> {
        let is_dynamic = self.deferred_user_tools.contains(name) || self.mcp_tools.contains_key(name);
        if !is_dynamic {
            return None;
        }
        let is_registered = self.user_tools.contains_key(name) || self.mcp_tools.contains_key(name);
        let is_loaded = self.loaded_dynamic_tool_names().contains(name);

        if is_registered && !is_loaded {
            Some(format!(
                "Tool \"{}\" is available but not loaded. Call select_tools with [\"{}\"] first, then call the tool.",
                name, name
            ))
        } else if !is_registered && is_loaded && is_mcp_tool_name(name) {
            Some(format!(
                "Tool \"{}\" was loaded but its MCP server is currently disconnected. It may become available again when the server reconnects.",
                name
            ))
        } else if !is_registered && is_loaded {
            Some(format!(
                "Tool \"{}\" was loaded but is no longer registered or active. Do not retry it.",
                name
            ))
        } else {
            None
        }
    }
}

impl Default for ToolManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Check if a name looks like an MCP tool name (starts with `mcp__`).
fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with("mcp__")
}

/// Qualify an MCP tool name with the server name.
fn qualify_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    format!("mcp__{}__{}", server_name, tool_name)
}

/// Simple glob match for MCP access patterns.
fn native_glob_match(name: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if pattern == name {
        return true;
    }
    // Handle simple wildcard patterns (e.g., "mcp__*", "mcp__github__*")
    if let Some(prefix) = pattern.strip_suffix('*') {
        return name.starts_with(prefix);
    }
    if let Some(suffix) = pattern.strip_prefix('*') {
        return name.ends_with(suffix);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_manager_empty() {
        let tm = ToolManager::new();
        assert!(tm.loop_tools().is_empty());
        assert!(tm.data().is_empty());
    }

    #[test]
    fn test_register_builtin() {
        let mut tm = ToolManager::new();
        tm.register_builtin("read", "Read a file", serde_json::json!({"type": "object"}));
        assert_eq!(tm.loop_tools().len(), 1);
        assert_eq!(tm.loop_tools()[0].name, "read");
    }

    #[test]
    fn test_register_user_tool() {
        let mut tm = ToolManager::new();
        tm.register_user_tool(UserToolRegistration {
            name: "my-tool".into(),
            description: "My custom tool".into(),
            parameters: serde_json::json!({"type": "object"}),
            disclosure: None,
        });
        assert_eq!(tm.loop_tools().len(), 1);
    }

    #[test]
    fn test_unregister_user_tool() {
        let mut tm = ToolManager::new();
        tm.register_user_tool(UserToolRegistration {
            name: "my-tool".into(),
            description: "desc".into(),
            parameters: serde_json::json!({}),
            disclosure: None,
        });
        tm.unregister_user_tool("my-tool");
        assert!(tm.loop_tools().is_empty());
    }

    #[test]
    fn test_mcp_tool_registration() {
        let mut tm = ToolManager::new();
        let tools = vec![
            ("read".into(), "Read a file".into(), serde_json::json!({})),
            ("write".into(), "Write a file".into(), serde_json::json!({})),
        ];
        let result = tm.register_mcp_server("filesystem", &tools, None);
        assert_eq!(result.registered.len(), 2);
        assert!(result.collisions.is_empty());
    }

    #[test]
    fn test_mcp_tool_name_collision() {
        let mut tm = ToolManager::new();
        // Two tools with the same name from the same server should collide
        let tools = vec![
            ("read".into(), "Read".into(), serde_json::json!({})),
        ];

        tm.register_mcp_server("server-a", &tools, None);
        // Registering the same server again should replace, not collide
        let result = tm.register_mcp_server("server-a", &tools, None);
        assert_eq!(result.registered.len(), 1);
        assert!(result.collisions.is_empty());
    }

    #[test]
    fn test_mcp_access_patterns() {
        let mut tm = ToolManager::new();
        let tools = vec![
            ("list".into(), "List files".into(), serde_json::json!({})),
        ];
        tm.register_mcp_server("filesystem", &tools, None);

        // Without pattern, MCP tools are not in loop_tools by default
        assert!(tm.loop_tools().is_empty());

        // With pattern, they should appear
        tm.set_active_tools(&["mcp__filesystem__*".to_string()]);
        let tools = tm.loop_tools();
        assert_eq!(tools.len(), 1, "expected 1 tool, got {:#?}", tools);
        assert!(tools[0].name.starts_with("mcp__filesystem__"));
    }

    #[test]
    fn test_set_active_tools() {
        let mut tm = ToolManager::new();
        tm.register_builtin("read", "Read", serde_json::json!({}));
        tm.register_builtin("write", "Write", serde_json::json!({}));

        tm.set_active_tools(&["read".to_string()]);
        assert_eq!(tm.loop_tools().len(), 1);
        assert_eq!(tm.loop_tools()[0].name, "read");
    }

    #[test]
    fn test_deferred_user_tools() {
        let mut tm = ToolManager::new();
        tm.register_user_tool(UserToolRegistration {
            name: "deferred-tool".into(),
            description: "Deferred".into(),
            parameters: serde_json::json!({}),
            disclosure: Some(ToolDisclosure::Deferred),
        });

        // Without loading, deferred tools are not in the loop list
        assert!(tm.loop_tools().is_empty());

        // After marking loaded, they should appear
        tm.mark_dynamic_tools_loaded(&["deferred-tool".to_string()]);
        assert_eq!(tm.loop_tools().len(), 1);
    }

    #[test]
    fn test_context_cleared_clears_pending() {
        let mut tm = ToolManager::new();
        tm.mark_dynamic_tools_loaded(&["tool-1".to_string()]);
        tm.on_context_cleared();
        // After clear, the pending set is empty, so a deferred tool won't appear
        assert!(tm.loop_tools().is_empty());
    }

    #[test]
    fn test_missing_tool_message_registered_not_loaded() {
        let mut tm = ToolManager::new();
        tm.register_user_tool(UserToolRegistration {
            name: "deferred-tool".into(),
            description: "Deferred".into(),
            parameters: serde_json::json!({}),
            disclosure: Some(ToolDisclosure::Deferred),
        });

        let msg = tm.missing_tool_message("deferred-tool");
        assert!(msg.is_some());
        assert!(msg.unwrap().contains("available but not loaded"));
    }

    #[test]
    fn test_missing_tool_message_not_found() {
        let tm = ToolManager::new();
        assert!(tm.missing_tool_message("nonexistent").is_none());
    }

    #[test]
    fn test_data_contains_tools() {
        let mut tm = ToolManager::new();
        tm.register_builtin("read", "Read", serde_json::json!({}));
        tm.register_user_tool(UserToolRegistration {
            name: "user-tool".into(),
            description: "User tool".into(),
            parameters: serde_json::json!({}),
            disclosure: None,
        });

        let data = tm.data();
        assert_eq!(data.len(), 2);
    }

    #[test]
    fn test_is_mcp_tool_name() {
        assert!(is_mcp_tool_name("mcp__github__list-issues"));
        assert!(!is_mcp_tool_name("Bash"));
        assert!(!is_mcp_tool_name("github__list-issues"));
    }

    #[test]
    fn test_qualify_mcp_tool_name() {
        assert_eq!(qualify_mcp_tool_name("github", "list-issues"), "mcp__github__list-issues");
    }

    #[test]
    fn test_native_glob_match() {
        assert!(native_glob_match("github__list", "github__*"));
        assert!(native_glob_match("github__list", "github__list"));
        assert!(!native_glob_match("github__list", "gitlab__*"));
        assert!(native_glob_match("anything", "*"));
    }
}