import { TuiAltScreen, visibleWidth, type Component } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildGoalReportLines,
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
  GoalStatusMessageComponent,
  UpcomingGoalAddedMessageComponent,
  goalPanelTitle,
} from '#/tui/components/messages/goal-panel';
import {
  flattenTranscriptRow,
  TranscriptRowLayout,
} from '#/tui/components/messages/transcript-row-layout';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';
import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

const previousChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(lines: string[]): string {
  return lines.join('\n').replaceAll(ANSI_SGR, '');
}

async function expectLogicalLineCopy(component: Component, source: string): Promise<void> {
  const terminal = new VirtualTerminal(16, 20);
  const copied: string[] = [];
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    copySelection: async (text) => {
      copied.push(text);
      return true;
    },
  });
  tui.addChild(component);
  tui.start();
  try {
    await terminal.waitForRender();
    const rows = tui.getScreenLines().map((line) => strip([line]));
    const firstNeedle = source.slice(0, 4);
    const lastNeedle = source.slice(-4);
    const startRow = rows.findIndex((line) => line.includes(firstNeedle));
    const endRow = rows.findLastIndex((line) => line.includes(lastNeedle));
    expect(startRow).toBeGreaterThanOrEqual(0);
    expect(endRow).toBeGreaterThanOrEqual(startRow);
    const startColumn = rows[startRow]!.indexOf(firstNeedle) + 1;
    const endColumn = rows[endRow]!.indexOf(lastNeedle) + lastNeedle.length;
    terminal.sendInput(`\u001B[<0;${startColumn};${startRow + 1}M`);
    terminal.sendInput(`\u001B[<32;${endColumn};${endRow + 1}M`);
    terminal.sendInput(`\u001B[<0;${endColumn};${endRow + 1}m`);
    await terminal.waitForRender();
    expect(copied).toEqual([source]);
  } finally {
    tui.stop();
  }
}

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: 'Ship the goal status box',
    status: 'active',
    turnsUsed: 7,
    tokensUsed: 128_400,
    wallClockMs: 252_000,
    budget: {
      turnBudget: null,
      tokenBudget: null,
      wallClockBudgetMs: null,
    },
    ...overrides,
  } as GoalSnapshot;
}

function lines(g: GoalSnapshot): string {
  return strip(buildGoalReportLines(g));
}

describe('buildGoalReportLines', () => {
  it('renders the objective as a blockquote and key counters for an active goal', () => {
    const out = lines(goal());
    expect(out).toContain('▌ Ship the goal status box');
    expect(out).toContain('Running');
    expect(out).toContain('4m 12s');
    expect(out).toContain('Turns');
    expect(out).toContain('125k');
  });

  it('shows a no-stop-condition note for an unbounded active goal', () => {
    expect(lines(goal())).toContain('No stop condition — runs until evaluated complete.');
  });

  it('shows a Stop row with progress when a turn budget is set', () => {
    const out = lines(goal({ budget: { turnBudget: 20, tokenBudget: null, wallClockBudgetMs: null } } as Partial<GoalSnapshot>));
    expect(out).toContain('Stop');
    expect(out).toContain('after 20 turns (7/20)');
    expect(out).not.toContain('No stop condition');
  });

  it('includes the completion criterion when present', () => {
    const out = lines(goal({ completionCriterion: 'tests pass' }));
    expect(out).toContain('✓ tests pass');
  });

  it('renders a terminal goal with a Status row and no Stop row', () => {
    const out = lines(goal({ status: 'complete', terminalReason: 'all done' }));
    expect(out).toContain('Status');
    expect(out).toContain('complete — all done');
    expect(out).not.toContain('No stop condition');
    expect(out).not.toMatch(/^Stop/m);
  });

  it('shows the reason for a paused goal when one exists', () => {
    const out = lines(goal({ status: 'paused', terminalReason: 'Paused after provider rate limit' }));
    expect(out).toContain('Status');
    expect(out).toContain('paused — Paused after provider rate limit');
  });

  it('titles the box with the status', () => {
    expect(goalPanelTitle(goal())).toBe(' Goal · active ');
    expect(goalPanelTitle(goal({ status: 'complete' }))).toBe(' Goal · complete ');
  });

  it('truncates a very long objective with an ellipsis', () => {
    const long = 'word '.repeat(200).trim();
    const out = lines(goal({ objective: long }));
    expect(out).toContain('…');
  });
});

