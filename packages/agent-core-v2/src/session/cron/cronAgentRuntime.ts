import { ulid } from 'ulid';
import { assign, fromCallback, setup, type AnyActorRef, type EventObject, type Snapshot } from 'xstate';

import { DisposableStore } from '#/_base/di/lifecycle';
import { IntervalTimer } from '#/_base/utils/timer';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { CronJobOrigin, CronMissedOrigin, ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { type AgentRuntimeContext, defineAgentRuntime } from '#/agent/runtime/agentRuntime';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ICronCreateTool } from '#/agent/tools/cron/cron-create/cron-create';
import { ICronDeleteTool } from '#/agent/tools/cron/cron-delete/cron-delete';
import { ICronListTool } from '#/agent/tools/cron/cron-list/cron-list';
import { IConfigService } from '#/app/config/config';
import { type ClockSources, resolveClockSources, SYSTEM_CLOCKS } from '#/app/cron/clock';
import { type CronConfig, CRON_SECTION } from '#/app/cron/configSection';
import { computeNextCronRun, parseCronExpression, type ParsedCronExpression } from '#/app/cron/cron-expr';
import type { CronTask, CronTaskInit } from '#/app/cron/cronTask';
import { renderCronFireXml } from '#/app/cron/format';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from '#/app/cron/jitter';
import type { CronDeletedEvent, CronScheduledEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { BugIndicatingError } from '#/errors';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentManager, MAIN_AGENT_ID } from '#/session/agentManager/agentManager';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { AgentCron, IAgentCron } from './agentCron';
import { CronAdd, CronCursor, CronDelete, CronFired, type CronModelState } from './cronOps';

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_COALESCE_ITERATIONS = 10_000;
const CRON_ID_REGEX: RegExp = /^(?:[0-9a-f]{8}|[0-9A-HJKMNP-TV-Z]{26})$/i;
const MAX_ID_ATTEMPTS = 8;

export const CRON_SCHEDULED = 'cron_scheduled' as const;
export const CRON_FIRED = 'cron_fired' as const;
export const CRON_MISSED = 'cron_missed' as const;
export const CRON_DELETED = 'cron_deleted' as const;

interface CronActivation {
  readonly runtime: AgentRuntimeContext<CronModelState>;
  readonly scheduler: CronScheduler;
}

interface CronActorContext {
  readonly tasks: CronModelState;
  readonly activation?: CronActivation;
}

interface CronCommitEvent {
  readonly type: 'cron.commit';
  readonly tasks: CronModelState;
}

interface CronActivateEvent {
  readonly type: 'cron.activate';
  readonly activation: CronActivation;
}

type CronActorEvent = CronCommitEvent | CronActivateEvent;

type CronActorSnapshot = Snapshot<unknown> & { readonly context: CronActorContext };

class CronScheduler {
  private clocks: ClockSources = SYSTEM_CLOCKS;
  private timer: IntervalTimer | undefined;
  private sigusr1Handler: NodeJS.SignalsListener | null = null;
  private readonly parsedCache = new Map<string, ParsedCronExpression>();
  private readonly lastSeenAt = new Map<string, number>();
  private readonly seededFromStore = new Set<string>();
  private readonly inFlight = new Set<string>();
  private started = false;

  constructor(private readonly runtime: AgentRuntimeContext<CronModelState>) {}

  attach(): () => void {
    if (this.runtime.agent.agentId !== MAIN_AGENT_ID) return () => {};
    const store = new DisposableStore();
    this.timer = store.add(new IntervalTimer({ unref: true }));
    const dispatcher = this.runtime.get(IEventDispatcher);
    store.add(
      dispatcher.hooks.onDidRestore.register('cron', async (_ctx, next) => {
        await this.config().ready;
        this.resolveClocks();
        await this.start();
        await next();
      }),
    );
    const registry = this.runtime.get(IAgentToolRegistryService);
    const tools = [
      this.runtime.get(ICronCreateTool),
      this.runtime.get(ICronListTool),
      this.runtime.get(ICronDeleteTool),
    ];
    for (const tool of tools) {
      store.add(registry.register(tool, { source: 'builtin' }));
    }
    return () => {
      void this.stop();
      store.dispose();
    };
  }

  private get tasks(): ReadonlyMap<string, CronTask> {
    return this.runtime.getState();
  }

  private config(): IConfigService {
    return this.runtime.get(IConfigService);
  }

  private telemetry(): ITelemetryService {
    return this.runtime.get(ITelemetryService);
  }

