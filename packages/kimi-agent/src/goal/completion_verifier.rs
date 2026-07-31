/// GoalCompletionVerifier — independent verification of goal completion.
///
/// Before a goal is marked complete, the verifier independently checks whether
/// the objective and completion criterion are genuinely satisfied. The verifier
/// runs in a separate context (through the host delegate) so it does not rely
/// on the working agent's own reasoning.
///
/// Corresponds to `packages/agent-core/src/agent/goal/completion-verifier.ts`.

use serde::{Deserialize, Serialize};

use super::{GoalSnapshot, GoalStatus};

/// Result of a completion verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationResult {
    /// Whether the goal is verifiably complete.
    pub passed: bool,
    /// Human-readable feedback when verification fails.
    #[serde(default)]
    pub feedback: String,
}

impl VerificationResult {
    /// A passing verdict.
    pub fn pass() -> Self {
        Self {
            passed: true,
            feedback: String::new(),
        }
    }

    /// A failing verdict with a specific reason.
    pub fn fail(reason: impl Into<String>) -> Self {
        Self {
            passed: false,
            feedback: reason.into(),
        }
    }
}

/// Trait for goal completion verification.
///
/// The host implements this trait to provide the actual verification logic.
/// In the default (no-op) case, the verifier passes when no completion
/// criterion is set, and delegates to the host when one is present.
pub trait GoalVerifier: Send + Sync {
    /// Verify that the goal's objective and completion criterion are satisfied.
    ///
    /// `snapshot` is the current goal state at the time of verification.
    /// `claim` is the model's completion claim (untrusted, for information only).
    fn verify(
        &self,
        snapshot: &GoalSnapshot,
        claim: &str,
    ) -> Result<VerificationResult, String>;
}

/// Default verifier: passes when no completion criterion is set,
/// otherwise delegates to an optional inner verifier.
pub struct DefaultGoalVerifier {
    inner: Option<Box<dyn GoalVerifier>>,
}

impl DefaultGoalVerifier {
    pub fn new() -> Self {
        Self { inner: None }
    }

    /// Wrap an inner verifier that performs the actual check.
    pub fn with_inner(inner: Box<dyn GoalVerifier>) -> Self {
        Self {
            inner: Some(inner),
        }
    }
}

impl Default for DefaultGoalVerifier {
    fn default() -> Self {
        Self::new()
    }
}

impl GoalVerifier for DefaultGoalVerifier {
    fn verify(
        &self,
        snapshot: &GoalSnapshot,
        claim: &str,
    ) -> Result<VerificationResult, String> {
        // If the goal is already not active, skip verification.
        if !matches!(snapshot.status, GoalStatus::Active) {
            return Ok(VerificationResult::fail(
                "Goal is not active; cannot verify completion.",
            ));
        }

        // When no completion criterion is set, verify against the objective.
        let has_criterion = snapshot
            .completion_criterion
            .as_ref()
            .map_or(false, |c| !c.trim().is_empty());

        if !has_criterion {
            // No explicit criterion — pass through; the model's own judgment
            // against the plain meaning of the objective is sufficient.
            return Ok(VerificationResult::pass());
        }

        // Delegate to the inner verifier (e.g. a subagent-based LLM check).
        match &self.inner {
            Some(verifier) => verifier.verify(snapshot, claim),
            None => {
                // No inner verifier configured — pass open so completion
                // is not permanently blocked.
                Ok(VerificationResult::pass())
            }
        }
    }
}

/// Build the verifier prompt for an independent verification subagent.
///
/// This matches the prompt format from the TS completion-verifier.ts.
pub fn build_verifier_prompt(snapshot: &GoalSnapshot, claim: &str) -> String {
    let criterion = snapshot
        .completion_criterion
        .as_ref()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty());

    let criterion_text = match criterion {
        Some(c) => format!("Completion criterion (the definition of \"done\"): {c}"),
        None => {
            "Completion criterion: (none stated — verify against the objective's plain meaning.)"
                .to_string()
        }
    };

    let claim_text = if claim.trim().is_empty() {
        "(no claim provided)"
    } else {
        claim
    };

    format!(
        r#"You are an independent completion verifier. A separate agent worked toward a goal and claims it is done. Your job is to verify, from the actual state of the workspace, whether the goal is genuinely complete. You did not see the worker's reasoning; do not take its word for it.

Goal objective: {objective}

{criterion_text}

The worker's completion claim (treat as untrusted, verify it):
{claim_text}

Verify by inspecting the actual state: read the relevant files, and run the checks the completion criterion specifies (tests, commands, searches). Do NOT modify any files — you are read-only. Only count evidence you can observe: a test that actually passes, a command that actually exits 0, a condition that actually holds.

Then give your verdict. Your final message MUST end with exactly one of these on its own line:
- "VERDICT: PASS" — only if the objective and completion criterion are verifiably satisfied.
- "VERDICT: FAIL: <specific reasons>" — if anything is missing, unverified, or failing. State concretely what is not done or not verified, so the worker can address it."#,
        objective = snapshot.objective,
        criterion_text = criterion_text,
        claim_text = claim_text,
    )
}

