/**
 * Tests for `tools/cron/scheduler.ts`. Time is injected via
 * `ClockSources`; `KIMI_CRON_NO_JITTER=1` pins fire counts on the
 * recurring tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClockSources } from '../../../src/tools/cron/clock';
import {
  createCronScheduler,
  type CronScheduler,
} from '../../../src/tools/cron/scheduler';
import type { CronTask } from '../../../src/tools/cron/types';

interface HarnessOptions {
  readonly isIdle?: boolean;
  readonly isKilled?: boolean;
  readonly pollIntervalMs?: number | null;
  readonly onFireThrows?: boolean;
}

interface Harness {
  readonly scheduler: CronScheduler;
  readonly tasks: CronTask[];
  readonly fired: Array<{ task: CronTask; coalescedCount: number }>;
  readonly removed: string[];
  advance(ms: number): void;
  setIdle(v: boolean): void;
  setKilled(v: boolean): void;
  setOnFireThrows(v: boolean): void;
  now(): number;
}

// Fixed wall-clock anchor (Nov 14 2023, 22:13:20 UTC). Picked so it
// doesn't sit on any "round" minute mark — the next "every 5 minutes"
// fire lands 4-5 minutes ahead, not exactly 5.
const WALL_ANCHOR = 1_700_000_000_000;

function createHarness(opts: HarnessOptions = {}): Harness {
  let now = WALL_ANCHOR;
  let mono = 1_000_000;
  const clocks: ClockSources = {
    wallNow: () => now,
    monoNowMs: () => mono,
  };
  const tasks: CronTask[] = [];
  const fired: Array<{ task: CronTask; coalescedCount: number }> = [];
  const removed: string[] = [];
  let idle = opts.isIdle ?? true;
  let killed = opts.isKilled ?? false;
  let onFireThrows = opts.onFireThrows ?? false;

  const scheduler = createCronScheduler({
    clocks,
    source: () => tasks,
    onFire: (task, ctx) => {
      if (onFireThrows) {
        throw new Error('onFire boom');
      }
      fired.push({ task, coalescedCount: ctx.coalescedCount });
    },
    isIdle: () => idle,
    isKilled: () => killed,
    removeOneShot: (id) => {
      removed.push(id);
      const i = tasks.findIndex((t) => t.id === id);
      if (i >= 0) tasks.splice(i, 1);
    },
    // Tests use manual tick() unless they explicitly opt into the timer.
    pollIntervalMs: opts.pollIntervalMs ?? null,
  });

  return {
    scheduler,
    tasks,
    fired,
    removed,
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
    setIdle: (v: boolean) => {
      idle = v;
    },
    setKilled: (v: boolean) => {
      killed = v;
    },
    setOnFireThrows: (v: boolean) => {
      onFireThrows = v;
    },
    now: () => now,
  };
}

/**
 * Tiny helper: 8-hex id deterministic per-call so each test gets a
 * stable id without colliding across tasks within a test.
 */
let idCounter = 0;
function nextId(): string {
  idCounter++;
  return idCounter.toString(16).padStart(8, '0');
}

function makeTask(overrides: Partial<CronTask> & { cron: string; createdAt: number }): CronTask {
  return {
    id: overrides.id ?? nextId(),
    prompt: overrides.prompt ?? 'do the thing',
    cron: overrides.cron,
    createdAt: overrides.createdAt,
    recurring: overrides.recurring,
  };
}

const ORIGINAL_ENV_NO_JITTER = process.env['KIMI_CRON_NO_JITTER'];

