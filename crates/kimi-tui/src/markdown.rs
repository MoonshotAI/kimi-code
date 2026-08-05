//! Markdown rendering for the assistant transcript 鈥?a lightweight pass over
//! `pulldown-cmark` that maps block/span events onto ratatui styled spans.
//! Pure function, unit-testable without a terminal.

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line as RenderLine, Span};

use crate::theme::Theme;

/// Render a markdown document into styled ratatui lines using the given
/// theme palette.
pub fn render_markdown_themed(markdown: &str, theme: Theme) -> Vec<RenderLine<'static>> {
    render_inner(markdown, theme)
}

/// Render a markdown document with the default (dark) palette.
pub fn render_markdown(markdown: &str) -> Vec<RenderLine<'static>> {
    render_inner(markdown, Theme::dark())
}

fn render_inner(markdown: &str, theme: Theme) -> Vec<RenderLine<'static>> {
    let parser = Parser::new_ext(markdown, Options::ENABLE_TABLES);
    let mut out: Vec<RenderLine<'static>> = Vec::new();
    let mut current: Vec<Span<'static>> = Vec::new();
    // Inline emphasis / code state.
    let mut bold = false;
    let mut italic = false;
    let mut strike = false;
    // Block state.
    let mut quote_depth = 0usize;
    let mut in_code_block = false;
    let mut code_buf: Vec<u8> = Vec::new();

    macro_rules! flush_line {
        () => {{
            if !current.is_empty() {
                out.push(RenderLine::from(std::mem::take(&mut current)));
            } else {
                out.push(RenderLine::default());
            }
        }};
    }

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush_line!();
                current.push(Span::styled(
                    heading_prefix(level),
                    Style::default().add_modifier(Modifier::BOLD),
                ));
            }
            Event::End(TagEnd::Heading(_)) => {
                flush_line!();
                out.push(RenderLine::default());
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => flush_line!(),
            Event::Start(Tag::Emphasis) => italic = true,
            Event::End(TagEnd::Emphasis) => italic = false,
            Event::Start(Tag::Strong) => bold = true,
            Event::End(TagEnd::Strong) => bold = false,
            Event::Start(Tag::Strikethrough) => strike = true,
            Event::End(TagEnd::Strikethrough) => strike = false,
            Event::Start(Tag::BlockQuote(_)) => {
                flush_line!();
                quote_depth += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush_line!();
                quote_depth = quote_depth.saturating_sub(1);
            }
            Event::Start(Tag::List(..)) => {}
            Event::End(TagEnd::List(_)) => {}
            Event::Start(Tag::Item) => {
                let indent = "  ".repeat(quote_depth);
                current.push(Span::raw(format!("{indent}鈥?")));
            }
            Event::End(TagEnd::Item) => flush_line!(),
            Event::Start(Tag::CodeBlock(_kind)) => {
                flush_line!();
                in_code_block = true;
                code_buf.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                let code = String::from_utf8_lossy(&code_buf).into_owned();
                for line in code.lines() {
                    out.push(RenderLine::from(Span::styled(
                        format!("  {line}"),
                        Style::default().fg(theme.code),
                    )));
                }
                code_buf.clear();
            }
            Event::Text(text) => {
                if in_code_block {
                    code_buf.extend_from_slice(text.as_bytes());
                } else {
                    let mut style = Style::default();
                    if bold {
                        style = style.add_modifier(Modifier::BOLD);
                    }
                    if italic {
                        style = style.add_modifier(Modifier::ITALIC);
                    }
                    if strike {
                        style = style.add_modifier(Modifier::CROSSED_OUT);
                    }
                    current.push(Span::styled(text.to_string(), style));
                }
            }
            Event::Code(text) => {
                current.push(Span::styled(text.to_string(), Style::default().fg(theme.code)));
            }
            Event::SoftBreak | Event::HardBreak => {
                flush_line!();
            }
            Event::Rule => {
                flush_line!();
                out.push(RenderLine::from(Span::styled(
                    "鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€",
                    Style::default().fg(theme.status),
                )));
            }
            Event::TaskListMarker(true) => current.push(Span::raw("鈽?")),
            Event::TaskListMarker(false) => current.push(Span::raw("鈽?")),
            Event::Start(Tag::Link { .. }) | Event::Start(Tag::Image { .. }) => {}
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {}
            Event::Html(_) | Event::InlineHtml(_) => {}
            Event::InlineMath(_) | Event::DisplayMath(_) => {}
            Event::FootnoteReference(_) => {}
            Event::Start(Tag::FootnoteDefinition(_)) => {}
            Event::End(TagEnd::FootnoteDefinition) => {}
            Event::Start(Tag::DefinitionList) => {}
            Event::End(TagEnd::DefinitionList) => {}
            Event::Start(Tag::DefinitionListTitle) => {}
            Event::End(TagEnd::DefinitionListTitle) => {}
            Event::Start(Tag::DefinitionListDefinition) => {}
            Event::End(TagEnd::DefinitionListDefinition) => {}
            Event::Start(Tag::Table(_)) => {}
            Event::End(TagEnd::Table) => {}
            Event::Start(Tag::TableHead) => {}
            Event::End(TagEnd::TableHead) => {}
            Event::Start(Tag::TableRow) => {}
            Event::End(TagEnd::TableRow) => {}
            Event::Start(Tag::TableCell) => {}
            Event::End(TagEnd::TableCell) => {}
            Event::Start(Tag::HtmlBlock) => {}
            Event::End(TagEnd::HtmlBlock) => {}
            Event::Start(Tag::MetadataBlock(_)) => {}
            Event::End(TagEnd::MetadataBlock(_)) => {}
        }
    }
    if in_code_block && !code_buf.is_empty() {
        let code = String::from_utf8_lossy(&code_buf).into_owned();
        for line in code.lines() {
            out.push(RenderLine::from(Span::styled(
                format!("  {line}"),
                Style::default().fg(theme.code),
            )));
        }
    }
    if !current.is_empty() {
        out.push(RenderLine::from(current));
    }
    if out.is_empty() {
        out.push(RenderLine::default());
    }
    out
}

