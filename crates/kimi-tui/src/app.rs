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
const SLASH_COMMANDS: &[&str] = &[
    "/add-dir",
    "/approvals",
    "/approve",
    "/archive",
    "/clear",
    "/compact",
    "/config",
    "/deny",
    "/exit",
    "/export",
    "/fork",
    "/goal",
    "/goal-cancel",
    "/goal-pause",
    "/goal-resume",
    "/goal-status",
    "/help",
    "/import",
    "/info",
    "/model",
    "/models",
    "/plan",
    "/quit",
    "/resume",
    "/sessions",
    "/skills",
    "/status",
    "/steer",
    "/swarm",
    "/thinking",
    "/undo",
    "/usage",
];

/// Closed argument sets for Tab completion of a few commands.
const ON_OFF_ARGS: &[&str] = &["on", "off"];
const THINKING_ARGS: &[&str] = &["low", "medium", "high"];

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

/// A single transcript line: text plus the role it renders as.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptLine {
    pub kind: TranscriptKind,
    pub text: String,
}

impl TranscriptLine {
    pub fn user(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::User, text: text.into() }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Assistant, text: text.into() }
    }
    pub fn streaming(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Streaming, text: text.into() }
    }
    pub fn thinking(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Thinking, text: text.into() }
    }
    pub fn tool(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Tool, text: text.into() }
    }
    pub fn status(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Status, text: text.into() }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self { kind: TranscriptKind::Error, text: text.into() }
    }
}

/// Append a live text delta to the trailing streaming line, starting one if
/// the transcript tail is not a streaming line (e.g. after a tool event).
fn append_stream(transcript: &mut Vec<TranscriptLine>, delta: &str) {
    if let Some(last) = transcript.last_mut() {
        if last.kind == TranscriptKind::Streaming {
            last.text.push_str(delta);
            return;
        }
    }
    transcript.push(TranscriptLine::streaming(delta.to_string()));
}

/// Append a thinking delta to the trailing thinking line (same accumulate
/// semantics as `append_stream`).
fn append_thinking(transcript: &mut Vec<TranscriptLine>, delta: &str) {
    if let Some(last) = transcript.last_mut() {
        if last.kind == TranscriptKind::Thinking {
            last.text.push_str(delta);
            return;
        }
    }
    transcript.push(TranscriptLine::thinking(delta.to_string()));
}

/// Drop trailing transient thinking lines (reasoning never enters the
/// transcript once the turn closes).
fn drop_trailing_thinking(transcript: &mut Vec<TranscriptLine>) {
    while transcript.last().is_some_and(|l| l.kind == TranscriptKind::Thinking) {
        transcript.pop();
    }
}

/// Close a streaming turn: replace the trailing streaming line with the final
/// assistant text (or push it when nothing streamed). Returns whether a line
/// was replaced.
fn finish_stream(transcript: &mut Vec<TranscriptLine>, final_text: String) -> bool {
    if let Some(last) = transcript.last_mut() {
        if last.kind == TranscriptKind::Streaming {
            last.kind = TranscriptKind::Assistant;
            last.text = final_text;
            return true;
        }
    }
    transcript.push(TranscriptLine::assistant(final_text));
    false
}

/// State for an in-progress Tab completion cycle.
#[derive(Debug, Clone, PartialEq)]
struct TabState {
    /// The input as it was when the cycle started (matches cycle on this).
    base: String,
    /// Index into the current match list.
    idx: usize,
}

