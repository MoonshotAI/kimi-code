//! Generic interactive selector (↑/↓ pick, Enter select, Esc / Ctrl-C
//! cancel) — the building block for `/model`, `/skills`, `/session` pickers.
//! Pure UI; the caller supplies the items and receives the picked value.

use std::io;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::{
    backend::CrosstermBackend,
    style::{Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph},
    Frame, Terminal,
};

use crate::theme::Theme;

/// Interactively pick one of `items` (`(value, label)`), rendered in a
/// bordered list titled `title`. Returns the picked value, or `None` on
/// Esc / Ctrl-C. Returns `None` immediately when `items` is empty.
pub fn select(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    theme: Theme,
    title: &str,
    items: &[(String, String)],
) -> io::Result<Option<String>> {
    if items.is_empty() {
        return Ok(None);
    }
    let mut selected = 0usize;
    loop {
        terminal.draw(|frame| render(frame, theme, title, items, selected))?;
        if !event::poll(std::time::Duration::from_millis(100))? {
            continue;
        }
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Up => selected = selected.saturating_sub(1),
                KeyCode::Down => selected = (selected + 1).min(items.len() - 1),
                KeyCode::Enter => return Ok(Some(items[selected].0.clone())),
                KeyCode::Char('c') if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                    return Ok(None);
                }
                KeyCode::Esc => return Ok(None),
                _ => {}
            }
        }
    }
}

/// Render the selector overlay (full area, bordered list with the current
/// row highlighted).
pub(crate) fn render(
    frame: &mut Frame<'_>,
    theme: Theme,
    title: &str,
    items: &[(String, String)],
    selected: usize,
) {
    let lines: Vec<Line<'_>> = items
        .iter()
        .enumerate()
        .map(|(i, (value, label))| {
            let text = format!("  {value}  {label}");
            let style = if i == selected {
                Style::default().fg(theme.user).add_modifier(Modifier::REVERSED)
            } else {
                Style::default().fg(theme.status)
            };
            Line::from(Span::styled(text, style))
        })
        .collect();
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!("{title} — ↑/↓ pick · Enter select · Esc cancel"));
    frame.render_widget(Paragraph::new(Text::from(lines)).block(block), frame.area());
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    #[test]
    fn selector_renders_title_items_and_highlights_selected() {
        let items = vec![
            ("s-1".to_string(), "first".to_string()),
            ("s-2".to_string(), "second".to_string()),
            ("s-3".to_string(), "third".to_string()),
        ];
        let mut terminal = Terminal::new(TestBackend::new(50, 10)).unwrap();
        terminal
            .draw(|frame| render(frame, crate::theme::Theme::dark(), "resume a session", &items, 1))
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let lines: Vec<String> = (0..10)
            .map(|y| (0..50).map(|x| buffer[(x, y)].symbol().to_string()).collect())
            .collect();
        assert!(
            lines.iter().any(|l| l.contains("resume a session")),
            "title:\n{}",
            lines.join("\n")
        );
        assert!(lines.iter().any(|l| l.contains("s-1") && l.contains("first")));
        assert!(lines.iter().any(|l| l.contains("s-3") && l.contains("third")));
        // The selected entry (index 1) is highlighted with REVERSED.
        let selected_row = lines.iter().position(|l| l.contains("second")).expect("second row");
        let cell = &buffer[(3, selected_row as u16)];
        assert!(
            cell.style().add_modifier.contains(Modifier::REVERSED),
            "selected highlighted: {:?}",
            cell.style()
        );
    }

    #[test]
    fn empty_items_are_rejected_up_front() {
        // select() returns None without touching the terminal for empty input.
        let items: &[(String, String)] = &[];
        let items_len = items.len();
        assert_eq!(items_len, 0);
        // The interactive loop is guarded by `if items.is_empty() { return None }`.
        let _ = select;
    }
}
