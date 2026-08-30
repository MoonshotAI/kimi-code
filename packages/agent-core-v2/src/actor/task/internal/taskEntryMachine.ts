import {
  assign,
  enqueueActions,
  fromCallback,
  sendParent,
  setup,
  type ActorRefFrom,
  type SnapshotFrom,
} from 'xstate';

import { userCancellationReason } from '#/_base/utils/abort';
import { setClampedTimeout } from '#/_base/utils/timer';
import type { IConfigService } from '#/app/config/config';

import {
  TERMINAL_STATUSES,
  type AgentTaskInfo,
  type AgentTaskInfoBase,
  type AgentTaskOutputSnapshot,
  type AgentTaskSettlement,
  type AgentTaskSettlementStatus,
  type AgentTaskSink,
  type AgentTaskStatus,
  type ForegroundTaskReleaseReason,
  type TaskExecution,
} from '../types';
import { resolveAgentTaskConfig } from '../configSection';
import type { AgentTaskPersistence } from './persist';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINAL_OUTPUT_TAIL_BYTES = 4 * 1024;
const MAX_TASK_OUTPUT_BYTES = 16 * 1024 * 1024;
const SIGTERM_GRACE_MS = 5_000;

export const SESSION_CLOSED_REASON = 'Session closed';

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function outputLimitReason(): string {
  const mib = Math.floor(MAX_TASK_OUTPUT_BYTES / (1024 * 1024));
  return (
    `Output limit exceeded: the command produced more than ${mib} MiB and was ` +
    'terminated. Redirect large output to a file (e.g. `command > out.txt`) and ' +
    'inspect it in slices instead.'
  );
}

export interface TaskOutputBuffer {
  readonly chunks: string[];
  sizeBytes: number;
  retainedBytes: number;
  limitTripped: boolean;
  pending: string[];
  pendingBytes: number;
  persistStarted: boolean;
  writeQueue: Promise<void>;
}

export interface TaskEntrySlot {
  settled: boolean;
  executionPromise: Promise<void>;
}

export interface TaskEntryInput {
  readonly persistence: AgentTaskPersistence;
  readonly config: IConfigService;
  readonly taskId: string;
  readonly execution: TaskExecution;
  readonly detached: boolean;
  readonly timeoutMs?: number;
  readonly detachTimeoutMs?: number;
  readonly autoBackgroundOnTimeout?: boolean;
  readonly signal?: AbortSignal;
  readonly startedAt: number;
  readonly initialTimerDelayMs?: number;
  readonly persistStarted: boolean;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
}

export interface PendingStop {
  readonly finalStatus: 'killed' | 'timed_out';
  readonly stopReason?: string;
}

export interface TaskEntryContext {
  readonly persistence: AgentTaskPersistence;
  readonly config: IConfigService;
  readonly taskId: string;
  readonly execution: TaskExecution;
  readonly startedDetached: boolean;
  readonly startedAt: number;
  readonly detachTimeoutMs?: number;
  readonly autoBackgroundOnTimeout: boolean;
  readonly signal?: AbortSignal;
  readonly initialTimerDelayMs?: number;
  readonly abortController: AbortController;
  readonly slot: TaskEntrySlot;
  readonly output: TaskOutputBuffer;
  detached: boolean;
  timeoutMs?: number;
  endedAt: number | null;
  stopReason?: string;
  pendingStop?: PendingStop;
  timedOut: boolean;
  terminalNotificationSuppressed?: boolean;
  releaseReason?: ForegroundTaskReleaseReason;
}

export interface EntryOutputEvent {
  readonly type: 'entry.output';
  readonly chunk: string;
}

export interface EntrySettleEvent {
  readonly type: 'entry.settle';
  readonly settlement: AgentTaskSettlement;
  readonly reply?: { accepted: boolean };
}

export interface EntryExecutionFailedEvent {
  readonly type: 'entry.executionFailed';
  readonly message: string;
  readonly aborted: boolean;
}

export interface EntryStopEvent {
  readonly type: 'entry.stop';
  readonly stopReason?: string;
  readonly abortReason: unknown;
  readonly finalStatus: 'killed' | 'timed_out';
}

