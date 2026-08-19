import { describe, expect, it } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
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
});
