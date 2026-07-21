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
    'Then give your verdict. Your final message MUST end with exactly one of these on its own line:',
    `- "${VERDICT_PASS_MARKER}" — only if the objective and completion criterion are verifiably satisfied.`,
    `- "${VERDICT_FAIL_MARKER}: <specific reasons>" — if anything is missing, unverified, or failing. State concretely what is not done or not verified, so the worker can address it.`,
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
  // Explicit PASS, or no clear verdict at all. A missing verdict means the
  // verifier could not check (malfunction, non-verdict output) — fail open
  // rather than block completion indefinitely; the worker cannot influence the
  // independent verifier's output, so this cannot dodge an explicit FAIL.
  return { passed: true, feedback: '' };
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
}
