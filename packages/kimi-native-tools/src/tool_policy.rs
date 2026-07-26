/// Tool policy evaluation — pure tool-activation policy evaluation.
///
/// Pure functions for tool policy evaluation. The TS side retains
/// service orchestration, DI registration, and config section handling.
///
/// Corresponds to `packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts`.
use napi_derive::napi;
use regex::Regex;

const MCP_NAME_PREFIX: &str = "mcp__";

/// Regex that matches glob magic characters: * ? [ ] { }
fn has_glob_magic(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?')
        || pattern.contains('[') || pattern.contains(']')
        || pattern.contains('{') || pattern.contains('}')
}

/// Check if a name is an MCP tool name (starts with `mcp__` and has server+tool parts).
fn native_is_mcp_tool_name(name: &str) -> bool {
    if !name.starts_with(MCP_NAME_PREFIX) {
        return false;
    }
    let tail = &name[MCP_NAME_PREFIX.len()..];
    if let Some(sep) = tail.find("__") {
        let server = &tail[..sep];
        let tool = &tail[sep + 2..];
        !server.is_empty() && !tool.is_empty()
    } else {
        false
    }
}

/// Check if a pattern is intended to match MCP tool names.
fn is_mcp_pattern(pattern: &str) -> bool {
    native_is_mcp_tool_name(pattern)
        || (pattern.starts_with(MCP_NAME_PREFIX) && has_glob_magic(pattern))
}

/// Simple glob match for MCP patterns.
/// Uses regex crate to convert a glob-like pattern to a regex.
fn glob_match(pattern: &str, name: &str) -> bool {
    let glob_regex = pattern
        .replace('.', "\\.")
        .replace('?', ".")
        .replace('*', ".*");
    Regex::new(&format!("^{}$", glob_regex)).map_or(false, |re| re.is_match(name))
}

/// Check if a tool is active according to a policy.
/// Returns true if the tool is allowed.
#[napi]
pub fn native_is_tool_active(policy_json: String, name: String, source: String) -> bool {
    let policy: serde_json::Value =
        serde_json::from_str(&policy_json).unwrap_or(serde_json::Value::Null);

    let source_str = source.as_str();
    let is_mcp = source_str == "mcp";

    // Check allowlist (tools)
    if let Some(tools) = policy.get("tools").and_then(|t| t.as_array()) {
        let allowed = if !is_mcp {
            tools.iter().any(|t| t.as_str() == Some(&name))
        } else {
            let mcp_patterns: Vec<&str> = tools
                .iter()
                .filter_map(|t| t.as_str())
                .filter(|p| is_mcp_pattern(p))
                .collect();
            mcp_patterns.iter().any(|p| glob_match(p, &name))
        };
        if !allowed {
            return false;
        }
    }

    // Check denylist (disallowedTools)
    if let Some(disallowed) = policy.get("disallowedTools").and_then(|t| t.as_array()) {
        if !is_mcp {
            if disallowed.iter().any(|t| t.as_str() == Some(&name)) {
                return false;
            }
        } else {
            let mcp_patterns: Vec<&str> = disallowed
                .iter()
                .filter_map(|t| t.as_str())
                .filter(|p| is_mcp_pattern(p))
                .collect();
            if mcp_patterns.iter().any(|p| glob_match(p, &name)) {
                return false;
            }
        }
    }

    true
}

