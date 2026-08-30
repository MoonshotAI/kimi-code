import { ulid } from 'ulid';
import { assign, fromCallback, sendTo, setup, type Snapshot } from 'xstate';

import { IntervalTimer } from '#/_base/utils/timer';
import type { CronJobOrigin, CronMissedOrigin, ContextMessage } from '#/actor/contextMemory/types';
import { AgentLoop } from '#/actor/loop/loop';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { Turn } from '#/actor/loop/internal/loop';
import { AgentPrompt } from '#/actor/prompt/promptAgentRuntime';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import { IConfigService } from '#/app/config/config';
import { type ClockSources, resolveClockSources, SYSTEM_CLOCKS } from '#/actor/cron/internal/clock';
import { type CronConfig, CRON_SECTION, DEFAULT_CRON_CONFIG } from '#/actor/cron/configSection';
import { computeNextCronRun, parseCronExpression, type ParsedCronExpression } from '#/actor/cron/internal/cron-expr';
import type { CronTask, CronTaskInit } from '#/actor/cron/cronTask';
import { renderCronFireXml } from '#/actor/cron/internal/format';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from '#/actor/cron/internal/jitter';
import type { CronDeletedEvent, CronScheduledEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentHostService } from '#/agent/host/agentHost';
import { BugIndicatingError } from '#/errors';
import type { ContentPart } from '#/kosong/contract/message';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

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

interface CronActorContext {
  readonly tasks: CronModelState;
  readonly runtime: AgentRuntimeContext<CronModelState>;
  readonly clocks: ClockSources;
  readonly parsed: ReadonlyMap<string, ParsedCronExpression>;
  readonly lastSeenAt: ReadonlyMap<string, number>;
  readonly seeded: ReadonlySet<string>;
  readonly inFlight: ReadonlySet<string>;
}

interface CronCommitEvent {
  readonly type: 'cron.commit';
  readonly tasks: CronModelState;
}

interface CronTickEvent {
  readonly type: 'cron.tick';
  readonly resolve?: () => void;
  readonly reject?: (error: unknown) => void;
}

interface CronClocksResolvedEvent {
  readonly type: 'cron.clocksResolved';
  readonly clocks: ClockSources;
}

interface CronExpressionParsedEvent {
  readonly type: 'cron.expressionParsed';
  readonly expression: string;
  readonly parsed: ParsedCronExpression;
}

interface CronTaskSeededEvent {
  readonly type: 'cron.taskSeeded';
  readonly id: string;
  readonly cursor?: number;
}

interface CronFireStartedEvent {
  readonly type: 'cron.fireStarted';
  readonly id: string;
}

interface CronFireSettledEvent {
  readonly type: 'cron.fireSettled';
  readonly id: string;
}

interface CronCursorAdvancedEvent {
  readonly type: 'cron.cursorAdvanced';
  readonly id: string;
  readonly at: number;
}

interface CronTaskForgottenEvent {
  readonly type: 'cron.taskForgotten';
  readonly id: string;
}

type CronActorEvent =
  | CronCommitEvent
  | AgentRuntimeRestoreEvent
  | CronTickEvent
  | CronClocksResolvedEvent
  | CronExpressionParsedEvent
  | CronTaskSeededEvent
  | CronFireStartedEvent
  | CronFireSettledEvent
  | CronCursorAdvancedEvent
  | CronTaskForgottenEvent;
type CronActorSnapshot = Snapshot<unknown> & { readonly context: CronActorContext };

function mapWith<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function mapWithout<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function setWith<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (set.has(value)) return set;
  const next = new Set(set);
  next.add(value);
  return next;
}

function setWithout<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

function actorContextOf(runtime: AgentRuntimeContext<CronModelState>): CronActorContext {
  return runtime.getLogicState<CronActorContext>();
}

function configOf(runtime: AgentRuntimeContext<CronModelState>): IConfigService {
  return runtime.get(IConfigService);
}

function cronConfigOf(runtime: AgentRuntimeContext<CronModelState>): CronConfig {
  return configOf(runtime).get<CronConfig>(CRON_SECTION) ?? DEFAULT_CRON_CONFIG;
}

