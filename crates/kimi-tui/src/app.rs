//! The TUI application: terminal setup, event loop, and rendering.

use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Terminal;

use kimi_sdk::Harness;

/// The interactive chat application.
pub struct App {
    harness: Harness,
    /// Transcript lines rendered in the chat panel.
    transcript: Vec<String>,
    /// The user's current input line.
    input: String,
    /// Prompt history (up/down).
    history: Vec<String>,
    history_idx: Option<usize>,
    session_id: String,
    session: Option<kimi_sdk::Session>,
    /// Model aliases for `/model` Tab completion.
    model_aliases: Vec<String>,
    tab_idx: Option<usize>,
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
            tab_idx: None,
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
        self.transcript.push(format!("session {} ready — type /help", self.session_id));
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
                    KeyCode::Char(ch) => self.input.push(ch),
                    KeyCode::Backspace => {
                        self.input.pop();
                    }
                    KeyCode::Enter => {
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
                    KeyCode::Tab => self.complete_model(),
                    KeyCode::PageUp => self.scroll = self.scroll.saturating_add(5),
                    KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(5),
                    KeyCode::Up => self.history_back(),
                    KeyCode::Down => self.history_forward(),
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
                    self.transcript.push("/quit /help /model <id> /plan on|off /status /goal <obj> /goal-status /goal-cancel /clear /usage /sessions /export".into());
                }
                "/status" => {
                    let status = self.session.as_mut().expect("session").get_status().await;
                    self.transcript.push(format!("status: {}", serde_json::to_string_pretty(&status["result"]).unwrap_or_default()));
                }
                "/plan" => {
                    let enabled = rest == "on" || rest.is_empty();
                    self.session.as_mut().expect("session").set_plan_mode(enabled).await?;
                    self.transcript.push(format!("plan mode {}", if enabled { "on" } else { "off" }));
                    self.refresh_status().await;
                }
                "/swarm" => {
                    let enabled = rest == "on" || rest.is_empty();
                    self.session.as_mut().expect("session").set_swarm_mode(enabled).await?;
                    self.transcript.push(format!("swarm mode {}", if enabled { "on" } else { "off" }));
                    self.refresh_status().await;
                }
                "/thinking" => {
                    if rest.is_empty() {
                        self.transcript.push("usage: /thinking <low|medium|high>".into());
                    } else {
                        self.session.as_mut().expect("session").set_thinking(Some(rest)).await?;
                        self.transcript.push(format!("thinking effort set to {rest}"));
                    }
                }
                "/models" => {
                    let (aliases, default_model) = self.harness.list_models().await?;
                    if aliases.is_empty() {
                        self.transcript.push("no model aliases configured".into());
                    }
                    for alias in aliases.iter().take(20) {
                        self.transcript.push(alias.clone());
                    }
                    if let Some(default_model) = default_model {
                        self.transcript.push(format!("default: {default_model}"));
                    }
                }
                "/model" => {
                    if rest.is_empty() {
                        self.transcript.push("usage: /model <model-id>".into());
                    } else {
                        self.session.as_mut().expect("session").set_model(rest).await?;
                        self.transcript.push(format!("model set to {rest}"));
                    }
                }
                "/resume" => {
                    if rest.is_empty() {
                        self.transcript.push("usage: /resume <session-id>".into());
                    } else {
                        let new_session = self.harness.create_session(rest).await?;
                        self.session = Some(new_session);
                        self.session_id = rest.to_string();
                        self.transcript.push(format!("switched to session {rest}"));
                    }
                }
                "/goal" => {
                    if rest.is_empty() {
                        self.transcript.push("usage: /goal <objective>".into());
                    } else {
                        let snapshot = self.session.as_mut().expect("session").create_goal(rest).await?;
                        self.transcript.push(format!("goal created: {}", snapshot["objective"]));
                    }
                }
                "/goal-cancel" => {
                    self.session.as_mut().expect("session").cancel_goal().await?;
                    self.transcript.push("goal cancelled".into());
                }
                "/goal-pause" => {
                    self.session.as_mut().expect("session").pause_goal(Some(rest)).await?;
                    self.transcript.push("goal paused".into());
                }
                "/goal-resume" => {
                    self.session.as_mut().expect("session").resume_goal(Some(rest)).await?;
                    self.transcript.push("goal resumed".into());
                }
                "/clear" => {
                    self.session.as_mut().expect("session").clear_context().await?;
                    self.transcript.push("context cleared".into());
                }
                "/compact" => {
                    match self.session.as_mut().expect("session").compact().await {
                        Ok(_) => self.transcript.push("context compacted".into()),
                        Err(e) => self.transcript.push(format!("compact failed: {e}")),
                    }
                }
                "/usage" => {
                    let usage = self.session.as_mut().expect("session").get_usage().await?;
                    self.transcript.push(format!("usage: {}", serde_json::to_string(&usage).unwrap_or_default()));
                }
                "/goal-status" => {
                    let goal = self.session.as_mut().expect("session").goal().await?;
                    self.transcript.push(format!("goal: {}", serde_json::to_string(&goal["goal"]).unwrap_or_default()));
                }
                "/sessions" => {
                    let sessions = self.harness.list_sessions(50).await?;
                    if sessions.is_empty() {
                        self.transcript.push("no sessions".into());
                    }
                    for s in sessions.iter().take(20) {
                        let id = s["id"].as_str().unwrap_or("");
                        let title = s["title"].as_str().unwrap_or("(untitled)");
                        self.transcript.push(format!("{id}  {title}"));
                    }
                }
                "/export" => {
                    match self.harness.export_session(&self.session_id).await {
                        Ok(zip) => {
                            let path = format!("{}.zip", self.session_id);
                            match std::fs::write(&path, &zip) {
                                Ok(()) => self.transcript.push(format!("exported to {path} ({} bytes)", zip.len())),
                                Err(e) => self.transcript.push(format!("write failed: {e}")),
                            }
                        }
                        Err(e) => self.transcript.push(format!("export failed: {e}")),
                    }
                }
                other => self.transcript.push(format!("unknown command {other} — try /help")),
            }
            return Ok(false);
        }
        // A real prompt: run it and render the transcript, pumping engine
        // events into the panel while the turn runs. The prompt future lives
        // in a block so its `&mut session` borrow ends before we read back.
        self.transcript.push(format!("> {line}"));
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
                self.transcript.push(format!("error: {}", error["message"].as_str().unwrap_or("unknown")));
            } else {
                match self.session.as_mut().expect("session").transcript().await? {
                    Some(text) => self.transcript.push(text),
                    None => self.transcript.push(result.to_string()),
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
                // Mark tool progress lines so they read differently from the
                // transcript and the user's own prompts.
                let is_tool = event.get("type").and_then(|t| t.as_str()).is_some_and(|t| t.starts_with("session.tool."));
                if is_tool {
                    self.transcript.push(format!("  ⚙ {line}"));
                } else {
                    self.transcript.push(line);
                }
            }
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

    /// Tab completion for `/model <prefix>`: cycle the model aliases.
    fn complete_model(&mut self) {
        let Some(prefix) = self.input.strip_prefix("/model ") else {
            self.tab_idx = None;
            return;
        };
        if self.model_aliases.is_empty() {
            return;
        }
        let matches: Vec<&String> = self
            .model_aliases
            .iter()
            .filter(|a| a.starts_with(prefix))
            .collect();
        if matches.is_empty() {
            return;
        }
        let idx = self.tab_idx.map_or(0, |i| (i + 1) % matches.len());
        self.tab_idx = Some(idx);
        self.input = format!("/model {}", matches[idx]);
    }

    fn draw(&mut self, frame: &mut ratatui::Frame<'_>) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(3), Constraint::Length(3)])
            .split(frame.area());
        let transcript = self.transcript.join("\n");
        let viewport = chunks[0].height.saturating_sub(2) as usize;
        let total = self.transcript.len();
        let max_scroll = total.saturating_sub(viewport);
        if self.scroll as usize > max_scroll {
            self.scroll = max_scroll as u16;
        }
        let chat = Paragraph::new(transcript)
            .block(Block::default().borders(Borders::ALL).title("chat"))
            .scroll((self.scroll, 0));
        let input = Paragraph::new(self.input.as_str())
            .block(Block::default().borders(Borders::ALL).title(format!("input — {} | {}", self.session_id, self.status)));
        frame.render_widget(chat, chunks[0]);
        frame.render_widget(input, chunks[1]);
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
