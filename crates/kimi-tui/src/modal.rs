//! Modal chrome — full-screen overlay rendering shared by the approval
//! detail view, selectors, and future dialogs. This is the rendering side
//! of the TS `modal-coordinator`; the mutual-exclusion / queueing state
//! stays in `app.rs`'s single `Overlay` slot until a second modal type
//! (question dialog, task viewer) needs real coordination.

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::theme::Theme;

/// One modal row: text plus an explicit color. `None` falls back to the
/// theme's status color.
pub struct ModalRow {
    pub text: String,
    pub color: Option<Color>,
}

impl ModalRow {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            color: None,
        }
    }
    pub fn colored(text: impl Into<String>, color: Color) -> Self {
        Self {
            text: text.into(),
            color: Some(color),
        }
    }
}

/// Draw a full-screen modal titled `title` over the whole frame, one row
/// per entry. Rows are laid out top-down from the border; the caller is
/// responsible for truncating content to the terminal height.
pub fn render_modal(
    frame: &mut ratatui::Frame<'_>,
    title: &str,
    rows: &[ModalRow],
    theme: Theme,
) {
    let lines: Vec<Line<'_>> = rows
        .iter()
        .map(|row| {
            Line::from(Span::styled(
                row.text.clone(),
                Style::default().fg(row.color.unwrap_or(theme.status)),
            ))
        })
        .collect();
    let block = Block::default()
        .borders(Borders::ALL)
        .title(title.to_string());
    frame.render_widget(Paragraph::new(lines).block(block), frame.area());
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn modal_renders_titled_rows_with_colors() {
        let mut terminal = Terminal::new(TestBackend::new(40, 6)).unwrap();
        terminal
            .draw(|frame| {
                render_modal(
                    frame,
                    "approval",
                    &[
                        ModalRow::colored("header", Color::White),
                        ModalRow::new("body line"),
                        ModalRow::colored("danger", Color::Red),
                    ],
                    Theme::dark(),
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text: Vec<String> = (0..6)
            .map(|y| {
                (0..40)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect()
            })
            .collect();
        assert!(text[0].contains("approval"), "title: {}", text[0]);
        assert!(text.iter().any(|l| l.contains("body line")));
        // The red row is colored with the error color.
        let red_row = text
            .iter()
            .position(|l| l.contains("danger"))
            .expect("danger row");
        let cell = &buffer[(1, red_row as u16)];
        assert_eq!(cell.style().fg, Some(Color::Red));
    }
}
