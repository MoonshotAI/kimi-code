import { PRINT_WAIT_CEILING_S_DEFAULT } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import {
  applyPrintBackgroundPolicy,
  createPrintTurnEndings,
  formatTrustGatedMcpWarning,
  PrintSteeredTurnFailedError,
  type PrintTurnEnding,
  type PrintTurnEndings,
} from '#/cli/v2/run-v2-print';

function ending(
  turnId: number,
  reason: PrintTurnEnding['reason'] = 'completed',
): PrintTurnEnding {
  return { type: 'turn.ended', turnId, reason } as unknown as PrintTurnEnding;
}

interface ScriptedEntry {
  readonly event: PrintTurnEnding;
  readonly apply?: () => void;
}

function scriptedTurnEndings(entries: ScriptedEntry[]): PrintTurnEndings {
  const queue = [...entries];
  return {
    next: async (_remainingMs: number, skipTurnId: number) => {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (entry.event.turnId === skipTurnId) continue;
        entry.apply?.();
        return entry.event;
      }
      return null;
    },
  };
}

describe('applyPrintBackgroundPolicy', () => {
  it('exit returns immediately without draining or waiting', async () => {
    const drain = vi.fn(async () => {});
    const countPending = vi.fn(() => 1);
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 60,
      maxTurns: 50,
      countPending,
      drain,
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn: () => {},
      now: () => Date.now(),
    });
    expect(drain).not.toHaveBeenCalled();
    expect(countPending).not.toHaveBeenCalled();
  });

  it('drain drains once and returns', async () => {
    const drain = vi.fn(async () => {});
    await applyPrintBackgroundPolicy({
      mode: 'drain',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => 1,
      drain,
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn: () => {},
      now: () => Date.now(),
    });
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('steer returns once background tasks are quiescent', async () => {
    let pending = 1;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => pending,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        { event: ending(1) },
        { event: ending(2), apply: () => { pending = 0; } },
      ]),
      skipTurnId: 1,
      warn,
      now: () => Date.now(),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('steer finishes with a warning when max turns is reached', async () => {
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 60,
      maxTurns: 2,
      countPending: () => 1,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([{ event: ending(2) }, { event: ending(3) }]),
      skipTurnId: 1,
      warn,
      now: () => Date.now(),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('max turns');
  });

  it('steer finishes with a warning when the ceiling is reached', async () => {
    let now = 0;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 10,
      maxTurns: 50,
      countPending: () => 1,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { now = 10_001; } },
      ]),
      skipTurnId: 1,
      warn,
      now: () => now,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('ceiling');
  });

  it('steer returns when the wait times out with tasks still pending', async () => {
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => 1,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn,
      now: () => Date.now(),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('steer throws when a steered turn does not complete', async () => {
    await expect(
      applyPrintBackgroundPolicy({
        mode: 'steer',
        ceilingS: 60,
        maxTurns: 50,
        countPending: () => 1,
        drain: async () => {},
        turnEndings: scriptedTurnEndings([
          {
            event: {
              type: 'turn.ended',
              turnId: 2,
              reason: 'failed',
              error: { code: 'provider.overloaded', message: 'try later' },
            } as PrintTurnEnding,
          },
        ]),
        skipTurnId: 1,
        warn: () => {},
        now: () => Date.now(),
      }),
    ).rejects.toThrow(PrintSteeredTurnFailedError);
  });

  it('waits for goal continuation turns before applying the mode', async () => {
    let active = true;
    let consumed = 0;
    const drain = vi.fn(async () => {});
    await applyPrintBackgroundPolicy({
      mode: 'drain',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => 0,
      drain,
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { consumed += 1; } },
        {
          event: ending(3),
          apply: () => {
            consumed += 1;
            active = false;
          },
        },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => Date.now(),
      goalActive: () => active,
    });
    expect(consumed).toBe(2);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('warns and returns when the goal wait hits the ceiling', async () => {
    let now = 0;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 10,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: {
        next: async () => {
          now = 10_001;
          return null;
        },
      },
      skipTurnId: 1,
      warn,
      now: () => now,
      goalActive: () => true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('goal wait ceiling');
  });

  it('exits the goal wait promptly when the goal settles without a turn ending', async () => {
    let active = true;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: {
        next: async () => {
          active = false;
          return null;
        },
      },
      skipTurnId: 1,
      warn,
      now: () => Date.now(),
      goalActive: () => active,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps an exit-mode run alive until a pending cron fire steered a turn', async () => {
    let nextFire: number | null = 60_000;
    let fireTurnEnded = false;
    const cronNextFireAt = vi.fn(() => nextFire);
    const countPending = vi.fn(() => 0);
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        {
          event: ending(2),
          apply: () => {
            fireTurnEnded = true;
            nextFire = null;
          },
        },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => 0,
      cronNextFireAt,
    });
    expect(fireTurnEnded).toBe(true);
    expect(cronNextFireAt).toHaveBeenCalledTimes(2);
    expect(countPending).not.toHaveBeenCalled();
  });

  it('throws when a cron-fire steered turn does not complete', async () => {
    await expect(
      applyPrintBackgroundPolicy({
        mode: 'exit',
        ceilingS: 3600,
        maxTurns: 50,
        countPending: () => 0,
        drain: async () => {},
        turnEndings: scriptedTurnEndings([
          {
            event: {
              type: 'turn.ended',
              turnId: 2,
              reason: 'failed',
              error: { code: 'provider.overloaded', message: 'try later' },
            } as PrintTurnEnding,
          },
        ]),
        skipTurnId: 1,
        warn: () => {},
        now: () => 0,
        cronNextFireAt: () => 60_000,
      }),
    ).rejects.toThrow(PrintSteeredTurnFailedError);
  });

  it('keeps waiting while a recurring cron advances its next fire time', async () => {
    let nextFire: number | null = 10_000;
    const cronNextFireAt = vi.fn(() => nextFire);
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { nextFire = 20_000; } },
        { event: ending(3), apply: () => { nextFire = null; } },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => 0,
      cronNextFireAt,
    });
    expect(cronNextFireAt).toHaveBeenCalledTimes(3);
  });

  it('re-reads the cron schedule when the fire wait times out without a turn', async () => {
    let nextFire: number | null = 10_000;
    const cronNextFireAt = vi.fn(() => {
      const value = nextFire;
      nextFire = null;
      return value;
    });
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn,
      now: () => 0,
      cronNextFireAt,
    });
    expect(cronNextFireAt).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and stops cron waiting when the next fire time is stuck in the past', async () => {
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([]),
      skipTurnId: 1,
      warn,
      now: () => 1_000,
      cronNextFireAt: () => 500,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('cron');
  });

  it('waits for an in-flight turn instead of treating an empty cron schedule as quiescent', async () => {
    let active = true;
    let consumed = 0;
    const warn = vi.fn();
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { consumed += 1; active = false; } },
      ]),
      skipTurnId: 1,
      warn,
      now: () => 0,
      turnActive: () => active,
      cronNextFireAt: () => null,
    });
    expect(consumed).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not read a past fire time as a wedged tick while a turn is running', async () => {
    let active = true;
    let nextFire: number | null = 500;
    const warn = vi.fn();
    const turnEndings: PrintTurnEndings = {
      next: async (remainingMs) => {
        if (remainingMs <= 10_000) return null;
        if (active) {
          active = false;
          nextFire = 60_000;
          return ending(2);
        }
        nextFire = null;
        return ending(3);
      },
    };
    await applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings,
      skipTurnId: 1,
      warn,
      now: () => 1_000,
      turnActive: () => active,
      cronNextFireAt: () => nextFire,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails the run when an in-flight steered turn does not complete', async () => {
    await expect(
      applyPrintBackgroundPolicy({
        mode: 'steer',
        ceilingS: 3600,
        maxTurns: 50,
        countPending: () => 0,
        drain: async () => {},
        turnEndings: scriptedTurnEndings([
          {
            event: {
              type: 'turn.ended',
              turnId: 2,
              reason: 'failed',
              error: { code: 'provider.overloaded', message: 'try later' },
            } as PrintTurnEnding,
          },
        ]),
        skipTurnId: 1,
        warn: () => {},
        now: () => 0,
        turnActive: () => true,
        cronNextFireAt: () => null,
      }),
    ).rejects.toThrow(PrintSteeredTurnFailedError);
  });

  it('finishes goal waiting before consulting the cron schedule', async () => {
    let active = true;
    let consumed = 0;
    let nextFire: number | null = 60_000;
    let cronFirstCallAtConsumed = -1;
    const cronNextFireAt = vi.fn(() => {
      if (cronFirstCallAtConsumed === -1) cronFirstCallAtConsumed = consumed;
      return nextFire;
    });
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 3600,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { consumed += 1; } },
        {
          event: ending(3),
          apply: () => {
            consumed += 1;
            active = false;
          },
        },
        { event: ending(4), apply: () => { nextFire = null; } },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => 0,
      goalActive: () => active,
      cronNextFireAt,
    });
    expect(cronFirstCallAtConsumed).toBe(2);
    expect(cronNextFireAt).toHaveBeenCalled();
  });

  it('waits for a Stop hook continuation turn before exiting', async () => {
    let active = false;
    let consumed = 0;
    let stopHookRan = false;
    const drainStopHooks = vi.fn(async () => {
      if (stopHookRan) return;
      stopHookRan = true;
      active = true;
    });
    await applyPrintBackgroundPolicy({
      mode: 'exit',
      ceilingS: 60,
      maxTurns: 50,
      countPending: () => 0,
      drain: async () => {},
      turnEndings: scriptedTurnEndings([
        { event: ending(2), apply: () => { consumed += 1; active = false; } },
      ]),
      skipTurnId: 1,
      warn: () => {},
      now: () => Date.now(),
      turnActive: () => active,
      drainStopHooks,
    });
    expect(drainStopHooks).toHaveBeenCalled();
    expect(consumed).toBe(1);
  });

  it('steer keeps waiting under the default ceiling with tasks pending', async () => {
    let pending = 1;
    const turnEndings = createPrintTurnEndings();
    const policy = applyPrintBackgroundPolicy({
      mode: 'steer',
      ceilingS: PRINT_WAIT_CEILING_S_DEFAULT,
      maxTurns: 50,
      countPending: () => pending,
      drain: async () => {},
      turnEndings,
      skipTurnId: 1,
      warn: () => {},
      now: () => Date.now(),
    });
    const early = await Promise.race([
      policy.then(() => 'returned' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => {
        resolve('waiting');
      }, 50)),
    ]);
    expect(early).toBe('waiting');
    pending = 0;
    turnEndings.push(ending(2));
    await policy;
  });
});

