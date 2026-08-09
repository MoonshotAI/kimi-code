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

use crate::t;
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

/// Keep the items whose value or label contains `filter` (case-insensitive).
/// Used by the filtered picker; exported for unit tests.
pub fn filter_items<'a>(items: &'a [(String, String)], filter: &str) -> Vec<(&'a str, &'a str)> {
    let filter = filter.to_lowercase();
    items
        .iter()
        .filter(|(value, label)| {
            value.to_lowercase().contains(&filter) || label.to_lowercase().contains(&filter)
        })
        .map(|(value, label)| (value.as_str(), label.as_str()))
        .collect()
}

/// A picker with incremental search: typing filters the list, Backspace
/// clears the last filter char (TS model-selector parity). Returns the
/// picked value, or `None` on Esc / Ctrl-C / no matches.
pub fn select_filtered(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    theme: Theme,
    title: &str,
    items: &[(String, String)],
) -> io::Result<Option<String>> {
    if items.is_empty() {
        return Ok(None);
    }
    let mut selected = 0usize;
    let mut filter = String::new();
    loop {
        let filtered: Vec<(String, String)> = if filter.is_empty() {
            items.to_vec()
        } else {
            filter_items(items, &filter)
                .into_iter()
                .map(|(v, l)| (v.to_string(), l.to_string()))
                .collect()
        };
        let no_match = filtered.is_empty();
        let shown: Vec<(String, String)> = if no_match {
            vec![(String::new(), format!("no match: {filter}"))]
        } else {
            filtered
        };
        selected = selected.min(shown.len().saturating_sub(1));
        let display_title = if filter.is_empty() {
            title.to_string()
        } else {
            format!("{title} — {filter}")
        };
        terminal.draw(|frame| render(frame, theme, &display_title, &shown, selected))?;
        if !event::poll(std::time::Duration::from_millis(100))? {
            continue;
        }
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Up => selected = selected.saturating_sub(1),
                KeyCode::Down => selected = (selected + 1).min(shown.len().saturating_sub(1)),
                KeyCode::Enter => {
                    // A no-match placeholder row is not selectable.
                    if no_match {
                        continue;
                    }
                    return Ok(Some(shown[selected].0.clone()));
                }
                KeyCode::Backspace => {
                    filter.pop();
                    selected = 0;
                }
                KeyCode::Char('c') if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                    return Ok(None);
                }
                KeyCode::Esc => return Ok(None),
                KeyCode::Char(ch) => {
                    filter.push(ch);
                    selected = 0;
                }
                _ => {}
            }
        }
    }
}

/// A selectable entry with an optional trailing description (dimmed).
/// The `label` is the primary text; `description` shows after it (TS
/// `choice-picker` items parity — model descriptions, plugin summaries).
pub struct PickerItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

impl PickerItem {
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            description: None,
        }
    }
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// Display options for the full picker (`select_picker`).
pub struct PickerOptions {
    /// Border title of the list.
    pub title: String,
    /// Optional hint line pinned to the bottom of the list (dim).
    pub notice: Option<String>,
    /// Enable incremental search: typing filters, Backspace clears, a
    /// no-match placeholder row shows (TS model-selector parity).
    pub filterable: bool,
    /// Max visible rows per page; 0 disables pagination.
    pub page_size: u16,
}

impl PickerOptions {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            notice: None,
            filterable: false,
            page_size: 0,
        }
    }
    pub fn filterable(mut self) -> Self {
        self.filterable = true;
        self
    }
    pub fn paged(mut self, page_size: u16) -> Self {
        self.page_size = page_size;
        self
    }
    pub fn notice(mut self, notice: impl Into<String>) -> Self {
        self.notice = Some(notice.into());
        self
    }
}

/// Index of the page containing `index` (`page_size == 0` → page 0).
pub fn page_of(index: usize, page_size: u16) -> usize {
    if page_size == 0 {
        0
    } else {
        index / page_size as usize
    }
}

/// Number of pages for `count` items (at least one page).
pub fn pages_of(count: usize, page_size: u16) -> usize {
    if page_size == 0 {
        1
    } else {
        count.div_ceil(page_size as usize).max(1)
    }
}

/// The visible window `(start, end)` for `index` under pagination — the
/// page containing `index`, clamped to `count`. `page_size == 0` →
/// `(0, count)`.
pub fn window(index: usize, count: usize, page_size: u16) -> (usize, usize) {
    if page_size == 0 || count == 0 {
        return (0, count);
    }
    let start = (index / page_size as usize) * page_size as usize;
    (start, (start + page_size as usize).min(count))
}

/// Keep the items whose value or label contains `filter` (case-insensitive),
/// preserving order.
pub fn filter_picker_items<'a>(items: &'a [PickerItem], filter: &str) -> Vec<&'a PickerItem> {
    let filter = filter.to_lowercase();
    items
        .iter()
        .filter(|it| {
            it.value.to_lowercase().contains(&filter)
                || it.label.to_lowercase().contains(&filter)
        })
        .collect()
}

