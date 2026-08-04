//! The TUI application: terminal setup, event loop, and rendering.

use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Terminal;

use kimi_sdk::Harness;

/// All slash commands the chat surface understands (shared with `/help`).
const SLASH_COMMANDS: &[&str] = &[
    "/clear",
    "/compact",
    "/exit",
    "/export",
    "/goal",
    "/goal-cancel",
    "/goal-pause",
    "/goal-resume",
    "/goal-status",
    "/help",
    "/model",
    "/models",
    "/plan",
    "/quit",
    "/resume",
    "/sessions",
    "/status",
    "/swarm",
    "/thinking",
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

/// State for an in-progress Tab completion cycle.
#[derive(Debug, Clone, PartialEq)]
struct TabState {
    /// The input as it was when the cycle started (matches cycle on this).
    base: String,
    /// Index into the current match list.
    idx: usize,
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
    /// Transcript scroll offset (lines from the bottom).
    scroll: u16,
    /// Session status summary for the footer (plan/swarm).
    status: String,
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
            scroll: 0,
            status: String::new(),
        }
    }

    /// Run the event loop until the user quits (`/quit` or Ctrl-C).
    pub async fn run(&mut self) -> anyhow::Result<()> {
        // Open the session up front.
        let mut session = self.harness.create_session(&self.session_id).await?;
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
                "/status" => {
                    let status = self.session.as_mut().expect("session").get_status().await;
                    self.transcript.push(TranscriptLine::status(format!(
                        "status: {}",
                        serde_json::to_string_pretty(&status["result"]).unwrap_or_default()
                    )));
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
                    self.session.as_mut().expect("session").set_swarm_mode(enabled).await?;
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
                        let new_session = self.harness.create_session(rest).await?;
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
                match self.session.as_mut().expect("session").transcript().await? {
                    Some(text) => self.transcript.push(TranscriptLine::assistant(text)),
                    None => self.transcript.push(TranscriptLine::assistant(result.to_string())),
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
        let mut guard = self.harness.events().await;
        if let Some(source) = guard.as_mut() {
            if let Ok(Some(event)) =
                tokio::time::timeout(std::time::Duration::from_millis(50), source.next()).await
            {
                let line = kimi_ui::render_event(&event).unwrap_or_else(|| event.to_string());
                // Tool progress reads differently from transcript/status.
                let is_tool = event
                    .get("type")
                    .and_then(|t| t.as_str())
                    .is_some_and(|t| t.starts_with("session.tool."));
                self.transcript.push(if is_tool {
                    TranscriptLine::tool(line)
                } else {
                    TranscriptLine::status(line)
                });
            }
        }
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
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(3), Constraint::Length(3)])
            .split(frame.area());
        let viewport = chunks[0].height.saturating_sub(2) as usize;
        let total = self.transcript.len();
        let max_scroll = total.saturating_sub(viewport);
        if self.scroll as usize > max_scroll {
            self.scroll = max_scroll as u16;
        }
        let chat = Paragraph::new(styled_lines(&self.transcript))
            .block(Block::default().borders(Borders::ALL).title("chat"))
            .scroll((self.scroll, 0));
        let input = Paragraph::new(self.input.as_str())
            .block(Block::default().borders(Borders::ALL).title(format!("input — {} | {}", self.session_id, self.status)));
        frame.render_widget(chat, chunks[0]);
        frame.render_widget(input, chunks[1]);
    }
}

/// Map transcript entries to styled render lines (role → prefix + style).
fn styled_lines(transcript: &[TranscriptLine]) -> Vec<RenderLine<'static>> {
    transcript
        .iter()
        .map(|entry| {
            let (text, style) = match entry.kind {
                TranscriptKind::User => (
                    format!("▶ {}", entry.text),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                TranscriptKind::Assistant => (entry.text.clone(), Style::default()),
                TranscriptKind::Tool => (format!("  ⚙ {}", entry.text), Style::default().fg(Color::Blue)),
                TranscriptKind::Status => (entry.text.clone(), Style::default().fg(Color::DarkGray)),
                TranscriptKind::Error => (entry.text.clone(), Style::default().fg(Color::Red)),
            };
            RenderLine::from(Span::styled(text, style))
        })
        .collect()
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

    #[test]
    fn completes_command_names_and_cycles() {
        assert_eq!(complete_line("/", &[], None), ("/clear".to_string(), Some(0)));
        assert_eq!(complete_line("/", &[], Some(0)), ("/compact".to_string(), Some(1)));
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
    fn transcript_lines_render_by_kind() {
        let transcript = vec![
            TranscriptLine::user("hi"),
            TranscriptLine::assistant("hello"),
            TranscriptLine::tool("Read started"),
            TranscriptLine::status("plan mode on"),
            TranscriptLine::error("boom"),
        ];
        let lines = styled_lines(&transcript);
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
}
