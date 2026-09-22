import { describe, expect, it, vi } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
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

function handleWith(checkAgentsBusy: () => IDisposable): ISessionScopeHandle {
  return {
    id: 'session-1',
    accessor: {
      get: (id: unknown) => {
        if (id === IAgentLifecycleService) return { checkAgentsBusy };
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

describe('SessionLifecycleService.checkSessionBusy', () => {
  it('throws resume_in_flight while a resume is in flight', () => {
    const svc = service({ resuming: true });
    expect(thrown(() => svc.checkSessionBusy('session-1'))).toMatchObject({
      code: 'session.busy',
      details: { reason: 'resume_in_flight' },
    });
  });

  it('returns a no-op guard when the session is not loaded', () => {
    const svc = service({});
    const guard = svc.checkSessionBusy('session-1');
    expect(() => guard.dispose()).not.toThrow();
  });

  it('returns the agent guard when all agents are idle', () => {
    const agentGuard = { dispose: vi.fn() };
    const svc = service({ handle: handleWith(() => agentGuard) });
    const guard = svc.checkSessionBusy('session-1');
    guard.dispose();
    expect(agentGuard.dispose).toHaveBeenCalledTimes(1);
  });

  it('passes the agent busy error through unchanged', () => {
    const busy = new Error2(ErrorCodes.SESSION_BUSY, 'Cannot delete while a turn is active or queued.', {
      details: { reason: 'active_turn' },
    });
    const svc = service({
      handle: handleWith(() => {
        throw busy;
      }),
    });
    expect(thrown(() => svc.checkSessionBusy('session-1'))).toBe(busy);
  });
});
