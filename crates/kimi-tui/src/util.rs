//! Free-standing helpers extracted from `app.rs`: terminal setup/teardown,
//! command aliasing, `/discuss` argument parsing, markdown export, clipboard
//! copy, and the interrupt-action mapping. No `App` state dependency.

use std::io;

use crossterm::event::{KeyCode, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::app::{TranscriptEntry, TranscriptKind};

/// An interrupt a running turn should react to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InterruptAction {
    /// Abort the current turn via the session cancel flag.
    CancelTurn,
}


/// Generate a fresh session id for `/new` (timestamp-based, unique enough for
/// an interactive session).
pub(crate) fn fresh_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis:x}")
}


/// Map a pressed key to an interrupt action (pure, tested).
pub(crate) fn interrupt_action(code: KeyCode, modifiers: KeyModifiers) -> Option<InterruptAction> {
    match code {
        KeyCode::Esc => Some(InterruptAction::CancelTurn),
        KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
            Some(InterruptAction::CancelTurn)
        }
        _ => None,
    }
}


/// Alias resolution (TS registry aliases parity).
pub(crate) fn resolve_alias(cmd: &str) -> &str {
    match cmd {
        "/yes" => "/yolo",
        "/h" | "/?" => "/help",
        "/q" => "/quit",
        "/rename" => "/title",
        "/task" => "/tasks",
        "/effort" => "/thinking",
        "/providers" => "/provider",
        "/disconnect" => "/logout",
        _ => cmd,
    }
}

/// Parsed `/discuss` arguments.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DiscussArgs {
    pub(crate) topic: String,
    pub(crate) roles: Vec<String>,
    pub(crate) debate: bool,
}


/// Parse `/discuss <topic> [with <r1>,<r2>,...] [--debate]` (TS
/// `parseDiscussArgs` parity, simplified — no role stances). Defaults to
/// the researcher/architect/engineer trio when no roles are given.
pub(crate) fn parse_discuss(args: &str) -> Result<DiscussArgs, &'static str> {
    let trimmed = args.trim();
    if trimmed.is_empty() {
        return Err("usage");
    }
    let (debate, remaining) = match trimmed.strip_prefix("--debate") {
        Some(rest) => (true, rest.trim_start()),
        None => (false, trimmed),
    };
    let with_re = regex::Regex::new(r"(?i)\s+with\s+").expect("valid with-regex");
    let mut parts = with_re.splitn(remaining, 2);
    let topic = parts.next().unwrap_or("").trim();
    let roles_raw = parts.next().unwrap_or("");
    if topic.is_empty() {
        return Err("need-topic");
    }
    let roles: Vec<String> = if roles_raw.is_empty() {
        vec!["researcher".into(), "architect".into(), "engineer".into()]
    } else {
        roles_raw
            .split(',')
            .map(|r| r.trim())
            .filter(|r| !r.is_empty())
            .map(str::to_string)
            .collect()
    };
    if roles.len() < 2 {
        return Err("need-roles");
    }
    Ok(DiscussArgs {
        topic: topic.to_string(),
        roles,
        debate,
    })
}


/// The newest assistant reply's text (TS `findLastAssistantText` parity):
/// sourced from the rendered transcript so it survives compaction.
pub(crate) fn find_last_assistant_text(transcript: &[TranscriptEntry]) -> Option<String> {
    transcript.iter().rev().find_map(|entry| match entry {
        TranscriptEntry::Line(line) if line.kind == TranscriptKind::Assistant => {
            let text = line.text.trim();
            (!text.is_empty()).then(|| line.text.clone())
        }
        _ => None,
    })
}


/// Copy text to the system clipboard (Windows via `Set-Clipboard`).
pub(crate) fn copy_to_clipboard(text: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        // Single-quote escaping: `''` is a literal quote inside a PS string.
        let escaped = text.replace('\'', "''");
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                &format!("Set-Clipboard -Value '{}'", escaped),
            ])
            .status()?;
        if !status.success() {
            anyhow::bail!("Set-Clipboard exited with {status}");
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        anyhow::bail!("clipboard is not supported on this platform")
    }
}


/// Render the visible transcript as Markdown (simplified `/export-md`).
pub(crate) fn transcript_to_markdown(transcript: &[TranscriptEntry]) -> String {
    let mut md = String::new();
    for entry in transcript {
        match entry {
            TranscriptEntry::Line(line) => match line.kind {
                TranscriptKind::User => md.push_str(&format!("## User\n\n{}\n\n", line.text)),
                TranscriptKind::Assistant | TranscriptKind::Streaming => {
                    md.push_str(&format!("## Assistant\n\n{}\n\n", line.text))
                }
                TranscriptKind::Tool => md.push_str(&format!("```\n{}\n```\n\n", line.text)),
                _ => {}
            },
            TranscriptEntry::ToolCall(tc) => {
                md.push_str(&format!("## Tool: {}\n\n```\n", tc.tool_name));
                if let Some(result) = &tc.result {
                    md.push_str(result);
                }
                md.push_str("\n```\n\n");
            }
            TranscriptEntry::Task(task) => {
                let status = if task.ended { task.status.as_str() } else { "running" };
                let description = if task.description.is_empty() {
                    task.task_id.clone()
                } else {
                    task.description.clone()
                };
                md.push_str(&format!("## Task: {description} ({status})\n\n"));
            }
        }
    }
    md
}


pub(crate) fn init_terminal() -> anyhow::Result<Terminal<CrosstermBackend<io::Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    crossterm::execute!(
        stdout,
        EnterAlternateScreen,
        crossterm::event::EnableBracketedPaste
    )?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}


pub(crate) fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> anyhow::Result<()> {
    disable_raw_mode()?;
    crossterm::execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        crossterm::event::DisableBracketedPaste
    )?;
    Ok(())
}