import type { PromptOrigin } from '@moonshot-ai/agent-core/history/index';

export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

export const MAX_GOAL_COMPLETION_CRITERION_LENGTH = MAX_GOAL_OBJECTIVE_LENGTH;

export interface GoalContinuationOrigin extends PromptOrigin {
  readonly name: 'goal_continuation';
}

export const GOAL_CONTINUATION_ORIGIN: GoalContinuationOrigin = {
  kind: 'system_trigger',
  name: 'goal_continuation',
};

export function isGoalContinuationOrigin(origin: PromptOrigin | undefined): boolean {
  return (
    origin?.kind === 'system_trigger' &&
    (origin as { readonly name?: unknown }).name === GOAL_CONTINUATION_ORIGIN.name
  );
}

export const GOAL_REMIND_KEY = 'goal';

export const GOAL_CANCELLED_REMINDER_NAME = 'goal_cancelled';

export const GOAL_CANCELLED_REMINDER = [
  'The user cancelled the current goal.',
  'Ignore earlier active-goal reminders for that goal.',
  'Handle the next user request normally unless the user starts or resumes a goal.',
].join(' ');

export const GOAL_BUDGET_STOP_REMINDER_NAME = 'goal_budget_stop';

export const GOAL_BUDGET_STOP_REMINDER = [
  "The goal's hard budget was reached and the goal is now blocked; the user can resume it with /goal resume.",
  'Stop immediately.',
  'Do not call any more tools: they will be rejected.',
  'Write a brief final status message summarizing the progress so far.',
].join(' ');

export const GOAL_BUDGET_TOOLS_REJECTED_MESSAGE =
  'Goal budget exhausted; tool calls are rejected. Write your final message.';

export const GOAL_STALE_TOOL_RESULT =
  'Goal changed since this turn started; ignored stale goal tool call.';

export const GOAL_MAIN_AGENT_ONLY = 'Goal tools are only supported by the main agent.';

export const GOAL_RATE_LIMIT_PAUSE_REASON = 'Paused after provider rate limit';
export const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = 'Paused after provider connection error';
export const GOAL_PROVIDER_API_PAUSE_PREFIX = 'Paused after provider API error';
export const GOAL_RUNTIME_PAUSE_PREFIX = 'Paused after runtime error';
export const GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX = 'Paused after goal continuation failure';
export const GOAL_BUDGET_BLOCK_PREFIX = 'Blocked after goal budget reached';

export const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far, choose one bounded, useful slice of work, and use the existing',
  'conversation context and your tools. Do not try to finish a broad goal in one turn unless the',
  'whole goal is genuinely small. Most goal turns should not call UpdateGoal: after completing a',
  'useful slice, if material work remains, end the turn normally without calling UpdateGoal so',
  'the runtime can continue the goal in the next turn. Call UpdateGoal with `complete` only when',
  'all required work is done, any stated validation has passed, and there is no useful next',
  'action. Completion audit: before calling `complete`, verify the current state against the',
  'actual objective and every explicit requirement. Treat weak or indirect evidence as not',
  'complete. Do not mark complete after only producing a plan, summary, first pass, or partial',
  'result. Do not mark complete merely because a budget is nearly exhausted or you want to stop.',
  'Blocked audit: do not call UpdateGoal with `blocked` the first time you hit a blocker. Use',
  '`blocked` only for a genuine impasse: an external condition, required user input, missing',
  'credentials or permissions, or a persistent technical failure. For those non-terminal',
  'blockers, the same blocking condition must repeat for at least 3 consecutive goal turns before',
  'you call `blocked`, counting the original/user-triggered turn and automatic continuations.',
  'If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit.',
  'Exception: if the objective itself is impossible, unsafe, or contradictory, call UpdateGoal',
  'with `blocked` in the same turn; do not run more goal turns just to satisfy the audit. Do not',
  'use `blocked` because the work is large, hard, slow, uncertain, incomplete, still needs',
  'validation, would benefit from clarification, or needs more goal turns. Once the 3-turn',
  'threshold is met and you cannot make meaningful progress without user input or an',
  'external-state change, call UpdateGoal with `blocked`; do not keep reporting the blocker while',
  'leaving the goal active. Do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

export const GOAL_STEP_CAP_CONTINUATION_PROMPT = [
  'The previous goal turn reached the per-turn step limit before finishing its work,',
  'so a new turn was started for you. Pick up where that turn stopped and keep each',
  'slice of work small enough to fit the limit.',
  GOAL_CONTINUATION_PROMPT,
].join(' ');
