import {
  decorateRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  Text,
  textRenderLine,
  truncateRenderLine,
  truncateToWidth,
  visibleWidth,
  withRenderLineSelectionExclusions,
  withRenderLineText,
  type Component,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';
import type { GoalSnapshot, GoalStatus } from '@moonshot-ai/kimi-code-sdk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import { formatTokenCount } from '#/utils/usage/usage-format';
import { formatGoalElapsed } from './goal-format';
import type { TranscriptRowParts } from './transcript-row-layout';

const WRAP_WIDTH = 72;
const MAX_OBJECTIVE_LINES = 6;
const MAX_CRITERION_LINES = 3;
const LABEL_WIDTH = 11;
const PANEL_LEFT_MARGIN = 2;
const PANEL_SIDE_PADDING = 1;
const PANEL_BOX_OVERHEAD = PANEL_LEFT_MARGIN + 2 + 2 * PANEL_SIDE_PADDING;

function renderLifecycleLines(label: string, width: number): TuiRenderLine[] {
  if (width <= 0) return [textRenderLine('')];

  const marker = currentTheme.boldFg('primary', STATUS_BULLET);
  const text = new Text(currentTheme.boldFg('primary', label), 0, 0);
  const contentWidth = Math.max(1, width - visibleWidth(STATUS_BULLET));
  const contentLines = renderComponentLines(text, contentWidth);
  return [
    textRenderLine(''),
    ...contentLines.map((line, index) =>
      truncateRenderLine(
        decorateRenderLine(
          withRenderLineText(line, line.text.trimEnd()),
          index === 0 ? marker : MESSAGE_INDENT,
        ),
        width,
        '…',
      ),
    ),
  ];
}

function renderLifecycleTranscriptRow(label: string, width: number): TranscriptRowParts {
  const safeWidth = Math.max(0, width);
  const gutterWidth = visibleWidth(STATUS_BULLET);
  if (safeWidth <= gutterWidth) {
    const gutterLines = renderLifecycleLines(label, safeWidth);
    return {
      gutterWidth: safeWidth,
      gutterLines,
      contentLines: gutterLines.map(() => textRenderLine('')),
    };
  }

  const marker = currentTheme.boldFg('primary', STATUS_BULLET);
  const text = new Text(currentTheme.boldFg('primary', label), 0, 0);
  const contentLines = renderComponentLines(text, safeWidth - gutterWidth).map((line) =>
    withRenderLineText(line, line.text.trimEnd()),
  );
  return {
    gutterWidth,
    gutterLines: [
      textRenderLine(''),
      ...contentLines.map((_, index) =>
        textRenderLine(index === 0 ? marker : MESSAGE_INDENT),
      ),
    ],
    contentLines: [textRenderLine(''), ...contentLines],
  };
}

export class GoalSetMessageComponent implements Component {
  invalidate(): void {}

  renderTranscriptRow(width: number): TranscriptRowParts {
    return renderLifecycleTranscriptRow('Goal set', width);
  }

  selectionExclusions() {
    return [{ start: 0, end: MESSAGE_INDENT.length }];
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    return renderLifecycleLines('Goal set', width);
  }
}

export class UpcomingGoalAddedMessageComponent implements Component {
  invalidate(): void {}

  renderTranscriptRow(width: number): TranscriptRowParts {
    return renderLifecycleTranscriptRow(
      'Upcoming goal added. It will start after the current goal is complete.',
      width,
    );
  }

  selectionExclusions() {
    return [{ start: 0, end: MESSAGE_INDENT.length }];
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    return renderLifecycleLines(
      'Upcoming goal added. It will start after the current goal is complete.',
      width,
    );
  }
}

export class GoalCompletionMessageComponent implements Component {
  constructor(private readonly message: string) {}

  invalidate(): void {}

  renderTranscriptRow(width: number): TranscriptRowParts {
    const [headline = '', ...details] = this.message.trim().split(/\r?\n/);
    if (headline.length === 0) {
      return { gutterWidth: 0, gutterLines: [], contentLines: [] };
    }
    const safeWidth = Math.max(0, width);
    const gutterWidth = visibleWidth(STATUS_BULLET);
    if (safeWidth <= gutterWidth) {
      const gutterLines = this[RENDER_LINES](safeWidth);
      return {
        gutterWidth: safeWidth,
        gutterLines,
        contentLines: gutterLines.map(() => textRenderLine('')),
      };
    }

    const bullet = currentTheme.boldFg('success', STATUS_BULLET);
    const contentWidth = safeWidth - gutterWidth;
    const headlineLines = renderComponentLines(
      new Text(currentTheme.boldFg('success', headline), 0, 0),
      contentWidth,
    ).map((line) => withRenderLineText(line, line.text.trimEnd()));
    const contentLines: TuiRenderLine[] = [textRenderLine(''), ...headlineLines];
    const gutterLines: TuiRenderLine[] = [
      textRenderLine(''),
      ...headlineLines.map((_, index) =>
        textRenderLine(index === 0 ? bullet : MESSAGE_INDENT),
      ),
    ];
    const detailText = details.join('\n').trim();
    if (detailText.length > 0) {
      const detailLines = renderComponentLines(
        new Text(currentTheme.fg('textDim', detailText), 0, 0),
        contentWidth,
      ).map((line) => withRenderLineText(line, line.text.trimEnd()));
      contentLines.push(...detailLines);
      gutterLines.push(...detailLines.map(() => textRenderLine(MESSAGE_INDENT)));
    }
    return { gutterWidth, gutterLines, contentLines };
  }

  selectionExclusions() {
    return [{ start: 0, end: MESSAGE_INDENT.length }];
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    const [headline = '', ...details] = this.message.trim().split(/\r?\n/);
    if (headline.length === 0) return [];
    if (width <= 0) return [textRenderLine('')];

    const bullet = currentTheme.boldFg('success', STATUS_BULLET);
    const bulletWidth = visibleWidth(STATUS_BULLET);
    const contentWidth = Math.max(1, width - bulletWidth);
    const lines: TuiRenderLine[] = [textRenderLine('')];

    const headlineText = new Text(currentTheme.boldFg('success', headline), 0, 0);
    const headlineLines = renderComponentLines(headlineText, contentWidth);
    for (let i = 0; i < headlineLines.length; i += 1) {
      lines.push(
        truncateRenderLine(
          decorateRenderLine(headlineLines[i]!, i === 0 ? bullet : MESSAGE_INDENT),
          width,
          '…',
        ),
      );
    }

    const detailText = details.join('\n').trim();
    if (detailText.length > 0) {
      const detailLines = renderComponentLines(
        new Text(currentTheme.fg('textDim', detailText), 0, 0),
        contentWidth,
      );
      for (const line of detailLines) {
        lines.push(
          truncateRenderLine(decorateRenderLine(line, MESSAGE_INDENT), width, '…'),
        );
      }
    }

    return lines;
  }
}

export class GoalStatusMessageComponent implements Component {
  constructor(private readonly goal: GoalSnapshot) {}

  invalidate(): void {}

  renderTranscriptRow(width: number): TranscriptRowParts {
    const safeWidth = Math.max(0, width);
    const separateGutter = safeWidth - PANEL_BOX_OVERHEAD >= 1;
    const gutterWidth = separateGutter ? PANEL_LEFT_MARGIN : 0;
    const panelLines = separateGutter
      ? renderGoalPanelLines(this.goal, safeWidth - gutterWidth, 0)
      : renderGoalPanelLines(this.goal, safeWidth);
    return {
      gutterWidth,
      gutterLines: [
        textRenderLine(''),
        ...panelLines.map(() => textRenderLine(' '.repeat(gutterWidth))),
      ],
      contentLines: [textRenderLine(''), ...panelLines],
    };
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    return [textRenderLine(''), ...renderGoalPanelLines(this.goal, width)];
  }
}

export function goalPanelTitle(goal: GoalSnapshot): string {
  return ` Goal · ${goal.status} `;
}

export function buildGoalReportLines(goal: GoalSnapshot, wrapWidth: number = WRAP_WIDTH): string[] {
  return renderLineTexts(buildGoalReportRenderLines(goal, wrapWidth));
}

function buildGoalReportRenderLines(goal: GoalSnapshot, wrapWidth: number): TuiRenderLine[] {
  const statusColor = statusToken(goal.status);
  const bar = (s: string) => currentTheme.fg(statusColor, s);
  const value = (s: string) => currentTheme.fg('text', s);
  const muted = (s: string) => currentTheme.fg('textDim', s);
  const isComplete = goal.status === 'complete';
  const reason = goal.terminalReason;
  const showReason =
    (goal.status === 'paused' && reason !== undefined) || goal.status === 'blocked' || isComplete;
  const lines: TuiRenderLine[] = [];

  const blockquoteWrapWidth = Math.max(1, wrapWidth - visibleWidth('▌ '));
  for (const line of wrap(goal.objective, blockquoteWrapWidth, MAX_OBJECTIVE_LINES)) {
    lines.push(decorateRenderLine(withRenderLineText(line, value(line.text)), `${bar('▌')} `));
  }
  if (goal.completionCriterion !== undefined) {
    for (const line of wrap(
      `✓ ${goal.completionCriterion}`,
      blockquoteWrapWidth,
      MAX_CRITERION_LINES,
    )) {
      lines.push(decorateRenderLine(withRenderLineText(line, muted(line.text)), `${bar('▌')} `));
    }
  }
  lines.push(textRenderLine(''));

  const row = (label: string, val: string): string => `${muted(label.padEnd(LABEL_WIDTH))}${val}`;

  if (showReason) {
    lines.push(
      textRenderLine(
        row(
          'Status',
          currentTheme.fg(statusColor, goal.status) +
            (reason !== undefined ? muted(` — ${reason}`) : ''),
        ),
      ),
    );
  }
  lines.push(textRenderLine(row('Running', value(formatGoalElapsed(goal.wallClockMs)))));
  lines.push(textRenderLine(row('Turns', value(`${goal.turnsUsed}`))));
  lines.push(textRenderLine(row('Tokens', value(formatTokenCount(goal.tokensUsed)))));
  if (!isComplete) {
    const stop = formatStopRow(goal);
    lines.push(
      textRenderLine(
        stop !== null
          ? row('Stop', value(stop))
          : muted('No stop condition — runs until evaluated complete.'),
      ),
    );
  }
  return lines;
}

function renderGoalPanelLines(
  goal: GoalSnapshot,
  width: number,
  leftMargin: number = PANEL_LEFT_MARGIN,
): TuiRenderLine[] {
  const safeWidth = Math.max(0, width);
  if (safeWidth <= 0) return [textRenderLine('')];

  const title = goalPanelTitle(goal);
  const panelBoxOverhead = leftMargin + 2 + 2 * PANEL_SIDE_PADDING;
  const lines = buildGoalReportRenderLines(goal, Math.max(1, safeWidth - panelBoxOverhead));
  const paint = (s: string): string => currentTheme.fg('primary', s);
  const availableInterior = safeWidth - panelBoxOverhead;
  if (availableInterior < 1) {
    return [
      textRenderLine(truncateToWidth(title.trim(), safeWidth, '…')),
      ...lines.map((line) => truncateRenderLine(line, safeWidth, '…')),
    ];
  }

  const indent = ' '.repeat(leftMargin);
  const longestLine = lines.reduce((max, line) => Math.max(max, visibleWidth(line.text)), 0);
  const contentWidth = Math.max(
    1,
    Math.min(availableInterior, Math.max(longestLine, visibleWidth(title))),
  );
  const horzLen = contentWidth + 2 * PANEL_SIDE_PADDING;
  const panelTitle = truncateToWidth(title, horzLen, '…');
  const trailingDashLen = Math.max(0, horzLen - visibleWidth(panelTitle));
  const top =
    indent + paint('╭') + paint(panelTitle) + paint('─'.repeat(trailingDashLen)) + paint('╮');
  const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');
  const out: TuiRenderLine[] = [textRenderLine(top)];

  for (const line of lines) {
    const clipped =
      visibleWidth(line.text) > contentWidth ? truncateRenderLine(line, contentWidth) : line;
    const pad = Math.max(0, contentWidth - visibleWidth(clipped.text));
    const prefixed = decorateRenderLine(clipped, indent + paint('│') + ' ');
    const rightStart = visibleWidth(prefixed.text) + pad;
    const padded = withRenderLineText(
      prefixed,
      `${prefixed.text}${' '.repeat(pad)} ${paint('│')}`,
    );
    out.push(
      withRenderLineSelectionExclusions(padded, [{ start: rightStart, end: rightStart + 2 }]),
    );
  }
  out.push(textRenderLine(bottom));
  return out.map((line) => truncateRenderLine(line, safeWidth, '…'));
}

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
    parts.push(`after ${formatGoalElapsed(budget.wallClockBudgetMs)}`);
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

function wrap(text: string, width: number, maxLines: number): TuiRenderLine[] {
  const safeWidth = Math.max(1, width);
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  let lines = renderComponentLines(new Text(normalized, 0, 0), safeWidth).map((line) =>
    withRenderLineText(line, line.text.trimEnd()),
  );
  if (lines.length === 0) lines = [textRenderLine('')];
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  const lastLine = clipped[maxLines - 1]!;
  clipped[maxLines - 1] = truncateRenderLine(
    withRenderLineText(lastLine, `${lastLine.text}…`),
    safeWidth,
    '…',
  );
  return clipped;
}