export interface EntryDetachEvent {
  readonly type: 'entry.detach';
}

export interface EntryTimedOutEvent {
  readonly type: 'entry.timedOut';
}

export interface EntryPersistOutputEvent {
  readonly type: 'entry.persistOutput';
}

export interface EntrySuppressNotificationEvent {
  readonly type: 'entry.suppressNotification';
}

export type TaskEntryEvent =
  | EntryOutputEvent
  | EntrySettleEvent
  | EntryExecutionFailedEvent
  | EntryStopEvent
  | EntryDetachEvent
  | EntryTimedOutEvent
  | EntryPersistOutputEvent
  | EntrySuppressNotificationEvent;

export interface TaskChildDetachedEvent {
  readonly type: 'task.child.detached';
  readonly info: AgentTaskInfo;
}

export interface TaskChildSettledEvent {
  readonly type: 'task.child.settled';
  readonly info: AgentTaskInfo;
  readonly outputTail?: string;
}

export type TaskEntryParentEvent = TaskChildDetachedEvent | TaskChildSettledEvent;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function effectiveSettlementStatus(
  context: TaskEntryContext,
  settlement: AgentTaskSettlement,
): AgentTaskSettlementStatus {
  if (context.timedOut && settlement.status === 'killed') return 'timed_out';
  return settlement.status;
}

function createOutputBuffer(persistStarted: boolean): TaskOutputBuffer {
  return {
    chunks: [],
    sizeBytes: 0,
    retainedBytes: 0,
    limitTripped: false,
    pending: [],
    pendingBytes: 0,
    persistStarted,
    writeQueue: Promise.resolve(),
  };
}

function appendRetainedOutput(buffer: TaskOutputBuffer, chunk: string, chunkBytes: number): void {
  if (chunkBytes >= MAX_OUTPUT_BYTES) {
    const retained = Buffer.from(chunk, 'utf-8')
      .subarray(chunkBytes - MAX_OUTPUT_BYTES)
      .toString('utf-8');
    buffer.chunks.length = 0;
    buffer.chunks.push(retained);
    buffer.retainedBytes = Buffer.byteLength(retained, 'utf-8');
    return;
  }

  buffer.chunks.push(chunk);
  buffer.retainedBytes += chunkBytes;
  while (buffer.retainedBytes > MAX_OUTPUT_BYTES) {
    const removed = buffer.chunks.shift();
    if (removed === undefined) break;
    buffer.retainedBytes -= Buffer.byteLength(removed, 'utf-8');
  }
}

function appendPersistedOutput(context: TaskEntryContext, chunk: string): void {
  const { output, persistence, taskId } = context;
  output.writeQueue = output.writeQueue
    .then(() => persistence.appendTaskOutput(taskId, chunk))
    .catch(() => {});
}

export function startOutputPersist(context: TaskEntryContext): void {
  const output = context.output;
  if (output.persistStarted) return;
  output.persistStarted = true;
  if (output.pending.length > 0) {
    appendPersistedOutput(context, output.pending.join(''));
  }
  output.pending = [];
  output.pendingBytes = 0;
}

function appendEntryOutput(context: TaskEntryContext, chunk: string): boolean {
  const output = context.output;
  const chunkBytes = Buffer.byteLength(chunk, 'utf-8');
  output.sizeBytes += chunkBytes;
  appendRetainedOutput(output, chunk, chunkBytes);

  let trippedNow = false;
  if (
    !output.limitTripped &&
    context.execution.kind === 'process' &&
    output.sizeBytes > MAX_TASK_OUTPUT_BYTES
  ) {
    output.limitTripped = true;
    trippedNow = true;
  }

  if (output.limitTripped) return trippedNow;

  if (!output.persistStarted) {
    output.pending.push(chunk);
    output.pendingBytes += chunkBytes;
    if (output.pendingBytes > MAX_OUTPUT_BYTES) {
      startOutputPersist(context);
    }
    return trippedNow;
  }
  appendPersistedOutput(context, chunk);
  return trippedNow;
}