/// A pending tool approval awaiting an interactive y/n decision.
#[derive(Debug, Clone, PartialEq)]
struct PendingApproval {
    id: String,
    tool: String,
    /// Matching permission rule label (e.g. "Always allow"), when known.
    rule: String,
    /// Compact preview of the tool arguments (bounded length).
    args: String,
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
/// Returns how many new approvals were queued.
fn queue_new_approvals(queue: &mut Vec<PendingApproval>, items: &[serde_json::Value]) -> usize {
    let mut added = 0;
    for item in items {
        let id = item["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let tool = item["tool_name"].as_str().unwrap_or("?").to_string();
        let rule = item["approval_rule"].as_str().unwrap_or("?").to_string();
        let args = args_preview(&item["arguments"]);
        if !queue.iter().any(|p| p.id == id) {
            queue.push(PendingApproval { id, tool, rule, args });
            added += 1;
        }
    }
    added
}

/// An interrupt a running turn should react to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InterruptAction {
    /// Abort the current turn via the session cancel flag.
    CancelTurn,
}

/// Map a pressed key to an interrupt action (pure, tested).
fn interrupt_action(code: KeyCode, modifiers: event::KeyModifiers) -> Option<InterruptAction> {
    match code {
        KeyCode::Esc => Some(InterruptAction::CancelTurn),
        KeyCode::Char('c') if modifiers.contains(event::KeyModifiers::CONTROL) => {
            Some(InterruptAction::CancelTurn)
        }
        _ => None,
    }
}

/// The interactive chat application.
pub struct App {
    harness: Harness,
    /// Transcript lines rendered in the chat panel.
    transcript: Vec<TranscriptLine>,
    /// The user's current input line.
    input: String,
    /// Prompt history (up/down).
    history: Vec<String>,
    history_idx: Option<usize>,
    session_id: String,
    session: Option<kimi_sdk::Session>,
    /// Model aliases for `/model` Tab completion.
    model_aliases: Vec<String>,
    /// Active Tab completion cycle, if any.
    tab: Option<TabState>,
    /// Pending tool approvals queued for interactive y/n resolution.
    pending_approvals: Vec<PendingApproval>,
    /// Transcript scroll offset (lines from the bottom).
    scroll: u16,
    /// Session status summary for the footer (plan/swarm).
    status: String,
    /// Semantic color palette resolved from `tui.toml`.
    theme: crate::theme::Theme,
}

impl App {
    /// Create the app around an engine harness (embedded or remote).
    pub fn new(harness: Harness, session_id: &str) -> Self {
        Self {
            harness,
            transcript: Vec::new(),
            input: String::new(),
            history: Vec::new(),
            history_idx: None,
            session_id: session_id.to_string(),
            session: None,
            model_aliases: Vec::new(),
            tab: None,
            pending_approvals: Vec::new(),
            scroll: 0,
            status: String::new(),
            theme: crate::theme::load_theme(),
        }
    }

