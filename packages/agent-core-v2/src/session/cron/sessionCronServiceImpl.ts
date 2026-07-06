/**
 * `cron` domain (L5) — `SessionCronService` implementation.
 *
 * Session-level scheduling engine. Holds the in-memory task map (filtered
 * from `ICronTaskPersistence` by `sessionId` tag), runs the polling timer
 * (tick / coalesce / jitter / cursor), persists mutations through the
 * App-scoped `ICronTaskPersistence`, mirrors mutations as `cron.add` /
 * `cron.delete` / `cron.cursor` Ops on the main agent's `wire` (cross-scope
 * borrow) so `wire.replay` can rebuild the `CronModel`, fires `cron.fired`
 * through the main agent's `wire` signal channel, steers the main agent
 * through `IAgentPromptService` when a task fires, and registers the cron
 * tools (`CronCreate` / `CronList` / `CronDelete`) into the main agent's
 * `IAgentToolRegistryService` once `IAgentLifecycleService` signals
 * `onDidCreateMain`. Bound at Session scope.
 */

import { randomBytes } from 'node:crypto';

import type { ContentPart } from '#/app/llmProtocol';
import type { CronJobOrigin, CronMissedOrigin } from '@moonshot-ai/protocol';

import { Disposable, toDisposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IntervalTimer } from '#/_base/utils';

import { IConfigService } from '#/app/config';
import { ITelemetryService } from '#/app/telemetry';
import {
  computeNextCronRun,
  type ClockSources,
  type CronConfig,
  type CronTask,
  type CronTaskInit,
  CRON_SECTION,
  DEFAULT_CRON_CONFIG,
  ICronTaskPersistence,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
  parseCronExpression,
  type ParsedCronExpression,
  renderCronFireXml,
  resolveClockSources,
  SYSTEM_CLOCKS,
} from '#/app/cron';
import { ISessionContext } from '#/session/sessionContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle';
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentWireService, type Op, type Signal } from '#/wire';
import { type DomainEvent, IEventBus } from '#/app/event';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { Turn } from '#/agent/turn';
import { IAgentTurnService } from '#/agent/turn';

import { CronCreateTool } from './tools/cron-create';
import { CronListTool } from './tools/cron-list';
import { CronDeleteTool } from './tools/cron-delete';

import { CronModel, cronAdd, cronDelete, cronCursor } from './cronOps';
import { ISessionCronService, type CronLoadOptions } from './sessionCronService';

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
const MAX_COALESCE_ITERATIONS = 10_000;
const CRON_ID_REGEX: RegExp = /^[0-9a-f]{8}$/;
const MAX_ID_ATTEMPTS = 8;
const SESSION_TAG = 'sessionId';

export class SessionCronServiceImpl extends Disposable implements ISessionCronService {
  declare readonly _serviceBrand: undefined;

  private readonly tasks = new Map<string, CronTask>();
  private readonly parsedCache = new Map<string, ParsedCronExpression>();
  private readonly lastSeenAt = new Map<string, number>();
  private readonly seededFromStore = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly timer = this._register(new IntervalTimer({ unref: true }));
  private readonly persistQueues = new Map<string, Promise<void>>();

  readonly clocks: ClockSources;
  readonly isEnabled: boolean = true;

