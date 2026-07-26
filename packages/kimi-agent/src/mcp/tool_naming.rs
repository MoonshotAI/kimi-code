/// MCP tool naming conventions.
///
/// Mirrors the TS `packages/agent-core/src/mcp/tool-naming.ts`.
/// Handles the `mcp__` prefix convention for MCP tools.

/// Prefix for all MCP tools.
pub const MCP_TOOL_PREFIX: &str = "mcp__";

/// Prefix separator.
pub const MCP_TOOL_SEPARATOR: &str = "__";

/// Check if a tool name is an MCP tool (starts with `mcp__`).
pub fn is_mcp_tool(tool_name: &str) -> bool {
    tool_name.starts_with(MCP_TOOL_PREFIX)
}

/// Parse an MCP tool name into (server_name, tool_name).
/// e.g. "mcp__github__list_issues" → ("github", "list_issues")
pub fn parse_mcp_tool_name(tool_name: &str) -> Option<(&str, &str)> {
    if !is_mcp_tool(tool_name) {
        return None;
    }
    let remainder = &tool_name[MCP_TOOL_PREFIX.len()..];
    match remainder.split_once(MCP_TOOL_SEPARATOR) {
        Some((server, tool)) => Some((server, tool)),
        None => None,
    }
}

/// Build an MCP tool name from server name and tool name.
/// e.g. ("github", "list_issues") → "mcp__github__list_issues"
pub fn build_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    format!("mcp__{}__{}", server_name, tool_name)
}

/// Build an MCP tool group name (all tools from a server).
/// e.g. "mcp__github" → "mcp__github__*"
pub fn mcp_tool_group_pattern(server_name: &str) -> String {
    format!("mcp__{}__*", server_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_mcp_tool() {
        assert!(is_mcp_tool("mcp__github__read"));
        assert!(!is_mcp_tool("Read"));
        assert!(!is_mcp_tool("Bash"));
    }

    #[test]
    fn test_parse_mcp_tool_name() {
        let parsed = parse_mcp_tool_name("mcp__github__list_issues");
        assert!(parsed.is_some());
        let (server, tool) = parsed.unwrap();
        assert_eq!(server, "github");
        assert_eq!(tool, "list_issues");
    }

    #[test]
    fn test_parse_invalid() {
        assert!(parse_mcp_tool_name("Read").is_none());
        assert!(parse_mcp_tool_name("mcp__").is_none());
    }

    #[test]
    fn test_build_mcp_tool_name() {
        let name = build_mcp_tool_name("github", "list_issues");
        assert_eq!(name, "mcp__github__list_issues");
    }

    #[test]
    fn test_mcp_tool_group_pattern() {
        let pattern = mcp_tool_group_pattern("github");
        assert_eq!(pattern, "mcp__github__*");
    }
}