  private getCronConfig(): CronConfig {
    return this.config().get<CronConfig>(CRON_SECTION);
  }

  private resolveClocks(): void {
    const cfg = this.getCronConfig();
    this.clocks = resolveClockSources(cfg.clock, cfg.debug) ?? SYSTEM_CLOCKS;
  }

  now(): number {
    return this.clocks.wallNow();
  }

  isDisabled(): boolean {
    return this.getCronConfig().disabled;
  }

  addTask(init: CronTaskInit): CronTask {
    const task: CronTask = {
      ...init,
      id: this.generateUniqueId(),
      createdAt: this.clocks.wallNow(),
    };
    void this.runtime.dispatch(new CronAdd({ task }));
    return task;
  }

  removeTasks(ids: readonly string[]): readonly string[] {
    const removed = ids.filter((id) => this.tasks.has(id));
    if (removed.length === 0) return removed;
    void this.runtime.dispatch(new CronDelete({ ids: removed }));
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

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.config().ready;
    const cfg = this.getCronConfig();
    const poll = cfg.manualTick ? null : cfg.pollIntervalMs;
    const interval = poll === undefined ? DEFAULT_POLL_INTERVAL_MS : poll;
    if (interval !== null && interval !== 0) {
      this.timer?.cancelAndSet(() => { void this.tick(); }, interval);
    }
    this.bindSigusr1();
  }

  async stop(): Promise<void> {
    this.unbindSigusr1();
    this.timer?.cancel();
    this.inFlight.clear();
    this.lastSeenAt.clear();
    this.seededFromStore.clear();
    this.parsedCache.clear();
    this.started = false;
  }

  async tick(): Promise<void> {
    await this.config().ready;
    if (this.getCronConfig().disabled) return;
    if (this.tasks.size === 0) return;

    const loop = this.runtime.get(IAgentLoopService);
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

  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (tasks: readonly CronTask[]) => readonly ContentPart[],
  ): Turn | undefined {
    if (tasks.length === 0) return undefined;

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
    void this.runtime.get(IAgentPromptService).inject(message).catch(() => {});
    this.telemetry().track2(CRON_MISSED, { count: tasks.length });
    return undefined;
  }

  emitScheduled(task: CronTask, agentId?: string): void {
    const properties: CronScheduledEvent = {
      recurring: task.recurring !== false,
      agent_id: agentId,
    };
    this.telemetry().track2(CRON_SCHEDULED, properties);
  }

