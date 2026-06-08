import type { GoalSnapshot } from '../../session/goal';

export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion';

/**
 * The deterministic goal-completion message. It is built from the final
 * snapshot — not the model — so the figures (turns / tokens / time) are
 * guaranteed exact.
 */
export function buildGoalCompletionMessage(goal: GoalSnapshot): string {
  const head = `✓ Goal complete${goal.terminalReason ? ` — ${goal.terminalReason}` : ''}.`;
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatElapsed(goal.wallClockMs)}, using ${formatTokens(goal.tokensUsed)} tokens.`;
  return `${head}\n${stats}`;
}

export function buildGoalCompletionSummaryPrompt(goal: GoalSnapshot): string {
  return [
    buildGoalCompletionMessage(goal),
    '',
    'Now summarize how you completed the goal for the user. Mention the main work completed and any validation you ran. Do not call more goal tools.',
  ].join('\n');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
