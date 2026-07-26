/// `task` domain — terminal notification rendering.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/task/notificationXml.ts` plus the
/// notification helpers in `taskService.ts`
/// (`buildAgentTaskNotificationBody`, `agentTaskNotificationChildren`,
/// `renderOutputFileBlock`, `renderOutputPreviewBlock`, `notificationKey`).
///
/// The opening tag name and attribute set are load-bearing for notification
/// consumers, and `agent_id` stays separate from `source_id` because subagent
/// resume ids and task ids live in different namespaces.
use crate::task::types::{TaskInfoBase, TaskOutputSnapshot, TaskStatus};

/// Preview budget used when no persisted output log is available.
pub const NOTIFICATION_FALLBACK_PREVIEW_BYTES: usize = 3_000;

/// The English rendering of `t('toolsV2.abort.abortedByUser')`.
///
/// The TS side resolves this through i18n, so a non-English host records a
/// localised stop reason. Callers that care should pass their own locale's
/// string to [`build_agent_task_notification_body`].
pub const DEFAULT_USER_CANCELLATION_MESSAGE: &str = "Aborted by the user";

/// Escape a value for use in element content: `&`, `<`, `>`, `"`.
pub fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Escape a value for use in a double-quoted attribute: `&` and `"` only.
///
/// Deliberately narrower than [`escape_xml`] — TS keeps `<` and `>` literal in
/// attribute values, and widening it here would change the rendered bytes.
pub fn escape_xml_attr(input: &str) -> String {
    input.replace('&', "&amp;").replace('"', "&quot;")
}

/// Identity of one terminal notification, used to suppress re-delivery.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TaskNotificationOrigin {
    pub task_id: String,
    pub status: TaskStatus,
    pub notification_id: String,
}

impl TaskNotificationOrigin {
    pub fn new(task_id: &str, status: TaskStatus) -> Self {
        Self {
            task_id: task_id.to_string(),
            status,
            notification_id: notification_id(task_id, status),
        }
    }

    pub fn key(&self) -> String {
        format!("{}\0{}\0{}", self.task_id, self.status.as_str(), self.notification_id)
    }
}