/// Three-layer tool policy composition.
/// layers_json: { profile: ToolActivationPolicy, global?: { enabled?, disabled? }, sessionDisabledTools?: string[] }
/// name: tool name
/// source: tool source ("builtin", "mcp", etc.)
/// Returns true if the tool is active across all layers.
#[napi]
pub fn native_is_tool_active_composed(layers_json: String, name: String, source: String) -> bool {
    let layers: serde_json::Value =
        serde_json::from_str(&layers_json).unwrap_or(serde_json::Value::Null);

    // Layer 1: Profile
    let profile = layers.get("profile");
    if let Some(p) = profile {
        if !native_is_tool_active(serde_json::to_string(p).unwrap_or_default(), name.clone(), source.clone()) {
            return false;
        }
    }

    // Layer 2: Global config
    if let Some(global) = layers.get("global") {
        let enabled = global.get("enabled").and_then(|e| e.as_array());
        let disabled = global.get("disabled").and_then(|d| d.as_array());
        let global_policy = serde_json::json!({
            "tools": enabled.and_then(|arr| if arr.is_empty() { None } else { Some(arr) }),
            "disallowedTools": disabled,
        });
        if !native_is_tool_active(
            serde_json::to_string(&global_policy).unwrap_or_default(),
            name.clone(),
            source.clone(),
        ) {
            return false;
        }
    }

    // Layer 3: Session denylist
    if let Some(session) = layers.get("sessionDisabledTools").and_then(|s| s.as_array()) {
        let session_policy = serde_json::json!({
            "disallowedTools": session,
        });
        if !native_is_tool_active(
            serde_json::to_string(&session_policy).unwrap_or_default(),
            name,
            source,
        ) {
            return false;
        }
    }

    true
}

/// Filter patterns to get literal (non-glob, non-MCP) tool names.
/// Returns JSON array of literal tool name strings.
#[napi]
pub fn native_literal_tool_names(patterns_json: String) -> String {
    let patterns: Vec<String> =
        serde_json::from_str(&patterns_json).unwrap_or_default();

    let result: Vec<String> = patterns
        .into_iter()
        .filter(|p| !native_is_mcp_tool_name(p) && !has_glob_magic(p))
        .collect();

    serde_json::to_string(&result).unwrap_or_else(|_| "[]".to_string())
}

/// Find inactive tool patterns (dead configurations).
/// Returns JSON array of { pattern: string, kind: string } objects.
#[napi]
pub fn native_find_inactive_tool_patterns(
    patterns_json: String,
    is_known_tool_name_json: Option<String>,
) -> String {
    let patterns: Vec<String> =
        serde_json::from_str(&patterns_json).unwrap_or_default();
    let known_tools: Vec<String> = is_known_tool_name_json
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();

    let mut issues: Vec<serde_json::Value> = Vec::new();

    for pattern in &patterns {
        // Check for MCP-related patterns: valid tool name, glob pattern, or incomplete
        let is_mcp = native_is_mcp_tool_name(pattern) || is_mcp_pattern(pattern);
        let starts_mcp = pattern.starts_with(MCP_NAME_PREFIX);
        if is_mcp || (starts_mcp && !has_glob_magic(pattern)) {
            // MCP pattern check
            if !has_glob_magic(pattern) {
                let tail = &pattern[MCP_NAME_PREFIX.len()..];
                if !tail.contains("__") {
                    issues.push(serde_json::json!({
                        "pattern": pattern,
                        "kind": "incomplete-mcp-name",
                    }));
                }
            }
            continue;
        }
        if has_glob_magic(pattern) {
            issues.push(serde_json::json!({
                "pattern": pattern,
                "kind": "wildcard-not-mcp",
            }));
            continue;
        }
        // Literal tool name check
        if !known_tools.is_empty() && !known_tools.contains(pattern) {
            issues.push(serde_json::json!({
                "pattern": pattern,
                "kind": "unknown-tool",
            }));
        }
    }

    serde_json::to_string(&issues).unwrap_or_else(|_| "[]".to_string())
}

