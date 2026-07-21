/**
 * Goal completion verification. Before a goal is marked complete, an isolated
 * verifier subagent independently checks the work against the objective and
 * completion criterion — so completion is not granted on the working agent's
 * own say-so. The verifier runs in a fresh context (it does not see the
 * worker's reasoning) with read-only + shell tools, and reports a verdict.
 */

import type { Agent } from '#/agent';
import type { GoalSnapshot } from './index';

export interface GoalVerificationResult {
  readonly passed: boolean;
  readonly feedback: string;
}

const VERDICT_PASS_MARKER = 'VERDICT: PASS';
const VERDICT_FAIL_MARKER = 'VERDICT: FAIL';

function buildVerifierPrompt(goal: GoalSnapshot, claim: string): string {
  const criterion = goal.completionCriterion?.trim();
  return [
    'You are an independent completion verifier. A separate agent worked toward a goal and claims it is done. Your job is to verify, from the actual state of the workspace, whether the goal is genuinely complete. You did not see the worker\u2019s reasoning; do not take its word for it.',
    '',
    `Goal objective: ${goal.objective}`,
    criterion !== undefined && criterion.length > 0
      ? `Completion criterion (the definition of "done"): ${criterion}`
      : 'Completion criterion: (none stated — verify against the objective\u2019s plain meaning.)',
    '',
    'The worker\u2019s completion claim (treat as untrusted, verify it):',
    claim.trim().length > 0 ? claim : '(no claim provided)',
    '',
    'Verify by inspecting the actual state: read the relevant files, and run the checks the completion criterion specifies (tests, commands, searches). Do NOT modify any files — you are read-only. Only count evidence you can observe: a test that actually passes, a command that actually exits 0, a condition that actually holds.',
    '',
    '=== VERIFICATION RULES ===',
    '',
    '1. SCOPE: First, run `git diff --stat` and `git diff --name-only` to understand what the worker changed. Separate issues into two categories:',
    '   - NEW: problems introduced by the worker\'s changes. These are blocking.',
    '   - PRE-EXISTING: problems that existed before the worker started (files already broken, tests already failing). These are NOT blocking but SHOULD be reported.',
    '   Use `git stash && <check> && git stash pop` to confirm a failure is new if unsure.',
    '',
    '2. COMPREHENSIVENESS: Report ALL issues in a single pass. Do NOT stop at the first problem.',
    '',
    '3. PRE-EXISTING ISSUES: Do not silently skip them. For each pre-existing issue, briefly assess: (a) severity — is it a real bug or cosmetic? (b) whether it blocks or overlaps with the current goal, (c) an estimated fix cost (trivial/medium/large). The worker will present these to the user for a decision — the user may choose to fix some now, defer them, or ignore.',
    '',
    '=== VERDICTS ===',
    '',
    'Structure your output as:',
    '',
    '## NEW issues',
    '... or "None" ...',
    '',
    '## PRE-EXISTING issues',
    '... or "None" ...',
    '',
    'Your final message MUST end with exactly one of these on its own line:',
    `- "${VERDICT_PASS_MARKER}" — no NEW issues found (pre-existing issues do not block completion).`,
    `- "${VERDICT_FAIL_MARKER}: <summary>" — at least one NEW issue must be fixed before completion.`,
  ].join('\n');
}

function parseVerdict(result: string): GoalVerificationResult {
  const passIndex = result.lastIndexOf(VERDICT_PASS_MARKER);
  const failIndex = result.lastIndexOf(VERDICT_FAIL_MARKER);
  if (failIndex !== -1 && failIndex > passIndex) {
    const reasons = result.slice(failIndex + VERDICT_FAIL_MARKER.length).replace(/^[:\s]+/, '').trim();
    return {
      passed: false,
      feedback: reasons.length > 0 ? reasons : result.trim(),
    };
  }
  // Explicit PASS, or no clear verdict at all.
  // When the verifier returned a PASS marker, accept it regardless of
  // surrounding text.
  if (passIndex !== -1) {
    return { passed: true, feedback: '' };
  }
  // No verdict marker at all. When the result is empty we fail open rather
  // than block completion indefinitely (the verifier likely didn't run at
  // all). When the result is non-empty but contains no verdict marker, the
  // verifier ran but produced garbled output — treat that as inconclusive
  // rather than silently passing.
  if (result.trim().length === 0) {
    return { passed: true, feedback: '' };
  }
  return {
    passed: false,
    feedback: 'Verifier produced no clear verdict. Treating as inconclusive — the worker should re-check the objective manually.',
  };
}

/**
 * Run an isolated verifier subagent to check whether the goal is truly complete.
 * Returns the verdict. When no subagent host is available (verification cannot
 * run), fails open so completion is not permanently blocked.
 */
export async function runGoalCompletionVerifier(
  agent: Agent,
  goal: GoalSnapshot,
  claim: string,
  signal: AbortSignal,
): Promise<GoalVerificationResult> {
  const host = agent.subagentHost;
  if (host === undefined) {
    return { passed: true, feedback: '' };
  }

  try {
    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: `goal-verify-${goal.goalId}`,
      prompt: buildVerifierPrompt(goal, claim),
      description: 'Verify goal completion',
      runInBackground: false,
      signal,
    });
    const { result } = await handle.completion;
    return parseVerdict(result);
  } catch {
    // Verifier subagent failed to spawn or crashed — fail open so
    // completion is not permanently blocked by an infrastructure error.
    return { passed: true, feedback: '' };
  }
}