describe('GoalSetMessageComponent', () => {
  it('renders a marker-style lifecycle line without repeating the objective', () => {
    const rendered = new GoalSetMessageComponent().render(60);
    expect(rendered[0]).toBe('');
    expect(strip(rendered)).toBe('\n● Goal set');
  });

  it('renders the marker and label in the primary accent', () => {
    const rendered = new GoalSetMessageComponent().render(60);

    expect(rendered[1]).toBe(
      chalk.hex(darkColors.primary).bold(STATUS_BULLET) +
        chalk.hex(darkColors.primary).bold('Goal set'),
    );
  });

  it('separates the lifecycle bullet from its label', () => {
    const component = new GoalSetMessageComponent();
    const parts = component.renderTranscriptRow(60);

    expect(parts.contentLines.map((line) => strip([line.text]))).toEqual(['', 'Goal set']);
    expect(parts.gutterLines.map((line) => strip([line.text]))).toEqual(['', '● ']);
    expect(
      flattenTranscriptRow(parts, 60).map((line) => strip([line.text]).trimEnd()),
    ).toEqual(component.render(60).map((line) => strip([line]).trimEnd()));
  });

  it('keeps the lifecycle line within narrow widths', () => {
    for (const width of [39, 20, 10, 4]) {
      for (const line of new GoalSetMessageComponent().render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('UpcomingGoalAddedMessageComponent', () => {
  it('renders the upcoming-goal confirmation like the goal-set lifecycle line', () => {
    const rendered = new UpcomingGoalAddedMessageComponent().render(80);

    expect(strip(rendered)).toBe(
      '\n● Upcoming goal added. It will start after the current goal is complete.',
    );
    expect(rendered[1]).toBe(
      chalk.hex(darkColors.primary).bold(STATUS_BULLET) +
        chalk.hex(darkColors.primary).bold(
          'Upcoming goal added. It will start after the current goal is complete.',
        ),
    );
  });

  it('wraps the upcoming-goal confirmation within narrow widths', () => {
    for (const width of [39, 20, 10, 4]) {
      for (const line of new UpcomingGoalAddedMessageComponent().render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('keeps wrapped lifecycle continuation alignment in the gutter', () => {
    const component = new UpcomingGoalAddedMessageComponent();
    const width = 20;
    const parts = component.renderTranscriptRow(width);

    expect(parts.contentLines.length).toBeGreaterThan(2);
    expect(parts.contentLines.map((line) => strip([line.text])).join('')).not.toContain('●');
    expect(parts.gutterLines.slice(2).every((line) => strip([line.text]) === '  ')).toBe(true);
    expect(
      flattenTranscriptRow(parts, width).map((line) => strip([line.text]).trimEnd()),
    ).toEqual(component.render(width).map((line) => strip([line]).trimEnd()));
  });

  it('copies the soft-wrapped confirmation without visual newlines or indentation', async () => {
    const source = 'Upcoming goal added. It will start after the current goal is complete.';
    const component = new UpcomingGoalAddedMessageComponent();
    await expectLogicalLineCopy(component, source);
    await expectLogicalLineCopy(new TranscriptRowLayout(component), source);
  });
});

describe('GoalStatusMessageComponent', () => {
  it('adds a blank line before the status box', () => {
    const rendered = new GoalStatusMessageComponent(goal()).render(80);

    expect(rendered[0]).toBe('');
    expect(strip([rendered[1]!])).toContain('╭ Goal · active ');
  });

  it('wraps objective blockquotes without clipping them at 80 columns', () => {
    const rendered = new GoalStatusMessageComponent(
      goal({ objective: 'word '.repeat(30).trim() }),
    ).render(80);

    expect(strip(rendered)).not.toContain('...');
  });

  it('keeps the status box within narrow widths', () => {
    const rendered = new GoalStatusMessageComponent(goal({ objective: '管理飞书日历的技能描述 '.repeat(4).trim() }));

    for (const width of [39, 24, 20, 10]) {
      for (const line of rendered.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('separates only the panel alignment margin from semantic panel content', () => {
    const component = new GoalStatusMessageComponent(goal());
    const width = 80;
    const parts = component.renderTranscriptRow(width);
    const content = strip(parts.contentLines.map((line) => line.text));

    expect(parts.gutterWidth).toBe(2);
    expect(parts.gutterLines.slice(1).every((line) => strip([line.text]) === '  ')).toBe(true);
    expect(strip([parts.contentLines[1]!.text])).toContain('╭ Goal · active ');
    expect(content).toContain('▌ Ship the goal status box');
    expect(content).toContain('Running');
    expect(
      flattenTranscriptRow(parts, width).map((line) => strip([line.text]).trimEnd()),
    ).toEqual(component.render(width).map((line) => strip([line]).trimEnd()));
  });

  it('copies a soft-wrapped objective without visual newlines or panel decoration', async () => {
    const source = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const component = new GoalStatusMessageComponent(goal({ objective: source }));
    await expectLogicalLineCopy(component, source);
    await expectLogicalLineCopy(new TranscriptRowLayout(component), source);
  });
});

describe('GoalCompletionMessageComponent', () => {
  it('renders the completion headline in green and keeps the stats line indented', () => {
    const message = '✓ Goal complete.\nWorked 1 turn over 2m28s, using 766.9k tokens.';
    const rendered = new GoalCompletionMessageComponent(message).render(80);

    expect(rendered[0]).toBe('');
    expect(rendered[1]?.trimEnd()).toBe(
      chalk.hex(darkColors.success).bold(STATUS_BULLET) +
        chalk.hex(darkColors.success).bold('✓ Goal complete.'),
    );
    expect(strip([rendered[2]!]).trimEnd()).toBe(
      '  Worked 1 turn over 2m28s, using 766.9k tokens.',
    );
  });

  it('separates completion markers and detail indentation from content', () => {
    const component = new GoalCompletionMessageComponent('Goal complete.\nWorked 1 turn.');
    const width = 40;
    const parts = component.renderTranscriptRow(width);

    expect(parts.contentLines.map((line) => strip([line.text]))).toEqual([
      '',
      'Goal complete.',
      'Worked 1 turn.',
    ]);
    expect(parts.gutterLines.map((line) => strip([line.text]))).toEqual(['', '● ', '  ']);
    expect(
      flattenTranscriptRow(parts, width).map((line) => strip([line.text]).trimEnd()),
    ).toEqual(component.render(width).map((line) => strip([line]).trimEnd()));
  });

  it('copies soft-wrapped completion details without visual newlines or indentation', async () => {
    const source = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const component = new GoalCompletionMessageComponent(`Goal complete.\n${source}`);
    await expectLogicalLineCopy(component, source);
    await expectLogicalLineCopy(new TranscriptRowLayout(component), source);
  });
});
