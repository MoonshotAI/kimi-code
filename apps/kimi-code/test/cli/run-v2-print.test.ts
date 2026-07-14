import { describe, expect, it, vi } from 'vitest';

import {
  applyPrintBackgroundPolicy,
  createPrintTurnEndings,
  PrintSteeredTurnFailedError,
  type PrintTurnEnding,
  type PrintTurnEndings,
} from '#/cli/v2/run-v2-print';

function ending(
  turnId: number,
  reason: PrintTurnEnding['reason'] = 'completed',
): PrintTurnEnding {
  return { type: 'turn.ended', turnId, reason };
}

interface ScriptedEntry {
  readonly event: PrintTurnEnding;
  /** Side effect applied when this entry is consumed (e.g. mutate pending). */
  readonly apply?: () => void;
}

/**
 * Scripted `PrintTurnEndings`: replays queued endings (honouring `skipTurnId`),
 * then resolves `null` once the script is exhausted (the wait "timed out").
 */
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
        // The main turn's own buffered ending is skipped.
        { event: ending(1) },
        // A background task completed and steered a new turn; it finished and
        // no tasks remain.
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
      // Empty script: no further turn ends before the deadline.
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
    // Both continuation turns ended before the mode ('drain') ran.
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
      // No continuation turn ever ends; the poll interval elapses each time.
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
      // Poll interval elapses; the goal settles (paused/blocked) mid-wait
      // without producing a turn.ended.
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
});
