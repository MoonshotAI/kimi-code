import type { GoalSnapshot } from '../../../agent/goal';

export function buildGoalCompletionSummaryPrompt(goal: GoalSnapshot): string {
  return [
    buildGoalCompletionPromptMessage(goal),
    '',
    'Write a concise final message for the user. State that the goal is complete, summarize the main work completed, and mention any validation you ran. Do not call more goal tools.',
  ].join('\n');
}

export function buildGoalBlockedReasonPrompt(goal: GoalSnapshot): string {
  return [
    buildGoalBlockedMessage(goal),
    '',
    'Write a concise final message for the user. State that the goal is blocked, explain the concrete blocker, and say what input or change is needed before work can continue. Do not call more goal tools.',
  ].join('\n');
}

function buildGoalCompletionPromptMessage(goal: GoalSnapshot): string {
  const head = `Goal completed successfully${goal.terminalReason ? `: ${goal.terminalReason}` : ''}.`;
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatElapsed(goal.wallClockMs)}, using ${formatTokens(goal.tokensUsed)} tokens.`;
  return `${head}\n${stats}`;
}

function buildGoalBlockedMessage(goal: GoalSnapshot): string {
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatElapsed(goal.wallClockMs)}, using ${formatTokens(goal.tokensUsed)} tokens.`;
  return `Goal blocked.\n${stats}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${(minutes % 60).toString().padStart(2, '0')}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