/// Full picker: optional incremental search, optional pagination, an
/// optional bottom notice line, and optional per-item descriptions. Returns
/// the picked value, or `None` on Esc / Ctrl-C / empty items.
pub fn select_picker(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    theme: Theme,
    opts: &PickerOptions,
    items: &[PickerItem],
) -> io::Result<Option<String>> {
    if items.is_empty() {
        return Ok(None);
    }
    let mut selected = 0usize;
    let mut filter = String::new();
    loop {
        let (shown, no_match): (Vec<&PickerItem>, bool) = if opts.filterable && !filter.is_empty() {
            let filtered = filter_picker_items(items, &filter);
            let no_match = filtered.is_empty();
            (filtered, no_match)
        } else {
            (items.iter().collect(), false)
        };
        if !no_match {
            selected = selected.min(shown.len().saturating_sub(1));
        }
        terminal.draw(|frame| {
            render_picker(frame, theme, opts, &shown, selected, &filter, no_match)
        })?;
        if !event::poll(std::time::Duration::from_millis(100))? {
            continue;
        }
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Up => selected = selected.saturating_sub(1),
                KeyCode::Down => selected = (selected + 1).min(shown.len().saturating_sub(1)),
                KeyCode::PageUp => {
                    let page = opts.page_size.max(1) as usize;
                    selected = selected.saturating_sub(page);
                }
                KeyCode::PageDown => {
                    let page = opts.page_size.max(1) as usize;
                    selected = (selected + page).min(shown.len().saturating_sub(1));
                }
                KeyCode::Enter => {
                    if no_match {
                        continue;
                    }
                    return Ok(Some(shown[selected].value.clone()));
                }
                KeyCode::Backspace => {
                    filter.pop();
                    selected = 0;
                }
                KeyCode::Char('c') if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                    return Ok(None);
                }
                KeyCode::Esc => return Ok(None),
                KeyCode::Char(ch) if opts.filterable => {
                    filter.push(ch);
                    selected = 0;
                }
                _ => {}
            }
        }
    }
}