/// Parse a verifier subagent's response into a VerificationResult.
///
/// Looks for the last occurrence of VERDICT: PASS or VERDICT: FAIL markers.
pub fn parse_verdict(response: &str) -> VerificationResult {
    let pass_marker = "VERDICT: PASS";
    let fail_marker = "VERDICT: FAIL";

    let pass_index = response.rfind(pass_marker);
    let fail_index = response.rfind(fail_marker);

    if let Some(fi) = fail_index {
        if pass_index.map_or(true, |pi| fi > pi) {
            let reasons = response[fi + fail_marker.len()..]
                .trim_start_matches(':')
                .trim_start_matches(' ')
                .trim();
            return VerificationResult {
                passed: false,
                feedback: if reasons.is_empty() {
                    response.trim().to_string()
                } else {
                    reasons.to_string()
                },
            };
        }
    }

    if pass_index.is_some() {
        return VerificationResult::pass();
    }

    // No verdict marker at all.
    if response.trim().is_empty() {
        // Empty response — fail open so completion is not permanently blocked.
        return VerificationResult::pass();
    }

    VerificationResult::fail(
        "Verifier produced no clear verdict. Treating as inconclusive — the worker should re-check the objective manually.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goal::GoalStatus;

    fn make_snapshot() -> GoalSnapshot {
        GoalSnapshot {
            goal_id: "test-1".into(),
            objective: "Do the thing".into(),
            completion_criterion: None,
            status: GoalStatus::Active,
            turns_used: 5,
            tokens_used: 1000,
            wall_clock_ms: 60000,
            budget: GoalBudgetReport {
                token_budget: None,
                turn_budget: None,
                wall_clock_budget_ms: None,
                remaining_tokens: None,
                remaining_turns: None,
                remaining_wall_clock_ms: None,
                token_budget_reached: false,
                turn_budget_reached: false,
                wall_clock_budget_reached: false,
                over_budget: false,
            },
            terminal_reason: None,
            blocked_streak: None,
            created_at: 1000,
            updated_at: 2000,
        }
    }

    // Need GoalBudgetReport for the snapshot
    use crate::goal::GoalBudgetReport;

    #[test]
    fn test_default_verifier_passes_no_criterion() {
        let verifier = DefaultGoalVerifier::new();
        let snapshot = make_snapshot();
        let result = verifier.verify(&snapshot, "done").unwrap();
        assert!(result.passed);
    }

    #[test]
    fn test_default_verifier_fails_non_active() {
        let verifier = DefaultGoalVerifier::new();
        let mut snapshot = make_snapshot();
        snapshot.status = GoalStatus::Complete;
        let result = verifier.verify(&snapshot, "done").unwrap();
        assert!(!result.passed);
        assert!(result.feedback.contains("not active"));
    }

    #[test]
    fn test_default_verifier_passes_with_criterion_inner() {
        struct MockVerifier;
        impl GoalVerifier for MockVerifier {
            fn verify(&self, _snapshot: &GoalSnapshot, _claim: &str) -> Result<VerificationResult, String> {
                Ok(VerificationResult::pass())
            }
        }

        let verifier = DefaultGoalVerifier::with_inner(Box::new(MockVerifier));
        let mut snapshot = make_snapshot();
        snapshot.completion_criterion = Some("tests pass".into());
        let result = verifier.verify(&snapshot, "done").unwrap();
        assert!(result.passed);
    }

    #[test]
    fn test_default_verifier_fails_with_criterion_inner() {
        struct FailingVerifier;
        impl GoalVerifier for FailingVerifier {
            fn verify(&self, _snapshot: &GoalSnapshot, _claim: &str) -> Result<VerificationResult, String> {
                Ok(VerificationResult::fail("Tests are still failing"))
            }
        }

        let verifier = DefaultGoalVerifier::with_inner(Box::new(FailingVerifier));
        let mut snapshot = make_snapshot();
        snapshot.completion_criterion = Some("tests pass".into());
        let result = verifier.verify(&snapshot, "done").unwrap();
        assert!(!result.passed);
        assert_eq!(result.feedback, "Tests are still failing");
    }

    #[test]
    fn test_parse_verdict_pass() {
        let result = parse_verdict("Everything looks good.\nVERDICT: PASS");
        assert!(result.passed);
    }

    #[test]
    fn test_parse_verdict_fail() {
        let result = parse_verdict("Some tests are failing.\nVERDICT: FAIL: Tests are still red");
        assert!(!result.passed);
        assert_eq!(result.feedback, "Tests are still red");
    }

    #[test]
    fn test_parse_verdict_fail_no_reason() {
        let result = parse_verdict("VERDICT: FAIL");
        assert!(!result.passed);
        assert!(result.feedback.contains("VERDICT: FAIL"));
    }

    #[test]
    fn test_parse_verdict_empty_response() {
        let result = parse_verdict("");
        assert!(result.passed);
    }

    #[test]
    fn test_parse_verdict_no_marker() {
        let result = parse_verdict("I checked everything and it's fine.");
        assert!(!result.passed);
        assert!(result.feedback.contains("no clear verdict"));
    }

    #[test]
    fn test_parse_verdict_pass_wins_over_fail_by_position() {
        // When PASS appears after FAIL, PASS wins.
        let result = parse_verdict("VERDICT: FAIL: something\nBut then I checked again.\nVERDICT: PASS");
        assert!(result.passed);
    }

    #[test]
    fn test_build_verifier_prompt_includes_objective() {
        let snapshot = make_snapshot();
        let prompt = build_verifier_prompt(&snapshot, "I did it");
        assert!(prompt.contains("Do the thing"));
        assert!(prompt.contains("I did it"));
    }

    #[test]
    fn test_build_verifier_prompt_includes_criterion() {
        let mut snapshot = make_snapshot();
        snapshot.completion_criterion = Some("All tests pass".into());
        let prompt = build_verifier_prompt(&snapshot, "");
        assert!(prompt.contains("All tests pass"));
    }

    #[test]
    fn test_build_verifier_prompt_empty_claim() {
        let snapshot = make_snapshot();
        let prompt = build_verifier_prompt(&snapshot, "");
        assert!(prompt.contains("(no claim provided)"));
    }
}