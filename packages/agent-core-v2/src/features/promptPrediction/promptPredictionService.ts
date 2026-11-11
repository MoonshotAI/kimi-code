import { Disposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { abortable, abortError, createDeadlineAbortSignal, type DeadlineAbortSignal } from '#/_base/utils/abort';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type LoopSnapshot } from '#/agent/loop/loop';
import { turnKey } from '#/agent/loop/turnOps';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import { IAgentStateService } from '#/agent/state/agentState';
import { IFlagService } from '#/app/flag/flag';
import type { PredictionGeneratedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPlanService } from '#/features/plan/plan';
import { createUserMessage } from '@moonshot-ai/core/llm/message';
import type { LlmOutcome, LlmTiming } from '@moonshot-ai/core/llm/response';
import type { TokenUsage } from '@moonshot-ai/core/llm/usage';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionActivityView,
  type SessionActivityCause,
  type SessionActivityState,
} from '#/session/sessionActivity/sessionActivity';

import {
  ISessionPromptPredictionService,
  PROMPT_PREDICTION_FLAG_ID,
  PROMPT_PREDICTION_INSTRUCTION,
  PROMPT_PREDICTION_MAX_CHARS,
  PROMPT_PREDICTION_MAX_OUTPUT_TOKENS,
  PROMPT_PREDICTION_TIMEOUT_MS,
  type PromptPredictionCancelReason,
  type PromptPredictionInput,
} from './promptPrediction';

type PredictionOutcome =
  | 'generated'
  | 'empty'
  | 'invalid'
  | 'tool_call'
  | 'timeout'
  | 'cancelled'
  | 'stale'
  | 'error';

const ACTIVITY_CANCEL_REASONS = {
  turn_started: 'activity_turn_started',
  turn_ended: 'activity_turn_ended',
  background: 'activity_background',
  interaction: 'activity_interaction',
  agent_lifecycle: 'activity_agent_lifecycle',
} as const satisfies Record<SessionActivityCause, PromptPredictionCancelReason>;

interface ActivePrediction {
  readonly predictionId: string;
  readonly expectedTurnId: number;
  readonly controller: AbortController;
  readonly deadline: DeadlineAbortSignal;
  readonly startedAt: number;
  requested: boolean;
  outcome: PredictionOutcome;
  predictionChars?: number;
  usage?: TokenUsage;
  requestId?: string;
  timing?: LlmTiming;
  cancelReason?: PromptPredictionCancelReason;
}

interface PredictionScope {
  readonly handle: IAgentScopeHandle;
  readonly loop: IAgentLoopService;
  readonly states: IAgentStateService;
  readonly plan: IAgentPlanService;
  readonly telemetry: ITelemetryService;
}

export class SessionPromptPredictionService extends Disposable implements ISessionPromptPredictionService {
  declare readonly _serviceBrand: undefined;

