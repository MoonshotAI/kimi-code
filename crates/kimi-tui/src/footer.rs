//! Footer status bar — two lines below the input pane (TS `footer.ts`
//! parity, simplified). Line 1: mode badges + model + cwd + git branch,
//! with a rotating tip right-aligned; line 2: context usage right-aligned.
//! Pure over [`FooterInfo`], so it is unit-testable without a terminal.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};

use crate::i18n::t;
use crate::t;
use crate::theme::Theme;

/// Live session status for the footer strip, refreshed from
/// `session/get_status` plus the working directory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FooterInfo {
    pub plan: bool,
    pub swarm: bool,
    pub auto: bool,
    pub yolo: bool,
    pub model: String,
    /// Context tokens as a percentage of the window (0..=100).
    pub ctx_pct: u8,
    pub cwd: String,
    pub branch: Option<String>,
    /// Pre-formatted goal badge (`[goal ● active · 3 turns]`), driven by
    /// `session.goal.updated` events (TS `formatGoalBadge` parity).
    pub goal: Option<String>,
}

impl FooterInfo {
    /// Build from a `session/get_status` result; `cwd` and `branch` come
    /// from the process working directory + `.git/HEAD` (no subprocess).
    pub fn from_status(status: &serde_json::Value) -> Self {
        let ctx = status["context_tokens"].as_u64().unwrap_or(0);
        let max = status["max_context_tokens"].as_u64().unwrap_or(0);
        let ctx_pct = if max > 0 { ((ctx * 100) / max).min(100) as u8 } else { 0 };
        let permission = status["permission"].as_str().unwrap_or("");
        let cwd = std::env::current_dir()
            .ok()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        Self {
            plan: status["plan_mode"].as_bool().unwrap_or(false),
            swarm: status["swarm_mode"].as_bool().unwrap_or(false),
            auto: permission == "auto",
            yolo: permission == "yolo",
            model: status["model"].as_str().unwrap_or("-").to_string(),
            ctx_pct,
            cwd,
            branch: current_git_branch(),
            goal: None,
        }
    }
}

/// Format a goal badge from a `session.goal.updated` payload (TS
/// `formatGoalBadge` parity, simplified). `None` for terminal/no goal.
pub fn format_goal_badge(goal: &serde_json::Value) -> Option<String> {
    let status = goal["status"].as_str()?;
    if !matches!(status, "active" | "paused" | "blocked") {
        return None;
    }
    let dot = if status == "active" { "●" } else { "○" };
    let turns = goal["turnsUsed"].as_u64().unwrap_or(0);
    Some(format!("[goal {dot} {status} · {turns} {}]", crate::i18n::t("tui.footer.turns")))
}

/// The current git branch by parsing `.git/HEAD` (cheap, no subprocess).
fn current_git_branch() -> Option<String> {
    let head = std::env::current_dir().ok()?.join(".git").join("HEAD");
    let text = std::fs::read_to_string(head).ok()?;
    text.strip_prefix("ref: refs/heads/")
        .map(|b| b.trim().to_string())
}

