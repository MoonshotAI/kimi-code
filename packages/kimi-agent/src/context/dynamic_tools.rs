/// Dynamic tools context — select_tools progressive disclosure protocol filtering.
///
/// Corresponds to `packages/agent-core/src/agent/context/dynamic-tools.ts`.

use crate::context::types::{ContextMessage, MessageOrigin, ToolDefinition};

/// Origin variant of an injected dynamic tool schema message.
pub const DYNAMIC_TOOL_SCHEMA_VARIANT: &str = "dynamic_tool_schema";

/// Origin name of the loadable-tools diff announcements.
pub const LOADABLE_TOOLS_TRIGGER: &str = "loadable-tools";

/// Check if a message loads tool definitions.
pub fn is_dynamic_tool_schema_message(message: &ContextMessage) -> bool {
    message.tools.as_ref().is_some_and(|t| !t.is_empty())
}

/// Check if a message is a loadable-tools announcement.
pub fn is_loadable_tools_announcement(message: &ContextMessage) -> bool {
    matches!(
        message.origin,
        Some(MessageOrigin::SystemTrigger { ref name }) if name == LOADABLE_TOOLS_TRIGGER
    )
}

/// Strip dynamic tool context from a history slice.
/// Drops loadable-tools announcements and strips `tools` from schema messages.
pub fn strip_dynamic_tool_context(history: &[ContextMessage]) -> Vec<ContextMessage> {
    if !history.iter().any(|m| is_dynamic_tool_schema_message(m) || is_loadable_tools_announcement(m)) {
        return history.to_vec();
    }

    let mut out: Vec<ContextMessage> = Vec::with_capacity(history.len());
    for message in history {
        if is_loadable_tools_announcement(message) {
            continue;
        }
        if is_dynamic_tool_schema_message(message) {
            let mut m = message.clone();
            m.tools = None;
            if m.content.is_empty() && m.tool_calls.is_empty() {
                continue;
            }
            out.push(m);
            continue;
        }
        out.push(message.clone());
    }
    out
}

/// Collect loaded dynamic tool names from history.
pub fn collect_loaded_dynamic_tool_names(history: &[ContextMessage]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for message in history {
        if let Some(ref tools) = message.tools {
            for tool in tools {
                if !names.contains(&tool.name) {
                    names.push(tool.name.clone());
                }
            }
        }
    }
    names
}

/// Render a loadable-tools announcement.
pub fn render_loadable_tools_announcement(added: &[String], removed: &[String]) -> String {
    let mut sections: Vec<String> = Vec::new();

    if !added.is_empty() {
        sections.push(format!("<tools_added>\n{added}\n</tools_added>",
            added = added.join("\n")));
    }
    if !removed.is_empty() {
        sections.push(format!("<tools_removed>\n{removed}\n</tools_removed>",
            removed = removed.join("\n")));
    }
    sections.push(
        "Use the select_tools tool with exact names to load full tool definitions before calling them. \
         Names listed as removed are no longer loadable — do not select them. \
         Fold all announcements in this conversation in order to get the current list."
            .to_string(),
    );

    sections.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::types::ContentPart;

    fn make_msg(role: &str, text: &str) -> ContextMessage {
        ContextMessage {
            role: role.to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            tool_calls: vec![],
            ..Default::default()
        }
    }

    #[test]
    fn test_is_dynamic_tool_schema_message() {
        let mut msg = make_msg("user", "hello");
        assert!(!is_dynamic_tool_schema_message(&msg));

        msg.tools = Some(vec![ToolDefinition {
            name: "read".into(),
            description: "Read a file".into(),
            input_schema: None,
        }]);
        assert!(is_dynamic_tool_schema_message(&msg));
    }

    #[test]
    fn test_is_loadable_tools_announcement() {
        let mut msg = make_msg("user", "announcement");
        assert!(!is_loadable_tools_announcement(&msg));

        msg.origin = Some(MessageOrigin::SystemTrigger {
            name: LOADABLE_TOOLS_TRIGGER.into(),
        });
        assert!(is_loadable_tools_announcement(&msg));
    }

    #[test]
    fn test_strip_dynamic_tool_context_noop() {
        let history = vec![make_msg("user", "hello"), make_msg("assistant", "world")];
        let result = strip_dynamic_tool_context(&history);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_strip_dynamic_tool_context_removes_announcements() {
        let mut announcement = make_msg("user", "tools added");
        announcement.origin = Some(MessageOrigin::SystemTrigger {
            name: LOADABLE_TOOLS_TRIGGER.into(),
        });

        let history = vec![announcement, make_msg("user", "hello")];
        let result = strip_dynamic_tool_context(&history);
        assert_eq!(result.len(), 1);
        assert!(
            if let ContentPart::Text { text } = &result[0].content[0] {
                text == "hello"
            } else {
                false
            }
        );
    }

    #[test]
    fn test_collect_loaded_dynamic_tool_names() {
        let mut msg = make_msg("user", "");
        msg.tools = Some(vec![
            ToolDefinition { name: "read".into(), description: "".into(), input_schema: None },
            ToolDefinition { name: "write".into(), description: "".into(), input_schema: None },
        ]);
        let names = collect_loaded_dynamic_tool_names(&[msg]);
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"read".to_string()));
        assert!(names.contains(&"write".to_string()));
    }

    #[test]
    fn test_render_loadable_tools_announcement() {
        let added = vec!["read".to_string(), "write".to_string()];
        let removed = vec!["edit".to_string()];
        let result = render_loadable_tools_announcement(&added, &removed);
        assert!(result.contains("tools_added"));
        assert!(result.contains("tools_removed"));
        assert!(result.contains("select_tools"));
    }
}