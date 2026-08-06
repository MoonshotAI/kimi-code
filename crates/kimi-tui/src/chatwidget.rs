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
/// the editing position. When a slash-command completion popup is active it
/// is drawn over the bottom of the chat pane.
pub fn render_frame(
    frame: &mut ratatui::Frame<'_>,
    transcript: &[TranscriptLine],
    input: &str,
    cursor: usize,
    session_id: &str,
    status: &str,
    scroll: u16,
    theme: Theme,
    completion: Option<&crate::app::CompletionState>,
) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(3)])
        .split(frame.area());
    let mut chat = Paragraph::new(styled_lines(transcript, theme))
        .block(Block::default().borders(Borders::ALL).title("chat"))
        .scroll((scroll, 0));
    // The completion popup overlays the bottom of the chat pane.
    if let Some(state) = completion {
        let popup_lines: Vec<RenderLine<'static>> = state
            .matches
            .iter()
            .enumerate()
            .map(|(i, (cmd, desc))| {
                let selected = i == state.selected;
                // Command + dimmed description in a second column.
                let prefix = if selected { "▶" } else { " " };
                RenderLine::from(vec![
                    Span::styled(
                        format!("  {prefix} {cmd}"),
                        Style::default().fg(if selected { theme.assistant } else { theme.status }),
                    ),
                    Span::styled(
                        format!("  {desc}"),
                        Style::default().fg(theme.thinking),
                    ),
                ])
            })
            .collect();
        let popup = Paragraph::new(popup_lines).block(
            Block::default().borders(Borders::ALL).title("commands"),
        );
        let popup_height = (state.matches.len() as u16 + 2).min(chunks[0].height);
        let area = ratatui::layout::Rect {
            x: chunks[0].x,
            y: chunks[0].y + chunks[0].height - popup_height,
            width: chunks[0].width,
            height: popup_height,
        };
        frame.render_widget(chat, chunks[0]);
        // Overlay the popup on the bottom of the chat pane.
        frame.render_widget(popup, area);
    } else {
        frame.render_widget(chat, chunks[0]);
    }
    let input_widget = Paragraph::new(input).block(
        Block::default()
            .borders(Borders::ALL)
            .title(format!("input — {session_id} | {status}")),
    );
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
) -> Vec<RenderLine<'static>> {    let mut out = Vec::new();
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
                let prefix = if is_question { "❓" } else { "⚙" };
                if entry.collapsed {
                    // Collapsed long result: single-line preview + expand
                    // marker (Ctrl-O toggles).
                    let preview: String = entry.text.chars().take(120).collect();
                    out.push(RenderLine::from(Span::styled(
                        format!("  {prefix} {preview} [+]"),
                        Style::default().fg(if is_question { theme.status } else { theme.tool }),
                    )));
                } else {
                    // Expanded (or short): every line prefixed, the first
                    // with the tool marker.
                    for (i, line) in entry.text.lines().enumerate() {
                        out.push(RenderLine::from(Span::styled(
                            format!("  {} {line}", if i == 0 { prefix } else { " " }),
                            Style::default().fg(if is_question { theme.status } else { theme.tool }),
                        )));
                    }
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::TranscriptLine;
    use crate::theme::Theme;

    #[test]
    fn collapsed_tool_lines_show_expand_marker() {
        let transcript = vec![
            TranscriptLine::tool_collapsed("tool Bash -> ok: very long result output"),
        ];
        let lines = styled_lines(&transcript, Theme::dark());
        assert_eq!(lines.len(), 1, "collapsed renders one line");
        let text = lines[0].to_string();
        assert!(text.contains("[+]"), "expand marker: {text}");
        assert!(text.contains("…") || text.chars().count() <= 140, "preview bounded: {text}");
    }

    #[test]
    fn expanded_tool_lines_render_multiple_rows() {
        let transcript = vec![TranscriptLine::tool("line1\nline2\nline3")];
        let lines = styled_lines(&transcript, Theme::dark());
        assert_eq!(lines.len(), 3, "one row per text line");
        assert!(lines[0].to_string().contains("line1"));
        assert!(lines[2].to_string().contains("line3"));
    }
}
