/**
 * `cron` domain (L5) — `AgentCronService` implementation.
 *
 * Owns the agent's cron task set end to end: holds the in-memory task map,
 * runs the scheduling loop (tick / coalesce / jitter / cursor), persists each
 * task as an atomic document under the agent's home directory
 * (`<sessionDir>/agents/<agentId>/cron/<id>.json`, matching the v1 layout so a
 * session written by either side is readable by the other), mirrors mutations
 * onto `wireRecord` for replay, registers the cron tools into `toolRegistry`,
 * and steers the agent through `prompt` when a task fires. Bound at Agent scope.
 */

import { randomBytes } from 'node:crypto';

import type { ContentPart } from '#/app/llmProtocol';
import type { CronJobOrigin, CronMissedOrigin } from '@moonshot-ai/protocol';

import { Disposable, toDisposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IntervalTimer } from '#/_base/utils';

import { IConfigService } from '#/app/config';
import { IAtomicDocumentStore } from '#/app/storage';
import { ITelemetryService } from '#/app/telemetry';
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentRecordService } from '#/agent/record';
import { IAgentScopeContext } from '#/agent/scopeContext';
import type { Turn } from '#/agent/turn';
import { IAgentTurnService } from '#/agent/turn';

import {
  type CronConfig,
  CRON_SECTION,
  DEFAULT_CRON_CONFIG,
} from './configSection';
import {
  IAgentCronService,
  type CronLoadOptions,
  type CronTask,
  type CronTaskInit,
} from './cron';
import {
  computeNextCronRun,
  parseCronExpression,
  type ParsedCronExpression,
} from './cron-expr';
import { renderCronFireXml } from './format';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from './jitter';
import {
  resolveClockSources,
  SYSTEM_CLOCKS,
  type ClockSources,
} from './clock';

/** Telemetry event names emitted by the cron subsystem. Centralised so a typo can't drift a metric. */
export const CRON_SCHEDULED = 'cron_scheduled' as const;
export const CRON_FIRED = 'cron_fired' as const;
export const CRON_MISSED = 'cron_missed' as const;
export const CRON_DELETED = 'cron_deleted' as const;

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'cron.add': {
      task: CronTask;
    };
    'cron.delete': {
      ids: readonly string[];
    };
    'cron.cursor': {
      id: string;
      lastFiredAt: number;
    };
  }
}

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Cap on how many ideal fires we attempt to enumerate when computing
 * coalescedCount. With a 1-minute cron, this still covers 10 000 minutes
 * (~7 days). Beyond that we'd rather report 10 000 than spin.
 */
const MAX_COALESCE_ITERATIONS = 10_000;

/** Canonical cron task id shape (8 lower-hex chars) — doubles as the path-traversal guard. */
export const CRON_ID_REGEX: RegExp = /^[0-9a-f]{8}$/;

const JSON_SUFFIX = '.json';
const MAX_ID_ATTEMPTS = 8;

export function isValidCronTask(obj: unknown): obj is CronTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || !CRON_ID_REGEX.test(o['id'])) return false;
  if (typeof o['cron'] !== 'string') return false;
  if (typeof o['prompt'] !== 'string') return false;
  if (typeof o['createdAt'] !== 'number') return false;
  if (o['recurring'] !== undefined && typeof o['recurring'] !== 'boolean') return false;
  if (
    o['lastFiredAt'] !== undefined &&
    (typeof o['lastFiredAt'] !== 'number' || !Number.isFinite(o['lastFiredAt']))
  ) {
    return false;
  }
  return true;
}

function cronKey(id: string): string {
  if (!CRON_ID_REGEX.test(id)) {
    throw new Error(`Invalid cron job id: "${id}"`);
  }
  return `${id}${JSON_SUFFIX}`;
}

export class AgentCronService extends Disposable implements IAgentCronService {
  declare readonly _serviceBrand: undefined;

  // —— task set (the in-memory store) ——
  private readonly tasks = new Map<string, CronTask>();