    /// Run the event loop until the user quits (`/quit` or Ctrl-C).
    pub async fn run(&mut self) -> anyhow::Result<()> {
        // Open the session up front.
        let mut session = self.harness.create_session(&self.session_id).await?;
        // Resume semantics: create rebuilds a fresh agent, load re-applies
        // the persisted context + goal for an existing session (no-op for a
        // brand-new one).
        let _ = session.load().await;
        // Seed the footer status (best-effort) before the session moves.
        let status = session.get_status().await;
        let plan = status["result"]["plan_mode"].as_bool().unwrap_or(false);
        let swarm = status["result"]["swarm_mode"].as_bool().unwrap_or(false);
        self.status = format!("plan={} swarm={}", if plan { "on" } else { "off" }, if swarm { "on" } else { "off" });
        self.session = Some(session);
        self.transcript.push(TranscriptLine::status(format!("session {} ready — type /help", self.session_id)));
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
                    KeyCode::Char(ch) => {
                        self.tab = None;
                        self.input.push(ch);
                    }
                    KeyCode::Backspace => {
                        self.tab = None;
                        self.input.pop();
                    }
                    KeyCode::Enter => {
                        self.tab = None;
                        let line = std::mem::take(&mut self.input);
                        if line.trim().is_empty() {
                            continue;
                        }
                        if self.dispatch(&line).await? {
                            return Ok(());
                        }
                        self.history.push(line);
                        self.history_idx = None;
                    }
                    KeyCode::Tab => self.complete(),
                    KeyCode::PageUp => self.scroll = self.scroll.saturating_add(5),
                    KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(5),
                    KeyCode::Up => {
                        self.tab = None;
                        self.history_back();
                    }
                    KeyCode::Down => {
                        self.tab = None;
                        self.history_forward();
                    }
                    KeyCode::Esc => return Ok(()),
                    _ => {}
                },
                _ => {}
            }
        }
    }

    /// Handle one submitted line (slash command or prompt). Returns `true`
    /// when the app should quit.
    async fn dispatch(&mut self, line: &str) -> anyhow::Result<bool> {
        if line.starts_with('/') {
            let (cmd, rest) = line.split_once(' ').map(|(c, r)| (c, r.trim())).unwrap_or((line, ""));
            match cmd {
                "/quit" | "/exit" => return Ok(true),
                "/help" => {
                    self.transcript
                        .push(TranscriptLine::status(format!("commands: {}", SLASH_COMMANDS.join(" "))));
                }
                "/approvals" => {
                    let items = self.harness.approvals(Some(&self.session_id)).await?;
                    if items.is_empty() {
                        self.transcript.push(TranscriptLine::status("no pending approvals"));
                    }
                    for item in items.iter().take(10) {
                        let id = item["id"].as_str().unwrap_or("?");
                        let tool = item["tool_name"].as_str().unwrap_or("?");
                        let rule = item["approval_rule"].as_str().unwrap_or("?");
                        self.transcript.push(TranscriptLine::status(format!("{id}  {tool}  ({rule})")));
                    }
                }
                "/approve" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /approve <approval-id>"));
                    } else {
                        let resolved = self.harness.resolve_approval(rest, true, None).await?;
                        self.transcript.push(TranscriptLine::status(if resolved {
                            "approval allowed"
                        } else {
                            "approval not found"
                        }));
                    }
                }
                "/deny" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /deny <approval-id>"));
                    } else {
                        let resolved = self.harness.resolve_approval(rest, false, Some("denied by user")).await?;
                        self.transcript.push(TranscriptLine::status(if resolved {
                            "approval denied"
                        } else {
                            "approval not found"
                        }));
                    }
                }
                "/status" => {
                    let status = self.session.as_mut().expect("session").get_status().await;
                    self.transcript.push(TranscriptLine::status(format!(
                        "status: {}",
                        serde_json::to_string_pretty(&status["result"]).unwrap_or_default()
                    )));
                }
                "/info" => {
                    match self.harness.core_version().await {
                        Ok(v) => self.transcript.push(TranscriptLine::status(format!(
                            "kimi {} — session {}",
                            v, self.session_id
                        ))),
                        Err(e) => self
                            .transcript
                            .push(TranscriptLine::error(format!("info failed: {e}"))),
                    }
                }
                "/config" => {
                    let config = self.harness.config().await;
                    match config {
                        Ok(cfg) => self.transcript.push(TranscriptLine::status(format!(
                            "config: {}",
                            serde_json::to_string_pretty(&cfg).unwrap_or_default()
                        ))),
                        Err(e) => self
                            .transcript
                            .push(TranscriptLine::error(format!("config failed: {e}"))),
                    }
                }
                "/skills" => {
                    let skills = self.session.as_mut().expect("session").list_skills().await;
                    match skills {
                        Ok(skills) => {
                            let names: Vec<&str> = skills["skills"]
                                .as_array()
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|s| s["name"].as_str())
                                        .collect()
                                })
                                .unwrap_or_default();
                            if names.is_empty() {
                                self.transcript.push(TranscriptLine::status("no skills registered"));
                            } else {
                                self.transcript.push(TranscriptLine::status(format!(
                                    "skills: {}",
                                    names.join(", ")
                                )));
                            }
                        }
                        Err(e) => self
                            .transcript
                            .push(TranscriptLine::error(format!("skills failed: {e}"))),
                    }
                }
                "/plan" => {
                    let enabled = rest == "on" || rest.is_empty();
                    self.session.as_mut().expect("session").set_plan_mode(enabled).await?;
                    self.transcript.push(TranscriptLine::status(format!(
                        "plan mode {}",
                        if enabled { "on" } else { "off" }
                    )));
                    self.refresh_status().await;
                }
                "/swarm" => {
                    let enabled = rest == "on" || rest.is_empty();
                    self.session.as_mut().expect("session").set_swarm_mode(enabled, None).await?;
                    self.transcript.push(TranscriptLine::status(format!(
                        "swarm mode {}",
                        if enabled { "on" } else { "off" }
                    )));
                    self.refresh_status().await;
                }
                "/thinking" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /thinking <low|medium|high>"));
                    } else {
                        self.session.as_mut().expect("session").set_thinking(Some(rest)).await?;
                        self.transcript.push(TranscriptLine::status(format!("thinking effort set to {rest}")));
                    }
                }
                "/models" => {
                    let (aliases, default_model) = self.harness.list_models().await?;
                    if aliases.is_empty() {
                        self.transcript.push(TranscriptLine::status("no model aliases configured"));
                    }
                    for alias in aliases.iter().take(20) {
                        self.transcript.push(TranscriptLine::status(alias.clone()));
                    }
                    if let Some(default_model) = default_model {
                        self.transcript.push(TranscriptLine::status(format!("default: {default_model}")));
                    }
                }
                "/model" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /model <model-id>"));
                    } else {
                        self.session.as_mut().expect("session").set_model(rest).await?;
                        self.transcript.push(TranscriptLine::status(format!("model set to {rest}")));
                    }
                }
                "/resume" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /resume <session-id>"));
                    } else {
                        let mut new_session = self.harness.create_session(rest).await?;
                        // Restore the persisted state of the resumed session.
                        let _ = new_session.load().await;
                        self.session = Some(new_session);
                        self.session_id = rest.to_string();
                        self.transcript.push(TranscriptLine::status(format!("switched to session {rest}")));
                    }
                }
                "/goal" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /goal <objective>"));
                    } else {
                        let snapshot = self.session.as_mut().expect("session").create_goal(rest).await?;
                        self.transcript.push(TranscriptLine::status(format!(
                            "goal created: {}",
                            snapshot["objective"]
                        )));
                    }
                }
                "/goal-cancel" => {
                    self.session.as_mut().expect("session").cancel_goal().await?;
                    self.transcript.push(TranscriptLine::status("goal cancelled"));
                }
                "/goal-pause" => {
                    self.session.as_mut().expect("session").pause_goal(Some(rest)).await?;
                    self.transcript.push(TranscriptLine::status("goal paused"));
                }
                "/goal-resume" => {
                    self.session.as_mut().expect("session").resume_goal(Some(rest)).await?;
                    self.transcript.push(TranscriptLine::status("goal resumed"));
                }
                "/add-dir" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /add-dir <path>"));
                    } else {
                        match self.session.as_mut().expect("session").add_additional_dir(rest).await {
                            Ok(_) => self.transcript.push(TranscriptLine::status(format!("added dir {rest}"))),
                            Err(e) => self.transcript.push(TranscriptLine::error(format!("add-dir failed: {e}"))),
                        }
                    }
                }
                "/clear" => {
                    self.session.as_mut().expect("session").clear_context().await?;
                    self.transcript.push(TranscriptLine::status("context cleared"));
                }
                "/compact" => {
                    match self.session.as_mut().expect("session").compact().await {
                        Ok(_) => self.transcript.push(TranscriptLine::status("context compacted")),
                        Err(e) => self.transcript.push(TranscriptLine::error(format!("compact failed: {e}"))),
                    }
                }
                "/usage" => {
                    let usage = self.session.as_mut().expect("session").get_usage().await?;
                    self.transcript.push(TranscriptLine::status(format!(
                        "usage: {}",
                        serde_json::to_string(&usage).unwrap_or_default()
                    )));
                }
                "/undo" => {
                    let undone = self.session.as_mut().expect("session").undo_history(1).await?;
                    self.transcript.push(TranscriptLine::status(format!(
                        "undo: {}",
                        serde_json::to_string(&undone).unwrap_or_default()
                    )));
                }
                "/fork" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /fork <new-session-id>"));
                    } else {
                        self.session.as_mut().expect("session").fork(rest, None, None).await?;
                        self.transcript.push(TranscriptLine::status(format!("forked to {rest}")));
                    }
                }
                "/steer" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /steer <text>"));
                    } else {
                        let queued = self
                            .session
                            .as_mut()
                            .expect("session")
                            .steer(serde_json::json!([{ "type": "text", "text": rest }]))
                            .await?;
                        self.transcript.push(TranscriptLine::status(format!("steer queued: {queued}")));
                    }
                }
                "/import" => {
                    if rest.is_empty() {
                        self.transcript.push(TranscriptLine::status("usage: /import <text>"));
                    } else {
                        self.session
                            .as_mut()
                            .expect("session")
                            .import_context(rest, "tui")
                            .await?;
                        self.transcript
                            .push(TranscriptLine::status(format!("imported {} chars", rest.chars().count())));
                    }
                }
                "/goal-status" => {
                    let goal = self.session.as_mut().expect("session").goal().await?;
                    self.transcript.push(TranscriptLine::status(format!(
                        "goal: {}",
                        serde_json::to_string(&goal["goal"]).unwrap_or_default()
                    )));
                }
                "/sessions" => {
                    let sessions = self.harness.list_sessions(50).await?;
                    if sessions.is_empty() {
                        self.transcript.push(TranscriptLine::status("no sessions"));
                    }
                    for s in sessions.iter().take(20) {
                        let id = s["id"].as_str().unwrap_or("");
                        let title = s["title"].as_str().unwrap_or("(untitled)");
                        self.transcript.push(TranscriptLine::status(format!("{id}  {title}")));
                    }
                }
                "/export" => {
                    match self.harness.export_session(&self.session_id).await {
                        Ok(zip) => {
                            let path = format!("{}.zip", self.session_id);
                            match std::fs::write(&path, &zip) {
                                Ok(()) => self.transcript.push(TranscriptLine::status(format!(
                                    "exported to {path} ({} bytes)",
                                    zip.len()
                                ))),
                                Err(e) => self.transcript.push(TranscriptLine::error(format!("write failed: {e}"))),
                            }
                        }
                        Err(e) => self.transcript.push(TranscriptLine::error(format!("export failed: {e}"))),
                    }
                }
                "/archive" => {
                    let Some(session) = self.session.as_mut() else {
                        self.transcript.push(TranscriptLine::error("archive: no active session"));
                        return Ok(false);
                    };
                    match session.archive().await {
                        Ok(true) => self
                            .transcript
                            .push(TranscriptLine::status("session archived")),
                        Ok(false) => self
                            .transcript
                            .push(TranscriptLine::error("archive: session not found")),
                        Err(e) => self
                            .transcript
                            .push(TranscriptLine::error(format!("archive failed: {e}"))),
                    }
                }
                other => self
                    .transcript
                    .push(TranscriptLine::error(format!("unknown command {other} — try /help"))),
            }
            return Ok(false);
        }
        // A real prompt: run it and render the transcript, pumping engine
        // events into the panel while the turn runs. The prompt future lives
        // in a block so its `&mut session` borrow ends before we read back.
        self.transcript.push(TranscriptLine::user(line));
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
                self.transcript.push(TranscriptLine::error(format!(
                    "error: {}",
                    error["message"].as_str().unwrap_or("unknown")
                )));
            } else {
                // Close the streamed turn: drop transient thinking, replace
                // the live line with the final transcript (or append it when
                // nothing streamed).
                drop_trailing_thinking(&mut self.transcript);
                match self.session.as_mut().expect("session").transcript().await? {
                    Some(text) => {
                        finish_stream(&mut self.transcript, text);
                    }
                    None => {
                        finish_stream(&mut self.transcript, result.to_string());
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
                append_thinking(&mut self.transcript, think);
            } else if let Some(delta) = kimi_ui::stream_delta(&event) {
                append_stream(&mut self.transcript, delta);
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
        // Tool progress reads differently from transcript/status.
        let is_tool = r#type.starts_with("session.tool.");
        self.transcript.push(if is_tool {
            TranscriptLine::tool(line)
        } else {
            TranscriptLine::status(line)
        });
    }

    /// Fetch pending approvals after an `approval.requested` event and queue
    /// them for interactive y/n resolution.
    async fn request_approval(&mut self) {
        let session_id = self.session_id.clone();
        match self.harness.approvals(Some(&session_id)).await {
            Ok(items) if !items.is_empty() => {
                let added = queue_new_approvals(&mut self.pending_approvals, &items);
                if added > 0 {
                    if let Some(head) = self.pending_approvals.last() {
                        self.transcript.push(TranscriptLine::status(format!(
                            "approval requested: {} ({rule}) {args} — press y/n",
                            head.tool,
                            rule = head.rule,
                            args = head.args,
                        )));
                    }
                }
            }
            _ => {
                self.transcript
                    .push(TranscriptLine::status("approval requested — run /approvals to inspect"));
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
            if interrupt_action(key.code, key.modifiers) == Some(InterruptAction::CancelTurn) {
                let mut session = self.session.clone().expect("session");
                session.cancel().await;
                self.transcript.push(TranscriptLine::status("turn cancelled"));
                return Ok(());
            }
            if !self.pending_approvals.is_empty() {
                match key.code {
                    KeyCode::Char('y') => self.answer_approval(true).await?,
                    KeyCode::Char('n') => self.answer_approval(false).await?,
                    _ => {}
                }
            }
        }
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
            self.transcript.push(TranscriptLine::status(format!("{} {}", pending.tool, action)));
        } else {
            self.transcript
                .push(TranscriptLine::status(format!("{} no longer pending", pending.tool)));
        }
        Ok(())
    }

    /// Complete the current input on Tab: cycle the command name or an
    /// argument (model ids for `/model`, closed sets for `/plan|/swarm|/thinking`).
    fn complete(&mut self) {
        let base = self.tab.as_ref().map(|t| t.base.clone()).unwrap_or_else(|| self.input.clone());
        let idx = self.tab.as_ref().map(|t| t.idx);
        let (completed, next) = complete_line(&base, &self.model_aliases, idx);
        match next {
            Some(i) => {
                self.input = completed;
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
        }
    }

    fn draw(&mut self, frame: &mut ratatui::Frame<'_>) {
        // The chat pane is the area minus the fixed 3-line input pane.
        let pane_height = frame.area().height.saturating_sub(3);
        let max = max_scroll(self.transcript.len(), pane_height);
        if self.scroll as usize > max {
            self.scroll = max as u16;
        }
        render_frame(
            frame,
            &self.transcript,
            &self.input,
            &self.session_id,
            &self.status,
            self.scroll,
            self.theme,
        );
    }
}

/// Render the two-pane chat layout into the frame. Pure over the app state
/// so smoke tests can drive it with a `TestBackend`.
fn render_frame(
    frame: &mut ratatui::Frame<'_>,
    transcript: &[TranscriptLine],
    input: &str,
    session_id: &str,
    status: &str,
    scroll: u16,
    theme: crate::theme::Theme,
) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(3)])
        .split(frame.area());
    let chat = Paragraph::new(styled_lines(transcript, theme))
        .block(Block::default().borders(Borders::ALL).title("chat"))
        .scroll((scroll, 0));
    let input = Paragraph::new(input)
        .block(Block::default().borders(Borders::ALL).title(format!("input — {session_id} | {status}")));
    frame.render_widget(chat, chunks[0]);
    frame.render_widget(input, chunks[1]);
}

