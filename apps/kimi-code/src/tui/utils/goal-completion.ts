import type { GoalSnapshot } from '@moonshot-ai/harness-core';

import { formatTokenCount } from '#/utils/usage/usage-format';

export function buildGoalCompletionMessage(goal: GoalSnapshot): string {
  const head = `✓ Goal complete${goal.terminalReason ? ` — ${goal.terminalReason}` : ''}.`;
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatGoalCompletionElapsed(goal.wallClockMs)}, using ${formatTokenCount(goal.tokensUsed)} tokens.`;
  return `${head}\n${stats}`;
}

function formatGoalCompletionElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}
