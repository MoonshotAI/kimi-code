/// Notification XML rendering utilities.
///
/// Corresponds to `packages/agent-core/src/agent/context/notification-xml.ts`.

/// Render a background task notification as XML.
pub fn render_notification_xml(
    task_id: &str,
    status: &str,
    notification_id: &str,
    content: &str,
) -> String {
    format!(
        r#"<background_task task_id="{task_id}" notification_id="{notification_id}" status="{status}">
{content}
</background_task>"#
    )
}

/// Render a cron job fire notification as XML.
pub fn render_cron_notification_xml(
    job_id: &str,
    cron: &str,
    content: &str,
) -> String {
    format!(
        r#"<cron_job job_id="{job_id}" cron="{cron}">
{content}
</cron_job>"#
    )
}

/// Escape XML special characters.
pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Escape XML attribute value.
pub fn escape_xml_attr(text: &str) -> String {
    escape_xml(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_notification_xml() {
        let result = render_notification_xml("task-1", "completed", "notif-1", "Done");
        assert!(result.contains("task_id=\"task-1\""));
        assert!(result.contains("status=\"completed\""));
        assert!(result.contains("Done"));
    }

    #[test]
    fn test_escape_xml() {
        assert_eq!(escape_xml("<hello>"), "&lt;hello&gt;");
        assert_eq!(escape_xml("a & b"), "a &amp; b");
    }

    #[test]
    fn test_escape_xml_attr() {
        let result = escape_xml_attr("value with \"quotes\"");
        assert!(!result.contains('"'));
    }
}