/**
 * `cron` domain (L5) — `SessionCronService` implementation.
 *
 * Session-level scheduling engine. Holds the in-memory task map (filtered
 * from `ICronTaskPersistence` by `sessionId` tag), runs the polling timer
 * (tick / coalesce / jitter / cursor), persists mutations through the
 * App-scoped `ICronTaskPersistence`, mirrors mutations as `cron.add` /
 * `cron.delete` / `cron.cursor` Ops on the main agent's `wire` (cross-scope
 * borrow) so wire restore can rebuild the `CronModel`, publishes `cron.fired`
 * to the main agent's `IEventBus`, steers the main agent
 * through `IAgentPromptService` when a task fires, and registers the cron
 * tools (`CronCreate` / `CronList` / `CronDelete`) into the main agent's
 * `IAgentToolRegistryService` once `IAgentLifecycleService` signals
 * `onDidCreateMain`. Bound at Session scope.
 */

import { ulid } from 'ulid';

import type { ContentPart } from '#/kosong/contract/message';
import type { CronJobOrigin, CronMissedOrigin } from '#/agent/contextMemory/types';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IntervalTimer } from '#/_base/utils/timer';

import { IConfigService } from '#/app/config/config';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { type ClockSources, resolveClockSources, SYSTEM_CLOCKS } from '#/app/cron/clock';
import { type CronConfig, CRON_SECTION } from '#/app/cron/configSection';
import { computeNextCronRun, parseCronExpression, type ParsedCronExpression } from '#/app/cron/cron-expr';
import { CRON_SESSION_TAG, type CronTask, type CronTaskInit } from '#/app/cron/cronTask';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { renderCronFireXml } from '#/app/cron/format';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from '#/app/cron/jitter';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { Op } from '#/wire/op';
import { IWireService } from '#/wire/wire';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';

import { CronCreateTool } from './tools/cron-create';
import { CronListTool } from './tools/cron-list';
import { CronDeleteTool } from './tools/cron-delete';

import { CronModel, cronAdd, cronDelete, cronCursor } from './cronOps';
import { ISessionCronService, type CronLoadOptions } from './sessionCronService';

export const CRON_SCHEDULED = 'cron_scheduled' as const;
export const CRON_FIRED = 'cron_fired' as const;
export const CRON_MISSED = 'cron_missed' as const;
export const CRON_DELETED = 'cron_deleted' as const;

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_COALESCE_ITERATIONS = 10_000;
const CRON_ID_REGEX: RegExp = /^(?:[0-9a-f]{8}|[0-9A-HJKMNP-TV-Z]{26})$/i;
const MAX_ID_ATTEMPTS = 8;

export class SessionCronServiceImpl extends Disposable implements ISessionCronService {
  declare readonly _serviceBrand: undefined;

  private readonly tasks = new Map<string, CronTask>();
  private readonly parsedCache = new Map<string, ParsedCronExpression>();
  private readonly lastSeenAt = new Map<string, number>();
  private readonly seededFromStore = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly timer = this._register(new IntervalTimer({ unref: true }));
  private readonly persistQueues = new Map<string, Promise<void>>();

  private clocks: ClockSources = SYSTEM_CLOCKS;
  readonly isEnabled: boolean = true;

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

    this._register(
      this.agentLifecycle.onDidCreate((handle) => {
        if (handle.id !== 'main') return;
        this.bindMainAgent(handle);
      }),
    );

    const existingMain = this.agentLifecycle.get('main');
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
    const wire = handle.accessor.get(IWireService);
    this._register(
      wire.hooks.onDidRestore.register('cron', async (_ctx, next) => {
        await this.config.ready;
        this.resolveClocks();
        this.tasks.clear();
        for (const [id, task] of wire.getModel(CronModel)) {
          this.tasks.set(id, task as CronTask);
        }
        await this.loadFromStore({ replace: false });
        await this.start();
        await next();
      }),
    );

