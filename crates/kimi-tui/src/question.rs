//! AskUserQuestion dialog (TS `question-dialog` parity) — the modal the
//! stopped turn opens so the user can answer with an option pick (single or
//! multi) or free text. The answer is sent back as the next user message.
//! Pure UI state machine over the structured tool arguments; the app shell
//! owns rendering and the submit path.

use crossterm::event::KeyCode;

use crate::i18n::t;
use crate::t;

/// The AskUserQuestion modal state: parsed args + the in-progress answer.
#[derive(Debug, Clone, PartialEq)]
pub struct QuestionPanel {
    pub(crate) tool_call_id: String,
    header: String,
    question: String,
    options: Vec<(String, String)>,
    multi_select: bool,
    draft: String,
    selected: Vec<usize>,
    /// First visible option row (↑/↓ scrolls when options overflow).
    offset: usize,
}

impl QuestionPanel {
    /// Parse the structured `AskUserQuestion` arguments (the same JSON the
    /// engine received on `session.tool.started`).
    pub fn from_args(args: &serde_json::Value) -> Self {
        let question = args["question"].as_str().unwrap_or("?").to_string();
        let header = args["header"].as_str().unwrap_or("").to_string();
        let multi_select = args["multi_select"].as_bool().unwrap_or(false);
        let options = args["options"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| {
                        let label = o["label"].as_str()?.to_string();
                        let desc = o["description"].as_str().unwrap_or("").to_string();
                        Some((label, desc))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            tool_call_id: String::new(),
            header,
            question,
            options,
            multi_select,
            draft: String::new(),
            selected: Vec::new(),
            offset: 0,
        }
    }

    /// The visible option slice for a modal `height`-tall (borders excluded):
    /// header + question + options + draft + hint rows need to fit.
    fn visible_options(&self, height: usize) -> (usize, usize) {
        // Rows before the options: header?, question, blank, "options:".
        let prefix = 2 + usize::from(!self.header.is_empty()) + 1;
        // Rows after the options: blank + draft + blank + hint.
        let suffix = 4;
        let available = height.saturating_sub(prefix + suffix);
        let count = self.options.len().min(available);
        let start = self.offset.min(self.options.len().saturating_sub(count));
        (start, start + count)
    }

    /// The modal text rows (pure, tested): header + question + numbered
    /// options + the answer draft + an action hint. The live renderer uses
    /// [`Self::rows_visible`]; the full layout is kept for tests.
    #[cfg(test)]
    pub fn rows(&self) -> Vec<String> {
        self.build_rows(0..self.options.len())
    }

    /// Rows clipped to a `height`-tall modal (borders excluded): the option
    /// window scrolls (↑/↓) when options overflow.
    pub fn rows_visible(&self, height: usize) -> Vec<String> {
        let (start, end) = self.visible_options(height);
        let mut rows = self.build_rows(start..end);
        if end - start < self.options.len() {
            rows.push(t!(
                "tui.question.more",
                self.options.len() - (end - start)
            ));
        }
        rows
    }

    fn build_rows(&self, options: std::ops::Range<usize>) -> Vec<String> {
        let mut rows = Vec::new();
        if !self.header.is_empty() {
            rows.push(self.header.clone());
        }
        rows.push(self.question.clone());
        if !self.options.is_empty() {
            rows.push(String::new());
            rows.push(t("tui.question.options").to_string());
        }
        for (i, (label, desc)) in self
            .options
            .iter()
            .enumerate()
            .skip(options.start)
            .take(options.end - options.start)
        {
            let mark = if self.multi_select && self.selected.contains(&i) {
                "✓"
            } else {
                " "
            };
            let line = if desc.is_empty() {
                format!("  {mark} {}. {label}", i + 1)
            } else {
                format!("  {mark} {}. {label} — {desc}", i + 1)
            };
            rows.push(line);
        }
        rows.push(String::new());
        rows.push(format!("{} {}", t("tui.question.answer"), self.draft));
        rows.push(String::new());
        rows.push(
            t(if self.multi_select {
                "tui.question.multiHint"
            } else {
                "tui.question.hint"
            })
            .to_string(),
        );
        rows
    }

    /// The answer the current state would submit: the picked option label
    /// (single), picked labels joined (multi), or the free-text draft.
    pub fn answer(&self) -> String {
        if self.multi_select {
            let picked: Vec<String> = self
                .selected
                .iter()
                .filter_map(|&i| self.options.get(i))
                .map(|(label, _)| label.clone())
                .collect();
            if picked.is_empty() {
                self.draft.clone()
            } else {
                picked.join(", ")
            }
        } else if let Some(&i) = self.selected.first() {
            self.options
                .get(i)
                .map(|(label, _)| label.clone())
                .unwrap_or_default()
        } else {
            self.draft.clone()
        }
    }

    /// Handle one key press; returns the answer to submit, or `None` to keep
    /// the panel open.
    pub fn key(&mut self, code: KeyCode) -> Option<String> {
        match code {
            KeyCode::Esc => Some(String::new()),
            KeyCode::Enter => Some(self.answer()),
            KeyCode::Up => {
                self.offset = self.offset.saturating_sub(1);
                None
            }
            KeyCode::Down => {
                self.offset = self.offset.saturating_add(1);
                None
            }
            KeyCode::Backspace => {
                self.draft.pop();
                None
            }
            KeyCode::Char(ch) if ch.is_ascii_digit() && ch != '0' => {
                let idx = ch.to_digit(10).unwrap() as usize - 1;
                if idx < self.options.len() {
                    if self.multi_select {
                        if let Some(pos) = self.selected.iter().position(|&s| s == idx) {
                            self.selected.remove(pos);
                        } else {
                            self.selected.push(idx);
                        }
                    } else {
                        self.selected = vec![idx];
                    }
                } else {
                    self.draft.push(ch);
                }
                None
            }
            KeyCode::Char(ch) => {
                self.draft.push(ch);
                None
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Locale;

    #[test]
    fn question_panel_parses_args_and_answers() {
        crate::i18n::set_locale(Locale::En);
        let args = serde_json::json!({
            "question": "Which approach?",
            "options": [
                { "label": "Rust" },
                { "label": "TS", "description": "keep TS" }
            ],
            "header": "Architecture",
            "multi_select": false,
        });
        let mut panel = QuestionPanel::from_args(&args);
        // Rows: header + question + options + draft + hint.
        let rows = panel.rows();
        assert!(rows.iter().any(|r| r.contains("Architecture")));
        assert!(rows.iter().any(|r| r.contains("Which approach?")));
        assert!(rows.iter().any(|r| r.contains("1. Rust")));
        assert!(rows.iter().any(|r| r.contains("2. TS — keep TS")));
        // Digit picks the option; the answer is its label.
        assert_eq!(panel.key(KeyCode::Char('2')), None);
        assert_eq!(panel.answer(), "TS");
        // Enter submits the picked label.
        assert_eq!(panel.key(KeyCode::Enter).as_deref(), Some("TS"));
        // Esc submits an empty answer (skip).
        let mut skip = QuestionPanel::from_args(&args);
        assert_eq!(skip.key(KeyCode::Esc).as_deref(), Some(""));
        // Free text works when nothing is picked.
        let mut free = QuestionPanel::from_args(&args);
        assert_eq!(free.key(KeyCode::Char('h')), None);
        assert_eq!(free.key(KeyCode::Char('i')), None);
        assert_eq!(free.key(KeyCode::Enter).as_deref(), Some("hi"));
    }

    #[test]
    fn question_panel_multi_select_joins_labels() {
        crate::i18n::set_locale(Locale::En);
        let args = serde_json::json!({
            "question": "Pick?",
            "options": [ { "label": "a" }, { "label": "b" }, { "label": "c" } ],
            "multi_select": true,
        });
        let mut panel = QuestionPanel::from_args(&args);
        assert_eq!(panel.key(KeyCode::Char('1')), None);
        assert_eq!(panel.key(KeyCode::Char('3')), None);
        // Toggle off the first pick.
        assert_eq!(panel.key(KeyCode::Char('1')), None);
        assert_eq!(panel.answer(), "c");
        assert_eq!(panel.key(KeyCode::Enter).as_deref(), Some("c"));
        // Missing digits fall back to the draft.
        let mut panel = QuestionPanel::from_args(&args);
        assert_eq!(panel.key(KeyCode::Char('9')), None);
        assert_eq!(panel.key(KeyCode::Enter).as_deref(), Some("9"));
    }

    #[test]
    fn question_panel_scrolls_overflowing_options() {
        crate::i18n::set_locale(Locale::En);
        let mut options = Vec::new();
        for i in 0..12 {
            options.push(serde_json::json!({ "label": format!("opt-{i}") }));
        }
        let args = serde_json::json!({
            "question": "Pick one?",
            "options": options,
        });
        let mut panel = QuestionPanel::from_args(&args);
        // A short modal clips the options and reports the hidden count.
        let visible = panel.rows_visible(10);
        assert!(visible.iter().any(|r| r.contains("opt-0")));
        assert!(!visible.iter().any(|r| r.contains("opt-11")));
        assert!(visible.iter().any(|r| r.contains("more options")));
        // ↑/↓ move the window; the selection still maps to absolute indices.
        assert_eq!(panel.key(KeyCode::Down), None);
        let visible = panel.rows_visible(10);
        assert!(visible.iter().any(|r| r.contains("opt-1")));
        // A tall modal shows everything without the "more" hint.
        let tall = panel.rows_visible(10_000);
        assert!(tall.iter().any(|r| r.contains("opt-11")));
        assert!(!tall.iter().any(|r| r.contains("more options")));
        // Scrolling never underflows.
        for _ in 0..5 {
            assert_eq!(panel.key(KeyCode::Up), None);
        }
        let visible = panel.rows_visible(10);
        assert!(visible.iter().any(|r| r.contains("opt-0")));
    }
}
