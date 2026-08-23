import { ulid } from 'ulid';
import { assign, fromCallback, sendTo, setup, type Snapshot } from 'xstate';

import { IntervalTimer } from '#/_base/utils/timer';
import type { CronJobOrigin, CronMissedOrigin, ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { IConfigService } from '#/app/config/config';
import { type ClockSources, resolveClockSources, SYSTEM_CLOCKS } from '#/app/cron/clock';
import { type CronConfig, CRON_SECTION, DEFAULT_CRON_CONFIG } from '#/app/cron/configSection';
import { computeNextCronRun, parseCronExpression, type ParsedCronExpression } from '#/app/cron/cron-expr';
import type { CronTask, CronTaskInit } from '#/app/cron/cronTask';
import { renderCronFireXml } from '#/app/cron/format';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from '#/app/cron/jitter';
import type { CronDeletedEvent, CronScheduledEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
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

type CronActorEvent = CronCommitEvent | AgentRuntimeRestoreEvent | CronTickEvent;
type CronActorSnapshot = Snapshot<unknown> & { readonly context: CronActorContext };

interface CronEffectState {
  clocks: ClockSources;
  readonly parsedCache: Map<string, ParsedCronExpression>;
  readonly lastSeenAt: Map<string, number>;
  readonly seededFromStore: Set<string>;
  readonly inFlight: Set<string>;
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
  return runtime.get(ITelemetryService);
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

function parsedCron(state: CronEffectState, expression: string): ParsedCronExpression {
  const cached = state.parsedCache.get(expression);
  if (cached !== undefined) return cached;
  const parsed = parseCronExpression(expression);
  state.parsedCache.set(expression, parsed);
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
  const buffered = runtime.get(IAgentLoopService).status().state === 'running';
  let launched: Promise<unknown>;
  try {
    launched = runtime.get(IAgentPromptService).inject(message);
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
  state: CronEffectState,
  task: CronTask,
  now: number,
): Promise<void> {
  if (state.inFlight.has(task.id)) return;
  let parsed: ParsedCronExpression;
  try {
    parsed = parsedCron(state, task.cron);
  } catch (error) {
    debugLog(runtime, `tick failed to parse cron for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (
    !state.seededFromStore.has(task.id) &&
    task.lastFiredAt !== undefined &&
    Number.isFinite(task.lastFiredAt) &&
    task.lastFiredAt <= now &&
    !state.lastSeenAt.has(task.id)
  ) {
    state.lastSeenAt.set(task.id, task.lastFiredAt);
  }
  state.seededFromStore.add(task.id);
  const seen = state.lastSeenAt.get(task.id);
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
  state.inFlight.add(task.id);
  const firedAt = state.clocks.wallNow();
  let delivered = false;
  try {
    delivered = await deliverFire(runtime, task, { coalescedCount, firedAt });
  } catch (error) {
    debugLog(runtime, `deliverDue threw for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    state.inFlight.delete(task.id);
  }
  if (!delivered) return;
  if (task.recurring === false || isStaleAt(runtime, task, firedAt)) {
    const removed = removeTasks(runtime, [task.id]);
    state.lastSeenAt.delete(task.id);
    state.seededFromStore.delete(task.id);
    if (task.recurring !== false && removed.length > 0) {
      const properties: CronDeletedEvent = { task_id: task.id, agent_id: undefined };
      telemetryOf(runtime).track2(CRON_DELETED, properties);
    }
    return;
  }
  const advancedTo = lastDueMs ?? now;
  state.lastSeenAt.set(task.id, advancedTo);
  if (runtime.getState().has(task.id)) {
    void runtime.dispatch(new CronCursor({ id: task.id, lastFiredAt: advancedTo }));
  }
}

async function tickCron(
  runtime: AgentRuntimeContext<CronModelState>,
  state: CronEffectState,
): Promise<void> {
  await configOf(runtime).ready;
  if (cronConfigOf(runtime).disabled || runtime.getState().size === 0) return;
  if (runtime.get(IAgentLoopService).status().state === 'running') return;
  const now = state.clocks.wallNow();
  await Promise.all([...runtime.getState().values()].map((task) => processDue(runtime, state, task, now)));
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
  const state: CronEffectState = {
    clocks: SYSTEM_CLOCKS,
    parsedCache: new Map(),
    lastSeenAt: new Map(),
    seededFromStore: new Set(),
    inFlight: new Set(),
  };
  let disposed = false;
  let signalHandler: NodeJS.SignalsListener | undefined;
  receive((event) => {
    void tickCron(input.runtime, state).then(event.resolve, event.reject);
  });
  input.restore.waitUntil(configOf(input.runtime).ready.then(() => {
    if (disposed) return;
    const config = cronConfigOf(input.runtime);
    state.clocks = resolveClockSources(config.clock, config.debug) ?? SYSTEM_CLOCKS;
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
    state.inFlight.clear();
    state.lastSeenAt.clear();
    state.seededFromStore.clear();
    state.parsedCache.clear();
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
    void this.runtime.get(IAgentPromptService).inject(message).catch(() => {});
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
  context: ({ input }) => ({ tasks: new Map(), runtime: input }),
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
