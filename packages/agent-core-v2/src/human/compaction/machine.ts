import { estimateUsedContextTokens } from '#/agent/context-usage';
import {
  inputCancelled,
  inputNotified,
  inputReminded,
  inputSteered,
  inputSubmitted,
} from '#/agent/events';
import { createUserEntry, type HistoryMessage, type SystemEntry, type UserEntry } from '#/agent/turn';
import type { ExternalEvent } from '#/eventStore/events';
import type { UserMessage } from '#/llm/message';
import type { AgentActorRef } from '#/session/machine';
import type { SessionStores } from '#/session/stores';
import { assign, emit, enqueueActions, fromPromise, setup, waitFor } from '#/xstate2';

import { CompactError } from './errors';
import { buildCompactionSeed, compactionContinuationMessage } from './shape';
import type { Summarize, SummaryOutcome } from './summarize';

export type CompactionReason = 'budget' | 'manual' | 'overflow';

export type CompactionPhase =
  | 'idle'
  | 'quiescing'
  | 'summarizing'
  | 'switching'
  | 'resuming'
  | 'completed'
  | 'cancelled';

export type CompactionCancelCause = 'cancelled' | 'user-abort' | 'drift' | 'failed';

export type SummaryTelemetry = Omit<SummaryOutcome, 'text'>;

export interface CompactionStats {
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

export type CompactionEvent =
  | { type: 'compaction.started'; reason: CompactionReason; instruction?: string }
  | { type: 'compaction.blocked'; turnId?: number }
  | {
      type: 'compaction.completed';
      reason: CompactionReason;
      branchId: string;
      stats: CompactionStats;
      durationMs: number;
      originTurnId?: number;
      summary?: SummaryTelemetry;
    }
  | {
      type: 'compaction.cancelled';
      reason: CompactionReason;
      cause: CompactionCancelCause;
      error?: unknown;
      durationMs: number;
      originTurnId?: number;
      tokensBefore?: number;
    };

export interface CompactionMachineDeps {
  agentId: string;
  actor: AgentActorRef;
  stores: SessionStores;
  summarize: Summarize;
  continuation?: (reason: CompactionReason) => UserMessage | undefined;
  todos?: () => string | undefined;
  onWillCompact?: (input: {
    reason: CompactionReason;
    instruction?: string;
    signal: AbortSignal;
    tokenCount: number;
  }) => void | Promise<void>;
}

export interface CompactionMachineInput {
  reason: CompactionReason;
  instruction?: string;
}

export type CompactionMachineOutput =
  | { status: 'completed'; branchId: string; stats: CompactionStats }
  | { status: 'cancelled'; cause: CompactionCancelCause; error: unknown };

type CompactionMachineEvent = { type: 'cancel'; cause: 'cancelled' | 'user-abort' };

interface PendingSnapshot {
  notifications: UserEntry[];
  reminders: HistoryMessage[];
}

interface QuiesceSnapshot extends PendingSnapshot {
  queue: UserEntry[];
  history: HistoryMessage[];
  nextTurnId: number;
  branch: string;
  head: number | null;
  tokensBefore: number;
}

interface SummaryResult {
  seedEvents: ExternalEvent[];
  stats: CompactionStats;
  telemetry: SummaryTelemetry;
}

interface CompactionMachineContext {
  input: CompactionMachineInput;
  startedAt: number;
  cause?: CompactionCancelCause;
  error?: unknown;
  originTurnId?: number;
  snap?: QuiesceSnapshot;
  seedEvents?: ExternalEvent[];
  stats?: CompactionStats;
  summaryTelemetry?: SummaryTelemetry;
  branchId?: string;
  pending?: PendingSnapshot;
}

const PAUSE_TIMEOUT_MS = 300_000;
const RESET_TIMEOUT_MS = 20_000;

const INPUT_DELTA_TYPES: ReadonlySet<string> = new Set([
  inputSubmitted.type,
  inputNotified.type,
  inputReminded.type,
  inputCancelled.type,
  inputSteered.type,
]);

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason as unknown);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as unknown), { once: true });
  });
}

