/// MCP connection manager.
///
/// Mirrors the TS `packages/agent-core/src/mcp/connection-manager.ts`.
/// Manages multiple MCP server connections and their lifecycle.

use std::collections::HashMap;

use crate::mcp::types::MCPTool;

/// Status of an MCP server connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpServerStatus {
    Pending,
    Connected,
    Failed,
    Disabled,
    NeedsAuth,
}

/// Entry for an MCP server in the connection manager.
#[derive(Debug, Clone)]
pub struct McpServerEntry {
    pub name: String,
    pub status: McpServerStatus,
    pub tool_count: usize,
    pub error: Option<String>,
}

/// Internal server state.
struct ServerState {
    name: String,
    status: McpServerStatus,
    tools: Vec<MCPTool>,
    error: Option<String>,
}

/// MCP connection manager.
pub struct McpConnectionManager {
    /// Map of server name → server state.
    servers: HashMap<String, ServerState>,
}

impl McpConnectionManager {
    /// Create a new connection manager.
    pub fn new() -> Self {
        Self {
            servers: HashMap::new(),
        }
    }

    /// Register a server (sets status to Pending).
    pub fn register_server(&mut self, name: &str) {
        self.servers.insert(
            name.to_string(),
            ServerState {
                name: name.to_string(),
                status: McpServerStatus::Pending,
                tools: Vec::new(),
                error: None,
            },
        );
    }

    /// Mark a server as connected.
    pub fn mark_connected(&mut self, name: &str, tools: Vec<MCPTool>) {
        if let Some(server) = self.servers.get_mut(name) {
            server.status = McpServerStatus::Connected;
            server.tools = tools;
            server.error = None;
        }
    }

    /// Mark a server as failed.
    pub fn mark_failed(&mut self, name: &str, error: &str) {
        if let Some(server) = self.servers.get_mut(name) {
            server.status = McpServerStatus::Failed;
            server.error = Some(error.to_string());
        }
    }

    /// Mark a server as disabled.
    pub fn mark_disabled(&mut self, name: &str) {
        if let Some(server) = self.servers.get_mut(name) {
            server.status = McpServerStatus::Disabled;
        }
    }

    /// Remove a server.
    pub fn remove_server(&mut self, name: &str) {
        self.servers.remove(name);
    }

    /// Get all server entries.
    pub fn list_entries(&self) -> Vec<McpServerEntry> {
        self.servers
            .values()
            .map(|s| McpServerEntry {
                name: s.name.clone(),
                status: s.status,
                tool_count: s.tools.len(),
                error: s.error.clone(),
            })
            .collect()
    }

    /// Get tools for a specific server.
    pub fn get_tools(&self, name: &str) -> Option<&[MCPTool]> {
        self.servers.get(name).map(|s| s.tools.as_slice())
    }

    /// Get the status of a specific server.
    pub fn get_status(&self, name: &str) -> Option<McpServerStatus> {
        self.servers.get(name).map(|s| s.status)
    }

    /// Get all tools from all connected servers.
    pub fn all_tools(&self) -> Vec<&MCPTool> {
        self.servers
            .values()
            .filter(|s| s.status == McpServerStatus::Connected)
            .flat_map(|s| s.tools.iter())
            .collect()
    }

    /// Number of registered servers.
    pub fn server_count(&self) -> usize {
        self.servers.len()
    }

    /// Number of connected servers.
    pub fn connected_count(&self) -> usize {
        self.servers
            .values()
            .filter(|s| s.status == McpServerStatus::Connected)
            .count()
    }
}

impl Default for McpConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_manager() {
        let mgr = McpConnectionManager::new();
        assert_eq!(mgr.server_count(), 0);
        assert!(mgr.list_entries().is_empty());
    }

    #[test]
    fn test_register_and_connect() {
        let mut mgr = McpConnectionManager::new();
        mgr.register_server("github");
        assert_eq!(mgr.get_status("github"), Some(McpServerStatus::Pending));

        let tools = vec![MCPTool {
            name: "list_issues".into(),
            description: Some("List issues".into()),
            input_schema: None,
        }];
        mgr.mark_connected("github", tools);
        assert_eq!(mgr.get_status("github"), Some(McpServerStatus::Connected));

        let entries = mgr.list_entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].tool_count, 1);
    }

    #[test]
    fn test_failure() {
        let mut mgr = McpConnectionManager::new();
        mgr.register_server("filesystem");
        mgr.mark_failed("filesystem", "Connection refused");
        assert_eq!(mgr.get_status("filesystem"), Some(McpServerStatus::Failed));

        let entries = mgr.list_entries();
        assert_eq!(entries[0].error, Some("Connection refused".into()));
    }

    #[test]
    fn test_remove() {
        let mut mgr = McpConnectionManager::new();
        mgr.register_server("github");
        assert_eq!(mgr.server_count(), 1);
        mgr.remove_server("github");
        assert_eq!(mgr.server_count(), 0);
    }

    #[test]
    fn test_all_tools() {
        let mut mgr = McpConnectionManager::new();
        mgr.register_server("s1");
        mgr.register_server("s2");

        mgr.mark_connected("s1", vec![
            MCPTool { name: "tool1".into(), description: None, input_schema: None },
        ]);
        mgr.mark_connected("s2", vec![
            MCPTool { name: "tool2".into(), description: None, input_schema: None },
        ]);

        let all = mgr.all_tools();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_connected_count() {
        let mut mgr = McpConnectionManager::new();
        mgr.register_server("s1");
        mgr.register_server("s2");
        mgr.register_server("s3");

        mgr.mark_connected("s1", vec![]);
        mgr.mark_failed("s2", "error");

        assert_eq!(mgr.connected_count(), 1);
    }
}