export function retainedOutputTail(buffer: TaskOutputBuffer): string | undefined {
  if (buffer.chunks.length === 0) return undefined;
  const retained = Buffer.from(buffer.chunks.join(''), 'utf-8');
  const offset = Math.max(0, retained.byteLength - TERMINAL_OUTPUT_TAIL_BYTES);
  return retained.subarray(offset).toString('utf-8');
}

export function emptyOutputSnapshot(): AgentTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}

export interface EntryExecutionInput {
  readonly execution: TaskExecution;
  readonly abortController: AbortController;
  readonly slot: TaskEntrySlot;
}

const entryExecution = fromCallback(
  ({
    input,
    sendBack,
  }: {
    input: EntryExecutionInput;
    sendBack: (event: TaskEntryEvent) => void;
  }) => {
    const { execution, abortController, slot } = input;
    const sink: AgentTaskSink = {
      signal: abortController.signal,
      appendOutput: (chunk) => {
        sendBack({ type: 'entry.output', chunk });
      },
      settle: (settlement) => {
        const reply = { accepted: false };
        sendBack({ type: 'entry.settle', settlement, reply });
        return Promise.resolve(reply.accepted);
      },
    };
    slot.executionPromise = Promise.resolve()
      .then(() => execution.start(sink))
      .catch((error: unknown) => {
        sendBack({
          type: 'entry.executionFailed',
          message: errorMessage(error),
          aborted: abortController.signal.aborted,
        });
      });
    return () => {
      if (slot.settled) return;
      if (execution.survivesSessionClose?.() === true) {
        try {
          execution.releaseOnSessionClose?.();
        } catch {}
        return;
      }
      abortController.abort(SESSION_CLOSED_REASON);
      const forceStop = execution.forceStop?.bind(execution);
      if (forceStop === undefined) return;
      try {
        void forceStop().catch(() => {});
      } catch {}
    };
  },
);

const entryTimer = fromCallback(
  ({
    input,
    sendBack,
    receive,
  }: {
    input: { readonly initialDelayMs?: number };
    sendBack: (event: TaskEntryEvent) => void;
    receive: (listener: (event: { type: string; delayMs?: number }) => void) => void;
  }) => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const clear = (): void => {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    };
    const arm = (delayMs: number): void => {
      clear();
      handle = setClampedTimeout(() => {
        handle = undefined;
        sendBack({ type: 'entry.timedOut' });
      }, delayMs);
      handle.unref?.();
    };
    if (input.initialDelayMs !== undefined) arm(input.initialDelayMs);
    receive((event) => {
      if (event.type !== 'entry.rearm') return;
      if (event.delayMs === undefined) clear();
      else arm(event.delayMs);
    });
    return clear;
  },
);

const entrySignal = fromCallback(
  ({
    input,
    sendBack,
  }: {
    input: { readonly signal?: AbortSignal };
    sendBack: (event: TaskEntryEvent) => void;
  }) => {
    const signal = input.signal;
    if (signal === undefined) return;
    const abortFromSignal = (): void => {
      const userReason = userCancellationReason();
      sendBack({
        type: 'entry.stop',
        stopReason: userReason.message,
        abortReason: signal.reason,
        finalStatus: 'killed',
      });
    };
    if (signal.aborted) {
      abortFromSignal();
      return;
    }
    signal.addEventListener('abort', abortFromSignal, { once: true });
    return () => {
      signal.removeEventListener('abort', abortFromSignal);
    };
  },
);

export interface EntryGraceInput {
  readonly slot: TaskEntrySlot;
  readonly execution: TaskExecution;
  readonly graceMs: number;
  readonly finalStatus: 'killed' | 'timed_out';
  readonly stopReason?: string;
}

const entryGrace = fromCallback(
  ({
    input,
    sendBack,
  }: {
    input: EntryGraceInput;
    sendBack: (event: TaskEntryEvent) => void;
  }) => {
    let cancelled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const graceful = await Promise.race([
        input.slot.executionPromise.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          graceTimer = setTimeout(() => {
            resolve(false);
          }, input.graceMs);
          graceTimer.unref?.();
        }),
      ]);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (cancelled) return;
      if (!graceful) {
        try {
          await input.execution.forceStop?.();
        } catch {}
      }
      if (cancelled) return;
      sendBack({
        type: 'entry.settle',
        settlement: { status: input.finalStatus, stopReason: input.stopReason },
      });
    })();
    return () => {
      cancelled = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };
  },
);

