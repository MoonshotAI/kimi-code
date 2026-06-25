import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IEventService } from '#/event/event';
import { ISessionActivity } from '#/session-activity/sessionActivity';
import { ISessionService } from '#/session/session';
import { SessionService } from '#/session/sessionService';
import { registerRecordsServices } from '../records/stubs';

const handle: IScopeHandle = {
  id: 'main',
  kind: LifecycleScope.Agent,
  accessor: { get: () => ({}) } as unknown as ServicesAccessor,
};

describe('SessionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerRecordsServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IEventService, {});
        reg.define(ISessionService, SessionService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  // NOTE: SessionService is built via createInstance (not get) because
  // "status reflects activity" needs two instances with different
  // ISessionActivity stubs within the same test — a singleton-per-container
  // cannot produce both. See di-testing.md "Exceptions".
  function make(idle: boolean): ISessionService {
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      create: () => Promise.resolve(handle),
      createMain: () => Promise.resolve(handle),
      getHandle: () => handle,
      list: () => [handle],
      remove: () => Promise.resolve(),
    });
    ix.stub(ISessionActivity, { _serviceBrand: undefined, isIdle: () => idle });
    return ix.createInstance(SessionService);
  }

  it('status reflects activity', () => {
    expect(make(true).status()).toBe('idle');
    expect(make(false).status()).toBe('running');
  });

  it('agents delegates to lifecycle', () => {
    expect(make(true).agents()).toEqual([handle]);
  });
});