function clocksOf(runtime: AgentRuntimeContext<CronModelState>): ClockSources {
  const config = cronConfigOf(runtime);
  return resolveClockSources(config.clock, config.debug) ?? SYSTEM_CLOCKS;
}

function telemetryOf(runtime: AgentRuntimeContext<CronModelState>): ITelemetryService {
  return runtime.get(IAgentHostService).of(runtime.agent).telemetry;
}

function debugLog(runtime: AgentRuntimeContext<CronModelState>, message: string): void {
  if (cronConfigOf(runtime).debug) process.stderr.write(`[cron/session] ${message}\n`);
}

function isStaleAt(
  runtime: AgentRuntimeContext<CronModelState>,
  task: CronTask,
  now: number,
): boolean {
  if (cronConfigOf(runtime).noStale) return false;
  if (task.recurring === false) return false;
  const age = now - task.createdAt;
  return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
}

function computeJitteredNext(
  runtime: AgentRuntimeContext<CronModelState>,
  task: CronTask,
  parsed: ParsedCronExpression,
  baseMs: number,
): number | null {
  const ideal = computeNextCronRun(parsed, baseMs);
  if (ideal === null) return null;
  const noJitter = cronConfigOf(runtime).noJitter;
  if (task.recurring === false) {
    return oneShotJitteredNextCronRunMs(task, ideal, undefined, noJitter);
  }
  return jitteredNextCronRunMs(task, parsed, ideal, undefined, noJitter);
}

function parsedCron(
  runtime: AgentRuntimeContext<CronModelState>,
  expression: string,
): ParsedCronExpression {
  const cached = actorContextOf(runtime).parsed.get(expression);
  if (cached !== undefined) return cached;
  const parsed = parseCronExpression(expression);
  runtime.send({ type: 'cron.expressionParsed', expression, parsed });
  return parsed;
}

function countCoalesced(
  runtime: AgentRuntimeContext<CronModelState>,
  task: CronTask,
  parsed: ParsedCronExpression,
  firstFireMs: number,
  nowMs: number,
): { count: number; lastDueMs: number } {
  let count = 1;
  let cursor = firstFireMs;
  let lastDueMs = firstFireMs;
  const noJitter = cronConfigOf(runtime).noJitter;
  while (count < MAX_COALESCE_ITERATIONS) {
    const next = computeNextCronRun(parsed, cursor);
    if (next === null || next > nowMs) break;
    const jitteredNext = task.recurring === false
      ? oneShotJitteredNextCronRunMs(task, next, undefined, noJitter)
      : jitteredNextCronRunMs(task, parsed, next, undefined, noJitter);
    if (jitteredNext > nowMs) break;
    count += 1;
    cursor = next;
    lastDueMs = next;
  }
  return { count, lastDueMs };
}

function removeTasks(
  runtime: AgentRuntimeContext<CronModelState>,
  ids: readonly string[],
): readonly string[] {
  const removed = ids.filter((id) => runtime.getState().has(id));
  if (removed.length > 0) void runtime.dispatch(new CronDelete({ ids: removed }));
  return removed;
}

function deliverFire(
  runtime: AgentRuntimeContext<CronModelState>,
  task: CronTask,
  context: { readonly coalescedCount: number; readonly firedAt: number },
): Promise<boolean> {
  const origin: CronJobOrigin = {
    kind: 'cron_job',
    jobId: task.id,
    cron: task.cron,
    recurring: task.recurring !== false,
    coalescedCount: context.coalescedCount,
    stale: isStaleAt(runtime, task, context.firedAt),
  };
  const message: ContextMessage = {
    role: 'user',
    content: [{ type: 'text', text: renderCronFireXml(origin, task.prompt) }],
    toolCalls: [],
    origin,
  };
  const buffered = runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentLoop).status() === 'running';
  let launched: Promise<unknown>;
  try {
    launched = runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentPrompt).inject(message);
  } catch (error) {
    debugLog(runtime, `steer threw for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    return Promise.resolve(false);
  }
  return launched.then(
    () => {
      void runtime.dispatch(new CronFired({ origin, prompt: task.prompt }));
      telemetryOf(runtime).track2(CRON_FIRED, {
        recurring: task.recurring !== false,
        coalesced_count: context.coalescedCount,
        stale: origin.stale,
        buffered,
      });
      return true;
    },
    (error: unknown) => {
      debugLog(runtime, `steer launch rejected for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    },
  );
}

