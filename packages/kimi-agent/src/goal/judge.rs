/// Goal judge — independent goal-completion verification.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/goal/judge/judgePrompt.ts` plus the
/// verdict parsing from `judge/goalJudgeService.ts`.
///
/// When the agent calls `UpdateGoal('complete')`, the judge either re-reads
/// the transcript (LLM path) or independently executes commands (subagent
/// path) and returns a JSON verdict. It must not defer to the agent's
/// self-assessment — "the assistant said it was done" is not evidence.
///
/// The subagent run, its timeout, and the retry request stay with the host;
/// this module owns the prompts (verbatim) and the verdict extraction.

/// The judge's system prompt, verbatim from `JUDGE_SYSTEM_PROMPT`.
pub const JUDGE_SYSTEM_PROMPT: &str = r#"You are an independent judge evaluating whether a goal has been completed.

Your role is to verify — with concrete evidence — that the stated goal and its
completion criterion have been fully satisfied. You are NOT the assistant; you
must NOT defer to the assistant's self-assessment.

## Evaluation Framework

1. **Decompose** the completion criterion into individual checkable conditions.
2. **For each condition**, search the transcript for DIRECT evidence:
   - Command outputs (exit codes, stdout/stderr)
   - File contents shown in tool results
   - Test results (pass/fail counts)
   - Explicit confirmations from tool execution
3. **Classify evidence**:
   - DIRECT: a tool result or command output that unambiguously proves the condition
   - INFERRED: the condition is likely met based on context but not explicitly shown
   - MISSING: no evidence found in the transcript
4. **Verdict rules**:
   - ALL conditions have DIRECT evidence → {"ok": true}
   - Any condition has only INFERRED or MISSING evidence → {"ok": false}
   - Goal is self-contradictory or impossible → {"ok": false, "impossible": true}

## Output Format

Return ONLY a JSON object (no markdown fences, no extra text):

{"ok": true, "reason": "Each condition verified: (1) ... [evidence: ...], (2) ... [evidence: ...]"}

or

{"ok": false, "reason": "Condition X not verified: expected ... but transcript shows ..."}

or

{"ok": false, "impossible": true, "reason": "Goal cannot be achieved because ..."}

## Important

- "The assistant said it was done" is NOT evidence. Look for tool outputs.
- When in doubt, return {"ok": false}.
- A partially completed goal is NOT complete.
- Do not invent evidence that is not in the transcript."#;

/// The simplified retry system prompt used when the first response could not
/// be parsed.
pub const RETRY_SYSTEM_PROMPT: &str = r#"You are a judge. Return ONLY a JSON object with fields "ok" (boolean) and "reason" (string). No other text."#;

/// The judge subagent's timeout, mirroring `JUDGE_SUBAGENT_TIMEOUT_MS`.
pub const JUDGE_SUBAGENT_TIMEOUT_MS: u64 = 60_000;

/// Build the transcript-evaluation user prompt (`buildJudgeUserPrompt`).
pub fn build_judge_user_prompt(objective: &str, completion_criterion: Option<&str>) -> String {
    let mut lines: Vec<String> = vec!["## Goal Objective".to_string(), objective.to_string()];

    match completion_criterion.filter(|criterion| !criterion.is_empty()) {
        Some(criterion) => {
            lines.extend([
                String::new(),
                "## Completion Criterion".to_string(),
                criterion.to_string(),
                String::new(),
                "## Evaluation Instructions".to_string(),
                "You MUST verify EACH condition in the completion criterion independently."
                    .to_string(),
                "For each condition, cite the specific transcript evidence (tool output, command result, file content) that proves it."
                    .to_string(),
                "If any condition lacks direct evidence, the goal is NOT complete.".to_string(),
            ]);
        }
        None => {
            lines.extend([
                String::new(),
                "## Evaluation Instructions".to_string(),
                "No explicit completion criterion was provided. Judge whether the objective"
                    .to_string(),
                "has been fully achieved based on the transcript evidence.".to_string(),
            ]);
        }
    }

    lines.extend([
        String::new(),
        "## Task".to_string(),
        "Based on the conversation transcript above, produce your verdict as a single JSON object."
            .to_string(),
    ]);

    lines.join("\n")
}

