//! Report builders — the multi-line `/status`, `/usage`, `/goal`, `/mcp`,
//! `/plugins` rows and the tool-result chip / relative-time helpers
//! (TS `status-panel` / `usage-panel` / `goal-panel` parity, simplified).
//! Pure functions over wire shapes; the app shell pushes the lines.

use crate::i18n::t;
use crate::t;


/// One-line tool-result summary for the collapsed card body (TS `chip.ts`
/// parity, simplified). Returns `None` for tools without a meaningful
/// summary — the caller falls back to the plain preview.
pub fn tool_result_chip(tool: &str, result: &str, is_error: bool) -> Option<String> {
    if is_error {
        return Some(t!("tui.chip.failed", tool));
    }
    let body = result.trim();
    match tool {
        "Edit" => {
            let first = body.lines().next().unwrap_or("");
            if first.starts_with('+') || first.starts_with('-') {
                Some(t!("tui.chip.edit", first))
            } else {
                Some(t("tui.chip.editOk").to_string())
            }
        }
        "Write" => Some(t!("tui.chip.write", body.lines().count())),
        "Read" => Some(t!("tui.chip.read", body.lines().count())),
        "Bash" => {
            if body.is_empty() {
                Some(t("tui.chip.bashOk").to_string())
            } else {
                let preview: String = body.chars().take(60).collect();
                Some(format!("Bash → {preview}"))
            }
        }
        _ => None,
    }
}


/// `3m ago`-style relative time from an ISO-8601 UTC timestamp (session
/// picker rows; TS session-picker relative-time parity). Unparseable or
/// future timestamps produce an empty string.
pub fn format_relative_time(iso: &str, now_ms: u64) -> String {
    let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) else {
        return String::new();
    };
    let ts = dt.timestamp_millis() as u64;
    if now_ms < ts {
        return String::new(); // future timestamp
    }
    let elapsed = (now_ms - ts) / 1000;
    match elapsed {
        0..=59 => t!("tui.time.sAgo", elapsed),
        60..=3599 => t!("tui.time.mAgo", elapsed / 60),
        3600..=86_399 => t!("tui.time.hAgo", elapsed / 3600),
        _ => t!("tui.time.dAgo", elapsed / 86_400),
    }
}


/// Multi-line `/status` report (TS `status-panel` parity, simplified): one
/// labeled line per field instead of the single-line summary.
pub(crate) fn build_status_report(status: &serde_json::Value, version: &str, session_id: &str) -> Vec<String> {
    let model = status["model"].as_str().unwrap_or("-");
    let permission = status["permission"].as_str().unwrap_or("-");
    let plan = status["plan_mode"].as_bool().unwrap_or(false);
    let swarm = status["swarm_mode"].as_bool().unwrap_or(false);
    let thinking = status["thinking_effort"].as_str().unwrap_or("-");
    let mode = match (plan, swarm) {
        (true, true) => "plan+swarm",
        (true, false) => "plan",
        (false, true) => "swarm",
        (false, false) => "chat",
    };
    let ctx = status["context_tokens"].as_u64().unwrap_or(0);
    let max_ctx = status["max_context_tokens"].as_u64().unwrap_or(0);
    vec![
        t!("tui.status.reportModel", version, model),
        t!("tui.status.reportMode", mode),
        t!("tui.status.reportPermission", permission),
        t!("tui.status.reportThinking", thinking),
        format!(
            "{} {}",
            ctx_bar(ctx, max_ctx),
            t!("tui.status.reportCtx", ctx, max_ctx)
        ),
        t!("tui.status.reportSession", session_id),
    ]
}

/// A 20-cell ASCII context bar (`[████░░░░░░░░░░░░░░░░]`) — the TS
/// status-panel progress-bar parity. Empty when `max_ctx` is 0.
fn ctx_bar(ctx: u64, max_ctx: u64) -> String {
    if max_ctx == 0 {
        return String::new();
    }
    let filled = ((ctx as f64 / max_ctx as f64) * 20.0).round() as usize;
    let filled = filled.min(20);
    format!("[{}{}]", "█".repeat(filled), "░".repeat(20 - filled))
}


/// Multi-line `/usage` report (TS `usage-panel` parity, simplified).
pub(crate) fn build_usage_report(usage: &serde_json::Value) -> Vec<String> {
    let field = |name: &str| -> u64 { usage["total"][name].as_u64().unwrap_or(0) };
    let (input, output, total) = (
        field("input_tokens"),
        field("output_tokens"),
        field("total_tokens"),
    );
    if total == 0 && input == 0 && output == 0 {
        vec![t("tui.usage.none").to_string()]
    } else {
        vec![
            t!("tui.usage.reportTotal", total),
            t!("tui.usage.reportInput", input),
            t!("tui.usage.reportOutput", output),
        ]
    }
}