    this.registerCronTools(handle);
  }

  private registerCronTools(handle: IAgentScopeHandle): void {
    const instantiation = handle.accessor.get(IInstantiationService);
    const registry = handle.accessor.get(IAgentToolRegistryService);
    const tools = [
      instantiation.createInstance(CronCreateTool),
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

  private resolveClocks(): void {
    const cfg = this.getCronConfig();
    this.clocks = resolveClockSources(cfg.clock, cfg.debug) ?? SYSTEM_CLOCKS;
  }

  private getCronConfig(): CronConfig {
    return this.config.get<CronConfig>(CRON_SECTION);
  }

  isDisabled(): boolean {
    return this.getCronConfig().disabled;
  }


  addTask(init: CronTaskInit): CronTask {
    const task: CronTask = {
      ...init,
      id: this.generateUniqueId(),
      createdAt: this.clocks.wallNow(),
      tags: { ...init.tags, [CRON_SESSION_TAG]: this.ctx.sessionId },
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


  async loadFromStore(options: CronLoadOptions = {}): Promise<void> {
    if (options.replace !== false) {
      this.tasks.clear();
    }
    const allTasks = await this.store.list({ workspaceId: this.ctx.workspaceId });
    for (const task of allTasks) {
      const owner = task.tags?.[CRON_SESSION_TAG];
      if (owner !== undefined && owner !== this.ctx.sessionId) continue;
      if (owner === undefined) {
        const claimed: CronTask = {
          ...task,
          tags: { ...task.tags, [CRON_SESSION_TAG]: this.ctx.sessionId },
        };
        this.adopt(claimed);
        this.persistEnqueue(claimed.id, () =>
          this.store.save(this.ctx.workspaceId, claimed),
        );
        continue;
      }
      this.adopt(task);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.config.ready;
    const cfg = this.getCronConfig();
    const poll = cfg.manualTick ? null : cfg.pollIntervalMs;
    const interval = poll === undefined ? DEFAULT_POLL_INTERVAL_MS : poll;
    if (interval !== null && interval !== 0) {
      this.timer.cancelAndSet(() => { void this.tick(); }, interval);
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

  async tick(): Promise<void> {
    await this.config.ready;
    if (this.getCronConfig().disabled) return;
    if (this.tasks.size === 0) return;

    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return;

    const loop = mainHandle.accessor.get(IAgentLoopService);
    if (loop.status().state === 'running') return;

    const now = this.clocks.wallNow();

    const work: Promise<void>[] = [];
    for (const task of this.list()) {
      work.push(this.processDue(task, now));
    }
    await Promise.all(work);
  }

  private async processDue(task: CronTask, now: number): Promise<void> {
    if (this.inFlight.has(task.id)) return;

    let parsed: ParsedCronExpression;
    try {
      parsed = this.getParsed(task.cron);
    } catch (error) {
      this.debugLog(
        `tick failed to parse cron for task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

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
    if (nextFireAt === null) return;
    if (now < nextFireAt) return;

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
      delivered = await this.deliverDue(task, coalescedCount);
    } catch (error) {
      this.debugLog(
        `deliverDue threw for task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.inFlight.delete(task.id);
    }
    if (!delivered) return;

    if (task.recurring === false) {
      this.removeTasks([task.id]);
      this.lastSeenAt.delete(task.id);
      this.seededFromStore.delete(task.id);
    } else {
      const advancedTo = lastDueMs ?? now;
      this.lastSeenAt.set(task.id, advancedTo);
      this.advanceCursor(task.id, advancedTo);
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

    const mainHandle = this.agentLifecycle.get('main');
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
    void promptService.inject(message).catch(() => {});
    this.telemetry.track2(CRON_MISSED, { count: tasks.length });
    return undefined;
  }

  emitScheduled(task: CronTask): void {
    this.telemetry.track2(CRON_SCHEDULED, {
      recurring: task.recurring !== false,
    });
  }

  emitDeleted(taskId: string): void {
    this.telemetry.track2(CRON_DELETED, { task_id: taskId });
  }


  private async deliverDue(task: CronTask, coalescedCount: number): Promise<boolean> {
    const firedAt = this.clocks.wallNow();
    const stale = this.isStaleAt(task, firedAt);
    const delivered = await this.deliverFire(task, { coalescedCount, firedAt });
    if (delivered && stale && task.recurring !== false) {
      const removed = this.removeTasks([task.id]);
      if (removed.length > 0) this.emitDeleted(task.id);
    }
    return delivered;
  }

  private deliverFire(
    task: CronTask,
    ctx: { readonly coalescedCount: number; readonly firedAt: number },
  ): Promise<boolean> {
    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return Promise.resolve(false);

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
    const buffered = mainHandle.accessor.get(IAgentLoopService).status().state === 'running';

    let launched: Promise<unknown>;
    try {
      launched = promptService.inject(message);
    } catch (error) {
      this.debugLog(
        `steer threw for task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return Promise.resolve(false);
    }

    return launched.then(
      () => {
        this.signalCron({ type: 'cron.fired', origin, prompt: task.prompt });
        this.telemetry.track2(CRON_FIRED, {
          recurring: task.recurring !== false,
          coalesced_count: ctx.coalescedCount,
          stale: origin.stale,
          buffered,
        });
        return true;
      },
      (error: unknown) => {
        this.debugLog(
          `steer launch rejected for task ${task.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      },
    );
  }

  private advanceCursor(id: string, lastFiredAt: number): void {
    const updated = this.markFired(id, lastFiredAt);
    if (updated === undefined) return;

    this.dispatchCron(cronCursor({ id, lastFiredAt }));
    this.persistEnqueue(id, () =>
      this.store.save(this.ctx.workspaceId, updated),
    );
  }


  private dispatchCron(op: Op): void {
    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return;
    mainHandle.accessor.get(IWireService).dispatch(op);
  }

  private signalCron(event: DomainEvent): void {
    const mainHandle = this.agentLifecycle.get('main');
    if (!mainHandle) return;
    mainHandle.accessor.get(IEventBus).publish(event);
  }


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
      return oneShotJitteredNextCronRunMs(task, ideal, undefined, this.getCronConfig().noJitter);
    }
    return jitteredNextCronRunMs(task, parsed, ideal, undefined, this.getCronConfig().noJitter);
  }

  computeDisplayNextFire(
    task: CronTask,
    parsed: ParsedCronExpression,
    idealMs: number,
  ): number | null {
    const noJitter = this.getCronConfig().noJitter;
    if (task.recurring === false) {
      return oneShotJitteredNextCronRunMs(task, idealMs, undefined, noJitter);
    }
    return jitteredNextCronRunMs(task, parsed, idealMs, undefined, noJitter);
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
          ? oneShotJitteredNextCronRunMs(task, next, undefined, this.getCronConfig().noJitter)
          : jitteredNextCronRunMs(task, parsed, next, undefined, this.getCronConfig().noJitter);
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
    if (this.getCronConfig().debug) {
      process.stderr.write(`[cron/session] ${message}\n`);
    }
  }


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
      const candidate = ulid();
      if (!CRON_ID_REGEX.test(candidate)) continue;
      if (!this.tasks.has(candidate)) return candidate;
    }
    throw new Error(
      `SessionCronService: failed to generate a unique ULID after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }

  private isStaleAt(task: CronTask, now: number): boolean {
    if (this.getCronConfig().noStale) return false;
    if (task.recurring === false) return false;
    const age = now - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }


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


  private bindSigusr1(): void {
    if (process.platform === 'win32') return;
    if (!this.getCronConfig().manualTick) return;
    if (this.sigusr1Handler !== null) return;
    const handler: NodeJS.SignalsListener = () => {
      try {
        void this.tick();
      } catch (error) {
        if (this.getCronConfig().debug) {
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
  InstantiationType.Eager,
  'cron',
);
