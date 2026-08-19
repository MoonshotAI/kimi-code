import { describe, expect, it } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import type { CronTask } from '#/app/cron/cronTask';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { CronCursor } from '#/session/cron/cronOps';
import { ISessionCronService } from '#/session/cron/sessionCronService';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  sessionService,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';

interface CronHarness {
  readonly ctx: TestAgentContext;
  readonly onDidCreate: Emitter<IAgentScopeHandle>;
}

async function bootCronContext(options: TestAgentOptions = {}): Promise<CronHarness> {
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  let mainHandle: IAgentScopeHandle | undefined;
  const lifecycleStub: IAgentLifecycleService = {
    _serviceBrand: undefined,
    onDidCreate: onDidCreate.event,
    onDidDispose: Event.None as Event<string>,
    create: () => Promise.reject(new Error('not supported in this test')),
    fork: () => Promise.reject(new Error('not supported in this test')),
    get: (agentId) => (agentId === 'main' ? mainHandle : undefined),
    list: () => (mainHandle === undefined ? [] : [mainHandle]),
    broadcastPermissionMode: () => {},
    remove: () => Promise.resolve(),
  };
  const ctx = createTestAgent(options, sessionService(IAgentLifecycleService, lifecycleStub));
  ctx.kimiConfig = {
    ...ctx.kimiConfig,
    cron: { debug: false, noJitter: true, noStale: false, disabled: false, manualTick: true },
  };
  const accessor = {
    get: <T,>(id: ServiceIdentifier<T>): T => ctx.get(id),
  };
  mainHandle = { id: 'main', kind: LifecycleScope.Agent, accessor, dispose: () => {} };
  onDidCreate.fire(mainHandle);
  return { ctx, onDidCreate };
}

describe('session cron wire persistence', () => {
  it('writes cron ops as durable wire records and rebuilds the task table on replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = await bootCronContext({ persistence });
    try {
      await first.ctx.restorePersisted();

      const cron = first.ctx.get(ISessionCronService);
      const task = cron.addTask({ cron: '0 9 * * *', prompt: 'wire me', recurring: true });
      await first.ctx.dispatcher.dispatch(new CronCursor({ id: task.id, lastFiredAt: 1234 }));
      await first.ctx.dispatcher.flush();

      const types = persistence.records.map((record) => record.type);
      expect(types).toContain('cron.add');
      expect(types).toContain('cron.cursor');
    } finally {
      await first.ctx.dispose();
      first.onDidCreate.dispose();
    }

    const second = await bootCronContext({
      persistence: new InMemoryWireRecordPersistence(persistence.records),
    });
    try {
      await second.ctx.restorePersisted();

      const resumed = second.ctx.get(ISessionCronService);
      const rebuilt = resumed.list();
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]).toMatchObject({
        cron: '0 9 * * *',
        prompt: 'wire me',
        recurring: true,
        lastFiredAt: 1234,
      });
    } finally {
      await second.ctx.dispose();
      second.onDidCreate.dispose();
    }
  });

  it('drops deleted tasks on replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = await bootCronContext({ persistence });
    try {
      await first.ctx.restorePersisted();

      const cron = first.ctx.get(ISessionCronService);
      const kept = cron.addTask({ cron: '0 9 * * *', prompt: 'keep', recurring: true });
      const dropped = cron.addTask({ cron: '0 10 * * *', prompt: 'drop', recurring: true });
      cron.removeTasks([dropped.id]);
      await first.ctx.dispatcher.flush();

      const types = persistence.records.map((record) => record.type);
      expect(types).toContain('cron.delete');
      expect(kept.id).not.toBe(dropped.id);
    } finally {
      await first.ctx.dispose();
      first.onDidCreate.dispose();
    }

    const second = await bootCronContext({
      persistence: new InMemoryWireRecordPersistence(persistence.records),
    });
    try {
      await second.ctx.restorePersisted();

      const resumed = second.ctx.get(ISessionCronService);
      expect(resumed.list().map((task) => task.prompt)).toEqual(['keep']);
    } finally {
      await second.ctx.dispose();
      second.onDidCreate.dispose();
    }
  });

  it('migrates legacy cron task files into the wire on first restore', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const { ctx, onDidCreate } = await bootCronContext({ persistence });
    try {
      const atomicDocs = ctx.get(IAtomicDocumentStore);
      const scope = 'cron/test-workspace';
      const owned: CronTask = {
        id: 'aa11bb22',
        cron: '0 9 * * *',
        prompt: 'legacy owned',
        createdAt: 1,
        tags: { sessionId: 'test-session' },
      };
      const ownerless: CronTask = {
        id: 'bb22cc33',
        cron: '0 10 * * *',
        prompt: 'legacy ownerless',
        createdAt: 2,
      };
      const foreign: CronTask = {
        id: 'cc33dd44',
        cron: '0 11 * * *',
        prompt: 'legacy foreign',
        createdAt: 3,
        tags: { sessionId: 'other-session' },
      };
      await atomicDocs.set(scope, 'aa11bb22.json', owned);
      await atomicDocs.set(scope, 'bb22cc33.json', ownerless);
      await atomicDocs.set(scope, 'cc33dd44.json', foreign);

      await ctx.restorePersisted();

      const cron = ctx.get(ISessionCronService);
      expect(cron.list().map((task) => task.id).sort()).toEqual(['aa11bb22', 'bb22cc33']);
      const migratedIds = persistence.records
        .filter((record) => record.type === 'cron.add')
        .map((record) => (record['task'] as { id: string }).id)
        .sort();
      expect(migratedIds).toEqual(['aa11bb22', 'bb22cc33']);
      expect(await atomicDocs.get(scope, 'aa11bb22.json')).toBeUndefined();
      expect(await atomicDocs.get(scope, 'bb22cc33.json')).toBeUndefined();
      expect(await atomicDocs.get(scope, 'cc33dd44.json')).toBeDefined();
    } finally {
      await ctx.dispose();
      onDidCreate.dispose();
    }
  });
});