  // —— scheduler bookkeeping ——
  private readonly parsedCache = new Map<string, ParsedCronExpression>();
  private readonly lastSeenAt = new Map<string, number>();
  private readonly seededFromDisk = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly timer = this._register(new IntervalTimer({ unref: true }));

  // —— persistence write serialization, keyed by task id ——
  private readonly persistQueues = new Map<string, Promise<void>>();

  readonly clocks: ClockSources;

  private readonly enabled: boolean;
  /**
   * HomeDir-relative atomic-document scope for this agent's cron tasks,
   * e.g. `sessions/<workspaceId>/<sessionId>/agents/<agentId>/cron`. Co-locates
   * the tasks with the agent's home directory (`<agentHomedir>/cron/<id>.json`),
   * matching the v1 layout. `undefined` when the agent has no id (ephemeral /
   * test seam) — persistence is then skipped, matching v1's "no homedir, no
   * persistence" behaviour.
   */
  private readonly cronScope: string | undefined;
  private cronConfig: CronConfig;
  private started = false;
  private sigusr1Handler: NodeJS.SignalsListener | null = null;

  constructor(
    @IAgentScopeContext private readonly ctx: IAgentScopeContext,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentTurnService private readonly turnService: IAgentTurnService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly config: IConfigService,
    @IAtomicDocumentStore private readonly atomicDocs: IAtomicDocumentStore,
  ) {
    super();
    this.enabled = this.ctx.agentId === 'main';
    // Co-locate cron tasks with the agent's home directory
    // (`sessions/<wsId>/<sId>/agents/<agentId>/cron/<id>.json`), matching the v1
    // layout so a session written by the CLI / v1 server is readable here and
    // vice-versa. `ctx.scope('cron')` is the agent-scoped persistence root's
    // `cron` sub-scope, addressed straight into `IAtomicDocumentStore`.
    this.cronScope =
      typeof this.ctx.agentId === 'string' ? this.ctx.scope('cron') : undefined;
    this.cronConfig = this.config.get<CronConfig>(CRON_SECTION) ?? DEFAULT_CRON_CONFIG;
    this._register(
      this.config.onDidChangeConfiguration((e) => {
        if (e.domain === CRON_SECTION) {
          this.cronConfig = this.config.get<CronConfig>(CRON_SECTION) ?? DEFAULT_CRON_CONFIG;
        }
      }),
    );
    this.clocks =
      resolveClockSources(this.cronConfig.clock, this.cronConfig.debug) ?? SYSTEM_CLOCKS;

    this._register(
      record.define('cron.add', {
        resume: (r) => {
          if (this.enabled) this.adopt(r.task);
        },
      }),
    );
    this._register(
      record.define('cron.delete', {
        resume: (r) => {
          if (this.enabled) this.removeByIds(r.ids);
        },
      }),
    );
    this._register(
      record.define('cron.cursor', {
        resume: (r) => {
          if (this.enabled) this.markFired(r.id, r.lastFiredAt);
        },
      }),
    );
    this._register(
      record.hooks.onResumeEnded.register('cron-lifecycle-resume', async (_ctx, next) => {
        await this.loadFromDisk({ replace: false });
        this.start();
        await next();
      }),
    );

    if (this.enabled) {
      this.start();
    }

    this._register(
      toDisposable(() => {
        void this.stop();
      }),
    );
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  now(): number {
    return this.clocks.wallNow();
  }

  // —— task CRUD ——

  addTask(init: CronTaskInit): CronTask {
    const task: CronTask = {
      ...init,
      id: this.generateUniqueId(),
      createdAt: this.clocks.wallNow(),
    };
    this.tasks.set(task.id, task);
    this.record.append({ type: 'cron.add', task });
    this.persistEnqueue(task.id, (scope) => this.atomicDocs.set(scope, cronKey(task.id), task));
    return task;
  }

  removeTasks(ids: readonly string[]): readonly string[] {
    const removed = this.removeByIds(ids);
    if (removed.length === 0) return removed;

    this.record.append({ type: 'cron.delete', ids: removed });
    for (const id of removed) {
      this.persistEnqueue(id, (scope) => this.atomicDocs.delete(scope, cronKey(id)));
    }
    return removed;
  }

  getTask(id: string): CronTask | undefined {
    return this.tasks.get(id);
  }

  list(): readonly CronTask[] {
    return Array.from(this.tasks.values());
  }

  // —— scheduling queries ——

  isStale(task: CronTask): boolean {
    return this.isStaleAt(task, this.clocks.wallNow());
  }

  getNextFireTime(): number | null {
    if (this.tasks.size === 0) return null;
    let min: number | null = null;
    for (const task of this.tasks.values()) {
      const next = this.nextFireFor(task);
      if (next === null) continue;
      if (min === null || next < min) min = next;
    }
    return min;
  }

  getNextFireForTask(taskId: string): number | null {
    const task = this.tasks.get(taskId);
    if (task === undefined) return null;
    return this.nextFireFor(task);
  }

  // —— lifecycle ——

  async loadFromDisk(options: CronLoadOptions = {}): Promise<void> {
    if (!this.enabled) return;
    if (this.cronScope === undefined) return;
    const scope = this.cronScope;
    if (options.replace !== false) {
      this.tasks.clear();
    }
    const keys = await this.atomicDocs.list(scope);
    for (const key of keys) {
      if (!key.endsWith(JSON_SUFFIX)) continue;
      const id = key.slice(0, -JSON_SUFFIX.length);
      if (!CRON_ID_REGEX.test(id)) continue;
      const value = await this.atomicDocs.get<CronTask>(scope, key);
      if (value === undefined || !isValidCronTask(value)) continue;
      this.adopt(value);
    }
  }

  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;

    const poll = this.cronConfig.manualTick ? null : this.cronConfig.pollIntervalMs;
    const interval = poll === undefined ? DEFAULT_POLL_INTERVAL_MS : poll;
    if (interval !== null && interval !== 0) {
      this.timer.cancelAndSet(() => this.tick(), interval);
    }
    this.bindSigusr1();
  }

