import { usedContextTokens, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import type { UserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type {
  Cause,
  StepStartingDecision,
  StepStartingEvent,
  StepStoppingEvent,
  StepStoppingVerdict,
  TurnOutcome,
} from '@moonshot-ai/agent-core/loop/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import {
  createFeature,
  useAgent,
  useRequester,
  useStepStarting,
  useStepStopping,
  type Feature,
} from '#/app/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  type RuntimeEvent,
} from '#/kernel/index';
import { useLoopEvent } from '#/runtime/index';

import { CompactError, isContextOverflowError } from './errors';
import { buildCompactionSeed, compactionContinuationMessage, type CompactionSeed } from './shape';
import { createSummarize, type Summarize, type SummaryOutcome } from './summarize';

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

export interface CompactionStartedEvent extends RuntimeEvent {
  readonly type: 'compaction.started';
  readonly reason: CompactionReason;
  readonly instruction?: string;
}

export interface CompactionEnqueuedEvent extends RuntimeEvent {
  readonly type: 'compaction.enqueued';
  readonly reason: CompactionReason;
  readonly instruction?: string;
  readonly turnId?: number;
}

export type CompactionRejectReason = 'busy';

export interface CompactionRejectedEvent extends RuntimeEvent {
  readonly type: 'compaction.rejected';
  readonly reason: CompactionRejectReason;
  readonly instruction?: string;
}

export interface CompactionCompletedEvent extends RuntimeEvent {
  readonly type: 'compaction.completed';
  readonly reason: CompactionReason;
  readonly stats: CompactionStats;
  readonly durationMs: number;
  readonly originTurnId?: number;
  readonly summary?: SummaryTelemetry;
}

export interface CompactionCancelledEvent extends RuntimeEvent {
  readonly type: 'compaction.cancelled';
  readonly reason: CompactionReason;
  readonly cause: CompactionCancelCause;
  readonly error?: unknown;
  readonly durationMs: number;
  readonly originTurnId?: number;
  readonly tokensBefore?: number;
}

export type CompactionEvent =
  | CompactionStartedEvent
  | CompactionEnqueuedEvent
  | CompactionRejectedEvent
  | CompactionCompletedEvent
  | CompactionCancelledEvent;

export interface CompactionStatus {
  phase: CompactionPhase;
  reason?: CompactionReason;
  startedAt?: number;
}

export interface CompactionFace {
  compact(instruction?: string): Promise<void>;
  cancel(): void;
  status(): CompactionStatus;
}

export const CompactionRef = createFacadeToken<CompactionFace>('compaction');

export interface CreateCompactionDeps {
  summarize?: Summarize;
  budget: {
    maxContextTokens(): number;
    triggerRatio: number;
  };
  continuation?: (reason: CompactionReason) => UserMessage | undefined;
  maxAutoAttempts?: number;
  todos?: () => string | undefined;
  onWillCompact?: (input: {
    reason: CompactionReason;
    instruction?: string;
    signal: AbortSignal;
    tokenCount: number;
  }) => void | Promise<void>;
  onEvent?: (event: CompactionEvent) => void;
}

interface ActiveRun {
  reason: CompactionReason;
  phase: CompactionPhase;
  startedAt: number;
  controller: AbortController;
  cancelCause?: CompactionCancelCause;
  originTurnId?: number;
  tokensBefore?: number;
}

interface PendingCompaction {
  startedAt: number;
  controller: AbortController;
  cancelCause?: CompactionCancelCause;
}

interface CompactionState {
  active?: ActiveRun;
  pending?: PendingCompaction;
  attempts: { turnId?: number; count: number };
  pendingOverflow: boolean;
  lastLlmErrorKind?: string;
}

const states = new WeakMap<Agent, CompactionState>();

const DEFAULT_MAX_AUTO_ATTEMPTS = 3;
const IDLE_TIMEOUT_MS = 300_000;

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? String(typeof error);
}