function entryInfoOfContext(context: TaskEntryContext, status: AgentTaskStatus): AgentTaskInfo {
  const base: AgentTaskInfoBase = {
    taskId: context.taskId,
    description: context.execution.description,
    status,
    detached: context.detached ? true : false,
    startedAt: context.startedAt,
    endedAt: context.endedAt,
    stopReason: context.stopReason,
    terminalNotificationSuppressed: context.terminalNotificationSuppressed,
    timeoutMs: context.timeoutMs,
  };
  return context.execution.toInfo(base);
}

const settleTransitions = [
  { guard: 'settlesCompleted', target: 'completed', actions: 'applySettle' },
  { guard: 'settlesFailed', target: 'failed', actions: 'applySettle' },
  { guard: 'settlesTimedOut', target: 'timedOut', actions: 'applySettle' },
  { target: 'killed', actions: 'applySettle' },
] as const;

export const taskEntryLogic = setup({
  types: {} as {
    context: TaskEntryContext;
    input: TaskEntryInput;
    events: TaskEntryEvent;
  },
  actors: { entryExecution, entryTimer, entrySignal, entryGrace },
  actions: {
    handleOutput: enqueueActions(({ context, event, enqueue }) => {
      const trippedNow = appendEntryOutput(context, (event as EntryOutputEvent).chunk);
      if (trippedNow) {
        enqueue.raise({
          type: 'entry.stop',
          stopReason: outputLimitReason(),
          abortReason: outputLimitReason(),
          finalStatus: 'killed',
        });
      }
    }),
    persistOutputNow: ({ context }) => {
      startOutputPersist(context);
    },
    suppressNotification: assign({ terminalNotificationSuppressed: true }),
    beginStop: enqueueActions(({ context, event, enqueue }) => {
      const e = event as EntryStopEvent;
      enqueue.assign({
        stopReason: e.stopReason,
        timedOut: context.timedOut || e.finalStatus === 'timed_out',
        pendingStop: { finalStatus: e.finalStatus, stopReason: e.stopReason },
      });
      enqueue(() => {
        context.abortController.abort(e.abortReason);
      });
    }),
    beginTimeoutStop: enqueueActions(({ context, enqueue }) => {
      enqueue.assign({
        stopReason: undefined,
        timedOut: true,
        pendingStop: { finalStatus: 'timed_out', stopReason: undefined },
      });
      enqueue(() => {
        context.abortController.abort('Timed out');
      });
    }),
    markTimedOut: assign({ timedOut: true }),
    applyDetach: enqueueActions(({ context, event, enqueue }) => {
      const viaTimeout = event.type === 'entry.timedOut';
      enqueue.assign({
        detached: true,
        releaseReason: context.releaseReason ?? (viaTimeout ? 'timeout_detached' : 'detached'),
        timeoutMs:
          context.detachTimeoutMs !== undefined ? context.detachTimeoutMs : context.timeoutMs,
      });
      if (context.detachTimeoutMs !== undefined) {
        enqueue.sendTo('entryTimer', {
          type: 'entry.rearm',
          delayMs: context.detachTimeoutMs > 0 ? context.detachTimeoutMs : undefined,
        });
      }
      enqueue(() => {
        try {
          context.execution.onDetach?.();
        } catch {}
        startOutputPersist(context);
      });
      enqueue(
        sendParent(({ context: current }) => ({
          type: 'task.child.detached',
          info: entryInfoOfContext(current as TaskEntryContext, 'running'),
        })),
      );
    }),
    raiseFailureSettle: enqueueActions(({ context, event, enqueue }) => {
      const e = event as EntryExecutionFailedEvent;
      const status: AgentTaskSettlementStatus = context.timedOut
        ? 'timed_out'
        : e.aborted
          ? 'killed'
          : 'failed';
      enqueue.raise({
        type: 'entry.settle',
        settlement: { status, stopReason: status === 'failed' ? e.message : undefined },
      });
    }),
    applySettle: enqueueActions(({ context, event, enqueue }) => {
      const e = event as EntrySettleEvent;
      const status = effectiveSettlementStatus(context, e.settlement);
      if (e.reply !== undefined) e.reply.accepted = true;
      context.slot.settled = true;
      if (!context.output.persistStarted) {
        context.output.pending = [];
        context.output.pendingBytes = 0;
      }
      enqueue.assign({
        endedAt: Date.now(),
        stopReason:
          e.settlement.stopReason ?? (status === 'killed' ? context.stopReason : undefined),
        releaseReason: context.releaseReason ?? 'terminal',
      });
      if (context.detached) {
        enqueue(
          sendParent(({ context: current }) => {
            const settled = current as TaskEntryContext;
            return {
              type: 'task.child.settled',
              info: entryInfoOfContext(settled, status),
              outputTail: retainedOutputTail(settled.output),
            };
          }),
        );
      }
    }),
  },
  guards: {
    settlesCompleted: ({ context, event }) =>
      effectiveSettlementStatus(context, (event as EntrySettleEvent).settlement) === 'completed',
    settlesFailed: ({ context, event }) =>
      effectiveSettlementStatus(context, (event as EntrySettleEvent).settlement) === 'failed',
    settlesTimedOut: ({ context, event }) =>
      effectiveSettlementStatus(context, (event as EntrySettleEvent).settlement) === 'timed_out',
    canAutoBackground: ({ context }) => context.autoBackgroundOnTimeout,
    startsDetached: ({ context }) => context.detached,
  },
}).createMachine({
  id: 'taskEntry',
  context: ({ input }) => ({
    persistence: input.persistence,
    config: input.config,
    taskId: input.taskId,
    execution: input.execution,
    startedDetached: input.detached,
    startedAt: input.startedAt,
    detachTimeoutMs: input.detachTimeoutMs,
    autoBackgroundOnTimeout: input.autoBackgroundOnTimeout === true,
    signal: input.signal,
    initialTimerDelayMs: input.initialTimerDelayMs,
    abortController: new AbortController(),
    slot: { settled: false, executionPromise: Promise.resolve() },
    output: createOutputBuffer(input.persistStarted),
    detached: input.detached,
    timeoutMs: input.timeoutMs,
    endedAt: null,
    stopReason: input.stopReason,
    pendingStop: undefined,
    timedOut: false,
    terminalNotificationSuppressed: input.terminalNotificationSuppressed,
    releaseReason: undefined,
  }),
  invoke: {
    src: 'entryExecution',
    input: ({ context }): EntryExecutionInput => ({
      execution: context.execution,
      abortController: context.abortController,
      slot: context.slot,
    }),
  },
  initial: 'running',
  states: {
    running: {
      invoke: {
        id: 'entryTimer',
        src: 'entryTimer',
        input: ({ context }) => ({ initialDelayMs: context.initialTimerDelayMs }),
      },
      initial: 'admitting',
      states: {
        admitting: {
          always: [
            { guard: 'startsDetached', target: 'detached' },
            { target: 'foreground' },
          ],
        },
        foreground: {
          invoke: {
            src: 'entrySignal',
            input: ({ context }) => ({ signal: context.signal }),
          },
          on: {
            'entry.detach': { target: 'detached', actions: 'applyDetach' },
            'entry.timedOut': [
              {
                guard: 'canAutoBackground',
                target: 'detached',
                actions: 'applyDetach',
              },
              { target: '#taskEntry.stopping', actions: 'beginTimeoutStop' },
            ],
          },
        },
        detached: {
          on: {
            'entry.timedOut': { target: '#taskEntry.stopping', actions: 'beginTimeoutStop' },
          },
        },
      },
      on: {
        'entry.stop': { target: 'stopping', actions: 'beginStop' },
        'entry.settle': [...settleTransitions],
        'entry.executionFailed': { actions: 'raiseFailureSettle' },
      },
    },
    stopping: {
      invoke: {
        src: 'entryGrace',
        input: ({ context }): EntryGraceInput => ({
          slot: context.slot,
          execution: context.execution,
          graceMs: resolveAgentTaskConfig(context.config)?.killGracePeriodMs ?? SIGTERM_GRACE_MS,
          finalStatus: context.pendingStop?.finalStatus ?? 'killed',
          stopReason: context.pendingStop?.stopReason,
        }),
      },
      on: {
        'entry.timedOut': { actions: 'markTimedOut' },
        'entry.settle': [...settleTransitions],
        'entry.executionFailed': { actions: 'raiseFailureSettle' },
      },
    },
    completed: {},
    failed: {},
    timedOut: {},
    killed: {},
  },
  on: {
    'entry.output': { actions: 'handleOutput' },
    'entry.persistOutput': { actions: 'persistOutputNow' },
    'entry.suppressNotification': { actions: 'suppressNotification' },
  },
});

