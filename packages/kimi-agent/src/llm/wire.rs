//! Provider-agnostic wire message used to project a turn's history into a
//! specific provider's request format.
#![allow(dead_code)]

use crate::turn_loop::types::{LLMMessage, ToolCall};

/// A single chat message to be projected into a provider wire format.
///
/// Content is text-only for now (media / thinking projection is a later
/// phase). Tool calls (assistant) and the tool-result linkage (`tool_call_id`)
/// are carried structurally so multi-step tool turns round-trip faithfully
/// across providers with different tool-call encodings (OpenAI stringified
/// `function.arguments` vs. Anthropic `tool_use.input` objects).
#[derive(Debug, Clone)]
pub struct WireMessage {
    /// One of "system" | "user" | "assistant" | "tool".
    pub role: String,
    /// Text content. May be empty for an assistant turn that only calls tools.
    pub content: String,
    /// Tool calls requested by an assistant turn (empty otherwise).
    pub tool_calls: Vec<ToolCall>,
    /// For `role == "tool"`: the id of the tool call this message answers.
    pub tool_call_id: Option<String>,
}

impl WireMessage {
    /// A plain text message with no tool calls or tool-result linkage.
    pub fn text(role: &str, content: &str) -> Self {
        Self {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    /// An assistant message that issued `tool_calls` (optionally with text).
    pub fn assistant_tool_calls(content: &str, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.to_string(),
            tool_calls,
            tool_call_id: None,
        }
    }

    /// A tool-result message answering the call `tool_call_id`.
    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        Self {
            role: "tool".to_string(),
            content: content.to_string(),
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.to_string()),
        }
    }
}

/// Project the loop's `LLMMessage` history into provider-agnostic wire
/// messages. The two types are structurally identical today; this converter is
/// the single seam where the loop message model and the provider projection
/// input can diverge later (e.g. media content parts).
pub fn to_wire(messages: &[LLMMessage]) -> Vec<WireMessage> {
    messages
        .iter()
        .map(|m| WireMessage {
            role: m.role.clone(),
            content: m.content.clone(),
            tool_calls: m.tool_calls.clone(),
            tool_call_id: m.tool_call_id.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn to_wire_preserves_tool_structure() {
        let messages = vec![
            LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() },
            LLMMessage {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "Read".into(),
                    arguments: json!({ "path": "a" }),
                }],
                tool_call_id: None,
            },
            LLMMessage {
                role: "tool".into(),
                content: "body".into(),
                tool_calls: Vec::new(),
                tool_call_id: Some("c1".into()),
            },
        ];

        let wire = to_wire(&messages);
        assert_eq!(wire.len(), 3);
        assert!(wire[0].tool_calls.is_empty());
        assert_eq!(wire[1].tool_calls.len(), 1);
        assert_eq!(wire[1].tool_calls[0].id, "c1");
        assert_eq!(wire[2].tool_call_id.as_deref(), Some("c1"));
    }
}
