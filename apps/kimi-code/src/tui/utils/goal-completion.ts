import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { formatTokenCount } from '#/utils/usage/usage-format';

interface GoalCompletionStats {
  readonly terminalReason?: string | undefined;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

/**
 * Deterministic goal-completion text rendered by the TUI when the model marks a
 * goal `complete`. It is built from the final snapshot, so the figures
 * (turns / tokens / time) are exact and do not depend on model prose.
 */
export function buildGoalCompletionMessage(goal: GoalSnapshot): string {
  return buildGoalCompletionMessageFromStats(goal);
}

export function buildGoalCompletionMessageFromStats(goal: GoalCompletionStats): string {
  const head = t('tui.messages.goalComplete', {
    reason: goal.terminalReason ? ` — ${goal.terminalReason}` : '',
  });
  const turns = t('tui.messages.goalCompleteTurns', {
    count: goal.turnsUsed,
    plural: goal.turnsUsed === 1 ? '' : 's',
  });
  const stats = t('tui.messages.goalCompleteSummary', {
    turns,
    elapsed: formatElapsed(goal.wallClockMs),
    tokens: formatTokenCount(goal.tokensUsed),
  });
  return `${head}\n${stats}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return t('tui.messages.goalFormat.elapsedSeconds', { count: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return t('tui.messages.goalFormat.elapsedMinutes', { minutes, seconds });
  const hours = Math.floor(minutes / 60);
  return t('tui.messages.goalFormat.elapsedHours', { hours, minutes: minutes % 60 });
}
