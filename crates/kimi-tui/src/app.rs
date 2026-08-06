//! The TUI application: terminal setup, event loop, and rendering.

use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Terminal;

use kimi_sdk::Harness;

/// All slash commands the chat surface understands (shared with `/help`).
use crate::bottom_pane::SLASH_COMMANDS;



/// The role/source of a transcript line, driving its render style.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    /// The user's own prompt (`▶ …`).
    User,
    /// Assistant text (final transcript of a turn).
    Assistant,
    /// Live assistant text streamed via `llm.delta` events (replaced by the
    /// final transcript when the turn ends).
    Streaming,
    /// Live model reasoning streamed via `llm.delta` think parts (transient —
    /// dropped when the turn ends, never part of the transcript).
    Thinking,
    /// Engine tool progress (`⚙ …`).
    Tool,
    /// Status / informational messages (command echoes, engine events).
    Status,
    /// Errors.
    Error,
}

/// A structured transcript entry: a plain line, or a tool-call card (the
/// chatwidget component-tree step — TS `tool-call.ts` parity).
#[derive(Debug, Clone, PartialEq)]
pub enum TranscriptEntry {
    /// A role-styled line (user/assistant/status/…).
    Line(TranscriptLine),
    /// A structured tool call with args + optional result (collapsible).
    ToolCall(ToolCallEntry),
}

/// One tool invocation in the transcript: starts on `session.tool.started`,
/// gains its result on `session.tool.settled`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallEntry {
    pub tool_call_id: String,
    pub tool_name: String,
    /// The tool arguments JSON.
    pub args: String,
    /// The settled result text (None while running).
    pub result: Option<String>,
    pub is_error: bool,
    /// Long results start collapsed (`[+]`; Ctrl-O toggles).
    pub collapsed: bool,
}

/// Convenience push for the common plain-line case (`transcript.push_line`).
pub trait TranscriptVec {
    fn push_line(&mut self, line: TranscriptLine);
}

impl TranscriptVec for Vec<TranscriptEntry> {
    fn push_line(&mut self, line: TranscriptLine) {
        self.push(TranscriptEntry::Line(line));
    }
}

/// A single transcript line: text plus the role it renders as.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptLine {
    pub kind: TranscriptKind,
    pub text: String,
    /// Long tool-result lines start collapsed (single-line preview + `[+]`);
    /// Ctrl-O toggles the most recent collapsed tool line.
    pub collapsed: bool,
}

impl TranscriptLine {
    pub fn user(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::User, text: text.into(), collapsed: false }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Assistant, text: text.into(), collapsed: false }
    }
    pub fn streaming(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Streaming, text: text.into(), collapsed: false }
    }
    pub fn thinking(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Thinking, text: text.into(), collapsed: false }
    }
    pub fn tool(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Tool, text: text.into(), collapsed: false }
    }
    /// A tool-result line that starts collapsed (long output).
    pub fn tool_collapsed(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Tool, text: text.into(), collapsed: true }
    }
    pub fn status(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Status, text: text.into(), collapsed: false }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Error, text: text.into(), collapsed: false }
    }
}
/// State for an in-progress Tab completion cycle.
#[derive(Debug, Clone, PartialEq)]
struct TabState {
    /// The input as it was when the cycle started (matches cycle on this).
    base: String,
    /// Index into the current match list.
    idx: usize,
}

/// A pending tool approval awaiting an interactive decision (y/n, `v` for
/// details, `s` to approve-for-session).
#[derive(Debug, Clone, PartialEq)]
struct PendingApproval {
    id: String,
    tool: String,
    /// Matching permission rule label (e.g. "Always allow"), when known.
    rule: String,
    /// Compact preview of the tool arguments (bounded length).
    args: String,
    /// The full tool arguments JSON (for the `v` detail view).
    arguments: String,
}

/// Active slash-command completion popup: the matching commands shown above
/// the input while typing `/…` (↑/↓ to move, Enter to fill, Esc to close).
/// Each entry is `(command, description)` for the description column.
#[derive(Debug, Clone, PartialEq)]
pub struct CompletionState {
    pub matches: Vec<(String, String)>,
    pub selected: usize,
}

/// Tool output above this length starts collapsed in the transcript (`[+]`;
/// Ctrl-O to expand) — the tool-call card fold threshold.
pub const TOOL_COLLAPSE_THRESHOLD: usize = 120;

/// A tool-result line with long output starts collapsed (`[+]`; Ctrl-O to
/// expand) — the tool-call card fold. Short results stay expanded.
pub fn tool_result_collapsed(text: &str) -> bool {
    text.chars().count() > TOOL_COLLAPSE_THRESHOLD
}

/// The approval-detail modal's text lines (pure, tested).
pub fn approval_modal_lines(pending: &PendingApproval) -> Vec<String> {
    vec![
        format!("⚙ {} ({})", pending.tool, pending.rule),
        pending.arguments.clone(),
        String::new(),
        "y = allow    n = deny    s = allow for session    Esc = close".to_string(),
    ]
}

/// The slash-command completion popup state for an input, or `None` when the
/// input is not a bare `/prefix`. Entries carry the command's description
/// (TS registry parity).
pub fn completion_for_input(input: &str) -> Option<CompletionState> {
    if !input.starts_with('/') || input.contains(' ') {
        return None;
    }
    let matches: Vec<(String, String)> = crate::bottom_pane::COMMAND_DESCRIPTIONS
        .iter()
        .filter(|(name, _)| name.starts_with(input))
        .map(|(name, desc)| (name.to_string(), desc.to_string()))
        .collect();
    if matches.is_empty() {
        None
    } else {
        Some(CompletionState { matches, selected: 0 })
    }
}

/// Toggle the most recent tool-result card (Ctrl-O) — expand/collapse. Cards
/// with a long argument preview or an already-collapsed state participate;
/// short running cards stay put.
pub fn toggle_last_tool_collapse(transcript: &mut [TranscriptEntry]) {
    if let Some(entry) = transcript.iter_mut().rev().find(|e| match e {
        TranscriptEntry::ToolCall(tc) => {
            tc.collapsed
                || tc.args.chars().count() > TOOL_COLLAPSE_THRESHOLD
                || tc.result.as_ref().is_some_and(|r| r.chars().count() > TOOL_COLLAPSE_THRESHOLD)
        }
        _ => false,
    }) {
        if let TranscriptEntry::ToolCall(tc) = entry {
            tc.collapsed = !tc.collapsed;
        }
    }
}

/// Compact single-line preview of a tool's arguments (≤ 80 chars, char-safe).
fn args_preview(arguments: &serde_json::Value) -> String {
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
fn queue_new_approvals(
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
            queue.push(PendingApproval { id, tool, rule, args, arguments });
            added += 1;
        }
    }
    (added, auto_resolve)
}

/// An interrupt a running turn should react to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InterruptAction {
    /// Abort the current turn via the session cancel flag.
    CancelTurn,
}

/// Render a `session/get_status` result as a one-line human summary
/// (model · mode · permission · thinking · context) instead of raw JSON.
fn format_status(status: &serde_json::Value) -> String {
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
    format!("model: {model} | mode: {mode} | permission: {permission} | thinking: {thinking} | ctx: {ctx}/{max_ctx}")
}

/// Render a token-usage snapshot (`{total: {input/output/total_tokens}}`) as
/// a one-line summary instead of raw JSON.
fn format_usage(usage: &serde_json::Value) -> String {
    let field = |name: &str| -> u64 {
        usage["total"][name].as_u64().unwrap_or(0)
    };
    let (input, output, total) = (field("input_tokens"), field("output_tokens"), field("total_tokens"));
    if total == 0 && input == 0 && output == 0 {
        "usage: no tokens recorded".to_string()
    } else {
        format!("usage: {total} total ({input} in / {output} out)")
    }
}

/// Generate a fresh session id for `/new` (timestamp-based, unique enough for
/// an interactive session).
fn fresh_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis:x}")
}

/// Map a pressed key to an interrupt action (pure, tested).
fn interrupt_action(code: KeyCode, modifiers: event::KeyModifiers) -> Option<InterruptAction> {    match code {
        KeyCode::Esc => Some(InterruptAction::CancelTurn),
        KeyCode::Char('c') if modifiers.contains(event::KeyModifiers::CONTROL) => {
            Some(InterruptAction::CancelTurn)
        }
        _ => None,
    }
}

