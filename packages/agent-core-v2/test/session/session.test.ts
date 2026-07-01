import { describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';
import type { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import type { ISessionActivity } from '#/session-activity/sessionActivity';

import { SessionService } from '#/session/sessionService';

const handle: IScopeHandle = { id: 'main', kind: 2, accessor: { get: () => ({}) } as ServicesAccessor };

function make(idle: boolean): SessionService {
  const agents: IAgentLifecycleService = {
    _serviceBrand: undefined,
    create: () => Promise.resolve(handle),
    createMain: () => Promise.resolve(handle),
    getHandle: () => handle,
    list: () => [handle],
    remove: () => Promise.resolve(),
  };
  const activity: ISessionActivity = { _serviceBrand: undefined, isIdle: () => idle };
  return new SessionService(undefined as never, agents, activity, undefined as never);
}

describe('SessionService', () => {
  it('status reflects activity', () => {
    expect(make(true).status()).toBe('idle');
    expect(make(false).status()).toBe('running');
  });

  it('agents delegates to lifecycle', () => {
    expect(make(true).agents()).toEqual([handle]);
  });
});