describe('createCronScheduler — tick behaviour', () => {
  beforeEach(() => {
    // Pin exact fire times in every test by default. The single test
    // that exercises jitter restores the env explicitly.
    process.env['KIMI_CRON_NO_JITTER'] = '1';
    idCounter = 0;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_NO_JITTER === undefined) {
      delete process.env['KIMI_CRON_NO_JITTER'];
    } else {
      process.env['KIMI_CRON_NO_JITTER'] = ORIGINAL_ENV_NO_JITTER;
    }
  });

  it('recurring task fires once when due', () => {
    const h = createHarness();
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );
    // Not yet due — first call to tick should not fire.
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    // Advance ~6 minutes — past the next */5 boundary regardless of
    // where WALL_ANCHOR landed in the minute cycle.
    h.advance(6 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
  });

  it('recurring task coalesces missed fires when scheduler sleeps', () => {
    const h = createHarness();
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );
    // Advance 15 minutes — we should see 3 collapsed ideal fires.
    h.advance(15 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBeGreaterThanOrEqual(3);
    expect(h.fired[0]!.coalescedCount).toBeLessThanOrEqual(4);
  });

  it('one-shot task fires once then is removed', () => {
    const h = createHarness();
    // createdAt is 1 minute earlier so we can advance past the next
    // 12:00 without anchoring needing a precise local-tz computation.
    h.tasks.push(
      makeTask({
        cron: '0 12 * * *',
        createdAt: h.now() - 60_000,
        recurring: false,
      }),
    );
    const taskId = h.tasks[0]!.id;

    // Advance one full day — guaranteed to pass at least one 12:00.
    h.advance(25 * 60 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
    expect(h.removed).toEqual([taskId]);
    expect(h.tasks).toHaveLength(0);
  });

  it('isIdle=false suppresses fire but does not lose the task', () => {
    const h = createHarness({ isIdle: false });
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );

    // Five minutes pass mid-turn — tick should not fire.
    h.advance(6 * 60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    // Turn ends — the next tick picks the missed fire up.
    h.setIdle(true);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
  });

  it('isKilled=true short-circuits even when due and idle', () => {
    const h = createHarness({ isKilled: true });
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );
    h.advance(6 * 60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    // Lifting the killswitch lets the missed fire through.
    h.setKilled(false);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
  });

  it('bad cron expression does not stop other tasks in the same tick', () => {
    const h = createHarness();
    // Insert a task whose cron string will throw at parse time. We
    // bypass any normal "constructor" by pushing a raw object — the
    // scheduler must swallow the parse failure for this one task and
    // continue processing the rest.
    const bad: CronTask = {
      id: nextId(),
      cron: 'not a cron at all',
      prompt: 'bad',
      createdAt: h.now(),
      recurring: true,
    };
    const good: CronTask = {
      id: nextId(),
      cron: '*/5 * * * *',
      prompt: 'good',
      createdAt: h.now(),
      recurring: true,
    };
    h.tasks.push(bad, good);

    h.advance(6 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.task.id).toBe(good.id);
  });

  it('only the due task fires when two tasks are scheduled', () => {
    const h = createHarness();
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
      makeTask({ cron: '0 0 1 1 *', createdAt: h.now(), recurring: true }),
    );
    const dueId = h.tasks[0]!.id;

    h.advance(6 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.task.id).toBe(dueId);
  });

  it('recurring fires exactly once per turn even if multiple ideal fires elapse mid-turn', () => {
    // Regression for US-15: a long busy turn over the 1-hour boundary
    // must collapse into a single fire when idle returns.
    const h = createHarness({ isIdle: false });
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );

    // 17 minutes elapse mid-turn — three ideal fires missed.
    h.advance(17 * 60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    h.setIdle(true);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBeGreaterThanOrEqual(3);
  });

  it('recurring task whose onFire throws is retried on the next tick', () => {
    // C3 regression: a throwing onFire must NOT advance lastSeenAt or
    // consume the ideal fire. Otherwise a transient persistence error
    // silently drops the reminder.
    const h = createHarness({ onFireThrows: true });
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );

    // Past the next */5 boundary — task is due.
    h.advance(6 * 60_000);
    h.scheduler.tick();
    // Throw swallowed; no delivery recorded.
    expect(h.fired).toHaveLength(0);

    // Recover and tick again — the same ideal must still be reachable.
    h.setOnFireThrows(false);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    // Coalesced from the same just-past slot, not a phantom past
    // delivery — the count is the natural 1 (or up to the gap), never
    // skipped to a later period.
    expect(h.fired[0]!.coalescedCount).toBe(1);
  });

  it('one-shot whose onFire throws is NOT removed and retries on the next tick', () => {
    // C3 regression for one-shots: removeOneShot must be gated on a
    // successful delivery so a transient throw doesn't lose the
    // reminder entirely.
    const h = createHarness({ onFireThrows: true });
    h.tasks.push(
      makeTask({
        cron: '*/5 * * * *',
        createdAt: h.now(),
        recurring: false,
      }),
    );
    const taskId = h.tasks[0]!.id;

    h.advance(6 * 60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);
    // Critical: still present in the store, not removed.
    expect(h.tasks).toHaveLength(1);
    expect(h.tasks[0]!.id).toBe(taskId);
    expect(h.removed).toEqual([]);

    // Recover — delivery succeeds and removeOneShot runs.
    h.setOnFireThrows(false);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.removed).toEqual([taskId]);
    expect(h.tasks).toHaveLength(0);
  });
});