/// Largest scroll offset that still keeps the last transcript line visible
/// in a `pane_height`-tall chat pane (minus its borders).
fn max_scroll(total: usize, pane_height: u16) -> usize {
    total.saturating_sub(pane_height.saturating_sub(2) as usize)
}

/// Map transcript entries to styled render lines (role → prefix + style).
/// Assistant (and live-streaming) text is markdown-rendered; everything else
/// stays plain. Colors come from the resolved theme palette.
fn styled_lines(
    transcript: &[TranscriptLine],
    theme: crate::theme::Theme,
) -> Vec<RenderLine<'static>> {
    let mut out = Vec::new();
    for entry in transcript {
        match entry.kind {
            TranscriptKind::Assistant | TranscriptKind::Streaming => {
                out.extend(crate::markdown::render_markdown_themed(&entry.text, theme));
            }
            TranscriptKind::User => out.push(RenderLine::from(Span::styled(
                format!("▶ {}", entry.text),
                Style::default().fg(theme.user).add_modifier(Modifier::BOLD),
            ))),
            // Reasoning is transient and dimmer than the visible stream.
            TranscriptKind::Thinking => out.push(RenderLine::from(Span::styled(
                entry.text.clone(),
                Style::default().fg(theme.thinking).add_modifier(Modifier::ITALIC),
            ))),
            TranscriptKind::Tool => out.push(RenderLine::from(Span::styled(
                format!("  ⚙ {}", entry.text),
                Style::default().fg(theme.tool),
            ))),
            TranscriptKind::Status => out.push(RenderLine::from(Span::styled(
                entry.text.clone(),
                Style::default().fg(theme.status),
            ))),
            TranscriptKind::Error => out.push(RenderLine::from(Span::styled(
                entry.text.clone(),
                Style::default().fg(theme.error),
            ))),
        }
    }
    out
}

