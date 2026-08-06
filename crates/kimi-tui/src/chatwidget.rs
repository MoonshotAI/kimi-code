//! Chat widget — renders the transcript + input panes (G-4 chatwidget
//! component tree, step 1). Extracted from `app.rs` so the app shell stays
//! thin and the widget can grow independently (tool cards, approval dialogs,
//! media blocks) against a TestBackend contract.

use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{TranscriptEntry, TranscriptKind, TranscriptLine, ToolCallEntry};
use crate::theme::Theme;

/// Draw the two-pane chat layout: a scrollable transcript on top and the
/// input line (with session id + status footer) below, with the cursor at
/// the editing position. When a slash-command completion popup is active it
/// is drawn over the bottom of the chat pane.
pub fn render_frame(
    frame: &mut ratatui::Frame<'_>,
    transcript: &[TranscriptEntry],
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
    transcript: &[TranscriptEntry],
    theme: Theme,
) -> Vec<RenderLine<'static>> {    let mut out = Vec::new();
    for entry in transcript {
        match entry {
            TranscriptEntry::ToolCall(tc) => {
                // Tool-call card: `⚙ name(args)` header, then the result when
                // settled (collapsed -> preview + `[+]`).
                let header = format!("⚙ {}({})", tc.tool_name, preview(&tc.args, 60));
                out.push(RenderLine::from(Span::styled(
                    header,
                    Style::default().fg(theme.tool),
                )));
                if let Some(result) = &tc.result {
                    if tc.collapsed {
                        out.push(RenderLine::from(Span::styled(
                            format!("  -> {} [+]", preview(result, 100)),
                            Style::default().fg(if tc.is_error { theme.error } else { theme.status }),
                        )));
                    } else {
                        for (i, line) in result.lines().enumerate() {
                            out.push(RenderLine::from(Span::styled(
                                format!("  {} {line}", if i == 0 { "->" } else { " " }),
                                Style::default().fg(if tc.is_error { theme.error } else { theme.status }),
                            )));
                        }
                    }
                }
            }
            TranscriptEntry::Line(line) => match line.kind {
                TranscriptKind::Assistant | TranscriptKind::Streaming => {
                    out.extend(crate::markdown::render_markdown_themed(&line.text, theme));
                }
                TranscriptKind::User => out.push(RenderLine::from(Span::styled(
                    format!("▶ {}", line.text),
                    Style::default().fg(theme.user).add_modifier(Modifier::BOLD),
                ))),
                // Reasoning is transient and dimmer than the visible stream.
                TranscriptKind::Thinking => out.push(RenderLine::from(Span::styled(
                    line.text.clone(),
                    Style::default().fg(theme.thinking).add_modifier(Modifier::ITALIC),
                ))),
                TranscriptKind::Tool => {
                    let is_question = line.text.contains("AskUserQuestion");
                    out.push(RenderLine::from(Span::styled(
                        format!("  {} {}", if is_question { "❓" } else { "⚙" }, line.text),
                        Style::default().fg(if is_question { theme.status } else { theme.tool }),
                    )));
                }
                TranscriptKind::Status => out.push(RenderLine::from(Span::styled(
                    line.text.clone(),
                    Style::default().fg(theme.status),
                ))),
                TranscriptKind::Error => out.push(RenderLine::from(Span::styled(
                    line.text.clone(),
                    Style::default().fg(theme.error),
                ))),
            },
        }
    }
    out
}

/// Bounded single-line preview (`…` when truncated).
fn preview(text: &str, max: usize) -> String {
    let text = text.replace('\n', " ");
    if text.chars().count() <= max {
        text
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::TranscriptLine;
    use crate::theme::Theme;

    #[test]
    fn collapsed_tool_lines_show_expand_marker() {
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "Bash".into(),
            args: "{}".into(),
            result: Some("very long result output".repeat(20)),
            is_error: false,
            collapsed: true,
        })];
        let lines = styled_lines(&transcript, Theme::dark());
        // Header + collapsed result preview with the expand marker.
        let all: String = lines.iter().map(|l| l.to_string()).collect();
        assert!(all.contains("[+]"), "expand marker: {all}");
        assert!(all.contains("⚙ Bash"), "tool header: {all}");
    }

    #[test]
    fn expanded_tool_result_renders_multiple_rows() {
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "Bash".into(),
            args: "{}".into(),
            result: Some("line1\nline2\nline3".into()),
            is_error: false,
            collapsed: false,
        })];
        let lines = styled_lines(&transcript, Theme::dark());
        // Header + one row per result line.
        assert_eq!(lines.len(), 4, "header + 3 result rows: {lines:?}");
        assert!(lines[1].to_string().contains("line1"));
        assert!(lines[3].to_string().contains("line3"));
    }
}
