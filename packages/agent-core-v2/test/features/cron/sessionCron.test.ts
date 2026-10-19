import { describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentCronService } from '#/features/cron/cronService';
import { CronCursor } from '#/features/cron/cronOps';
import type { WireRecord } from '#/wire/record';

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

async function restoreCronRecords(records: readonly WireRecord[]): Promise<TestAgentContext> {
  const ctx = await bootCronContext();
  ctx.get(IAgentCronService).list();
  await ctx.restore(records);
  return ctx;
}

describe('session cron wire persistence', () => {
  it('writes cron ops as durable wire records and rebuilds the task table on replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = await bootCronContext({ persistence });
    try {
      await first.restorePersisted();

      const cron = first.get(IAgentCronService);
      const kept = cron.addTask({ cron: '0 9 * * *', prompt: 'keep', recurring: true });
      const dropped = cron.addTask({ cron: '0 10 * * *', prompt: 'drop', recurring: true });
      cron.removeTasks([dropped.id]);
      await first.dispatcher.dispatch(new CronCursor({ id: kept.id, lastFiredAt: 1234 }));
      await first.dispatcher.flush();

      const types = persistence.records.map((record) => record.type);
      expect(types).toContain('cron.add');
      expect(types).toContain('cron.delete');
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
        prompt: 'keep',
        recurring: true,
        lastFiredAt: 1234,
      });
    } finally {
      await second.dispose();
    }
  });

  it('clears inherited tasks at the fork record and delivers the fork-cleared reminder exactly once', async () => {
    const addRecord = (id: string, prompt: string): WireRecord => ({
      type: 'cron.add',
      task: { id, cron: '0 9 * * *', prompt, createdAt: 1000, recurring: true },
    });

    const withInherited = await restoreCronRecords([
      addRecord('seed-inherited', 'inherited'),
      { type: 'forked' },
    ]);
    try {
      expect(withInherited.get(IAgentCronService).list()).toEqual([]);
      const reminder = withInherited.get(IAgentContextMemoryService).get().at(-1);
      expect(reminder?.origin).toEqual({ kind: 'injection', variant: 'cron_fork_cleared' });
      const text = JSON.stringify(reminder?.content);
      expect(text).toContain('This fork does not have any scheduled cron tasks.');
      expect(text).toContain('Tasks from the source session continue to run in the source session.');
    } finally {
      await withInherited.dispose();
    }

    const noTasks = await restoreCronRecords([{ type: 'forked' }]);
    try {
      expect(noTasks.get(IAgentCronService).list()).toEqual([]);
      expect(noTasks.get(IAgentContextMemoryService).get()).toEqual([]);
    } finally {
      await noTasks.dispose();
    }

    const recreated = await restoreCronRecords([
      addRecord('seed-inherited', 'inherited'),
      { type: 'forked' },
      addRecord('seed-recreated', 'recreated'),
    ]);
    try {
      expect(recreated.get(IAgentCronService).list().map((task) => task.prompt)).toEqual([
        'recreated',
      ]);
    } finally {
      await recreated.dispose();
    }

    const delivered = await restoreCronRecords([
      addRecord('seed-inherited', 'inherited'),
      { type: 'forked' },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>\nfork cleared\n</system-reminder>' }],
          toolCalls: [],
          origin: { kind: 'injection', variant: 'cron_fork_cleared' },
        },
      },
    ]);
    try {
      expect(delivered.get(IAgentContextMemoryService).get()).toHaveLength(1);
    } finally {
      await delivered.dispose();
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