async function processDue(
  runtime: AgentRuntimeContext<CronModelState>,
  task: CronTask,
  now: number,
): Promise<void> {
  if (actorContextOf(runtime).inFlight.has(task.id)) return;
  let parsed: ParsedCronExpression;
  try {
    parsed = parsedCron(runtime, task.cron);
  } catch (error) {
    debugLog(runtime, `tick failed to parse cron for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!actorContextOf(runtime).seeded.has(task.id)) {
    const cursor =
      task.lastFiredAt !== undefined &&
      Number.isFinite(task.lastFiredAt) &&
      task.lastFiredAt <= now
        ? task.lastFiredAt
        : undefined;
    runtime.send({ type: 'cron.taskSeeded', id: task.id, cursor });
  }
  const seen = actorContextOf(runtime).lastSeenAt.get(task.id);
  const baseFromMs = seen !== undefined && seen > task.createdAt ? seen : task.createdAt;
  const nextFireAt = computeJitteredNext(runtime, task, parsed, baseFromMs);
  if (nextFireAt === null || now < nextFireAt) return;
  const ideal = computeNextCronRun(parsed, baseFromMs);
  let coalescedCount = 1;
  let lastDueMs: number | null = null;
  if (task.recurring !== false && ideal !== null) {
    const result = countCoalesced(runtime, task, parsed, ideal, now);
    coalescedCount = Math.max(1, result.count);
    lastDueMs = result.lastDueMs;
  }
  runtime.send({ type: 'cron.fireStarted', id: task.id });
  const firedAt = actorContextOf(runtime).clocks.wallNow();
  let delivered = false;
  try {
    delivered = await deliverFire(runtime, task, { coalescedCount, firedAt });
  } catch (error) {
    debugLog(runtime, `deliverDue threw for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    runtime.send({ type: 'cron.fireSettled', id: task.id });
  }
  if (!delivered) return;
  if (task.recurring === false || isStaleAt(runtime, task, firedAt)) {
    const removed = removeTasks(runtime, [task.id]);
    runtime.send({ type: 'cron.taskForgotten', id: task.id });
    if (task.recurring !== false && removed.length > 0) {
      const properties: CronDeletedEvent = { task_id: task.id, agent_id: undefined };
      telemetryOf(runtime).track2(CRON_DELETED, properties);
    }
    return;
  }
  const advancedTo = lastDueMs ?? now;
  runtime.send({ type: 'cron.cursorAdvanced', id: task.id, at: advancedTo });
  if (runtime.getState().has(task.id)) {
    void runtime.dispatch(new CronCursor({ id: task.id, lastFiredAt: advancedTo }));
  }
}

async function tickCron(runtime: AgentRuntimeContext<CronModelState>): Promise<void> {
  await configOf(runtime).ready;
  if (cronConfigOf(runtime).disabled || runtime.getState().size === 0) return;
  if (runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentLoop).status() === 'running') return;
  const now = actorContextOf(runtime).clocks.wallNow();
  await Promise.all([...runtime.getState().values()].map((task) => processDue(runtime, task, now)));
}