/// Multi-line `/goal status` report (TS `goal-panel` parity, simplified).
pub(crate) fn build_goal_report(goal: &serde_json::Value) -> Vec<String> {
    let objective = goal["objective"].as_str().unwrap_or("?");
    let status = goal["status"].as_str().unwrap_or("?");
    let turns = goal["turnsUsed"].as_u64().unwrap_or(0);
    let tokens = goal["tokensUsed"].as_u64().unwrap_or(0);
    vec![
        t!("tui.goal.reportObjective", objective),
        t!("tui.goal.reportStatus", status),
        t!("tui.goal.reportTurns", turns),
        t!("tui.goal.reportTokens", tokens),
    ]
}


/// Multi-line MCP server report (TS `mcp-status-panel` parity, simplified):
/// one row per server — name, status, transport, tool count.
pub(crate) fn build_mcp_report(servers: &[serde_json::Value]) -> Vec<String> {
    if servers.is_empty() {
        return vec![t("tui.mcp.none").to_string()];
    }
    servers
        .iter()
        .map(|s| {
            let name = s["name"]
                .as_str()
                .or_else(|| s["server_name"].as_str())
                .unwrap_or("?");
            let status = s["status"].as_str().unwrap_or("?");
            let transport = s["transport"].as_str().unwrap_or("");
            let tools = s["tools"].as_array().map(|a| a.len()).unwrap_or(0);
            let mut line = format!("  {name}  [{status}]");
            if !transport.is_empty() {
                line.push_str(&format!("  ({transport})"));
            }
            if tools > 0 {
                line.push_str(&format!("  {tools} tools"));
            }
            line
        })
        .collect()
}


/// Multi-line plugin report (TS `plugins-status-panel` parity, simplified):
/// one row per plugin — id, on/off state, version.
pub(crate) fn build_plugins_report(plugins: &[serde_json::Value]) -> Vec<String> {
    if plugins.is_empty() {
        return vec![t("tui.plugins.none").to_string()];
    }
    plugins
        .iter()
        .filter_map(|p| {
            let id = p["id"].as_str()?;
            let enabled = p["enabled"].as_bool().unwrap_or(false);
            let version = p["version"].as_str().unwrap_or("");
            let mut line = format!(
                "  {id}  [{}]",
                if enabled {
                    t("tui.status.on")
                } else {
                    t("tui.status.off")
                }
            );
            if !version.is_empty() {
                line.push_str(&format!("  v{version}"));
            }
            Some(line)
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;

#[test]
    fn tool_chip_summarizes_results() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        // Edit: stats header passes through.
        assert!(tool_result_chip("Edit", "+2 -1\n a.txt", false)
            .unwrap()
            .contains("+2 -1"));
        assert!(tool_result_chip("Edit", "done", false)
            .unwrap()
            .contains("ok"));
        // Write / Read: line counts.
        assert!(tool_result_chip("Write", "a\nb\nc", false)
            .unwrap()
            .contains("3 lines"));
        assert!(tool_result_chip("Read", "one\ntwo", false)
            .unwrap()
            .contains("2 lines"));
        // Bash: preview of the tail.
        assert!(tool_result_chip("Bash", "hello world", false)
            .unwrap()
            .contains("hello world"));
        assert!(tool_result_chip("Bash", "", false)
            .unwrap()
            .contains("ok"));
        // Errors mark the tool failed.
        assert!(tool_result_chip("Bash", "boom", true)
            .unwrap()
            .contains("failed"));
        // Unknown tools fall back (None).
        assert_eq!(tool_result_chip("WebSearch", "results", false), None);
    }

#[test]
    fn relative_time_formats_from_iso_timestamps() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        // 2027-01-01T00:00:00Z in epoch ms.
        let iso_ms = 1_798_761_600_000u64;
        assert_eq!(format_relative_time("2027-01-01T00:00:00Z", iso_ms), "0s ago");
        assert_eq!(
            format_relative_time("2027-01-01T00:00:00Z", iso_ms + 45_000),
            "45s ago"
        );
        assert_eq!(
            format_relative_time("2027-01-01T00:00:00Z", iso_ms + 180_000),
            "3m ago"
        );
        assert_eq!(
            format_relative_time("2027-01-01T00:00:00Z", iso_ms + 7_200_000),
            "2h ago"
        );
        assert_eq!(
            format_relative_time("2027-01-01T00:00:00Z", iso_ms + 172_800_000),
            "2d ago"
        );
        // Unparseable / future timestamps -> empty.
        assert_eq!(format_relative_time("not-a-date", iso_ms), "");
        assert_eq!(format_relative_time("2027-01-01T00:00:00Z", 0), "");
        assert_eq!(format_relative_time("2027-01-02T00:00:00Z", iso_ms), "");
    }

#[test]
    fn status_report_renders_labeled_lines() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let status = serde_json::json!({
            "model": "kimi-k2",
            "permission": "auto",
            "plan_mode": true,
            "swarm_mode": false,
            "thinking_effort": "high",
            "context_tokens": 1200,
            "max_context_tokens": 128000,
        });
        let lines = build_status_report(&status, "0.1.0", "sess-1");
        assert_eq!(lines.len(), 6);
        assert!(lines[0].contains("kimi 0.1.0"), "{}", lines[0]);
        assert!(lines[0].contains("kimi-k2"));
        assert!(lines[1].contains("plan"), "mode: {}", lines[1]);
        assert!(lines[2].contains("auto"), "permission: {}", lines[2]);
        assert!(lines[3].contains("high"), "thinking: {}", lines[3]);
        assert!(lines[4].contains("1200/128000"), "ctx: {}", lines[4]);
        assert!(lines[5].contains("sess-1"), "session: {}", lines[5]);
    }