/// Resolve a Tab press against `base` (the input when the cycle started, or
/// the current input). Returns the completed input and the next cycle index.
fn complete_line(base: &str, model_aliases: &[String], tab_idx: Option<usize>) -> (String, Option<usize>) {
    // Argument completion: `/plan `, `/swarm `, `/thinking `, `/model `.
    if let Some((cmd, arg)) = base.split_once(' ') {
        let next = match cmd {
            "/plan" | "/swarm" => complete_from(cmd, arg, ON_OFF_ARGS, tab_idx),
            "/thinking" => complete_from(cmd, arg, THINKING_ARGS, tab_idx),
            "/model" => complete_model_arg(arg, model_aliases, tab_idx),
            _ => None,
        };
        return next.map_or((base.to_string(), None), |(s, i)| (s, Some(i)));
    }
    // Command-name completion while typing `/…`.
    if base.starts_with('/') {
        let matches: Vec<&&str> = SLASH_COMMANDS.iter().filter(|c| c.starts_with(base)).collect();
        if matches.is_empty() {
            return (base.to_string(), None);
        }
        let idx = tab_idx.map_or(0, |i| (i + 1) % matches.len());
        return ((*matches[idx]).to_string(), Some(idx));
    }
    (base.to_string(), None)
}

/// Cycle through a closed argument set (`on|off`, `low|medium|high`, …).
fn complete_from(cmd: &str, arg: &str, options: &[&str], tab_idx: Option<usize>) -> Option<(String, usize)> {
    let matches: Vec<&str> = options.iter().copied().filter(|o| o.starts_with(arg)).collect();
    if matches.is_empty() {
        return None;
    }
    let idx = tab_idx.map_or(0, |i| (i + 1) % matches.len());
    Some((format!("{cmd} {}", matches[idx]), idx))
}