  emitDeleted(taskId: string, agentId?: string): void {
    const properties: CronDeletedEvent = { task_id: taskId, agent_id: agentId };
    this.telemetry().track2(CRON_DELETED, properties);
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
    const promptService = this.runtime.get(IAgentPromptService);

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
    const buffered = this.runtime.get(IAgentLoopService).status().state === 'running';

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
        void this.runtime.dispatch(new CronFired({ origin, prompt: task.prompt }));
        this.telemetry().track2(CRON_FIRED, {
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
    if (!this.tasks.has(id)) return;
    void this.runtime.dispatch(new CronCursor({ id, lastFiredAt }));
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

  private generateUniqueId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const candidate = ulid();
      if (!CRON_ID_REGEX.test(candidate)) continue;
      if (!this.tasks.has(candidate)) return candidate;
    }
    throw new BugIndicatingError(
      `SessionCronService: failed to generate a unique ULID after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }

  private isStaleAt(task: CronTask, now: number): boolean {
    if (this.getCronConfig().noStale) return false;
    if (task.recurring === false) return false;
    const age = now - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
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

const cronSchedulerLogic = fromCallback<EventObject, CronActivation>(({ input }) =>
  input.scheduler.attach(),
);

const cronActorLogic = setup({
  types: {} as {
    context: CronActorContext;
    events: CronActorEvent;
  },
  actors: {
    scheduler: cronSchedulerLogic,
  },
}).createMachine({
  context: { tasks: new Map() },
  initial: 'inactive',
  on: {
    'cron.commit': {
      actions: assign({ tasks: ({ event }) => event.tasks }),
    },
  },
  states: {
    inactive: {
      on: {
        'cron.activate': {
          target: 'active',
          actions: assign({ activation: ({ event }) => event.activation }),
        },
      },
    },
    active: {
      invoke: {
        src: 'scheduler',
        input: ({ context }) => context.activation!,
      },
    },
  },
});

const schedulers = new WeakMap<AnyActorRef, CronScheduler>();

export const CronAgentRuntimeDefinition = defineAgentRuntime<CronModelState, IAgentCron>({
  id: 'cron',
  logic: cronActorLogic,
  eager: true,
  durable: {
    events: [CronAdd, CronDelete, CronCursor],
    undoable: false,
    transition: (state, event) => {
      if (event instanceof CronAdd) {
        state.set(event.task.id, event.task);
        return;
      }
      if (event instanceof CronDelete) {
        for (const id of event.ids) state.delete(id);
        return;
      }
      if (event instanceof CronCursor) {
        const task = state.get(event.id);
        if (task === undefined) return;
        state.set(event.id, { ...task, lastFiredAt: event.lastFiredAt });
      }
    },
    read: (snapshot) => (snapshot as CronActorSnapshot).context.tasks,
    commit: (actor, tasks) => { actor.send({ type: 'cron.commit', tasks }); },
  },
  createFacade: (actor, context) => {
    const scheduler = new CronScheduler(context);
    schedulers.set(actor, scheduler);
    return {
      _serviceBrand: undefined,
      isEnabled: true,
      isDisabled: () => scheduler.isDisabled(),
      addTask: (init) => scheduler.addTask(init),
      removeTasks: (ids) => scheduler.removeTasks(ids),
      getTask: (id) => scheduler.getTask(id),
      list: () => scheduler.list(),
      now: () => scheduler.now(),
      isStale: (task) => scheduler.isStale(task),
      getNextFireTime: () => scheduler.getNextFireTime(),
      getNextFireForTask: (taskId) => scheduler.getNextFireForTask(taskId),
      computeDisplayNextFire: (task, parsed, idealMs) =>
        scheduler.computeDisplayNextFire(task, parsed, idealMs),
      start: () => scheduler.start(),
      stop: () => scheduler.stop(),
      tick: () => scheduler.tick(),
      handleMissed: (tasks, renderMissedNotification) =>
        scheduler.handleMissed(tasks, renderMissedNotification),
      emitScheduled: (task, agentId) => scheduler.emitScheduled(task, agentId),
      emitDeleted: (taskId, agentId) => scheduler.emitDeleted(taskId, agentId),
    };
  },
  activate: (actor, context) => {
    actor.send({
      type: 'cron.activate',
      activation: { runtime: context, scheduler: schedulers.get(actor)! },
    });
  },
  inspect: (snapshot) =>
    [...(snapshot as CronActorSnapshot).context.tasks.values()].map((task) => ({
      id: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      createdAt: task.createdAt,
      lastFiredAt: task.lastFiredAt,
    })),
});

export class AgentCronBinding implements IAgentCron {
  declare readonly _serviceBrand: undefined;

  private readonly cron: IAgentCron;

  constructor(
    @IAgentManager manager: IAgentManager,
    @IAgentScopeContext scope: IAgentScopeContext,
  ) {
    this.cron = manager.resolve(scope.agentContext, AgentCron);
  }

  get isEnabled() {
    return this.cron.isEnabled;
  }

  isDisabled(): boolean {
    return this.cron.isDisabled();
  }

  addTask(init: CronTaskInit): CronTask {
    return this.cron.addTask(init);
  }

  removeTasks(ids: readonly string[]): readonly string[] {
    return this.cron.removeTasks(ids);
  }

  getTask(id: string): CronTask | undefined {
    return this.cron.getTask(id);
  }

  list(): readonly CronTask[] {
    return this.cron.list();
  }

  now(): number {
    return this.cron.now();
  }

  isStale(task: CronTask): boolean {
    return this.cron.isStale(task);
  }

  getNextFireTime(): number | null {
    return this.cron.getNextFireTime();
  }

  getNextFireForTask(taskId: string): number | null {
    return this.cron.getNextFireForTask(taskId);
  }

  computeDisplayNextFire(
    task: CronTask,
    parsed: ParsedCronExpression,
    idealMs: number,
  ): number | null {
    return this.cron.computeDisplayNextFire(task, parsed, idealMs);
  }

  start(): Promise<void> {
    return this.cron.start();
  }

  stop(): Promise<void> {
    return this.cron.stop();
  }

  tick(): Promise<void> {
    return this.cron.tick();
  }

  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (tasks: readonly CronTask[]) => readonly ContentPart[],
  ): Turn | undefined {
    return this.cron.handleMissed(tasks, renderMissedNotification);
  }

  emitScheduled(task: CronTask, agentId?: string): void {
    this.cron.emitScheduled(task, agentId);
  }

  emitDeleted(taskId: string, agentId?: string): void {
    this.cron.emitDeleted(taskId, agentId);
  }
}
