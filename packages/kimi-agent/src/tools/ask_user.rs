//! AskUserQuestion tool — ask the user a structured question with options.
//!
//! The model calls this tool when the best approach depends on user
//! preferences, constraints, or missing context. Unlike a permission prompt
//! (which gates a tool execution), this is a *deliberate* question the model
//! poses: the turn stops and the host surfaces the question (TUI dialog or
//! plain-text block). The user's answer arrives as the next user message, so
//! this tool needs no reverse-RPC: it formats the question + options into the
//! result content and sets `stop_turn`, mirroring the TS
//! `AskUserQuestion` builtin from `apps/kimi-code`.

use serde_json::Value;

use crate::turn_loop::types::ExecutableToolResult;

// ── Constants ───────────────────────────────────────────────────────────

pub const ASK_USER_QUESTION_TOOL_NAME: &str = "AskUserQuestion";

const ASK_USER_QUESTION_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "question": {
      "type": "string",
      "description": "The question to ask the user."
    },
    "options": {
      "type": "array",
      "description": "Suggested answers; the user may still reply freely.",
      "items": {
        "type": "object",
        "properties": {
          "label": { "type": "string", "description": "Short option label." },
          "description": { "type": "string", "description": "Optional longer explanation." }
        },
        "required": ["label"]
      }
    },
    "multi_select": {
      "type": "boolean",
      "description": "Whether the user may pick more than one option."
    },
    "header": {
      "type": "string",
      "description": "Optional section header for the question dialog."
    }
  },
  "required": ["question", "options"]
}"#;

// ── Tool definition ─────────────────────────────────────────────────────

/// The `ToolDefinition` advertised to the model.
pub fn tool_definition() -> crate::context::types::ToolDefinition {
    crate::context::types::ToolDefinition {
        name: ASK_USER_QUESTION_TOOL_NAME.into(),
        description: "Ask the user a question with suggested options. Use this when the best \
                      approach depends on user preferences, constraints, or missing context. The \
                      turn ends until the user answers."
            .into(),
        input_schema: Some(serde_json::from_str(ASK_USER_QUESTION_SCHEMA).expect("valid schema")),
    }
}

// ── Execution ───────────────────────────────────────────────────────────

/// Format the question + options into a human-readable block and stop the
/// turn. The host surfaces the content; the user's answer arrives as the
/// next user message.
pub fn execute_ask_user_question(args: &Value) -> ExecutableToolResult {
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("(no question provided)");
    let header = args.get("header").and_then(|v| v.as_str());
    let multi_select = args.get("multi_select").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut content = String::new();
    if let Some(h) = header {
        content.push_str(&format!("## {h}\n\n"));
    }
    content.push_str(question);
    content.push('\n');

    if let Some(options) = args.get("options").and_then(|v| v.as_array()) {
        if !options.is_empty() {
            content.push_str("\nOptions:\n");
            for (i, opt) in options.iter().enumerate() {
                let label = opt.get("label").and_then(|v| v.as_str()).unwrap_or("");
                let desc = opt.get("description").and_then(|v| v.as_str());
                match desc {
                    Some(d) if !d.is_empty() => {
                        content.push_str(&format!("  {}. {label} — {d}\n", i + 1));
                    }
                    _ => content.push_str(&format!("  {}. {label}\n", i + 1)),
                }
            }
        }
    }
    content.push_str(if multi_select {
        "\n(multi-select — reply with one or more numbers, or free text)"
    } else {
        "\n(reply with a number, or free text)"
    });

    ExecutableToolResult {
        content,
        is_error: false,
        is_prediction: false,
        // Stop the turn so the host can surface the question and the user can
        // answer; the answer arrives as the next user message.
        stop_turn: true,
        media: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_question_with_options_and_stops_turn() {
        let result = execute_ask_user_question(&json!({
            "question": "Which approach?",
            "options": [
                { "label": "Rust" },
                { "label": "TS", "description": "keep TS" }
            ],
            "header": "Architecture",
        }));
        assert!(!result.is_error);
        assert!(result.stop_turn, "AskUserQuestion must stop the turn");
        assert!(result.content.contains("## Architecture"), "{}", result.content);
        assert!(result.content.contains("Which approach?"), "{}", result.content);
        assert!(result.content.contains("1. Rust"), "{}", result.content);
        assert!(result.content.contains("2. TS — keep TS"), "{}", result.content);
    }

    #[test]
    fn handles_missing_options_gracefully() {
        let result = execute_ask_user_question(&json!({ "question": "ok?" }));
        assert!(!result.is_error);
        assert!(result.content.contains("ok?"));
        assert!(!result.content.contains("Options:"));
    }

    #[test]
    fn advertised_definition_matches_name() {
        assert_eq!(tool_definition().name, ASK_USER_QUESTION_TOOL_NAME);
        let schema = tool_definition().input_schema.expect("schema present");
        assert!(schema.get("required").is_some());
    }
}