async function forEachDeltaEntry(
  stores: SessionStores,
  snapBranch: string,
  snapHead: number | null,
  visit: (type: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const branch = stores.tree.openBranch(snapBranch);
  const head = branch.head;
  if (head === null) return;
  for (let seq = (snapHead ?? -1) + 1; seq <= head; seq++) {
    const entry = branch.entryAt(seq);
    if (entry === null) continue;
    const data = (await stores.tree.resolve(entry)) as Record<string, unknown> | null;
    if (data === null) continue;
    visit(entry.type, data);
  }
}

async function assertInputOnlyDelta(
  stores: SessionStores,
  snapBranch: string,
  snapHead: number | null,
): Promise<void> {
  await forEachDeltaEntry(stores, snapBranch, snapHead, (type) => {
    if (!INPUT_DELTA_TYPES.has(type)) {
      throw new CompactError('drift', 'history changed during compaction; cancelled');
    }
  });
}

function replayPendingDelta(
  deps: CompactionMachineDeps,
  snap: PendingSnapshot,
  pending: PendingSnapshot,
): void {
  const snapNotifications = new Set(snap.notifications);
  for (const entry of pending.notifications) {
    if (!snapNotifications.has(entry)) {
      deps.actor.send({ type: 'input.notify', entry });
    }
  }
  const snapReminders = new Set(snap.reminders);
  for (const entry of pending.reminders) {
    if (snapReminders.has(entry) || entry.meta?.key === undefined) continue;
    if (entry.message.role !== 'system' && entry.message.role !== 'user') continue;
    deps.actor.send({ type: 'input.remind', key: entry.meta.key, entry: entry as SystemEntry | UserEntry });
  }
}

function waitForResetApplied(deps: CompactionMachineDeps, branchId: string): Promise<void> {
  if (deps.actor.getSnapshot().context.branchId === branchId) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.unsubscribe();
      reject(new CompactError('reset-timeout', `machine did not apply branch '${branchId}' in time`));
    }, RESET_TIMEOUT_MS);
    const subscription = deps.actor.on('context.reset', (event) => {
      if (event.branchId !== branchId) return;
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve();
    });
  });
}

