import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IEventService } from '#/event';
import { ISessionService } from '#/session';
import { SessionService } from '#/session/sessionService';
import { ISessionContext } from '#/session-context';
import { ISessionMetadata } from '#/session-metadata';

const handle: IScopeHandle = {
  id: 'main',
  kind: LifecycleScope.Agent,
  accessor: { get: () => ({}) } as unknown as ServicesAccessor,
  dispose: () => {},
};

function makeContext(): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 's1',
    workspaceId: 'wd_test',
    sessionDir: '/tmp/sessions/wd_test/s1',
    metaScope: 'sessions/wd_test/s1/session-meta',
  };
}

describe('SessionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, makeContext());
        reg.define(ISessionService, SessionService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('archive sets the flag, removes agents, and publishes the event', async () => {
    let archived: boolean | undefined;
    const removed: string[] = [];
    const published: { type: string; payload: unknown }[] = [];

    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      read: () =>
        Promise.resolve({ id: 's1', createdAt: 0, updatedAt: 0, archived: false }),
      update: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setArchived: (value: boolean) => {
        archived = value;
        return Promise.resolve();
      },
    });
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      create: () => Promise.resolve(handle),
      createMain: () => Promise.resolve(handle),
      getHandle: () => handle,
      list: () => [handle],
      remove: (id: string) => {
        removed.push(id);
        return Promise.resolve();
      },
    });
    ix.stub(IEventService, {
      publish: (event: { type: string; payload: unknown }) => published.push(event),
    });

    await ix.get(ISessionService).archive();

    expect(archived).toBe(true);
    expect(removed).toEqual(['main']);
    expect(published).toEqual([
      { type: 'event.session.archived', payload: { sessionId: 's1' } },
    ]);
  });
});
