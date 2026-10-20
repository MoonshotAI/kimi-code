import { usedContextTokens, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import type { UserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';
import type {
  Cause,
  StepStartingDecision,
  StepStartingEvent,
  StepStoppingEvent,
  StepStoppingVerdict,
  TurnOutcome,
} from '@moonshot-ai/agent-core/loop/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import { CompactError, isContextOverflowError } from './errors';
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

export interface CompactionStartedEvent extends RuntimeEvent {
  readonly type: 'compaction.started';
  readonly reason: CompactionReason;
  readonly instruction?: string;
}

export interface CompactionBlockedEvent extends RuntimeEvent {
  readonly type: 'compaction.blocked';
  readonly turnId?: number;
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
  | CompactionBlockedEvent
  | CompactionCompletedEvent
  | CompactionCancelledEvent;

export interface CompactionStatus {
  phase: CompactionPhase;
  reason?: CompactionReason;
  startedAt?: number;
}

export interface CompactionControllerDeps {
  agent: Agent;
  summarize: Summarize;
  budget: {
    maxContextTokens(): number;
    triggerRatio: number;
  };
  emit: (event: CompactionEvent) => void;
  continuation?: (reason: CompactionReason) => UserMessage | undefined;
  maxAutoAttempts?: number;
  todos?: () => string | undefined;
  onWillCompact?: (input: {
    reason: CompactionReason;
    instruction?: string;
    signal: AbortSignal;
    tokenCount: number;
  }) => void | Promise<void>;
}

export interface CompactionController {
  compact(instruction?: string): Promise<void>;
  cancel(): void;
  status(): CompactionStatus;
  stepStarting(
    event: StepStartingEvent,
    signal: AbortSignal,
  ): Promise<StepStartingDecision | undefined>;
  stepStopping(event: StepStoppingEvent): StepStoppingVerdict | undefined;
  noteLlmOutcome(outcome: LlmOutcome): void;
  noteTurnEnded(outcome: TurnOutcome): void;
  dispose(): void;
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

interface CompactionState {
  active?: ActiveRun;
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

export function createCompactionController(deps: CompactionControllerDeps): CompactionController {
  const maxAutoAttempts = deps.maxAutoAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;
  let state = states.get(deps.agent);
  if (state === undefined) {
    state = { attempts: { count: 0 }, pendingOverflow: false };
    states.set(deps.agent, state);
  }
  const shared = state;

  const budgetExceeded = (used: number): boolean => {
    const max = deps.budget.maxContextTokens();
    return max > 0 && used >= max * deps.budget.triggerRatio;
  };

  const bumpAttempts = (turnId: number): void => {
    if (shared.attempts.turnId !== turnId) shared.attempts = { turnId, count: 0 };
    shared.attempts.count += 1;
  };

  const cancelCauseOf = (run: ActiveRun, error: unknown): CompactionCancelCause => {
    if (run.cancelCause !== undefined) return run.cancelCause;
    if (error instanceof CompactError && error.code === 'drift') return 'drift';
    return 'failed';
  };

  const abortRun = (run: ActiveRun, cause: 'cancelled' | 'user-abort'): void => {
    run.cancelCause = cause;
    run.controller.abort(
      cause === 'cancelled'
        ? new CompactError('cancelled', 'compaction was cancelled')
        : new CompactError('aborted', 'compaction cancelled by user abort'),
    );
  };

  const summarizeAndSeed = async (
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
    const outcome = await deps.summarize({ history, instruction, signal });
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

  const waitForIdle = async (signal: AbortSignal): Promise<void> => {
    const started = Date.now();
    for (;;) {
      if (signal.aborted) throw signal.reason as unknown;
      if (deps.agent.loop.state.turn === undefined) return;
      if (Date.now() - started > IDLE_TIMEOUT_MS) {
        throw new CompactError('reset-timeout', 'agent did not become idle before compaction');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const compact = async (instruction?: string): Promise<void> => {
    if (shared.active !== undefined) {
      throw new CompactError('busy', 'compaction is already running');
    }
    const run: ActiveRun = {
      reason: 'manual',
      phase: 'quiescing',
      startedAt: Date.now(),
      controller: new AbortController(),
    };
    shared.active = run;
    deps.emit({ type: 'compaction.started', reason: 'manual', instruction });
    try {
      const turnId = deps.agent.loop.state.turn?.id;
      if (turnId !== undefined) {
        deps.emit({ type: 'compaction.blocked', turnId });
        await waitForIdle(run.controller.signal);
      }
      run.phase = 'summarizing';
      await deps.agent.flush();
      const history = deps.agent.view.getState().messages;
      if (history.length === 0) {
        throw new CompactError('insufficient', 'nothing to compact');
      }
      run.tokensBefore = usedContextTokens(history);
      const { seed, telemetry } = await summarizeAndSeed(
        run,
        history,
        instruction,
        run.controller.signal,
      );
      run.phase = 'resetting';
      if (deps.agent.loop.state.turn !== undefined) {
        throw new CompactError('drift', 'history changed during compaction; cancelled');
      }
      const ack = deps.agent.loop.setContext([...seed.messages], 'manual');
      if (ack === undefined || ack.type !== 'context.settled') {
        throw new CompactError('reset-failed', 'agent did not accept the context reset');
      }
      const stats: CompactionStats = {
        compactedCount: history.length,
        tokensBefore: run.tokensBefore,
        tokensAfter: seed.tokensAfter,
      };
      deps.emit({
        type: 'compaction.completed',
        reason: 'manual',
        stats,
        durationMs: Date.now() - run.startedAt,
        summary: telemetry,
      });
    } catch (error) {
      const cause = cancelCauseOf(run, error);
      deps.emit({
        type: 'compaction.cancelled',
        reason: 'manual',
        cause,
        error: cause === 'failed' ? error : undefined,
        durationMs: Date.now() - run.startedAt,
        tokensBefore: run.tokensBefore,
      });
      throw error;
    } finally {
      if (shared.active === run) shared.active = undefined;
    }
  };

  const stepStarting = async (
    event: StepStartingEvent,
    signal: AbortSignal,
  ): Promise<StepStartingDecision | undefined> => {
    const overflow = shared.pendingOverflow;
    shared.pendingOverflow = false;
    const used = usedContextTokens(event.messages, {
      systemPrompt: event.profile.systemPrompt,
      tools: event.profile.tools,
    });
    if (!overflow && !budgetExceeded(used)) return undefined;
    if (shared.active !== undefined) return undefined;
    const reason: CompactionReason = overflow ? 'overflow' : 'budget';
    if (!overflow) {
      bumpAttempts(event.turnId);
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
    shared.active = run;
    deps.emit({ type: 'compaction.started', reason, instruction: undefined });
    try {
      const { seed, telemetry } = await summarizeAndSeed(
        run,
        event.messages,
        undefined,
        AbortSignal.any([signal, run.controller.signal]),
      );
      const stats: CompactionStats = {
        compactedCount: event.messages.length,
        tokensBefore: used,
        tokensAfter: seed.tokensAfter,
      };
      deps.emit({
        type: 'compaction.completed',
        reason,
        stats,
        durationMs: Date.now() - run.startedAt,
        originTurnId: event.turnId,
        summary: telemetry,
      });
      return { messages: seed.messages };
    } catch (error) {
      const cause = cancelCauseOf(run, error);
      deps.emit({
        type: 'compaction.cancelled',
        reason,
        cause,
        error: cause === 'failed' ? error : undefined,
        durationMs: Date.now() - run.startedAt,
        originTurnId: event.turnId,
        tokensBefore: used,
      });
      if (cause === 'failed') {
        const blocked: Cause = {
          by: 'compaction',
          reason: error instanceof CompactError ? error.code : 'summary-failed',
          message: errorMessageOf(error),
        };
        return { blocked };
      }
      return undefined;
    } finally {
      if (shared.active === run) shared.active = undefined;
    }
  };

  const stepStopping = (event: StepStoppingEvent): StepStoppingVerdict | undefined => {
    const { draft } = event;
    if (draft.type !== 'failed') {
      shared.lastLlmErrorKind = undefined;
      return undefined;
    }
    const overflow =
      isContextOverflowError(draft.error) || shared.lastLlmErrorKind === 'context_overflow';
    shared.lastLlmErrorKind = undefined;
    if (!overflow) return undefined;
    bumpAttempts(event.turnId);
    if (shared.attempts.count > maxAutoAttempts) return undefined;
    shared.pendingOverflow = true;
    return { type: 'continue', cause: { by: 'compaction', reason: 'context-overflow' } };
  };

  return {
    compact,
    cancel: () => {
      if (shared.active !== undefined) abortRun(shared.active, 'cancelled');
    },
    status: () =>
      shared.active === undefined
        ? { phase: 'idle' }
        : {
            phase: shared.active.phase,
            reason: shared.active.reason,
            startedAt: shared.active.startedAt,
          },
    stepStarting,
    stepStopping,
    noteLlmOutcome: (outcome) => {
      shared.lastLlmErrorKind = outcome.type === 'failed' ? outcome.error.kind : undefined;
    },
    noteTurnEnded: (outcome) => {
      if (outcome.type === 'done') shared.attempts = { count: 0 };
      if (outcome.type === 'aborted' && shared.active !== undefined) {
        abortRun(shared.active, 'user-abort');
      }
    },
    dispose: () => {
      if (shared.active !== undefined) abortRun(shared.active, 'cancelled');
    },
  };
}
