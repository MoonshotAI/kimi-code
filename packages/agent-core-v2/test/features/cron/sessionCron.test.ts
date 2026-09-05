import { describe, expect, it } from 'vitest';

import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentCronService } from '#/features/cron/cronService';
import { CronCursor } from '#/features/cron/cronOps';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';

async function bootCronContext(options: TestAgentOptions = {}): Promise<TestAgentContext> {
  const ctx = createTestAgent(options);
  ctx.kimiConfig = {
    ...ctx.kimiConfig,
    cron: { debug: false, noJitter: true, noStale: false, disabled: false, manualTick: true },
  };
  return ctx;
}

describe('session cron wire persistence', () => {
  it('writes cron ops as durable wire records and rebuilds the task table on replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = await bootCronContext({ persistence });
    try {
      await first.restorePersisted();

      const cron = first.get(IAgentCronService);
      const task = cron.addTask({ cron: '0 9 * * *', prompt: 'wire me', recurring: true });
      await first.dispatcher.dispatch(new CronCursor({ id: task.id, lastFiredAt: 1234 }));
      await first.dispatcher.flush();

      const types = persistence.records.map((record) => record.type);
      expect(types).toContain('cron.add');
      expect(types).toContain('cron.cursor');
    } finally {
      await first.dispose();
    }

    const second = await bootCronContext({
      persistence: new InMemoryWireRecordPersistence(persistence.records),
    });
    try {
      await second.restorePersisted();

      const resumed = second.get(IAgentCronService);
      const rebuilt = resumed.list();
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]).toMatchObject({
        cron: '0 9 * * *',
        prompt: 'wire me',
        recurring: true,
        lastFiredAt: 1234,
      });
    } finally {
      await second.dispose();
    }
  });

  it('drops deleted tasks on replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = await bootCronContext({ persistence });
    try {
      await first.restorePersisted();

      const cron = first.get(IAgentCronService);
      const kept = cron.addTask({ cron: '0 9 * * *', prompt: 'keep', recurring: true });
      const dropped = cron.addTask({ cron: '0 10 * * *', prompt: 'drop', recurring: true });
      cron.removeTasks([dropped.id]);
      await first.dispatcher.flush();

      const types = persistence.records.map((record) => record.type);
      expect(types).toContain('cron.delete');
      expect(kept.id).not.toBe(dropped.id);
    } finally {
      await first.dispose();
    }

    const second = await bootCronContext({
      persistence: new InMemoryWireRecordPersistence(persistence.records),
    });
    try {
      await second.restorePersisted();

      const resumed = second.get(IAgentCronService);
      expect(resumed.list().map((task) => task.prompt)).toEqual(['keep']);
    } finally {
      await second.dispose();
    }
  });

  it('activates effects once after restore and cleans them up on close', async () => {
    const ctx = await bootCronContext();
    const registry = ctx.get(IAgentToolRegistryService);
    let disposed = false;
    try {
      expect(registry.listReferences().filter((tool) => tool.name.startsWith('Cron'))).toEqual([
        { name: 'CronCreate', source: 'builtin' },
        { name: 'CronDelete', source: 'builtin' },
        { name: 'CronList', source: 'builtin' },
      ]);
      await expect(ctx.get(IAgentCronService).tick()).rejects.toThrow('not restored');

      await ctx.restorePersisted();

      await expect(ctx.get(IAgentCronService).tick()).resolves.toBeUndefined();

      await ctx.dispose();
      disposed = true;

      expect(() => ctx.get(IAgentCronService)).toThrow();
    } finally {
      if (!disposed) await ctx.dispose();
    }
  });

  it('stops the poll timer on dispose without unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const ctx = createTestAgent();
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      cron: {
        debug: false,
        noJitter: true,
        noStale: false,
        disabled: false,
        manualTick: false,
        pollIntervalMs: 10,
      },
    };
    let disposed = false;
    try {
      await ctx.restorePersisted();
      const cron = ctx.get(IAgentCronService);
      cron.addTask({ cron: '* * * * *', prompt: 'poll me', recurring: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await ctx.dispose();
      disposed = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      if (!disposed) await ctx.dispose();
    }
  });
});
