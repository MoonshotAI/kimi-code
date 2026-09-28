import {
  usedContextTokens,
  type AgentCommands,
  type HistoryMessage,
  type RecordEvent,
  type SessionStores,
  type UserEntry,
  type UserMessage,
} from '@moonshot-ai/agent-core';
import { assign, emit, enqueueActions, fromPromise, setup } from '@moonshot-ai/agent-core/xstate2/index';

import { CompactError } from './errors';
import { buildCompactionSeed } from './shape';
import type { Summarize, SummaryOutcome } from './summarize';

export type CompactionReason = 'budget' | 'manual' | 'overflow';

export type CompactionPhase =
  | 'idle'
  | 'quiescing'
  | 'summarizing'
  | 'switching'
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
  agent: AgentCommands;
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

interface QuiesceSnapshot {
  queue: UserEntry[];
  history: HistoryMessage[];
  nextTurnId: number;
  branch: string;
  head: number | null;
  tokensBefore: number;
}

interface SummaryResult {
  seedEvents: RecordEvent[];
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
  seedEvents?: RecordEvent[];
  stats?: CompactionStats;
  summaryTelemetry?: SummaryTelemetry;
  branchId?: string;
}

const PAUSE_TIMEOUT_MS = 300_000;
const HISTORY_DELTA_TYPES = new Set(['message.appended', 'turn.started', 'turn.ended']);

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason as unknown);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as unknown), { once: true });
  });
}

async function waitIdle(agent: AgentCommands, signal: AbortSignal): Promise<void> {
  const started = Date.now();
  while (agent.snapshot.value?.matches('idle') !== true) {
    if (signal.aborted) throw signal.reason;
    if (Date.now() - started > PAUSE_TIMEOUT_MS) {
      throw new CompactError('reset-timeout', 'agent did not become idle before compaction');
    }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 25)), aborted(signal)]);
  }
}

function assertInputOnlyDelta(stores: SessionStores, snapBranch: string, snapHead: number | null): void {
  const branch = stores.tree.openBranch(snapBranch);
  const head = branch.head;
  if (head === null) return;
  for (let seq = (snapHead ?? -1) + 1; seq <= head; seq++) {
    const entry = branch.entryAt(seq);
    if (entry === null) continue;
    if (HISTORY_DELTA_TYPES.has(entry.type)) {
      throw new CompactError('drift', 'history changed during compaction; cancelled');
    }
  }
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
        deps.agent.pause();
        await Promise.race([waitIdle(deps.agent, signal), aborted(signal)]);
        await deps.stores.flush();
        const state = store.getState();
        if (state.history.length === 0) {
          throw new CompactError('insufficient', 'nothing to compact');
        }
        const branch = deps.stores.branch(deps.agentId);
        if (branch === undefined) {
          throw new CompactError('unknown-agent', `unknown agent: '${deps.agentId}'`);
        }
        const pending = deps.agent.snapshot.value?.context;
        return {
          history: state.history,
          queue: [...(pending?.queue ?? [])],
          nextTurnId: state.turnIndex.nextTurnId,
          branch,
          head: deps.stores.tree.openBranch(branch).head,
          tokensBefore: usedContextTokens(state.history),
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
        if (store === undefined || deps.stores.branch(deps.agentId) !== input.snap.branch) {
          throw new CompactError('drift', 'branch switched during compaction; cancelled');
        }
        assertInputOnlyDelta(deps.stores, input.snap.branch, input.snap.head);
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
      switchStore: fromPromise<{ branchId: string }, { seedEvents: RecordEvent[]; stats: CompactionStats }>(
        async ({ input }) => {
          return deps.stores.switchBranch(deps.agentId, {
            reason: 'compaction',
            stats: {
              compactedCount: input.stats.compactedCount,
              tokensBefore: input.stats.tokensBefore,
              tokensAfter: input.stats.tokensAfter,
            },
            seed: input.seedEvents,
          });
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
                : deps.agent.snapshot.value?.context.activeTurnId,
          }),
          enqueueActions(({ enqueue }) => {
            if (deps.agent.snapshot.value?.matches('idle') !== true) {
              enqueue.emit({
                type: 'compaction.blocked',
                turnId: deps.agent.snapshot.value?.context.activeTurnId,
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
            seedEvents: context.seedEvents as RecordEvent[],
            stats: context.stats as CompactionStats,
          }),
          onDone: {
            target: 'completed',
            actions: assign({
              branchId: ({ event }) => event.output.branchId,
            }),
          },
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
              deps.agent.continue();
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
