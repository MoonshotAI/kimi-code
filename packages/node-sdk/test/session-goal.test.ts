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
  it('createGoal forwards the supported payload with sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.createGoal({
      objective: 'Ship feature X',
      replace: true,
    });
    expect(rpc.createGoal).toHaveBeenCalledWith({
      sessionId: 'ses_goal',
      objective: 'Ship feature X',
      replace: true,
    });
  });

  it('getGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.getGoal();
    expect(rpc.getGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('pauseGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.pauseGoal();
    expect(rpc.pauseGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('resumeGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.resumeGoal();
    expect(rpc.resumeGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('cancelGoal forwards sessionId', async () => {
    const { session, rpc } = makeSession();
    await session.cancelGoal();
    expect(rpc.cancelGoal).toHaveBeenCalledWith({ sessionId: 'ses_goal' });
  });

  it('does not expose a public clearGoal or updateGoal method', () => {
    const { session } = makeSession();
    expect((session as unknown as { clearGoal?: unknown }).clearGoal).toBeUndefined();
    expect((session as unknown as { updateGoal?: unknown }).updateGoal).toBeUndefined();
  });
});
