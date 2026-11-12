import { formatDuration } from '#/tui/utils/transcript-items';
import type { Instant, TurnFacts } from '#/tui/utils/turn-timeline';

export function workingLabel(turn: TurnFacts | undefined, now: Instant): string {
  return turn?.kind === 'live' ? `Working for ${formatDuration(now - turn.start)}` : 'Working…';
}

export function workedSummary(turn: TurnFacts | undefined): string {
  if (turn?.kind !== 'ended' || turn.outcome !== 'completed') return '';
  const doneAt = new Date(turn.endedAtMs).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `Worked for ${formatDuration(turn.end - turn.start)} · done ${doneAt}`;
}
