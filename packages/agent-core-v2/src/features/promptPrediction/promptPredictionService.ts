import { Disposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { abortable, abortError, createDeadlineAbortSignal, type DeadlineAbortSignal } from '#/_base/utils/abort';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type LoopSnapshot } from '#/agent/loop/loop';
import type { AgentLLMRequestFinish } from '#/agent/loop/requesterContract';
import { turnKey } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IFlagService } from '#/app/flag/flag';
import type { PredictionGeneratedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPlanService } from '#/features/plan/plan';
import { createUserMessage } from '#human/llm/message';
import type { TokenUsage } from '#human/llm-requester/usage';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView, type SessionActivityState } from '#/session/sessionActivity/sessionActivity';
import { ISessionUsageService } from '#/session/usage/sessionUsage';

import {
  ISessionPromptPredictionService,
  PROMPT_PREDICTION_FLAG_ID,
  PROMPT_PREDICTION_INSTRUCTION,
  PROMPT_PREDICTION_MAX_CHARS,
  PROMPT_PREDICTION_MAX_OUTPUT_TOKENS,
  PROMPT_PREDICTION_MAX_UNCACHED_INPUT_TOKENS,
  PROMPT_PREDICTION_TIMEOUT_MS,
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
}

interface PredictionScope {
  readonly handle: IAgentScopeHandle;
  readonly loop: IAgentLoopService;
  readonly context: IAgentContextMemoryService;
  readonly states: IAgentStateService;
  readonly plan: IAgentPlanService;
  readonly tools: IAgentToolRegistryService;
}

export class SessionPromptPredictionService extends Disposable implements ISessionPromptPredictionService {
  declare readonly _serviceBrand: undefined;

  private readonly attemptedTurnIds = new Set<number>();
  private active: ActivePrediction | undefined;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionActivityView private readonly activity: ISessionActivityView,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IFlagService private readonly flags: IFlagService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(this.activity.onDidChange(() => {
      this.abortActive();
    }));
    this._register(this.agents.onWillClose((agent) => {
      if (agent.agentId === MAIN_AGENT_ID) this.abortActive();
    }));
    this._register(this.agents.onDidCreateScope(({ handle }) => {
      if (handle.id === MAIN_AGENT_ID && handle !== this.activeHandle) this.abortActive();
    }));
    this._register(this.agents.onDidClose((agent) => {
      if (agent.agentId === MAIN_AGENT_ID) this.abortActive();
    }));
  }

  private activeHandle: IAgentScopeHandle | undefined;

  async predict(input: PromptPredictionInput): Promise<string | null> {
    if (!this.flags.enabled(PROMPT_PREDICTION_FLAG_ID) || this.active !== undefined) return null;
    const scope = this.resolveScope();
    if (scope === undefined || !this.sourceTurnMatches(scope, input.expectedTurnId)) return null;
    if (this.attemptedTurnIds.has(input.expectedTurnId)) return null;
    if (!this.idle(scope.loop.snapshot(), this.activity.state())) return null;

    const contextSnapshot = scope.context.get();
    const agentContext = scope.handle.accessor.get(IAgentScopeContext).agentContext;
    const currentTurn = this.usage.status(agentContext).currentTurn;
    if (
      currentTurn === undefined ||
      currentTurn.inputOther + currentTurn.inputCacheCreation >
        PROMPT_PREDICTION_MAX_UNCACHED_INPUT_TOKENS
    ) {
      return null;
    }

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
      this.telemetry.track2('prediction_requested', {
        prediction_id: active.predictionId,
        turn_id: active.expectedTurnId,
      });
      const task = scope.loop.requester.start(
        {
          messages: [...contextSnapshot, createUserMessage(PROMPT_PREDICTION_INSTRUCTION)],
          tools: scope.tools.list().map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? {},
            deferred: tool.disclosure === 'deferred' ? true : undefined,
          })),
          maxOutputSize: PROMPT_PREDICTION_MAX_OUTPUT_TOKENS,
          source: {
            type: 'operation',
            turnId: active.expectedTurnId,
            requestKind: 'prompt_prediction',
          },
        },
        undefined,
        active.deadline.signal,
      );
      const finish = await abortable(task.result, active.deadline.signal);
      active.usage = finish.usage;
      active.requestId = finish.requestId ?? task.trace.requestId;
      const prediction = predictionText(finish);
      if (prediction === null) {
        active.outcome = finish.message.toolCalls.length > 0 ? 'tool_call' : 'invalid';
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
        const properties: PredictionGeneratedEvent = {
          prediction_id: active.predictionId,
          turn_id: active.expectedTurnId,
          status: active.outcome,
          duration_ms: Date.now() - active.startedAt,
          prediction_chars: active.predictionChars,
          input_tokens: active.usage === undefined
            ? undefined
            : active.usage.inputOther +
              (active.usage.inputCacheRead ?? 0) +
              active.usage.inputCacheCreation,
          output_tokens: active.usage?.output,
          input_cache_read: active.usage?.inputCacheRead,
          input_cache_creation: active.usage?.inputCacheCreation,
          request_id: active.requestId,
        };
        this.telemetry.track2('prediction_generated', properties);
      }
      active.deadline.clear();
      if (this.active === active) {
        this.active = undefined;
        this.activeHandle = undefined;
      }
    }
  }

  cancel(predictionId: string): boolean {
    const active = this.active;
    if (
      active === undefined ||
      active.predictionId !== predictionId ||
      active.controller.signal.aborted
    ) {
      return false;
    }
    active.outcome = 'cancelled';
    active.controller.abort(abortError('Prompt prediction cancelled'));
    return true;
  }

  override dispose(): void {
    this.abortActive();
    super.dispose();
  }

  private abortActive(): void {
    const active = this.active;
    if (active === undefined || active.controller.signal.aborted) return;
    if (active.outcome !== 'generated') active.outcome = 'cancelled';
    active.controller.abort(abortError('Prompt prediction lifecycle changed'));
  }

  private resolveScope(): PredictionScope | undefined {
    const handle = this.agents.handleOf(MAIN_AGENT_ID);
    if (handle === undefined) return undefined;
    try {
      return {
        handle,
        loop: handle.accessor.get(IAgentLoopService),
        context: handle.accessor.get(IAgentContextMemoryService),
        states: handle.accessor.get(IAgentStateService),
        plan: handle.accessor.get(IAgentPlanService),
        tools: handle.accessor.get(IAgentToolRegistryService),
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
      scope.context.get() === contextSnapshot &&
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

function predictionText(finish: AgentLLMRequestFinish): string | null {
  if (finish.providerFinishReason === 'truncated' || finish.message.toolCalls.length > 0) return null;
  const parts = finish.message.content;
  if (parts.some((part) => part.type !== 'text' && part.type !== 'think')) return null;
  const text = parts.map((part) => part.type === 'text' ? part.text : '').join('').trim();
  if (text.length === 0 || text.length > PROMPT_PREDICTION_MAX_CHARS || text.includes('\0')) return null;
  return text;
}
