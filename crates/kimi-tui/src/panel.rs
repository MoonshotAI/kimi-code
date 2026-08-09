//! Panel chrome — the bordered box with an optional colored border that
//! frames a set of pre-styled lines (TS `usage-panel.ts` border-box parity).
//! The line *builders* (goal/status/usage reports) land with the P3 panel
//! batch; this module owns the box itself and its rendering.

use ratatui::style::Color;
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Paragraph};

/// Render a bordered box with `title` and an optional border color,
/// wrapping `lines`. The box spans `area` entirely (borders included).
pub fn render_panel(
    frame: &mut ratatui::Frame<'_>,
    area: ratatui::layout::Rect,
    title: &str,
    border: Option<Color>,
    lines: Vec<Line<'static>>,
) {
    let mut block = Block::default()
        .borders(Borders::ALL)
        .title(title.to_string());
    if let Some(color) = border {
        block = block.border_style(ratatui::style::Style::default().fg(color));
    }
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn panel_renders_title_border_and_lines() {
        let mut terminal = Terminal::new(TestBackend::new(40, 6)).unwrap();
        let lines = vec![
            Line::from("line one"),
            Line::from("line two"),
        ];
        terminal
            .draw(|frame| {
                render_panel(
                    frame,
                    frame.area(),
                    "usage",
                    Some(ratatui::style::Color::Cyan),
                    lines,
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
        assert!(text[0].contains("usage"), "title row: {}", text[0]);
        assert!(text.iter().any(|l| l.contains("line one")));
        assert!(text.iter().any(|l| l.contains("line two")));
        // Border glyphs on the top/bottom rows.
        assert!(text[0].contains('┌') && text[5].contains('└'));
    }

    #[test]
    fn panel_without_border_color_renders_plain() {
        let mut terminal = Terminal::new(TestBackend::new(20, 4)).unwrap();
        terminal
            .draw(|frame| render_panel(frame, frame.area(), "t", None, vec![]))
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let top: String = (0..20)
            .map(|x| buffer[(x, 0)].symbol().to_string())
            .collect();
        assert!(top.contains('┌'), "border drawn: {top}");
    }
}