const cronEffects = fromCallback(({
  input,
  receive,
  sendBack,
}: {
  input: {
    readonly runtime: AgentRuntimeContext<CronModelState>;
    readonly restore: AgentRuntimeRestoreEvent;
  };
  receive: (listener: (event: CronTickEvent) => void) => void;
  sendBack: (event: CronActorEvent) => void;
}) => {
  if (input.runtime.agent.agentId !== MAIN_AGENT_ID) return;
  const timer = new IntervalTimer({ unref: true });
  let disposed = false;
  let signalHandler: NodeJS.SignalsListener | undefined;
  receive((event) => {
    void tickCron(input.runtime).then(event.resolve, event.reject);
  });
  input.restore.waitUntil(configOf(input.runtime).ready.then(() => {
    if (disposed) return;
    const config = cronConfigOf(input.runtime);
    sendBack({
      type: 'cron.clocksResolved',
      clocks: resolveClockSources(config.clock, config.debug) ?? SYSTEM_CLOCKS,
    });
    const poll = config.manualTick ? null : config.pollIntervalMs;
    const interval = poll === undefined ? DEFAULT_POLL_INTERVAL_MS : poll;
    if (interval !== null && interval !== 0) {
      timer.cancelAndSet(() => { sendBack({ type: 'cron.tick' }); }, interval);
    }
    if (process.platform !== 'win32' && config.manualTick) {
      signalHandler = () => { sendBack({ type: 'cron.tick' }); };
      process.on('SIGUSR1', signalHandler);
    }
  }));
  return () => {
    disposed = true;
    timer.dispose();
    if (signalHandler !== undefined) process.off('SIGUSR1', signalHandler);
  };
});

