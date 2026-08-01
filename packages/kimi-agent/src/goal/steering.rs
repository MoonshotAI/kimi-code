//! Continuation steering for the standalone goal driver.
//!
//! GOAL.md: continuation input is rendered from the `continuation.md`
//! steering template — the Codex-derived prompt carrying the tuned
//! completion audit ("the audit must prove completion") and the 3-turn
//! blocked audit. The canonical template and renderer live in
//! `kimi-native-tools/src/goal/` (the production engine surfaced over
//! napi); this module embeds the SAME template file so the standalone
//! Rust agent speaks the identical contract without cross-crate linking.
//! Single source: the `include_str!` below points at the canonical file —
//! there is no second copy to drift.

use std::collections::HashMap;

/// The canonical continuation template (see module docs — single source).
const CONTINUATION_TEMPLATE: &str =
    include_str!("../../../kimi-native-tools/src/goal/templates/continuation.md");

/// Render the continuation prompt for an active goal, mirroring
/// `kimi-native-tools/src/goal/steering.rs::render_continuation`.
pub fn render_continuation(
    objective: &str,
    tokens_used: u64,
    token_budget: Option<u64>,
) -> String {
    let mut vars = HashMap::new();
    vars.insert("objective".to_string(), objective.to_string());
    vars.insert("tokens_used".to_string(), tokens_used.to_string());
    vars.insert(
        "token_budget".to_string(),
        token_budget.map_or_else(|| "unlimited".to_string(), |v| v.to_string()),
    );
    vars.insert(
        "remaining_tokens".to_string(),
        token_budget.map_or_else(
            || "unlimited".to_string(),
            |budget| budget.saturating_sub(tokens_used).to_string(),
        ),
    );
    render_template(CONTINUATION_TEMPLATE, &vars)
}

/// Step-cap notice prepended to the continuation prompt when the previous
/// goal turn ended by hitting the per-turn step limit (`max_steps_per_turn`).
/// Mirrors the upstream `GOAL_STEP_CAP_CONTINUATION_PROMPT` (agent-core
/// `agent/turn/index.ts`, #2210): the limit fragments goal work into more
/// continuation turns, and the notice tells the model why so it can size the
/// next slice to fit the limit.
const STEP_CAP_NOTICE: &str = "The previous goal turn reached the per-turn step limit before finishing its work, so a new turn was started for you. Pick up where that turn stopped and keep each slice of work small enough to fit the limit.";

/// Render the continuation prompt for a goal turn that ended at the per-turn
/// step limit: the step-cap notice followed by the standard continuation
/// steering (completion audit + blocked audit).
pub fn render_step_capped_continuation(
    objective: &str,
    tokens_used: u64,
    token_budget: Option<u64>,
) -> String {
    format!(
        "{STEP_CAP_NOTICE}\n\n{}",
        render_continuation(objective, tokens_used, token_budget)
    )
}

/// `{{ key }}` substitution with XML-escaping of values — the same engine
/// as the canonical steering module (Codex `ext/goal/src/steering.rs`).
fn render_template(template: &str, vars: &HashMap<String, String>) -> String {
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
                result.push_str(&format!("{{{{ {key} }}}}"));
            }
        } else {
            result.push_str(rest);
            break;
        }
    }
    result.push_str(rest);
    result
}

fn escape_xml(input: &str) -> String {
    input.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_carries_the_tuned_audits() {
        let text = render_continuation("fix the login bug", 500, Some(2000));
        assert!(text.contains("<objective>"));
        assert!(text.contains("fix the login bug"));
        // The tuned completion audit: proof, not absence of counter-evidence.
        assert!(text.contains("The audit must prove completion"));
        // The 3-turn blocked audit.
        assert!(text.contains("at least three consecutive goal turns"));
        // Budget lines.
        assert!(text.contains("Tokens used: 500"));
        assert!(text.contains("Tokens remaining: 1500"));
    }

    #[test]
    fn objective_is_escaped_as_untrusted_data() {
        let text = render_continuation("a < b & c > d", 0, None);
        assert!(text.contains("a &lt; b &amp; c &gt; d"));
        assert!(text.contains("Token budget: unlimited"));
    }

    #[test]
    fn step_capped_continuation_leads_with_the_step_cap_notice() {
        let text = render_step_capped_continuation("fix the login bug", 100, Some(2000));
        // The step-cap notice explains why a fresh turn was started...
        assert!(text.starts_with(
            "The previous goal turn reached the per-turn step limit before finishing its work"
        ));
        assert!(text.contains("Pick up where that turn stopped"));
        // ...and still carries the tuned completion audit.
        assert!(text.contains("The audit must prove completion"));
        assert!(text.contains("fix the login bug"));
    }

    #[test]
    fn step_capped_continuation_escapes_objective() {
        let text = render_step_capped_continuation("a < b", 0, None);
        assert!(text.contains("a &lt; b"));
    }
}
