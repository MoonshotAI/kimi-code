/// `toolPolicy` domain (L4) — pure tool-activation policy evaluation.
///
/// Port of `packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts`.
///
/// Applies allowlists and denylists with builtin/MCP matching semantics.
/// `is_tool_active_composed` intersects the three policy layers (profile,
/// global `[tools]` config, session denylist).
use globset::{Glob, GlobMatcher};

use crate::tool_select::is_mcp_tool_name;

/// True when `pattern` contains glob magic characters.
const GLOB_MAGIC: &[char] = &['*', '?', '[', ']', '{', '}'];

// ── Glob matching ─────────────────────────────────────────────────────────

/// Pre-compiled glob pattern for repeated matching.
#[derive(Debug, Clone)]
pub struct GlobPattern {
    raw: String,
    matcher: GlobMatcher,
}

impl GlobPattern {
    pub fn new(pattern: &str) -> Result<Self, String> {
        let glob = Glob::new(pattern).map_err(|e| format!("invalid glob pattern \"{pattern}\": {e}"))?;
        Ok(Self {
            raw: pattern.to_string(),
            matcher: glob.compile_matcher(),
        })
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.matcher.is_match(text)
    }

    pub fn raw(&self) -> &str {
        &self.raw
    }
}

/// True when `pattern` is intended to match MCP tool names — either a full
/// `mcp__<server>__<tool>` name or an `mcp__`-prefixed glob like `mcp__*`.
pub(crate) fn is_mcp_pattern(pattern: &str) -> bool {
    is_mcp_tool_name(pattern) || (pattern.starts_with("mcp__") && pattern.contains(GLOB_MAGIC))
}

// ── Policy types ──────────────────────────────────────────────────────────

/// Profile-scoped tool activation policy.
#[derive(Debug, Clone, Default)]
pub struct ToolActivationPolicy {
    /// Allowlist: when present, only these tools are active.
    pub tools: Option<Vec<String>>,
    /// Denylist: these tools are explicitly disabled.
    pub disallowed_tools: Option<Vec<String>>,
}

/// Global `[tools]` configuration section.
#[derive(Debug, Clone, Default)]
pub struct GlobalToolsPolicy {
    /// Allowlist: when non-empty, only these tools are active.
    pub enabled: Option<Vec<String>>,
    /// Denylist: these tools are explicitly disabled.
    pub disabled: Option<Vec<String>>,
}

/// All three policy layers combined.
#[derive(Debug, Clone, Default)]
pub struct ToolPolicyLayers {
    pub profile: ToolActivationPolicy,
    pub global: Option<GlobalToolsPolicy>,
    pub session_disabled_tools: Option<Vec<String>>,
}

// ── Core functions ────────────────────────────────────────────────────────

/// Check whether a tool is active under a single policy layer.
///
/// - If `tools` (allowlist) is present: the name must be in the list.
///   For MCP tools, glob matching is used against MCP-pattern entries.
/// - If `disallowed_tools` (denylist) is present: the name must not be in the list.
///   For MCP tools, glob matching is used against MCP-pattern entries.
/// - No allowlist and no denylist: every tool is active.
pub fn is_tool_active(
    policy: &ToolActivationPolicy,
    name: &str,
    source: &str,
) -> bool {
    // Allowlist check
    if let Some(ref tools) = policy.tools {
        let allowed = if source != "mcp" {
            tools.iter().any(|t| t == name)
        } else {
            tools.iter()
                .filter(|p| is_mcp_pattern(p))
                .any(|p| glob_match(p, name))
        };
        if !allowed {
            return false;
        }
    }

    // Denylist check
    let Some(ref disallowed) = policy.disallowed_tools else {
        return true;
    };
    if source != "mcp" {
        return !disallowed.iter().any(|t| t == name);
    }
    !disallowed
        .iter()
        .filter(|p| is_mcp_pattern(p))
        .any(|p| glob_match(p, name))
}