  async stop(): Promise<void> {
    this.unbindSigusr1();
    this.timer.cancel();
    this.inFlight.clear();
    this.lastSeenAt.clear();
    this.seededFromDisk.clear();
    this.parsedCache.clear();
    await this.flushPersist();
    this.started = false;
  }

  tick(): void {
    if (this.cronConfig.disabled) return;
    if (this.turnService.getActiveTurn() !== undefined) return;
    if (this.tasks.size === 0) return;

    const now = this.clocks.wallNow();

    try {
      for (const task of this.list()) {
        try {
          if (this.inFlight.has(task.id)) continue;

          const parsed = this.getParsed(task.cron);

          if (
            !this.seededFromDisk.has(task.id) &&
            task.lastFiredAt !== undefined &&
            Number.isFinite(task.lastFiredAt) &&
            task.lastFiredAt <= now &&
            !this.lastSeenAt.has(task.id)
          ) {
            this.lastSeenAt.set(task.id, task.lastFiredAt);
          }
          this.seededFromDisk.add(task.id);

          const seen = this.lastSeenAt.get(task.id);
          const baseFromMs =
            seen !== undefined && seen > task.createdAt ? seen : task.createdAt;

          const nextFireAt = this.computeJitteredNext(task, parsed, baseFromMs);
          if (nextFireAt === null) continue;
          if (now < nextFireAt) continue;

          const ideal = computeNextCronRun(parsed, baseFromMs);
          let coalescedCount = 1;
          let lastDueMs: number | null = null;
          if (task.recurring !== false && ideal !== null) {
            const result = this.countCoalesced(task, parsed, ideal, now);
            coalescedCount = Math.max(1, result.count);
            lastDueMs = result.lastDueMs;
          }

          this.inFlight.add(task.id);
          let delivered = false;
          try {
            this.deliverDue(task, coalescedCount);
            delivered = true;
          } catch (error) {
            this.debugLog(
              `deliverDue threw for task ${task.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          if (!delivered) continue;

          if (task.recurring === false) {
            this.removeTasks([task.id]);
            this.lastSeenAt.delete(task.id);
            this.seededFromDisk.delete(task.id);
          } else {
            const advancedTo = lastDueMs ?? now;
            this.lastSeenAt.set(task.id, advancedTo);
            this.advanceCursor(task.id, advancedTo);
          }
        } catch (error) {
          this.debugLog(
            `tick failed for task ${task.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      this.inFlight.clear();
    }
  }

  async flushPersist(): Promise<void> {
    const inFlight = Array.from(this.persistQueues.values());
    await Promise.allSettled(inFlight);
  }

  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (tasks: readonly CronTask[]) => readonly ContentPart[],
  ): Turn | undefined {
    if (!this.enabled || tasks.length === 0) return undefined;
    const origin: CronMissedOrigin = {
      kind: 'cron_missed',
      count: tasks.length,
    };
    const message: ContextMessage = {
      role: 'user',
      content: [...renderMissedNotification(tasks)],
      toolCalls: [],
      origin,
    };
    const turn = this.prompt.steer(message);
    this.telemetry.track(CRON_MISSED, { count: tasks.length });
    return turn;
  }

  emitScheduled(task: CronTask): void {
    this.telemetry.track(CRON_SCHEDULED, {
      recurring: task.recurring !== false,
    });
  }

  emitDeleted(taskId: string): void {
    this.telemetry.track(CRON_DELETED, { task_id: taskId });
  }

  // —— fire delivery ——

  private deliverDue(task: CronTask, coalescedCount: number): void {
    const firedAt = this.clocks.wallNow();
    const stale = this.isStaleAt(task, firedAt);
    this.deliverFire(task, { coalescedCount, firedAt });
    if (stale && task.recurring !== false) {
      const removed = this.removeTasks([task.id]);
      if (removed.length > 0) this.emitDeleted(task.id);
    }
  }

  private deliverFire(
    task: CronTask,
    ctx: { readonly coalescedCount: number; readonly firedAt: number },
  ): Turn | undefined {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      coalescedCount: ctx.coalescedCount,
      stale: this.isStaleAt(task, ctx.firedAt),
    };
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: renderCronFireXml(origin, task.prompt),
        },
      ],
      toolCalls: [],
      origin,
    };
    this.record.signal({ type: 'cron.fired', origin, prompt: task.prompt });
    const turn = this.prompt.steer(message);
    this.telemetry.track(CRON_FIRED, {
      recurring: task.recurring !== false,
      coalesced_count: ctx.coalescedCount,
      stale: origin.stale,
      buffered: turn === undefined,
    });
    return turn;
  }

