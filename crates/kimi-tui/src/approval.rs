//! Approval support — the pending-approval queue, tool-argument previews,
//! dangerous-command detection, and the modal row layout (TS
//! `approval-panel` / `approval/adapter.ts` parity, simplified). Pure
//! functions over wire shapes; the app shell owns polling and resolution.

use crate::i18n::t;
use crate::t;

/// A pending tool approval awaiting an interactive decision (y/n, `v` for
/// details, `s` to approve-for-session).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PendingApproval {
    pub(crate) id: String,
    pub(crate) tool: String,
    /// Matching permission rule label (e.g. "Always allow"), when known.
    pub(crate) rule: String,
    /// Compact preview of the tool arguments (bounded length).
    pub(crate) args: String,
    /// The full tool arguments JSON (for the `v` detail view).
    pub(crate) arguments: String,
}


/// Tool content bodies longer than this many lines are truncated in the
/// approval preview (TS `CONTENT_SUMMARY_MAX_LINES` parity spirit).
const PREVIEW_MAX_LINES: usize = 25;

/// The first present, non-empty string field among `keys`, or `?`.
fn first_str(args: &serde_json::Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| {
            args.get(k)
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("?")
        .to_string()
}


/// Trim `lines` past `PREVIEW_MAX_LINES` (header kept), appending a
/// `… N more lines` hint (i18n).
fn truncate_preview(lines: &mut Vec<String>) {
    if lines.len() <= PREVIEW_MAX_LINES {
        return;
    }
    let hidden = lines.len() - PREVIEW_MAX_LINES;
    lines.truncate(PREVIEW_MAX_LINES);
    lines.push(format!("  {}", t!("tui.approval.moreLines", hidden)));
}


/// Human-readable preview lines for a pending approval's arguments — the
/// tool-specific display blocks (TS `approval-panel` DisplayBlock parity,
/// simplified — no syntax highlighting or diff clustering): Edit renders
/// old/new hunks, Write renders the file content (truncated), Bash the
/// command, Read/Grep/Glob/FsSearch/WebSearch/WebFetch their target,
/// AskUserQuestion the question + options, TodoList the items. Falls back
/// to the raw JSON for other tools.
/// First dangerous-command pattern matched in `command` (TS `detectDanger`
/// parity): returns the i18n key of the first hit, or `None`. The Bash
/// approval preview appends a ⚠ line when a pattern matches.
pub fn detect_danger(command: &str) -> Option<&'static str> {
    const PATTERNS: &[(&str, &str)] = &[
        (
            r"\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)",
            "tui.dangerPatterns.recursiveDelete",
        ),
        (r"\bsudo\b", "tui.dangerPatterns.sudo"),
        (
            r"\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b",
            "tui.dangerPatterns.pipeToShell",
        ),
        (r"\bdd\b[^|]*\bof=", "tui.dangerPatterns.ddWrite"),
        (r"\bmkfs\b", "tui.dangerPatterns.mkfs"),
        (
            r">\s*/dev/(sd|nvme|disk|hd)",
            "tui.dangerPatterns.writeToRawDevice",
        ),
        (
            r"\bchmod\s+-R?\s*777\b",
            "tui.dangerPatterns.chmod777",
        ),
        (
            r":\(\)\s*\{\s*:\|:&\s*\}",
            "tui.dangerPatterns.forkBomb",
        ),
    ];
    PATTERNS.iter().find_map(|(re, key)| {
        regex::Regex::new(re)
            .ok()
            .is_some_and(|rx| rx.is_match(command))
            .then_some(*key)
    })
}