/// Intersect the three policy layers: profile, global config, session.
///
/// All layers must allow the tool for it to be active.
pub fn is_tool_active_composed(
    layers: &ToolPolicyLayers,
    name: &str,
    source: &str,
) -> bool {
    // Profile layer
    if !is_tool_active(&layers.profile, name, source) {
        return false;
    }

    // Global config layer: an empty `enabled` list means unconstrained,
    // so we only apply the allowlist when it is non-empty.
    if let Some(ref global) = layers.global {
        let global_policy = ToolActivationPolicy {
            tools: global
                .enabled
                .as_ref()
                .filter(|e| !e.is_empty())
                .cloned(),
            disallowed_tools: global.disabled.clone(),
        };
        if !is_tool_active(&global_policy, name, source) {
            return false;
        }
    }

    // Session denylist layer
    if let Some(ref session) = layers.session_disabled_tools {
        let session_policy = ToolActivationPolicy {
            tools: None,
            disallowed_tools: Some(session.clone()),
        };
        if !is_tool_active(&session_policy, name, source) {
            return false;
        }
    }

    true
}

/// From an allowlist + denylist, resolve the final set of active tool names.
///
/// Returns `None` when there is no allowlist (all tools active).
/// Returns `Some(names)` with the intersection of allowlist minus denylist.
pub fn resolve_active_tool_names(
    policy: &ToolActivationPolicy,
) -> Option<Vec<String>> {
    let tools = policy.tools.as_ref()?;
    let active: Vec<String> = tools
        .iter()
        .filter(|name| {
            let source = if is_mcp_tool_name(name) { "mcp" } else { "builtin" };
            is_tool_active(policy, name, source)
        })
        .cloned()
        .collect();
    Some(active)
}

// ── Inactive tool pattern detection ───────────────────────────────────────

/// Why a pattern in the tool policy cannot activate any tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InactiveToolPatternKind {
    /// A wildcard outside an `mcp__` context — can never match.
    WildcardNotMcp,
    /// An `mcp__` literal without a full `mcp__<server>__<tool>` name.
    IncompleteMcpName,
    /// A literal naming no registered tool.
    UnknownTool,
}

/// A pattern that is ineffective under the current policy.
#[derive(Debug, Clone)]
pub struct InactiveToolPattern {
    pub pattern: String,
    pub kind: InactiveToolPatternKind,
}

/// Extract literal (non-glob, non-MCP) tool names from a list of patterns.
pub fn literal_tool_names(patterns: &[String]) -> Vec<String> {
    patterns
        .iter()
        .filter(|p| !is_mcp_tool_name(p) && !p.contains(GLOB_MAGIC))
        .cloned()
        .collect()
}

/// Find patterns that are ineffective — dead on arrival under `is_tool_active`.
///
/// Three shapes are problematic:
/// 1. `wildcard-not-mcp`: a glob outside `mcp__` prefix — can never match
/// 2. `incomplete-mcp-name`: an `mcp__` literal missing the `__<tool>` part
/// 3. `unknown-tool`: a literal naming no registered tool
pub fn find_inactive_tool_patterns(
    patterns: &[String],
    is_known_tool_name: Option<&dyn Fn(&str) -> bool>,
) -> Vec<InactiveToolPattern> {
    let mut issues = Vec::new();
    for pattern in patterns {
        if is_mcp_tool_name(pattern) || is_mcp_pattern(pattern) {
            // Incomplete MCP name: literal (no glob magic) missing the `__<tool>` part.
            if !pattern.contains(GLOB_MAGIC) && !pattern["mcp__".len()..].contains("__") {
                issues.push(InactiveToolPattern {
                    pattern: pattern.clone(),
                    kind: InactiveToolPatternKind::IncompleteMcpName,
                });
            }
            continue;
        }
        if pattern.contains(GLOB_MAGIC) {
            issues.push(InactiveToolPattern {
                pattern: pattern.clone(),
                kind: InactiveToolPatternKind::WildcardNotMcp,
            });
            continue;
        }
        if let Some(ref is_known) = is_known_tool_name {
            if !is_known(pattern) {
                issues.push(InactiveToolPattern {
                    pattern: pattern.clone(),
                    kind: InactiveToolPatternKind::UnknownTool,
                });
            }
        }
    }
    issues
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Match a single glob pattern against a name.
///
/// Uses `globset` for glob matching. For simple (non-glob) patterns, falls
/// back to exact string comparison.
fn glob_match(pattern: &str, name: &str) -> bool {
    if !pattern.contains(GLOB_MAGIC) {
        return pattern == name;
    }
    GlobPattern::new(pattern)
        .map(|gp| gp.is_match(name))
        .unwrap_or(false)
}