export type TaskEntryRef = ActorRefFrom<typeof taskEntryLogic>;
export type TaskEntrySnapshot = SnapshotFrom<typeof taskEntryLogic>;

export function isEntryTerminal(snapshot: TaskEntrySnapshot): boolean {
  return typeof snapshot.value === 'string' && snapshot.value !== 'stopping';
}

export function entryStatusOf(snapshot: TaskEntrySnapshot): AgentTaskStatus {
  const value = snapshot.value;
  if (typeof value !== 'string' || value === 'stopping') return 'running';
  if (value === 'timedOut') return 'timed_out';
  return value as AgentTaskStatus;
}

export function entryInfoOf(snapshot: TaskEntrySnapshot): AgentTaskInfo {
  return entryInfoOfContext(snapshot.context, entryStatusOf(snapshot));
}

function shouldListTask(info: AgentTaskInfo, activeOnly: boolean): boolean {
  if (!TERMINAL_STATUSES.has(info.status)) return true;
  if (activeOnly) return false;
  return info.detached !== false;
}

export function listTaskInfos(
  entries: ReadonlyMap<string, TaskEntryRef>,
  ghosts: ReadonlyMap<string, AgentTaskInfo>,
  activeOnly = true,
  limit?: number,
): readonly AgentTaskInfo[] {
  const result: AgentTaskInfo[] = [];
  for (const ref of entries.values()) {
    const info = entryInfoOf(ref.getSnapshot());
    if (!shouldListTask(info, activeOnly)) continue;
    result.push(info);
    if (limit !== undefined && result.length >= limit) return result;
  }
  if (!activeOnly) {
    for (const ghost of ghosts.values()) {
      if (!shouldListTask(ghost, activeOnly)) continue;
      result.push(ghost);
      if (limit !== undefined && result.length >= limit) return result;
    }
  }
  return result;
}