describe('createPrintTurnEndings', () => {
  it('buffers events pushed before next() and skips the given turn id', async () => {
    const endings = createPrintTurnEndings();
    endings.push(ending(1));
    endings.push(ending(2));
    await expect(endings.next(1000, 1)).resolves.toMatchObject({ turnId: 2 });
  });

  it('delivers a pushed event to a pending next()', async () => {
    const endings = createPrintTurnEndings();
    const pending = endings.next(1000, 1);
    endings.push(ending(3));
    await expect(pending).resolves.toMatchObject({ turnId: 3 });
  });

  it('resolves null when the remaining time elapses', async () => {
    const endings = createPrintTurnEndings();
    await expect(endings.next(5, 1)).resolves.toBeNull();
  });

  it('keeps waiting when only the skipped turn ends', async () => {
    const endings = createPrintTurnEndings();
    const pending = endings.next(1000, 1);
    endings.push(ending(1));
    endings.push(ending(4));
    await expect(pending).resolves.toMatchObject({ turnId: 4 });
  });

  it('does not resolve null early when the budget exceeds the timer ceiling', async () => {
    const endings = createPrintTurnEndings();
    const pending = endings.next(10 * 365 * 24 * 3600 * 1000, 1);
    const early = await Promise.race([
      pending,
      new Promise<'waiting'>((resolve) => setTimeout(() => {
        resolve('waiting');
      }, 50)),
    ]);
    expect(early).toBe('waiting');
    endings.push(ending(7));
    await expect(pending).resolves.toMatchObject({ turnId: 7 });
  });
});

describe('formatTrustGatedMcpWarning', () => {
  it('singularizes the noun for one skipped server', () => {
    const text = formatTrustGatedMcpWarning([{ name: 'fs', target: 'stdio: node server.js' }]);
    expect(text).toContain('skipped 1 project-level MCP server: fs (stdio: node server.js).');
    expect(text).toContain('Warning: this project is not trusted;');
    expect(text).toContain('Run `kimi` here and choose "Trust and continue"');
    expect(text).toContain('KIMI_CODE_TRUST_WORKSPACE=1');
  });

  it('pluralizes and joins multiple skipped servers', () => {
    const text = formatTrustGatedMcpWarning([
      { name: 'api', target: 'http: https://example.com/mcp' },
      { name: 'fs', target: 'stdio: node server.js' },
    ]);
    expect(text).toContain('skipped 2 project-level MCP servers:');
    expect(text).toContain('api (http: https://example.com/mcp), fs (stdio: node server.js)');
  });
});
