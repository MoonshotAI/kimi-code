use super::evaluate::*;
use crate::tool_select::is_mcp_tool_name;

// ── is_tool_active tests ─────────────────────────────────────────────────

#[test]
fn no_policy_all_tools_active() {
    let policy = ToolActivationPolicy::default();
    assert!(is_tool_active(&policy, "Read", "builtin"));
    assert!(is_tool_active(&policy, "Write", "mcp"));
}

#[test]
fn allowlist_grants_tools() {
    let policy = ToolActivationPolicy {
        tools: Some(vec!["Read".into(), "Grep".into()]),
        disallowed_tools: None,
    };
    assert!(is_tool_active(&policy, "Read", "builtin"));
    assert!(is_tool_active(&policy, "Grep", "builtin"));
    assert!(!is_tool_active(&policy, "Write", "builtin"));
    assert!(!is_tool_active(&policy, "Bash", "builtin"));
}

#[test]
fn denylist_blocks_tools() {
    let policy = ToolActivationPolicy {
        tools: None,
        disallowed_tools: Some(vec!["Bash".into()]),
    };
    assert!(is_tool_active(&policy, "Read", "builtin"));
    assert!(!is_tool_active(&policy, "Bash", "builtin"));
    assert!(is_tool_active(&policy, "Write", "builtin"));
}

#[test]
fn allowlist_and_denylist_intersect() {
    let policy = ToolActivationPolicy {
        tools: Some(vec!["Read".into(), "Grep".into(), "Bash".into()]),
        disallowed_tools: Some(vec!["Bash".into()]),
    };
    assert!(is_tool_active(&policy, "Read", "builtin"));
    assert!(is_tool_active(&policy, "Grep", "builtin"));
    assert!(!is_tool_active(&policy, "Bash", "builtin"));
    assert!(!is_tool_active(&policy, "Write", "builtin"));
}

// ── MCP tool matching ────────────────────────────────────────────────────

#[test]
fn mcp_tool_exact_match_in_allowlist() {
    let policy = ToolActivationPolicy {
        tools: Some(vec!["mcp__github__list-issues".into()]),
        disallowed_tools: None,
    };
    assert!(is_tool_active(&policy, "mcp__github__list-issues", "mcp"));
    assert!(!is_tool_active(&policy, "mcp__github__other", "mcp"));
    assert!(!is_tool_active(&policy, "mcp__other__tool", "mcp"));
}

#[test]
fn mcp_tool_glob_match_in_allowlist() {
    let policy = ToolActivationPolicy {
        tools: Some(vec!["mcp__github__*".into()]),
        disallowed_tools: None,
    };
    assert!(is_tool_active(&policy, "mcp__github__list-issues", "mcp"));
    assert!(is_tool_active(&policy, "mcp__github__create-pr", "mcp"));
    assert!(!is_tool_active(&policy, "mcp__gitlab__list-issues", "mcp"));
    assert!(!is_tool_active(&policy, "mcp__other__tool", "mcp"));
}

#[test]
fn mcp_tool_glob_wildcard_server() {
    let policy = ToolActivationPolicy {
        tools: Some(vec!["mcp__*".into()]),
        disallowed_tools: None,
    };
    assert!(is_tool_active(&policy, "mcp__github__list-issues", "mcp"));
    assert!(is_tool_active(&policy, "mcp__filesystem__read", "mcp"));
    // Non-MCP tools are not affected by MCP globs
    assert!(!is_tool_active(&policy, "Read", "builtin"));
}

#[test]
fn mcp_tool_denylist_glob() {
    let policy = ToolActivationPolicy {
        tools: None,
        disallowed_tools: Some(vec!["mcp__github__*".into()]),
    };
    assert!(!is_tool_active(&policy, "mcp__github__list-issues", "mcp"));
    assert!(!is_tool_active(&policy, "mcp__github__create-pr", "mcp"));
    assert!(is_tool_active(&policy, "mcp__gitlab__list-issues", "mcp"));
    assert!(is_tool_active(&policy, "mcp__filesystem__read", "mcp"));
    // Non-MCP tools are not affected by MCP globs
    assert!(is_tool_active(&policy, "Read", "builtin"));
}

#[test]
fn mcp_tool_non_mcp_patterns_ignored_in_mcp_checks() {
    // Non-MCP patterns in the allowlist should not affect MCP tool matching
    let policy = ToolActivationPolicy {
        tools: Some(vec!["Read".into(), "mcp__github__*".into()]),
        disallowed_tools: None,
    };
    assert!(is_tool_active(&policy, "mcp__github__list-issues", "mcp"));
    assert!(is_tool_active(&policy, "Read", "builtin"));
    assert!(!is_tool_active(&policy, "Write", "builtin"));
}