/// Shorten a working directory for the footer (TS `shortenCwd` parity):
/// `~` for the home dir, then at most 3 path segments.
fn shorten_cwd(path: &str) -> String {
    if path.is_empty() {
        return path.to_string();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() {
        if path == home {
            return "~".to_string();
        }
        let prefix = format!("{home}/");
        if let Some(rest) = path.strip_prefix(&prefix) {
            return format!("~/{rest}");
        }
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() <= 3 {
        path.to_string()
    } else {
        format!("…/{}", segments[segments.len() - 3..].join("/"))
    }
}

/// The tip keys, rotated on a 10s cadence.
const TIP_KEYS: &[&str] = &[
    "tui.tip.0",
    "tui.tip.1",
    "tui.tip.2",
    "tui.tip.3",
    "tui.tip.4",
    "tui.tip.5",
];

/// Which tip to show now (time-based, so it rotates while idle).
pub fn tip_index() -> usize {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (secs / 10) as usize % TIP_KEYS.len()
}

/// The two footer lines for a `width`-wide pane: the status strip with a
/// right-aligned tip, then right-aligned context usage.
pub fn footer_lines(info: &FooterInfo, theme: Theme, width: u16) -> Vec<RenderLine<'static>> {
    // Line 1 — left: `[auto] [yolo] [plan] [swarm] model  cwd  (branch)`.
    let mut spans: Vec<Span<'static>> = Vec::new();
    for (label, on) in [
        ("auto", info.auto),
        ("yolo", info.yolo),
        ("plan", info.plan),
        ("swarm", info.swarm),
    ] {
        if on {
            spans.push(Span::styled(
                format!("[{label}] "),
                Style::default().fg(theme.assistant).add_modifier(Modifier::BOLD),
            ));
        }
    }
    if let Some(goal) = &info.goal {
        spans.push(Span::styled(
            format!("{goal} "),
            Style::default().fg(theme.status),
        ));
    }
    spans.push(Span::styled(
        info.model.clone(),
        Style::default().fg(theme.status),
    ));
    let cwd = shorten_cwd(&info.cwd);
    if !cwd.is_empty() {
        spans.push(Span::styled(
            format!("  {cwd}"),
            Style::default().fg(theme.thinking),
        ));
    }
    if let Some(branch) = &info.branch {
        spans.push(Span::styled(
            format!(" ({branch})"),
            Style::default().fg(theme.thinking),
        ));
    }
    let strip_width: usize = spans.iter().map(|s| s.width()).sum();

    // Right-aligned rotating tip on line 1.
    let tip_text = t(TIP_KEYS[tip_index()]);
    let tip_span = Span::styled(tip_text, Style::default().fg(theme.thinking));
    let tip_width = tip_span.width();
    let pad = (width as usize).saturating_sub(strip_width + 1 + tip_width);
    spans.push(Span::raw(" ".repeat(pad + 1)));
    spans.push(tip_span);
    let line1 = RenderLine::from(spans);

    // Line 2 — right-aligned context usage.
    let ctx_text = t!("tui.footer.ctx", info.ctx_pct);
    let ctx_line = RenderLine::from(Span::styled(
        ctx_text.clone(),
        Style::default().fg(theme.status),
    ));
    let ctx_width = ctx_line.width();
    let pad2 = (width as usize).saturating_sub(ctx_width);
    let line2 = RenderLine::from(vec![
        Span::raw(" ".repeat(pad2)),
        Span::styled(ctx_text, Style::default().fg(theme.status)),
    ]);

    vec![line1, line2]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Locale;

    #[test]
    fn from_status_parses_modes_and_context() {
        let status = serde_json::json!({
            "plan_mode": true,
            "swarm_mode": false,
            "permission": "yolo",
            "model": "kimi-k2",
            "context_tokens": 300,
            "max_context_tokens": 1000,
        });
        let info = FooterInfo::from_status(&status);
        assert!(info.plan);
        assert!(!info.swarm);
        assert!(info.yolo);
        assert!(!info.auto);
        assert_eq!(info.model, "kimi-k2");
        assert_eq!(info.ctx_pct, 30);
    }

    #[test]
    fn context_percentage_clamps() {
        let info = FooterInfo::from_status(&serde_json::json!({
            "context_tokens": 5000,
            "max_context_tokens": 1000,
        }));
        assert_eq!(info.ctx_pct, 100);
        let info = FooterInfo::from_status(&serde_json::json!({}));
        assert_eq!(info.ctx_pct, 0);
    }

    #[test]
    fn footer_lines_render_modes_and_usage() {
        // Pin En so assertions are stable regardless of the dev tui.toml.
        crate::i18n::set_locale(Locale::En);
        let info = FooterInfo {
            plan: true,
            swarm: false,
            auto: true,
            yolo: false,
            model: "kimi-k2".into(),
            ctx_pct: 30,
            cwd: "/work".into(),
            branch: Some("main".into()),
            goal: Some("[goal ● active · 3 turns]".into()),
        };
        let lines = footer_lines(&info, Theme::dark(), 80);
        assert_eq!(lines.len(), 2);
        let strip: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert!(strip.contains("[auto]"), "strip: {strip}");
        assert!(strip.contains("[plan]"), "strip: {strip}");
        assert!(strip.contains("kimi-k2"), "strip: {strip}");
        assert!(strip.contains("/work"), "strip: {strip}");
        assert!(strip.contains("(main)"), "strip: {strip}");
        assert!(strip.contains("[goal ● active"), "goal badge: {strip}");
        // The current tip text right-aligns on line 1 (no prefix, TS parity).
        let tip_text = crate::i18n::t(TIP_KEYS[tip_index()]);
        assert!(strip.contains(tip_text), "tip on line 1: {strip}");
        let usage: String = lines[1].spans.iter().map(|s| s.content.clone()).collect();
        assert!(usage.contains("ctx: 30%"), "usage: {usage}");
    }

    #[test]
    fn cwd_shortening() {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            assert_eq!(shorten_cwd(&home), "~");
            assert_eq!(shorten_cwd(&format!("{home}/a/b")), "~/a/b");
        }
        assert_eq!(shorten_cwd("/a/b/c/d/e"), "…/c/d/e");
        assert_eq!(shorten_cwd("/a/b/c"), "/a/b/c");
        assert_eq!(shorten_cwd(""), "");
    }

    #[test]
    fn tip_index_rotates_within_bounds() {
        for _ in 0..10 {
            let idx = tip_index();
            assert!(idx < TIP_KEYS.len(), "idx {idx}");
        }
    }

    #[test]
    fn goal_badge_formats_live_goals() {
        // Pin En so the "turns" label is stable.
        crate::i18n::set_locale(Locale::En);
        let goal = serde_json::json!({ "status": "active", "turnsUsed": 3 });
        let badge = format_goal_badge(&goal).expect("badge");
        assert_eq!(badge, "[goal ● active · 3 turns]");
        // Terminal / no goal → None.
        assert!(format_goal_badge(&serde_json::json!({ "status": "complete" })).is_none());
        assert!(format_goal_badge(&serde_json::json!({})).is_none());
    }
}