// ── Input editing primitives ──────────────────────────────────────────────
// The input cursor is a char index (UTF-8 safe); byte offsets are computed
// only at edit boundaries. Every function clamps an out-of-range cursor.
/// The interactive chat application.
pub struct App {
    harness: Harness,
    /// Transcript lines rendered in the chat panel.
    transcript: Vec<TranscriptEntry>,
    /// The user's current input line.
    input: String,
    /// Char index of the input cursor (editing position).
    cursor: usize,
    /// Prompt history (up/down).
    history: Vec<String>,
    history_idx: Option<usize>,
    session_id: String,
    /// When true (App::new(None)), the startup flow offers a session picker.
    startup_pick: bool,
    session: Option<kimi_sdk::Session>,
    /// Model aliases for `/model` Tab completion.
    model_aliases: Vec<String>,
    /// Active Tab completion cycle, if any.
    tab: Option<TabState>,
    /// Pending tool approvals queued for interactive y/n resolution.
    pending_approvals: Vec<PendingApproval>,
    /// Active slash-command completion popup (None when not typing `/…`).
    completion: Option<CompletionState>,
    /// Full-screen approval detail modal (the `v` key), when open.
    approval_detail: Option<PendingApproval>,
    /// Permission rules the user approved "for this session": future
    /// approvals matching these rules resolve automatically (TS
    /// approve-for-session parity).
    auto_allow_rules: std::collections::HashSet<String>,
    /// Transcript scroll offset (lines from the bottom).
    scroll: u16,
    /// Session status summary for the footer (plan/swarm).
    status: String,
    /// Semantic color palette resolved from `tui.toml`.
    theme: crate::theme::Theme,
    /// Whether the dark palette is active (`/theme` toggles this).
    dark_mode: bool,
}

impl App {
    /// Push a plain line onto the transcript (the common case).
    fn push_line(&mut self, line: TranscriptLine) {
        self.transcript.push(TranscriptEntry::Line(line));
    }

    /// Create the app around an engine harness (embedded or remote).
    pub fn new(harness: Harness, session_id: Option<&str>) -> Self {
        Self {
            harness,
            transcript: Vec::new(),
            input: String::new(),
            cursor: 0,
            history: Vec::new(),
            history_idx: None,
            session_id: session_id.unwrap_or_default().to_string(),
            startup_pick: session_id.is_none(),
            session: None,
            model_aliases: Vec::new(),
            tab: None,
            pending_approvals: Vec::new(),
            completion: None,
            approval_detail: None,
            auto_allow_rules: std::collections::HashSet::new(),
            scroll: 0,
            status: String::new(),
            theme: crate::theme::load_theme(),
            dark_mode: true,
        }
    }

    /// Run the event loop until the user quits (`/quit` or Ctrl-C).
    pub async fn run(&mut self) -> anyhow::Result<()> {
        // Startup picker: when no session was requested and persisted
        // sessions exist, offer an interactive choice (resume UX parity).
        if self.startup_pick {
            let sessions = self.harness.list_sessions(50).await?;
            let items: Vec<(String, String)> = sessions
                .iter()
                .filter_map(|s| {
                    let id = s["id"].as_str()?.to_string();
                    let title = s["title"].as_str().unwrap_or("(untitled)").to_string();
                    Some((id, title))
                })
                .collect();
            if !items.is_empty() {
                let mut terminal = init_terminal()?;
                let picked = crate::picker::select(
                    &mut terminal,
                    self.theme,
                    "resume a session (Esc = new)",
                    &items,
                )?;
                restore_terminal(&mut terminal)?;
                if let Some(id) = picked {
                    self.session_id = id;
                }
            }
            self.startup_pick = false;
        }
        // Open the session up front.
        let mut session = self.harness.create_session(&self.session_id).await?;
        // Resume semantics: create rebuilds a fresh agent, load re-applies
        // the persisted context + goal for an existing session (no-op for a
        // brand-new one).
        let _ = session.load().await;
        // Rebuild the transcript from the persisted context (resume UX
        // parity): the user sees the conversation history instead of a blank
        // chat, exactly as it ended.
        let context = session.get_context().await;
        let history = crate::history::render_history(&context["result"]);
        self.transcript.extend(history);
        // Seed the footer status (best-effort) before the session moves.
        let status = session.get_status().await;
        let plan = status["result"]["plan_mode"].as_bool().unwrap_or(false);
        let swarm = status["result"]["swarm_mode"].as_bool().unwrap_or(false);
        self.status = format!("plan={} swarm={}", if plan { "on" } else { "off" }, if swarm { "on" } else { "off" });
        self.session = Some(session);
        self.push_line(TranscriptLine::status(format!("session {} ready — type /help", self.session_id)));
        // Preload model aliases for `/model` Tab completion (best-effort).
        if let Ok((aliases, _)) = self.harness.list_models().await {
            self.model_aliases = aliases;
        }

        let mut terminal = init_terminal()?;
        let result = self.event_loop(&mut terminal).await;
        restore_terminal(&mut terminal)?;
        result
    }

    async fn event_loop(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    ) -> anyhow::Result<()> {
        loop {
            terminal.draw(|frame| self.draw(frame))?;
            if !event::poll(Duration::from_millis(100))? {
                continue;
            }
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                    KeyCode::Char('c') if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                        return Ok(());
                    }
                    KeyCode::Char(ch) if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                        self.tab = None;
                        match ch {
                            'a' => self.cursor = 0,
                            'e' => self.cursor = self.input.chars().count(),
                            'u' => {
                                let (input, cursor) = crate::bottom_pane::kill_to_start(&self.input, self.cursor);
                                self.input = input;
                                self.cursor = cursor;
                            }
                            'k' => {
                                self.input = crate::bottom_pane::kill_to_end(&self.input, self.cursor);
                            }
                            'w' => {
                                let (input, cursor) = crate::bottom_pane::kill_word(&self.input, self.cursor);
                                self.input = input;
                                self.cursor = cursor;
                            }
                            'o' => self.toggle_last_tool_collapse(),
                            _ => {}
                        }
                    }
                    KeyCode::Char(ch) => {
                        self.tab = None;
                        let (input, cursor) = crate::bottom_pane::insert_char(&self.input, self.cursor, ch);
                        self.input = input;
                        self.cursor = cursor;
                        self.refresh_completion();
                    }
                    KeyCode::Backspace => {
                        self.tab = None;
                        let (input, cursor) = crate::bottom_pane::backspace(&self.input, self.cursor);
                        self.input = input;
                        self.cursor = cursor;
                        self.refresh_completion();
                    }
                    KeyCode::Delete => {
                        self.tab = None;
                        self.input = crate::bottom_pane::delete_forward(&self.input, self.cursor);
                        self.refresh_completion();
                    }
                    KeyCode::Left => {
                        self.tab = None;
                        self.cursor = crate::bottom_pane::move_cursor(&self.input, self.cursor, -1);
                        self.refresh_completion();
                    }
                    KeyCode::Right => {
                        self.tab = None;
                        self.cursor = crate::bottom_pane::move_cursor(&self.input, self.cursor, 1);
                        self.refresh_completion();
                    }
                    KeyCode::Home => {
                        self.tab = None;
                        self.cursor = 0;
                        self.refresh_completion();
                    }
                    KeyCode::End => {
                        self.tab = None;
                        self.cursor = self.input.chars().count();
                        self.refresh_completion();
                    }
                    KeyCode::Enter => {
                        // With the completion popup open, Enter fills the
                        // selected command instead of submitting.
                        if self.completion.is_some() {
                            self.apply_completion();
                            continue;
                        }
                        self.tab = None;
                        self.cursor = 0;
                        let line = std::mem::take(&mut self.input);
                        if line.trim().is_empty() {
                            continue;
                        }
                        if self.dispatch(terminal, &line).await? {
                            return Ok(());
                        }
                        self.history.push(line);
                        self.history_idx = None;
                    }
                    KeyCode::Tab => self.complete(),
                    KeyCode::PageUp => self.scroll = self.scroll.saturating_add(5),
                    KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(5),
                    KeyCode::Up => {
                        if self.completion.is_some() {
                            if let Some(state) = self.completion.as_mut() {
                                state.selected = state
                                    .selected
                                    .checked_sub(1)
                                    .unwrap_or(state.matches.len().saturating_sub(1));
                            }
                            continue;
                        }
                        self.tab = None;
                        self.history_back();
                    }
                    KeyCode::Down => {
                        if self.completion.is_some() {
                            if let Some(state) = self.completion.as_mut() {
                                state.selected = (state.selected + 1) % state.matches.len().max(1);
                            }
                            continue;
                        }
                        self.tab = None;
                        self.history_forward();
                    }
                    KeyCode::Esc => {
                        // Esc closes the popup first; a second Esc quits.
                        if self.completion.is_some() {
                            self.completion = None;
                            continue;
                        }
                        return Ok(());
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }

