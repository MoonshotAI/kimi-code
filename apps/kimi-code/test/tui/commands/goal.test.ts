import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchInput,
  goalArgumentCompletions,
  handleGoalCommand,
  parseGoalCommand,
  setExperimentalFlags,
} from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function fakeSnapshot() {
  return {
    goalId: 'g1',
    objective: 'obj',
    status: 'active' as const,
    createdAt: '',
    updatedAt: '',
    startedBy: 'user' as const,
    updatedBy: 'user' as const,
    turnsUsed: 0,
    consecutiveNoProgressTurns: 0,
    consecutiveFailureTurns: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: {
      tokenBudget: null,
      turnBudget: 20,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: 20,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      noProgressTurnLimit: null,
      failureTurnLimit: null,
      overBudget: false,
    },
  };
}

function makeHost(overrides: { model?: string; hasSession?: boolean; streaming?: boolean } = {}) {
  const session = {
    createGoal: vi.fn(async () => fakeSnapshot()),
    getGoal: vi.fn(async () => ({ goal: null })),
    pauseGoal: vi.fn(async () => fakeSnapshot()),
    resumeGoal: vi.fn(async () => fakeSnapshot()),
    cancelGoal: vi.fn(async () => fakeSnapshot()),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        model: overrides.model ?? 'kimi-model',
        streamingPhase: overrides.streaming ? 'streaming' : 'idle',
        isCompacting: false,
      },
    },
    session: hasSession ? session : undefined,
    skillCommandMap: new Map<string, string>(),
    requireSession: () => session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    sendNormalUserInput: vi.fn(),
    cancelInFlight: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('parseGoalCommand', () => {
  it('treats empty and status as status', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'status' });
    expect(parseGoalCommand('status')).toEqual({ kind: 'status' });
  });

  it('parses control subcommands', () => {
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseGoalCommand('cancel')).toEqual({ kind: 'cancel' });
  });

  it('treats `clear` as an objective, not a subcommand (cancel is the remove action)', () => {
    expect(parseGoalCommand('clear')).toMatchObject({ kind: 'create', objective: 'clear' });
  });

  it('parses a plain objective', () => {
    expect(parseGoalCommand('Ship feature X')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature X',
      replace: false,
    });
  });

  it('parses budget options before the objective', () => {
    expect(parseGoalCommand('--max-tokens 50000 Ship feature X')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature X',
      budgetLimits: { tokenBudget: 50000 },
    });
    expect(parseGoalCommand('--max-turns 8 Ship X')).toMatchObject({
      budgetLimits: { turnBudget: 8 },
    });
    expect(parseGoalCommand('--max-minutes 30 Ship X')).toMatchObject({
      budgetLimits: { wallClockBudgetMs: 1_800_000 },
    });
  });

  it('rejects non-positive-integer option values', () => {
    expect(parseGoalCommand('--max-tokens abc Ship X')).toMatchObject({ kind: 'error' });
    expect(parseGoalCommand('--max-turns 0 Ship X')).toMatchObject({ kind: 'error' });
  });

  it('treats text after -- as the objective', () => {
    expect(parseGoalCommand('-- --max-tokens is part of the goal')).toMatchObject({
      kind: 'create',
      objective: '--max-tokens is part of the goal',
    });
    expect(parseGoalCommand('-- cancel')).toMatchObject({ kind: 'create', objective: 'cancel' });
  });

  it('parses replace as the first argument', () => {
    expect(parseGoalCommand('replace Ship feature Y')).toMatchObject({
      kind: 'create',
      objective: 'Ship feature Y',
      replace: true,
    });
  });

  it('rejects objectives longer than 4000 characters', () => {
    expect(parseGoalCommand('x'.repeat(4001))).toMatchObject({ kind: 'error' });
  });
});