/// Resolve active tool names from a policy (filter only active ones).
/// Returns JSON array of active tool name strings, or empty array if policy has no tools.
#[napi]
pub fn native_resolve_active_tool_names(policy_json: String) -> String {
    let policy: serde_json::Value =
        serde_json::from_str(&policy_json).unwrap_or(serde_json::Value::Null);

    let tools = match policy.get("tools").and_then(|t| t.as_array()) {
        Some(t) => t,
        None => return "[]".to_string(),
    };

    let mut result: Vec<serde_json::Value> = Vec::new();
    for tool_val in tools {
        if let Some(name) = tool_val.as_str() {
            let source = if native_is_mcp_tool_name(name) {
                "mcp"
            } else {
                "builtin"
            };
            if native_is_tool_active(policy_json.clone(), name.to_string(), source.to_string()) {
                result.push(serde_json::json!(name));
            }
        }
    }

    serde_json::to_string(&result).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_mcp_tool_name() {
        assert!(native_is_mcp_tool_name("mcp__server__tool"));
        assert!(!native_is_mcp_tool_name("read"));
        assert!(!native_is_mcp_tool_name("mcp__"));
        assert!(!native_is_mcp_tool_name("mcp__server"));
    }

    #[test]
    fn test_is_tool_active_allowlist() {
        let policy = serde_json::json!({
            "tools": ["read", "write"],
        });
        assert!(native_is_tool_active(policy.to_string(), "read".to_string(), "builtin".to_string()));
        assert!(!native_is_tool_active(policy.to_string(), "delete".to_string(), "builtin".to_string()));
    }

    #[test]
    fn test_is_tool_active_denylist() {
        let policy = serde_json::json!({
            "disallowedTools": ["delete"],
        });
        assert!(native_is_tool_active(policy.to_string(), "read".to_string(), "builtin".to_string()));
        assert!(!native_is_tool_active(policy.to_string(), "delete".to_string(), "builtin".to_string()));
    }

    #[test]
    fn test_is_tool_active_mcp_glob() {
        let policy = serde_json::json!({
            "tools": ["mcp__github__*"],
        });
        assert!(native_is_tool_active(
            policy.to_string(),
            "mcp__github__list-issues".to_string(),
            "mcp".to_string(),
        ));
        assert!(!native_is_tool_active(
            policy.to_string(),
            "mcp__gitlab__list-issues".to_string(),
            "mcp".to_string(),
        ));
    }

    #[test]
    fn test_is_tool_active_composed() {
        let layers = serde_json::json!({
            "profile": {"tools": ["read", "write"]},
            "global": {"disabled": ["delete"]},
            "sessionDisabledTools": ["dangerous"],
        });
        // read is allowed by profile, not in global disabled, not in session → active
        assert!(native_is_tool_active_composed(
            layers.to_string(),
            "read".to_string(),
            "builtin".to_string(),
        ));
        // delete is not in profile tools → inactive
        assert!(!native_is_tool_active_composed(
            layers.to_string(),
            "delete".to_string(),
            "builtin".to_string(),
        ));
    }

    #[test]
    fn test_literal_tool_names() {
        let patterns = serde_json::json!(["read", "write", "mcp__s__t", "glob_*"]);
        let result = native_literal_tool_names(patterns.to_string());
        let parsed: Vec<String> = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed, vec!["read", "write"]);
    }

    #[test]
    fn test_find_inactive_patterns() {
        let patterns = serde_json::json!(["read", "mcp__s", "*", "unknown"]);
        let known = serde_json::json!(["read", "write"]);
        let result = native_find_inactive_tool_patterns(
            patterns.to_string(),
            Some(known.to_string()),
        );
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        assert!(parsed.iter().any(|i| i["kind"] == "incomplete-mcp-name"));
        assert!(parsed.iter().any(|i| i["kind"] == "wildcard-not-mcp"));
        assert!(parsed.iter().any(|i| i["kind"] == "unknown-tool"));
    }

    #[test]
    fn test_resolve_active_tool_names() {
        let policy = serde_json::json!({
            "tools": ["read", "write", "delete"],
            "disallowedTools": ["delete"],
        });
        let result = native_resolve_active_tool_names(policy.to_string());
        let parsed: Vec<String> = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed, vec!["read", "write"]);
    }
}