#[test]
    fn usage_report_renders_three_lines_or_none() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let usage = serde_json::json!({
            "total": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 }
        });
        let lines = build_usage_report(&usage);
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("30"), "{}", lines[0]);
        assert!(lines[1].contains("10"));
        assert!(lines[2].contains("20"));
        // Empty usage -> single "none" line.
        let empty = build_usage_report(&serde_json::json!({ "total": {} }));
        assert_eq!(empty.len(), 1);
        assert!(empty[0].contains("no"), "{}", empty[0]);
    }

#[test]
    fn goal_report_renders_objective_status_and_counts() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let goal = serde_json::json!({
            "objective": "fix the build",
            "status": "active",
            "turnsUsed": 3,
            "tokensUsed": 9000,
        });
        let lines = build_goal_report(&goal);
        assert_eq!(lines.len(), 4);
        assert!(lines[0].contains("fix the build"), "{}", lines[0]);
        assert!(lines[1].contains("active"));
        assert!(lines[2].contains("3"));
        assert!(lines[3].contains("9000"));
    }

#[test]
    fn mcp_report_renders_server_rows() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let servers = vec![
            serde_json::json!({
                "name": "filesystem",
                "status": "connected",
                "transport": "stdio",
                "tools": [{ "name": "read" }, { "name": "write" }],
            }),
            serde_json::json!({
                "server_name": "github",
                "status": "failed",
            }),
        ];
        let lines = build_mcp_report(&servers);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("filesystem"), "{}", lines[0]);
        assert!(lines[0].contains("connected"));
        assert!(lines[0].contains("stdio"));
        assert!(lines[0].contains("2 tools"));
        assert!(lines[1].contains("github"), "{}", lines[1]);
        assert!(lines[1].contains("failed"));
        // Empty -> none line.
        assert_eq!(build_mcp_report(&[]).len(), 1);
    }

#[test]
    fn plugins_report_renders_plugin_rows() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let plugins = vec![
            serde_json::json!({
                "id": "kimi-plugins",
                "enabled": true,
                "version": "0.3.0",
            }),
            serde_json::json!({
                "id": "old-plugin",
                "enabled": false,
            }),
        ];
        let lines = build_plugins_report(&plugins);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("kimi-plugins"), "{}", lines[0]);
        assert!(lines[0].contains("[on]"));
        assert!(lines[0].contains("v0.3.0"));
        assert!(lines[1].contains("[off]"), "{}", lines[1]);
        assert!(!lines[1].contains('v'), "no version: {}", lines[1]);
    }

    #[test]
    fn ctx_bar_scales_and_clamps() {
        // Full, half, empty, and unknown-max cases.
        assert_eq!(ctx_bar(128_000, 128_000), "[████████████████████]");
        assert_eq!(
            ctx_bar(64_000, 128_000),
            "[██████████░░░░░░░░░░]"
        );
        assert_eq!(ctx_bar(0, 128_000), "[░░░░░░░░░░░░░░░░░░░░]");
        // Unknown max -> no bar.
        assert_eq!(ctx_bar(100, 0), "");
        // Overflow clamps to full.
        assert_eq!(ctx_bar(200_000, 128_000), "[████████████████████]");
        // The /status report embeds the bar before the token readout.
        let status = serde_json::json!({
            "model": "kimi-k2",
            "permission": "auto",
            "plan_mode": false,
            "swarm_mode": false,
            "thinking_effort": "high",
            "context_tokens": 64_000,
            "max_context_tokens": 128_000,
        });
        let lines = build_status_report(&status, "0.1.0", "sess-1");
        assert!(lines[4].contains('█'), "bar: {}", lines[4]);
        assert!(lines[4].contains("64000/128000"), "{}", lines[4]);
    }
}