export function createCompactionMachine(deps: CompactionMachineDeps) {
  return setup({
    types: {
      input: {} as CompactionMachineInput,
      context: {} as CompactionMachineContext,
      events: {} as CompactionMachineEvent,
      emitted: {} as CompactionEvent,
      output: {} as CompactionMachineOutput,
    },
    actors: {
      quiesce: fromPromise<QuiesceSnapshot, void>(async ({ signal }) => {
        const store = deps.stores.get(deps.agentId);
        if (store === undefined) {
          throw new CompactError('unknown-agent', `unknown agent: '${deps.agentId}'`);
        }
        deps.actor.send({ type: 'input.pause' });
        const waiting = waitFor(deps.actor, (s) => s.matches('idle'), { timeout: PAUSE_TIMEOUT_MS });
        void waiting.catch(() => undefined);
        await Promise.race([waiting, aborted(signal)]);
        await store.flush();
        const state = store.getState();
        if (state.history.length === 0) {
          throw new CompactError('insufficient', 'nothing to compact');
        }
        const pending = deps.actor.getSnapshot().context;
        return {
          history: state.history,
          queue: [...pending.queue],
          notifications: [...pending.notifications],
          reminders: [...pending.reminders],
          nextTurnId: state.turnIndex.nextTurnId,
          branch: store.ref.branch,
          head: deps.stores.tree.openBranch(store.ref.branch).head,
          tokensBefore: estimateUsedContextTokens(state.history),
        };
      }),
      summarize: fromPromise<
        SummaryResult,
        { snap: QuiesceSnapshot; reason: CompactionReason; instruction?: string }
      >(async ({ input, signal }) => {
        await deps.onWillCompact?.({
          reason: input.reason,
          instruction: input.instruction,
          signal,
          tokenCount: input.snap.tokensBefore,
        });
        const outcome = await deps.summarize({
          history: input.snap.history,
          instruction: input.instruction,
          signal,
        });
        let summary = outcome.text;
        const todoText = deps.todos?.();
        if (todoText !== undefined && todoText.length > 0) {
          summary = `${summary.trim()}\n\n${todoText}`;
        }
        if (signal.aborted) throw signal.reason;
        const store = deps.stores.get(deps.agentId);
        if (store === undefined || store.ref.branch !== input.snap.branch) {
          throw new CompactError('drift', 'branch switched during compaction; cancelled');
        }
        await assertInputOnlyDelta(deps.stores, input.snap.branch, input.snap.head);
        const seed = buildCompactionSeed({
          turnId: input.snap.nextTurnId,
          history: input.snap.history,
          summary,
          queue: input.snap.queue,
        });
        return {
          seedEvents: seed.events,
          stats: {
            compactedCount: input.snap.history.length,
            tokensBefore: input.snap.tokensBefore,
            tokensAfter: seed.tokensAfter,
          },
          telemetry: {
            usage: outcome.usage,
            traceId: outcome.traceId,
            attempts: outcome.attempts,
            droppedCount: outcome.droppedCount,
          },
        };
      }),
      switchStore: fromPromise<
        { branchId: string; pending: PendingSnapshot },
        { seedEvents: ExternalEvent[]; stats: CompactionStats }
      >(async ({ input }) => {
        const machineContext = deps.actor.getSnapshot().context;
        const pending: PendingSnapshot = {
          notifications: [...machineContext.notifications],
          reminders: [...machineContext.reminders],
        };
        const { branchId } = await deps.stores.switchBranch(deps.agentId, {
          reason: 'compaction',
          stats: {
            compactedCount: input.stats.compactedCount,
            tokensBefore: input.stats.tokensBefore,
            tokensAfter: input.stats.tokensAfter,
          },
          seed: input.seedEvents,
        });
        await waitForResetApplied(deps, branchId);
        return { branchId, pending };
      }),
      resume: fromPromise<void, { snap: QuiesceSnapshot; pending: PendingSnapshot; reason: CompactionReason }>(
        async ({ input }) => {
          replayPendingDelta(deps, input.snap, input.pending);
          const continuation = (deps.continuation ?? defaultContinuation)(input.reason);
          if (continuation !== undefined) {
            deps.actor.send({ type: 'input.submit', entry: createUserEntry(continuation) });
          }
          deps.actor.send({ type: 'input.continue' });
        },
      ),
    },
  }).createMachine({
    id: 'compaction',
    initial: 'quiescing',
    context: ({ input }) => ({ input, startedAt: Date.now() }),
    on: {
      cancel: {},
    },
    states: {
      quiescing: {
        entry: [
          emit(({ context }) => ({
            type: 'compaction.started' as const,
            reason: context.input.reason,
            instruction: context.input.instruction,
          })),
          assign({
            originTurnId: ({ context }) =>
              context.input.reason === 'manual'
                ? undefined
                : deps.actor.getSnapshot().context.activeTurnId,
          }),
          enqueueActions(({ enqueue }) => {
            const snapshot = deps.actor.getSnapshot();
            if (!snapshot.matches('idle')) {
              enqueue.emit({
                type: 'compaction.blocked',
                turnId: snapshot.context.activeTurnId,
              });
            }
          }),
        ],
        invoke: {
          src: 'quiesce',
          onDone: {
            target: 'summarizing',
            actions: assign({ snap: ({ event }) => event.output }),
          },
          onError: {
            target: 'cancelled',
            actions: assign(({ event }) => ({
              cause: (event.error instanceof CompactError && event.error.code === 'drift'
                ? 'drift'
                : 'failed') as CompactionCancelCause,
              error: event.error,
            })),
          },
        },
        on: {
          cancel: {
            target: 'cancelled',
            actions: assign(({ event }) => ({
              cause: event.cause as CompactionCancelCause,
              error: cancelError(event.cause),
            })),
          },
        },
      },
      summarizing: {
        invoke: {
          src: 'summarize',
          input: ({ context }) => ({
            snap: context.snap as QuiesceSnapshot,
            reason: context.input.reason,
            instruction: context.input.instruction,
          }),
          onDone: {
            target: 'switching',
            actions: assign({
              seedEvents: ({ event }) => event.output.seedEvents,
              stats: ({ event }) => event.output.stats,
              summaryTelemetry: ({ event }) => event.output.telemetry,
            }),
          },
          onError: {
            target: 'cancelled',
            actions: assign(({ event }) => ({
              cause: (event.error instanceof CompactError && event.error.code === 'drift'
                ? 'drift'
                : 'failed') as CompactionCancelCause,
              error: event.error,
            })),
          },
        },
        on: {
          cancel: {
            target: 'cancelled',
            actions: assign(({ event }) => ({
              cause: event.cause as CompactionCancelCause,
              error: cancelError(event.cause),
            })),
          },
        },
      },
      switching: {
        invoke: {
          src: 'switchStore',
          input: ({ context }) => ({
            seedEvents: context.seedEvents as ExternalEvent[],
            stats: context.stats as CompactionStats,
          }),
          onDone: {
            target: 'resuming',
            actions: assign({
              branchId: ({ event }) => event.output.branchId,
              pending: ({ event }) => event.output.pending,
            }),
          },
          onError: {
            target: 'cancelled',
            actions: assign({ cause: 'failed' as CompactionCancelCause, error: ({ event }) => event.error }),
          },
        },
      },
      resuming: {
        invoke: {
          src: 'resume',
          input: ({ context }) => ({
            snap: context.snap as QuiesceSnapshot,
            pending: context.pending as PendingSnapshot,
            reason: context.input.reason,
          }),
          onDone: { target: 'completed' },
          onError: {
            target: 'cancelled',
            actions: assign({ cause: 'failed' as CompactionCancelCause, error: ({ event }) => event.error }),
          },
        },
      },
      completed: {
        type: 'final',
        entry: emit(({ context }) => ({
          type: 'compaction.completed' as const,
          reason: context.input.reason,
          branchId: context.branchId as string,
          stats: context.stats as CompactionStats,
          durationMs: Date.now() - context.startedAt,
          originTurnId: context.originTurnId,
          summary: context.summaryTelemetry,
        })),
      },
      cancelled: {
        type: 'final',
        entry: [
          ({ context }) => {
            if (context.cause !== 'user-abort') {
              deps.actor.send({ type: 'input.continue' });
            }
          },
          emit(({ context }) => ({
            type: 'compaction.cancelled' as const,
            reason: context.input.reason,
            cause: context.cause as CompactionCancelCause,
            error: context.cause === 'failed' ? context.error : undefined,
            durationMs: Date.now() - context.startedAt,
            originTurnId: context.originTurnId,
            tokensBefore: context.snap?.tokensBefore,
          })),
        ],
      },
    },
    output: ({ context }): CompactionMachineOutput =>
      context.cause === undefined
        ? {
            status: 'completed',
            branchId: context.branchId as string,
            stats: context.stats as CompactionStats,
          }
        : { status: 'cancelled', cause: context.cause, error: context.error },
  });
}

function cancelError(cause: 'cancelled' | 'user-abort'): CompactError {
  return cause === 'cancelled'
    ? new CompactError('cancelled', 'compaction was cancelled')
    : new CompactError('aborted', 'compaction cancelled by user abort');
}

function defaultContinuation(reason: CompactionReason): UserMessage | undefined {
  if (reason === 'manual') return undefined;
  return compactionContinuationMessage();
}