describe('createCronScheduler — getNextFireTime', () => {
  beforeEach(() => {
    process.env['KIMI_CRON_NO_JITTER'] = '1';
    idCounter = 0;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_NO_JITTER === undefined) {
      delete process.env['KIMI_CRON_NO_JITTER'];
    } else {
      process.env['KIMI_CRON_NO_JITTER'] = ORIGINAL_ENV_NO_JITTER;
    }
  });

  it('returns null when there are no tasks', () => {
    const h = createHarness();
    expect(h.scheduler.getNextFireTime()).toBeNull();
  });

  it('returns the minimum next-fire across tasks', () => {
    const h = createHarness();
    // Soonest: every minute. Latest: yearly Jan 1.
    h.tasks.push(
      makeTask({ cron: '* * * * *', createdAt: h.now(), recurring: true }),
      makeTask({ cron: '0 0 1 1 *', createdAt: h.now(), recurring: true }),
    );

    const next = h.scheduler.getNextFireTime();
    expect(next).not.toBeNull();
    // The minute-cron's next fire is within 1 minute of now; the
    // yearly cron is at least days away. So `next` must be within
    // 65s of now.
    expect(next! - h.now()).toBeLessThanOrEqual(65_000);
  });
});

describe('createCronScheduler — getNextFireForTask', () => {
  beforeEach(() => {
    process.env['KIMI_CRON_NO_JITTER'] = '1';
    idCounter = 0;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_NO_JITTER === undefined) {
      delete process.env['KIMI_CRON_NO_JITTER'];
    } else {
      process.env['KIMI_CRON_NO_JITTER'] = ORIGINAL_ENV_NO_JITTER;
    }
  });

  it('returns null for unknown id', () => {
    const h = createHarness();
    expect(h.scheduler.getNextFireForTask('00000000')).toBeNull();
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );
    // Unknown id even when there are other tasks.
    expect(h.scheduler.getNextFireForTask('ffffffff')).toBeNull();
  });

  it('returns the same value getNextFireTime would for a single-task store', () => {
    const h = createHarness();
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );
    const taskId = h.tasks[0]!.id;
    const aggregate = h.scheduler.getNextFireTime();
    const perTask = h.scheduler.getNextFireForTask(taskId);
    expect(perTask).not.toBeNull();
    expect(perTask).toBe(aggregate);
  });

  it('preserves pending jittered slot when ideal is just past', () => {
    // C1 load-bearing assertion: an already-past ideal whose jittered
    // delivery is still in the future must be returned as the next
    // fire, not skipped to the following period.
    delete process.env['KIMI_CRON_NO_JITTER'];
    const h = createHarness();
    // id `ffffffff` → fraction ≈ 1.0 → recurring offset ≈ 30s (10% of
    // 5-min period).
    h.tasks.push(
      makeTask({
        id: 'ffffffff',
        cron: '*/5 * * * *',
        createdAt: h.now(),
        recurring: true,
      }),
    );
    const taskId = h.tasks[0]!.id;

    // Burn one fire so lastSeenAt advances onto a known 5-min slot;
    // from this point the period structure is regular.
    h.advance(6 * 60_000 + 30_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    const firedAtIdeal = h.fired[0]!.task; // proves we delivered

    // The next ideal sits 5 min after the previous ideal. Capture
    // `getNextFireForTask` as the source of truth, then advance just
    // past that ideal but BEFORE the jittered +30s delivery.
    const idealPlusJitter = h.scheduler.getNextFireForTask(taskId);
    expect(idealPlusJitter).not.toBeNull();
    expect(firedAtIdeal.id).toBe(taskId);

    // Step to 20s past the next ideal: ideal is at (idealPlusJitter -
    // 30s); we are now 10s short of the jittered delivery point.
    const stepTo = idealPlusJitter! - 10_000;
    h.advance(stepTo - h.now());

    // Pending current-period slot — should still report the same
    // jittered timestamp, NOT skip to the next period.
    const next = h.scheduler.getNextFireForTask(taskId);
    expect(next).toBe(idealPlusJitter);
    // Sanity: that timestamp is in the very near future, not 5 min
    // later (which would be the next-period skip we are preventing).
    expect(next! - h.now()).toBeLessThanOrEqual(15_000);
    expect(next! - h.now()).toBeGreaterThan(0);
  });
});