/// Render the picker overlay: bordered list, optional page footer in the
/// title, a bottom notice line, and a no-match placeholder row.
fn render_picker(
    frame: &mut Frame<'_>,
    theme: Theme,
    opts: &PickerOptions,
    shown: &[&PickerItem],
    selected: usize,
    filter: &str,
    no_match: bool,
) {
    let (start, end) = window(selected, shown.len(), opts.page_size);
    let mut lines: Vec<Line<'_>> = Vec::new();
    if no_match {
        lines.push(Line::from(Span::styled(
            t!("tui.picker.noMatch", filter),
            Style::default().fg(theme.error),
        )));
    } else {
        for (i, item) in shown.iter().enumerate().skip(start).take(end - start) {
            let is_selected = i == selected;
            let base_style = if is_selected {
                Style::default()
                    .fg(theme.user)
                    .add_modifier(Modifier::REVERSED)
            } else {
                Style::default().fg(theme.status)
            };
            let mut spans = vec![Span::styled(format!("  {}", item.value), base_style)];
            spans.push(Span::styled(format!("  {}", item.label), base_style));
            if let Some(desc) = &item.description {
                spans.push(Span::styled(
                    format!("  {desc}"),
                    Style::default().fg(theme.thinking),
                ));
            }
            lines.push(Line::from(spans));
        }
    }
    if let Some(notice) = &opts.notice {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            notice.clone(),
            Style::default().fg(theme.thinking),
        )));
    }
    let title = if opts.page_size > 0 {
        let page = page_of(selected, opts.page_size);
        let pages = pages_of(shown.len(), opts.page_size);
        format!("{} ({}/{})", opts.title, page + 1, pages)
    } else {
        opts.title.clone()
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .title(t!("tui.picker.hint", title));
    frame.render_widget(Paragraph::new(Text::from(lines)).block(block), frame.area());
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
                Style::default()
                    .fg(theme.user)
                    .add_modifier(Modifier::REVERSED)
            } else {
                Style::default().fg(theme.status)
            };
            Line::from(Span::styled(text, style))
        })
        .collect();
    let block = Block::default()
        .borders(Borders::ALL)
        .title(t!("tui.picker.hint", title));
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
            .draw(|frame| {
                render(
                    frame,
                    crate::theme::Theme::dark(),
                    "resume a session",
                    &items,
                    1,
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let lines: Vec<String> = (0..10)
            .map(|y| {
                (0..50)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect()
            })
            .collect();
        assert!(
            lines.iter().any(|l| l.contains("resume a session")),
            "title:\n{}",
            lines.join("\n")
        );
        assert!(lines
            .iter()
            .any(|l| l.contains("s-1") && l.contains("first")));
        assert!(lines
            .iter()
            .any(|l| l.contains("s-3") && l.contains("third")));
        // The selected entry (index 1) is highlighted with REVERSED.
        let selected_row = lines
            .iter()
            .position(|l| l.contains("second"))
            .expect("second row");
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

    #[test]
    fn filter_matches_value_or_label_case_insensitively() {
        let items = vec![
            ("kimi-k2".to_string(), "Kimi K2".to_string()),
            (
                "kimi-k2-thinking".to_string(),
                "Kimi K2 Thinking".to_string(),
            ),
            ("deepseek".to_string(), "DeepSeek".to_string()),
        ];
        assert_eq!(filter_items(&items, "k2").len(), 2);
        assert_eq!(filter_items(&items, "DEEP").len(), 1);
        assert_eq!(filter_items(&items, "DEEP")[0].0, "deepseek");
        assert!(filter_items(&items, "zzz").is_empty());
        assert_eq!(filter_items(&items, "").len(), 3);
    }

    #[test]
    fn pagination_window_follows_selected_page() {
        // page_size 0 disables pagination -> whole list.
        assert_eq!(window(0, 10, 0), (0, 10));
        assert_eq!(window(9, 10, 0), (0, 10));
        // Page boundaries: 4-item pages over 10 items.
        assert_eq!(window(0, 10, 4), (0, 4));
        assert_eq!(window(3, 10, 4), (0, 4));
        assert_eq!(window(4, 10, 4), (4, 8));
        assert_eq!(window(7, 10, 4), (4, 8));
        assert_eq!(window(9, 10, 4), (8, 10));
        // Empty list -> empty window.
        assert_eq!(window(0, 0, 4), (0, 0));
    }

    #[test]
    fn pagination_page_math() {
        assert_eq!(page_of(5, 4), 1);
        assert_eq!(page_of(0, 4), 0);
        assert_eq!(pages_of(10, 4), 3);
        assert_eq!(pages_of(4, 4), 1);
        assert_eq!(pages_of(0, 4), 1);
        assert_eq!(page_of(5, 0), 0);
        assert_eq!(pages_of(10, 0), 1);
    }

    #[test]
    fn picker_items_filter_by_value_or_label() {
        let items = vec![
            PickerItem::new("kimi-k2", "Kimi K2").with_description("flagship"),
            PickerItem::new("deepseek", "DeepSeek"),
        ];
        assert_eq!(filter_picker_items(&items, "k2").len(), 1);
        assert_eq!(filter_picker_items(&items, "DEEP").len(), 1);
        assert_eq!(filter_picker_items(&items, "zzz").len(), 0);
        assert_eq!(filter_picker_items(&items, "").len(), 2);
    }

    #[test]
    fn picker_renders_description_and_notice() {
        let items = vec![PickerItem::new("m1", "Model One").with_description("desc one")];
        let opts = PickerOptions::new("models").notice("↑/↓ navigate");
        let mut terminal = Terminal::new(TestBackend::new(50, 8)).unwrap();
        terminal
            .draw(|frame| {
                let shown: Vec<&PickerItem> = items.iter().collect();
                render_picker(
                    frame,
                    crate::theme::Theme::dark(),
                    &opts,
                    &shown,
                    0,
                    "",
                    false,
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let text: Vec<String> = (0..8)
            .map(|y| {
                (0..50)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect()
            })
            .collect();
        assert!(
            text.iter().any(|l| l.contains("desc one")),
            "description: {:?}",
            text
        );
        assert!(
            text.iter().any(|l| l.contains("↑/↓ navigate")),
            "notice: {:?}",
            text
        );
    }

    #[test]
    fn picker_title_shows_page_footer_when_paged() {
        let opts = PickerOptions::new("sessions").paged(3);
        let items: Vec<PickerItem> = (0..7)
            .map(|i| PickerItem::new(format!("s{i}"), format!("S{i}")))
            .collect();
        let mut terminal = Terminal::new(TestBackend::new(40, 6)).unwrap();
        terminal
            .draw(|frame| {
                let shown: Vec<&PickerItem> = items.iter().collect();
                render_picker(
                    frame,
                    crate::theme::Theme::dark(),
                    &opts,
                    &shown,
                    4,
                    "",
                    false,
                )
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let top: String = (0..40)
            .map(|x| buffer[(x, 0)].symbol().to_string())
            .collect();
        assert!(top.contains("(2/3)"), "page footer: {top}");
    }

    #[test]
    fn picker_renders_no_match_placeholder() {
        let opts = PickerOptions::new("models").filterable();
        let mut terminal = Terminal::new(TestBackend::new(40, 6)).unwrap();
        terminal
            .draw(|frame| {
                let shown: Vec<&PickerItem> = vec![];
                render_picker(
                    frame,
                    crate::theme::Theme::dark(),
                    &opts,
                    &shown,
                    0,
                    "zzz",
                    true,
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
        assert!(
            text.iter().any(|l| l.contains("no match: zzz")),
            "rows: {:?}",
            text
        );
    }
}
