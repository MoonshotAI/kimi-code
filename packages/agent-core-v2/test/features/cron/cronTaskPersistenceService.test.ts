import { describe, expect, it } from 'vitest';

import { AgentCron } from '#/features/cron/cronAgentRuntime';
import { CronAdd } from '#/features/cron/cronOps';
import type { CronTask } from '#/features/cron/cronTask';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import type { WireRecord } from '#/wire/record';

import { createTestAgent, InMemoryWireRecordPersistence } from '../../harness';

const validTask: CronTask = {
  id: '01HF7YAT00TP4QF6RDFFZR3QJ7',
  cron: '*/5 * * * *',
  prompt: 'ping',
  createdAt: 1_700_000_000_000,
  recurring: true,
};

function parseCronAdd(payload: unknown): boolean {
  return CronAdd.schema?.safeParse(payload).success ?? false;
}

describe('cron.add payload guards', () => {
  describe('schema validation', () => {
    it('accepts a fully specified recurring task', () => {
      expect(parseCronAdd({ task: validTask })).toBe(true);
    });

    it('accepts a task with omitted recurring', () => {
      const { recurring: _recurring, ...withoutRecurring } = validTask;
      expect(parseCronAdd({ task: withoutRecurring })).toBe(true);
    });

    it('accepts an explicit one-shot task', () => {
      expect(parseCronAdd({ task: { ...validTask, recurring: false } })).toBe(true);
    });

    it('rejects non-object tasks', () => {
      expect(parseCronAdd({ task: null })).toBe(false);
      expect(parseCronAdd({ task: undefined })).toBe(false);
      expect(parseCronAdd({ task: 'hello' })).toBe(false);
      expect(parseCronAdd({ task: 42 })).toBe(false);
    });

    it('rejects missing and wrong-typed fields', () => {
      const { cron: _cron, ...withoutCron } = validTask;
      const { prompt: _prompt, ...withoutPrompt } = validTask;

      expect(parseCronAdd({ task: withoutCron })).toBe(false);
      expect(parseCronAdd({ task: withoutPrompt })).toBe(false);
      expect(parseCronAdd({ task: { ...validTask, createdAt: 'recent' } })).toBe(false);
      expect(parseCronAdd({ task: { ...validTask, recurring: 'yes' } })).toBe(false);
      expect(parseCronAdd({ task: { ...validTask, lastFiredAt: Number.NaN } })).toBe(false);
    });
  });

  describe('restore replay', () => {
    it('adopts well-formed cron.add records and skips malformed ones', async () => {
      const records: WireRecord[] = [
        { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
        { type: 'cron.add', task: validTask },
        { type: 'cron.add', task: { id: 'broken' } },
        { type: 'cron.add', task: { ...validTask, id: '01HF7YAT00TP4QF6RDFFZR3QJ8', createdAt: 'recent' } },
      ];
      const ctx = createTestAgent({ persistence: new InMemoryWireRecordPersistence(records) });
      try {
        await ctx.restorePersisted();

        const tasks = ctx.resolve(AgentCron).list();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toEqual(validTask);
      } finally {
        await ctx.dispose();
      }
    });
  });
});