/// Build the verification-subagent prompt (`buildJudgeVerificationPrompt`).
///
/// Unlike the transcript prompt, this instructs the judge subagent to verify
/// from system state — reading files and running commands, trusting nothing
/// from the prior conversation.
pub fn build_judge_verification_prompt(
    objective: &str,
    completion_criterion: Option<&str>,
    cwd: Option<&str>,
) -> String {
    let mut lines: Vec<String> = vec![
        "# Goal Verification Task".to_string(),
        String::new(),
        "## Objective".to_string(),
        objective.to_string(),
    ];

    match completion_criterion.filter(|criterion| !criterion.is_empty()) {
        Some(criterion) => {
            lines.extend([
                String::new(),
                "## Completion Criterion".to_string(),
                criterion.to_string(),
                String::new(),
                "## Your Task".to_string(),
                "Verify EACH condition in the completion criterion by executing commands."
                    .to_string(),
                "Do NOT trust any prior conversation — verify from scratch by reading files,"
                    .to_string(),
                "running tests, or checking command outputs.".to_string(),
            ]);
        }
        None => {
            lines.extend([
                String::new(),
                "## Your Task".to_string(),
                "No explicit completion criterion was provided.".to_string(),
                "Verify the objective has been achieved by inspecting files and running commands."
                    .to_string(),
            ]);
        }
    }

    if let Some(cwd) = cwd {
        lines.push(String::new());
        lines.push(format!("Working directory: {cwd}"));
    }

    lines.extend([
        String::new(),
        "## Instructions".to_string(),
        "1. Determine what commands/reads would verify the criterion".to_string(),
        "2. Execute them using your tools (Bash, Read, Grep)".to_string(),
        "3. Based on ACTUAL outputs, produce your verdict".to_string(),
        "4. Output your verdict as the LAST thing you write, as a JSON object:".to_string(),
        "   {\"ok\": true, \"reason\": \"...\"}  or  {\"ok\": false, \"reason\": \"...\"}"
            .to_string(),
    ]);

    lines.join("\n")
}

/// The judge's verdict (TS `JudgeVerdict`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgeVerdict {
    pub ok: bool,
    /// Set only when the goal itself is impossible; implies `ok == false`.
    pub impossible: bool,
    pub reason: String,
}

/// Validate one candidate JSON string (TS `tryParseVerdictJson`).
///
/// Contradictory verdicts are normalised rather than rejected: `impossible`
/// forces `ok` to false.
fn try_parse_verdict_json(raw: &str) -> Option<JudgeVerdict> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let ok = parsed.get("ok")?.as_bool()?;
    let reason = parsed.get("reason")?.as_str()?.to_string();
    let impossible = parsed.get("impossible").and_then(|value| value.as_bool()) == Some(true);
    Some(JudgeVerdict { ok: if impossible { false } else { ok }, impossible, reason })
}