pub(crate) fn approval_preview_lines(tool: &str, arguments: &str) -> Vec<String> {
    let Ok(args) = serde_json::from_str::<serde_json::Value>(arguments) else {
        return vec![arguments.to_string()];
    };
    match tool {
        "Edit" => {
            let path = first_str(&args, &["file_path", "path"]);
            let mut lines = vec![format!("Edit: {path}")];
            let old = args["old_string"].as_str().unwrap_or("");
            let new = args["new_string"].as_str().unwrap_or("");
            if old.is_empty() && new.is_empty() {
                lines.push("(no change)".to_string());
            } else {
                // LCS diff with context clustering (TS `renderDiffLinesClustered`
                // parity); the caller's `Edit: {path}` line stands in for the
                // diff header's path.
                lines.extend(crate::diff::render_diff_clustered(old, new, ""));
            }
            lines
        }
        "Write" => {
            let path = first_str(&args, &["file_path", "path"]);
            let mut lines = vec![format!("Write: {path}")];
            if let Some(content) = args["content"].as_str() {
                lines.extend(content.lines().map(|l| format!("  {l}")));
            }
            truncate_preview(&mut lines);
            lines
        }
        "Bash" => {
            let cmd = first_str(&args, &["command"]);
            let mut lines = vec![format!("Bash: {cmd}")];
            if let Some(key) = detect_danger(&cmd) {
                lines.push(format!("⚠ {}", t(key)));
            }
            lines
        }
        "Read" => vec![format!("Read: {}", first_str(&args, &["path", "file_path"]))],
        "Grep" => vec![format!("grep: {}", first_str(&args, &["pattern"]))],
        "Glob" => vec![format!("glob: {}", first_str(&args, &["pattern"]))],
        "FsSearch" | "WebSearch" => {
            vec![format!("search: {}", first_str(&args, &["query", "pattern"]))]
        }
        "WebFetch" => vec![format!("GET {}", first_str(&args, &["url"]))],
        "Task" => vec![format!(
            "task: {}",
            first_str(&args, &["objective", "description"])
        )],
        "AskUserQuestion" => {
            let question = first_str(&args, &["question"]);
            let mut lines = vec![format!("❓ {question}")];
            if let Some(options) = args["options"].as_array() {
                for (i, opt) in options.iter().enumerate().take(5) {
                    let label = opt["label"].as_str().unwrap_or("?");
                    lines.push(format!("  {}. {label}", i + 1));
                }
                if options.len() > 5 {
                    lines.push(format!("  {}", t!("tui.approval.moreOptions", options.len() - 5)));
                }
            }
            lines
        }
        "TodoList" => match args["todos"].as_array() {
            Some(items) if !items.is_empty() => items
                .iter()
                .take(8)
                .map(|item| {
                    let title = item["title"].as_str().unwrap_or("?");
                    match item["status"].as_str() {
                        Some(status) if !status.is_empty() => format!("  - [{status}] {title}"),
                        _ => format!("  - {title}"),
                    }
                })
                .collect(),
            _ => vec![t!("tui.approval.todoEmpty").to_string()],
        },
        _ => vec![arguments.to_string()],
    }
}


/// The approval-detail modal's text lines (pure, tested).
pub(crate) fn approval_modal_lines(pending: &PendingApproval) -> Vec<String> {
    let mut lines = vec![format!("⚙ {} ({})", pending.tool, pending.rule)];
    lines.extend(approval_preview_lines(&pending.tool, &pending.arguments));
    lines.push(String::new());
    lines.push(t("tui.approval.modalHint").to_string());
    lines
}


/// Compact single-line preview of a tool's arguments (≤ 80 chars, char-safe).
pub(crate) fn args_preview(arguments: &serde_json::Value) -> String {
    let text = serde_json::to_string(arguments).unwrap_or_default();
    if text.chars().count() <= 80 {
        text
    } else {
        let cut: String = text.chars().take(80).collect();
        format!("{cut}…")
    }
}