  private readonly attemptedTurnIds = new Set<number>();
  private active: ActivePrediction | undefined;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionActivityView private readonly activity: ISessionActivityView,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(this.activity.onDidChange((event) => {
      this.abortActive(ACTIVITY_CANCEL_REASONS[event.cause]);
    }));
    this._register(this.agents.onWillClose((agent) => {
      if (agent.agentId === MAIN_AGENT_ID) this.abortActive('agent_will_close');
    }));
    this._register(this.agents.onDidCreateScope(({ handle }) => {
      if (handle.id === MAIN_AGENT_ID && handle !== this.activeHandle) {
        this.abortActive('agent_replaced');
      }
    }));
    this._register(this.agents.onDidClose((agent) => {
      if (agent.agentId === MAIN_AGENT_ID) this.abortActive('agent_closed');
    }));
  }

  private activeHandle: IAgentScopeHandle | undefined;

  async predict(input: PromptPredictionInput): Promise<string | null> {
    if (!this.flags.enabled(PROMPT_PREDICTION_FLAG_ID) || this.active !== undefined) return null;
    const scope = this.resolveScope();
    if (scope === undefined || !this.sourceTurnMatches(scope, input.expectedTurnId)) return null;
    if (this.attemptedTurnIds.has(input.expectedTurnId)) return null;
    if (!this.idle(scope.loop.snapshot(), this.activity.state())) return null;

    const contextSnapshot = scope.loop.history();
    this.attemptedTurnIds.add(input.expectedTurnId);
    const controller = new AbortController();
    const active: ActivePrediction = {
      predictionId: input.predictionId,
      expectedTurnId: input.expectedTurnId,
      controller,
      deadline: createDeadlineAbortSignal(controller.signal, PROMPT_PREDICTION_TIMEOUT_MS),
      startedAt: Date.now(),
      requested: false,
      outcome: 'error',
    };
    this.active = active;
    this.activeHandle = scope.handle;
    try {
      const plan = await abortable(scope.plan.status(), active.deadline.signal);
      if (plan !== null || !this.stillCurrent(active, scope, contextSnapshot)) {
        active.outcome = 'stale';
        return null;
      }
      active.requested = true;
      scope.telemetry.track2('prediction_requested', {
        prediction_id: active.predictionId,
        turn_id: active.expectedTurnId,
      });
      const source = {
        type: 'operation',
        turnId: active.expectedTurnId,
        requestKind: 'prompt_prediction',
      } as const;
      let trace: LLMRequestTrace | undefined;
      const requester = await scope.loop.requester.prepareOperation({
        maxOutputSize: PROMPT_PREDICTION_MAX_OUTPUT_TOKENS,
        source: () => source,
        onTrace: (value) => {
          trace = value;
        },
      }, active.deadline.signal);
      const outcome = await abortable(requester.generate(
        {
          content: {
            messages: [...contextSnapshot, createUserMessage(PROMPT_PREDICTION_INSTRUCTION)],
          },
          profile: {},
        },
        { signal: active.deadline.signal },
      ), active.deadline.signal);
      if (outcome.type === 'failed') throw outcome.error;
      if (outcome.type === 'aborted') {
        throw outcome.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      }
      active.usage = outcome.usage;
      active.requestId = outcome.requestId ?? trace?.requestId;
      active.timing = outcome.timing;
      const prediction = predictionText(outcome);
      if (prediction === null) {
        active.outcome = outcome.message.toolCalls.length > 0 ? 'tool_call' : 'invalid';
        return null;
      }
      active.predictionChars = prediction.length;
      if ((await abortable(scope.plan.status(), active.deadline.signal)) !== null) {
        active.outcome = 'stale';
        return null;
      }
      if (!this.stillCurrent(active, scope, contextSnapshot)) {
        active.outcome = 'stale';
        return null;
      }
      active.outcome = 'generated';
      return prediction;
    } catch {
      active.outcome = active.deadline.timedOut()
        ? 'timeout'
        : active.deadline.signal.aborted
          ? 'cancelled'
          : 'error';
      return null;
    } finally {
      if (active.requested) {
        if (active.outcome === 'error' && active.deadline.signal.aborted) {
          active.outcome = active.deadline.timedOut() ? 'timeout' : 'cancelled';
        }
        const inputTokens = active.usage === undefined
          ? undefined
          : active.usage.inputOther +
            (active.usage.inputCacheRead ?? 0) +
            active.usage.inputCacheCreation;
        const cacheReadPct = inputTokens === undefined || inputTokens === 0
          ? undefined
          : Math.round(((active.usage?.inputCacheRead ?? 0) / inputTokens) * 10_000) / 100;
        const properties: PredictionGeneratedEvent = {
          prediction_id: active.predictionId,
          turn_id: active.expectedTurnId,
          status: active.outcome,
          reason: active.outcome === 'cancelled'
            ? active.cancelReason ?? 'unspecified'
            : undefined,
          duration_ms: Date.now() - active.startedAt,
          prediction_chars: active.predictionChars,
          input_tokens: inputTokens,
          input_other: active.usage?.inputOther,
          output_tokens: active.usage?.output,
          input_cache_read: active.usage?.inputCacheRead,
          input_cache_creation: active.usage?.inputCacheCreation,
          cache_read_pct: cacheReadPct,
          ttft_ms: active.timing?.firstTokenLatencyMs,
          stream_duration_ms: active.timing?.streamDurationMs,
          request_build_ms: active.timing?.requestBuildMs,
          server_first_token_ms: active.timing?.serverFirstTokenMs,
          server_decode_ms: active.timing?.serverDecodeMs,
          client_consume_ms: active.timing?.clientConsumeMs,
          client_blocked_ms: active.timing?.clientBlockedMs,
          request_id: active.requestId,
        };
        this.log.info('prompt prediction finished', properties);
        scope.telemetry.track2('prediction_generated', properties);
      }
      active.deadline.clear();
      if (this.active === active) {
        this.active = undefined;
        this.activeHandle = undefined;
      }
    }
  }

  cancel(predictionId: string, reason: PromptPredictionCancelReason = 'unspecified'): boolean {
    const active = this.active;
    if (
      active === undefined ||
      active.predictionId !== predictionId ||
      active.controller.signal.aborted
    ) {
      return false;
    }
    active.outcome = 'cancelled';
    active.cancelReason = reason;
    active.controller.abort(abortError(`Prompt prediction cancelled: ${reason}`));
    return true;
  }

  override dispose(): void {
    this.abortActive('disposed');
    super.dispose();
  }

  private abortActive(reason: PromptPredictionCancelReason): void {
    const active = this.active;
    if (active === undefined || active.controller.signal.aborted) return;
    if (active.outcome !== 'generated') active.outcome = 'cancelled';
    active.cancelReason = reason;
    active.controller.abort(abortError(`Prompt prediction cancelled: ${reason}`));
  }

  private resolveScope(): PredictionScope | undefined {
    const handle = this.agents.handleOf(MAIN_AGENT_ID);
    if (handle === undefined) return undefined;
    try {
      return {
        handle,
        loop: handle.accessor.get(IAgentLoopService),
        states: handle.accessor.get(IAgentStateService),
        plan: handle.accessor.get(IAgentPlanService),
        telemetry: handle.accessor.get(ITelemetryService),
      };
    } catch {
      return undefined;
    }
  }

  private sourceTurnMatches(scope: PredictionScope, expectedTurnId: number): boolean {
    const lastEnded = scope.states.get(turnKey).lastEnded;
    return (
      lastEnded?.turnId === expectedTurnId &&
      lastEnded.reason === 'completed' &&
      this.activity.state().lastTurnReason === 'completed'
    );
  }

  private stillCurrent(
    active: ActivePrediction,
    scope: PredictionScope,
    contextSnapshot: readonly ContextMessage[],
  ): boolean {
    return (
      this.active === active &&
      this.activeHandle === scope.handle &&
      !active.deadline.signal.aborted &&
      this.flags.enabled(PROMPT_PREDICTION_FLAG_ID) &&
      this.agents.handleOf(MAIN_AGENT_ID) === scope.handle &&
      scope.loop.history() === contextSnapshot &&
      this.sourceTurnMatches(scope, active.expectedTurnId) &&
      this.idle(scope.loop.snapshot(), this.activity.state())
    );
  }

  private idle(loop: LoopSnapshot, activity: SessionActivityState): boolean {
    return (
      loop.state === 'idle' &&
      loop.activeTurnId === undefined &&
      loop.turn === undefined &&
      loop.queue.length === 0 &&
      loop.notificationCount === 0 &&
      !loop.hasPendingRequests &&
      !loop.paused &&
      !activity.busy &&
      !activity.mainTurnActive &&
      activity.pendingInteraction === 'none'
    );
  }
}

function predictionText(outcome: Extract<LlmOutcome, { type: 'done' }>): string | null {
  if (outcome.finish?.finishReason !== 'completed' || outcome.message.toolCalls.length > 0) return null;
  const parts = outcome.message.content;
  if (parts.some((part) => part.type !== 'text' && part.type !== 'think')) return null;
  const text = parts.map((part) => part.type === 'text' ? part.text : '').join('').trim();
  if (
    text.length === 0 ||
    text.length > PROMPT_PREDICTION_MAX_CHARS ||
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(text)
  ) {
    return null;
  }
  return text;
}
