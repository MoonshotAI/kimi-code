//! The TUI application: terminal setup, event loop, and rendering.

use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use kimi_sdk::Harness;

use crate::approval::{approval_modal_lines, queue_new_approvals, PendingApproval};
use crate::i18n::t;
/// The `t!` formatting macro (exported at the crate root by `i18n`).
use crate::t;
use crate::question::QuestionPanel;
/// The `t!` formatting macro (exported at the crate root by `i18n`).
use crate::util::{
    init_terminal, interrupt_action, restore_terminal, InterruptAction,
};

/// The role/source of a transcript line, driving its render style.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    /// The user's own prompt (`✨ …`).
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

/// A structured transcript entry: a plain line, a tool-call card (the
/// chatwidget component-tree step — TS `tool-call.ts` parity), or a
/// background-task / subagent card (TS `background-agent-status` parity).
#[derive(Debug, Clone, PartialEq)]
pub enum TranscriptEntry {
    /// A role-styled line (user/assistant/status/…).
    Line(TranscriptLine),
    /// A structured tool call with args + optional result (collapsible).
    ToolCall(ToolCallEntry),
    /// A background task / subagent with lifecycle status (started →
    /// terminated; kind `agent` is a subagent).
    Task(TaskEntry),
}

/// One background task in the transcript: created on `session.task.started`,
/// gains its terminal status on `session.task.terminated`.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskEntry {
    pub task_id: String,
    /// Human description (the tool objective / command).
    pub description: String,
    /// 'agent' | 'process' | 'question' (wire `kind`).
    pub kind: String,
    /// Running status while live; the terminal status once terminated.
    pub status: String,
    /// Terminal status landed (None while running).
    pub ended: bool,
    /// Started timestamp (epoch ms from the wire) for duration display.
    pub started_at_ms: Option<u64>,
    pub ended_at_ms: Option<u64>,
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
    /// AskUserQuestion — renders with a ❓ prefix and a reply hint, since
    /// the user's answer arrives as the next message.
    pub is_question: bool,
    /// Execution time (started → settled), when known.
    pub duration: Option<std::time::Duration>,
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
        Self {
            kind: TranscriptKind::User,
            text: text.into(),
            collapsed: false,
        }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            kind: TranscriptKind::Assistant,
            text: text.into(),
            collapsed: false,
        }
    }
    pub fn streaming(text: impl Into<String>) -> Self {
        Self {
            kind: TranscriptKind::Streaming,
            text: text.into(),
            collapsed: false,
        }
    }
    pub fn thinking(text: impl Into<String>) -> Self {
        Self {
            kind: TranscriptKind::Thinking,
            text: text.into(),
            collapsed: false,
        }
    }
    pub fn tool(text: impl Into<String>) -> Self {
        Self {
            kind: TranscriptKind::Tool,
            text: text.into(),
            collapsed: false,
        }
    }
    /// A tool-result line that starts collapsed (long output).
    pub fn tool_collapsed(text: impl Into<String>) -> Self {
        Self {
            kind: TranscriptKind::Tool,
            text: text.into(),
            collapsed: true,
        }
    }
    pub fn status(text: impl Into<String>) -> Self {
        Self {
            kind: TranscriptKind::Status,
            text: text.into(),
            collapsed: false,
        }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self {
            kind: TranscriptKind::Error,
            text: text.into(),
            collapsed: false,
        }
    }
}
/// State for an in-progress Tab completion cycle.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TabState {
    /// The input as it was when the cycle started (matches cycle on this).
    base: String,
    /// Index into the current match list.
    idx: usize,
}

/// Active slash-command completion popup: the matching commands shown above
/// the input while typing `/…` (↑/↓ to move, Enter to fill, Esc to close).
/// Each entry is `(command, description)` for the description column.
#[derive(Debug, Clone, PartialEq)]
pub struct CompletionState {
    pub matches: Vec<(String, String)>,
    pub selected: usize,
}
/// The current overlay (mutually exclusive modal): the slash-command
/// completion popup, the full-screen approval detail view, the help panel,
/// or the AskUserQuestion dialog. `None` when no overlay is open.
/// Centralizes modal state so new overlays just add a variant.
pub(crate) enum Overlay {
    Completion(CompletionState),
    ApprovalDetail(PendingApproval),
    Help(HelpPanel),
    Question(QuestionPanel),
}

/// The `/help` modal: a scrollable list of keyboard shortcuts + all
/// slash commands with descriptions (TS `help-panel` parity).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HelpPanel {
    /// Pre-rendered rows (header sections + command lines).
    rows: Vec<String>,
    /// First visible row (↑/↓ scrolls).
    offset: usize,
}

impl HelpPanel {
    /// Build the panel from the command registry.
    pub fn new() -> Self {
        Self {
            rows: build_help_rows(),
            offset: 0,
        }
    }
    /// The visible slice for a `height`-tall modal (borders excluded).
    fn visible(&self, height: usize) -> &[String] {
        let end = (self.offset + height).min(self.rows.len());
        &self.rows[self.offset..end]
    }
}

/// The `/help` panel rows: a shortcuts section, then every slash command
/// with its description (pure, tested).
fn build_help_rows() -> Vec<String> {
    let mut rows = vec![
        t("tui.help.shortcuts").to_string(),
        "  Ctrl-C ×2   quit".to_string(),
        "  Ctrl-O      toggle tool card".to_string(),
        "  Ctrl-G      external editor".to_string(),
        "  Ctrl-S      steer / queue".to_string(),
        "  PageUp/Dn   scroll (in lists)".to_string(),
        String::new(),
    ];
    rows.push(t!("tui.help.commands", crate::bottom_pane::command_descriptions().len()));
    for (name, desc) in crate::bottom_pane::command_descriptions() {
        rows.push(format!("{name}  {desc}"));
    }
    rows.push(String::new());
    rows.push(t("tui.help.detailHint").to_string());
    rows
}

/// Tool output above this length starts collapsed in the transcript (`[+]`;
/// Ctrl-O to expand) — the tool-call card fold threshold.
pub const TOOL_COLLAPSE_THRESHOLD: usize = 120;

/// A tool-result line with long output starts collapsed (`[+]`; Ctrl-O to
/// expand) — the tool-call card fold. Short results stay expanded.
pub fn tool_result_collapsed(text: &str) -> bool {
    text.chars().count() > TOOL_COLLAPSE_THRESHOLD
}

/// The slash-command completion popup state for an input, or `None` when the
/// input is not a bare `/prefix`. Entries carry the command's description
/// (TS registry parity).
pub fn completion_for_input(input: &str) -> Option<CompletionState> {
    if !input.starts_with('/') || input.contains(' ') {
        return None;
    }
    let matches: Vec<(String, String)> = crate::bottom_pane::command_descriptions()
        .into_iter()
        .filter(|(name, _)| name.starts_with(input))
        .collect();
    if matches.is_empty() {
        None
    } else {
        Some(CompletionState {
            matches,
            selected: 0,
        })
    }
}

