/**
 * Builds the line content for the `/goal` status box. The lines are rendered
 * inside a {@link UsagePanelComponent} (the same bordered box as `/usage`), so
 * this module only owns the goal-specific layout:
 *
 *   ▌ <objective> (blockquote left-trail, wrapped)
 *   ▌ ✓ <completion criterion>
 *
 *   Status     complete — <reason>        (terminal goals only)
 *   Running    4m 12s
 *   Turns      7
 *   Tokens     128.4k
 *   Stop       after 20 turns (7/20)      (or a dim "no stop condition" note)
 */

import {
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@moonshot-ai/pi-tui';
import type { GoalSnapshot, GoalStatus } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';
import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import { formatTokenCount } from '#/utils/usage/usage-format';
import { formatGoalElapsed } from './goal-format';
import { UsagePanelComponent } from './usage-panel';

const WRAP_WIDTH = 72;
const MAX_OBJECTIVE_LINES = 6;
const MAX_CRITERION_LINES = 3;
const LABEL_WIDTH = 11;

function renderLifecycleLine(label: string, width: number): string[] {
  if (width <= 0) return [''];

  const marker = currentTheme.boldFg('primary', STATUS_BULLET);
  const text = new Text(currentTheme.boldFg('primary', label), 0, 0);
  const contentWidth = Math.max(1, width - visibleWidth(STATUS_BULLET));
  return [
    '',
    ...text
      .render(contentWidth)
      .map((line, index) => (index === 0 ? marker : MESSAGE_INDENT) + line.trimEnd()),
  ];
}

/**
 * The "Goal set" confirmation shown after `/goal <objective>`. The objective is
 * rendered as the following user prompt, so this message only marks the state
 * change in the transcript.
 */
export class GoalSetMessageComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return renderLifecycleLine(t('tui.messages.goalPanel.goalSet'), width);
  }
}

export class UpcomingGoalAddedMessageComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return renderLifecycleLine(
      t('tui.messages.goalPanel.upcomingAdded'),
      width,
    );
  }
}

export class GoalCompletionMessageComponent implements Component {
  constructor(private readonly message: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    const [headline = '', ...details] = this.message.trim().split(/\r?\n/);
    if (headline.length === 0) return [];

    const bullet = currentTheme.boldFg('success', STATUS_BULLET);
    const bulletWidth = visibleWidth(STATUS_BULLET);
    const contentWidth = Math.max(1, width - bulletWidth);
    const lines: string[] = [''];

    const headlineText = new Text(currentTheme.boldFg('success', headline), 0, 0);
    const headlineLines = headlineText.render(contentWidth);
    for (let i = 0; i < headlineLines.length; i += 1) {
      lines.push((i === 0 ? bullet : MESSAGE_INDENT) + headlineLines[i]);
    }

    const detailText = details.join('\n').trim();
    if (detailText.length > 0) {
      const detailLines = new Text(currentTheme.fg('textDim', detailText), 0, 0).render(
        contentWidth,
      );
      for (const line of detailLines) {
        lines.push(MESSAGE_INDENT + line);
      }
    }

    return lines;
  }
}

export class GoalStatusMessageComponent implements Component {
  constructor(private readonly goal: GoalSnapshot) {}

  invalidate(): void {}

  render(width: number): string[] {
    const panelContentWidth = Math.max(1, width - 6);
    const panel = new UsagePanelComponent(
      () => buildGoalReportLines(this.goal, panelContentWidth),
      'primary',
      goalPanelTitle(this.goal),
    );
    return ['', ...panel.render(width)];
  }
}

/** Box title, e.g. ` Goal · active `. */
export function goalPanelTitle(goal: GoalSnapshot): string {
  return t('tui.messages.goalPanel.title', { status: statusLabel(goal.status) });
}