export function createCompaction(deps: CreateCompactionDeps): Feature<void, { agent: CompactionEvent }> {
  return createFeature<{ agent: CompactionEvent }>('compaction', {
    agent() {
      const agent = useAgent();
      const fire = useFire();
      const summarize = deps.summarize ?? createSummarize({ requester: useRequester() });
      const maxAutoAttempts = deps.maxAutoAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;

      const _emit = (event: CompactionEvent): void => {
        deps.onEvent?.(event);
        fire({ ...event });
      };

      let state = states.get(agent);
      if (state === undefined) {
        state = { attempts: { count: 0 }, pendingOverflow: false };
        states.set(agent, state);
      }
      const shared = state;

      const _budgetExceeded = (used: number): boolean => {
        const max = deps.budget.maxContextTokens();
        return max > 0 && used >= max * deps.budget.triggerRatio;
      };

      const _bumpAttempts = (turnId: number): void => {
        if (shared.attempts.turnId !== turnId) shared.attempts = { turnId, count: 0 };
        shared.attempts.count += 1;
      };

      const _cancelCauseOf = (run: ActiveRun, error: unknown): CompactionCancelCause => {
        if (run.cancelCause !== undefined) return run.cancelCause;
        if (error instanceof CompactError && error.code === 'drift') return 'drift';
        return 'failed';
      };

      const _abort = (
        target: { controller: AbortController; cancelCause?: CompactionCancelCause },
        cause: 'cancelled' | 'user-abort',
      ): void => {
        target.cancelCause = cause;
        target.controller.abort(
          cause === 'cancelled'
            ? new CompactError('cancelled', 'compaction was cancelled')
            : new CompactError('aborted', 'compaction cancelled by user abort'),
        );
      };

      const _summarizeAndSeed = async (
        run: ActiveRun,
        history: readonly HistoryMessage[],
        instruction: string | undefined,
        signal: AbortSignal,
      ) => {
        await deps.onWillCompact?.({
          reason: run.reason,
          instruction,
          signal,
          tokenCount: run.tokensBefore ?? usedContextTokens(history),
        });
        const outcome = await summarize({ history, instruction, signal });
        let summary = outcome.text;
        const todoText = deps.todos?.();
        if (todoText !== undefined && todoText.length > 0) {
          summary = `${summary.trim()}\n\n${todoText}`;
        }
        if (signal.aborted) throw signal.reason as unknown;
        const seed = buildCompactionSeed({
          history,
          summary,
          continuation: deps.continuation?.(run.reason) ?? compactionContinuationMessage(),
        });
        const telemetry: SummaryTelemetry = {
          usage: outcome.usage,
          traceId: outcome.traceId,
          attempts: outcome.attempts,
          droppedCount: outcome.droppedCount,
        };
        return { seed, telemetry };
      };

      const _waitForIdle = async (signal: AbortSignal): Promise<void> => {
        const started = Date.now();
        for (;;) {
          if (signal.aborted) throw signal.reason as unknown;
          if (agent.loop.state.turn === undefined) return;
          if (Date.now() - started > IDLE_TIMEOUT_MS) {
            throw new CompactError('reset-timeout', 'agent did not become idle before compaction');
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };

      const _compact = async <T>(
        run: ActiveRun,
        prepare: () => Promise<readonly HistoryMessage[]> | readonly HistoryMessage[],
        instruction: string | undefined,
        signal: AbortSignal,
        apply: (seed: CompactionSeed) => T | Promise<T>,
      ): Promise<T> => {
        shared.active = run;
        _emit({ type: 'compaction.started', reason: run.reason, instruction });
        try {
          const history = await prepare();
          const tokensBefore = (run.tokensBefore ??= usedContextTokens(history));
          const { seed, telemetry } = await _summarizeAndSeed(run, history, instruction, signal);
          const result = await apply(seed);
          const stats: CompactionStats = {
            compactedCount: history.length,
            tokensBefore,
            tokensAfter: seed.tokensAfter,
          };
          _emit({
            type: 'compaction.completed',
            reason: run.reason,
            stats,
            durationMs: Date.now() - run.startedAt,
            originTurnId: run.originTurnId,
            summary: telemetry,
          });
          return result;
        } catch (error) {
          const cause = _cancelCauseOf(run, error);
          _emit({
            type: 'compaction.cancelled',
            reason: run.reason,
            cause,
            error: cause === 'failed' ? error : undefined,
            durationMs: Date.now() - run.startedAt,
            originTurnId: run.originTurnId,
            tokensBefore: run.tokensBefore,
          });
          throw error;
        } finally {
          if (shared.active === run) shared.active = undefined;
        }
      };

      const compact = async (instruction?: string): Promise<void> => {
        if (shared.active !== undefined || shared.pending !== undefined) {
          _emit({ type: 'compaction.rejected', reason: 'busy', instruction });
          throw new CompactError('busy', 'compaction is already running');
        }
        const turnId = agent.loop.state.turn?.id;
        if (turnId !== undefined) {
          const pending: PendingCompaction = {
            startedAt: Date.now(),
            controller: new AbortController(),
          };
          shared.pending = pending;
          _emit({ type: 'compaction.enqueued', reason: 'manual', instruction, turnId });
          try {
            await _waitForIdle(pending.controller.signal);
          } catch (error) {
            const cause = pending.cancelCause ?? 'failed';
            _emit({
              type: 'compaction.cancelled',
              reason: 'manual',
              cause,
              error: cause === 'failed' ? error : undefined,
              durationMs: Date.now() - pending.startedAt,
            });
            throw error;
          } finally {
            if (shared.pending === pending) shared.pending = undefined;
          }
        }
        const run: ActiveRun = {
          reason: 'manual',
          phase: 'summarizing',
          startedAt: Date.now(),
          controller: new AbortController(),
        };
        await _compact(
          run,
          async () => {
            await agent.flush();
            const history = agent.view.getState().messages;
            if (history.length === 0) {
              throw new CompactError('insufficient', 'nothing to compact');
            }
            return history;
          },
          instruction,
          run.controller.signal,
          (seed) => {
            run.phase = 'resetting';
            if (agent.loop.state.turn !== undefined) {
              throw new CompactError('drift', 'history changed during compaction; cancelled');
            }
            const ack = agent.loop.setContext([...seed.messages], 'manual');
            if (ack === undefined || ack.type !== 'context.settled') {
              throw new CompactError('reset-failed', 'agent did not accept the context reset');
            }
          },
        );
      };

      const cancel = (): void => {
        if (shared.pending !== undefined) _abort(shared.pending, 'cancelled');
        if (shared.active !== undefined) _abort(shared.active, 'cancelled');
      };

      const status = (): CompactionStatus => {
        if (shared.active !== undefined) {
          return {
            phase: shared.active.phase,
            reason: shared.active.reason,
            startedAt: shared.active.startedAt,
          };
        }
        if (shared.pending !== undefined) {
          return { phase: 'quiescing', reason: 'manual', startedAt: shared.pending.startedAt };
        }
        return { phase: 'idle' };
      };

      const _stepStarting = async (
        event: StepStartingEvent,
        signal: AbortSignal,
      ): Promise<StepStartingDecision | undefined> => {
        const overflow = shared.pendingOverflow;
        shared.pendingOverflow = false;
        const used = usedContextTokens(event.messages, {
          systemPrompt: event.profile.systemPrompt,
          tools: event.profile.tools,
        });
        if (!overflow && !_budgetExceeded(used)) return undefined;
        if (shared.active !== undefined) return undefined;
        const reason: CompactionReason = overflow ? 'overflow' : 'budget';
        if (!overflow) {
          _bumpAttempts(event.turnId);
          if (shared.attempts.count > maxAutoAttempts) {
            return {
              blocked: {
                by: 'compaction',
                reason: 'attempts-exceeded',
                message: `auto compaction exceeded ${String(maxAutoAttempts)} attempts for turn ${String(event.turnId)}`,
              },
            };
          }
        }
        const run: ActiveRun = {
          reason,
          phase: 'summarizing',
          startedAt: Date.now(),
          controller: new AbortController(),
          originTurnId: event.turnId,
          tokensBefore: used,
        };
        try {
          return await _compact(
            run,
            () => event.messages,
            undefined,
            AbortSignal.any([signal, run.controller.signal]),
            (seed) => ({ messages: seed.messages }),
          );
        } catch (error) {
          const cause = _cancelCauseOf(run, error);
          if (cause === 'failed') {
            const blocked: Cause = {
              by: 'compaction',
              reason: error instanceof CompactError ? error.code : 'summary-failed',
              message: errorMessageOf(error),
            };
            return { blocked };
          }
          return undefined;
        }
      };

      const _stepStopping = (event: StepStoppingEvent): StepStoppingVerdict | undefined => {
        const { draft } = event;
        if (draft.type !== 'failed') {
          shared.lastLlmErrorKind = undefined;
          return undefined;
        }
        const overflow =
          isContextOverflowError(draft.error) || shared.lastLlmErrorKind === 'context_overflow';
        shared.lastLlmErrorKind = undefined;
        if (!overflow) return undefined;
        _bumpAttempts(event.turnId);
        if (shared.attempts.count > maxAutoAttempts) return undefined;
        shared.pendingOverflow = true;
        return { type: 'continue', cause: { by: 'compaction', reason: 'context-overflow' } };
      };

      const _noteLlmOutcome = (outcome: LlmOutcome): void => {
        shared.lastLlmErrorKind = outcome.type === 'failed' ? outcome.error.kind : undefined;
      };

      const _noteTurnEnded = (outcome: TurnOutcome): void => {
        if (outcome.type === 'done') shared.attempts = { count: 0 };
        if (outcome.type === 'aborted') {
          if (shared.pending !== undefined) _abort(shared.pending, 'user-abort');
          if (shared.active !== undefined) _abort(shared.active, 'user-abort');
        }
      };

      useStepStarting(_stepStarting, { id: 'compaction.step-starting' });
      useStepStopping(_stepStopping, { id: 'compaction.step-stopping' });
      useLoopEvent('llm.ended', ({ outcome }) => _noteLlmOutcome(outcome));
      useLoopEvent('turn.ended', ({ outcome }) => _noteTurnEnded(outcome));
      useExpose(CompactionRef, { compact, cancel, status });
      useCleanup(() => {
        if (shared.pending !== undefined) _abort(shared.pending, 'cancelled');
        if (shared.active !== undefined) _abort(shared.active, 'cancelled');
      });
    },
  });
}
