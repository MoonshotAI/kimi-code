/**
 * CronManager — Agent-facing facade for the session-only cron scheduler.
 *
 * This layer sits between the raw `CronScheduler` (which knows nothing
 * about agents) and the rest of the agent runtime (Agent / turn /
 * telemetry / tool surface). Its job is small but important:
 *
 *   - own the `SessionCronStore` for this session;
 *   - hand `() => store.list()` to the scheduler so add / delete are
 *     picked up automatically every tick;
 *   - gate fires on `agent.turn.hasActiveTurn` rather than maintaining a
 *     duplicate idle flag — the turn machinery already knows;
 *   - translate a fired `CronTask` into a `steer(...)` call carrying a
 *     `CronJobOrigin`, plus the `cron_fired` telemetry event;
 *   - provide a `handleMissed(...)` entry point that Phase 2 boot-time
 *     missed-task detection (P2.7 / P2.11) will call. In Phase 1 the
 *     entry point is reachable but never invoked from the framework —
 *     it is exposed now so the API surface stays stable across the
 *     phase boundary.
 *
 * The manager does NOT read `Date.now()` directly anywhere; every
 * wall-clock read goes through `this.clocks.wallNow()`. The
 * `no-date-now.test.ts` guard does not list this file (it covers the
 * scheduler / jitter layer), but the same discipline is intentional so
 * bench / test clock injection holds end-to-end.
 *
 * Note on `recurring` semantics: the canonical task representation uses
 * `recurring: boolean | undefined` where `undefined` means recurring
 * (cron tasks default to repeating). One-shot is the explicit
 * `recurring === false` opt-out. Every check in this file uses
 * `task.recurring !== false` to keep that default behaviour even when
 * the field is omitted by the caller.
 */
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../index';
import type { CronJobOrigin, CronMissedOrigin } from '../context/types';
import {
  resolveClockSources,
  SYSTEM_CLOCKS,
  type ClockSources,
} from '../../tools/cron/clock';
import { SessionCronStore } from '../../tools/cron/session-store';
import {
  createCronScheduler,
  type CronScheduler,
} from '../../tools/cron/scheduler';
import {
  CRON_FIRED,
  CRON_MISSED,
} from '../../tools/cron/telemetry-events';
import type { CronTask } from '../../tools/cron/types';

/**
 * Threshold past which a recurring task is flagged `stale: true` on its
 * fire `origin`. One-shot tasks never carry the stale flag — they are
 * one-time, "we always fire at most once" by construction. Disabled by
 * `KIMI_CRON_NO_STALE=1` (bench / acceptance tests).
 *
 * Seven days mirrors the wall-clock "this got forgotten about" window
 * we want the LLM to notice; the figure also matches the auto-expire
 * cadence documented in the user-facing schedule story.
 */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface CronManagerOptions {
  /**
   * Override for tests / bench. Defaults to
   * `resolveClockSources(process.env.KIMI_CRON_CLOCK)` so production
   * picks up `KIMI_CRON_CLOCK=env:...` / `file:...` automatically.
   * When unset, falls through to {@link SYSTEM_CLOCKS}.
   */
  readonly clocks?: ClockSources;

  /**
   * Override scheduler poll interval. Defaults handled by the scheduler
   * (1000ms unless `KIMI_CRON_MANUAL_TICK` is set; that env wiring lives
   * in P1.8). `null` or `0` means "no automatic timer — caller drives
   * `tick()` manually".
   */
  readonly pollIntervalMs?: number | null;
}

export class CronManager {
  /** Session-only task store. Empty at construction. */
  readonly store: SessionCronStore;

  /**
   * Clock source used for the stale judgment. Also passed to the
   * scheduler so the entire stack shares one notion of "now".
   */
  readonly clocks: ClockSources;

  private readonly scheduler: CronScheduler;
  private readonly agent: Agent;