describe('handleGoalCommand', () => {
  let host: SlashCommandHost;
  let session: ReturnType<typeof makeHost>['session'];

  beforeEach(() => {
    const made = makeHost();
    host = made.host;
    session = made.session;
  });

  it('/goal calls getGoal and does not send input', async () => {
    await handleGoalCommand(host, '');
    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal status calls getGoal and does not send input', async () => {
    await handleGoalCommand(host, 'status');
    expect(session.getGoal).toHaveBeenCalledOnce();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal <objective> creates a goal and sends the objective as input', async () => {
    await handleGoalCommand(host, 'Ship feature X');
    expect(session.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship feature X', replace: false }),
    );
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    expect(host.sendNormalUserInput).not.toHaveBeenCalledWith('/goal Ship feature X');
  });

  it('passes budget limits through to createGoal', async () => {
    await handleGoalCommand(host, '--max-tokens 50000 Ship feature X');
    expect(session.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ budgetLimits: { tokenBudget: 50000 } }),
    );
  });

  it('rejects too-long objectives before any SDK call', async () => {
    await handleGoalCommand(host, 'x'.repeat(4001));
    expect(host.showError).toHaveBeenCalled();
    expect(session.createGoal).not.toHaveBeenCalled();
  });

  it('/goal replace passes replace: true', async () => {
    await handleGoalCommand(host, 'replace Ship feature Y');
    expect(session.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship feature Y', replace: true }),
    );
  });

  it('surfaces duplicate-goal errors with replace guidance', async () => {
    session.createGoal.mockRejectedValueOnce(
      new KimiError(ErrorCodes.GOAL_ALREADY_EXISTS, 'exists'),
    );
    await handleGoalCommand(host, 'Ship feature X');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('/goal replace'));
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal pause calls pauseGoal and does not send input', async () => {
    await handleGoalCommand(host, 'pause');
    expect(session.pauseGoal).toHaveBeenCalledOnce();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('/goal resume calls resumeGoal and sends a resume input', async () => {
    await handleGoalCommand(host, 'resume');
    expect(session.resumeGoal).toHaveBeenCalledOnce();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Resume the active goal.');
  });

  it('/goal cancel calls cancelGoal and does not send input', async () => {
    await handleGoalCommand(host, 'cancel');
    expect(session.cancelGoal).toHaveBeenCalledOnce();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('status/pause/cancel work without a configured model', async () => {
    const { host: noModelHost, session: s } = makeHost({ model: '' });
    await handleGoalCommand(noModelHost, 'status');
    await handleGoalCommand(noModelHost, 'pause');
    await handleGoalCommand(noModelHost, 'cancel');
    expect(s.getGoal).toHaveBeenCalled();
    expect(s.pauseGoal).toHaveBeenCalled();
    expect(s.cancelGoal).toHaveBeenCalled();
    expect(noModelHost.showError).not.toHaveBeenCalled();
  });

  it('creation without a configured model shows LLM_NOT_SET_MESSAGE', async () => {
    const { host: noModelHost, session: s } = makeHost({ model: '' });
    await handleGoalCommand(noModelHost, 'Ship feature X');
    expect(noModelHost.showError).toHaveBeenCalled();
    expect(s.createGoal).not.toHaveBeenCalled();
  });

  it('creation without an active session shows LLM_NOT_SET_MESSAGE', async () => {
    const { host: noSessionHost, session: s } = makeHost({ hasSession: false });
    await handleGoalCommand(noSessionHost, 'Ship feature X');
    expect(noSessionHost.showError).toHaveBeenCalled();
    expect(s.createGoal).not.toHaveBeenCalled();
  });
});

describe('dispatchInput /goal integration', () => {
  afterEach(() => {
    setExperimentalFlags({});
  });

  it('routes /goal through the real resolver, creates the goal, and sends the objective', async () => {
    setExperimentalFlags({ 'goal-command': true });
    const { host, session } = makeHost();

    dispatchInput(host, '/goal Ship feature X');

    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalledWith(
        expect.objectContaining({ objective: 'Ship feature X' }),
      );
    });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    expect(host.sendNormalUserInput).not.toHaveBeenCalledWith('/goal Ship feature X');
  });

  it('treats /goal as a normal message when the flag is disabled', async () => {
    setExperimentalFlags({});
    const { host, session } = makeHost();

    dispatchInput(host, '/goal Ship feature X');

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('/goal Ship feature X');
    });
    expect(session.createGoal).not.toHaveBeenCalled();
  });
});

describe('goalArgumentCompletions', () => {
  function values(prefix: string): string[] | null {
    const items = goalArgumentCompletions(prefix);
    return items === null ? null : items.map((i) => i.value);
  }

  it('offers every subcommand and budget flag for an empty prefix', () => {
    expect(values('')).toEqual([
      'status',
      'pause',
      'resume',
      'cancel',
      'replace',
      '--max-turns',
      '--max-tokens',
      '--max-minutes',
    ]);
  });

  it('prefix-filters subcommands case-insensitively', () => {
    expect(values('pa')).toEqual(['pause']);
    expect(values('RE')).toEqual(['resume', 'replace']);
  });

  it('prefix-filters budget flags', () => {
    expect(values('--max-t')).toEqual(['--max-turns', '--max-tokens']);
  });

  it('returns items whose value/label are the token itself', () => {
    const items = goalArgumentCompletions('paus');
    expect(items).toEqual([
      { value: 'pause', label: 'pause', description: 'Pause the active goal' },
    ]);
  });

  it('suppresses the menu once a token is fully typed and unambiguous', () => {
    // `status` is the sole match and equals the prefix exactly, so there is
    // nothing left to complete: the menu hides and Enter submits `/goal status`
    // instead of confirming a no-op completion.
    expect(values('status')).toBeNull();
    expect(values('pause')).toBeNull();
    expect(values('--max-turns')).toBeNull();
    // `re` still has two completions, so the menu stays open.
    expect(values('re')).toEqual(['resume', 'replace']);
  });

  it('stops completing once past the first token (space typed)', () => {
    expect(values('pause ')).toBeNull();
    expect(values('replace Ship feature')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(values('zzz')).toBeNull();
  });
});