export async function outputSnapshotOf(
  entries: ReadonlyMap<string, TaskEntryRef>,
  ghosts: ReadonlyMap<string, AgentTaskInfo>,
  persistence: AgentTaskPersistence,
  taskId: string,
  maxPreviewBytes: number,
): Promise<AgentTaskOutputSnapshot> {
  const ref = entries.get(taskId);
  if (ref === undefined && !ghosts.has(taskId)) return emptyOutputSnapshot();

  await ref?.getSnapshot().context.output.writeQueue;

  const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
  const persisted = await persistence.readTaskOutputSnapshot(taskId, previewLimit);
  if (persisted !== undefined) {
    return {
      ...persisted,
      fullOutputAvailable: true,
    };
  }

  if (ref === undefined) return emptyOutputSnapshot();

  const output = ref.getSnapshot().context.output;
  const available = Buffer.from(output.chunks.join(''), 'utf-8');
  const previewBytes = Math.min(previewLimit, available.byteLength, output.sizeBytes);
  const previewOffset = Math.max(0, available.byteLength - previewBytes);
  return {
    outputSizeBytes: output.sizeBytes,
    previewBytes,
    truncated: output.sizeBytes > previewBytes,
    fullOutputAvailable: false,
    preview: available.subarray(previewOffset).toString('utf-8'),
  };
}
