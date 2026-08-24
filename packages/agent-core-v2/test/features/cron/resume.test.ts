import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentCron, type CronRuntime } from '#/features/cron/cronAgentRuntime';
import type { CronConfig } from '#/features/cron/configSection';
import { CronCursor } from '#/features/cron/cronOps';
import type { ContentPart } from '#/kosong/contract/message';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import type { WireRecord } from '#/wire/record';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

const WALL_ANCHOR = 1_700_000_000_000;

interface SteerCall {
  readonly content: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

interface ResumeRig {
  readonly persistence: InMemoryWireRecordPersistence;
  readonly clockFile: string;
  readonly contexts: TestAgentContext[];
}

function makeRig(): ResumeRig {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-cron-resume-'));
  const clockFile = join(dir, 'clock.txt');
  writeFileSync(clockFile, String(WALL_ANCHOR));
  return {
    persistence: new InMemoryWireRecordPersistence([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
    ]),
    clockFile,
    contexts: [],
  };
}

async function bootCtx(rig: ResumeRig): Promise<TestAgentContext> {
  const ctx = createTestAgent({ persistence: rig.persistence });
  const cronConfig: CronConfig = {
    debug: false,
    noJitter: true,
    noStale: false,
    disabled: false,
    manualTick: false,
    pollIntervalMs: null,
    clock: `file:${rig.clockFile}`,
  };
  ctx.kimiConfig = { ...ctx.kimiConfig, cron: cronConfig };
  await ctx.restorePersisted();
  rig.contexts.push(ctx);
  return ctx;
}

function setClock(rig: ResumeRig, ms: number): void {
  writeFileSync(rig.clockFile, String(ms));
}

function captureSteer(ctx: TestAgentContext): SteerCall[] {
  const calls: SteerCall[] = [];
  const prompt = ctx.get(IAgentPromptService);
  vi.spyOn(prompt, 'inject').mockImplementation(async (message: ContextMessage) => {
    calls.push({ content: message.content, origin: message.origin as PromptOrigin });
    return undefined;
  });
  return calls;
}

function recordsOfType(persistence: InMemoryWireRecordPersistence, type: string): WireRecord[] {
  return persistence.records.filter((record) => record.type === type);
}

describe('AgentCron — persistence and resume', () => {
  let rig: ResumeRig;

  afterEach(async () => {
    for (const ctx of rig.contexts.splice(0)) {
      await ctx.dispose();
    }
    vi.restoreAllMocks();
  });

  describe('single session persistence', () => {
    it('addTask persists the task as a durable cron.add record', async () => {
      rig = makeRig();
      const ctx = await bootCtx(rig);
      const cron = ctx.resolve(AgentCron);

      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'ping' });
      await ctx.dispatcher.flush();

      const adds = recordsOfType(rig.persistence, 'cron.add');
      expect(adds).toHaveLength(1);
      expect(adds[0]).toMatchObject({
        task: {
          id: task.id,
          cron: '*/5 * * * *',
          prompt: 'ping',
          createdAt: WALL_ANCHOR,
        },
      });
    });

    it('removeTasks appends a durable cron.delete record', async () => {
      rig = makeRig();
      const ctx = await bootCtx(rig);
      const cron = ctx.resolve(AgentCron);

      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
      await ctx.dispatcher.flush();
      expect(recordsOfType(rig.persistence, 'cron.add')).toHaveLength(1);

      cron.removeTasks([task.id]);
      await ctx.dispatcher.flush();
      expect(recordsOfType(rig.persistence, 'cron.delete')).toEqual([
        expect.objectContaining({ ids: [task.id] }),
      ]);
    });
  });

  describe('restore re-adoption', () => {
    it('re-adopts tasks with original id and createdAt', async () => {
      rig = makeRig();
      const first = await bootCtx(rig);
      const cron = first.resolve(AgentCron);
      const t1 = cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
      const t2 = cron.addTask({ cron: '0 9 * * *', prompt: 'b', recurring: true });
      await first.dispatcher.flush();

      setClock(rig, WALL_ANCHOR + 60_000);
      const second = await bootCtx(rig);
      const resumed = second.resolve(AgentCron);

      const loaded = resumed.list().slice().toSorted((a, b) => a.id.localeCompare(b.id));
      const expected = [t1, t2].toSorted((a, b) => a.id.localeCompare(b.id));
      expect(loaded.map((t) => t.id)).toEqual(expected.map((t) => t.id));
      for (const original of expected) {
        const reloaded = resumed.getTask(original.id);
        expect(reloaded).toBeDefined();
        expect(reloaded?.cron).toBe(original.cron);
        expect(reloaded?.prompt).toBe(original.prompt);
        expect(reloaded?.createdAt).toBe(original.createdAt);
      }
    });
  });

