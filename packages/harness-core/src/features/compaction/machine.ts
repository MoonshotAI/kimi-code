import {
  usedContextTokens,
  type AgentCommands,
  type HistoryMessage,
  type SessionStores,
  type UserMessage,
} from '@moonshot-ai/agent-core';
import { assign, emit, enqueueActions, fromPromise, setup } from '@moonshot-ai/agent-core/xstate2/index';

import { CompactError } from './errors';
import { buildCompactionSeed, compactionContinuationMessage } from './shape';
import type { Summarize, SummaryOutcome } from './summarize';

export type CompactionReason = 'budget' | 'manual' | 'overflow';

export type CompactionPhase =
  | 'idle'
  | 'quiescing'
  | 'summarizing'
  | 'resetting'
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

export interface CompactionOrigin {
  turnId: number;
  history: HistoryMessage[];
}

export interface CompactionMachineInput {
  reason: CompactionReason;
  instruction?: string;
  origin?: CompactionOrigin;
}

export type CompactionMachineOutput =
  | { status: 'completed'; stats: CompactionStats }
  | { status: 'cancelled'; cause: CompactionCancelCause; error: unknown };

type CompactionMachineEvent = { type: 'cancel'; cause: 'cancelled' | 'user-abort' };

interface QuiesceSnapshot {
  history: HistoryMessage[];
  branch: string;
  head: number | null;
  tokensBefore: number;
}

interface CompactionSource {
  history: HistoryMessage[];
  tokensBefore: number;
  drift?: { branch: string; head: number | null };
}

interface SummaryResult {
  seed: HistoryMessage[];
  stats: CompactionStats;
  telemetry: SummaryTelemetry;
}

interface CompactionMachineContext {
  input: CompactionMachineInput;
  startedAt: number;
  cause?: CompactionCancelCause;
  error?: unknown;
  originTurnId?: number;
  source?: CompactionSource;
  seed?: HistoryMessage[];
  stats?: CompactionStats;
  summaryTelemetry?: SummaryTelemetry;
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
        return {
          history: state.history,
          branch,
          head: deps.stores.tree.openBranch(branch).head,
          tokensBefore: usedContextTokens(state.history),
        };
      }),
      summarize: fromPromise<
        SummaryResult,
        { source: CompactionSource; reason: CompactionReason; instruction?: string }
      >(async ({ input, signal }) => {
        await deps.onWillCompact?.({
          reason: input.reason,
          instruction: input.instruction,
          signal,
          tokenCount: input.source.tokensBefore,
        });
        const outcome = await deps.summarize({
          history: input.source.history,
          instruction: input.instruction,
          signal,
        });
        let summary = outcome.text;
        const todoText = deps.todos?.();
        if (todoText !== undefined && todoText.length > 0) {
          summary = `${summary.trim()}\n\n${todoText}`;
        }
        if (signal.aborted) throw signal.reason;
        if (input.source.drift !== undefined) {
          const drift = input.source.drift;
          const store = deps.stores.get(deps.agentId);
          if (store === undefined || deps.stores.branch(deps.agentId) !== drift.branch) {
            throw new CompactError('drift', 'branch switched during compaction; cancelled');
          }
          assertInputOnlyDelta(deps.stores, drift.branch, drift.head);
        }
        const seed = buildCompactionSeed({
          history: input.source.history,
          summary,
          continuation: deps.continuation?.(input.reason) ?? compactionContinuationMessage(),
        });
        return {
          seed: seed.messages,
          stats: {
            compactedCount: input.source.history.length,
            tokensBefore: input.source.tokensBefore,
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
      resetContext: fromPromise<
        void,
        { seed: HistoryMessage[]; stats: CompactionStats; reason: CompactionReason; instruction?: string }
      >(async ({ input }) => {
        const ack = deps.agent.contextReset({
          messages: input.seed,
          reason: input.reason,
          instruction: input.instruction,
          stats: {
            compactedCount: input.stats.compactedCount,
            tokensBefore: input.stats.tokensBefore,
            tokensAfter: input.stats.tokensAfter,
          },
        });
        if (ack === undefined) {
          throw new CompactError('reset-failed', 'agent did not accept the context reset');
        }
      }),
    },
  }).createMachine({
    id: 'compaction',
    initial: 'starting',
    context: ({ input }) => ({ input, startedAt: Date.now() }),
    entry: [
      emit(({ context }) => ({
        type: 'compaction.started' as const,
        reason: context.input.reason,
        instruction: context.input.instruction,
      })),
      assign({
        originTurnId: ({ context }) => context.input.origin?.turnId,
      }),
    ],
    on: {
      cancel: {},
    },
    states: {
      starting: {
        always: [
          {
            guard: ({ context }) => context.input.origin !== undefined,
            target: 'summarizing',
            actions: assign({
              source: ({ context }) => {
                const origin = context.input.origin as CompactionOrigin;
                return {
                  history: origin.history,
                  tokensBefore: usedContextTokens(origin.history),
                };
              },
            }),
          },
          { target: 'quiescing' },
        ],
      },
      quiescing: {
        entry: enqueueActions(({ enqueue }) => {
          if (deps.agent.snapshot.value?.matches('idle') !== true) {
            enqueue.emit({
              type: 'compaction.blocked',
              turnId: deps.agent.snapshot.value?.context.activeTurnId,
            });
          }
        }),
        invoke: {
          src: 'quiesce',
          onDone: {
            target: 'summarizing',
            actions: assign({
              source: ({ event }) => ({
                history: event.output.history,
                tokensBefore: event.output.tokensBefore,
                drift: { branch: event.output.branch, head: event.output.head },
              }),
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
      summarizing: {
        invoke: {
          src: 'summarize',
          input: ({ context }) => ({
            source: context.source as CompactionSource,
            reason: context.input.reason,
            instruction: context.input.instruction,
          }),
          onDone: {
            target: 'resetting',
            actions: assign({
              seed: ({ event }) => event.output.seed,
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
      resetting: {
        invoke: {
          src: 'resetContext',
          input: ({ context }) => ({
            seed: context.seed as HistoryMessage[],
            stats: context.stats as CompactionStats,
            reason: context.input.reason,
            instruction: context.input.instruction,
          }),
          onDone: {
            target: 'completed',
          },
          onError: {
            target: 'cancelled',
            actions: assign({ cause: 'failed' as CompactionCancelCause, error: ({ event }) => event.error }),
          },
        },
      },
      completed: {
        type: 'final',
        entry: [
          ({ context }) => {
            if (context.input.origin === undefined) {
              deps.agent.continue();
            }
          },
          emit(({ context }) => ({
            type: 'compaction.completed' as const,
            reason: context.input.reason,
            stats: context.stats as CompactionStats,
            durationMs: Date.now() - context.startedAt,
            originTurnId: context.originTurnId,
            summary: context.summaryTelemetry,
          })),
        ],
      },
      cancelled: {
        type: 'final',
        entry: [
          ({ context }) => {
            if (context.input.origin !== undefined && context.error !== undefined) {
              deps.agent.contextReset({ error: context.error });
            }
          },
          ({ context }) => {
            if (context.input.origin === undefined && context.cause !== 'user-abort') {
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
            tokensBefore: context.source?.tokensBefore,
          })),
        ],
      },
    },
    output: ({ context }): CompactionMachineOutput =>
      context.cause === undefined
        ? {
            status: 'completed',
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
