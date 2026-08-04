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
        }
    }

    /// Run the event loop until the user quits (`/quit` or Ctrl-C).
    pub async fn run(&mut self) -> anyhow::Result<()> {
        // Open the session up front.
        let mut session = self.harness.create_session(&self.session_id).await?;
        self.session = Some(session.clone());
        self.transcript.push(format!("session {} ready — type /help", self.session_id));

        let mut terminal = init_terminal()?;
        let result = self.event_loop(&mut terminal, &mut session).await;
        restore_terminal(&mut terminal)?;
        result
    }

    async fn event_loop(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        session: &mut kimi_sdk::Session,
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
                        if self.dispatch(&line, session).await? {
                            return Ok(());
                        }
                        self.history.push(line);
                        self.history_idx = None;
                    }
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
    async fn dispatch(&mut self, line: &str, session: &mut kimi_sdk::Session) -> anyhow::Result<bool> {
        if line.starts_with('/') {
            let (cmd, rest) = line.split_once(' ').map(|(c, r)| (c, r.trim())).unwrap_or((line, ""));
            match cmd {
                "/quit" | "/exit" => return Ok(true),
                "/help" => {
                    self.transcript.push("/quit /help /model <id> /plan on|off /status".into());
                }
                "/status" => {
                    let status = session.get_status().await;
                    self.transcript.push(format!("status: {}", serde_json::to_string_pretty(&status["result"]).unwrap_or_default()));
                }
                "/plan" => {
                    let enabled = rest == "on" || rest.is_empty();
                    session.set_plan_mode(enabled).await?;
                    self.transcript.push(format!("plan mode {}", if enabled { "on" } else { "off" }));
                }
                "/model" => {
                    if rest.is_empty() {
                        self.transcript.push("usage: /model <model-id>".into());
                    } else {
                        session.set_model(rest).await?;
                        self.transcript.push(format!("model set to {rest}"));
                    }
                }
                other => self.transcript.push(format!("unknown command {other} — try /help")),
            }
            return Ok(false);
        }
        // A real prompt: run it and render the transcript.
        self.transcript.push(format!("> {line}"));
        let result = session.prompt(line).await;
        if let Some(error) = result.get("error") {
            self.transcript.push(format!("error: {}", error["message"].as_str().unwrap_or("unknown")));
            return Ok(false);
        }
        match session.transcript().await? {
            Some(text) => self.transcript.push(text),
            None => self.transcript.push(result.to_string()),
        }
        Ok(false)
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

    fn draw(&self, frame: &mut ratatui::Frame<'_>) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(3), Constraint::Length(3)])
            .split(frame.area());
        let transcript = self.transcript.join("\n");
        let chat = Paragraph::new(transcript)
            .block(Block::default().borders(Borders::ALL).title("chat"))
            .scroll((self.transcript.len().saturating_sub(1) as u16, 0));
        let input = Paragraph::new(self.input.as_str())
            .block(Block::default().borders(Borders::ALL).title("input"));
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
