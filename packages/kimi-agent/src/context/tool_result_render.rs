/// Tool result rendering for model consumption.
///
/// Corresponds to `packages/agent-core/src/agent/context/tool-result-render.ts`.

use crate::context::types::ContentPart;

/// Status markers for tool results.
pub const TOOL_ERROR_STATUS: &str = "<system>ERROR: Tool execution failed.</system>";
pub const TOOL_EMPTY_STATUS: &str = "<system>Tool output is empty.</system>";
pub const TOOL_EMPTY_ERROR_STATUS: &str =
    "<system>ERROR: Tool execution failed. Tool output is empty.</system>";

/// Input for rendering a tool result for the model.
pub struct RenderableToolResult {
    pub output: ToolResultOutput,
    pub note: Option<String>,
    pub is_error: bool,
}

/// Tool result output: either a plain string or content parts.
pub enum ToolResultOutput {
    Text(String),
    Parts(Vec<ContentPart>),
}

/// Render a tool result for model consumption.
/// Applies error status prefix, empty-output placeholder, and trailing note.
pub fn render_tool_result_for_model(result: RenderableToolResult) -> Vec<ContentPart> {
    let rendered = render_status(&result);
    match &result.note {
        Some(note) if !note.is_empty() => {
            // Append note as a trailing text part.
            let mut out = rendered;
            if let Some(first) = out.first() {
                if out.len() == 1 && matches!(first, ContentPart::Text { .. }) {
                    // Join note into the single text part.
                    if let ContentPart::Text { text } = first {
                        return vec![ContentPart::Text {
                            text: format!("{text}\n{note}"),
                        }];
                    }
                }
            }
            out.push(ContentPart::Text {
                text: note.clone(),
            });
            out
        }
        _ => rendered,
    }
}

fn render_status(result: &RenderableToolResult) -> Vec<ContentPart> {
    let single = match &result.output {
        ToolResultOutput::Text(s) => Some(s.clone()),
        ToolResultOutput::Parts(parts) => single_text_part(parts),
    };

    if let Some(text) = single {
        if result.is_error {
            if text.is_empty() {
                return vec![ContentPart::Text {
                    text: TOOL_EMPTY_ERROR_STATUS.to_string(),
                }];
            }
            return vec![ContentPart::Text {
                text: format!("{TOOL_ERROR_STATUS}\n{text}"),
            }];
        }
        if is_empty_output_text(&text) {
            return vec![ContentPart::Text {
                text: TOOL_EMPTY_STATUS.to_string(),
            }];
        }
        return vec![ContentPart::Text { text }];
    }

    // Content parts array
    let parts = match &result.output {
        ToolResultOutput::Parts(p) => p,
        _ => unreachable!(),
    };

    if is_empty_equivalent_content_array(parts) {
        return vec![ContentPart::Text {
            text: if result.is_error {
                TOOL_EMPTY_ERROR_STATUS.to_string()
            } else {
                TOOL_EMPTY_STATUS.to_string()
            },
        }];
    }

    if result.is_error {
        let mut out = vec![ContentPart::Text {
            text: TOOL_ERROR_STATUS.to_string(),
        }];
        out.extend(parts.iter().cloned());
        return out;
    }

    parts.clone()
}

fn single_text_part(parts: &[ContentPart]) -> Option<String> {
    if parts.len() == 1 {
        if let ContentPart::Text { text } = &parts[0] {
            return Some(text.clone());
        }
    }
    None
}

fn is_empty_output_text(text: &str) -> bool {
    text.trim().is_empty() || text.trim() == "Tool output is empty."
}

fn is_empty_equivalent_content_array(parts: &[ContentPart]) -> bool {
    parts.iter().all(|part| {
        if let ContentPart::Text { text } = part {
            text.trim().is_empty()
        } else {
            false
        }
    })
}