#[test]
fn mcp_tool_glob_with_question_mark() {
    let policy = ToolActivationPolicy {
        tools: Some(vec!["mcp__github__list-?ssues".into()]),
        disallowed_tools: None,
    };
    assert!(is_tool_active(&policy, "mcp__github__list-issues", "mcp"));
    assert!(!is_tool_active(&policy, "mcp__github__list-issuess", "mcp"));
}

// ── is_tool_active_composed tests ─────────────────────────────────────────

#[test]
fn composed_all_layers_allow() {
    let layers = ToolPolicyLayers {
        profile: ToolActivationPolicy {
            tools: Some(vec!["Read".into(), "Write".into()]),
            disallowed_tools: None,
        },
        global: Some(GlobalToolsPolicy {
            enabled: Some(vec!["Read".into(), "Write".into(), "Grep".into()]),
            disabled: None,
        }),
        session_disabled_tools: Some(vec![]),
    };
    assert!(is_tool_active_composed(&layers, "Read", "builtin"));
    assert!(is_tool_active_composed(&layers, "Write", "builtin"));
    assert!(!is_tool_active_composed(&layers, "Grep", "builtin")); // not in profile allowlist
}

#[test]
fn composed_profile_blocks() {
    let layers = ToolPolicyLayers {
        profile: ToolActivationPolicy {
            tools: None,
            disallowed_tools: Some(vec!["Bash".into()]),
        },
        global: None,
        session_disabled_tools: None,
    };
    assert!(is_tool_active_composed(&layers, "Read", "builtin"));
    assert!(!is_tool_active_composed(&layers, "Bash", "builtin"));
}

#[test]
fn composed_global_denylist_blocks() {
    let layers = ToolPolicyLayers {
        profile: ToolActivationPolicy::default(),
        global: Some(GlobalToolsPolicy {
            enabled: None,
            disabled: Some(vec!["Write".into()]),
        }),
        session_disabled_tools: None,
    };
    assert!(is_tool_active_composed(&layers, "Read", "builtin"));
    assert!(!is_tool_active_composed(&layers, "Write", "builtin"));
}

#[test]
fn composed_session_blocks() {
    let layers = ToolPolicyLayers {
        profile: ToolActivationPolicy::default(),
        global: None,
        session_disabled_tools: Some(vec!["Bash".into()]),
    };
    assert!(is_tool_active_composed(&layers, "Read", "builtin"));
    assert!(!is_tool_active_composed(&layers, "Bash", "builtin"));
}

#[test]
fn composed_profile_denylist_overrides_global_allowlist() {
    let layers = ToolPolicyLayers {
        profile: ToolActivationPolicy {
            tools: None,
            disallowed_tools: Some(vec!["Read".into()]),
        },
        global: Some(GlobalToolsPolicy {
            enabled: Some(vec!["Read".into(), "Write".into()]),
            disabled: None,
        }),
        session_disabled_tools: None,
    };
    // Profile denylist blocks Read even though global allowlist allows it
    assert!(!is_tool_active_composed(&layers, "Read", "builtin"));
    // Write is allowed by profile (no allowlist, no denylist), and global allowlist allows it
    assert!(is_tool_active_composed(&layers, "Write", "builtin"));
}

#[test]
fn composed_empty_global_enabled_is_unconstrained() {
    let layers = ToolPolicyLayers {
        profile: ToolActivationPolicy::default(),
        global: Some(GlobalToolsPolicy {
            enabled: Some(vec![]),
            disabled: None,
        }),
        session_disabled_tools: None,
    };
    // An empty enabled list means "unconstrained" — all tools are active
    assert!(is_tool_active_composed(&layers, "Read", "builtin"));
    assert!(is_tool_active_composed(&layers, "Write", "builtin"));
}

// ── resolve_active_tool_names tests ───────────────────────────────────────

#[test]
fn resolve_no_allowlist_returns_none() {
    let policy = ToolActivationPolicy::default();
    assert!(resolve_active_tool_names(&policy).is_none());
}

#[test]
fn resolve_allowlist_returns_filtered() {
    let policy = ToolActivationPolicy {
        tools: Some(vec![
            "Read".into(),
            "Bash".into(),
            "mcp__github__list-issues".into(),
        ]),
        disallowed_tools: Some(vec!["Bash".into()]),
    };
    let active = resolve_active_tool_names(&policy).unwrap();
    assert!(active.contains(&"Read".to_string()));
    assert!(!active.contains(&"Bash".to_string()));
    assert!(active.contains(&"mcp__github__list-issues".to_string()));
}

// ── find_inactive_tool_patterns tests ─────────────────────────────────────

#[test]
fn find_inactive_no_issues() {
    let patterns = vec!["Read".into(), "Grep".into(), "mcp__github__list-issues".into()];
    let issues = find_inactive_tool_patterns(&patterns, None);
    assert!(issues.is_empty());
}

