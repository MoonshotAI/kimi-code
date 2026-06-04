import { describe, expect, it, vi } from 'vitest';

import { Session } from '#/session';
import type { SDKRpcClientBase } from '#/rpc';

function makeSession() {
  const rpc = {
    createGoal: vi.fn(async () => ({ goalId: 'g1' })),
    getGoal: vi.fn(async () => ({ goal: null })),
    pauseGoal: vi.fn(async () => ({ goalId: 'g1' })),
    resumeGoal: vi.fn(async () => ({ goalId: 'g1' })),
    cancelGoal: vi.fn(async () => ({ goalId: 'g1' })),
    clearSessionHandlers: vi.fn(),
  } as unknown as SDKRpcClientBase;
  const session = new Session({ id: 'ses_goal', workDir: '/tmp/work', rpc });
  return { session, rpc };
}

describe('Session goal methods', () => {
  it('createGoal forwards the full payload with sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.createGoal({
      objective: 'Ship feature X',
      completionCriterion: 'tests pass',
      budgetLimits: { tokenBudget: 5000 },
      replace: true,
    });
    expect(rpc.createGoal).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      objective: 'Ship feature X',
      completionCriterion: 'tests pass',
      budgetLimits: { tokenBudget: 5000 },
      replace: true,
    });
  });

  it('getGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.getGoal();
    expect(rpc.getGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('pauseGoal forwards a reason', async () => {
    const { session, rpc } = makeSession();
    await session.pauseGoal({ reason: 'taking a break' });
    expect(rpc.pauseGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal', reason: 'taking a break' });
  });

  it('resumeGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.resumeGoal();
    expect(rpc.resumeGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal', reason: undefined });
  });

  it('cancelGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.cancelGoal();
    expect(rpc.cancelGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal', reason: undefined });
  });

  it('does not expose a public clearGoal or updateGoal method', () => {
    const { session } = makeSession();
    expect((session as unknown as { clearGoal?: unknown }).clearGoal).toBeUndefined();
    expect((session as unknown as { updateGoal?: unknown }).updateGoal).toBeUndefined();
  });
});