export function buildGoalReportLines(goal: GoalSnapshot, wrapWidth: number = WRAP_WIDTH): string[] {
  const statusColor = statusToken(goal.status);
  const bar = (s: string) => currentTheme.fg(statusColor, s);
  const value = (s: string) => currentTheme.fg('text', s);
  const muted = (s: string) => currentTheme.fg('textDim', s);
  // `complete` is the terminal outcome (the completion card); everything else
  // (active / paused / blocked) is a persisted, resumable goal that still shows
  // its stop condition. A reason is worth surfacing for stopped / complete states.
  const isComplete = goal.status === 'complete';
  const reason = goal.terminalReason;
  const showReason =
    (goal.status === 'paused' && reason !== undefined) || goal.status === 'blocked' || isComplete;
  const lines: string[] = [];

  // Condition as a blockquote left-trail. Reserve the visible "▌ " prefix before
  // wrapping so the panel doesn't clip rows that exactly fit the panel interior.
  const blockquoteWrapWidth = Math.max(1, wrapWidth - visibleWidth('▌ '));
  for (const line of wrap(goal.objective, blockquoteWrapWidth, MAX_OBJECTIVE_LINES)) {
    lines.push(`${bar('▌')} ${value(line)}`);
  }
  if (goal.completionCriterion !== undefined) {
    for (const line of wrap(`✓ ${goal.completionCriterion}`, blockquoteWrapWidth, MAX_CRITERION_LINES)) {
      lines.push(`${bar('▌')} ${muted(line)}`);
    }
  }
  lines.push('');

  const row = (label: string, val: string): string => `${muted(label.padEnd(LABEL_WIDTH))}${val}`;

  if (showReason) {
    lines.push(
      row(
        t('tui.messages.goalPanel.statusLabel'),
        currentTheme.fg(statusColor, statusLabel(goal.status)) +
          (reason !== undefined ? muted(` — ${reason}`) : ''),
      ),
    );
  }
  lines.push(row(t('tui.messages.goalPanel.runningLabel'), value(formatGoalElapsed(goal.wallClockMs))));
  lines.push(row(t('tui.messages.goalPanel.turnsLabel'), value(`${goal.turnsUsed}`)));
  lines.push(row(t('tui.messages.goalPanel.tokensLabel'), value(formatTokenCount(goal.tokensUsed))));
  if (!isComplete) {
    const stop = formatStopRow(goal);
    lines.push(
      stop !== null
        ? row(t('tui.messages.goalPanel.stopLabel'), value(stop))
        : muted(t('tui.messages.goalPanel.noStopCondition')),
    );
  }
  return lines;
}

/** The configured hard stop(s), or null when the goal is unbounded. */
function formatStopRow(goal: GoalSnapshot): string | null {
  const { budget } = goal;
  const parts: string[] = [];
  if (budget.turnBudget !== null) {
    parts.push(
      t('tui.messages.goalPanel.stopTurns', {
        turnBudget: budget.turnBudget,
        turnsUsed: goal.turnsUsed,
      }),
    );
  }
  if (budget.tokenBudget !== null) {
    parts.push(
      t('tui.messages.goalPanel.stopTokens', {
        tokenBudget: formatTokenCount(budget.tokenBudget),
      }),
    );
  }
  if (budget.wallClockBudgetMs !== null) {
    parts.push(
      t('tui.messages.goalPanel.stopTime', {
        duration: formatGoalElapsed(budget.wallClockBudgetMs),
      }),
    );
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function statusToken(status: GoalStatus): ColorToken {
  switch (status) {
    case 'active':
      return 'primary';
    case 'complete':
      return 'success';
    case 'blocked':
      return 'warning';
    case 'paused':
      return 'textDim';
  }
}

function statusLabel(status: GoalStatus): string {
  switch (status) {
    case 'active':
      return t('tui.messages.goalPanel.statusActive');
    case 'complete':
      return t('tui.messages.goalPanel.statusComplete');
    case 'blocked':
      return t('tui.messages.goalPanel.statusBlocked');
    case 'paused':
      return t('tui.messages.goalPanel.statusPaused');
  }
}

/** Word-wrap to `width`, capped at `maxLines` (last line gets an ellipsis when clipped). */
function wrap(text: string, width: number, maxLines: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines = wrapTextWithAnsi(text.replaceAll(/\s+/g, ' ').trim(), safeWidth);
  if (lines.length === 0) return [''];
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  const lastLine = clipped[maxLines - 1] ?? '';
  clipped[maxLines - 1] = truncateToWidth(`${lastLine}…`, safeWidth, '…');
  return clipped;
}
