import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { ISessionActivity } from '#/session-activity/sessionActivity';
import { SessionActivity } from '#/session-activity/sessionActivityService';
import { stubTurn } from '../turn/stubs';

function handle(id: string, active: boolean): IScopeHandle {
  const turn = stubTurn({ hasActiveTurn: active, currentId: active ? id : undefined });
  const accessor = { get: () => turn } as unknown as ServicesAccessor;
  return { id, kind: LifecycleScope.Agent, accessor };
}

function lifecycle(handles: readonly IScopeHandle[]): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    create: () => Promise.resolve(handles[0]!),
    createMain: () => Promise.resolve(handles[0]!),
    getHandle: () => undefined,
    list: () => handles,
    remove: () => Promise.resolve(),
  };
}

describe('SessionActivity', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(ISessionActivity, SessionActivity);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('idle when no agents', () => {
    ix.stub(IAgentLifecycleService, lifecycle([]));
    expect(ix.get(ISessionActivity).isIdle()).toBe(true);
  });

  it('idle when all agents idle', () => {
    ix.stub(IAgentLifecycleService, lifecycle([handle('a', false)]));
    expect(ix.get(ISessionActivity).isIdle()).toBe(true);
  });

  it('not idle when any agent has an active turn', () => {
    ix.stub(
      IAgentLifecycleService,
      lifecycle([handle('a', false), handle('b', true)]),
    );
    expect(ix.get(ISessionActivity).isIdle()).toBe(false);
  });
});