/// The visual prefix for a heading level (h1 鈫?`# `, h2 鈫?`## `, 鈥?.
fn heading_prefix(level: HeadingLevel) -> String {
    let n = match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    };
    format!("{} ", "#".repeat(n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Color;


    #[test]
    fn renders_plain_text() {
        let lines = render_markdown("hello world");
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(text, "hello world");
    }

    #[test]
    fn renders_headings_and_paragraphs() {
        let lines = render_markdown("# Title\n\nSome text.");
        // Heading flush yields: blank, title, blank, paragraph.
        assert!(lines.len() >= 4, "got {} lines", lines.len());
        let title: String = lines[1].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(title, "# Title");
        let para: String = lines[3].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(para, "Some text.");
    }

    #[test]
    fn renders_bold_and_code_spans() {
        let lines = render_markdown("**bold** and `code`");
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.clone()).collect();
        assert_eq!(text, "bold and code");
        // Bold span carries the BOLD modifier.
        assert!(
            lines[0].spans.iter().any(|s| s.style.add_modifier.contains(Modifier::BOLD)),
            "a span is bold"
        );
        // Code span is yellow.
        assert!(
            lines[0].spans.iter().any(|s| s.style.fg == Some(Color::Yellow)),
            "a span is code-styled"
        );
    }

    #[test]
    fn renders_code_block() {
        let lines = render_markdown("```rust\nfn main() {}\n```");
        let all: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.clone()))
            .collect();
        assert!(all.contains("fn main() {}"), "code body present: {all}");
        assert!(
            lines.iter().any(|l| l.spans.iter().any(|s| s.style.fg == Some(Color::Yellow))),
            "code line is yellow"
        );
    }

    #[test]
    fn empty_input_yields_one_blank_line() {
        let lines = render_markdown("");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].spans.is_empty());
    }
}