pub fn notification_id(task_id: &str, status: TaskStatus) -> String {
    format!("task:{}:{}", task_id, status.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotificationSeverity {
    Info,
    Warning,
}

impl NotificationSeverity {
    pub fn as_str(&self) -> &'static str {
        match self {
            NotificationSeverity::Info => "info",
            NotificationSeverity::Warning => "warning",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskNotification {
    pub id: String,
    pub category: String,
    pub notification_type: String,
    pub source_kind: String,
    pub source_id: String,
    pub agent_id: Option<String>,
    pub title: String,
    pub severity: NotificationSeverity,
    pub body: String,
    pub children: Vec<String>,
}

/// Render the model-visible `<notification …>` block.
///
/// Attribute values fall back to `unknown` when empty, matching TS's
/// `stringAttr`. Title / severity / body are *not* escaped — TS emits them
/// verbatim, and escaping them here would change what the model reads.
pub fn render_notification_xml(notification: &TaskNotification) -> String {
    let id = attr_or_unknown(&notification.id);
    let category = attr_or_unknown(&notification.category);
    let notification_type = attr_or_unknown(&notification.notification_type);
    let source_kind = attr_or_unknown(&notification.source_kind);
    let source_id = attr_or_unknown(&notification.source_id);
    let agent_id_attr = notification
        .agent_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|value| format!(" agent_id=\"{}\"", escape_xml_attr(value)))
        .unwrap_or_default();

    let mut lines = vec![format!(
        "<notification id=\"{id}\" category=\"{category}\" type=\"{notification_type}\" source_kind=\"{source_kind}\" source_id=\"{source_id}\"{agent_id_attr}>"
    )];
    if !notification.title.is_empty() {
        lines.push(format!("Title: {}", notification.title));
    }
    lines.push(format!("Severity: {}", notification.severity.as_str()));
    if !notification.body.is_empty() {
        lines.push(notification.body.clone());
    }
    lines.extend(notification.children.iter().filter(|c| !c.is_empty()).cloned());
    lines.push("</notification>".to_string());
    lines.join("\n")
}

fn attr_or_unknown(value: &str) -> String {
    if value.is_empty() {
        return "unknown".to_string();
    }
    escape_xml_attr(value)
}

/// The `<output-*>` child blocks attached to a terminal notification.
///
/// A persisted log wins: pointing the model at the file beats inlining a
/// preview it would have to re-fetch anyway.
pub fn notification_children(output: &TaskOutputSnapshot) -> Vec<String> {
    if output.full_output_available {
        if let Some(path) = output.output_path.as_deref() {
            return vec![render_output_file_block(path, output.output_size_bytes)];
        }
    }
    if output.preview.is_empty() {
        return Vec::new();
    }
    vec![render_output_preview_block(output)]
}

pub fn render_output_file_block(output_path: &str, output_size_bytes: usize) -> String {
    format!(
        "<output-file path=\"{}\" bytes=\"{}\">\nRead the output file to retrieve the result: {}\n</output-file>",
        escape_xml_attr(output_path),
        output_size_bytes,
        escape_xml(output_path)
    )
}

pub fn render_output_preview_block(output: &TaskOutputSnapshot) -> String {
    let note = if output.truncated {
        format!(
            "Showing the last {} bytes. No persisted full output is available.",
            output.preview_bytes
        )
    } else {
        "No persisted full output is available; this preview is the currently buffered task output."
            .to_string()
    };
    format!(
        "<output-preview bytes=\"{}\" total_bytes=\"{}\" truncated=\"{}\">\n{}\n{}\n</output-preview>",
        output.preview_bytes,
        output.output_size_bytes,
        output.truncated,
        note,
        escape_xml(&output.preview)
    )
}

/// Build the human-readable notification body for a settled task.
///
/// A failed *subagent* additionally gets resume instructions, because the work
/// is recoverable and the model otherwise has no way to know the agent id it
/// must pass back.
pub fn build_agent_task_notification_body(
    info: &TaskInfoBase,
    user_cancellation_message: &str,
) -> String {
    let description = &info.description;
    let base_line = match info.status {
        TaskStatus::TimedOut => format!("{description} timed out."),
        TaskStatus::Killed
            if info.stop_reason.as_deref() == Some(user_cancellation_message) =>
        {
            format!("{description} was stopped by user.")
        }
        status => match info.stop_reason.as_deref() {
            Some(reason) if !reason.is_empty() => {
                let verb = if status == TaskStatus::Killed { "was stopped" } else { status.as_str() };
                format!("{description} {verb}. Reason: {reason}")
            }
            _ => format!("{description} {}.", status.as_str()),
        },
    };

    if info.kind != "agent" || info.status == TaskStatus::Completed {
        return base_line;
    }
    // `agent_id == task_id` means the adapter never assigned a distinct
    // resumable id, so there is nothing useful to tell the model.
    let Some(agent_id) = info.agent_id.as_deref().filter(|id| *id != info.task_id) else {
        return base_line;
    };

    let recovery = [
        String::new(),
        format!(
            "To recover or continue this subagent, call Agent(resume=\"{agent_id}\", prompt=\"Pick up where you left off; redo the last tool call if its result was never observed.\")."
        ),
        format!(
            "Use agent_id (\"{agent_id}\"), NOT source_id / task_id (\"{}\") — the two look alike but only agent_id is accepted by the resume parameter.",
            info.task_id
        ),
        "Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.".to_string(),
        "The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.".to_string(),
    ]
    .join("\n");

    format!("{base_line}{recovery}")
}

/// Assemble the full notification for a settled task.
pub fn build_task_notification(
    info: &TaskInfoBase,
    output: &TaskOutputSnapshot,
    user_cancellation_message: &str,
) -> TaskNotification {
    TaskNotification {
        id: notification_id(&info.task_id, info.status),
        category: "task".to_string(),
        notification_type: format!("task.{}", info.status.as_str()),
        source_kind: "background_task".to_string(),
        source_id: info.task_id.clone(),
        agent_id: if info.kind == "agent" { info.agent_id.clone() } else { None },
        title: format!("Background {} {}", info.kind, info.status.as_str()),
        severity: if info.status == TaskStatus::Completed {
            NotificationSeverity::Info
        } else {
            NotificationSeverity::Warning
        },
        body: build_agent_task_notification_body(info, user_cancellation_message),
        children: notification_children(output),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(status: TaskStatus, kind: &str) -> TaskInfoBase {
        TaskInfoBase {
            task_id: "process-abc12345".to_string(),
            description: "npm test".to_string(),
            status,
            kind: kind.to_string(),
            started_at: 1_000,
            ended_at: Some(2_000),
            detached: true,
            stop_reason: None,
            terminal_notification_suppressed: false,
            timeout_ms: None,
            agent_id: None,
        }
    }

    fn snapshot(preview: &str, truncated: bool) -> TaskOutputSnapshot {
        TaskOutputSnapshot {
            output_path: None,
            output_size_bytes: preview.len(),
            preview_bytes: preview.len(),
            truncated,
            full_output_available: false,
            preview: preview.to_string(),
        }
    }

    // ── escaping ──────────────────────────────────────────────────────────

    #[test]
    fn escape_xml_covers_all_four_entities() {
        assert_eq!(escape_xml("a&b<c>d\"e"), "a&amp;b&lt;c&gt;d&quot;e");
    }

    #[test]
    fn escape_xml_attr_leaves_angle_brackets_alone() {
        // Narrower than escape_xml on purpose — widening it changes the bytes
        // the TS renderer produces.
        assert_eq!(escape_xml_attr("a&b<c>d\"e"), "a&amp;b<c>d&quot;e");
    }

    // ── keys ──────────────────────────────────────────────────────────────

    #[test]
    fn notification_id_encodes_task_and_status() {
        assert_eq!(notification_id("t1", TaskStatus::TimedOut), "task:t1:timed_out");
    }

    #[test]
    fn notification_key_is_nul_separated() {
        let origin = TaskNotificationOrigin::new("t1", TaskStatus::Failed);
        assert_eq!(origin.key(), "t1\0failed\0task:t1:failed");
    }

    #[test]
    fn notification_keys_differ_per_status() {
        let a = TaskNotificationOrigin::new("t1", TaskStatus::Completed).key();
        let b = TaskNotificationOrigin::new("t1", TaskStatus::Failed).key();
        assert_ne!(a, b);
    }

    // ── XML ───────────────────────────────────────────────────────────────

    #[test]
    fn renders_the_opening_tag_with_every_attribute() {
        let notification = build_task_notification(
            &info(TaskStatus::Completed, "process"),
            &TaskOutputSnapshot::empty(),
            DEFAULT_USER_CANCELLATION_MESSAGE,
        );
        let xml = render_notification_xml(&notification);
        assert!(xml.starts_with(
            "<notification id=\"task:process-abc12345:completed\" category=\"task\" type=\"task.completed\" source_kind=\"background_task\" source_id=\"process-abc12345\">"
        ));
        assert!(xml.ends_with("</notification>"));
        assert!(xml.contains("Title: Background process completed"));
        assert!(xml.contains("Severity: info"));
        assert!(!xml.contains("agent_id="), "non-agent tasks carry no agent_id");
    }

    #[test]
    fn renders_agent_id_only_for_agent_tasks() {
        let mut agent = info(TaskStatus::Failed, "agent");
        agent.agent_id = Some("agent-xyz".to_string());
        let notification = build_task_notification(
            &agent,
            &TaskOutputSnapshot::empty(),
            DEFAULT_USER_CANCELLATION_MESSAGE,
        );
        let xml = render_notification_xml(&notification);
        assert!(xml.contains(" agent_id=\"agent-xyz\">"));
        assert!(xml.contains("Severity: warning"));
    }

    #[test]
    fn empty_attributes_fall_back_to_unknown() {
        let notification = TaskNotification {
            id: String::new(),
            category: String::new(),
            notification_type: String::new(),
            source_kind: String::new(),
            source_id: String::new(),
            agent_id: Some(String::new()),
            title: String::new(),
            severity: NotificationSeverity::Info,
            body: String::new(),
            children: vec![],
        };
        let xml = render_notification_xml(&notification);
        assert_eq!(
            xml,
            "<notification id=\"unknown\" category=\"unknown\" type=\"unknown\" source_kind=\"unknown\" source_id=\"unknown\">\nSeverity: info\n</notification>"
        );
    }

    #[test]
    fn attributes_are_escaped_but_body_is_not() {
        let notification = TaskNotification {
            id: "a&b".to_string(),
            category: "task".to_string(),
            notification_type: "task.failed".to_string(),
            source_kind: "background_task".to_string(),
            source_id: "s\"q".to_string(),
            agent_id: None,
            title: "t".to_string(),
            severity: NotificationSeverity::Warning,
            body: "body with <tags> & \"quotes\"".to_string(),
            children: vec![],
        };
        let xml = render_notification_xml(&notification);
        assert!(xml.contains("id=\"a&amp;b\""));
        assert!(xml.contains("source_id=\"s&quot;q\""));
        assert!(xml.contains("body with <tags> & \"quotes\""), "body is verbatim");
    }

    #[test]
    fn children_are_appended_before_the_closing_tag() {
        let notification = build_task_notification(
            &info(TaskStatus::Completed, "process"),
            &snapshot("some output", false),
            DEFAULT_USER_CANCELLATION_MESSAGE,
        );
        let xml = render_notification_xml(&notification);
        let preview_at = xml.find("<output-preview").expect("preview block present");
        let close_at = xml.find("</notification>").expect("closing tag present");
        assert!(preview_at < close_at);
    }

    // ── output blocks ─────────────────────────────────────────────────────

    #[test]
    fn a_persisted_log_wins_over_a_preview() {
        let output = TaskOutputSnapshot {
            output_path: Some("/logs/task.log".to_string()),
            output_size_bytes: 4096,
            preview_bytes: 10,
            truncated: true,
            full_output_available: true,
            preview: "ignored".to_string(),
        };
        let children = notification_children(&output);
        assert_eq!(children.len(), 1);
        assert!(children[0].starts_with("<output-file path=\"/logs/task.log\" bytes=\"4096\">"));
        assert!(children[0].contains("Read the output file to retrieve the result: /logs/task.log"));
    }

    #[test]
    fn no_output_yields_no_children() {
        assert!(notification_children(&TaskOutputSnapshot::empty()).is_empty());
    }

    #[test]
    fn a_truncated_preview_says_how_much_it_shows() {
        let mut output = snapshot("tail bytes", true);
        output.output_size_bytes = 9_999;
        let children = notification_children(&output);
        assert!(children[0].contains("truncated=\"true\""));
        assert!(children[0].contains("Showing the last 10 bytes."));
        assert!(children[0].contains("total_bytes=\"9999\""));
    }

    #[test]
    fn an_untruncated_preview_says_it_is_the_buffer() {
        let children = notification_children(&snapshot("all of it", false));
        assert!(children[0].contains("truncated=\"false\""));
        assert!(children[0].contains("this preview is the currently buffered task output"));
    }

    #[test]
    fn preview_content_is_escaped() {
        let children = notification_children(&snapshot("<script>&</script>", false));
        assert!(children[0].contains("&lt;script&gt;&amp;&lt;/script&gt;"));
    }

    // ── bodies ────────────────────────────────────────────────────────────

    #[test]
    fn body_for_a_plain_completion() {
        let body = build_agent_task_notification_body(
            &info(TaskStatus::Completed, "process"),
            DEFAULT_USER_CANCELLATION_MESSAGE,
        );
        assert_eq!(body, "npm test completed.");
    }

    #[test]
    fn body_for_a_timeout_ignores_the_stop_reason() {
        let mut timed_out = info(TaskStatus::TimedOut, "process");
        timed_out.stop_reason = Some("Timed out".to_string());
        let body =
            build_agent_task_notification_body(&timed_out, DEFAULT_USER_CANCELLATION_MESSAGE);
        assert_eq!(body, "npm test timed out.");
    }

    #[test]
    fn body_for_a_user_stop_is_phrased_specially() {
        let mut killed = info(TaskStatus::Killed, "process");
        killed.stop_reason = Some(DEFAULT_USER_CANCELLATION_MESSAGE.to_string());
        let body = build_agent_task_notification_body(&killed, DEFAULT_USER_CANCELLATION_MESSAGE);
        assert_eq!(body, "npm test was stopped by user.");
    }

    #[test]
    fn body_for_a_user_stop_respects_a_localised_message() {
        let mut killed = info(TaskStatus::Killed, "process");
        killed.stop_reason = Some("已被用户中止".to_string());
        let body = build_agent_task_notification_body(&killed, "已被用户中止");
        assert_eq!(body, "npm test was stopped by user.");
        // …and under a different locale the same reason reads as a plain stop.
        let other =
            build_agent_task_notification_body(&killed, DEFAULT_USER_CANCELLATION_MESSAGE);
        assert_eq!(other, "npm test was stopped. Reason: 已被用户中止");
    }

    #[test]
    fn body_for_a_kill_with_a_reason() {
        let mut killed = info(TaskStatus::Killed, "process");
        killed.stop_reason = Some("output limit".to_string());
        let body = build_agent_task_notification_body(&killed, DEFAULT_USER_CANCELLATION_MESSAGE);
        assert_eq!(body, "npm test was stopped. Reason: output limit");
    }

    #[test]
    fn body_for_a_failure_with_a_reason() {
        let mut failed = info(TaskStatus::Failed, "process");
        failed.stop_reason = Some("exit 1".to_string());
        let body = build_agent_task_notification_body(&failed, DEFAULT_USER_CANCELLATION_MESSAGE);
        assert_eq!(body, "npm test failed. Reason: exit 1");
    }

    #[test]
    fn a_failed_subagent_gets_resume_instructions() {
        let mut agent = info(TaskStatus::Failed, "agent");
        agent.agent_id = Some("agent-xyz".to_string());
        let body = build_agent_task_notification_body(&agent, DEFAULT_USER_CANCELLATION_MESSAGE);
        assert!(body.starts_with("npm test failed."));
        assert!(body.contains("Agent(resume=\"agent-xyz\""));
        assert!(body.contains("NOT source_id / task_id (\"process-abc12345\")"));
        assert!(body.contains("run_in_background=true"));
    }

    #[test]
    fn a_completed_subagent_gets_no_resume_instructions() {
        let mut agent = info(TaskStatus::Completed, "agent");
        agent.agent_id = Some("agent-xyz".to_string());
        let body = build_agent_task_notification_body(&agent, DEFAULT_USER_CANCELLATION_MESSAGE);
        assert_eq!(body, "npm test completed.");
    }

    #[test]
    fn a_subagent_without_a_distinct_id_gets_no_resume_instructions() {
        let mut agent = info(TaskStatus::Failed, "agent");
        agent.agent_id = None;
        assert!(!build_agent_task_notification_body(&agent, DEFAULT_USER_CANCELLATION_MESSAGE)
            .contains("resume"));

        agent.agent_id = Some(agent.task_id.clone());
        assert!(!build_agent_task_notification_body(&agent, DEFAULT_USER_CANCELLATION_MESSAGE)
            .contains("resume"));
    }

    #[test]
    fn severity_is_info_only_for_completion() {
        for status in [TaskStatus::Failed, TaskStatus::Killed, TaskStatus::TimedOut, TaskStatus::Lost]
        {
            let notification = build_task_notification(
                &info(status, "process"),
                &TaskOutputSnapshot::empty(),
                DEFAULT_USER_CANCELLATION_MESSAGE,
            );
            assert_eq!(notification.severity, NotificationSeverity::Warning, "{status:?}");
        }
        let done = build_task_notification(
            &info(TaskStatus::Completed, "process"),
            &TaskOutputSnapshot::empty(),
            DEFAULT_USER_CANCELLATION_MESSAGE,
        );
        assert_eq!(done.severity, NotificationSeverity::Info);
    }
}