/// Merge newly fetched approval items into the pending queue (dedup by id).
/// Items whose rule is in `auto_allow_rules` are returned separately so the
/// caller can resolve them automatically (approve-for-session parity).
/// Returns `(newly_queued, auto_resolve_ids)`.
pub(crate) fn queue_new_approvals(
    queue: &mut Vec<PendingApproval>,
    items: &[serde_json::Value],
    auto_allow_rules: &std::collections::HashSet<String>,
) -> (usize, Vec<String>) {
    let mut added = 0;
    let mut auto_resolve = Vec::new();
    for item in items {
        let id = item["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let tool = item["tool_name"].as_str().unwrap_or("?").to_string();
        let rule = item["approval_rule"].as_str().unwrap_or("?").to_string();
        let arguments = item["arguments"].clone();
        let args = args_preview(&arguments);
        let arguments = serde_json::to_string(&arguments).unwrap_or_default();
        if !queue.iter().any(|p| p.id == id) {
            if auto_allow_rules.contains(&rule) {
                auto_resolve.push(id.clone());
                continue;
            }
            queue.push(PendingApproval {
                id,
                tool,
                rule,
                args,
                arguments,
            });
            added += 1;
        }
    }
    (added, auto_resolve)
}
#[cfg(test)]
mod tests {
    use super::*;

#[test]
    fn approval_modal_lines_show_details_and_actions() {
        // Pin the locale: the modal uses the global t(), and the dev machine
        // may have `locale = "zh"` in tui.toml.
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let pending = PendingApproval {
            id: "a1".into(),
            tool: "Bash".into(),
            rule: "Ask".into(),
            args: r#"{"command":"ls"}"#.into(),
            arguments: r#"{"command":"ls"}"#.into(),
        };
        let lines = approval_modal_lines(&pending);
        assert_eq!(lines.len(), 4);
        assert!(lines[0].contains("Bash"), "title: {}", lines[0]);
        assert!(lines[0].contains("Ask"), "rule: {}", lines[0]);
        // The Bash command is parsed into a readable preview line.
        assert_eq!(lines[1], "Bash: ls");
        assert!(
            lines[3].contains("s = allow for session"),
            "actions: {}",
            lines[3]
        );
    }

#[test]
    fn approval_preview_parses_tool_arguments() {
        // Edit renders an LCS diff with context clustering.
        let lines = approval_preview_lines(
            "Edit",
            r#"{"file_path":"a.txt","old_string":"old","new_string":"new line"}"#,
        );
        assert_eq!(lines[0], "Edit: a.txt");
        assert_eq!(lines[1], "+1 -1", "stats header: {lines:?}");
        assert!(
            lines.iter().any(|l| l.ends_with("- old")),
            "lines: {lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.ends_with("+ new line")),
            "lines: {lines:?}"
        );

        // Write renders the file content.
        let lines = approval_preview_lines("Write", r#"{"file_path":"b.txt","content":"hi\nbye"}"#);
        assert_eq!(lines[0], "Write: b.txt");
        assert!(lines.contains(&"  hi".to_string()));

        // Bash shows the command.
        let lines = approval_preview_lines("Bash", r#"{"command":"ls -la"}"#);
        assert_eq!(lines, vec!["Bash: ls -la"]);

        // Bash with a dangerous command appends a ⚠ line.
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let lines = approval_preview_lines("Bash", r#"{"command":"rm -rf /"}"#);
        assert_eq!(lines.len(), 2, "preview: {lines:?}");
        assert!(lines[0].starts_with("Bash: rm -rf /"));
        assert!(lines[1].contains("recursive delete"), "danger: {}", lines[1]);

        // Unknown tools fall back to the raw JSON.
        let lines = approval_preview_lines("Weird", r#"{"x":1}"#);
        assert_eq!(lines, vec![r#"{"x":1}"#]);

        // Unparseable arguments fall back verbatim.
        let lines = approval_preview_lines("Edit", "not json");
        assert_eq!(lines, vec!["not json"]);

        // AskUserQuestion renders the question + numbered options.
        let lines = approval_preview_lines(
            "AskUserQuestion",
            r#"{"question":"Which?","options":[{"label":"A"},{"label":"B","description":"bee"}]}"#,
        );
        assert!(lines[0].starts_with("❓ Which?"), "{}", lines[0]);
        assert!(lines.iter().any(|l| l.contains("1. A")));
        assert!(lines.iter().any(|l| l.contains("2. B")));

        // TodoList renders up to 8 rows with status markers.
        let lines = approval_preview_lines(
            "TodoList",
            r#"{"todos":[{"title":"t1","status":"done"},{"title":"t2"}]}"#,
        );
        assert!(lines.iter().any(|l| l.contains("[done] t1")));
        assert!(lines.iter().any(|l| l.contains("t2")));

        // WebFetch / Task render their target line.
        let lines = approval_preview_lines("WebFetch", r#"{"url":"https://example.com"}"#);
        assert_eq!(lines, vec!["GET https://example.com"]);
        let lines = approval_preview_lines("Task", r#"{"objective":"do the thing"}"#);
        assert_eq!(lines, vec!["task: do the thing"]);

        // Read/Grep/Glob/FsSearch/WebFetch/WebSearch render their target.
        let lines = approval_preview_lines("Read", r#"{"path":"/tmp/x"}"#);
        assert_eq!(lines, vec!["Read: /tmp/x"]);
        let lines = approval_preview_lines("Grep", r#"{"pattern":"fn main"}"#);
        assert_eq!(lines, vec!["grep: fn main"]);
        let lines = approval_preview_lines("Glob", r#"{"pattern":"**/*.rs"}"#);
        assert_eq!(lines, vec!["glob: **/*.rs"]);
        let lines = approval_preview_lines("FsSearch", r#"{"query":"auth"}"#);
        assert_eq!(lines, vec!["search: auth"]);
        let lines = approval_preview_lines("WebSearch", r#"{"query":"rust"}"#);
        assert_eq!(lines, vec!["search: rust"]);
        let lines = approval_preview_lines("WebFetch", r#"{"url":"https://example.com"}"#);
        assert_eq!(lines, vec!["GET https://example.com"]);

        // Task renders its objective (description as fallback).
        let lines = approval_preview_lines("Task", r#"{"objective":"fix tests"}"#);
        assert_eq!(lines, vec!["task: fix tests"]);

        // AskUserQuestion renders the question + option list.
        let lines = approval_preview_lines(
            "AskUserQuestion",
            r#"{"question":"ok?","options":[{"label":"yes"},{"label":"no"}]}"#,
        );
        assert_eq!(lines[0], "❓ ok?");
        assert!(lines.contains(&"  1. yes".to_string()), "lines: {lines:?}");
        assert!(lines.contains(&"  2. no".to_string()), "lines: {lines:?}");

        // TodoList renders the items.
        let lines = approval_preview_lines(
            "TodoList",
            r#"{"todos":[{"title":"A","status":"pending"},{"title":"B"}]}"#,
        );
        assert_eq!(lines, vec!["  - [pending] A", "  - B"]);
    }

#[test]
    fn approval_preview_truncates_long_contents() {
        // Pin the locale: the truncation hint goes through the global t().
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let content = (0..30)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let args = serde_json::json!({ "file_path": "big.txt", "content": content });
        let lines = approval_preview_lines("Write", &args.to_string());
        // Header + PREVIEW_MAX_LINES rows + the truncation hint.
        assert_eq!(lines.len(), PREVIEW_MAX_LINES + 1);
        assert_eq!(lines[0], "Write: big.txt");
        assert_eq!(lines[1], "  line 0");
        let hint = lines.last().unwrap();
        assert!(hint.contains("6 more lines"), "hint: {hint}");
    }

#[test]
    fn queues_approvals_with_dedup() {
        let mut queue = Vec::new();
        let auto = std::collections::HashSet::new();
        // New items are queued in order with their rule + args preview.
        let items = vec![
            serde_json::json!({ "id": "a1", "tool_name": "Bash", "approval_rule": "Always allow", "arguments": { "command": "ls" } }),
            serde_json::json!({ "id": "a2", "tool_name": "Read", "approval_rule": "Ask", "arguments": { "path": "/x" } }),
        ];
        let (added, auto_resolve) = queue_new_approvals(&mut queue, &items, &auto);
        assert_eq!(added, 2);
        assert!(auto_resolve.is_empty(), "no auto rules yet");
        assert_eq!(
            queue,
            vec![
                PendingApproval {
                    id: "a1".into(),
                    tool: "Bash".into(),
                    rule: "Always allow".into(),
                    args: r#"{"command":"ls"}"#.into(),
                    arguments: r#"{"command":"ls"}"#.into(),
                },
                PendingApproval {
                    id: "a2".into(),
                    tool: "Read".into(),
                    rule: "Ask".into(),
                    args: r#"{"path":"/x"}"#.into(),
                    arguments: r#"{"path":"/x"}"#.into(),
                },
            ]
        );
        // Re-fetching the same ids adds nothing.
        assert_eq!(queue_new_approvals(&mut queue, &items, &auto).0, 0);
        // A fresh id appended; items without an id are skipped.
        let more = vec![
            serde_json::json!({ "id": "a3", "tool_name": "Edit", "arguments": { "path": "/y" } }),
            serde_json::json!({ "tool_name": "no-id" }),
        ];
        assert_eq!(queue_new_approvals(&mut queue, &more, &auto).0, 1);
        assert_eq!(queue[2].id, "a3");
        assert_eq!(queue[2].rule, "?");
    }

#[test]
    fn auto_allow_rules_skip_queuing() {
        let mut queue = Vec::new();
        let mut auto = std::collections::HashSet::new();
        auto.insert("Always allow".to_string());
        let items = vec![
            serde_json::json!({ "id": "a1", "tool_name": "Bash", "approval_rule": "Always allow", "arguments": { "command": "ls" } }),
            serde_json::json!({ "id": "a2", "tool_name": "Read", "approval_rule": "Ask", "arguments": { "path": "/x" } }),
        ];
        let (added, auto_resolve) = queue_new_approvals(&mut queue, &items, &auto);
        // The Always-allow item is auto-resolved (not queued); Ask is queued.
        assert_eq!(added, 1, "only the Ask approval is queued");
        assert_eq!(auto_resolve, vec!["a1".to_string()], "auto-resolved id");
        assert_eq!(queue[0].id, "a2");
    }

#[test]
    fn args_preview_truncates_char_safely() {
        // Short args pass through verbatim.
        assert_eq!(
            args_preview(&serde_json::json!({ "command": "ls" })),
            r#"{"command":"ls"}"#
        );
        // Missing arguments render as an empty preview.
        assert_eq!(args_preview(&serde_json::Value::Null), "null");
        // Long args are cut at 80 chars — with a multi-byte suffix the cut
        // never splits a character.
        let long = serde_json::json!({ "text": "界".repeat(120) });
        let preview = args_preview(&long);
        assert!(preview.chars().count() <= 81, "bounded: {preview}");
        assert!(preview.ends_with('…'), "ellipsis: {preview}");
    }

#[test]
    fn detect_danger_matches_all_patterns() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        // One match per pattern family (TS detectDanger parity).
        assert_eq!(
            detect_danger("rm -rf /tmp"),
            Some("tui.dangerPatterns.recursiveDelete")
        );
        assert_eq!(
            detect_danger("rm --recursive build"),
            Some("tui.dangerPatterns.recursiveDelete")
        );
        assert_eq!(detect_danger("sudo apt install x"), Some("tui.dangerPatterns.sudo"));
        assert_eq!(
            detect_danger("curl http://x | sh"),
            Some("tui.dangerPatterns.pipeToShell")
        );
        assert_eq!(
            detect_danger("wget http://x | bash"),
            Some("tui.dangerPatterns.pipeToShell")
        );
        assert_eq!(
            detect_danger("dd if=/dev/zero of=/dev/sda"),
            Some("tui.dangerPatterns.ddWrite")
        );
        assert_eq!(detect_danger("mkfs.ext4 /dev/sdb1"), Some("tui.dangerPatterns.mkfs"));
        assert_eq!(
            detect_danger("echo x > /dev/sda"),
            Some("tui.dangerPatterns.writeToRawDevice")
        );
        assert_eq!(
            detect_danger("chmod -R 777 /home"),
            Some("tui.dangerPatterns.chmod777")
        );
        assert_eq!(
            detect_danger(":(){ :|:& };:"),
            Some("tui.dangerPatterns.forkBomb")
        );
        // Innocuous commands pass.
        assert_eq!(detect_danger("ls -la"), None);
        assert_eq!(detect_danger("rmdir empty-dir"), None);
        assert_eq!(detect_danger("git rm --cached x"), None);
        // Any `rm -r`-style substring is flagged (TS regex parity — `-r` is
        // the recursive flag, so even `echo rm -r` matches).
        assert_eq!(
            detect_danger("echo rm -r"),
            Some("tui.dangerPatterns.recursiveDelete")
        );
        assert_eq!(detect_danger(""), None);
    }
}