#[test]
fn find_inactive_wildcard_not_mcp() {
    let patterns = vec!["*".into(), "Read".into()];
    let issues = find_inactive_tool_patterns(&patterns, None);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, InactiveToolPatternKind::WildcardNotMcp);
    assert_eq!(issues[0].pattern, "*");
}

#[test]
fn find_inactive_incomplete_mcp_name() {
    // `mcp__github` doesn't match MCP pattern detection (no glob magic,
    // not a valid MCP tool name), so it falls through to the non-MCP
    // branch and is only flagged when `is_known_tool_name` rejects it.
    let patterns = vec!["mcp__github".into()];
    let issues = find_inactive_tool_patterns(&patterns, None);
    assert!(issues.is_empty(), "no is_known_tool_name: not flagged");

    // With a known-tool-name check that rejects it, it shows as unknown-tool.
    let issues = find_inactive_tool_patterns(&patterns, Some(&|name: &str| {
        name == "Read" || name == "Grep"
    }));
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, InactiveToolPatternKind::UnknownTool);
    assert_eq!(issues[0].pattern, "mcp__github");
}

#[test]
fn find_inactive_unknown_tool() {
    let patterns = vec!["Read".into(), "NopeTool".into()];
    let known = |name: &str| name == "Read" || name == "Grep";
    let issues = find_inactive_tool_patterns(&patterns, Some(&known));
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, InactiveToolPatternKind::UnknownTool);
    assert_eq!(issues[0].pattern, "NopeTool");
}

#[test]
fn find_inactive_mcp_glob_is_valid() {
    // mcp__github__* is a valid MCP glob — should not be flagged
    let patterns = vec!["mcp__github__*".into()];
    let issues = find_inactive_tool_patterns(&patterns, None);
    assert!(issues.is_empty());
}

#[test]
fn find_inactive_skips_known_tools() {
    let patterns = vec!["Read".into(), "Grep".into()];
    let known = |name: &str| name == "Read" || name == "Grep";
    let issues = find_inactive_tool_patterns(&patterns, Some(&known));
    assert!(issues.is_empty());
}

// ── literal_tool_names tests ──────────────────────────────────────────────

#[test]
fn literal_tool_names_filters() {
    let patterns = vec![
        "Read".into(),
        "mcp__github__list-issues".into(),
        "mcp__*".into(),
        "Grep".into(),
    ];
    let literals = literal_tool_names(&patterns);
    assert_eq!(literals, vec!["Read".to_string(), "Grep".to_string()]);
}

// ── GlobPattern tests ─────────────────────────────────────────────────────

#[test]
fn glob_pattern_exact() {
    let gp = GlobPattern::new("Read").unwrap();
    assert!(gp.is_match("Read"));
    assert!(!gp.is_match("Reader"));
}

#[test]
fn glob_pattern_wildcard() {
    let gp = GlobPattern::new("mcp__github__*").unwrap();
    assert!(gp.is_match("mcp__github__list-issues"));
    assert!(gp.is_match("mcp__github__create-pr"));
    assert!(!gp.is_match("mcp__gitlab__list-issues"));
}

#[test]
fn glob_pattern_question_mark() {
    let gp = GlobPattern::new("mcp__github__??-issues").unwrap();
    assert!(gp.is_match("mcp__github__ls-issues"));
    assert!(!gp.is_match("mcp__github__list-issues"));
}

#[test]
fn glob_pattern_invalid() {
    assert!(GlobPattern::new("[invalid").is_err());
}

// ── is_mcp_pattern tests ──────────────────────────────────────────────────

#[test]
fn mcp_pattern_full_name() {
    assert!(is_mcp_pattern("mcp__github__list-issues"));
}

#[test]
fn mcp_pattern_glob() {
    assert!(is_mcp_pattern("mcp__github__*"));
    assert!(is_mcp_pattern("mcp__*"));
}

#[test]
fn mcp_pattern_not_mcp() {
    assert!(!is_mcp_pattern("Read"));
    assert!(!is_mcp_pattern("mcp__github")); // incomplete, not a full name
}

// ── is_mcp_tool_name (re-exported from tool_select) ───────────────────────

#[test]
fn mcp_tool_name_validation() {
    assert!(is_mcp_tool_name("mcp__server__tool"));
    assert!(!is_mcp_tool_name("mcp__server"));
    assert!(!is_mcp_tool_name("mcp__"));
    assert!(!is_mcp_tool_name("Read"));
    assert!(is_mcp_tool_name("mcp__s__t")); // server "s", tool "t"
    assert!(is_mcp_tool_name("mcp__s__t__extra")); // multiple segments
}