/// Cycle through live model aliases for `/model <prefix>`.
fn complete_model_arg(prefix: &str, model_aliases: &[String], tab_idx: Option<usize>) -> Option<(String, usize)> {
    if model_aliases.is_empty() {
        return None;
    }
    let matches: Vec<&String> = model_aliases.iter().filter(|a| a.starts_with(prefix)).collect();
    if matches.is_empty() {
        return None;
    }
    let idx = tab_idx.map_or(0, |i| (i + 1) % matches.len());
    Some((format!("/model {}", matches[idx]), idx))
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
    fn completes_command_names_and_cycles() {
        assert_eq!(complete_line("/", &[], None), ("/add-dir".to_string(), Some(0)));
        assert_eq!(complete_line("/", &[], Some(0)), ("/approvals".to_string(), Some(1)));
        assert_eq!(complete_line("/go", &[], None), ("/goal".to_string(), Some(0)));
        assert_eq!(complete_line("/mod", &[], None), ("/model".to_string(), Some(0)));
        assert_eq!(complete_line("/zzz", &[], None), ("/zzz".to_string(), None));
        // Non-slash input is never completed.
        assert_eq!(complete_line("hi", &[], None), ("hi".to_string(), None));
    }

    #[test]
    fn completes_closed_argument_sets() {
        assert_eq!(complete_line("/plan ", &[], None), ("/plan on".to_string(), Some(0)));
        assert_eq!(complete_line("/plan ", &[], Some(0)), ("/plan off".to_string(), Some(1)));
        assert_eq!(complete_line("/plan ", &[], Some(1)), ("/plan on".to_string(), Some(0)));
        assert_eq!(complete_line("/swarm o", &[], None), ("/swarm on".to_string(), Some(0)));
        assert_eq!(complete_line("/thinking med", &[], None), ("/thinking medium".to_string(), Some(0)));
        // Commands without a closed arg set are left alone.
        assert_eq!(complete_line("/clear ", &[], None), ("/clear ".to_string(), None));
    }

    #[test]
    fn completes_model_aliases() {
        let aliases = ["kimi-k2", "kimi-latest", "claude-3"].map(String::from);
        assert_eq!(complete_line("/model ", &aliases, None), ("/model kimi-k2".to_string(), Some(0)));
        assert_eq!(complete_line("/model ", &aliases, Some(0)), ("/model kimi-latest".to_string(), Some(1)));
        assert_eq!(complete_line("/model kimi-", &aliases, None), ("/model kimi-k2".to_string(), Some(0)));
        assert_eq!(complete_line("/model nope", &aliases, None), ("/model nope".to_string(), None));
        // No aliases configured → untouched.
        assert_eq!(complete_line("/model ", &[], None), ("/model ".to_string(), None));
    }

    #[test]
    fn thinking_accumulates_and_drops() {
        let mut transcript = Vec::new();
        append_thinking(&mut transcript, "let me ");
        append_thinking(&mut transcript, "think");
        assert_eq!(transcript, vec![TranscriptLine::thinking("let me think")]);
        // Text streaming after thinking starts a separate assistant line.
        append_stream(&mut transcript, "answer");
        assert_eq!(transcript[1], TranscriptLine::streaming("answer"));
        // Only TRAILING thinking lines are dropped at turn close: reasoning
        // above the visible answer stays, trailing reasoning goes.
        drop_trailing_thinking(&mut transcript);
        assert_eq!(
            transcript,
            vec![TranscriptLine::thinking("let me think"), TranscriptLine::streaming("answer")],
            "non-trailing thinking survives"
        );
        transcript.pop(); // the assistant line closes via finish_stream
        drop_trailing_thinking(&mut transcript);
        assert!(transcript.is_empty(), "trailing thinking dropped");
    }

    #[test]
    fn thinking_renders_dimmed() {
        let lines = styled_lines(&[TranscriptLine::thinking("reasoning")], crate::theme::Theme::dark());
        assert_eq!(lines[0].spans[0].content, "reasoning");
        assert_eq!(lines[0].spans[0].style.fg, Some(Color::DarkGray));
        assert!(lines[0].spans[0].style.add_modifier.contains(Modifier::ITALIC));
    }

    #[test]
    fn streaming_append_and_finish() {
        // Deltas accumulate on a trailing streaming line.
        let mut transcript = Vec::new();
        append_stream(&mut transcript, "hello ");
        append_stream(&mut transcript, "world");
        assert_eq!(
            transcript,
            vec![TranscriptLine::streaming("hello world")],
            "deltas append to the streaming line"
        );
        // A non-streaming line in between (e.g. a tool event) starts a new
        // streaming line instead of corrupting the previous message.
        transcript.push(TranscriptLine::tool("Bash started"));
        append_stream(&mut transcript, "step 2");
        assert_eq!(transcript[2], TranscriptLine::streaming("step 2"));

        // finish_stream replaces the trailing streaming line with the final
        // transcript, and reports the replacement.
        assert!(finish_stream(&mut transcript, "final text".to_string()));
        assert_eq!(transcript[2], TranscriptLine::assistant("final text"));
        // With no streaming line it appends a fresh assistant line.
        assert!(!finish_stream(&mut transcript, "another".to_string()));
        assert_eq!(transcript.last(), Some(&TranscriptLine::assistant("another")));
    }

    #[test]
    fn streaming_renders_distinct() {
        let lines = styled_lines(&[TranscriptLine::streaming("growing")], crate::theme::Theme::dark());
        let text: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(text, "growing");
    }

    #[test]
    fn queues_approvals_with_dedup() {
        let mut queue = Vec::new();
        // New items are queued in order with their rule + args preview.
        let items = vec![
            serde_json::json!({ "id": "a1", "tool_name": "Bash", "approval_rule": "Always allow", "arguments": { "command": "ls" } }),
            serde_json::json!({ "id": "a2", "tool_name": "Read", "approval_rule": "Ask", "arguments": { "path": "/x" } }),
        ];
        assert_eq!(queue_new_approvals(&mut queue, &items), 2);
        assert_eq!(
            queue,
            vec![
                PendingApproval {
                    id: "a1".into(),
                    tool: "Bash".into(),
                    rule: "Always allow".into(),
                    args: r#"{"command":"ls"}"#.into(),
                },
                PendingApproval {
                    id: "a2".into(),
                    tool: "Read".into(),
                    rule: "Ask".into(),
                    args: r#"{"path":"/x"}"#.into(),
                },
            ]
        );
        // Re-fetching the same ids adds nothing.
        assert_eq!(queue_new_approvals(&mut queue, &items), 0);
        // A fresh id appended; items without an id are skipped.
        let more = vec![
            serde_json::json!({ "id": "a3", "tool_name": "Edit", "arguments": { "path": "/y" } }),
            serde_json::json!({ "tool_name": "no-id" }),
        ];
        assert_eq!(queue_new_approvals(&mut queue, &more), 1);
        assert_eq!(queue[2].id, "a3");
        assert_eq!(queue[2].rule, "?");
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
            TranscriptLine::user("hi"),
            TranscriptLine::assistant("hello"),
            TranscriptLine::tool("Read started"),
            TranscriptLine::status("plan mode on"),
            TranscriptLine::error("boom"),
        ];
        let lines = styled_lines(&transcript, crate::theme::Theme::dark());
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
    fn smoke_renders_two_panes() {
        use ratatui::backend::TestBackend;

        let transcript = vec![
            TranscriptLine::user("hi"),
            TranscriptLine::assistant("hello there"),
            TranscriptLine::tool("Read started"),
        ];
        let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
        terminal
            .draw(|frame| {
                render_frame(frame, &transcript, "/help", "sess-1", "plan=off swarm=off", 0, crate::theme::Theme::dark());
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
    }

    #[test]
    fn max_scroll_matches_viewport() {
        // A 12-row terminal: chat pane is 9 rows, minus borders = 7 visible.
        assert_eq!(max_scroll(10, 9), 3);
        assert_eq!(max_scroll(7, 9), 0);
        // Empty transcript never underflows.
        assert_eq!(max_scroll(0, 9), 0);
    }
}
