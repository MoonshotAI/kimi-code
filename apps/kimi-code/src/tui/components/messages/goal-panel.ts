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

import type { Component } from '@earendil-works/pi-tui';
import { Text, visibleWidth } from '@earendil-works/pi-tui';
import type { GoalSnapshot, GoalStatus } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import { formatTokenCount } from '#/utils/usage/usage-format';
import { UsagePanelComponent } from './usage-panel';

const WRAP_WIDTH = 72;
const MAX_OBJECTIVE_LINES = 6;
const MAX_CRITERION_LINES = 3;
const LABEL_WIDTH = 11;

function renderLifecycleLine(label: string, colors: ColorPalette): string[] {
  const marker = chalk.hex(colors.primary).bold(STATUS_BULLET);
  const text = chalk.hex(colors.primary).bold(label);
  return ['', marker + text];
}

/**
 * The "Goal set" confirmation shown after `/goal <objective>`. The objective is
 * rendered as the following user prompt, so this message only marks the state
 * change in the transcript.
 */
export class GoalSetMessageComponent implements Component {
  constructor(private readonly colors: ColorPalette) {}

  invalidate(): void {}

  render(_width: number): string[] {
    return renderLifecycleLine('Goal set', this.colors);
  }
}

export class UpcomingGoalAddedMessageComponent implements Component {
  constructor(private readonly colors: ColorPalette) {}

  invalidate(): void {}

  render(_width: number): string[] {
    return renderLifecycleLine(
      'Upcoming goal added. It will start after the current goal is complete.',
      this.colors,
    );
  }
}

export class GoalCompletionMessageComponent implements Component {
  constructor(
    private readonly message: string,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const [headline = '', ...details] = this.message.trim().split(/\r?\n/);
    if (headline.length === 0) return [];

    const bullet = chalk.hex(this.colors.success).bold(STATUS_BULLET);
    const bulletWidth = visibleWidth(STATUS_BULLET);
    const contentWidth = Math.max(1, width - bulletWidth);
    const lines: string[] = [''];

    const headlineText = new Text(chalk.hex(this.colors.success).bold(headline), 0, 0);
    const headlineLines = headlineText.render(contentWidth);
    for (let i = 0; i < headlineLines.length; i += 1) {
      lines.push((i === 0 ? bullet : MESSAGE_INDENT) + headlineLines[i]);
    }

    const detailText = details.join('\n').trim();
    if (detailText.length > 0) {
      const detailLines = new Text(chalk.hex(this.colors.textDim)(detailText), 0, 0).render(
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
  constructor(
    private readonly goal: GoalSnapshot,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines = buildGoalReportLines({ colors: this.colors, goal: this.goal });
    const panel = new UsagePanelComponent(lines, this.colors.primary, goalPanelTitle(this.goal));
    return ['', ...panel.render(width)];
  }
}

export interface GoalReportOptions {
  readonly colors: ColorPalette;
  readonly goal: GoalSnapshot;
}

/** Box title, e.g. ` Goal · active `. */
export function goalPanelTitle(goal: GoalSnapshot): string {
  return ` Goal · ${goal.status} `;
}

export function buildGoalReportLines(options: GoalReportOptions): string[] {
  const { colors, goal } = options;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const bar = chalk.hex(statusHex(goal.status, colors));
  // `complete` is the terminal outcome (the completion card); everything else
  // (active / paused / blocked) is a persisted, resumable goal that still shows
  // its stop condition. A reason is worth surfacing for stopped / complete states.
  const isComplete = goal.status === 'complete';
  const reason = goal.terminalReason;
  const showReason =
    (goal.status === 'paused' && reason !== undefined) || goal.status === 'blocked' || isComplete;
  const lines: string[] = [];

  // Condition as a blockquote left-trail.
  for (const line of wrap(goal.objective, WRAP_WIDTH, MAX_OBJECTIVE_LINES)) {
    lines.push(`${bar('▌')} ${value(line)}`);
  }
  if (goal.completionCriterion !== undefined) {
    for (const line of wrap(`✓ ${goal.completionCriterion}`, WRAP_WIDTH, MAX_CRITERION_LINES)) {
      lines.push(`${bar('▌')} ${muted(line)}`);
    }
  }
  lines.push('');

  const row = (label: string, val: string): string => `${muted(label.padEnd(LABEL_WIDTH))}${val}`;

  if (showReason) {
    lines.push(
      row(
        'Status',
        chalk.hex(statusHex(goal.status, colors))(goal.status) +
          (reason !== undefined ? muted(` — ${reason}`) : ''),
      ),
    );
  }
  lines.push(row('Running', value(formatElapsed(goal.wallClockMs))));
  lines.push(row('Turns', value(`${goal.turnsUsed}`)));
  lines.push(row('Tokens', value(formatTokenCount(goal.tokensUsed))));
  if (!isComplete) {
    const stop = formatStopRow(goal);
    lines.push(
      stop !== null
        ? row('Stop', value(stop))
        : muted('No stop condition — runs until evaluated complete.'),
    );
  }
  return lines;
}

/** The configured hard stop(s), or null when the goal is unbounded. */
function formatStopRow(goal: GoalSnapshot): string | null {
  const { budget } = goal;
  const parts: string[] = [];
  if (budget.turnBudget !== null) {
    parts.push(`after ${budget.turnBudget} turns (${goal.turnsUsed}/${budget.turnBudget})`);
  }
  if (budget.tokenBudget !== null) {
    parts.push(`at ${formatTokenCount(budget.tokenBudget)} tokens`);
  }
  if (budget.wallClockBudgetMs !== null) {
    parts.push(`after ${formatElapsed(budget.wallClockBudgetMs)}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function statusHex(status: GoalStatus, colors: ColorPalette): string {
  switch (status) {
    case 'active':
      return colors.primary;
    case 'complete':
      return colors.success;
    case 'blocked':
      return colors.warning;
    case 'paused':
      return colors.textDim;
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, '0')}m`;
}

/** Word-wrap to `width`, capped at `maxLines` (last line gets an ellipsis when clipped). */
function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.replaceAll(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  if (lines.length === 0) return [''];
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  clipped[maxLines - 1] = `${clipped[maxLines - 1]!.slice(0, Math.max(0, width - 1))}…`;
  return clipped;
}
