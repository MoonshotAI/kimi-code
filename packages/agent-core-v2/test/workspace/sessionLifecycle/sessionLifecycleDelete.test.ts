import { describe, expect, it, vi } from 'vitest';

import type { ISessionScopeHandle } from '#/_base/di/scope';
import {
  IAgentLifecycleService,
  type AgentDeleteGuardResult,
} from '#/session/agentLifecycle/agentLifecycle';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';

type Internals = {
  resuming: Map<string, Promise<ISessionScopeHandle | undefined>>;
  sessions: Map<string, ISessionScopeHandle>;
};

function service(opts: { resuming?: boolean; handle?: ISessionScopeHandle }): SessionLifecycleService {
  const svc = Object.create(SessionLifecycleService.prototype) as SessionLifecycleService;
  const internals = svc as unknown as Internals;
  internals.resuming = new Map();
  internals.sessions = new Map();
  if (opts.resuming === true) internals.resuming.set('session-1', Promise.resolve(undefined));
  if (opts.handle !== undefined) internals.sessions.set('session-1', opts.handle);
  return svc;
}

function handleWith(check: AgentDeleteGuardResult): ISessionScopeHandle {
  return {
    id: 'session-1',
    accessor: {
      get: (id: unknown) => {
        if (id === IAgentLifecycleService) return { acquireDeleteGuard: () => check };
        throw new Error(`unexpected service request: ${String(id)}`);
      },
    },
  } as unknown as ISessionScopeHandle;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('SessionLifecycleService.beginDeleteIfIdle', () => {
  it('rejects with resume_in_flight while a resume is in flight', () => {
    const svc = service({ resuming: true });
    expect(thrown(() => svc.beginDeleteIfIdle('session-1'))).toMatchObject({
      code: 'session.busy',
      details: { reason: 'resume_in_flight' },
    });
  });

  it('returns a no-op guard when the session is not loaded', () => {
    const svc = service({});
    const guard = svc.beginDeleteIfIdle('session-1');
    expect(() => guard.dispose()).not.toThrow();
  });

  it('returns the agent guard when all agents are idle', () => {
    const agentGuard = { dispose: vi.fn() };
    const svc = service({ handle: handleWith({ idle: true, guard: agentGuard }) });
    const guard = svc.beginDeleteIfIdle('session-1');
    guard.dispose();
    expect(agentGuard.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['active_turn', 'turn is active or queued'],
    ['background_tasks', 'background tasks are running'],
    ['compaction', 'compaction is running'],
  ] as const)('maps agent busy reason %s to SESSION_BUSY details', (reason, messagePart) => {
    const svc = service({ handle: handleWith({ idle: false, reason }) });
    expect(thrown(() => svc.beginDeleteIfIdle('session-1'))).toMatchObject({
      code: 'session.busy',
      details: { reason },
      message: expect.stringContaining(messagePart),
    });
  });
});
