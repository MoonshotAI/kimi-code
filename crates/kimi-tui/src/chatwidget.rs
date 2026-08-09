//! Chat widget — renders the transcript + input panes (G-4 chatwidget
//! component tree, step 1). Extracted from `app.rs` so the app shell stays
//! thin and the widget can grow independently (tool cards, approval dialogs,
//! media blocks) against a TestBackend contract.

use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{TranscriptEntry, TranscriptKind};
use crate::i18n::t;
use crate::t;
use crate::theme::Theme;

/// Draw the three-pane chat layout: a scrollable transcript on top, the
/// input line (with the session id) below, and the footer status bar at the
/// bottom, with the cursor at the editing position. When a slash-command
/// completion popup is active it is drawn over the bottom of the chat pane.
pub fn render_frame(
    frame: &mut ratatui::Frame<'_>,
    transcript: &[TranscriptEntry],
    input: &str,
    cursor: usize,
    session_id: &str,
    scroll: u16,
    theme: Theme,
    footer: &crate::footer::FooterInfo,
    completion: Option<&crate::app::CompletionState>,
) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(3),
            Constraint::Length(2),
        ])
        .split(frame.area());
    let chat = Paragraph::new(styled_lines(transcript, theme))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(t("tui.chat.title")),
        )
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
                let prefix = if selected { "❯" } else { " " };
                RenderLine::from(vec![
                    Span::styled(
                        format!("  {prefix} {cmd}"),
                        Style::default().fg(if selected {
                            theme.assistant
                        } else {
                            theme.status
                        }),
                    ),
                    Span::styled(format!("  {desc}"), Style::default().fg(theme.thinking)),
                ])
            })
            .collect();
        let popup = Paragraph::new(popup_lines)
            .block(Block::default().borders(Borders::ALL).title("commands"));
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
            .title(t!("tui.chat.inputTitle", session_id)),
    );
    frame.render_widget(input_widget, chunks[1]);
    // Footer status strip + rotating tip.
    let footer_widget = Paragraph::new(crate::footer::footer_lines(footer, theme, chunks[2].width));
    frame.render_widget(footer_widget, chunks[2]);
    // Place the terminal cursor at the input editing position (inside the
    // border). Multi-line input: row/col come from the cursor's line.
    let (line, col) = crate::bottom_pane::cursor_line_col(input, cursor);
    let input_row = chunks[1].y + 1 + line as u16;
    let input_col = chunks[1].x + 1 + col as u16;
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
pub fn styled_lines(transcript: &[TranscriptEntry], theme: Theme) -> Vec<RenderLine<'static>> {
    let mut out = Vec::new();
    for entry in transcript {
        match entry {
            TranscriptEntry::Task(task) => {
                // Task / subagent card: `⚙ task <id> <description> — <status>`
                // with an elapsed duration once terminated (TS
                // `background-agent-status` parity, simplified).
                let mut header = format!("⚙ task {}", task.task_id);
                if !task.description.is_empty() {
                    header.push_str(&format!(" {}", task.description));
                }
                let status = if task.ended {
                    task.status.as_str()
                } else {
                    "running"
                };
                header.push_str(&format!(" — {status}"));
                if let (Some(started), Some(ended)) = (task.started_at_ms, task.ended_at_ms) {
                    header.push_str(&format!(
                        " [{}]",
                        format_duration(std::time::Duration::from_millis(
                            ended.saturating_sub(started)
                        ))
                    ));
                }
                out.push(RenderLine::from(Span::styled(
                    header,
                    Style::default().fg(theme.tool),
                )));
            }
            TranscriptEntry::ToolCall(tc) => {
                // Tool-call card: `⚙ name(args)` header (or `❓` for
                // AskUserQuestion), then the result when settled
                // (collapsed -> preview + `[+]`).
                let marker = if tc.is_question { "❓" } else { "⚙" };
                let color = if tc.is_question {
                    theme.status
                } else {
                    theme.tool
                };
                let mut header = format!("{marker} {}({})", tc.tool_name, preview(&tc.args, 60));
                if let Some(duration) = tc.duration {
                    header.push_str(&format!(" [{}]", format_duration(duration)));
                }
                out.push(RenderLine::from(Span::styled(
                    header,
                    Style::default().fg(color),
                )));
                if let Some(result) = &tc.result {
                    if tc.collapsed {
                        out.push(RenderLine::from(Span::styled(
                            format!("  -> {} [+]", preview(result, 100)),
                            Style::default().fg(if tc.is_error {
                                theme.error
                            } else {
                                theme.status
                            }),
                        )));
                    } else {
                        for (i, line) in result.lines().enumerate() {
                            out.push(RenderLine::from(Span::styled(
                                format!("  {} {line}", if i == 0 { "->" } else { " " }),
                                Style::default().fg(if tc.is_error {
                                    theme.error
                                } else {
                                    theme.status
                                }),
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
                    format!("✨ {}", line.text),
                    Style::default().fg(theme.user).add_modifier(Modifier::BOLD),
                ))),
                // Reasoning is transient and dimmer than the visible stream;
                // long reasoning folds to a one-line preview so it can't
                // monopolize the viewport.
                TranscriptKind::Thinking => {
                    let folded = fold_thinking(&line.text);
                    out.push(RenderLine::from(Span::styled(
                        folded,
                        Style::default()
                            .fg(theme.thinking)
                            .add_modifier(Modifier::ITALIC),
                    )));
                }
                TranscriptKind::Tool => {
                    let is_question = line.text.contains("AskUserQuestion");
                    out.push(RenderLine::from(Span::styled(
                        format!("  {} {}", if is_question { "❓" } else { "⚙" }, line.text),
                        Style::default().fg(if is_question {
                            theme.status
                        } else {
                            theme.tool
                        }),
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

/// `123ms` under a second, `1.2s` above (tool-call duration label).
fn format_duration(d: std::time::Duration) -> String {
    let ms = d.as_millis();
    if ms >= 1000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{ms}ms")
    }
}

/// Reasoning longer than this many chars folds to a single-line preview.
const THINKING_FOLD_THRESHOLD: usize = 200;

/// Fold long thinking into `… (+N chars)`; short thinking passes through.
fn fold_thinking(text: &str) -> String {
    let chars = text.chars().count();
    if chars <= THINKING_FOLD_THRESHOLD {
        text.to_string()
    } else {
        format!("{}… (+{} chars)", preview(text, 80), chars - 80)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Theme;

    #[test]
    fn collapsed_tool_lines_show_expand_marker() {
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "Bash".into(),
            args: "{}".into(),
            result: Some("very long result output".repeat(20)),
            is_error: false,
            is_question: false,
            collapsed: true,
            duration: None,
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
            is_question: false,
            collapsed: false,
            duration: None,
        })];
        let lines = styled_lines(&transcript, Theme::dark());
        // Header + one row per result line.
        assert_eq!(lines.len(), 4, "header + 3 result rows: {lines:?}");
        assert!(lines[1].to_string().contains("line1"));
        assert!(lines[3].to_string().contains("line3"));
    }

    #[test]
    fn long_thinking_folds_to_preview() {
        // Short thinking passes through verbatim.
        assert_eq!(fold_thinking("hmm"), "hmm");
        // Long thinking folds to a preview with a char count.
        let long = "x".repeat(500);
        let folded = fold_thinking(&long);
        assert!(folded.ends_with("+420 chars)"), "folded: {folded}");
        assert!(folded.starts_with("xxx"), "folded: {folded}");
        assert!(!folded.contains('\n'), "single line");
    }

    #[test]
    fn durations_format_readably() {
        assert_eq!(
            format_duration(std::time::Duration::from_millis(250)),
            "250ms"
        );
        assert_eq!(
            format_duration(std::time::Duration::from_millis(1200)),
            "1.2s"
        );
    }

    #[test]
    fn tool_card_header_shows_duration() {
        let transcript = vec![TranscriptEntry::ToolCall(crate::app::ToolCallEntry {
            tool_call_id: "t1".into(),
            tool_name: "Bash".into(),
            args: "{}".into(),
            result: None,
            is_error: false,
            is_question: false,
            duration: Some(std::time::Duration::from_millis(1200)),
            collapsed: false,
        })];
        let lines = styled_lines(&transcript, Theme::dark());
        let all: String = lines.iter().map(|l| l.to_string()).collect();
        assert!(all.contains("[1.2s]"), "header: {all}");
    }
}