  private cronConfig: CronConfig;
  private started = false;
  private sigusr1Handler: NodeJS.SignalsListener | null = null;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ICronTaskPersistence private readonly store: ICronTaskPersistence,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
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
      this.agentLifecycle.onDidCreateMain((handle) => {
        this.bindMainAgent(handle);
      }),
    );

    const existingMain = this.agentLifecycle.getHandle('main');
    if (existingMain) {
      this.bindMainAgent(existingMain);
    }

    this._register(
      toDisposable(() => {
        void this.stop();
      }),
    );
  }

  private bindMainAgent(handle: IAgentScopeHandle): void {
    const wire = handle.accessor.get(IAgentWireService);
    this._register(
      wire.onRestored(() => {
        this.tasks.clear();
        for (const [id, task] of wire.getModel(CronModel)) {
          this.tasks.set(id, task as CronTask);
        }
        void this.loadFromStore({ replace: false }).then(() => this.start());
      }),
    );

    this.registerCronTools(handle);

    void this.loadFromStore().then(() => this.start());
  }

  private registerCronTools(handle: IAgentScopeHandle): void {
    const instantiation = handle.accessor.get(IInstantiationService);
    const registry = handle.accessor.get(IAgentToolRegistryService);
    const tools = [
      instantiation.createInstance(CronCreateTool, this.cronConfig.disabled),
      instantiation.createInstance(CronListTool),
      instantiation.createInstance(CronDeleteTool),
    ];
    for (const tool of tools) {
      this._register(registry.register(tool, { source: 'builtin' }));
    }
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
      tags: { ...init.tags, [SESSION_TAG]: this.ctx.sessionId },
    };
    this.tasks.set(task.id, task);
    this.dispatchCron(cronAdd({ task }));
    this.persistEnqueue(task.id, () =>
      this.store.save(this.ctx.workspaceId, task),
    );
    return task;
  }

  removeTasks(ids: readonly string[]): readonly string[] {
    const removed = this.removeByIds(ids);
    if (removed.length === 0) return removed;

    this.dispatchCron(cronDelete({ ids: removed }));
    for (const id of removed) {
      this.persistEnqueue(id, () =>
        this.store.delete(this.ctx.workspaceId, id),
      );
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

  async loadFromStore(options: CronLoadOptions = {}): Promise<void> {
    if (options.replace !== false) {
      this.tasks.clear();
    }
    const allTasks = await this.store.list({ workspaceId: this.ctx.workspaceId });
    for (const task of allTasks) {
      if (task.tags?.[SESSION_TAG] !== this.ctx.sessionId) continue;
      this.adopt(task);
    }
  }

  start(): void {
    if (this.started) return;
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
    this.seededFromStore.clear();
    this.parsedCache.clear();
    await this.flushPersist();
    this.started = false;
  }

  tick(): void {
    if (this.cronConfig.disabled) return;
    if (this.tasks.size === 0) return;

    const mainHandle = this.agentLifecycle.getHandle('main');
    if (!mainHandle) return;

    const turnService = mainHandle.accessor.get(IAgentTurnService);
    if (turnService.getActiveTurn() !== undefined) return;

    const now = this.clocks.wallNow();

    try {
      for (const task of this.list()) {
        try {
          if (this.inFlight.has(task.id)) continue;

          const parsed = this.getParsed(task.cron);

          if (
            !this.seededFromStore.has(task.id) &&
            task.lastFiredAt !== undefined &&
            Number.isFinite(task.lastFiredAt) &&
            task.lastFiredAt <= now &&
            !this.lastSeenAt.has(task.id)
          ) {
            this.lastSeenAt.set(task.id, task.lastFiredAt);
          }
          this.seededFromStore.add(task.id);

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
            this.seededFromStore.delete(task.id);
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
    if (tasks.length === 0) return undefined;

    const mainHandle = this.agentLifecycle.getHandle('main');
    if (!mainHandle) return undefined;

    const promptService = mainHandle.accessor.get(IAgentPromptService);

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
    void promptService.steer(message).launched.catch(() => {});
    this.telemetry.track(CRON_MISSED, { count: tasks.length });
    return undefined;
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
    const mainHandle = this.agentLifecycle.getHandle('main');
    if (!mainHandle) return undefined;

    const promptService = mainHandle.accessor.get(IAgentPromptService);

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
    this.signalCron({ type: 'cron.fired', origin, prompt: task.prompt });
    const buffered = mainHandle.accessor.get(IAgentTurnService).getActiveTurn() !== undefined;
    void promptService.steer(message).launched.catch(() => {});
    this.telemetry.track(CRON_FIRED, {
      recurring: task.recurring !== false,
      coalesced_count: ctx.coalescedCount,
      stale: origin.stale,
      buffered,
    });
    return undefined;
  }

  private advanceCursor(id: string, lastFiredAt: number): void {
    const updated = this.markFired(id, lastFiredAt);
    if (updated === undefined) return;

    this.dispatchCron(cronCursor({ id, lastFiredAt }));
    this.persistEnqueue(id, () =>
      this.store.save(this.ctx.workspaceId, updated),
    );
  }

  // —— wire borrow helpers ——

  private dispatchCron(op: Op): void {
    const mainHandle = this.agentLifecycle.getHandle('main');
    if (!mainHandle) return;
    mainHandle.accessor.get(IAgentWireService).dispatch(op);
  }

  private signalCron(signal: Signal): void {
    const mainHandle = this.agentLifecycle.getHandle('main');
    if (!mainHandle) return;
    mainHandle.accessor.get(IEventBus).publish(signal as DomainEvent);
    mainHandle.accessor.get(IAgentWireService).signal(signal);
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
      process.stderr.write(`[cron/session] ${message}\n`);
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
      `SessionCronService: failed to generate a unique 8-hex id after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }

  private isStaleAt(task: CronTask, now: number): boolean {
    if (this.cronConfig.noStale) return false;
    if (task.recurring === false) return false;
    const age = now - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }

  // —— persistence write serialization ——

  private persistEnqueue(id: string, work: () => Promise<void>): void {
    const prev = this.persistQueues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => work())
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
          process.stderr.write(`[cron/session] SIGUSR1 tick threw: ${msg}\n`);
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
  LifecycleScope.Session,
  ISessionCronService,
  SessionCronServiceImpl,
  InstantiationType.Delayed,
  'cron',
);