/// Upsert the background-task / subagent card from `session.task.started` /
/// `session.task.terminated` events (TS `background-agent-status` parity,
/// simplified): started creates the card, terminated lands its terminal
/// status + duration. A terminated ghost without a started event still
/// shows as ended.
pub fn upsert_task_card(transcript: &mut Vec<TranscriptEntry>, event: &serde_json::Value) {
    let task_id = event["task_id"].as_str().unwrap_or("").to_string();
    let description = event["description"].as_str().unwrap_or("").to_string();
    let kind = event["kind"].as_str().unwrap_or("").to_string();
    let r#type = event["type"].as_str().unwrap_or("");
    let index = transcript.iter().position(|e| match e {
        TranscriptEntry::Task(t) => t.task_id == task_id,
        _ => false,
    });
    if r#type == "session.task.started" {
        let entry = TaskEntry {
            task_id,
            description,
            kind,
            status: "running".to_string(),
            ended: false,
            started_at_ms: event["started_at_ms"].as_u64(),
            ended_at_ms: None,
        };
        match index {
            Some(i) => transcript[i] = TranscriptEntry::Task(entry),
            None => transcript.push(TranscriptEntry::Task(entry)),
        }
        return;
    }
    // terminated — land the terminal status.
    let status = event["status"].as_str().unwrap_or("terminated").to_string();
    match index.and_then(|i| transcript.get_mut(i)) {
        Some(TranscriptEntry::Task(task)) => {
            task.status = status;
            task.ended = true;
            task.ended_at_ms = event["ended_at_ms"].as_u64();
        }
        _ => {
            transcript.push(TranscriptEntry::Task(TaskEntry {
                task_id,
                description,
                kind,
                status,
                ended: true,
                started_at_ms: None,
                ended_at_ms: event["ended_at_ms"].as_u64(),
            }));
        }
    }
}

/// Toggle the most recent tool-result card (Ctrl-O) — expand/collapse. Cards
/// with a long argument preview or an already-collapsed state participate;
/// short running cards stay put.
pub fn toggle_last_tool_collapse(transcript: &mut [TranscriptEntry]) {
    if let Some(TranscriptEntry::ToolCall(tc)) = transcript.iter_mut().rev().find(|e| match e {
        TranscriptEntry::ToolCall(tc) => {
            tc.collapsed
                || tc.args.chars().count() > TOOL_COLLAPSE_THRESHOLD
                || tc
                    .result
                    .as_ref()
                    .is_some_and(|r| r.chars().count() > TOOL_COLLAPSE_THRESHOLD)
        }
        _ => false,
    }) {
        tc.collapsed = !tc.collapsed;
    }
}

// ── Input editing primitives ──────────────────────────────────────────────
// The input cursor is a char index (UTF-8 safe); byte offsets are computed
// only at edit boundaries. Every function clamps an out-of-range cursor.

/// Input-editing state (the prompt line, its cursor, history, Tab cycle).
#[derive(Debug, Default)]
pub struct EditorState {
    /// The user's current input line (multi-line capable).
    pub(crate) text: String,
    /// Char index of the input cursor (editing position).
    pub(crate) cursor: usize,
    /// Prompt history (up/down).
    pub(crate) history: Vec<String>,
    pub(crate) history_idx: Option<usize>,
    /// Active Tab completion cycle, if any.
    pub(crate) tab: Option<TabState>,
}

/// Rendering / view state (transcript, scroll, footer, theme).
#[derive(Debug)]
pub struct ViewState {
    /// Transcript lines rendered in the chat panel.
    pub(crate) transcript: Vec<TranscriptEntry>,
    /// Transcript scroll offset (lines from the bottom).
    pub(crate) scroll: u16,
    /// Whether the transcript auto-scrolls to the newest line; disabled by
    /// manual scrolling (PageUp/Down) until the user scrolls back down.
    pub(crate) follow_bottom: bool,
    /// Live session status for the footer strip.
    pub(crate) footer: crate::footer::FooterInfo,
    /// Semantic color palette resolved from `tui.toml`.
    pub(crate) theme: crate::theme::Theme,
    /// Whether the dark palette is active (`/theme` toggles this).
    pub(crate) dark_mode: bool,
    /// When the last Ctrl-C was pressed (double-press exit confirmation).
    last_ctrl_c: Option<std::time::Instant>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            transcript: Vec::new(),
            scroll: 0,
            follow_bottom: true,
            footer: crate::footer::FooterInfo::default(),
            theme: crate::theme::load_theme(),
            dark_mode: true,
            last_ctrl_c: None,
        }
    }
}

/// The interactive chat application.
pub struct App {
    pub(crate) harness: Harness,
    pub(crate) session_id: String,
    /// When true (App::new(None)), the startup flow offers a session picker.
    pub(crate) startup_pick: bool,
    pub(crate) session: Option<kimi_sdk::Session>,
    /// The active side-question (btw) agent id (`btw-<session_id>`); while
    /// set, every prompt routes to it (TS btw-panel parity, simplified).
    pub(crate) btw_agent: Option<String>,
    /// Model aliases for `/model` Tab completion.
    pub(crate) model_aliases: Vec<String>,
    /// Pending tool approvals queued for interactive y/n resolution.
    pub(crate) pending_approvals: Vec<PendingApproval>,
    /// The active overlay (completion popup / approval detail), if any.
    pub(crate) overlay: Option<Overlay>,
    /// Permission rules the user approved "for this session": future
    /// approvals matching these rules resolve automatically (TS
    /// approve-for-session parity).
    pub(crate) auto_allow_rules: std::collections::HashSet<String>,
    /// Pasted image attachments referenced by `[image #N]` placeholders.
    pub(crate) image_attachments: Vec<crate::clipboard::ImageAttachment>,
    /// Tool start timestamps (tool_call_id → Instant) for duration display.
    pub(crate) tool_started_at: std::collections::HashMap<String, std::time::Instant>,
    /// Input-editing state (prompt line, cursor, history, Tab).
    pub(crate) edit: EditorState,
    /// Rendering / view state (transcript, scroll, footer, theme).
    pub(crate) view: ViewState,
}

impl App {
    /// Push a plain line onto the transcript (the common case).
    pub(crate) fn push_line(&mut self, line: TranscriptLine) {
        self.view.transcript.push(TranscriptEntry::Line(line));
    }

