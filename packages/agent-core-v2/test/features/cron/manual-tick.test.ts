import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentCron, type CronRuntime } from '#/features/cron/cronAgentRuntime';
import type { CronConfig } from '#/features/cron/configSection';

import { createTestAgent, type TestAgentContext } from '../../harness';

const WALL_ANCHOR = 1_700_000_000_000;

interface CronTestRig {
  readonly ctx: TestAgentContext;
  readonly cron: CronRuntime;
  readonly prompt: IAgentPromptService;
  readonly clockFile: string;
}

async function bootCronRig(config: Partial<CronConfig> = {}): Promise<CronTestRig> {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-cron-manual-'));
  const clockFile = join(dir, 'clock.txt');
  writeFileSync(clockFile, String(WALL_ANCHOR));
  const ctx = createTestAgent();
  const cronConfig: CronConfig = {
    debug: false,
    noJitter: true,
    noStale: false,
    disabled: false,
    manualTick: true,
    ...config,
    clock: `file:${clockFile}`,
  };
  ctx.kimiConfig = { ...ctx.kimiConfig, cron: cronConfig };
  await ctx.restorePersisted();
  return {
    ctx,
    cron: ctx.resolve(AgentCron),
    prompt: ctx.get(IAgentPromptService),
    clockFile,
  };
}

function advance(clockFile: string, ms: number): void {
  const now = Number(readFileSync(clockFile, 'utf8').trim());
  writeFileSync(clockFile, String(now + ms));
}

function spySteer(prompt: IAgentPromptService) {
  return vi
    .spyOn(prompt, 'inject')
    .mockImplementation(async (_message: ContextMessage) => undefined);
}

describe('AgentCron — manual tick + SIGUSR1', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('manualTick: true', () => {
    let rig: CronTestRig;

    afterEach(async () => {
      await rig.ctx.dispose();
    });

    it('does not install a poll timer; tick() must be called manually', async () => {
      rig = await bootCronRig();
      const steerSpy = spySteer(rig.prompt);

      rig.cron.addTask({ cron: '*/5 * * * *', prompt: 'manual-only' });
      advance(rig.clockFile, 6 * 60_000);

      await new Promise((r) => setTimeout(r, 50));
      expect(steerSpy).toHaveBeenCalledTimes(0);

      await rig.cron.tick();
      expect(steerSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('manualTick: false', () => {
    let rig: CronTestRig;

    afterEach(async () => {
      await rig.ctx.dispose();
    });

    it('auto-tick fires on the poll interval without an explicit tick', async () => {
      rig = await bootCronRig({ manualTick: false, pollIntervalMs: 20 });
      const steerSpy = spySteer(rig.prompt);

      rig.cron.addTask({ cron: '*/5 * * * *', prompt: 'auto-tick' });
      advance(rig.clockFile, 6 * 60_000);

      await vi.waitFor(() => {
        expect(steerSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('SIGUSR1', () => {
    describe('manual tick enabled', () => {
      let rig: CronTestRig;
      let listenerCountBeforeCreate: number;

      afterEach(async () => {
        await rig.ctx.dispose();
      });

      it('binds one listener on restore and triggers a tick per emit', async () => {
        if (process.platform === 'win32') return;
        listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
        rig = await bootCronRig();
        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);

        const steerSpy = spySteer(rig.prompt);
        rig.cron.addTask({ cron: '*/5 * * * *', prompt: 'signal-fired' });

        advance(rig.clockFile, 6 * 60_000);
        process.emit('SIGUSR1', 'SIGUSR1');
        await vi.waitFor(() => {
          expect(steerSpy).toHaveBeenCalledTimes(1);
        });

        advance(rig.clockFile, 5 * 60_000);
        process.emit('SIGUSR1', 'SIGUSR1');
        await vi.waitFor(() => {
          expect(steerSpy).toHaveBeenCalledTimes(2);
        });
      });

      it('does not write to stderr when a steer fails and debug is off', async () => {
        if (process.platform === 'win32') return;
        rig = await bootCronRig();
        const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
          vi.spyOn(rig.prompt, 'inject').mockImplementation(async () => {
            throw new Error('silent-boom');
          });
          rig.cron.addTask({ cron: '*/5 * * * *', prompt: 'failing-steer' });
          advance(rig.clockFile, 6 * 60_000);

          process.emit('SIGUSR1', 'SIGUSR1');
          await vi.waitFor(() => {
            expect(rig.prompt.inject).toHaveBeenCalledTimes(1);
          });

          const calls = writeSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((s) => /cron\/session/.test(s))).toBe(false);
          expect(calls.some((s) => s.includes('silent-boom'))).toBe(false);
        } finally {
          writeSpy.mockRestore();
        }
      });

      it('logs a swallowed steer failure to stderr when debug is on', async () => {
        if (process.platform === 'win32') return;
        rig = await bootCronRig({ debug: true });
        const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
          vi.spyOn(rig.prompt, 'inject').mockImplementation(async () => {
            throw new Error('debug-boom');
          });
          rig.cron.addTask({ cron: '*/5 * * * *', prompt: 'failing-steer' });
          advance(rig.clockFile, 6 * 60_000);

          process.emit('SIGUSR1', 'SIGUSR1');
          await vi.waitFor(() => {
            const calls = writeSpy.mock.calls.map((c) => String(c[0]));
            expect(calls.some((s) => /cron\/session/.test(s) && s.includes('debug-boom'))).toBe(
              true,
            );
          });
        } finally {
          writeSpy.mockRestore();
        }
      });

      it('dispose removes the SIGUSR1 listener (no leak)', async () => {
        if (process.platform === 'win32') return;
        listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
        rig = await bootCronRig();
        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);
        await rig.ctx.dispose();
        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate);
      });
    });

    describe('manual tick disabled', () => {
      let rig: CronTestRig;

      afterEach(async () => {
        await rig.ctx.dispose();
      });

      it('does not bind a SIGUSR1 listener', async () => {
        if (process.platform === 'win32') return;
        const before = process.listenerCount('SIGUSR1');
        rig = await bootCronRig({ manualTick: false, pollIntervalMs: null });
        expect(process.listenerCount('SIGUSR1')).toBe(before);
      });
    });
  });
});
