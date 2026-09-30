import { describe, expect, it, vi } from 'vitest';

import type { GoalSnapshot, GoalToolResult } from '@moonshot-ai/harness-core';

import { handleGoalCommand } from '#/tui/commands/goal';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeGoalSnapshot(objective: string): GoalSnapshot {
  return {
    goalId: 'goal-1',
    objective,
    status: 'active',
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
  };
}

interface StubHost {
  host: SlashCommandHost;
  sent: string[];
  errors: string[];
  statuses: string[];
  notices: string[];
  mounted: unknown[];
  goal: { current: GoalSnapshot | null };
}

function makeHost(currentGoal: GoalSnapshot | null): StubHost {
  const sent: string[] = [];
  const errors: string[] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  const mounted: unknown[] = [];
  const goal = {
    current: currentGoal,
    result(): GoalToolResult {
      return { goal: this.current };
    },
  };
  const state = {
    appState: { model: 'test/test-model' },
    transcriptContainer: {
      addChild: (component: unknown) => {
        mounted.push(component);
      },
    },
    editor: { getText: () => '' },
    editorReplacementMounted: false,
    ui: { requestRender: vi.fn() },
  };
  const session = { id: 'session-1' };
  const host = {
    state,
    session,
    ensureSession: async () => session,
    mainAgent: () => ({
      resolve: () => ({
        getGoal: () => goal.result(),
        pauseGoal: vi.fn(async () => {
          goal.current = null;
        }),
        resumeGoal: vi.fn(),
        cancelGoal: vi.fn(async () => {
          goal.current = null;
        }),
      }),
    }),
    sendNormalUserInput: (text: string) => {
      sent.push(text);
    },
    showError: (msg: string) => {
      errors.push(msg);
    },
    showStatus: (msg: string) => {
      statuses.push(msg);
    },
    showNotice: (msg: string) => {
      notices.push(msg);
    },
    restoreInputText: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, sent, errors, statuses, notices, mounted, goal };
}

describe('/goal command', () => {
  it('submits a goal-intake prompt for a create command', async () => {
    const { host, sent, errors } = makeHost(null);

    await handleGoalCommand(host, 'ship feature x');

    expect(errors).toEqual([]);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('CreateGoal');
    expect(sent[0]).toContain('ship feature x');
    expect(sent[0]).not.toContain('replace: true');
  });

  it('asks for replacement in the intake prompt for `/goal replace`', async () => {
    const { host, sent, errors } = makeHost(makeGoalSnapshot('old goal'));

    await handleGoalCommand(host, 'replace ship feature y');

    expect(errors).toEqual([]);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('ship feature y');
    expect(sent[0]).toContain('replace: true');
  });

  it('refuses to submit when a goal is already active and replace was not given', async () => {
    const { host, sent, errors } = makeHost(makeGoalSnapshot('old goal'));

    await handleGoalCommand(host, 'another objective');

    expect(sent).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('/goal replace');
  });

  it('reports that upcoming goal queues are dropped', async () => {
    const { host, sent, statuses, errors } = makeHost(null);

    await handleGoalCommand(host, 'next ship later work');

    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
    expect(statuses.length).toBe(1);
    expect(statuses[0]).toContain('not available');
  });

  it('mounts the goal status panel for `/goal status`', async () => {
    const { host, mounted, statuses } = makeHost(makeGoalSnapshot('ship feature x'));

    await handleGoalCommand(host, 'status');

    expect(statuses).toEqual([]);
    expect(mounted.length).toBe(1);
    expect((mounted[0] as { constructor: { name: string } }).constructor.name).toBe(
      'GoalStatusMessageComponent',
    );
  });

  it('shows the empty status message when no goal exists', async () => {
    const { host, mounted, statuses } = makeHost(null);

    await handleGoalCommand(host, 'status');

    expect(mounted).toEqual([]);
    expect(statuses.length).toBe(1);
    expect(statuses[0]).toContain('No goal set');
  });

  it('restores over-length objectives into the editor', async () => {
    const { host, sent, errors } = makeHost(null);
    const objective = 'x'.repeat(4001);

    await handleGoalCommand(host, objective);

    expect(sent).toEqual([]);
    expect(errors.length).toBe(1);
    expect(host.restoreInputText).toHaveBeenCalledWith(`/goal ${objective}`);
  });
});