  describe('recurring resume fire', () => {
    it('recurring task missed during downtime fires once with coalescedCount > 1', async () => {
      rig = makeRig();
      const first = await bootCtx(rig);
      first.resolve(AgentCron).addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await first.dispatcher.flush();

      setClock(rig, WALL_ANCHOR + 23 * 60_000);
      const second = await bootCtx(rig);
      const resumed = second.resolve(AgentCron);

      const steerCalls = captureSteer(second);
      await resumed.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.coalescedCount).toBeGreaterThan(1);
      expect(origin.stale).toBe(false);
      expect(origin.recurring).toBe(true);
    });
  });

  describe('one-shot resume fire', () => {
    it('one-shot scheduled in the past fires once on resume and is removed', async () => {
      rig = makeRig();
      const first = await bootCtx(rig);
      const oneShot = first
        .resolve(AgentCron)
        .addTask({ cron: '*/5 * * * *', prompt: 'remind once', recurring: false });
      await first.dispatcher.flush();
      expect(recordsOfType(rig.persistence, 'cron.add')).toEqual([
        expect.objectContaining({ task: expect.objectContaining({ id: oneShot.id }) }),
      ]);

      setClock(rig, WALL_ANCHOR + 10 * 60_000);
      const second = await bootCtx(rig);
      const resumed = second.resolve(AgentCron);

      const steerCalls = captureSteer(second);
      await resumed.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.recurring).toBe(false);
      expect(origin.coalescedCount).toBe(1);

      expect(resumed.list()).toEqual([]);
      await second.dispatcher.flush();
      expect(recordsOfType(rig.persistence, 'cron.delete')).toEqual([
        expect.objectContaining({ ids: [oneShot.id] }),
      ]);
    });
  });

  describe('recurring task already fired before shutdown', () => {
    it('does NOT replay the fired slot on resume', async () => {
      rig = makeRig();
      const first = await bootCtx(rig);
      const cron = first.resolve(AgentCron);
      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await first.dispatcher.flush();

      const steerCallsA = captureSteer(first);
      setClock(rig, WALL_ANCHOR + 6 * 60_000);
      await cron.tick();
      expect(steerCallsA.length).toBe(1);
      await first.dispatcher.flush();

      const cursors = recordsOfType(rig.persistence, 'cron.cursor');
      expect(cursors).toEqual([
        expect.objectContaining({ id: task.id, lastFiredAt: expect.any(Number) }),
      ]);
      const lastFiredAt = cursors[0]!['lastFiredAt'] as number;
      expect(lastFiredAt).toBeLessThanOrEqual(WALL_ANCHOR + 6 * 60_000);

      setClock(rig, WALL_ANCHOR + 23 * 60_000);
      const second = await bootCtx(rig);
      const resumed = second.resolve(AgentCron);

      const steerCallsB = captureSteer(second);
      await resumed.tick();

      expect(steerCallsB.length).toBe(1);
      const resumeOrigin = steerCallsB[0]!.origin;
      if (resumeOrigin.kind !== 'cron_job') throw new Error('unreachable');
      expect(resumeOrigin.coalescedCount).toBeLessThanOrEqual(4);
      expect(resumeOrigin.coalescedCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('corrupt lastFiredAt', () => {
    it('treats a future lastFiredAt as corrupt and falls back to createdAt', async () => {
      rig = makeRig();
      const first = await bootCtx(rig);
      const cron = first.resolve(AgentCron);
      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await first.dispatcher.dispatch(
        new CronCursor({ id: task.id, lastFiredAt: WALL_ANCHOR + 365 * 24 * 60 * 60 * 1000 }),
      );
      await first.dispatcher.flush();

      setClock(rig, WALL_ANCHOR + 23 * 60_000);
      const second = await bootCtx(rig);
      const resumed: CronRuntime = second.resolve(AgentCron);

      const steerCalls = captureSteer(second);
      await resumed.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.coalescedCount).toBeGreaterThan(1);
    });
  });
});