/// Extract candidate JSON substrings by scanning for balanced braces,
/// string-aware so a `reason` containing braces does not break the scan.
fn extract_json_candidates(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut candidates = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escape = false;
        let mut end = None;
        for (j, &byte) in bytes.iter().enumerate().skip(i) {
            if escape {
                escape = false;
                continue;
            }
            match byte {
                b'\\' if in_string => escape = true,
                b'"' => in_string = !in_string,
                b'{' if !in_string => depth += 1,
                b'}' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        match end {
            Some(end) => {
                candidates.push(&text[i..=end]);
                i = end + 1;
            }
            None => break,
        }
    }
    candidates
}

/// Parse the judge's response into a verdict (TS `parseVerdict`).
///
/// Three strategies, in order: a direct parse, a markdown code fence, then
/// balanced-brace candidates scanned **backwards** — when the model adds
/// commentary, the last valid JSON object is most likely the verdict.
pub fn parse_judge_verdict(text: &str) -> Option<JudgeVerdict> {
    if let Some(verdict) = try_parse_verdict_json(text.trim()) {
        return Some(verdict);
    }
    if let Some(fenced) = extract_code_fence(text) {
        if let Some(verdict) = try_parse_verdict_json(fenced.trim()) {
            return Some(verdict);
        }
    }
    for candidate in extract_json_candidates(text).into_iter().rev() {
        if let Some(verdict) = try_parse_verdict_json(candidate) {
            return Some(verdict);
        }
    }
    None
}

/// TS: `/```(?:json)?\s*\n?([\s\S]*?)\n?```/` — the first fenced block.
fn extract_code_fence(text: &str) -> Option<&str> {
    let open = text.find("```")?;
    let after_marker = &text[open + 3..];
    // Skip an optional `json` language tag and following whitespace.
    let body_start = after_marker
        .strip_prefix("json")
        .unwrap_or(after_marker)
        .trim_start_matches([' ', '\t'])
        .trim_start_matches('\n');
    let close = body_start.find("```")?;
    Some(body_start[..close].trim_end_matches('\n'))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── prompts ───────────────────────────────────────────────────────────

    #[test]
    fn the_system_prompt_is_the_ts_text() {
        assert!(JUDGE_SYSTEM_PROMPT.starts_with(
            "You are an independent judge evaluating whether a goal has been completed."
        ));
        assert!(JUDGE_SYSTEM_PROMPT.contains("\"The assistant said it was done\" is NOT evidence."));
        assert!(JUDGE_SYSTEM_PROMPT.ends_with("Do not invent evidence that is not in the transcript."));
    }

    #[test]
    fn the_user_prompt_with_a_criterion_demands_per_condition_evidence() {
        let prompt = build_judge_user_prompt("ship the feature", Some("tests pass"));
        assert!(prompt.starts_with("## Goal Objective\nship the feature"));
        assert!(prompt.contains("## Completion Criterion\ntests pass"));
        assert!(prompt.contains("You MUST verify EACH condition"));
        assert!(prompt.ends_with("produce your verdict as a single JSON object."));
    }

    #[test]
    fn the_user_prompt_without_a_criterion_judges_the_objective() {
        let prompt = build_judge_user_prompt("ship it", None);
        assert!(!prompt.contains("## Completion Criterion"));
        assert!(prompt.contains("No explicit completion criterion was provided."));
        // An empty string counts as absent, matching the TS truthiness check.
        assert_eq!(build_judge_user_prompt("ship it", Some("")), prompt);
    }

    #[test]
    fn the_verification_prompt_verifies_from_scratch() {
        let prompt =
            build_judge_verification_prompt("ship it", Some("tests pass"), Some("/repo"));
        assert!(prompt.starts_with("# Goal Verification Task"));
        assert!(prompt.contains("Do NOT trust any prior conversation"));
        assert!(prompt.contains("Working directory: /repo"));
        assert!(prompt.contains("Execute them using your tools (Bash, Read, Grep)"));
    }

    #[test]
    fn the_verification_prompt_omits_the_cwd_when_unknown() {
        let prompt = build_judge_verification_prompt("ship it", None, None);
        assert!(!prompt.contains("Working directory:"));
        assert!(prompt.contains("No explicit completion criterion was provided."));
    }

    // ── verdict parsing ───────────────────────────────────────────────────

    #[test]
    fn a_pure_json_verdict_parses_directly() {
        let verdict = parse_judge_verdict(r#"{"ok": true, "reason": "all verified"}"#).unwrap();
        assert!(verdict.ok);
        assert!(!verdict.impossible);
        assert_eq!(verdict.reason, "all verified");
    }

    #[test]
    fn a_fenced_verdict_parses() {
        let text = "Here is my verdict:\n```json\n{\"ok\": false, \"reason\": \"tests fail\"}\n```";
        let verdict = parse_judge_verdict(text).unwrap();
        assert!(!verdict.ok);
        assert_eq!(verdict.reason, "tests fail");
    }

    #[test]
    fn a_fence_without_a_language_tag_parses() {
        let text = "```\n{\"ok\": true, \"reason\": \"done\"}\n```";
        assert!(parse_judge_verdict(text).unwrap().ok);
    }

    #[test]
    fn commentary_before_the_verdict_takes_the_last_json() {
        let text = concat!(
            "I checked {\"ok\": false, \"reason\": \"draft\"} first but then confirmed.\n",
            "Final: {\"ok\": true, \"reason\": \"verified\"}"
        );
        let verdict = parse_judge_verdict(text).unwrap();
        assert!(verdict.ok);
        assert_eq!(verdict.reason, "verified");
    }

    #[test]
    fn braces_inside_the_reason_do_not_break_extraction() {
        let text = r#"verdict: {"ok": false, "reason": "expected {a: 1} but saw {a: 2}"}"#;
        let verdict = parse_judge_verdict(text).unwrap();
        assert_eq!(verdict.reason, "expected {a: 1} but saw {a: 2}");
    }

    #[test]
    fn an_impossible_verdict_forces_not_ok() {
        // Contradictory input: ok=true with impossible=true → normalised.
        let text = r#"{"ok": true, "impossible": true, "reason": "cannot be done"}"#;
        let verdict = parse_judge_verdict(text).unwrap();
        assert!(!verdict.ok);
        assert!(verdict.impossible);
    }

    #[test]
    fn missing_fields_fail_the_parse() {
        assert!(parse_judge_verdict(r#"{"ok": true}"#).is_none(), "no reason");
        assert!(parse_judge_verdict(r#"{"reason": "x"}"#).is_none(), "no ok");
        assert!(parse_judge_verdict(r#"{"ok": "yes", "reason": "x"}"#).is_none(), "ok not bool");
        assert!(parse_judge_verdict("no json at all").is_none());
        assert!(parse_judge_verdict("").is_none());
    }

    #[test]
    fn an_unterminated_object_is_not_a_candidate() {
        assert!(parse_judge_verdict(r#"{"ok": true, "reason": "trunca"#).is_none());
    }

    #[test]
    fn the_retry_prompt_matches_ts() {
        assert_eq!(
            RETRY_SYSTEM_PROMPT,
            "You are a judge. Return ONLY a JSON object with fields \"ok\" (boolean) and \"reason\" (string). No other text."
        );
    }
}
