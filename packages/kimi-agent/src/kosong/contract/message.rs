/// Provider-agnostic wire message types.
///
/// Corresponds to `kosong/contract/message.ts`.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        }
    }
}

impl From<&str> for Role {
    fn from(s: &str) -> Self {
        match s {
            "system" => Role::System,
            "user" => Role::User,
            "assistant" => Role::Assistant,
            "tool" => Role::Tool,
            _ => Role::User,
        }
    }
}

// ---------------------------------------------------------------------------
// ContentPart
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text {
        text: String,
    },
    #[serde(rename = "think")]
    Think {
        think: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted: Option<String>,
    },
    #[serde(rename = "image_url")]
    ImageUrl {
        #[serde(rename = "imageUrl")]
        image_url: ImageUrlValue,
    },
    #[serde(rename = "audio_url")]
    AudioUrl {
        #[serde(rename = "audioUrl")]
        audio_url: AudioUrlValue,
    },
    #[serde(rename = "video_url")]
    VideoUrl {
        #[serde(rename = "videoUrl")]
        video_url: VideoUrlValue,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImageUrlValue {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioUrlValue {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VideoUrlValue {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

// ---------------------------------------------------------------------------
// ToolCall
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    #[serde(rename = "type")]
    pub call_type: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extras: Option<HashMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub _stream_index: Option<Value>,
}

impl ToolCall {
    pub fn new(id: &str, name: &str, arguments: Option<String>) -> Self {
        Self {
            call_type: "function".to_string(),
            id: id.to_string(),
            name: name.to_string(),
            arguments,
            extras: None,
            _stream_index: None,
        }
    }
}

// ---------------------------------------------------------------------------
// ToolCallPart (streamed delta)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCallPart {
    #[serde(default)]
    pub arguments_part: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<Value>,
}

// ---------------------------------------------------------------------------
// StreamedMessagePart
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum StreamedMessagePart {
    Content(ContentPart),
    ToolCall(ToolCall),
    ToolCallPart(ToolCallPart),
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub content: Vec<ContentPart>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub partial: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<super::tool::Tool>>,
}

fn is_false(b: &bool) -> bool {
    !b
}

// ---------------------------------------------------------------------------
// ContentPart predicate helpers
// ---------------------------------------------------------------------------

pub fn is_content_part(part: &StreamedMessagePart) -> bool {
    matches!(part, StreamedMessagePart::Content(_))
}

pub fn is_tool_call(part: &StreamedMessagePart) -> bool {
    matches!(part, StreamedMessagePart::ToolCall(_))
}

pub fn is_tool_call_part(part: &StreamedMessagePart) -> bool {
    matches!(part, StreamedMessagePart::ToolCallPart(_))
}

pub fn is_tool_declaration_only_message(message: &Message) -> bool {
    message.tools.as_ref().map_or(false, |tools| !tools.is_empty())
        && message.content.is_empty()
        && message.tool_calls.is_empty()
}

// ---------------------------------------------------------------------------
// merge_in_place — streamed delta merge
// ---------------------------------------------------------------------------

/// Merge a streamed delta `source` into the pending `target` part.
/// Returns `true` when the merge was applied (caller keeps the target),
/// `false` when the source is a new part (caller must flush the target first).
pub fn merge_in_place(target: &mut StreamedMessagePart, source: &StreamedMessagePart) -> bool {
    match (target, source) {
        (StreamedMessagePart::Content(a), StreamedMessagePart::Content(b)) => match (a, b) {
            (ContentPart::Text { text: ta }, ContentPart::Text { text: sa }) => {
                ta.push_str(sa);
                true
            }
            (
                ContentPart::Think {
                    think: ta,
                    encrypted: ea,
                },
                ContentPart::Think {
                    think: sa,
                    encrypted: se,
                },
            ) => {
                if ea.is_some() {
                    return false;
                }
                ta.push_str(sa);
                if se.is_some() {
                    *ea = se.clone();
                }
                true
            }
            _ => false,
        },
        (StreamedMessagePart::ToolCall(tc), StreamedMessagePart::ToolCallPart(tcp)) => {
            if let Some(ref ap) = tcp.arguments_part {
                tc.arguments = match tc.arguments.take() {
                    Some(existing) => Some(existing + ap),
                    None => Some(ap.clone()),
                };
            }
            true
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// extract_text
// ---------------------------------------------------------------------------

pub fn extract_text(message: &Message, sep: &str) -> String {
    message
        .content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(sep)
}

pub fn get_text_content(message: &Message) -> String {
    extract_text(message, "")
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

pub fn create_user_message(content: &str) -> Message {
    Message {
        role: Role::User,
        content: vec![ContentPart::Text {
            text: content.to_string(),
        }],
        tool_calls: vec![],
        name: None,
        tool_call_id: None,
        partial: false,
        tools: None,
    }
}

pub fn create_assistant_message(content: Vec<ContentPart>, tool_calls: Vec<ToolCall>) -> Message {
    Message {
        role: Role::Assistant,
        content,
        tool_calls,
        name: None,
        tool_call_id: None,
        partial: false,
        tools: None,
    }
}

pub fn create_tool_message(tool_call_id: &str, output: &str) -> Message {
    Message {
        role: Role::Tool,
        content: vec![ContentPart::Text {
            text: output.to_string(),
        }],
        tool_calls: vec![],
        tool_call_id: Some(tool_call_id.to_string()),
        name: None,
        partial: false,
        tools: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kosong::contract::tool::Tool;

    #[test]
    fn test_merge_text_parts() {
        let mut target = StreamedMessagePart::Content(ContentPart::Text {
            text: "hello ".to_string(),
        });
        let source = StreamedMessagePart::Content(ContentPart::Text {
            text: "world".to_string(),
        });
        assert!(merge_in_place(&mut target, &source));
        match &target {
            StreamedMessagePart::Content(ContentPart::Text { text }) => {
                assert_eq!(text, "hello world");
            }
            _ => panic!("expected text part"),
        }
    }

    #[test]
    fn test_merge_think_parts() {
        let mut target = StreamedMessagePart::Content(ContentPart::Think {
            think: "let me ".to_string(),
            encrypted: None,
        });
        let source = StreamedMessagePart::Content(ContentPart::Think {
            think: "think".to_string(),
            encrypted: None,
        });
        assert!(merge_in_place(&mut target, &source));
        match &target {
            StreamedMessagePart::Content(ContentPart::Think { think, .. }) => {
                assert_eq!(think, "let me think");
            }
            _ => panic!("expected think part"),
        }
    }

    #[test]
    fn test_merge_encrypted_think_rejected() {
        let mut target = StreamedMessagePart::Content(ContentPart::Think {
            think: "a".to_string(),
            encrypted: Some("cipher".to_string()),
        });
        let source = StreamedMessagePart::Content(ContentPart::Think {
            think: "b".to_string(),
            encrypted: None,
        });
        // Can't merge into an encrypted think
        assert!(!merge_in_place(&mut target, &source));
    }

    #[test]
    fn test_merge_tool_call_delta() {
        let mut target = StreamedMessagePart::ToolCall(ToolCall::new("c1", "Read", None));
        let source = StreamedMessagePart::ToolCallPart(ToolCallPart {
            arguments_part: Some(r#"{"path":""#.to_string()),
            index: None,
        });
        assert!(merge_in_place(&mut target, &source));
        match &target {
            StreamedMessagePart::ToolCall(tc) => {
                assert_eq!(tc.arguments.as_deref(), Some(r#"{"path":""#));
            }
            _ => panic!("expected tool call"),
        }
    }

    #[test]
    fn test_extract_text() {
        let msg = Message {
            role: Role::Assistant,
            content: vec![
                ContentPart::Text {
                    text: "Hello ".to_string(),
                },
                ContentPart::Think {
                    think: "hmm".to_string(),
                    encrypted: None,
                },
                ContentPart::Text {
                    text: "world".to_string(),
                },
            ],
            tool_calls: vec![],
            name: None,
            tool_call_id: None,
            partial: false,
            tools: None,
        };
        assert_eq!(extract_text(&msg, ""), "Hello world");
    }

    #[test]
    fn test_tool_declaration_only() {
        let msg = Message {
            role: Role::Assistant,
            content: vec![],
            tool_calls: vec![],
            tools: Some(vec![Tool::new("read", "Read a file", serde_json::json!({}))]),
            name: None,
            tool_call_id: None,
            partial: false,
        };
        assert!(is_tool_declaration_only_message(&msg));

        let msg2 = Message {
            role: Role::Assistant,
            content: vec![ContentPart::Text {
                text: "hi".to_string(),
            }],
            tool_calls: vec![],
            tools: Some(vec![]),
            name: None,
            tool_call_id: None,
            partial: false,
        };
        assert!(!is_tool_declaration_only_message(&msg2));
    }

    #[test]
    fn test_create_user_message() {
        let msg = create_user_message("hello");
        assert_eq!(msg.role, Role::User);
        assert_eq!(get_text_content(&msg), "hello");
    }

    #[test]
    fn test_create_tool_message() {
        let msg = create_tool_message("c1", "result");
        assert_eq!(msg.role, Role::Tool);
        assert_eq!(msg.tool_call_id, Some("c1".to_string()));
        assert_eq!(get_text_content(&msg), "result");
    }
}