    /// Handle one submitted line (slash command or prompt). Returns `true`
    /// when the app should quit.
    async fn dispatch(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        line: &str,
    ) -> anyhow::Result<bool> {
        if line.starts_with('/') {
            let (cmd, rest) = line.split_once(' ').map(|(c, r)| (c, r.trim())).unwrap_or((line, ""));
            match cmd {
                "/quit" | "/exit" => return Ok(true),
                "/help" => {
                    self.transcript
                        .push_line(TranscriptLine::status(format!("commands: {}", SLASH_COMMANDS.join(" "))));
                }
                "/approvals" => {
                    let items = self.harness.approvals(Some(&self.session_id)).await?;
                    if items.is_empty() {
                        self.push_line(TranscriptLine::status("no pending approvals"));
                    }
                    for item in items.iter().take(10) {
                        let id = item["id"].as_str().unwrap_or("?");
                        let tool = item["tool_name"].as_str().unwrap_or("?");
                        let rule = item["approval_rule"].as_str().unwrap_or("?");
                        self.push_line(TranscriptLine::status(format!("{id}  {tool}  ({rule})")));
                    }
                }
                "/approve" => {
                    if rest.is_empty() {
                        self.push_line(TranscriptLine::status("usage: /approve <approval-id>"));
                    } else {
                        let resolved = self.harness.resolve_approval(rest, true, None).await?;
                        self.push_line(TranscriptLine::status(if resolved {
                            "approval allowed"
                        } else {
                            "approval not found"
                        }));
                    }
                }
                "/deny" => {
                    if rest.is_empty() {
                        self.push_line(TranscriptLine::status("usage: /deny <approval-id>"));
                    } else {
                        let resolved = self.harness.resolve_approval(rest, false, Some("denied by user")).await?;
                        self.push_line(TranscriptLine::status(if resolved {
                            "approval denied"
                        } else {
                            "approval not found"
                        }));
                    }
                }
                "/status" => {
                    let status = self.session.as_mut().expect("session").get_status().await;
                    let summary = format_status(&status["result"]);
                    self.push_line(TranscriptLine::status(summary));
                }
                "/info" => {
                    match self.harness.core_version().await {
                        Ok(v) => self.push_line(TranscriptLine::status(format!(
                            "kimi {} — session {}",
                            v, self.session_id
                        ))),
                        Err(e) => self
                            .transcript
                            .push_line(TranscriptLine::error(format!("info failed: {e}"))),
                    }
                }
                "/session" => {
                    let parts: Vec<&str> = rest.split_whitespace().collect();
                    match parts.first().copied() {
                        Some("set") if parts.len() >= 2 => {
                            let title = parts[1..].join(" ");
                            match self.harness.rename_session(&self.session_id, &title).await {
                                Ok(()) => self.push_line(TranscriptLine::status(format!(
                                    "session {title}",
                                ))),
                                Err(e) => self
                                    .transcript
                                    .push_line(TranscriptLine::error(format!("rename failed: {e}"))),
                            }
                        }
                        _ => {
                            let msg = if parts.is_empty() {
                                format!("session {}", self.session_id)
                            } else {
                                "usage: /session [set <title>]".to_string()
                            };
                            self.push_line(TranscriptLine::status(msg));
                        }
                    }
                }
                "/plugins" => {
                    let parts: Vec<&str> = rest.split_whitespace().collect();
                    match parts.first().copied() {
                        None | Some("list") => {
                            match self.harness.list_plugins().await {
                                Ok(plugins) => {
                                    if plugins.is_empty() {
                                        self.transcript
                                            .push_line(TranscriptLine::status("no plugins installed"));
                                    } else {
                                        let lines: Vec<String> = plugins
                                            .iter()
                                            .map(|p| {
                                                let id = p["id"].as_str().unwrap_or("?");
                                                let enabled = p["enabled"].as_bool().unwrap_or(false);
                                                format!("{id} {}", if enabled { "[on]" } else { "[off]" })
                                            })
                                            .collect();
                                        self.push_line(TranscriptLine::status(format!(
                                            "plugins ({}): {}",
                                            lines.len(),
                                            lines.join(", ")
                                        )));
                                    }
                                }
                                Err(e) => self
                                    .transcript
                                    .push_line(TranscriptLine::error(format!("plugins failed: {e}"))),
                            }
                        }
                        Some(action) => {
                            let id = parts.get(1).copied().unwrap_or("");
                            let result = match action {
                                "enable" if !id.is_empty() => {
                                    self.harness.set_plugin_enabled(id, true).await.map(|_| format!("enabled {id}"))
                                }
                                "disable" if !id.is_empty() => {
                                    self.harness.set_plugin_enabled(id, false).await.map(|_| format!("disabled {id}"))
                                }
                                "remove" if !id.is_empty() => {
                                    self.harness.remove_plugin(id).await.map(|removed| {
                                        format!("removed {id}{}", if removed { "" } else { " (not found)" })
                                    })
                                }
                                "reload" => {
                                    self.harness.reload_plugins().await.map(|_| "plugins reloaded".to_string())
                                }
                                "install" if !id.is_empty() => {
                                    let source = parts.get(1).copied().unwrap_or("").to_string();
                                    self.harness.install_plugin(&source).await.map(|_| format!("installed {source}"))
                                }
                                _ => Err(anyhow::anyhow!("usage: /plugins [list|enable|disable|remove|reload|install <source>]")),
                            };
                            match result {
                                Ok(msg) => self.push_line(TranscriptLine::status(msg)),
                                Err(e) => self
                                    .transcript
                                    .push_line(TranscriptLine::error(format!("plugins: {e}"))),
                            }
                        }
                    }
                }
                "/config" => {
                    let config = self.harness.config().await;
                    match config {
                        Ok(cfg) => self.push_line(TranscriptLine::status(format!(
                            "config: {}",
                            serde_json::to_string_pretty(&cfg).unwrap_or_default()
                        ))),
                        Err(e) => self
                            .transcript
                            .push_line(TranscriptLine::error(format!("config failed: {e}"))),
                    }
                }
                "/skills" => {
                    let skills = self.session.as_mut().expect("session").list_skills().await;
                    match skills {
                        Ok(skills) => {
                            let entries: Vec<(String, String)> = skills["skills"]
                                .as_array()
                                .map(|arr| {
                                    arr.iter()
                                        .map(|s| {
                                            let name = s["name"].as_str().unwrap_or("?").to_string();
                                            let desc = s["description"].as_str().unwrap_or("").to_string();
                                            (name, desc)
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            if entries.is_empty() {
                                self.push_line(TranscriptLine::status("no skills registered"));
                            } else {
                                match crate::picker::select(
                                    terminal,
                                    self.theme,
                                    "select a skill",
                                    &entries,
                                )? {
                                    Some(name) => {
                                        let desc = entries
                                            .iter()
                                            .find(|(n, _)| *n == name)
                                            .map(|(_, d)| d.clone())
                                            .unwrap_or_default();
                                        self.push_line(TranscriptLine::status(format!(
                                            "{name}: {desc}"
                                        )));
                                    }
                                    None => self
                                        .transcript
                                        .push_line(TranscriptLine::status("skill selection cancelled")),
                                }
                            }
                        }
                        Err(e) => self
                            .transcript
                            .push_line(TranscriptLine::error(format!("skills failed: {e}"))),
                    }
                }
                "/plan" => {
                    let enabled = rest == "on" || rest.is_empty();
                    self.session.as_mut().expect("session").set_plan_mode(enabled).await?;
                    self.push_line(TranscriptLine::status(format!(
                        "plan mode {}",
                        if enabled { "on" } else { "off" }
                    )));
                    self.refresh_status().await;
                }
                "/swarm" => {
                    let enabled = rest == "on" || rest.is_empty();
                    self.session.as_mut().expect("session").set_swarm_mode(enabled, None).await?;
                    self.push_line(TranscriptLine::status(format!(
                        "swarm mode {}",
                        if enabled { "on" } else { "off" }
                    )));
                    self.refresh_status().await;
                }
                "/thinking" => {
                    if rest.is_empty() {
                        self.push_line(TranscriptLine::status("usage: /thinking <low|medium|high>"));
                    } else {
                        self.session.as_mut().expect("session").set_thinking(Some(rest)).await?;
                        self.push_line(TranscriptLine::status(format!("thinking effort set to {rest}")));
                    }
                }
                "/permission" => {
                    if rest.is_empty() {
                        // No arg: pick a permission mode (TS picker parity).
                        let items: Vec<(String, String)> = ["manual", "plan", "auto", "yolo"]
                            .iter()
                            .map(|m| (m.to_string(), String::new()))
                            .collect();
                        match crate::picker::select(terminal, self.theme, "select permission mode", &items)? {
                            Some(mode) => {
                                self.session.as_mut().expect("session").set_permission(&mode).await?;
                                self.transcript
                                    .push_line(TranscriptLine::status(format!("permission mode: {mode}")));
                            }
                            None => self
                                .transcript
                                .push_line(TranscriptLine::status("permission selection cancelled")),
                        }
                    } else {
                        let mode = rest;
                        self.session.as_mut().expect("session").set_permission(mode).await?;
                        self.transcript
                            .push_line(TranscriptLine::status(format!("permission mode: {mode}")));
                    }
                }
                "/yolo" => {
                    let current = self.session.as_mut().expect("session").get_status().await;
                    let on = current["result"]["permission"].as_str() != Some("yolo");
                    self.session
                        .as_mut()
                        .expect("session")
                        .set_permission(if on { "yolo" } else { "manual" })
                        .await?;
                    self.push_line(TranscriptLine::status(format!(
                        "yolo mode {}",
                        if on { "on" } else { "off" }
                    )));
                }
                "/auto" => {
                    let current = self.session.as_mut().expect("session").get_status().await;
                    let on = current["result"]["permission"].as_str() != Some("auto");
                    self.session
                        .as_mut()
                        .expect("session")
                        .set_permission(if on { "auto" } else { "manual" })
                        .await?;
                    self.push_line(TranscriptLine::status(format!(
                        "auto mode {}",
                        if on { "on" } else { "off" }
                    )));
                }
                "/new" => {
                    let fresh = format!("session-{}", fresh_session_id());
                    self.switch_to_session(&fresh).await?;
                }
                "/init" => {
                    self.session.as_mut().expect("session").init().await?;
                    self.transcript
                        .push_line(TranscriptLine::status("session initialized (agents.md)"));
                }
                "/title" => {
                    if rest.is_empty() {
                        self.transcript
                            .push_line(TranscriptLine::status("usage: /title <title>"));
                    } else {
                        self.session.as_mut().expect("session").rename(rest).await?;
                        self.transcript
                            .push_line(TranscriptLine::status(format!("session title: {rest}")));
                    }
                }
                "/mcp" => {
                    match self.session.as_mut().expect("session").list_mcp_servers().await {
                        Ok(servers) => {
                            let list = servers["mcp_servers"]
                                .as_array()
                                .or_else(|| servers["result"]["mcp_servers"].as_array())
                                .or_else(|| servers["servers"].as_array())
                                .cloned()
                                .unwrap_or_default();
                            let names: Vec<&str> = list
                                .iter()
                                .filter_map(|s| s["name"].as_str().or_else(|| s["server_name"].as_str()))
                                .collect();
                            if names.is_empty() {
                                self.transcript
                                    .push_line(TranscriptLine::status("no MCP servers configured"));
                            } else {
                                self.push_line(TranscriptLine::status(format!(
                                    "MCP servers: {}",
                                    names.join(", ")
                                )));
                            }
                        }
                        Err(e) => self
                            .transcript
                            .push_line(TranscriptLine::error(format!("mcp failed: {e}"))),
                    }
                }
                "/tasks" => {
                    let tasks = self.session.as_mut().expect("session").list_background_tasks().await;
                    let list = tasks["tasks"]
                        .as_array()
                        .or_else(|| tasks["result"]["tasks"].as_array())
                        .cloned()
                        .unwrap_or_default();
                    if list.is_empty() {
                        self.push_line(TranscriptLine::status("no background tasks"));
                    } else {
                        for t in list.iter().take(10) {
                            let id = t["id"].as_str().unwrap_or("?");
                            let label = t["label"].as_str().unwrap_or("");
                            let state = t["state"].as_str().unwrap_or("?");
                            self.transcript
                                .push_line(TranscriptLine::status(format!("{id}  {label}  [{state}]")));
                        }
                    }
                }
                "/theme" => {
                    self.dark_mode = !self.dark_mode;
                    self.theme = if self.dark_mode {
                        crate::theme::Theme::dark()
                    } else {
                        crate::theme::Theme::light()
                    };
                    self.push_line(TranscriptLine::status(format!(
                        "theme: {}",
                        if self.dark_mode { "dark" } else { "light" }
                    )));
                }
                "/version" => {
                    match self.harness.core_version().await {
                        Ok(v) => self
                            .transcript
                            .push_line(TranscriptLine::status(format!("kimi version: {v}"))),
                        Err(e) => self
                            .transcript
                            .push_line(TranscriptLine::error(format!("version failed: {e}"))),
                    }
                }
                "/models" => {
                    let (aliases, default_model) = self.harness.list_models().await?;
                    if aliases.is_empty() {
                        self.push_line(TranscriptLine::status("no model aliases configured"));
                    }
                    for alias in aliases.iter().take(20) {
                        self.push_line(TranscriptLine::status(alias.clone()));
                    }
                    if let Some(default_model) = default_model {
                        self.push_line(TranscriptLine::status(format!("default: {default_model}")));
                    }
                }
                "/model" => {
                    if rest.is_empty() {
                        // No arg: interactively pick a model from the aliases
                        // (TS `/model` picker parity) instead of a usage error.
                        let items: Vec<(String, String)> = self
                            .model_aliases
                            .iter()
                            .cloned()
                            .map(|alias| (alias.clone(), String::new()))
                            .collect();
                        if items.is_empty() {
                            self.push_line(TranscriptLine::status(
                                "no model aliases configured",
                            ));
                        } else {
                            match crate::picker::select(terminal, self.theme, "select a model", &items)? {
                                Some(model) => {
                                    self.session.as_mut().expect("session").set_model(&model).await?;
                                    self.transcript
                                        .push_line(TranscriptLine::status(format!("model set to {model}")));
                                }
                                None => self
                                    .transcript
                                    .push_line(TranscriptLine::status("model selection cancelled")),
                            }
                        }
                    } else {
                        self.session.as_mut().expect("session").set_model(rest).await?;
                        self.push_line(TranscriptLine::status(format!("model set to {rest}")));
                    }
                }
                "/reload" => {
                    // Re-load the persisted session state into the live agent
                    // (create already happened; load restores context + goal).
                    match self.session.as_mut().expect("session").load().await {
                        Ok(()) => self.push_line(TranscriptLine::status("session reloaded")),
                        Err(e) => self.push_line(TranscriptLine::error(format!("reload failed: {e}"))),
                    }
                }
                "/resume" => {
                    if rest.is_empty() {
                        self.push_line(TranscriptLine::status("usage: /resume <session-id>"));
                    } else {
                        let mut new_session = self.harness.create_session(rest).await?;
                        // Restore the persisted state of the resumed session.
                        let _ = new_session.load().await;
                        self.session = Some(new_session);
                        self.session_id = rest.to_string();
                        self.push_line(TranscriptLine::status(format!("switched to session {rest}")));
                    }
                }
                "/goal" => {
                    // TS parity: `/goal <subcommand>` manages the goal;
                    // anything else is the objective of a new goal.
                    let (cmd, objective) = match rest.split_once(char::is_whitespace) {
                        Some((c, o)) => (c, o.trim()),
                        None => (rest, ""),
                    };
                    let session = self.session.as_mut().expect("session");
                    match cmd {
                        "" => {
                            self.push_line(TranscriptLine::status(
                                "usage: /goal <objective> | status|pause|resume|cancel|replace|next",
                            ));
                        }
                        "status" => {
                            let goal = session.goal().await?;
                            let status = goal["result"]["goal"]["status"].as_str().unwrap_or("none");
                            self.push_line(TranscriptLine::status(format!("goal status: {status}")));
                        }
                        "pause" => {
                            session.pause_goal(Some(objective)).await?;
                            self.push_line(TranscriptLine::status("goal paused"));
                        }
                        "resume" => {
                            session.resume_goal(Some(objective)).await?;
                            self.push_line(TranscriptLine::status("goal resumed"));
                        }
                        "cancel" => {
                            session.cancel_goal().await?;
                            self.push_line(TranscriptLine::status("goal cancelled"));
                        }
                        "replace" => {
                            if objective.is_empty() {
                                self.push_line(TranscriptLine::status("usage: /goal replace <objective>"));
                            } else {
                                let snapshot = session.create_goal(objective).await?;
                                self.push_line(TranscriptLine::status(format!(
                                    "goal replaced: {}",
                                    snapshot["objective"]
                                )));
                            }
                        }
                        "next" => {
                            self.push_line(TranscriptLine::status(
                                "goal queueing is not supported in the Rust TUI — use a plain objective",
                            ));
                        }
                        _ => {
                            // A bare objective creates a goal (TS parity).
                            let snapshot = session.create_goal(rest).await?;
                            self.push_line(TranscriptLine::status(format!(
                                "goal created: {}",
                                snapshot["objective"]
                            )));
                        }
                    }
                }
                "/goal-cancel" => {
                    self.session.as_mut().expect("session").cancel_goal().await?;
                    self.push_line(TranscriptLine::status("goal cancelled"));
                }
                "/goal-pause" => {
                    self.session.as_mut().expect("session").pause_goal(Some(rest)).await?;
                    self.push_line(TranscriptLine::status("goal paused"));
                }
                "/goal-resume" => {
                    self.session.as_mut().expect("session").resume_goal(Some(rest)).await?;
                    self.push_line(TranscriptLine::status("goal resumed"));
                }
                "/add-dir" => {
                    if rest.is_empty() {
                        self.push_line(TranscriptLine::status("usage: /add-dir <path>"));
                    } else {
                        match self.session.as_mut().expect("session").add_additional_dir(rest).await {
                            Ok(_) => self.push_line(TranscriptLine::status(format!("added dir {rest}"))),
                            Err(e) => self.push_line(TranscriptLine::error(format!("add-dir failed: {e}"))),
                        }
                    }
                }
                "/clear" => {
                    self.session.as_mut().expect("session").clear_context().await?;
                    self.push_line(TranscriptLine::status("context cleared"));
                }
                "/compact" => {
                    match self.session.as_mut().expect("session").compact().await {
                        Ok(_) => self.push_line(TranscriptLine::status("context compacted")),
                        Err(e) => self.push_line(TranscriptLine::error(format!("compact failed: {e}"))),
                    }
                }
                "/usage" => {
                    let usage = self.session.as_mut().expect("session").get_usage().await?;
                    let summary = format_usage(&usage["result"]);
                    self.push_line(TranscriptLine::status(summary));
                }
                "/undo" => {
                    let undone = self.session.as_mut().expect("session").undo_history(1).await?;
                    self.push_line(TranscriptLine::status(format!(
                        "undo: {}",
                        serde_json::to_string(&undone).unwrap_or_default()
                    )));
                }
                "/fork" => {
                    if rest.is_empty() {
                        self.push_line(TranscriptLine::status("usage: /fork <new-session-id>"));
                    } else {
                        self.session.as_mut().expect("session").fork(rest, None, None).await?;
                        self.push_line(TranscriptLine::status(format!("forked to {rest}")));
                    }
                }
                "/steer" => {
                    if rest.is_empty() {
                        self.push_line(TranscriptLine::status("usage: /steer <text>"));
                    } else {
                        let queued = self
                            .session
                            .as_mut()
                            .expect("session")
                            .steer(serde_json::json!([{ "type": "text", "text": rest }]))
                            .await?;
                        self.push_line(TranscriptLine::status(format!("steer queued: {queued}")));
                    }
                }
                "/import" => {
                    if rest.is_empty() {
                        self.push_line(TranscriptLine::status("usage: /import <text>"));
                    } else {
                        self.session
                            .as_mut()
                            .expect("session")
                            .import_context(rest, "tui")
                            .await?;
                        self.transcript
                            .push_line(TranscriptLine::status(format!("imported {} chars", rest.chars().count())));
                    }
                }
                "/goal-status" => {
                    let goal = self.session.as_mut().expect("session").goal().await?;
                    self.push_line(TranscriptLine::status(format!(
                        "goal: {}",
                        serde_json::to_string(&goal["goal"]).unwrap_or_default()
                    )));
                }
                "/sessions" => {
                    let sessions = self.harness.list_sessions(50).await?;
                    let items: Vec<(String, String)> = sessions
                        .iter()
                        .filter_map(|s| {
                            let id = s["id"].as_str()?.to_string();
                            let title = s["title"].as_str().unwrap_or("(untitled)").to_string();
                            Some((id, title))
                        })
                        .collect();
                    if items.is_empty() {
                        self.push_line(TranscriptLine::status("no sessions"));
                    } else {
                        match crate::picker::select(
                            terminal,
                            self.theme,
                            "select a session",
                            &items,
                        )? {
                            Some(id) => self.switch_to_session(&id).await?,
                            None => self
                                .transcript
                                .push_line(TranscriptLine::status("session selection cancelled")),
                        }
                    }
                }
                "/export" => {
                    match self.harness.export_session(&self.session_id).await {
                        Ok(zip) => {
                            let path = format!("{}.zip", self.session_id);
                            match std::fs::write(&path, &zip) {
                                Ok(()) => self.push_line(TranscriptLine::status(format!(
                                    "exported to {path} ({} bytes)",
                                    zip.len()
                                ))),
                                Err(e) => self.push_line(TranscriptLine::error(format!("write failed: {e}"))),
                            }
                        }
                        Err(e) => self.push_line(TranscriptLine::error(format!("export failed: {e}"))),
                    }
                }
                "/archive" => {
                    let Some(session) = self.session.as_mut() else {
                        self.push_line(TranscriptLine::error("archive: no active session"));
                        return Ok(false);
                    };
                    match session.archive().await {
                        Ok(true) => self
                            .transcript
                            .push_line(TranscriptLine::status("session archived")),
                        Ok(false) => self
                            .transcript
                            .push_line(TranscriptLine::error("archive: session not found")),
                        Err(e) => self
                            .transcript
                            .push_line(TranscriptLine::error(format!("archive failed: {e}"))),
                    }
                }
                other => self
                    .transcript
                    .push_line(TranscriptLine::error(format!("unknown command {other} — try /help"))),
            }
            return Ok(false);
        }
        // A real prompt: run it and render the transcript, pumping engine
        // events into the panel while the turn runs. The prompt future lives
        // in a block so its `&mut session` borrow ends before we read back.
        self.push_line(TranscriptLine::user(line));
        let prompt_result = {
            // Clone the session out so the prompt future (which borrows it
            // mutably) can coexist with `self.pump_one_event` in the select.
            let mut session = self.session.clone().expect("session");
            let prompt_fut = session.prompt(line);
            tokio::pin!(prompt_fut);
            loop {
                self.poll_prompt_keys().await?;
                tokio::select! {
                    r = &mut prompt_fut => break Some(r.clone()),
                    _ = self.pump_one_event() => {}
                }
            }
        };
        if let Some(result) = prompt_result {
            if let Some(error) = result.get("error") {
                self.push_line(TranscriptLine::error(format!(
                    "error: {}",
                    error["message"].as_str().unwrap_or("unknown")
                )));
            } else {
                // Close the streamed turn: drop transient thinking, replace
                // the live line with the final transcript (or append it when
                // nothing streamed).
                crate::streaming::drop_trailing_thinking(&mut self.transcript);
                match self.session.as_mut().expect("session").transcript().await? {
                    Some(text) => {
                        crate::streaming::finish_stream(&mut self.transcript, text);
                    }
                    None => {
                        crate::streaming::finish_stream(&mut self.transcript, result.to_string());
                    }
                }
            }
        }
        Ok(false)
    }

    /// Refresh the footer status bar from the current session snapshot.
    async fn refresh_status(&mut self) {
        if let Some(session) = self.session.as_mut() {
            let status = session.get_status().await;
            let plan = status["result"]["plan_mode"].as_bool().unwrap_or(false);
            let swarm = status["result"]["swarm_mode"].as_bool().unwrap_or(false);
            self.status = format!("plan={} swarm={}", if plan { "on" } else { "off" }, if swarm { "on" } else { "off" });
        }
    }

    /// Render one engine event into the panel (with a short poll timeout so
    /// the select loop keeps yielding to the running prompt).
    async fn pump_one_event(&mut self) {
        let event = {
            let mut guard = self.harness.events().await;
            match guard.as_mut() {
                Some(source) => tokio::time::timeout(std::time::Duration::from_millis(50), source.next())
                    .await
                    .ok()
                    .flatten(),
                None => None,
            }
        };
        let Some(event) = event else { return };
        let r#type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if r#type == "session.approval.requested" {
            self.request_approval().await;
            return;
        }
        if r#type == "llm.delta" {
            // Live model output: thinking deltas accumulate on a transient
            // dimmed line; text deltas stream into the assistant line.
            if let Some(think) = kimi_ui::stream_thinking(&event) {
                crate::streaming::append_thinking(&mut self.transcript, think);
            } else if let Some(delta) = kimi_ui::stream_delta(&event) {
                crate::streaming::append_stream(&mut self.transcript, delta);
            }
            return;
        }
        if r#type.starts_with("llm.") {
            // llm.delta is streamed above; the step bookends render as
            // progress; the telemetry types (request/config/divergence/
            // tools_snapshot) stay silent — they exist for recorders.
            if !matches!(r#type, "llm.step.begin" | "llm.step.end") {
                return;
            }
        }
        let line = kimi_ui::render_event(&event).unwrap_or_else(|| event.to_string());
        // Tool progress is structured into tool-call cards (started/settled
        // update one ToolCallEntry by id); everything else is a status line.
        let is_tool = r#type.starts_with("session.tool.");
        if is_tool {
            self.handle_tool_event(&event);
            return;
        }
        self.transcript.push_line(TranscriptLine::status(line));
    }

    /// Update the transcript's tool-call cards from tool started/settled
    /// events (TS `tool-call.ts` parity: one card per tool invocation,
    /// gaining its result when the tool settles).
    fn handle_tool_event(&mut self, event: &serde_json::Value) {
        let r#type = event["type"].as_str().unwrap_or("");
        let tool_call_id = event["tool_call_id"].as_str().unwrap_or("").to_string();
        let tool_name = event["tool_name"].as_str().unwrap_or("?").to_string();
        // Empty ids never participate in upsert matching: a missing id would
        // otherwise match the first empty-id card (misattribution across
        // tools). Unmatched events just append a fresh card.
        let find_index = if tool_call_id.is_empty() {
            None
        } else {
            self.transcript.iter().position(|e| match e {
                TranscriptEntry::ToolCall(tc) => tc.tool_call_id == tool_call_id,
                _ => false,
            })
        };
        if r#type == "session.tool.started" {
            let args = serde_json::to_string(&event["arguments"]).unwrap_or_default();
            let collapsed = args.chars().count() > 120;
            match find_index.and_then(|i| self.transcript.get_mut(i)) {
                Some(TranscriptEntry::ToolCall(existing)) => {
                    existing.tool_name = tool_name;
                    existing.args = args;
                    existing.result = None;
                    existing.is_error = false;
                    existing.collapsed = collapsed;
                }
                _ => {
                    self.transcript.push(TranscriptEntry::ToolCall(ToolCallEntry {
                        tool_call_id,
                        tool_name,
                        args,
                        result: None,
                        is_error: false,
                        collapsed,
                    }));
                }
            }
        } else if r#type == "session.tool.settled" {
            let result = event["content"].as_str().unwrap_or("").to_string();
            let is_error = event["is_error"].as_bool().unwrap_or(false);
            match find_index.and_then(|i| self.transcript.get_mut(i)) {
                Some(TranscriptEntry::ToolCall(existing)) => {
                    existing.result = Some(result);
                    existing.is_error = is_error;
                }
                _ => {
                    // A settled event without a matching started (replay edge).
                    self.transcript.push(TranscriptEntry::ToolCall(ToolCallEntry {
                        tool_call_id,
                        tool_name,
                        args: String::new(),
                        result: Some(result),
                        is_error,
                        collapsed: false,
                    }));
                }
            }
        }
    }

    /// Fetch pending approvals after an `approval.requested` event and queue
    /// them for interactive resolution. Approvals matching an
    /// auto-approved rule resolve immediately (approve-for-session parity).
    async fn request_approval(&mut self) {
        let session_id = self.session_id.clone();
        match self.harness.approvals(Some(&session_id)).await {
            Ok(items) if !items.is_empty() => {
                let (added, auto_resolve) = queue_new_approvals(
                    &mut self.pending_approvals,
                    &items,
                    &self.auto_allow_rules,
                );
                for id in auto_resolve {
                    let _ = self.harness.resolve_approval(&id, true, None).await;
                }
                if added > 0 {
                    if let Some(head) = self.pending_approvals.last() {
                        self.push_line(TranscriptLine::status(format!(
                            "approval requested: {} ({rule}) {args} — y/n, v=details, s=for-session",
                            head.tool,
                            rule = head.rule,
                            args = head.args,
                        )));
                    }
                }
            }
            _ => {
                self.transcript
                    .push_line(TranscriptLine::status("approval requested — run /approvals to inspect"));
            }
        }
    }

    /// Poll one key while a turn runs. Esc/Ctrl-C cancels the turn; with an
    /// approval pending, y/n resolves the front of the queue. A single read
    /// so y/n and interrupt keys never swallow each other.
    async fn poll_prompt_keys(&mut self) -> anyhow::Result<()> {
        if !event::poll(std::time::Duration::from_millis(0))? {
            return Ok(());
        }
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                return Ok(());
            }
            // The approval-detail modal owns the keys while it is open:
            // y/n/s decide (and close), Esc closes, anything else is ignored.
            if self.approval_detail.is_some() {
                match key.code {
                    KeyCode::Char('y') => {
                        self.answer_approval(true).await?;
                        self.approval_detail = None;
                    }
                    KeyCode::Char('n') => {
                        self.answer_approval(false).await?;
                        self.approval_detail = None;
                    }
                    KeyCode::Char('s') => {
                        self.approve_for_session().await?;
                        self.approval_detail = None;
                    }
                    KeyCode::Esc => self.approval_detail = None,
                    _ => {}
                }
                return Ok(());
            }
            if interrupt_action(key.code, key.modifiers) == Some(InterruptAction::CancelTurn) {
                let mut session = self.session.clone().expect("session");
                session.cancel().await;
                self.push_line(TranscriptLine::status("turn cancelled"));
                return Ok(());
            }
            if !self.pending_approvals.is_empty() {
                match key.code {
                    KeyCode::Char('y') => self.answer_approval(true).await?,
                    KeyCode::Char('n') => self.answer_approval(false).await?,
                    KeyCode::Char('v') => self.open_approval_detail(),
                    KeyCode::Char('s') => self.approve_for_session().await?,
                    _ => {}
                }
            }
        }
        Ok(())
    }

    /// Switch to another session: persist + close the current one, then open
    /// `id` (create + load persisted context). Used by `/new` and the resume
    /// picker.
    async fn switch_to_session(&mut self, id: &str) -> anyhow::Result<()> {
        if let Some(mut s) = self.session.take() {
            let _ = s.save().await;
        }
        self.session_id = id.to_string();
        let mut session = self.harness.create_session(id).await?;
        let _ = session.load().await;
        self.session = Some(session);
        self.transcript
            .push_line(TranscriptLine::status(format!("session: {id}")));
        self.refresh_status().await;
        Ok(())
    }

    /// Resolve the front of the pending approval queue (`allow`, or `deny`
    /// with a user reason).
    async fn answer_approval(&mut self, allow: bool) -> anyhow::Result<()> {
        let Some(pending) = self.pending_approvals.first().cloned() else {
            return Ok(());
        };
        let reason = if allow { None } else { Some("denied by user") };
        let resolved = self
            .harness
            .resolve_approval(&pending.id, allow, reason)
            .await
            .unwrap_or(false);
        self.pending_approvals.remove(0);
        if resolved {
            let action = if allow { "allowed" } else { "denied" };
            self.push_line(TranscriptLine::status(format!("{} {}", pending.tool, action)));
        } else {
            self.transcript
                .push_line(TranscriptLine::status(format!("{} no longer pending", pending.tool)));
        }
        Ok(())
    }

    /// Toggle the most recent collapsed tool-result line (Ctrl-O) — the
    /// tool-call card expand/collapse.
    fn toggle_last_tool_collapse(&mut self) {
        toggle_last_tool_collapse(&mut self.transcript);
    }

    /// Open the full-screen approval detail modal (`v` key): the front
    /// pending approval's full arguments, with y/n/s/Esc decision keys.
    fn open_approval_detail(&mut self) {
        if let Some(pending) = self.pending_approvals.first().cloned() {
            self.approval_detail = Some(pending);
        }
    }

    /// Approve the front approval "for this session" (`s` key): remember its
    /// rule so future matching approvals resolve automatically, then allow
    /// it (TS approve-for-session parity).
    async fn approve_for_session(&mut self) -> anyhow::Result<()> {
        let Some(pending) = self.pending_approvals.first().cloned() else {
            return Ok(());
        };
        self.auto_allow_rules.insert(pending.rule.clone());
        let resolved = self
            .harness
            .resolve_approval(&pending.id, true, None)
            .await
            .unwrap_or(false);
        self.pending_approvals.remove(0);
        self.push_line(TranscriptLine::status(format!(
            "{} approved for session ({} will auto-approve)",
            pending.tool,
            pending.rule,
        )));
        if !resolved {
            self.transcript
                .push_line(TranscriptLine::status(format!("{} no longer pending", pending.tool)));
        }
        Ok(())
    }

    /// Refresh the slash-command completion popup from the current input:
    /// active only while typing a bare `/prefix` (no space yet).
    fn refresh_completion(&mut self) {
        self.completion = completion_for_input(&self.input);
    }

    /// Fill the input with the popup's selected command and close the popup.
    fn apply_completion(&mut self) {
        let Some(state) = self.completion.take() else { return };
        if let Some((cmd, _)) = state.matches.get(state.selected) {
            self.input = cmd.clone();
            self.cursor = self.input.chars().count();
        }
    }

    /// Complete the current input on Tab: cycle the command name or an
    /// argument (model ids for `/model`, closed sets for `/plan|/swarm|/thinking`).
    fn complete(&mut self) {
        let base = self.tab.as_ref().map(|t| t.base.clone()).unwrap_or_else(|| self.input.clone());
        let idx = self.tab.as_ref().map(|t| t.idx);
        let (completed, next) = crate::bottom_pane::complete_line(&base, &self.model_aliases, idx);
        match next {
            Some(i) => {
                self.input = completed;
                self.cursor = self.input.chars().count();
                self.tab = Some(TabState { base, idx: i });
            }
            None => self.tab = None,
        }
    }

    fn history_back(&mut self) {
        let idx = self.history_idx.map_or(self.history.len(), |i| i);
        if idx > 0 {
            self.history_idx = Some(idx - 1);
            self.input = self.history[idx - 1].clone();
            self.cursor = self.input.chars().count();
        }
    }

    fn history_forward(&mut self) {
        if let Some(idx) = self.history_idx {
            if idx + 1 < self.history.len() {
                self.history_idx = Some(idx + 1);
                self.input = self.history[idx + 1].clone();
            } else {
                self.history_idx = None;
                self.input.clear();
            }
            self.cursor = self.input.chars().count();
        }
    }

    fn draw(&mut self, frame: &mut ratatui::Frame<'_>) {
        // The chat pane is the area minus the fixed 3-line input pane.
        let pane_height = frame.area().height.saturating_sub(3);
        let max = crate::chatwidget::max_scroll(self.transcript.len(), pane_height);
        if self.scroll as usize > max {
            self.scroll = max as u16;
        }
        crate::chatwidget::render_frame(
            frame,
            &self.transcript,
            &self.input,
            self.cursor,
            &self.session_id,
            &self.status,
            self.scroll,
            self.theme,
            self.completion.as_ref(),
        );
        if let Some(pending) = self.approval_detail.as_ref() {
            self.render_approval_modal(frame, pending);
        }
    }

    /// Draw the full-screen approval detail modal over the chat layout.
    fn render_approval_modal(&self, frame: &mut ratatui::Frame<'_>, pending: &PendingApproval) {
        let lines: Vec<ratatui::text::Line> = approval_modal_lines(pending)
            .into_iter()
            .enumerate()
            .map(|(i, text)| {
                let color = match i {
                    0 => self.theme.assistant,
                    3 => self.theme.error,
                    _ => self.theme.status,
                };
                ratatui::text::Line::from(ratatui::text::Span::styled(
                    text,
                    ratatui::style::Style::default().fg(color),
                ))
            })
            .collect();
        let modal = ratatui::widgets::Paragraph::new(lines)
            .block(ratatui::widgets::Block::default().borders(ratatui::widgets::Borders::ALL).title("approval"));
        frame.render_widget(modal, frame.area());
    }
}
fn init_terminal() -> anyhow::Result<Terminal<CrosstermBackend<io::Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    crossterm::execute!(stdout, EnterAlternateScreen)?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> anyhow::Result<()> {
    disable_raw_mode()?;
    crossterm::execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::Backend;
    use ratatui::style::Color;

    /// Reconstruct each buffer row as a string (for substring assertions).
    fn buffer_text(buffer: &ratatui::buffer::Buffer) -> Vec<String> {
        let (width, height) = (buffer.area.width, buffer.area.height);
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
            })
            .collect()
    }




    #[test]
    fn thinking_accumulates_and_drops() {
        let mut transcript = Vec::new();
        crate::streaming::append_thinking(&mut transcript, "let me ");
        crate::streaming::append_thinking(&mut transcript, "think");
        assert_eq!(transcript, vec![TranscriptEntry::Line(TranscriptLine::thinking("let me think"))]);
        // Text streaming after thinking starts a separate assistant line.
        crate::streaming::append_stream(&mut transcript, "answer");
        assert_eq!(transcript[1], TranscriptEntry::Line(TranscriptLine::streaming("answer")));
        // Only TRAILING thinking lines are dropped at turn close: reasoning
        // above the visible answer stays, trailing reasoning goes.
        crate::streaming::drop_trailing_thinking(&mut transcript);
        assert_eq!(
            transcript,
            vec![TranscriptEntry::Line(TranscriptLine::thinking("let me think")), TranscriptEntry::Line(TranscriptLine::streaming("answer"))],
            "non-trailing thinking survives"
        );
        transcript.pop(); // the assistant line closes via finish_stream
        crate::streaming::drop_trailing_thinking(&mut transcript);
        assert!(transcript.is_empty(), "trailing thinking dropped");
    }

    #[test]
    fn thinking_renders_dimmed() {
        let lines = crate::chatwidget::styled_lines(&[TranscriptEntry::Line(TranscriptLine::thinking("reasoning"))], crate::theme::Theme::dark());
        assert_eq!(lines[0].spans[0].content, "reasoning");
        assert_eq!(lines[0].spans[0].style.fg, Some(Color::DarkGray));
        assert!(lines[0].spans[0].style.add_modifier.contains(Modifier::ITALIC));
    }

    #[test]
    fn streaming_append_and_finish() {
        // Deltas accumulate on a trailing streaming line.
        let mut transcript = Vec::new();
        crate::streaming::append_stream(&mut transcript, "hello ");
        crate::streaming::append_stream(&mut transcript, "world");
        assert_eq!(
            transcript,
            vec![TranscriptEntry::Line(TranscriptLine::streaming("hello world"))],
            "deltas append to the streaming line"
        );
        // A non-streaming line in between (e.g. a tool event) starts a new
        // streaming line instead of corrupting the previous message.
        transcript.push(TranscriptEntry::Line(TranscriptLine::tool("Bash started")));
        crate::streaming::append_stream(&mut transcript, "step 2");
        assert_eq!(transcript[2], TranscriptEntry::Line(TranscriptLine::streaming("step 2")));

        // finish_stream replaces the trailing streaming line with the final
        // transcript, and reports the replacement.
        assert!(crate::streaming::finish_stream(&mut transcript, "final text".to_string()));
        assert_eq!(transcript[2], TranscriptEntry::Line(TranscriptLine::assistant("final text")));
        // With no streaming line it appends a fresh assistant line.
        assert!(!crate::streaming::finish_stream(&mut transcript, "another".to_string()));
        assert_eq!(transcript.last(), Some(&TranscriptEntry::Line(TranscriptLine::assistant("another"))));
    }

    #[test]
    fn streaming_renders_distinct() {
        let lines = crate::chatwidget::styled_lines(&[TranscriptEntry::Line(TranscriptLine::streaming("growing"))], crate::theme::Theme::dark());
        let text: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(text, "growing");
    }

    #[tokio::test]
    async fn tool_events_build_structured_cards() {
        // started -> card; settled -> result lands on the same card.
        let mut app = App::new(kimi_sdk::Harness::embedded().expect("harness"), Some("s-tool"));
        app.handle_tool_event(&serde_json::json!({
            "type": "session.tool.started",
            "tool_call_id": "t1",
            "tool_name": "Bash",
            "arguments": { "command": "ls" },
        }));
        app.handle_tool_event(&serde_json::json!({
            "type": "session.tool.settled",
            "tool_call_id": "t1",
            "content": "file1\nfile2",
            "is_error": false,
        }));
        assert_eq!(app.transcript.len(), 1, "one card, not two lines");
        match &app.transcript[0] {
            TranscriptEntry::ToolCall(tc) => {
                assert_eq!(tc.tool_name, "Bash");
                assert_eq!(tc.result.as_deref(), Some("file1\nfile2"));
                assert!(!tc.is_error);
            }
            _ => panic!("expected a ToolCall card"),
        }
    }

    #[tokio::test]
    async fn tool_settled_without_started_appends_card() {
        // Replay edge: a settled event with no prior started still shows a card.
        let mut app = App::new(kimi_sdk::Harness::embedded().expect("harness"), Some("s-tool2"));
        app.handle_tool_event(&serde_json::json!({
            "type": "session.tool.settled",
            "tool_call_id": "t9",
            "tool_name": "Read",
            "content": "file contents",
            "is_error": true,
        }));
        assert_eq!(app.transcript.len(), 1);
        match &app.transcript[0] {
            TranscriptEntry::ToolCall(tc) => {
                assert_eq!(tc.tool_name, "Read");
                assert_eq!(tc.result.as_deref(), Some("file contents"));
                assert!(tc.is_error);
            }
            _ => panic!("expected a ToolCall card"),
        }
    }

    #[tokio::test]
    async fn tool_events_without_id_never_misattribute() {
        // Two tools without ids: the second started must not overwrite the
        // first card (empty ids never match for upsert).
        let mut app = App::new(kimi_sdk::Harness::embedded().expect("harness"), Some("s-tool3"));
        app.handle_tool_event(&serde_json::json!({
            "type": "session.tool.started",
            "tool_name": "Bash",
            "arguments": { "command": "ls" },
        }));
        app.handle_tool_event(&serde_json::json!({
            "type": "session.tool.started",
            "tool_name": "Read",
            "arguments": { "path": "/x" },
        }));
        assert_eq!(app.transcript.len(), 2, "two cards, no misattribution");
        match (&app.transcript[0], &app.transcript[1]) {
            (TranscriptEntry::ToolCall(a), TranscriptEntry::ToolCall(b)) => {
                assert_eq!(a.tool_name, "Bash");
                assert_eq!(b.tool_name, "Read");
            }
            _ => panic!("expected two ToolCall cards"),
        }
    }

    #[test]
    fn tool_result_collapse_and_toggle() {
        // Short results stay expanded; long ones collapse.
        assert!(!tool_result_collapsed("tool Read -> ok: short"));
        let long = format!("tool Bash -> ok: {}", "x".repeat(200));
        assert!(tool_result_collapsed(&long), "long result collapses");

        // Toggle flips the most recent ToolCall card (long args or collapsed).
        let mut transcript = vec![
            TranscriptEntry::ToolCall(ToolCallEntry {
                tool_call_id: "t1".into(),
                tool_name: "Bash".into(),
                args: "{}".into(),
                result: Some(long),
                is_error: false,
                collapsed: true,
            }),
            TranscriptEntry::Line(TranscriptLine::status("other")),
        ];
        assert!(matches!(&transcript[0], TranscriptEntry::ToolCall(tc) if tc.collapsed));
        toggle_last_tool_collapse(&mut transcript);
        assert!(matches!(&transcript[0], TranscriptEntry::ToolCall(tc) if !tc.collapsed));
        toggle_last_tool_collapse(&mut transcript);
        assert!(matches!(&transcript[0], TranscriptEntry::ToolCall(tc) if tc.collapsed));

        // No ToolCall cards -> no-op.
        let mut plain = vec![TranscriptEntry::Line(TranscriptLine::status("x"))];
        toggle_last_tool_collapse(&mut plain);
    }

    #[test]
    fn completion_popup_matches_bare_slash_prefix() {
        // `/s` matches the commands starting with `/s` (session, skills, …).
        let state = completion_for_input("/s").expect("popup for /s");
        assert!(!state.matches.is_empty());
        assert!(state.matches.iter().any(|(name, _)| name == "/session"));
        assert_eq!(state.selected, 0);
        // Every entry carries a description (popup description column).
        assert!(state.matches.iter().all(|(_, desc)| !desc.is_empty()));
        // Plain text / empty input / an argument after the command close it.
        assert!(completion_for_input("hello").is_none());
        assert!(completion_for_input("/session x").is_none(), "space closes popup");
        assert!(completion_for_input("/zzz").is_none(), "no matches");
    }

    #[test]
    fn approval_modal_lines_show_details_and_actions() {
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
        assert_eq!(lines[1], r#"{"command":"ls"}"#);
        assert!(lines[3].contains("s = allow for session"), "actions: {}", lines[3]);
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
        assert_eq!(args_preview(&serde_json::json!({ "command": "ls" })), r#"{"command":"ls"}"#);
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
    fn transcript_lines_render_by_kind() {
        let transcript = vec![
            TranscriptEntry::Line(TranscriptLine::user("hi")),
            TranscriptEntry::Line(TranscriptLine::assistant("hello")),
            TranscriptEntry::Line(TranscriptLine::tool("Read started")),
            TranscriptEntry::Line(TranscriptLine::status("plan mode on")),
            TranscriptEntry::Line(TranscriptLine::error("boom")),
        ];
        let lines = crate::chatwidget::styled_lines(&transcript, crate::theme::Theme::dark());
        assert_eq!(lines.len(), 5);
        // User lines are prefixed and bold.
        assert_eq!(lines[0].spans[0].content, "▶ hi");
        assert!(lines[0].spans[0].style.add_modifier.contains(Modifier::BOLD));
        // Assistant text renders verbatim.
        assert_eq!(lines[1].spans[0].content, "hello");
        // Tool lines carry the gear prefix and blue color.
        assert_eq!(lines[2].spans[0].content, "  ⚙ Read started");
        assert_eq!(lines[2].spans[0].style.fg, Some(Color::Blue));
        // Status lines are dimmed, errors are red.
        assert_eq!(lines[3].spans[0].style.fg, Some(Color::DarkGray));
        assert_eq!(lines[4].spans[0].style.fg, Some(Color::Red));
    }

    #[test]
    fn interrupt_action_mapping() {
        use event::KeyModifiers;
        assert_eq!(
            interrupt_action(KeyCode::Esc, KeyModifiers::NONE),
            Some(InterruptAction::CancelTurn)
        );
        assert_eq!(
            interrupt_action(KeyCode::Char('c'), KeyModifiers::CONTROL),
            Some(InterruptAction::CancelTurn)
        );
        // A bare 'c' or any other key is not an interrupt.
        assert_eq!(interrupt_action(KeyCode::Char('c'), KeyModifiers::NONE), None);
        assert_eq!(interrupt_action(KeyCode::Enter, KeyModifiers::NONE), None);
    }

    #[test]
    fn status_summary_is_readable() {
        let status = serde_json::json!({
            "model": "kimi-k2",
            "permission": "manual",
            "plan_mode": true,
            "swarm_mode": false,
            "thinking_effort": "high",
            "context_tokens": 120,
            "max_context_tokens": 1000,
        });
        let line = format_status(&status);
        assert!(line.contains("model: kimi-k2"), "line: {line}");
        assert!(line.contains("mode: plan"), "line: {line}");
        assert!(line.contains("permission: manual"), "line: {line}");
        assert!(line.contains("thinking: high"), "line: {line}");
        assert!(line.contains("ctx: 120/1000"), "line: {line}");

        let bare = format_status(&serde_json::json!({}));
        assert!(bare.contains("mode: chat"), "bare: {bare}");
        assert!(bare.contains("model: -"), "bare: {bare}");
    }

    #[test]
    fn usage_summary_is_readable() {
        let usage = serde_json::json!({
            "total": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 },
        });
        let line = format_usage(&usage);
        assert_eq!(line, "usage: 30 total (10 in / 20 out)");
        assert_eq!(format_usage(&serde_json::json!({})), "usage: no tokens recorded");
    }

    #[test]
    fn smoke_renders_two_panes() {
        use ratatui::backend::TestBackend;

        let transcript = vec![
            TranscriptEntry::Line(TranscriptLine::user("hi")),
            TranscriptEntry::Line(TranscriptLine::assistant("hello there")),
            TranscriptEntry::Line(TranscriptLine::tool("Read started")),
        ];
        let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
        terminal
            .draw(|frame| {
                crate::chatwidget::render_frame(frame, &transcript, "/help", 2, "sess-1", "plan=off swarm=off", 0, crate::theme::Theme::dark(), None);
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let lines = buffer_text(&buffer);
        // Both panes render with their block titles.
        assert!(lines.iter().any(|l| l.contains("chat")), "chat pane title missing:\n{}", lines.join("\n"));
        assert!(
            lines.iter().any(|l| l.contains("input — sess-1 | plan=off swarm=off")),
            "input pane title missing:\n{}",
            lines.join("\n")
        );
        // Transcript roles render with their prefixes, in order.
        let first_visible: String = lines.iter().filter(|l| !l.trim().is_empty()).cloned().collect();
        let user_at = first_visible.find("▶ hi").expect("user line missing");
        let tool_at = first_visible.find("⚙ Read started").expect("tool line missing");
        let assistant_at = first_visible.find("hello there").expect("assistant line missing");
        assert!(user_at < assistant_at && assistant_at < tool_at, "role order wrong");
        // The ▶ glyph is bold; the gear glyph is blue.
        let user_cell = buffer.content.iter().find(|c| c.symbol() == "▶").expect("▶ cell");
        assert!(user_cell.style().add_modifier.contains(Modifier::BOLD));
        let gear_cell = buffer.content.iter().find(|c| c.symbol() == "⚙").expect("⚙ cell");
        assert_eq!(gear_cell.style().fg, Some(Color::Blue));
        // The terminal cursor sits at the input editing position: inside the
        // input pane border (row 10 of 12; col = 1 border + 2 chars in).
        let pos = terminal.get_cursor_position().unwrap();
        assert_eq!((pos.x, pos.y), (3, 10));
    }

    #[test]
    fn max_scroll_matches_viewport() {
        // A 12-row terminal: chat pane is 9 rows, minus borders = 7 visible.
        assert_eq!(crate::chatwidget::max_scroll(10, 9), 3);
        assert_eq!(crate::chatwidget::max_scroll(7, 9), 0);
        // Empty transcript never underflows.
        assert_eq!(crate::chatwidget::max_scroll(0, 9), 0);
    }
}