    /// Create the app around an engine harness (embedded or remote).
    pub fn new(harness: Harness, session_id: Option<&str>) -> Self {
        Self {
            harness,
            session_id: session_id.unwrap_or_default().to_string(),
            startup_pick: session_id.is_none(),
            session: None,
            btw_agent: None,
            model_aliases: Vec::new(),
            pending_approvals: Vec::new(),
            overlay: None,
            auto_allow_rules: std::collections::HashSet::new(),
            image_attachments: Vec::new(),
            tool_started_at: std::collections::HashMap::new(),
            edit: EditorState::default(),
            view: ViewState::default(),
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
                    self.view.theme,
                    t("tui.picker.resumeSession"),
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
        self.view.transcript.extend(history);
        // Seed the footer status (best-effort) before the session moves.
        let status = session.get_status().await;
        self.view.footer = crate::footer::FooterInfo::from_status(&status["result"]);
        self.session = Some(session);
        self.push_line(TranscriptLine::status(t!(
            "tui.start.sessionReady",
            self.session_id
        )));
        // Best-effort auth status so a fresh user knows to `/login`.
        match kimi_sdk::KimiAuth::new().status(&self.harness).await {
            Ok(true) => self.push_line(TranscriptLine::status(t("tui.start.loggedIn"))),
            Ok(false) => self.push_line(TranscriptLine::status(t("tui.start.notLoggedIn"))),
            Err(_) => {}
        }
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
                Event::Paste(data) => {
                    // Bracketed paste (Ctrl-V / terminal paste) inserts into
                    // the input at the cursor.
                    self.edit.tab = None;
                    let (input, cursor) =
                        crate::bottom_pane::insert_text(&self.edit.text, self.edit.cursor, &data);
                    self.edit.text = input;
                    self.edit.cursor = cursor;
                    self.refresh_completion();
                }
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    // Overlays own the keys while open (question dialog after
                    // a stopped turn, help panel, approval detail).
                    if self.handle_overlay_key(key.code).await? {
                        continue;
                    }
                    match key.code {
                    KeyCode::Char('v') if key.modifiers.contains(event::KeyModifiers::ALT) => {
                        // Paste an image from the clipboard (Alt-V on
                        // Windows — Ctrl-V is usually reserved by the
                        // terminal for bracketed text paste).
                        match crate::clipboard::clipboard_image() {
                            Ok(Some((path, mime))) => {
                                let id = self.image_attachments.len();
                                self.image_attachments
                                    .push(crate::clipboard::ImageAttachment { id, path, mime });
                                let (input, cursor) = crate::bottom_pane::insert_text(
                                    &self.edit.text,
                                    self.edit.cursor,
                                    &format!("{} ", crate::clipboard::placeholder(id)),
                                );
                                self.edit.text = input;
                                self.edit.cursor = cursor;
                                self.push_line(TranscriptLine::status(t!("tui.paste.image", id)));
                            }
                            Ok(None) => {
                                self.push_line(TranscriptLine::status(t("tui.paste.noImage")))
                            }
                            Err(e) => {
                                self.push_line(TranscriptLine::error(format!("clipboard: {e}")))
                            }
                        }
                    }
                    KeyCode::Char('c') if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                        // Double-press Ctrl-C within 1.5s to exit; the first
                        // press just warns (TS exit-confirmation parity).
                        let now = std::time::Instant::now();
                        let again = self.view.last_ctrl_c.is_some_and(|t| {
                            now.duration_since(t) < std::time::Duration::from_millis(1500)
                        });
                        if again {
                            return Ok(());
                        }
                        self.view.last_ctrl_c = Some(now);
                        self.push_line(TranscriptLine::status(t("tui.turn.exitConfirm")));
                    }
                    KeyCode::Char(ch) if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                        self.edit.tab = None;
                        match ch {
                            'a' => self.edit.cursor = 0,
                            'e' => self.edit.cursor = self.edit.text.chars().count(),
                            'u' => {
                                let (input, cursor) = crate::bottom_pane::kill_to_start(
                                    &self.edit.text,
                                    self.edit.cursor,
                                );
                                self.edit.text = input;
                                self.edit.cursor = cursor;
                            }
                            'k' => {
                                self.edit.text = crate::bottom_pane::kill_to_end(
                                    &self.edit.text,
                                    self.edit.cursor,
                                );
                            }
                            'w' => {
                                let (input, cursor) = crate::bottom_pane::kill_word(
                                    &self.edit.text,
                                    self.edit.cursor,
                                );
                                self.edit.text = input;
                                self.edit.cursor = cursor;
                            }
                            's' => {
                                // Send the current input as a steer (TS
                                // Ctrl-S parity) instead of submitting.
                                let text = std::mem::take(&mut self.edit.text);
                                self.edit.cursor = 0;
                                if !text.trim().is_empty() {
                                    let queued = self
                                        .session
                                        .as_mut()
                                        .expect("session")
                                        .steer(
                                            serde_json::json!([{ "type": "text", "text": text }]),
                                        )
                                        .await?;
                                    self.push_line(TranscriptLine::status(t!(
                                        "tui.steer.queued",
                                        queued
                                    )));
                                }
                            }
                            'o' => self.toggle_last_tool_collapse(),
                            'g' => {
                                // External editor (Ctrl-G): suspend the TUI,
                                // edit a temp file seeded with the input,
                                // read the result back into the input line.
                                match crate::editor::edit_external(&self.edit.text) {
                                    Ok(text) => {
                                        self.edit.text = text;
                                        self.edit.cursor = self.edit.text.chars().count();
                                    }
                                    Err(e) => self.push_line(TranscriptLine::error(t!(
                                        "tui.err.editorFailed",
                                        e
                                    ))),
                                }
                            }
                            _ => {}
                        }
                    }
                    KeyCode::Char(ch) => {
                        self.edit.tab = None;
                        let (input, cursor) =
                            crate::bottom_pane::insert_char(&self.edit.text, self.edit.cursor, ch);
                        self.edit.text = input;
                        self.edit.cursor = cursor;
                        self.refresh_completion();
                    }
                    KeyCode::Backspace => {
                        self.edit.tab = None;
                        let (input, cursor) =
                            crate::bottom_pane::backspace(&self.edit.text, self.edit.cursor);
                        self.edit.text = input;
                        self.edit.cursor = cursor;
                        self.refresh_completion();
                    }
                    KeyCode::Delete => {
                        self.edit.tab = None;
                        self.edit.text =
                            crate::bottom_pane::delete_forward(&self.edit.text, self.edit.cursor);
                        self.refresh_completion();
                    }
                    KeyCode::Left => {
                        self.edit.tab = None;
                        self.edit.cursor =
                            crate::bottom_pane::move_cursor(&self.edit.text, self.edit.cursor, -1);
                        self.refresh_completion();
                    }
                    KeyCode::Right => {
                        self.edit.tab = None;
                        self.edit.cursor =
                            crate::bottom_pane::move_cursor(&self.edit.text, self.edit.cursor, 1);
                        self.refresh_completion();
                    }
                    KeyCode::Home => {
                        self.edit.tab = None;
                        self.edit.cursor = 0;
                        self.refresh_completion();
                    }
                    KeyCode::End => {
                        self.edit.tab = None;
                        self.edit.cursor = self.edit.text.chars().count();
                        self.refresh_completion();
                    }
                    KeyCode::Enter => {
                        // With the completion popup open, Enter fills the
                        // selected command instead of submitting.
                        if matches!(self.overlay, Some(Overlay::Completion(_))) {
                            self.apply_completion();
                            continue;
                        }
                        // Shift/Alt-Enter inserts a newline (multi-line input);
                        // plain Enter submits.
                        if key.modifiers.contains(event::KeyModifiers::SHIFT)
                            || key.modifiers.contains(event::KeyModifiers::ALT)
                        {
                            self.edit.tab = None;
                            let (input, cursor) = crate::bottom_pane::insert_char(
                                &self.edit.text,
                                self.edit.cursor,
                                '\n',
                            );
                            self.edit.text = input;
                            self.edit.cursor = cursor;
                            continue;
                        }
                        self.edit.tab = None;
                        self.edit.cursor = 0;
                        let line = std::mem::take(&mut self.edit.text);
                        if line.trim().is_empty() {
                            continue;
                        }
                        // A command error surfaces as a transcript line
                        // instead of killing the whole TUI.
                        match self.dispatch(terminal, &line).await {
                            Ok(true) => return Ok(()),
                            Ok(false) => {}
                            Err(e) => {
                                self.push_line(TranscriptLine::error(t!("tui.err.command", e)))
                            }
                        }
                        self.edit.history.push(line);
                        self.edit.history_idx = None;
                    }
                    KeyCode::Tab => self.complete(),
                    KeyCode::PageUp => {
                        self.view.follow_bottom = false;
                        self.view.scroll = self.view.scroll.saturating_add(5);
                    }
                    KeyCode::PageDown => {
                        self.view.follow_bottom = false;
                        self.view.scroll = self.view.scroll.saturating_sub(5);
                    }
                    KeyCode::Up => {
                        if let Some(Overlay::Completion(state)) = self.overlay.as_mut() {
                            state.selected = state
                                .selected
                                .checked_sub(1)
                                .unwrap_or(state.matches.len().saturating_sub(1));
                            continue;
                        }
                        self.edit.tab = None;
                        // Multi-line input: navigate lines; otherwise the
                        // prompt history.
                        if self.edit.text.contains('\n') {
                            self.edit.cursor = crate::bottom_pane::move_cursor_vert(
                                &self.edit.text,
                                self.edit.cursor,
                                -1,
                            );
                        } else {
                            self.history_back();
                        }
                    }
                    KeyCode::Down => {
                        if let Some(Overlay::Completion(state)) = self.overlay.as_mut() {
                            state.selected = (state.selected + 1) % state.matches.len().max(1);
                            continue;
                        }
                        self.edit.tab = None;
                        if self.edit.text.contains('\n') {
                            self.edit.cursor = crate::bottom_pane::move_cursor_vert(
                                &self.edit.text,
                                self.edit.cursor,
                                1,
                            );
                        } else {
                            self.history_forward();
                        }
                    }
                    KeyCode::Esc => {
                        // Esc closes the popup first; a second Esc quits.
                        if self.overlay.take().is_some() {
                            continue;
                        }
                        return Ok(());
                    }
                    _ => {}
                }
                }
                _ => {}
            }
        }
    }

    /// Handle one submitted line (slash command or prompt). Returns `true`
    /// when the app should quit. Boxed so `/settings` can re-enter it
    /// (async recursion needs indirection).
    /// Ask a y/N confirmation via the keyboard (provider / plugin removal).
    /// Repaints so the prompt is visible; `true` only on y/Y, anything else
    /// (n/N/Esc/Enter) → `false`.
    pub(crate) async fn confirm(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        prompt: &str,
    ) -> anyhow::Result<bool> {
        self.push_line(TranscriptLine::status(prompt.to_string()));
        terminal.draw(|frame| self.draw(frame))?;
        loop {
            if !event::poll(Duration::from_millis(100))? {
                continue;
            }
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') => return Ok(true),
                    KeyCode::Char('n')
                    | KeyCode::Char('N')
                    | KeyCode::Esc
                    | KeyCode::Enter => return Ok(false),
                    _ => {}
                }
            }
        }
    }

    /// Run one prompt turn and render the transcript, pumping engine events
    /// while the turn runs. When a side-question (btw) agent is active, the
    /// prompt routes to it and the streamed line IS the final answer (the
    /// side agent's context is not the session's, so no transcript read-back).
    pub(crate) async fn run_turn(&mut self, line: &str) -> anyhow::Result<()> {
        let agent_id: Option<String> = self.btw_agent.clone();
        self.push_line(if agent_id.is_some() {
            TranscriptLine::user(format!("[btw] {line}"))
        } else {
            TranscriptLine::user(line)
        });
        let turn_start = self.view.transcript.len();
        let prompt_result = {
            // Clone the session out so the prompt future (which borrows it
            // mutably) can coexist with `self.pump_one_event` in the select.
            let mut session = self.session.clone().expect("session");
            // Expand `[image #N]` paste placeholders into multi-modal parts
            // (plain text when nothing was pasted).
            let parts = crate::clipboard::expand_placeholders(line, &self.image_attachments);
            let prompt_fut = session.prompt_parts_as(parts, agent_id.as_deref());
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
                self.push_line(TranscriptLine::error(t!(
                    "tui.err.generic",
                    error["message"].as_str().unwrap_or("unknown")
                )));
            } else {
                // Close the streamed turn: drop transient thinking, replace
                // the live line with the final transcript (or append it when
                // nothing streamed).
                crate::streaming::drop_trailing_thinking(&mut self.view.transcript);
                if agent_id.is_some() {
                    // Side-agent turns: the streamed line is already the
                    // complete answer — promote it in place (no read-back;
                    // the side agent's context is not the session's).
                    crate::streaming::finish_side_turn(&mut self.view.transcript);
                } else {
                    match self.session.as_mut().expect("session").transcript().await? {
                        Some(text) => {
                            crate::streaming::finish_stream(&mut self.view.transcript, text);
                        }
                        None => {
                            crate::streaming::finish_stream(
                                &mut self.view.transcript,
                                result.to_string(),
                            );
                        }
                    }
                }
            }
        }
        // Turn summary (TS step-summary parity, simplified): when a turn
        // made several tool calls, fold a one-line recap into the transcript.
        let tools = self.view.transcript[turn_start..]
            .iter()
            .filter(|e| matches!(e, TranscriptEntry::ToolCall(_)))
            .count();
        let messages = self.view.transcript.len() - turn_start;
        if tools >= 2 {
            self.push_line(TranscriptLine::status(t!(
                "tui.turn.summary",
                tools,
                messages
            )));
        }
        Ok(())
    }

    /// Refresh the footer status strip from the current session snapshot.
    pub(crate) async fn refresh_status(&mut self) {
        if let Some(session) = self.session.as_mut() {
            let status = session.get_status().await;
            let mut footer = crate::footer::FooterInfo::from_status(&status["result"]);
            // from_status doesn't know the goal; keep the badge from the
            // last `session.goal.updated` event.
            footer.goal = self.view.footer.goal.clone();
            self.view.footer = footer;
        }
    }

    /// Start the next queued goal (if any) after the current one ended.
    /// Peeks first so a failed `create_goal` doesn't lose the entry.
    pub(crate) async fn maybe_promote_goal(&mut self) {
        let Ok(goals) = crate::goal_queue::read_queue(&self.session_id) else {
            return;
        };
        let Some(next) = goals.first().cloned() else {
            return;
        };
        let Some(session) = self.session.as_mut() else {
            return;
        };
        match session.create_goal(&next.objective).await {
            Ok(snapshot) => {
                let _ = crate::goal_queue::remove_goal(&self.session_id, &next.id);
                self.push_line(TranscriptLine::status(t!(
                    "tui.goal.promoted",
                    snapshot["objective"]
                )));
            }
            Err(e) => self.push_line(TranscriptLine::error(format!("goal queue: {e}"))),
        }
    }

    /// Render one engine event into the panel (with a short poll timeout so
    /// the select loop keeps yielding to the running prompt).
    pub(crate) async fn pump_one_event(&mut self) {
        let event = {
            let mut guard = self.harness.events().await;
            match guard.as_mut() {
                Some(source) => {
                    tokio::time::timeout(std::time::Duration::from_millis(50), source.next())
                        .await
                        .ok()
                        .flatten()
                }
                None => None,
            }
        };
        let Some(event) = event else { return };
        let r#type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if r#type == "session.approval.requested" {
            self.request_approval().await;
            return;
        }
        if r#type == "session.goal.updated" {
            // Auto-promote the next queued goal when the current one reached
            // a terminal state (TS `promoteNextQueuedGoal` parity). The
            // event still renders as a status line below.
            let status = event["goal"]["status"].as_str().unwrap_or("");
            if matches!(status, "complete" | "cancelled" | "blocked" | "failed") {
                self.maybe_promote_goal().await;
            }
            // Update the footer goal badge from the live snapshot.
            self.view.footer.goal = crate::footer::format_goal_badge(&event["goal"]);
        }
        if r#type == "llm.delta" {
            // Live model output: thinking deltas accumulate on a transient
            // dimmed line; text deltas stream into the assistant line;
            // tool_call deltas update a running card's argument preview.
            if let Some((id, _name, args)) = kimi_ui::stream_tool_call(&event) {
                crate::streaming::update_tool_args(&mut self.view.transcript, id, args);
            } else if let Some(think) = kimi_ui::stream_thinking(&event) {
                crate::streaming::append_thinking(&mut self.view.transcript, think);
            } else if let Some(delta) = kimi_ui::stream_delta(&event) {
                crate::streaming::append_stream(&mut self.view.transcript, delta);
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
        // Tool progress is structured into tool-call cards (started/settled
        // update one ToolCallEntry by id; `tool.native` carries a native
        // tool's final result — same settled semantics); background
        // tasks / subagents get lifecycle cards; everything else is a status
        // line.
        let is_tool =
            r#type.starts_with("session.tool.") || r#type == "tool.native";
        if is_tool {
            self.handle_tool_event(&event);
            return;
        }
        if r#type == "session.task.started" || r#type == "session.task.terminated" {
            self.handle_task_event(&event);
            return;
        }
        self.view.transcript.push_line(TranscriptLine::status(line));
    }

    /// Fetch pending approvals after an `approval.requested` event and queue
    /// them for interactive resolution. Approvals matching an
    /// auto-approved rule resolve immediately (approve-for-session parity).
    pub(crate) async fn request_approval(&mut self) {
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
                        self.push_line(TranscriptLine::status(t!(
                            "tui.approval.requested",
                            head.tool,
                            head.rule,
                            head.args,
                        )));
                    }
                }
            }
            _ => {
                self.view
                    .transcript
                    .push_line(TranscriptLine::status(t("tui.approval.inspect")));
            }
        }
    }

    /// Poll one key while a turn runs. Esc/Ctrl-C cancels the turn; with an
    /// approval pending, y/n resolves the front of the queue. A single read
    /// so y/n and interrupt keys never swallow each other.
    /// Handle one key press against the active overlay (question dialog /
    /// help panel / approval detail). Returns `true` when the key was
    /// consumed. Approval actions hit the engine; the question dialog may
    /// start a new turn (its answer is a prompt). Shared by the main loop
    /// (idle) and `poll_prompt_keys` (mid-turn) so overlays close anywhere.
    pub(crate) async fn handle_overlay_key(&mut self, code: KeyCode) -> anyhow::Result<bool> {
        enum OverlayAction {
            None,
            Close,
            Approve,
            Deny,
            Session,
        }
        let mut action = OverlayAction::None;
        let mut answer: Option<String> = None;
        match &mut self.overlay {
            Some(Overlay::Question(panel)) => {
                answer = panel.key(code);
            }
            Some(Overlay::Help(panel)) => {
                let delta = match code {
                    KeyCode::Up => -1i32,
                    KeyCode::Down => 1,
                    KeyCode::Esc | KeyCode::Enter => {
                        action = OverlayAction::Close;
                        0
                    }
                    _ => 0,
                };
                if delta != 0 {
                    let len = panel.rows.len();
                    panel.offset =
                        ((panel.offset as i64 + delta as i64).max(0) as usize)
                            .min(len.saturating_sub(1));
                }
            }
            Some(Overlay::ApprovalDetail(_)) => {
                match code {
                    KeyCode::Char('y') => action = OverlayAction::Approve,
                    KeyCode::Char('n') => action = OverlayAction::Deny,
                    KeyCode::Char('s') => action = OverlayAction::Session,
                    KeyCode::Esc => action = OverlayAction::Close,
                    _ => {}
                }
            }
            // The completion popup is editor-owned (the main loop handles
            // its Up/Down/Enter); every other overlay consumes the key.
            Some(Overlay::Completion(_)) => return Ok(false),
            None => return Ok(false),
        }
        if let Some(a) = answer {
            self.overlay = None;
            if !a.trim().is_empty() {
                let fut = self.run_turn(&a);
                Box::pin(fut).await?;
            }
            return Ok(true);
        }
        match action {
            OverlayAction::Close => self.overlay = None,
            OverlayAction::Approve => {
                self.answer_approval(true).await?;
                self.overlay = None;
            }
            OverlayAction::Deny => {
                self.answer_approval(false).await?;
                self.overlay = None;
            }
            OverlayAction::Session => {
                self.approve_for_session().await?;
                self.overlay = None;
            }
            OverlayAction::None => {}
        }
        Ok(true)
    }

    pub(crate) async fn poll_prompt_keys(&mut self) -> anyhow::Result<()> {
        if !event::poll(std::time::Duration::from_millis(0))? {
            return Ok(());
        }
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                return Ok(());
            }
            // Overlays own the keys while open (approval y/n/s, question
            // dialog, help panel).
            if self.handle_overlay_key(key.code).await? {
                return Ok(());
            }
            if interrupt_action(key.code, key.modifiers) == Some(InterruptAction::CancelTurn) {
                let mut session = self.session.clone().expect("session");
                session.cancel().await;
                self.push_line(TranscriptLine::status(t("tui.turn.cancelled")));
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
    pub(crate) async fn switch_to_session(&mut self, id: &str) -> anyhow::Result<()> {
        if let Some(mut s) = self.session.take() {
            let _ = s.save().await;
        }
        self.session_id = id.to_string();
        let mut session = self.harness.create_session(id).await?;
        let _ = session.load().await;
        self.session = Some(session);
        self.view
            .transcript
            .push_line(TranscriptLine::status(t!("tui.sessions.switched", id)));
        self.refresh_status().await;
        Ok(())
    }

    /// Resolve the front of the pending approval queue (`allow`, or `deny`
    /// with a user reason).
    pub(crate) async fn answer_approval(&mut self, allow: bool) -> anyhow::Result<()> {
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
            let line = if allow {
                t!("tui.approval.allowedAction", pending.tool)
            } else {
                t!("tui.approval.deniedAction", pending.tool)
            };
            self.push_line(TranscriptLine::status(line));
        } else {
            self.view.transcript.push_line(TranscriptLine::status(t!(
                "tui.approval.noLongerPending",
                pending.tool
            )));
        }
        Ok(())
    }

    /// Toggle the most recent collapsed tool-result line (Ctrl-O) — the
    /// tool-call card expand/collapse.
    pub(crate) fn toggle_last_tool_collapse(&mut self) {
        toggle_last_tool_collapse(&mut self.view.transcript);
    }

    /// Open the full-screen approval detail modal (`v` key): the front
    /// pending approval's full arguments, with y/n/s/Esc decision keys.
    pub(crate) fn open_approval_detail(&mut self) {
        if let Some(pending) = self.pending_approvals.first().cloned() {
            self.overlay = Some(Overlay::ApprovalDetail(pending));
        }
    }

    /// Approve the front approval "for this session" (`s` key): remember its
    /// rule so future matching approvals resolve automatically, then allow
    /// it (TS approve-for-session parity).
    pub(crate) async fn approve_for_session(&mut self) -> anyhow::Result<()> {
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
        self.push_line(TranscriptLine::status(t!(
            "tui.approval.allowedForSession",
            pending.tool,
            pending.rule,
        )));
        if !resolved {
            self.view.transcript.push_line(TranscriptLine::status(t!(
                "tui.approval.noLongerPending",
                pending.tool
            )));
        }
        Ok(())
    }
    /// Refresh the slash-command completion popup from the current input:
    /// active only while typing a bare `/prefix` (no space yet).
    pub(crate) fn refresh_completion(&mut self) {
        self.overlay = completion_for_input(&self.edit.text).map(Overlay::Completion);
    }

    /// Fill the input with the popup's selected command and close the popup.
    pub(crate) fn apply_completion(&mut self) {
        let Some(Overlay::Completion(state)) = self.overlay.take() else {
            return;
        };
        if let Some((cmd, _)) = state.matches.get(state.selected) {
            self.edit.text = cmd.clone();
            self.edit.cursor = self.edit.text.chars().count();
        }
    }

    /// Complete the current input on Tab: cycle the command name or an
    /// argument (model ids for `/model`, closed sets for `/plan|/swarm|/thinking`).
    pub(crate) fn complete(&mut self) {
        let base = self
            .edit
            .tab
            .as_ref()
            .map(|t| t.base.clone())
            .unwrap_or_else(|| self.edit.text.clone());
        let idx = self.edit.tab.as_ref().map(|t| t.idx);
        let (completed, next) = crate::bottom_pane::complete_line(&base, &self.model_aliases, idx);
        match next {
            Some(i) => {
                self.edit.text = completed;
                self.edit.cursor = self.edit.text.chars().count();
                self.edit.tab = Some(TabState { base, idx: i });
            }
            None => self.edit.tab = None,
        }
    }

    pub(crate) fn history_back(&mut self) {
        // Bash mode (`!`-prefixed drafts) only recalls `!`-prefixed history
        // (TS editor history-filter parity).
        let items = crate::bottom_pane::filtered_history(&self.edit.history, self.edit.text.starts_with('!'));
        if items.is_empty() {
            return;
        }
        let idx = self
            .edit
            .history_idx
            .unwrap_or(items.len())
            .min(items.len());
        if idx > 0 {
            self.edit.history_idx = Some(idx - 1);
            self.edit.text = items[idx - 1].clone();
            self.edit.cursor = self.edit.text.chars().count();
        }
    }

    pub(crate) fn history_forward(&mut self) {
        let items = crate::bottom_pane::filtered_history(&self.edit.history, self.edit.text.starts_with('!'));
        if let Some(idx) = self.edit.history_idx {
            if idx + 1 < items.len() {
                self.edit.history_idx = Some(idx + 1);
                self.edit.text = items[idx + 1].clone();
            } else {
                self.edit.history_idx = None;
                self.edit.text.clear();
            }
            self.edit.cursor = self.edit.text.chars().count();
        }
    }

    fn draw(&mut self, frame: &mut ratatui::Frame<'_>) {
        // The chat pane is the area minus the input (3) and footer (2) rows.
        let pane_height = frame.area().height.saturating_sub(5);
        let max = crate::chatwidget::max_scroll(self.view.transcript.len(), pane_height);
        if self.view.follow_bottom {
            // Auto-scroll to the newest line; a manual scroll disables it.
            self.view.scroll = max as u16;
        } else if self.view.scroll as usize > max {
            self.view.scroll = max as u16;
        }
        let completion = match &self.overlay {
            Some(Overlay::Completion(state)) => Some(state),
            _ => None,
        };
        let input_hint =
            crate::bottom_pane::argument_hint(&self.edit.text, &self.model_aliases);
        crate::chatwidget::render_frame(
            frame,
            &self.view.transcript,
            &self.edit.text,
            self.edit.cursor,
            &self.session_id,
            self.view.scroll,
            self.view.theme,
            &self.view.footer,
            completion,
            input_hint.as_deref(),
        );
        if let Some(Overlay::ApprovalDetail(pending)) = self.overlay.as_ref() {
            self.render_approval_modal(frame, pending);
        }
        if let Some(Overlay::Help(panel)) = self.overlay.as_ref() {
            self.render_help_modal(frame, panel);
        }
        if let Some(Overlay::Question(panel)) = self.overlay.as_ref() {
            self.render_question_modal(frame, panel);
        }
    }

    /// Draw the full-screen AskUserQuestion dialog over the chat layout.
    fn render_question_modal(&self, frame: &mut ratatui::Frame<'_>, panel: &QuestionPanel) {
        let height = frame.area().height.saturating_sub(2) as usize;
        let rows: Vec<crate::modal::ModalRow> = panel
            .rows_visible(height)
            .into_iter()
            .map(crate::modal::ModalRow::new)
            .collect();
        crate::modal::render_modal(frame, t("tui.question.title"), &rows, self.view.theme);
    }

    /// Draw the full-screen `/help` panel over the chat layout.
    fn render_help_modal(&self, frame: &mut ratatui::Frame<'_>, panel: &HelpPanel) {
        let height = frame.area().height.saturating_sub(2) as usize;
        let mut rows: Vec<crate::modal::ModalRow> = panel
            .visible(height)
            .iter()
            .map(|row| {
                if row.starts_with("  ") {
                    crate::modal::ModalRow::new(row.clone())
                } else {
                    crate::modal::ModalRow::colored(row.clone(), self.view.theme.assistant)
                }
            })
            .collect();
        if panel.rows.len() > height {
            rows.push(crate::modal::ModalRow::new(t("tui.help.scrollHint").to_string()));
        }
        crate::modal::render_modal(frame, t("tui.help.title"), &rows, self.view.theme);
    }

    /// Draw the full-screen approval detail modal over the chat layout.
    fn render_approval_modal(&self, frame: &mut ratatui::Frame<'_>, pending: &PendingApproval) {
        let rows: Vec<crate::modal::ModalRow> = approval_modal_lines(pending)
            .into_iter()
            .enumerate()
            .map(|(i, text)| match i {
                0 => crate::modal::ModalRow::colored(text, self.view.theme.assistant),
                3 => crate::modal::ModalRow::colored(text, self.view.theme.error),
                _ => crate::modal::ModalRow::new(text),
            })
            .collect();
        crate::modal::render_modal(frame, "approval", &rows, self.view.theme);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::{
        find_last_assistant_text, parse_discuss, resolve_alias, transcript_to_markdown,
    };
    use ratatui::style::{Color, Modifier};

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
        assert_eq!(
            transcript,
            vec![TranscriptEntry::Line(TranscriptLine::thinking(
                "let me think"
            ))]
        );
        // Text streaming after thinking starts a separate assistant line.
        crate::streaming::append_stream(&mut transcript, "answer");
        assert_eq!(
            transcript[1],
            TranscriptEntry::Line(TranscriptLine::streaming("answer"))
        );
        // Only TRAILING thinking lines are dropped at turn close: reasoning
        // above the visible answer stays, trailing reasoning goes.
        crate::streaming::drop_trailing_thinking(&mut transcript);
        assert_eq!(
            transcript,
            vec![
                TranscriptEntry::Line(TranscriptLine::thinking("let me think")),
                TranscriptEntry::Line(TranscriptLine::streaming("answer"))
            ],
            "non-trailing thinking survives"
        );
        transcript.pop(); // the assistant line closes via finish_stream
        crate::streaming::drop_trailing_thinking(&mut transcript);
        assert!(transcript.is_empty(), "trailing thinking dropped");
    }

    #[test]
    fn thinking_renders_dimmed() {
        let lines = crate::chatwidget::styled_lines(
            &[TranscriptEntry::Line(TranscriptLine::thinking("reasoning"))],
            crate::theme::Theme::dark(),
        );
        assert_eq!(lines[0].spans[0].content, "reasoning");
        assert_eq!(lines[0].spans[0].style.fg, Some(Color::DarkGray));
        assert!(lines[0].spans[0]
            .style
            .add_modifier
            .contains(Modifier::ITALIC));
    }

    #[test]
    fn streaming_append_and_finish() {
        // Deltas accumulate on a trailing streaming line.
        let mut transcript = Vec::new();
        crate::streaming::append_stream(&mut transcript, "hello ");
        crate::streaming::append_stream(&mut transcript, "world");
        assert_eq!(
            transcript,
            vec![TranscriptEntry::Line(TranscriptLine::streaming(
                "hello world"
            ))],
            "deltas append to the streaming line"
        );
        // A non-streaming line in between (e.g. a tool event) starts a new
        // streaming line instead of corrupting the previous message.
        transcript.push(TranscriptEntry::Line(TranscriptLine::tool("Bash started")));
        crate::streaming::append_stream(&mut transcript, "step 2");
        assert_eq!(
            transcript[2],
            TranscriptEntry::Line(TranscriptLine::streaming("step 2"))
        );

        // finish_stream replaces the trailing streaming line with the final
        // transcript, and reports the replacement.
        assert!(crate::streaming::finish_stream(
            &mut transcript,
            "final text".to_string()
        ));
        assert_eq!(
            transcript[2],
            TranscriptEntry::Line(TranscriptLine::assistant("final text"))
        );
        // With no streaming line it appends a fresh assistant line.
        assert!(!crate::streaming::finish_stream(
            &mut transcript,
            "another".to_string()
        ));
        assert_eq!(
            transcript.last(),
            Some(&TranscriptEntry::Line(TranscriptLine::assistant("another")))
        );
    }

    #[test]
    fn streaming_renders_distinct() {
        let lines = crate::chatwidget::styled_lines(
            &[TranscriptEntry::Line(TranscriptLine::streaming("growing"))],
            crate::theme::Theme::dark(),
        );
        let text: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(text, "growing");
    }

    #[tokio::test]
    async fn tool_events_build_structured_cards() {
        // started -> card; settled -> result lands on the same card.
        let mut app = App::new(
            kimi_sdk::Harness::embedded().expect("harness"),
            Some("s-tool"),
        );
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
        assert_eq!(app.view.transcript.len(), 1, "one card, not two lines");
        match &app.view.transcript[0] {
            TranscriptEntry::ToolCall(tc) => {
                assert_eq!(tc.tool_name, "Bash");
                assert_eq!(tc.result.as_deref(), Some("file1\nfile2"));
                assert!(!tc.is_error);
            }
            _ => panic!("expected a ToolCall card"),
        }
    }

    #[tokio::test]
    async fn tool_native_lands_on_card() {
        // A native tool result (engine executed it in-process) carries the
        // settled semantics — result lands on the matching card.
        let mut app = App::new(
            kimi_sdk::Harness::embedded().expect("harness"),
            Some("s-tool3"),
        );
        app.handle_tool_event(&serde_json::json!({
            "type": "tool.native",
            "tool_call_id": "t5",
            "tool_name": "Grep",
            "arguments": { "pattern": "foo" },
            "content": "a.txt:1:foo",
            "is_error": false,
        }));
        match &app.view.transcript[0] {
            TranscriptEntry::ToolCall(tc) => {
                assert_eq!(tc.tool_name, "Grep");
                assert_eq!(tc.result.as_deref(), Some("a.txt:1:foo"));
                assert!(!tc.is_error);
            }
            _ => panic!("expected a ToolCall card for tool.native"),
        }
    }

    #[test]
    fn task_events_build_lifecycle_cards() {
        // started creates a running card; terminated lands the status +
        // duration on the same card (TS background-agent-status parity).
        let mut transcript = Vec::new();
        upsert_task_card(
            &mut transcript,
            &serde_json::json!({
                "type": "session.task.started",
                "session_id": "s1",
                "task_id": "task-1",
                "description": "review the diff",
                "kind": "agent",
                "started_at_ms": 1000,
            }),
        );
        upsert_task_card(
            &mut transcript,
            &serde_json::json!({
                "type": "session.task.terminated",
                "session_id": "s1",
                "task_id": "task-1",
                "status": "completed",
                "description": "review the diff",
                "kind": "agent",
                "ended_at_ms": 3500,
            }),
        );
        assert_eq!(transcript.len(), 1, "one card, updated in place");
        match &transcript[0] {
            TranscriptEntry::Task(task) => {
                assert_eq!(task.task_id, "task-1");
                assert_eq!(task.description, "review the diff");
                assert_eq!(task.kind, "agent");
                assert_eq!(task.status, "completed");
                assert!(task.ended);
                assert_eq!(
                    (task.started_at_ms, task.ended_at_ms),
                    (Some(1000), Some(3500))
                );
            }
            _ => panic!("expected a Task card"),
        }

        // A terminated ghost without a started event still shows as ended.
        let mut ghost = Vec::new();
        upsert_task_card(
            &mut ghost,
            &serde_json::json!({
                "type": "session.task.terminated",
                "task_id": "ghost-1",
                "description": "restored",
                "kind": "process",
                "status": "failed",
                "ended_at_ms": 7,
            }),
        );
        match &ghost[0] {
            TranscriptEntry::Task(task) => {
                assert_eq!(task.status, "failed");
                assert!(task.ended);
                assert_eq!(task.started_at_ms, None);
            }
            _ => panic!("expected a Task card for the ghost"),
        }
    }

    #[tokio::test]
    async fn tool_settled_without_started_appends_card() {
        // Replay edge: a settled event with no prior started still shows a card.
        let mut app = App::new(
            kimi_sdk::Harness::embedded().expect("harness"),
            Some("s-tool2"),
        );
        app.handle_tool_event(&serde_json::json!({
            "type": "session.tool.settled",
            "tool_call_id": "t9",
            "tool_name": "Read",
            "content": "file contents",
            "is_error": true,
        }));
        assert_eq!(app.view.transcript.len(), 1);
        match &app.view.transcript[0] {
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
        let mut app = App::new(
            kimi_sdk::Harness::embedded().expect("harness"),
            Some("s-tool3"),
        );
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
        assert_eq!(app.view.transcript.len(), 2, "two cards, no misattribution");
        match (&app.view.transcript[0], &app.view.transcript[1]) {
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
                is_question: false,
                collapsed: true,
                duration: None,
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
        assert!(
            completion_for_input("/session x").is_none(),
            "space closes popup"
        );
        assert!(completion_for_input("/zzz").is_none(), "no matches");
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
        assert_eq!(lines[0].spans[0].content, "✨ hi");
        assert!(lines[0].spans[0]
            .style
            .add_modifier
            .contains(Modifier::BOLD));
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
        assert_eq!(
            interrupt_action(KeyCode::Char('c'), KeyModifiers::NONE),
            None
        );
        assert_eq!(interrupt_action(KeyCode::Enter, KeyModifiers::NONE), None);
    }

    #[test]
    fn smoke_renders_two_panes() {
        use ratatui::backend::TestBackend;

        let transcript = vec![
            TranscriptEntry::Line(TranscriptLine::user("hi")),
            TranscriptEntry::Line(TranscriptLine::assistant("hello there")),
            TranscriptEntry::Line(TranscriptLine::tool("Read started")),
        ];
        // Pin the locale (global t(); dev tui.toml may be zh).
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
        terminal
            .draw(|frame| {
                let footer = crate::footer::FooterInfo {
                    plan: false,
                    swarm: false,
                    auto: false,
                    yolo: false,
                    model: "kimi-k2".into(),
                    thinking: String::new(),
                    ctx_pct: 0,
                    cwd: String::new(),
                    branch: None,
                    goal: None,
                };
                crate::chatwidget::render_frame(
                    frame,
                    &transcript,
                    "/help",
                    2,
                    "sess-1",
                    0,
                    crate::theme::Theme::dark(),
                    &footer,
                    None,
                    None,
                );
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let lines = buffer_text(&buffer);
        // Both panes render with their block titles.
        assert!(
            lines.iter().any(|l| l.contains("chat")),
            "chat pane title missing:\n{}",
            lines.join("\n")
        );
        assert!(
            lines.iter().any(|l| l.contains("input — sess-1")),
            "input pane title missing:\n{}",
            lines.join("\n")
        );
        // Transcript roles render with their prefixes, in order. (`✨` is a
        // wide glyph; match on the text to stay buffer-width agnostic.)
        let first_visible: String = lines
            .iter()
            .filter(|l| !l.trim().is_empty())
            .cloned()
            .collect();
        let user_at = first_visible.find("hi").expect("user line missing");
        let tool_at = first_visible
            .find("⚙ Read started")
            .expect("tool line missing");
        let assistant_at = first_visible
            .find("hello there")
            .expect("assistant line missing");
        assert!(
            user_at < assistant_at && assistant_at < tool_at,
            "role order wrong"
        );
        // The user line is bold; the gear glyph is blue. (`✨` is a wide
        // glyph, so assert "some bold cell exists" — the user line is the
        // only bold content in this transcript.)
        assert!(
            buffer
                .content
                .iter()
                .any(|c| c.style().add_modifier.contains(Modifier::BOLD)),
            "user line should be bold"
        );
        let gear_cell = buffer
            .content
            .iter()
            .find(|c| c.symbol() == "⚙")
            .expect("⚙ cell");
        assert_eq!(gear_cell.style().fg, Some(Color::Blue));
        // The terminal cursor sits at the input editing position: inside the
        // input pane border (row 8 of 12 with the footer strip below; col =
        // 1 border + 2 chars in).
        let pos = terminal.get_cursor_position().unwrap();
        assert_eq!((pos.x, pos.y), (3, 8));
    }

    #[test]
    fn max_scroll_matches_viewport() {
        // A 12-row terminal: chat pane is 9 rows, minus borders = 7 visible.
        assert_eq!(crate::chatwidget::max_scroll(10, 9), 3);
        assert_eq!(crate::chatwidget::max_scroll(7, 9), 0);
        // Empty transcript never underflows.
        assert_eq!(crate::chatwidget::max_scroll(0, 9), 0);
    }

    #[test]
    fn aliases_resolve_to_canonical_commands() {
        assert_eq!(resolve_alias("/yes"), "/yolo");
        assert_eq!(resolve_alias("/h"), "/help");
        assert_eq!(resolve_alias("/?"), "/help");
        assert_eq!(resolve_alias("/q"), "/quit");
        assert_eq!(resolve_alias("/rename"), "/title");
        assert_eq!(resolve_alias("/task"), "/tasks");
        assert_eq!(resolve_alias("/effort"), "/thinking");
        assert_eq!(resolve_alias("/providers"), "/provider");
        assert_eq!(resolve_alias("/disconnect"), "/logout");
        assert_eq!(resolve_alias("/plan"), "/plan");
    }

    #[test]
    fn parses_discuss_arguments() {
        let args = parse_discuss("migration with rust,ts,architect").unwrap();
        assert_eq!(args.topic, "migration");
        assert_eq!(args.roles, vec!["rust", "ts", "architect"]);
        assert!(!args.debate);

        // No roles → the default trio.
        let args = parse_discuss("just a topic").unwrap();
        assert_eq!(args.roles, vec!["researcher", "architect", "engineer"]);

        // --debate flag.
        let args = parse_discuss("--debate api with backend,frontend").unwrap();
        assert!(args.debate);
        assert_eq!(args.topic, "api");

        // Errors.
        assert_eq!(parse_discuss("").unwrap_err(), "usage");
        assert_eq!(parse_discuss("topic with solo").unwrap_err(), "need-roles");
    }

    #[test]
    fn finds_last_assistant_reply() {
        let t = vec![
            TranscriptEntry::Line(TranscriptLine::user("hi")),
            TranscriptEntry::Line(TranscriptLine::assistant("first reply")),
            TranscriptEntry::Line(TranscriptLine::user("again")),
            TranscriptEntry::Line(TranscriptLine::status("status")),
            TranscriptEntry::Line(TranscriptLine::assistant("second reply")),
        ];
        assert_eq!(
            find_last_assistant_text(&t).as_deref(),
            Some("second reply")
        );
        // A trailing empty assistant line is skipped.
        let t2 = vec![
            TranscriptEntry::Line(TranscriptLine::assistant("  ")),
            TranscriptEntry::Line(TranscriptLine::assistant("real")),
        ];
        assert_eq!(find_last_assistant_text(&t2).as_deref(), Some("real"));
        // No assistant text at all.
        assert!(find_last_assistant_text(&[]).is_none());
    }

    #[test]
    fn transcript_renders_as_markdown() {
        let t = vec![
            TranscriptEntry::Line(TranscriptLine::user("question")),
            TranscriptEntry::Line(TranscriptLine::assistant("answer")),
            TranscriptEntry::ToolCall(ToolCallEntry {
                tool_call_id: "t1".into(),
                tool_name: "Bash".into(),
                args: "{}".into(),
                result: Some("ok".into()),
                is_error: false,
                is_question: false,
                collapsed: false,
                duration: None,
            }),
        ];
        let md = transcript_to_markdown(&t);
        assert!(md.contains("## User\n\nquestion"), "md: {md}");
        assert!(md.contains("## Assistant\n\nanswer"), "md: {md}");
        assert!(md.contains("## Tool: Bash"), "md: {md}");
        assert!(md.contains("ok"), "md: {md}");
    }

    

    

    #[test]
    fn help_panel_rows_cover_commands_and_scroll() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let panel = HelpPanel::new();
        assert!(!panel.rows.is_empty());
        // Commands section present with real command rows.
        assert!(
            panel.rows.iter().any(|r| r.starts_with("/help")),
            "has /help row"
        );
        // Visible window slices and clamps at the ends.
        assert_eq!(panel.visible(panel.rows.len()), panel.rows.as_slice());
        assert_eq!(panel.visible(0).len(), 0);
        assert_eq!(panel.visible(3).len(), 3);
        // A huge window shows everything (clamped).
        assert_eq!(panel.visible(10_000).len(), panel.rows.len());
    }

    

    

    

    

    

    

    

    

    
}