  constructor(agent: Agent, opts: CronManagerOptions = {}) {
    this.agent = agent;
    this.store = new SessionCronStore();
    this.clocks =
      opts.clocks ??
      resolveClockSources(process.env.KIMI_CRON_CLOCK) ??
      SYSTEM_CLOCKS;

    this.scheduler = createCronScheduler({
      clocks: this.clocks,
      source: () => this.store.list(),
      isIdle: () => !agent.turn.hasActiveTurn,
      isKilled: () => process.env.KIMI_DISABLE_CRON === '1',
      onFire: (task, ctx) => this.handleFire(task, ctx),
      removeOneShot: (id) => {
        this.store.remove([id]);
      },
      pollIntervalMs: opts.pollIntervalMs,
    });
  }

  /** Begin the scheduler's auto-tick loop. Idempotent. */
  start(): void {
    this.scheduler.start();
  }

  /** Stop the scheduler and clear in-flight bookkeeping. Idempotent. */
  stop(): Promise<void> {
    return this.scheduler.stop();
  }

  /** Drive one scheduler tick synchronously. Used by tests + P1.8 SIGUSR1. */
  tick(): void {
    this.scheduler.tick();
  }

  /**
   * Earliest theoretical (post-jitter) next-fire across all tasks, or
   * null if there are no tasks / none have a future fire. Used by the
   * `/cron` slash command and external monitoring.
   */
  getNextFireTime(): number | null {
    return this.scheduler.getNextFireTime();
  }

  /**
   * Stale judgment.
   *
   *   - `KIMI_CRON_NO_STALE=1` short-circuits to false (bench).
   *   - One-shot tasks (`recurring === false`) are never stale — they
   *     fire at most once by construction; flagging them stale would be
   *     a noisy false positive on every backlog wakeup.
   *   - Otherwise: `wallNow() - createdAt >= 7 days`.
   *
   * `Number.isFinite` guards against the wall clock being broken (e.g.
   * a mis-set bench env that returns `NaN`); a non-finite age is
   * treated as "we don't know, don't claim stale".
   */
  isStale(task: CronTask): boolean {
    if (process.env.KIMI_CRON_NO_STALE === '1') return false;
    if (task.recurring === false) return false;
    const age = this.clocks.wallNow() - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }

  /**
   * Translate a scheduler fire into a steer + telemetry event.
   *
   * `agent.turn.steer` returns the new turnId, or `null` when the input
   * was buffered because a turn is in flight (see turn/index.ts:84).
   * We propagate that as `buffered` on the telemetry props so dashboards
   * can distinguish "fired into a fresh turn" from "fired into a steer
   * buffer that may not run until the user's turn ends".
   */
  private handleFire(
    task: CronTask,
    ctx: { readonly coalescedCount: number },
  ): void {
    const stale = this.isStale(task);
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      coalescedCount: ctx.coalescedCount,
      stale,
    };
    const content: ContentPart[] = [{ type: 'text', text: task.prompt }];
    const turnId = this.agent.turn.steer(content, origin);
    this.agent.telemetry.track(CRON_FIRED, {
      recurring: task.recurring !== false,
      durable: task.durable === true,
      coalesced_count: ctx.coalescedCount,
      stale,
      buffered: turnId === null,
    });
  }

  /**
   * Called from P2.7 / P2.11 when boot-time missed one-shot tasks are
   * detected. Stubbed in P1.3 because Phase 1 has no persistence — but
   * the API surface is final so the consumer (file-backed missed-task
   * detector) can land without touching this class again.
   *
   * The `renderMissedNotification` callback is supplied by the caller
   * (rather than imported here) so this module stays free of UI / copy
   * coupling; the same manager works for tests that want to inject a
   * trivial renderer.
   *
   * `count: 0` is a no-op — the scheduler-side missed-task detector
   * filters empties before calling us, but defending here keeps the
   * contract simple ("safe to call with anything, no-op when empty").
   */
  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (
      tasks: readonly CronTask[],
    ) => readonly ContentPart[],
  ): void {
    if (tasks.length === 0) return;
    const content = renderMissedNotification(tasks);
    const origin: CronMissedOrigin = {
      kind: 'cron_missed',
      count: tasks.length,
    };
    this.agent.turn.steer(content, origin);
    this.agent.telemetry.track(CRON_MISSED, { count: tasks.length });
  }
}