  private advanceCursor(id: string, lastFiredAt: number): void {
    const updated = this.markFired(id, lastFiredAt);
    if (updated === undefined) return;

    this.record.append({ type: 'cron.cursor', id, lastFiredAt });
    this.persistEnqueue(id, (scope) => this.atomicDocs.set(scope, cronKey(id), updated));
  }

  // —— scheduler helpers ——

  private getParsed(expr: string): ParsedCronExpression {
    const cached = this.parsedCache.get(expr);
    if (cached !== undefined) return cached;
    const parsed = parseCronExpression(expr);
    this.parsedCache.set(expr, parsed);
    return parsed;
  }

  private computeJitteredNext(
    task: CronTask,
    parsed: ParsedCronExpression,
    baseMs: number,
  ): number | null {
    const ideal = computeNextCronRun(parsed, baseMs);
    if (ideal === null) return null;
    if (task.recurring === false) {
      return oneShotJitteredNextCronRunMs(task, ideal, undefined, this.cronConfig.noJitter);
    }
    return jitteredNextCronRunMs(task, parsed, ideal, undefined, this.cronConfig.noJitter);
  }

  private countCoalesced(
    task: CronTask,
    parsed: ParsedCronExpression,
    firstFireMs: number,
    nowMs: number,
  ): { count: number; lastDueMs: number } {
    let count = 1;
    let cursor = firstFireMs;
    let lastDueMs = firstFireMs;
    while (count < MAX_COALESCE_ITERATIONS) {
      const next = computeNextCronRun(parsed, cursor);
      if (next === null) break;
      if (next > nowMs) break;
      const jitteredNext =
        task.recurring === false
          ? oneShotJitteredNextCronRunMs(task, next, undefined, this.cronConfig.noJitter)
          : jitteredNextCronRunMs(task, parsed, next, undefined, this.cronConfig.noJitter);
      if (jitteredNext > nowMs) break;
      count++;
      cursor = next;
      lastDueMs = next;
    }
    return { count, lastDueMs };
  }

