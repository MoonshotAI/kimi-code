//! Chat widget — renders the transcript + input panes (G-4 chatwidget
//! component tree, step 1). Extracted from `app.rs` so the app shell stays
//! thin and the widget can grow independently (tool cards, approval dialogs,
//! media blocks) against a TestBackend contract.

use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{TranscriptKind, TranscriptLine};
use crate::theme::Theme;

/// Draw the two-pane chat layout: a scrollable transcript on top and the
/// input line (with session id + status footer) below, with the cursor at
/// the editing position.
pub fn render_frame(
    frame: &mut ratatui::Frame<'_>,
    transcript: &[TranscriptLine],
    input: &str,
    cursor: usize,
    session_id: &str,
    status: &str,
    scroll: u16,
    theme: Theme,
) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(3)])
        .split(frame.area());
    let chat = Paragraph::new(styled_lines(transcript, theme))
        .block(Block::default().borders(Borders::ALL).title("chat"))
        .scroll((scroll, 0));
    let input_widget = Paragraph::new(input).block(
        Block::default()
            .borders(Borders::ALL)
            .title(format!("input — {session_id} | {status}")),
    );
    frame.render_widget(chat, chunks[0]);
    frame.render_widget(input_widget, chunks[1]);
    // Place the terminal cursor at the input editing position (inside the
    // border). A cursor beyond the pane width is safe — it just stays hidden
    // until horizontal scrolling lands (later batch).
    let input_row = chunks[1].y + 1;
    let input_col = chunks[1].x + 1 + cursor as u16;
    frame.set_cursor_position((input_col, input_row));
}

/// Largest scroll offset that still keeps the last transcript line visible
/// in a `pane_height`-tall chat pane (minus its borders).
pub fn max_scroll(total: usize, pane_height: u16) -> usize {
    total.saturating_sub(pane_height.saturating_sub(2) as usize)
}

/// Map transcript entries to styled render lines (role → prefix + style).
/// Assistant (and live-streaming) text is markdown-rendered; everything else
/// stays plain. Colors come from the resolved theme palette.
pub fn styled_lines(
    transcript: &[TranscriptLine],
    theme: Theme,
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
            TranscriptKind::Tool => {
                // AskUserQuestion lines are surfaced as a question prompt
                // (❓) rather than a plain tool progress line, so the user
                // sees at a glance that the model is waiting for an answer.
                let is_question = entry.text.contains("AskUserQuestion");
                out.push(RenderLine::from(Span::styled(
                    format!("  {} {}", if is_question { "❓" } else { "⚙" }, entry.text),
                    Style::default().fg(if is_question { theme.status } else { theme.tool }),
                )));
            }
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
