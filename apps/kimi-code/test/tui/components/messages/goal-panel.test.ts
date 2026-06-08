import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';

import {
  buildGoalReportLines,
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
  GoalStatusMessageComponent,
  UpcomingGoalAddedMessageComponent,
  goalPanelTitle,
} from '#/tui/components/messages/goal-panel';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { darkColors } from '#/tui/theme/colors';
import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

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

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: 'Ship the goal status box',
    status: 'active',
    turnsUsed: 7,
    tokensUsed: 128_400,
    wallClockMs: 252_000, // 4m12s
    budget: {
      turnBudget: null,
      tokenBudget: null,
      wallClockBudgetMs: null,
    },
    ...overrides,
  } as GoalSnapshot;
}

function lines(g: GoalSnapshot): string {
  return strip(buildGoalReportLines({ colors: darkColors, goal: g }));
}

describe('buildGoalReportLines', () => {
  it('renders the objective as a blockquote and key counters for an active goal', () => {
    const out = lines(goal());
    expect(out).toContain('▌ Ship the goal status box');
    expect(out).toContain('Running');
    expect(out).toContain('4m 12s');
    expect(out).toContain('Turns');
    expect(out).toContain('128.4k'); // formatTokenCount
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
    const rendered = new GoalSetMessageComponent(darkColors).render(60);
    // Leading blank line separates it from the line above.
    expect(rendered[0]).toBe('');
    expect(strip(rendered)).toBe('\n● Goal set');
  });

  it('renders the marker and label in the primary accent', () => {
    const rendered = new GoalSetMessageComponent(darkColors).render(60);

    expect(rendered[1]).toBe(
      chalk.hex(darkColors.primary).bold(STATUS_BULLET) +
        chalk.hex(darkColors.primary).bold('Goal set'),
    );
  });
});

describe('UpcomingGoalAddedMessageComponent', () => {
  it('renders the upcoming-goal confirmation like the goal-set lifecycle line', () => {
    const rendered = new UpcomingGoalAddedMessageComponent(darkColors).render(80);

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
});

describe('GoalStatusMessageComponent', () => {
  it('adds a blank line before the status box', () => {
    const rendered = new GoalStatusMessageComponent(goal(), darkColors).render(80);

    expect(rendered[0]).toBe('');
    expect(strip([rendered[1]!])).toContain('╭ Goal · active ');
  });
});

describe('GoalCompletionMessageComponent', () => {
  it('renders the completion headline in green and keeps the stats line indented', () => {
    const message = '✓ Goal complete.\nWorked 1 turn over 2m28s, using 766.9k tokens.';
    const rendered = new GoalCompletionMessageComponent(message, darkColors).render(80);

    expect(rendered[0]).toBe('');
    expect(rendered[1]?.trimEnd()).toBe(
      chalk.hex(darkColors.success).bold(STATUS_BULLET) +
        chalk.hex(darkColors.success).bold('✓ Goal complete.'),
    );
    expect(strip([rendered[2]!]).trimEnd()).toBe(
      '  Worked 1 turn over 2m28s, using 766.9k tokens.',
    );
  });
});