  private nextFireFor(task: CronTask): number | null {
    try {
      const parsed = this.getParsed(task.cron);
      const seen = this.lastSeenAt.get(task.id);
      const persistedCursor =
        task.lastFiredAt !== undefined &&
        Number.isFinite(task.lastFiredAt) &&
        task.lastFiredAt <= this.clocks.wallNow()
          ? task.lastFiredAt
          : undefined;
      const cursor =
        seen !== undefined
          ? seen
          : persistedCursor !== undefined
            ? persistedCursor
            : undefined;
      const baseFromMs =
        cursor !== undefined && cursor > task.createdAt ? cursor : task.createdAt;
      return this.computeJitteredNext(task, parsed, baseFromMs);
    } catch (error) {
      this.debugLog(
        `nextFireFor skipping task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private debugLog(message: string): void {
    if (this.cronConfig.debug) {
      process.stderr.write(`[cron/service] ${message}\n`);
    }
  }

  // —— task-set primitives ——

  private adopt(task: CronTask): void {
    this.tasks.set(task.id, task);
  }

  private markFired(id: string, lastFiredAt: number): CronTask | undefined {
    const existing = this.tasks.get(id);
    if (existing === undefined) return undefined;
    const updated: CronTask = { ...existing, lastFiredAt };
    this.tasks.set(id, updated);
    return updated;
  }

  private removeByIds(ids: readonly string[]): readonly string[] {
    const removed: string[] = [];
    for (const id of ids) {
      if (this.tasks.delete(id)) {
        removed.push(id);
      }
    }
    return removed;
  }

  private generateUniqueId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const candidate = randomBytes(4).toString('hex');
      if (!CRON_ID_REGEX.test(candidate)) continue;
      if (!this.tasks.has(candidate)) return candidate;
    }
    throw new Error(
      `AgentCronService: failed to generate a unique 8-hex id after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }

  private isStaleAt(task: CronTask, now: number): boolean {
    if (this.cronConfig.noStale) return false;
    if (task.recurring === false) return false;
    const age = now - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }

  // —— persistence write serialization ——

  private persistEnqueue(id: string, work: (scope: string) => Promise<void>): void {
    if (this.cronScope === undefined) return;
    const scope = this.cronScope;
    const prev = this.persistQueues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => work(scope))
      .catch(() => {})
      .finally(() => {
        if (this.persistQueues.get(id) === next) {
          this.persistQueues.delete(id);
        }
      });
    this.persistQueues.set(id, next);
  }

  // —— SIGUSR1 manual-tick hook ——

  private bindSigusr1(): void {
    if (process.platform === 'win32') return;
    if (!this.cronConfig.manualTick) return;
    if (this.sigusr1Handler !== null) return;
    const handler: NodeJS.SignalsListener = () => {
      try {
        this.tick();
      } catch (error) {
        if (this.cronConfig.debug) {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[cron/service] SIGUSR1 tick threw: ${msg}\n`);
        }
      }
    };
    this.sigusr1Handler = handler;
    process.on('SIGUSR1', handler);
  }

  private unbindSigusr1(): void {
    if (this.sigusr1Handler === null) return;
    process.off('SIGUSR1', this.sigusr1Handler);
    this.sigusr1Handler = null;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCronService,
  AgentCronService,
  InstantiationType.Delayed,
  'cron',
);