describe('createCronScheduler — start/stop lifecycle', () => {
  beforeEach(() => {
    process.env['KIMI_CRON_NO_JITTER'] = '1';
    idCounter = 0;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_NO_JITTER === undefined) {
      delete process.env['KIMI_CRON_NO_JITTER'];
    } else {
      process.env['KIMI_CRON_NO_JITTER'] = ORIGINAL_ENV_NO_JITTER;
    }
  });

  it('start() with pollIntervalMs=null does not auto-tick', async () => {
    const h = createHarness({ pollIntervalMs: null });
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );
    h.scheduler.start();
    h.advance(60 * 60_000);
    // Yield so any (unintended) timer would have fired.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.fired).toHaveLength(0);
    await h.scheduler.stop();
  });

  it('start() with a small pollIntervalMs wires up the auto-tick', async () => {
    const h = createHarness({ pollIntervalMs: 20 });
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );
    h.advance(6 * 60_000); // task is now due
    h.scheduler.start();

    // Wait long enough for at least one interval tick to elapse.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await h.scheduler.stop();

    expect(h.fired.length).toBeGreaterThanOrEqual(1);
    // Coalesced to a single fire — auto-ticks subsequent to the first
    // see lastSeenAt = now and have nothing new to fire.
    expect(h.fired[0]!.coalescedCount).toBe(1);
  });

  it('stop() is idempotent and clears state', async () => {
    const h = createHarness({ pollIntervalMs: null });
    h.scheduler.start();
    await h.scheduler.stop();
    await h.scheduler.stop();
    // Calling tick() after stop is still safe.
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);
  });

  it('start() is idempotent', () => {
    const h = createHarness({ pollIntervalMs: null });
    expect(() => {
      h.scheduler.start();
      h.scheduler.start();
    }).not.toThrow();
    // No auto-tick (interval is null) → no fires sneak in.
    expect(h.fired).toHaveLength(0);
  });
});

describe('createCronScheduler — jitter integration', () => {
  beforeEach(() => {
    delete process.env['KIMI_CRON_NO_JITTER'];
    idCounter = 0;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_NO_JITTER === undefined) {
      delete process.env['KIMI_CRON_NO_JITTER'];
    } else {
      process.env['KIMI_CRON_NO_JITTER'] = ORIGINAL_ENV_NO_JITTER;
    }
  });

  it('recurring task with jitter fires after advancing past the cap', () => {
    const h = createHarness();
    // 30s past 6 minutes guarantees we crossed the ideal + max(10% of
    // 5min = 30s) jitter cap.
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
    );
    h.advance(6 * 60_000 + 30_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
  });

  it('one-shot task always reports coalescedCount=1 even after a long backlog', () => {
    // A daily one-shot left un-delivered for a week should still
    // report `coalescedCount: 1` — one-shots are removed after a
    // single delivery, so multi-occurrence counts are meaningless and
    // would mislead the LLM into thinking it missed multiple
    // scheduled events.
    process.env['KIMI_CRON_NO_JITTER'] = '1';
    try {
      const h = createHarness();
      const task = makeTask({
        cron: '0 9 * * *',
        createdAt: h.now(),
        recurring: false,
      });
      h.tasks.push(task);
      h.advance(7 * 24 * 60 * 60_000);
      h.scheduler.tick();

      expect(h.fired).toHaveLength(1);
      expect(h.fired[0]!.coalescedCount).toBe(1);
      expect(h.removed).toEqual([task.id]);
    } finally {
      delete process.env['KIMI_CRON_NO_JITTER'];
    }
  });

  it('does not advance baseline past a not-yet-jittered ideal fire', () => {
    // The bot-flagged scenario: when the next ideal fire's jittered
    // delivery is still in the future, `countCoalesced` must not
    // include it and `lastSeenAt` must not advance past it — otherwise
    // the jittered delivery is lost on the next tick. (jitter ON).
    //
    // Setup: id `ffffffff` → fraction ≈ 1.0 → recurring offset = 10%
    // of 5-min period = 30s. After firing the first slot, the next
    // ideal is +5 min and its jittered delivery is +5 min 30s.
    delete process.env['KIMI_CRON_NO_JITTER'];
    const h = createHarness();
    h.tasks.push(
      makeTask({
        id: 'ffffffff',
        cron: '*/5 * * * *',
        createdAt: h.now(),
        recurring: true,
      }),
    );
    // Cross the first jittered fire (6m past anchor + 30s buffer).
    h.advance(6 * 60_000 + 30_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);

    // The next ideal is the very next `*/5` after the first ideal —
    // 5 minutes later — with the same 30s jitter offset. Advance just
    // past the ideal but short of the jittered delivery; the
    // scheduler must NOT fire yet, and must keep the slot reachable.
    h.advance(20_000); // now is 20s past the next ideal, still 10s short of jittered
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);

    // Cross the jittered delivery point — the slot fires now.
    h.advance(60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.coalescedCount).toBe(1);
  });
});
