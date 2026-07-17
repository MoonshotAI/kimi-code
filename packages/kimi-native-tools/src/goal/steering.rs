//! Steering prompt rendering — renders goal templates with variable substitution.
//!
//! Based on Codex `ext/goal/src/steering.rs`.
//!
//! Templates use `{{ variable }}` syntax. Variables are escaped for XML safety
//! before substitution.

use std::collections::HashMap;

/// Simple template engine: replaces `{{ key }}` placeholders with values.
/// Escapes `&`, `<`, `>` in values before substitution.
pub fn render_template(template: &str, vars: &HashMap<String, String>) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find("{{ ") {
        result.push_str(&rest[..start]);
        rest = &rest[start + 3..];

        if let Some(end) = rest.find(" }}") {
            let key = rest[..end].trim();
            rest = &rest[end + 3..];

            if let Some(value) = vars.get(key) {
                result.push_str(&escape_xml(value));
            } else {
                // Keep the placeholder if variable not found
                result.push_str(&format!("{{{{ {} }}}}", key));
            }
        } else {
            // Unterminated placeholder — keep the rest as-is
            result.push_str(&rest);
            break;
        }
    }

    result.push_str(rest);
    result
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

// ---------------------------------------------------------------------------
// Embedded templates
// ---------------------------------------------------------------------------

const CONTINUATION_TEMPLATE: &str = include_str!("templates/continuation.md");
const BUDGET_LIMIT_TEMPLATE: &str = include_str!("templates/budget_limit.md");
const OBJECTIVE_UPDATED_TEMPLATE: &str = include_str!("templates/objective_updated.md");

// ---------------------------------------------------------------------------
// Public rendering API
// ---------------------------------------------------------------------------

/// Build variables map from goal fields and render the continuation prompt.
pub fn render_continuation(
    objective: &str,
    tokens_used: i64,
    token_budget: Option<i64>,
) -> String {
    let vars = vars_map_owned(objective, tokens_used, token_budget);
    render_template(CONTINUATION_TEMPLATE, &vars)
}

/// Render the budget-limit wrap-up prompt.
pub fn render_budget_limit(
    objective: &str,
    tokens_used: i64,
    token_budget: Option<i64>,
    time_used_seconds: i64,
) -> String {
    let mut vars = vars_map_owned(objective, tokens_used, token_budget);
    vars.insert("time_used_seconds".to_string(), time_used_seconds.to_string());
    render_template(BUDGET_LIMIT_TEMPLATE, &vars)
}

/// Render the objective-updated prompt.
pub fn render_objective_updated(
    objective: &str,
    tokens_used: i64,
    token_budget: Option<i64>,
) -> String {
    let vars = vars_map_owned(objective, tokens_used, token_budget);
    render_template(OBJECTIVE_UPDATED_TEMPLATE, &vars)
}

fn vars_map_owned(
    objective: &str,
    tokens_used: i64,
    token_budget: Option<i64>,
) -> HashMap<String, String> {
    let tokens_used_str = tokens_used.to_string();
    let (budget_str, remaining_str) = match token_budget {
        Some(budget) => {
            let remaining = (budget - tokens_used).max(0);
            (budget.to_string(), remaining.to_string())
        }
        None => ("none".to_string(), "unbounded".to_string()),
    };

    let mut vars = HashMap::new();
    vars.insert("objective".to_string(), objective.to_string());
    vars.insert("tokens_used".to_string(), tokens_used_str);
    vars.insert("token_budget".to_string(), budget_str);
    vars.insert("remaining_tokens".to_string(), remaining_str);
    vars
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_continuation() {
        let result = render_continuation("fix the login bug", 500, Some(2000));
        assert!(result.contains("fix the login bug"));
        assert!(result.contains("500"));
        assert!(result.contains("2000"));
        assert!(result.contains("1500")); // remaining
        assert!(result.contains("Blocked audit"));
        assert!(result.contains("three consecutive goal turns"));
    }

    #[test]
    fn test_render_budget_limit() {
        let result = render_budget_limit("fix the login bug", 2000, Some(2000), 120);
        assert!(result.contains("budget_limited"));
        assert!(result.contains("120 seconds"));
        assert!(result.contains("2000"));
    }

    #[test]
    fn test_render_objective_updated() {
        let result = render_objective_updated("new objective", 100, Some(1000));
        assert!(result.contains("new objective"));
        assert!(result.contains("900")); // remaining
        assert!(result.contains("untrusted_objective"));
    }

    #[test]
    fn test_no_budget() {
        let result = render_continuation("test", 0, None);
        assert!(result.contains("none"));
        assert!(result.contains("unbounded"));
    }

    #[test]
    fn test_xml_escaping() {
        let result = render_continuation("a < b & c > d", 0, None);
        assert!(result.contains("a &lt; b &amp; c &gt; d"));
    }

    #[test]
    fn test_template_engine() {
        let tmpl = "Hello {{ name }}, you have {{ count }} messages.";
        let mut vars = std::collections::HashMap::new();
        vars.insert("name".to_string(), "Alice".to_string());
        vars.insert("count".to_string(), "3".to_string());
        assert_eq!(render_template(tmpl, &vars), "Hello Alice, you have 3 messages.");
    }

    #[test]
    fn test_template_engine_missing_var() {
        let tmpl = "Hello {{ name }}, {{ missing }} end.";
        let mut vars = std::collections::HashMap::new();
        vars.insert("name".to_string(), "Alice".to_string());
        // missing not provided — should keep placeholder
        let result = render_template(tmpl, &vars);
        assert_eq!(result, "Hello Alice, {{ missing }} end.");
    }
}
