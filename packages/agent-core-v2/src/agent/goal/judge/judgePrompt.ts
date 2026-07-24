/**
 * Goal Judge — prompt templates for independent goal-completion verification.
 *
 * When the agent calls `UpdateGoal('complete')`, the judge sends the conversation
 * transcript to the same model with a verdict schema. The judge must independently
 * confirm the goal is satisfied — it must not defer to the agent's self-assessment.
 */

export const JUDGE_SYSTEM_PROMPT = `You are an independent judge evaluating whether a goal has been completed.

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
- Do not invent evidence that is not in the transcript.`;

export function buildJudgeUserPrompt(
  objective: string,
  completionCriterion?: string,
): string {
  const lines: string[] = [
    '## Goal Objective',
    objective,
  ];

  if (completionCriterion) {
    lines.push(
      '',
      '## Completion Criterion',
      completionCriterion,
      '',
      '## Evaluation Instructions',
      'You MUST verify EACH condition in the completion criterion independently.',
      'For each condition, cite the specific transcript evidence (tool output, command result, file content) that proves it.',
      'If any condition lacks direct evidence, the goal is NOT complete.',
    );
  } else {
    lines.push(
      '',
      '## Evaluation Instructions',
      'No explicit completion criterion was provided. Judge whether the objective',
      'has been fully achieved based on the transcript evidence.',
    );
  }

  lines.push(
    '',
    '## Task',
    'Based on the conversation transcript above, produce your verdict as a single JSON object.',
  );

  return lines.join('\n');
}

/**
 * Build the prompt for the judge verification subagent.
 *
 * Unlike `buildJudgeUserPrompt` (which provides transcript context to an LLM),
 * this prompt instructs the judge subagent to independently execute commands
 * and verify the completion criterion from system state.
 */
export function buildJudgeVerificationPrompt(
  objective: string,
  completionCriterion?: string,
  cwd?: string,
): string {
  const lines: string[] = [
    '# Goal Verification Task',
    '',
    '## Objective',
    objective,
  ];

  if (completionCriterion) {
    lines.push(
      '',
      '## Completion Criterion',
      completionCriterion,
      '',
      '## Your Task',
      'Verify EACH condition in the completion criterion by executing commands.',
      'Do NOT trust any prior conversation — verify from scratch by reading files,',
      'running tests, or checking command outputs.',
    );
  } else {
    lines.push(
      '',
      '## Your Task',
      'No explicit completion criterion was provided.',
      'Verify the objective has been achieved by inspecting files and running commands.',
    );
  }

  if (cwd) {
    lines.push('', `Working directory: ${cwd}`);
  }

  lines.push(
    '',
    '## Instructions',
    '1. Determine what commands/reads would verify the criterion',
    '2. Execute them using your tools (Bash, Read, Grep)',
    '3. Based on ACTUAL outputs, produce your verdict',
    '4. Output your verdict as the LAST thing you write, as a JSON object:',
    '   {"ok": true, "reason": "..."}  or  {"ok": false, "reason": "..."}',
  );

  return lines.join('\n');
}