function nextFireFor(
  runtime: AgentRuntimeContext<CronModelState>,
  task: CronTask,
): number | null {
  try {
    const clocks = clocksOf(runtime);
    const parsed = parseCronExpression(task.cron);
    const persistedCursor =
      task.lastFiredAt !== undefined &&
      Number.isFinite(task.lastFiredAt) &&
      task.lastFiredAt <= clocks.wallNow()
        ? task.lastFiredAt
        : undefined;
    const baseFromMs =
      persistedCursor !== undefined && persistedCursor > task.createdAt
        ? persistedCursor
        : task.createdAt;
    return computeJitteredNext(runtime, task, parsed, baseFromMs);
  } catch (error) {
    debugLog(runtime, `nextFireFor skipping task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export class CronRuntime {
  readonly isEnabled = true;

  constructor(private readonly runtime: AgentRuntimeContext<CronModelState>) {}

  now(): number {
    return clocksOf(this.runtime).wallNow();
  }

  isDisabled(): boolean {
    return cronConfigOf(this.runtime).disabled;
  }

  addTask(init: CronTaskInit): CronTask {
    const tasks = this.runtime.getState();
    let id: string | undefined;
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const candidate = ulid();
      if (CRON_ID_REGEX.test(candidate) && !tasks.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (id === undefined) {
      throw new BugIndicatingError(`SessionCronService: failed to generate a unique ULID after ${MAX_ID_ATTEMPTS} attempts`);
    }
    const task: CronTask = { ...init, id, createdAt: this.now() };
    void this.runtime.dispatch(new CronAdd({ task }));
    return task;
  }

  removeTasks(ids: readonly string[]): readonly string[] {
    return removeTasks(this.runtime, ids);
  }

  getTask(id: string): CronTask | undefined {
    return this.runtime.getState().get(id);
  }

  list(): readonly CronTask[] {
    return [...this.runtime.getState().values()];
  }

  isStale(task: CronTask): boolean {
    return isStaleAt(this.runtime, task, this.now());
  }

  getNextFireTime(): number | null {
    let min: number | null = null;
    for (const task of this.runtime.getState().values()) {
      const next = nextFireFor(this.runtime, task);
      if (next !== null && (min === null || next < min)) min = next;
    }
    return min;
  }

  getNextFireForTask(taskId: string): number | null {
    const task = this.runtime.getState().get(taskId);
    return task === undefined ? null : nextFireFor(this.runtime, task);
  }

  computeDisplayNextFire(
    task: CronTask,
    parsed: ParsedCronExpression,
    idealMs: number,
  ): number | null {
    const noJitter = cronConfigOf(this.runtime).noJitter;
    if (task.recurring === false) {
      return oneShotJitteredNextCronRunMs(task, idealMs, undefined, noJitter);
    }
    return jitteredNextCronRunMs(task, parsed, idealMs, undefined, noJitter);
  }

  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (tasks: readonly CronTask[]) => readonly ContentPart[],
  ): Turn | undefined {
    if (tasks.length === 0) return undefined;
    const origin: CronMissedOrigin = { kind: 'cron_missed', count: tasks.length };
    const message: ContextMessage = {
      role: 'user',
      content: [...renderMissedNotification(tasks)],
      toolCalls: [],
      origin,
    };
    void this.runtime.get(IAgentLifecycleService).resolve(this.runtime.agent, AgentPrompt).inject(message).catch(() => {});
    telemetryOf(this.runtime).track2(CRON_MISSED, { count: tasks.length });
    return undefined;
  }

  emitScheduled(task: CronTask, agentId?: string): void {
    const properties: CronScheduledEvent = { recurring: task.recurring !== false, agent_id: agentId };
    telemetryOf(this.runtime).track2(CRON_SCHEDULED, properties);
  }

  emitDeleted(taskId: string, agentId?: string): void {
    const properties: CronDeletedEvent = { task_id: taskId, agent_id: agentId };
    telemetryOf(this.runtime).track2(CRON_DELETED, properties);
  }

  tick(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.runtime.send({ type: 'cron.tick', resolve, reject });
    });
  }
}

const cronActorLogic = setup({
  types: {} as {
    context: CronActorContext;
    input: AgentRuntimeContext<CronModelState>;
    events: CronActorEvent;
  },
  actors: { cronEffects },
}).createMachine({
  context: ({ input }) => ({
    tasks: new Map(),
    runtime: input,
    clocks: SYSTEM_CLOCKS,
    parsed: new Map(),
    lastSeenAt: new Map(),
    seeded: new Set(),
    inFlight: new Set(),
  }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: {
        'runtime.restore': 'active',
        'cron.tick': {
          actions: ({ event }) => { event.reject?.(new Error('Cron runtime is not restored')); },
        },
      },
    },
    active: {
      invoke: {
        id: 'cronEffects',
        src: 'cronEffects',
        input: ({ context, event }) => ({
          runtime: context.runtime,
          restore: event as AgentRuntimeRestoreEvent,
        }),
      },
      on: {
        'cron.tick': { actions: sendTo('cronEffects', ({ event }) => event) },
      },
    },
  },
  on: {
    'cron.commit': {
      actions: assign({ tasks: ({ event }) => event.tasks }),
    },
    'cron.clocksResolved': {
      actions: assign({ clocks: ({ event }) => event.clocks }),
    },
    'cron.expressionParsed': {
      actions: assign({
        parsed: ({ context, event }) => mapWith(context.parsed, event.expression, event.parsed),
      }),
    },
    'cron.taskSeeded': {
      actions: assign(({ context, event }) => ({
        seeded: setWith(context.seeded, event.id),
        lastSeenAt:
          event.cursor !== undefined && !context.lastSeenAt.has(event.id)
            ? mapWith(context.lastSeenAt, event.id, event.cursor)
            : context.lastSeenAt,
      })),
    },
    'cron.fireStarted': {
      actions: assign({ inFlight: ({ context, event }) => setWith(context.inFlight, event.id) }),
    },
    'cron.fireSettled': {
      actions: assign({ inFlight: ({ context, event }) => setWithout(context.inFlight, event.id) }),
    },
    'cron.cursorAdvanced': {
      actions: assign({
        lastSeenAt: ({ context, event }) => mapWith(context.lastSeenAt, event.id, event.at),
      }),
    },
    'cron.taskForgotten': {
      actions: assign(({ context, event }) => ({
        lastSeenAt: mapWithout(context.lastSeenAt, event.id),
        seeded: setWithout(context.seeded, event.id),
      })),
    },
  },
});

export const AgentCron = defineAgentRuntimeContract<CronRuntime>('cron');

export const cronAgentRuntimeProvider = defineAgentRuntimeProvider<CronModelState, CronRuntime>(AgentCron, {
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
        if (task !== undefined) state.set(event.id, { ...task, lastFiredAt: event.lastFiredAt });
      }
    },
    read: (snapshot) => (snapshot as CronActorSnapshot).context.tasks,
    commit: (actor, tasks) => { actor.send({ type: 'cron.commit', tasks }); },
  },
  createApi: (context) => new CronRuntime(context),
  inspect: (snapshot) =>
    [...(snapshot as CronActorSnapshot).context.tasks.values()].map((task) => ({
      id: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      createdAt: task.createdAt,
      lastFiredAt: task.lastFiredAt,
    })),
});
