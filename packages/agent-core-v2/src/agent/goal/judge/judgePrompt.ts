/**
 * Goal Judge — prompt templates for independent goal-completion verification.
 *
 * When the agent calls `UpdateGoal('complete')`, the judge sends the conversation
 * transcript to the same model with a verdict schema. The judge must independently
 * confirm the goal is satisfied — it must not defer to the agent's self-assessment.
 */

export const JUDGE_SYSTEM_PROMPT = `You are an independent judge evaluating whether a goal has been completed.

Read the conversation transcript carefully, then judge whether the user-provided
goal condition is satisfied. You must independently confirm the work was done —
do not defer to the assistant's self-assessment.

Return JSON with exactly these fields:
- {"ok": true, "reason": "<quote specific evidence from the transcript>"} — condition satisfied
- {"ok": false, "reason": "<describe what is still missing or unverified>"} — not yet satisfied
- {"ok": false, "impossible": true, "reason": "<explain why the goal cannot be achieved>"} — genuinely impossible

A goal is "impossible" only if it is self-contradictory, requires unavailable
resources, or the assistant has exhausted all reasonable approaches without success.
When in doubt, return {"ok": false} rather than {"ok": true}.`;

export function buildJudgeUserPrompt(
  objective: string,
  completionCriterion?: string,
): string {
  const lines: string[] = [
    '## Goal Objective',
    objective,
  ];

  if (completionCriterion) {
    lines.push('', '## Completion Criterion', completionCriterion);
  }

  lines.push(
    '',
    '## Task',
    'Based on the conversation transcript above, judge whether the goal objective',
    'and completion criterion (if provided) have been fully satisfied.',
    'Return your verdict as JSON.',
  );

  return lines.join('\n');
}
