//! Engine event handling — tool and background-task events drive the
//! transcript cards (TS `session-event-handler` parity, simplified). Split
//! out of `app.rs`; the event pump in the app shell calls these.


use crate::app::{
    Overlay, ToolCallEntry, TranscriptEntry, TranscriptLine,
    upsert_task_card,
};
use crate::i18n::t;
use crate::question::QuestionPanel;

impl super::app::App {
    pub(crate) fn handle_tool_event(&mut self, event: &serde_json::Value) {
        let r#type = event["type"].as_str().unwrap_or("");
        let tool_call_id = event["tool_call_id"].as_str().unwrap_or("").to_string();
        let tool_name = event["tool_name"].as_str().unwrap_or("?").to_string();
        // Empty ids never participate in upsert matching: a missing id would
        // otherwise match the first empty-id card (misattribution across
        // tools). Unmatched events just append a fresh card.
        let find_index = if tool_call_id.is_empty() {
            None
        } else {
            self.view.transcript.iter().position(|e| match e {
                TranscriptEntry::ToolCall(tc) => tc.tool_call_id == tool_call_id,
                _ => false,
            })
        };
        if r#type == "session.tool.started" {
            let args = serde_json::to_string(&event["arguments"]).unwrap_or_default();
            let collapsed = args.chars().count() > 120;
            let is_question = tool_name == "AskUserQuestion";
            // Record the start time (empty ids don't get a duration).
            if !tool_call_id.is_empty() {
                self.tool_started_at
                    .insert(tool_call_id.clone(), std::time::Instant::now());
            }
            match find_index.and_then(|i| self.view.transcript.get_mut(i)) {
                Some(TranscriptEntry::ToolCall(existing)) => {
                    existing.tool_name = tool_name;
                    existing.args = args;
                    existing.result = None;
                    existing.is_error = false;
                    existing.is_question = is_question;
                    existing.duration = None;
                    existing.collapsed = collapsed;
                }
                _ => {
                    self.view
                        .transcript
                        .push(TranscriptEntry::ToolCall(ToolCallEntry {
                            tool_call_id,
                            tool_name,
                            args,
                            result: None,
                            is_error: false,
                            is_question,
                            duration: None,
                            collapsed,
                        }));
                }
            }
        } else if r#type == "session.tool.settled" || r#type == "tool.native" {
            let mut result = event["content"].as_str().unwrap_or("").to_string();
            let is_error = event["is_error"].as_bool().unwrap_or(false);
            // ReadMediaFile results embed the full base64 in `content`;
            // surface a human-readable summary instead (TS media renderer).
            if !is_error && tool_name == "ReadMediaFile" {
                result = crate::media::media_summary_text(&result).unwrap_or(result);
            }
            let is_question = tool_name == "AskUserQuestion";
            // AskUserQuestion stops the turn: open the question dialog so
            // the user can answer with an option or free text (the answer
            // goes back as the next user message).
            if is_question && !is_error {
                let args = event
                    .get("arguments")
                    .cloned()
                    .or_else(|| {
                        self.view.transcript.iter().rev().find_map(|e| match e {
                            TranscriptEntry::ToolCall(tc) if tc.is_question => {
                                serde_json::from_str(&tc.args).ok()
                            }
                            _ => None,
                        })
                    });
                if let Some(args) = args {
                    let mut panel = QuestionPanel::from_args(&args);
                    panel.tool_call_id = tool_call_id.clone();
                    self.overlay = Some(Overlay::Question(panel));
                }
            }
            // Resolve the elapsed time from the started event.
            let duration = self
                .tool_started_at
                .remove(&tool_call_id)
                .map(|t| t.elapsed());
            match find_index.and_then(|i| self.view.transcript.get_mut(i)) {
                Some(TranscriptEntry::ToolCall(existing)) => {
                    existing.result = Some(result);
                    existing.is_error = is_error;
                    existing.is_question = is_question;
                    existing.duration = duration;
                }
                _ => {
                    // A settled event without a matching started (replay edge).
                    self.view
                        .transcript
                        .push(TranscriptEntry::ToolCall(ToolCallEntry {
                            tool_call_id,
                            tool_name,
                            args: String::new(),
                            result: Some(result),
                            is_error,
                            is_question,
                            duration,
                            collapsed: false,
                        }));
                }
            }
            // AskUserQuestion stops the turn and awaits the user's answer as
            // the next message — tell the user how to reply.
            if is_question && !is_error {
                self.push_line(TranscriptLine::status(t("tui.question.replyHint")));
            }
        }
    }

    pub(crate) fn handle_task_event(&mut self, event: &serde_json::Value) {
        upsert_task_card(&mut self.view.transcript, event);
    }
}
