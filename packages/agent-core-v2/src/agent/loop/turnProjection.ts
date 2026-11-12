import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { createControlledPromise } from '@antfu/utils';

import { abortError, isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { retryErrorFields } from '#/_base/utils/retry';
import { defineState } from '#/state/state';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { IEventBus } from '#/app/event/eventBus';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type {
  TurnEndedEvent as TurnEndedTelemetryEvent,
  TurnInterruptedEvent,
  TurnStartedEvent as TurnStartedTelemetryEvent,
} from '#/app/telemetry/events';
import type { IPluginService } from '#/app/plugin/plugin';
import type { ILogService } from '#/_base/log/log';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { abortedToolOutput } from '#/agent/toolExecutor/toolExecutorService';
import { legacyToolDurationMs } from '#/tool/executor';
import type { AgentLoopService } from './loopService';
import type { AgentPromptProjection, ActivePrompt, PendingTurn } from './promptProjection';
import type { Loop, LoopEmitted, StepStartingEvent, StepStoppingEvent, TurnTrigger } from './core/index';
import type { StepStartingDecision } from './core/contract/hook';
import { MAX_STEPS_REASON } from './core/index';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ModelRequestTiming } from '#/llm-adapter/model/generate';
import type { FinishReason } from '#human/llm-requester/finish-reason';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import { emptyUsage, type TokenUsage } from '#human/llm-requester/usage';
import type { AssistantEntry, HistoryMessage, UserEntry } from '#human/agent/turn';
import { createUserEntry } from '#human/agent/turn';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { contextFromHistoryEntry, EMPTY_LOOP_PROMPT } from './history';
import {
  AssistantDelta,
  ThinkingDelta,
  ToolCallDelta,
  turnPromptAttachments,
  turnPromptText,
  TurnStarted,
  TurnStepCompleted,
  TurnStepInterrupted,
  TurnStepRetrying,
  TurnStepStarted,
  TurnStepStreamReset,
  type TurnInterruptReason,
} from './turnEvents';
import { AgentErrorEvent } from '#/agent/mcp/mcpEvents';
import { TurnEnded, TurnPrompt } from './turnOps';
import { ErrorCodes, Error2, isError2, toKimiErrorPayload } from '#/errors';
import type {
  AfterStepContext,
  AfterStepTool,
  LoopError,
  LoopErrorContext,
  LoopErrorHandler,
  LoopRunResult,
  LoopSnapshot,
  Turn,
  TurnResult,
} from './loop';
import { createMaxStepsExceededError, isMaxStepsExceededError } from './loop';
import { isUserPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import type { LoopInterruptReason } from './loopService';

export const loopLastRequestIdKey = defineState<string | undefined>(
  'loop.lastRequestId',
  () => undefined as string | undefined,
);

const MAX_STEP_SIGNAL_LISTENERS = 64;

interface CoreStepState {
  readonly number: number;
  readonly uuid: string;
  readonly signal: AbortSignal;
  entry?: AssistantEntry;
  usage?: TokenUsage;
  timing?: ModelRequestTiming;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  messageId?: string;
  pendingToolIds: Set<string>;
  tools: AfterStepTool[];
}

interface MachineFailedStep {
  readonly number: number;
  readonly uuid: string;
  readonly error: unknown;
}

interface ActiveTurn {
  readonly id: number;
  readonly prompt: ActivePrompt;
  readonly controller: AbortController;
  steerController: AbortController;
  readonly turn: MutableTurn;
  readonly ready: ReturnType<typeof createControlledPromise<void>>;
  readonly result: ReturnType<typeof createControlledPromise<TurnResult>>;
  started?: Promise<void>;
  readonly startedAt: number;
  steps: number;
  gatedSteps: number;
  readonly steeredPromptIds: Set<string>;
  readonly stepIds: Map<number, string>;
  current: CoreStepState | undefined;
  interruptStep: number | undefined;
  failedStep: MachineFailedStep | undefined;
  forcedStopReason: string | undefined;
  lastStopReason: FinishReason | undefined;
  filtered: boolean;
  maxStepsError: LoopError | undefined;
  abortReason: unknown;
  retryRequested: boolean;
  retry: { failedAttempt: number; nextAttempt: number; maxAttempts: number; delayMs: number; errorName?: string; statusCode?: number } | undefined;
  streamPartCount: number;
  streamToolIds: Map<number | string | undefined, string>;
  readyResolved: boolean;
  mode: 'agent' | 'plan' | undefined;
  providerType: string | undefined;
  protocol: string | undefined;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

export interface TurnProjectionOptions {
  readonly dispatcher: IEventDispatcher;
  readonly events: IEventBus;
  readonly scopeContext: IAgentScopeContext;
  readonly telemetry: ITelemetryService;
  readonly plugins: IPluginService;
  readonly states: IAgentStateService;
  readonly logger: ILogService;
  readonly prompts: AgentPromptProjection;
  readonly hooks: AgentLoopService['hooks'];
  readonly errorHandlers: readonly LoopErrorHandler[];
  readonly maxSteps: () => number | undefined;
  readonly cancel: (turnId: number, reason: unknown) => boolean;
  readonly recordStreamPart: (turnId: number, step: number, block: number) => void;
}

export class AgentTurnProjection {
  private active: ActiveTurn | undefined;
  private lastResultValue: TurnResult | undefined;
  private activeRequestTrace: LLMRequestTrace | undefined;
  private turnWatch: { timer: NodeJS.Timeout; signature: string; since: number; lastWarnAt: number } | undefined;
  private readonly promptOnlyTurnIds = new Set<number>();
  private readonly publishedPromptTurns = new Set<number>();
  private readonly turnTriggers = new Map<number, TurnTrigger>();
  private readonly entryTurnIds = new WeakMap<HistoryMessage, number>();
  private readonly failedTurnIds = new Set<number>();
  private readonly toolDurations = new Map<string, number>();
  private readonly toolNotes = new Map<string, string>();
  private readonly ending = new Set<Promise<void>>();
  private historyView: { readonly source: readonly HistoryMessage[]; readonly messages: readonly ContextMessage[] } | undefined;

  constructor(private readonly options: TurnProjectionOptions) {}

  get lastResult(): TurnResult | undefined {
    return this.lastResultValue;
  }

  get requestTrace(): LLMRequestTrace | undefined {
    return this.activeRequestTrace;
  }

  set requestTrace(trace: LLMRequestTrace | undefined) {
    this.activeRequestTrace = trace;
  }

  thinkingEffort: ThinkingEffort | undefined;

  get steerSignal(): AbortSignal | undefined {
    return this.active?.steerController.signal;
  }

  abort(turnId: number, reason: unknown): void {
    const active = this.active;
    if (active?.id !== turnId || active.controller.signal.aborted) return;
    active.abortReason = reason;
    active.controller.abort(reason);
  }

  private get lastRequestId(): string | undefined {
    return this.options.states.get(loopLastRequestIdKey);
  }

  private set lastRequestId(value: string | undefined) {
    this.options.states.set(loopLastRequestIdKey, value);
  }

  history(source: readonly HistoryMessage[]): readonly ContextMessage[] {
    const previous = this.historyView;
    if (previous?.source === source) return previous.messages;
    const answered = new Map<number, Set<string>>();
    for (const entry of source) {
      const turnId = this.entryTurnIds.get(entry);
      if (turnId === undefined || !this.failedTurnIds.has(turnId) || entry.message.role !== 'tool') continue;
      const calls = answered.get(turnId) ?? new Set<string>();
      calls.add(entry.message.toolCallId);
      answered.set(turnId, calls);
    }
    const messages = source.map((entry, index) => {
      const turnId = this.entryTurnIds.get(entry);
      const failed = turnId !== undefined && this.failedTurnIds.has(turnId);
      if (!failed && previous?.source[index] === entry) return previous.messages[index]!;
      return this.contextForHistory(entry, failed, turnId === undefined ? undefined : answered.get(turnId));
    });
    this.historyView = { source, messages };
    return messages;
  }

  private contextForHistory(entry: HistoryMessage, failed = false, answered?: ReadonlySet<string>): ContextMessage {
    const message = liveContextFromHistoryEntry(entry, failed, answered);
    if (message.role !== 'tool') return message;
    let projected = message;
    const note = this.toolNotes.get(message.toolCallId);
    if (message.note === undefined && note !== undefined) {
      const content = [...message.content];
      const last = content.at(-1);
      if (last?.type === 'text' && last.text === note) content.pop();
      projected = { ...projected, content, note };
    }
    const durationMs = projected.durationMs ?? this.toolDurations.get(message.toolCallId);
    return durationMs === undefined ? projected : { ...projected, durationMs };
  }

  invalidateHistory(): void {
    this.historyView = undefined;
  }

  snapshot(loop: Loop | undefined, queue: readonly UserEntry[], notificationCount: number, paused: boolean, hasPendingRequests: boolean): LoopSnapshot {
    const active = this.active;
    const current = active?.current;
    const retry = active?.retry;
    return {
      state: loop?.state.turn === undefined && active === undefined ? 'idle' : 'running',
      activeTurnId: loop?.state.turn?.id ?? active?.id,
      activePromptId: this.options.prompts.activePrompt()?.id,
      queue,
      notificationCount,
      paused,
      hasPendingRequests,
      turn: active === undefined
        ? undefined
        : {
            turnId: active.id,
            phase: retry !== undefined ? 'retrying' : (current?.pendingToolIds.size ?? 0) > 0 ? 'tool_call' : 'running',
            step: active.gatedSteps,
            ending: active.controller.signal.aborted,
            endingReason: active.controller.signal.aborted ? 'aborted' : undefined,
            retry,
            activeToolCalls: (loop?.state.calls ?? []).map((call) => ({ toolCallId: call.toolCall.id, name: call.toolCall.name })),
            since: active.startedAt,
          },
      activeRequestId: this.activeRequestTrace?.requestId,
    };
  }

  recordOutcome(outcome: { readonly timing?: ModelRequestTiming }, source: { readonly type: string; readonly turnId?: number; readonly step?: number }): void {
    if (source.type !== 'turn') return;
    const active = this.active;
    const step = active?.current;
    if (active?.id !== source.turnId || step === undefined || step.number !== source.step) return;
    step.timing = outcome.timing;
  }

  stepStarting(event: StepStartingEvent): StepStartingDecision | Promise<StepStartingDecision | undefined> | undefined {
    const turn = this.active;
    if (turn === undefined) return undefined;
    if (turn.steerController.signal.aborted) turn.steerController = new AbortController();
    turn.gatedSteps = event.step;
    if (!this.promptOnlyTurnIds.has(turn.id)) turn.steps = Math.max(turn.steps, event.step);
    turn.retry = undefined;
    this.activeRequestTrace = undefined;
    this.options.telemetry.setContext({ request_id: undefined });
    const step = turn.current ?? createStepState(event.step, turn.controller.signal);
    turn.current = step;
    turn.stepIds.set(step.number, step.uuid);
    turn.interruptStep = event.step;
    EventEmitter.setMaxListeners(MAX_STEP_SIGNAL_LISTENERS, turn.controller.signal);
    return this.runStepStarting(turn, step, event);
  }

  private async runStepStarting(turn: ActiveTurn, step: CoreStepState, event: StepStartingEvent) {
    try {
      await this.options.hooks.onWillBeginStep.run({
        turnId: turn.id,
        step: event.step,
        firstStepOfTurn: event.step === 1,
        signal: step.signal,
      });
    } catch (error) {
      if (isAbortError(error) || step.signal.aborted) {
        turn.abortReason = turn.controller.signal.aborted ? turn.controller.signal.reason : error;
      } else {
        turn.failedStep = { number: step.number, uuid: step.uuid, error };
      }
      return { blocked: { by: 'step', reason: 'step_hook_failed', message: toErrorMessage(error) } };
    }
    if (step.signal.aborted) {
      turn.abortReason = step.signal.reason ?? abortError('Step aborted');
      return { blocked: { by: 'step', reason: 'aborted' } };
    }
    return undefined;
  }

  async stepStopping(event: StepStoppingEvent) {
    const turn = this.active;
    if (turn === undefined) return undefined;
    const step = turn.current;
    if (step === undefined) return undefined;
    if (event.draft.type !== 'failed') {
      const finishReason = step.providerFinishReason ?? 'completed';
      const context: AfterStepContext = {
        turnId: turn.id,
        step: step.number,
        firstStepOfTurn: step.number === 1,
        signal: step.signal,
        usage: step.usage ?? emptyUsage(),
        finishReason,
        tools: step.tools,
        stopTurn: step.tools.some((tool) => tool.result?.stopTurn === true),
        stopReason: step.tools.find((tool) => tool.result?.stopTurnReason !== undefined)?.result?.stopTurnReason,
      };
      try {
        await this.options.hooks.onDidFinishStep.run(context);
      } catch (error) {
        if (isAbortError(error) || step.signal.aborted) {
          turn.abortReason = turn.controller.signal.aborted ? turn.controller.signal.reason : error;
        } else {
          turn.failedStep = { number: step.number, uuid: step.uuid, error };
        }
      }
      turn.interruptStep = undefined;
      if (turn.failedStep !== undefined || turn.abortReason !== undefined) {
        return { type: 'done' as const, cause: { by: 'afterStep', reason: 'step_hook_failed' } };
      }
      if (context.stopTurn) {
        turn.forcedStopReason = context.stopReason;
        return { type: 'done' as const, cause: { by: 'afterStep', reason: 'stop_turn' } };
      }
      if (finishReason === 'filtered') turn.filtered = true;
      return undefined;
    }
    const failure = turn.failedStep ?? { number: step.number, uuid: step.uuid, error: event.draft.error };
    turn.failedStep = undefined;
    if (turn.controller.signal.aborted || isAbortError(failure.error)) {
      turn.abortReason = turn.controller.signal.aborted ? turn.controller.signal.reason : failure.error;
      return undefined;
    }
    const context: LoopErrorContext = {
      turnId: turn.id,
      step: failure.number,
      stepId: failure.uuid,
      signal: turn.controller.signal,
      error: failure.error,
      retry: () => {
        turn.retryRequested = true;
      },
    };
    const handler = this.options.errorHandlers.find((entry) => entry.match(context));
    if (handler !== undefined) {
      try {
        if (await handler.handle(context)) {
          turn.interruptStep = undefined;
          if (turn.retryRequested) {
            turn.retryRequested = false;
            return { type: 'continue' as const, cause: { by: handler.id, reason: 'retry' } };
          }
          return undefined;
        }
      } catch (handlerError) {
        if (isAbortError(handlerError) || turn.controller.signal.aborted) {
          turn.abortReason = turn.controller.signal.aborted ? turn.controller.signal.reason : handlerError;
        } else {
          turn.failedStep = { number: failure.number, uuid: failure.uuid, error: handlerError };
        }
        return undefined;
      }
    }
    turn.failedStep = failure;
    return undefined;
  }

  enrich(event: LoopEmitted, toolExecutor: IAgentToolExecutorService): LoopEmitted {
    switch (event.type) {
      case 'prompt.notified': {
        const promptId = event.entry.meta?.promptId;
        if (this.active === undefined || promptId === undefined) return event;
        return { type: 'prompt.steered', promptIds: [promptId], entries: [event.entry] };
      }
      case 'turn.started': {
        const pending = this.options.prompts.pending(event.turnId);
        if (pending === undefined) return event;
        return { ...event, entry: { ...pending.entry, message: pending.message } };
      }
      case 'tool.started': {
        const handler = event.taskId === undefined ? undefined : toolExecutor.handler(event.taskId);
        const prepared = handler?.snapshot().prepared;
        return { ...event, display: prepared?.kind === 'execute' ? prepared.display : undefined };
      }
      case 'tool.ended': {
        const handler = event.taskId === undefined ? undefined : toolExecutor.handler(event.taskId);
        const snapshot = handler?.snapshot();
        const prepared = snapshot?.prepared;
        const result = prepared?.kind === 'execute' || prepared?.kind === 'synthetic' ? prepared.result : undefined;
        const stop = result as { stopTurn?: boolean; stopTurnReason?: string } | undefined;
        const entry = event.outcome.entry;
        const toolName = this.active?.current?.entry?.message.toolCalls.find((call) => call.id === event.toolCallId)?.name ?? event.toolCallId;
        return {
          ...event,
          result: {
            output: event.outcome.type === 'aborted' ? abortedToolOutput(toolName, event.outcome.reason) : result?.output ?? entry.message.content,
            isError: event.outcome.type === 'succeeded' ? result?.isError : true,
            note: result?.note,
            durationMs: event.detached || snapshot === undefined ? undefined : legacyToolDurationMs(snapshot),
            stopTurn: stop?.stopTurn,
            stopTurnReason: stop?.stopTurnReason,
          },
        };
      }
      case 'step.ended':
        return { ...event, timing: this.active?.current?.timing };
      case 'turn.ended': {
        const active = this.active;
        const promptOnly = this.promptOnlyTurnIds.has(event.turnId);
        return {
          ...event,
          durationMs: promptOnly ? 0 : active === undefined ? undefined : Date.now() - active.startedAt,
          stopReason: promptOnly ? 'prompt_only' : active?.forcedStopReason ?? active?.lastStopReason ?? undefined,
          requestId: promptOnly || event.outcome.type === 'aborted'
            ? undefined
            : event.outcome.type === 'done' ? this.lastRequestId : this.activeRequestTrace?.requestId,
        };
      }
      default:
        return event;
    }
  }

  project(event: LoopEmitted, loop: Loop): void {
    if (event.type === 'turn.started') this.turnTriggers.set(event.turnId, event.trigger);
    if (event.type === 'turn.started' && event.promptOnly === true) this.promptOnlyTurnIds.add(event.turnId);
    if (event.type === 'message.appended') this.entryTurnIds.set(event.entry, event.turnId);
    if (event.type === 'turn.ended' && event.outcome.type === 'failed') {
      this.failedTurnIds.add(event.turnId);
      this.historyView = undefined;
    }
    const ending = this.projectNow(event, loop);
    if (ending !== undefined) {
      this.ending.add(ending);
      void ending.finally(() => this.ending.delete(ending));
    }
    if (event.type === 'turn.ended') {
      this.promptOnlyTurnIds.delete(event.turnId);
      this.turnTriggers.delete(event.turnId);
    }
  }

  private projectNow(event: LoopEmitted, loop: Loop): Promise<void> | void {
    switch (event.type) {
      case 'turn.started': {
        if (event.promptOnly === true) {
          this.publishTurnPrompt(event.turnId, event.trigger, event.entry);
          const pending = this.options.prompts.activatePromptOnly(event);
          if (pending !== undefined) this.activate(pending, event.turnId);
        }
        return;
      }
      case 'turn.resumed': {
        if (this.active !== undefined) return;
        const entry = loop.state.messages.findLast((item): item is UserEntry => item.message.role === 'user') ?? createUserEntry(EMPTY_LOOP_PROMPT);
        const waiter = this.options.prompts.ensure(entry, false);
        this.activate({ entry, waiter, trigger: 'continue', message: entry.message }, event.turnId);
        return;
      }
      case 'step.started': {
        if (this.active === undefined) {
          const trigger = this.turnTriggers.get(event.turnId) ?? 'continue';
          const pending = this.options.prompts.activatePending(event.turnId);
          const entry = pending?.entry ?? this.options.prompts.entryForTurn(event.turnId);
          this.publishTurnPrompt(event.turnId, trigger, entry);
          if (entry !== undefined) {
            const waiter = pending?.waiter ?? this.options.prompts.ensure(entry, false);
            this.activate({ entry, waiter, trigger, message: pending?.message ?? entry.message }, event.turnId);
          } else if (trigger === 'continue') {
            const previous = loop.state.messages.findLast((item): item is UserEntry => item.message.role === 'user') ?? createUserEntry(EMPTY_LOOP_PROMPT);
            const waiter = this.options.prompts.ensure(previous, false);
            this.activate({ entry: previous, waiter, trigger, message: previous.message }, event.turnId);
          }
        }
        const turn = this.active;
        if (turn === undefined) return;
        const step = createStepState(event.step, turn.controller.signal);
        turn.current = step;
        turn.stepIds.set(step.number, step.uuid);
        turn.streamPartCount = 0;
        if (!turn.readyResolved) {
          turn.readyResolved = true;
          turn.ready.resolve();
        }
        void this.options.dispatcher.dispatch(new TurnStepStarted({
          agentId: this.options.scopeContext.agentId,
          turnId: turn.id,
          step: step.number,
          stepId: step.uuid,
        }));
        return;
      }
      case 'llm.sent': {
        const turn = this.active;
        if (turn === undefined || turn.retry === undefined) return;
        const step = turn.current?.number ?? turn.gatedSteps;
        turn.retry = undefined;
        void this.options.dispatcher.dispatch(new TurnStepStarted({
          agentId: this.options.scopeContext.agentId,
          turnId: turn.id,
          step,
          stepId: turn.current?.uuid ?? turn.stepIds.get(step),
        }));
        return;
      }
      case 'llm.streaming.part': {
        const turn = this.active;
        if (turn === undefined) return;
        const part = event.part;
        const step = turn.current;
        if (event.block !== undefined && step !== undefined) this.options.recordStreamPart(turn.id, step.number, event.block);
        turn.streamPartCount += 1;
        switch (part.type) {
          case 'text':
            void this.options.dispatcher.dispatch(new AssistantDelta({ agentId: this.options.scopeContext.agentId, turnId: turn.id, delta: part.text, block: event.block }));
            return;
          case 'think': {
            if (part.hidden === true) return;
            void this.options.dispatcher.dispatch(new ThinkingDelta({ agentId: this.options.scopeContext.agentId, turnId: turn.id, delta: part.think, block: event.block }));
            return;
          }
          case 'function':
            turn.streamToolIds.set(part._streamIndex, part.id);
            void this.options.dispatcher.dispatch(new ToolCallDelta({
              agentId: this.options.scopeContext.agentId,
              turnId: turn.id,
              toolCallId: part.id,
              name: part.name,
              argumentsPart: part.arguments ?? undefined,
            }));
            return;
          case 'tool_call_part': {
            const toolCallId = turn.streamToolIds.get(part.index);
            if (toolCallId === undefined) return;
            void this.options.dispatcher.dispatch(new ToolCallDelta({
              agentId: this.options.scopeContext.agentId,
              turnId: turn.id,
              toolCallId,
              argumentsPart: part.argumentsPart ?? undefined,
            }));
            return;
          }
          default:
            return;
        }
      }
      case 'llm.streaming.usage': {
        const step = this.active?.current;
        if (step !== undefined) step.usage = mergeUsage(step.usage, event.usage);
        return;
      }
      case 'llm.streaming.finish': {
        const step = this.active?.current;
        if (step !== undefined) {
          step.providerFinishReason = event.finish.finishReason ?? undefined;
          step.rawFinishReason = event.finish.rawFinishReason ?? undefined;
        }
        return;
      }
      case 'llm.streaming.message_id': {
        const step = this.active?.current;
        if (step !== undefined) step.messageId = event.messageId;
        return;
      }
      case 'llm.retrying': {
        const turn = this.active;
        if (turn === undefined) return;
        const step = turn.current;
        if (event.reason === 'recovery') {
          turn.current = undefined;
          return;
        }
        const fields = retryErrorFields(event.error);
        turn.retry = {
          failedAttempt: event.failedAttempt,
          nextAttempt: event.nextAttempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorName: fields.errorName,
          statusCode: fields.statusCode,
        };
        if (step !== undefined) {
          void this.options.dispatcher.dispatch(new TurnStepStreamReset({
            agentId: this.options.scopeContext.agentId,
            turnId: turn.id,
            step: step.number,
            stepId: step.uuid,
          }));
        }
        void this.options.dispatcher.dispatch(new TurnStepRetrying({
          agentId: this.options.scopeContext.agentId,
          turnId: turn.id,
          step: step?.number ?? turn.gatedSteps,
          stepId: step?.uuid,
          failedAttempt: event.failedAttempt,
          nextAttempt: event.nextAttempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorName: fields.errorName,
          errorMessage: fields.errorMessage,
          statusCode: fields.statusCode,
        }));
        turn.current = undefined;
        return;
      }
      case 'message.appended': {
        const history = loop.state.messages;
        const appended = history.at(-1);
        if (appended !== undefined) {
          void this.options.dispatcher.dispatch(new ContextSpliced({
            agentId: this.options.scopeContext.agentId,
            start: history.length - 1,
            deleteCount: 0,
            messages: [contextFromHistoryEntry(appended)],
          }));
        }
        this.options.prompts.appended(event);
        if (this.active !== undefined) this.options.prompts.materialized(this.active.turn);
        if (event.source !== 'llm') return;
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        step.entry = event.entry as AssistantEntry;
        const meta = step.entry.meta;
        step.usage = meta?.usage ?? step.usage;
        step.providerFinishReason = meta?.finish?.finishReason ?? step.providerFinishReason;
        step.rawFinishReason = meta?.finish?.rawFinishReason ?? step.rawFinishReason;
        step.messageId = meta?.messageId ?? step.messageId;
        this.lastRequestId = this.activeRequestTrace?.requestId;
        const toolCalls = step.entry.message.toolCalls;
        if (toolCalls.length === 0 && meta?.partial !== true) this.endOrInterruptStep(turn, step, step.providerFinishReason ?? 'completed');
        else if (toolCalls.length > 0) step.pendingToolIds = new Set(toolCalls.map((call) => call.id));
        return;
      }
      case 'tool.ended': {
        if (event.result?.durationMs !== undefined) this.toolDurations.set(event.toolCallId, event.result.durationMs);
        if (event.result?.note !== undefined) this.toolNotes.set(event.toolCallId, event.result.note);
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        step.pendingToolIds.delete(event.toolCallId);
        const toolCall = step.entry?.message.toolCalls.find((call) => call.id === event.toolCallId);
        if (toolCall !== undefined) step.tools.push({ toolCall, outcome: event.outcome, result: event.result });
        if (step.pendingToolIds.size === 0) this.endOrInterruptStep(turn, step, 'tool_calls');
        return;
      }
      case 'tool.async_ended':
        return;
      case 'step.ended': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined) return;
        const outcome = event.outcome;
        if (outcome.type === 'done' && outcome.cause?.reason === 'steered') {
          this.emitStepInterrupted(turn.id, event.step, 'steered', undefined, turn.stepIds.get(event.step));
          turn.interruptStep = undefined;
          turn.current = undefined;
          return;
        }
        if (outcome.type === 'blocked' && outcome.cause.reason === MAX_STEPS_REASON) {
          turn.maxStepsError = createMaxStepsExceededError(this.options.maxSteps() ?? 0);
        }
        if (outcome.type === 'failed') turn.failedStep ??= { number: event.step, uuid: step?.uuid ?? randomUUID(), error: outcome.error };
        if (step !== undefined && turn.current !== undefined) turn.current = undefined;
        return;
      }
      case 'turn.ended': {
        const outcome = event.outcome;
        if (outcome.type === 'blocked' && this.active === undefined) {
          this.options.prompts.gateRejected(event.turnId, outcome.cause.reason === 'blocked' ? 'blocked' : 'failed');
          if (outcome.cause.reason !== 'blocked') this.options.logger.warn('prompt gate failed', { error: outcome.cause });
          return;
        }
        const turn = this.active;
        if (turn === undefined) return;
        return this.finishTurn(turn, outcome);
      }
      case 'prompt.notified':
      case 'prompt.steered': {
        if (this.options.prompts.projectSteered(event)) this.active?.steerController.abort(abortError('Steered by new input'));
        return;
      }
      default:
        return;
    }
  }

  private activate(pending: PendingTurn, turnId: number): void {
    if (this.active !== undefined || pending.waiter === undefined) return;
    const prompt = this.options.prompts.begin(pending.waiter, { ...pending.entry, message: pending.message });
    const controller = new AbortController();
    const ready = createControlledPromise<void>();
    const result = createControlledPromise<TurnResult>();
    void ready.catch(() => undefined);
    const turn: MutableTurn = {
      id: turnId,
      state: 'queued',
      signal: controller.signal,
      ready,
      result,
      cancel: (reason) => this.active?.id === turnId
        ? this.options.cancel(turnId, reason ?? userCancellationReason())
        : true,
    };
    const active: ActiveTurn = {
      id: turnId,
      prompt,
      controller,
      steerController: new AbortController(),
      turn,
      ready,
      result,
      startedAt: Date.now(),
      steps: 0,
      gatedSteps: 0,
      steeredPromptIds: new Set(),
      stepIds: new Map(),
      current: undefined,
      interruptStep: undefined,
      failedStep: undefined,
      forcedStopReason: undefined,
      lastStopReason: undefined,
      filtered: false,
      maxStepsError: undefined,
      abortReason: undefined,
      retryRequested: false,
      retry: undefined,
      streamPartCount: 0,
      streamToolIds: new Map(),
      readyResolved: false,
      mode: undefined,
      providerType: undefined,
      protocol: undefined,
    };
    this.active = active;
    this.armTurnWatch(active);
    active.readyResolved = true;
    ready.resolve();
    active.mode = this.options.telemetry.getContext().mode;
    const { provider_type, protocol } = this.options.telemetry.getContext();
    active.providerType = provider_type;
    active.protocol = protocol;
    this.options.telemetry.setContext({ turn_id: turnId });
    this.options.telemetry.setContext({ thinking_effort: this.thinkingEffort });
    turn.state = 'running';
    active.started = this.options.dispatcher.dispatch(new TurnStarted({
      agentId: this.options.scopeContext.agentId,
      turnId,
      promptId: prompt.promptId,
      origin: prompt.origin,
      prompt: turnPromptText(prompt.message.content.filter((part) => !isUserPromptSubmitHookPart(part)), prompt.origin),
      promptAttachments: turnPromptAttachments(prompt.message.content, prompt.origin),
    }));
    const started: TurnStartedTelemetryEvent = {
      turn_id: turnId,
      mode: active.mode ?? 'agent',
      provider_type,
      protocol,
      enabled_plugins: this.options.plugins.enabledPluginIds()?.join(','),
    };
    this.options.telemetry.track2('turn_started', started);
    this.options.prompts.launched(pending.waiter, turn);
    this.options.prompts.materialized(turn);
  }

  private publishTurnPrompt(turnId: number, trigger: TurnTrigger, entry: UserEntry | undefined): void {
    if (this.publishedPromptTurns.has(turnId)) return;
    this.publishedPromptTurns.add(turnId);
    const origin = (entry?.meta?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
    this.options.events.publish(new TurnPrompt({
      agentId: this.options.scopeContext.agentId,
      input: entry?.message.content ?? [],
      origin,
      promptId: entry?.meta?.promptId,
      turnId,
      trigger: trigger === 'notify' || trigger === 'continue' ? trigger : 'normal',
    }));
  }

  private endOrInterruptStep(turn: ActiveTurn, step: CoreStepState, finishReason: FinishReason): void {
    if (turn.controller.signal.aborted) {
      turn.current = undefined;
      return;
    }
    const normalized = finishReason === 'tool_calls' && step.entry?.message.toolCalls.length === 0 ? 'other' : normalizeFinishReason(finishReason);
    const usage = step.usage ?? emptyUsage();
    turn.lastStopReason = finishReason;
    turn.current = step;
    void this.options.dispatcher.dispatch(new TurnStepCompleted({
      agentId: this.options.scopeContext.agentId,
      turnId: turn.id,
      step: step.number,
      stepId: step.uuid,
      usage,
      finishReason: normalized,
      llmFirstTokenLatencyMs: step.timing?.firstTokenLatencyMs,
      llmStreamDurationMs: step.timing?.streamDurationMs,
      llmRequestBuildMs: step.timing?.requestBuildMs,
      llmServerFirstTokenMs: step.timing?.serverFirstTokenMs,
      llmServerDecodeMs: step.timing?.serverDecodeMs,
      llmClientConsumeMs: step.timing?.clientConsumeMs,
      llmClientBlockedMs: step.timing?.clientBlockedMs,
      providerFinishReason: step.providerFinishReason,
      rawFinishReason: step.rawFinishReason,
    }));
  }

  private async finishTurn(turn: ActiveTurn, outcome: Extract<LoopEmitted, { type: 'turn.ended' }>['outcome']): Promise<void> {
    if (this.active !== turn) return;
    if (turn.abortReason !== undefined || turn.controller.signal.aborted || outcome.type === 'aborted') {
      const reason = turn.abortReason ?? (turn.controller.signal.aborted ? turn.controller.signal.reason : undefined) ?? abortError('Turn aborted');
      this.interruptRunForCancel(turn, reason);
      await this.endTurn(turn, { type: 'cancelled', steps: turn.steps, reason });
      return;
    }
    if (turn.filtered) {
      await this.endTurn(turn, {
        type: 'failed',
        steps: turn.steps,
        error: new Error2(ErrorCodes.PROVIDER_FILTERED, 'Provider safety policy blocked the response.', {
          name: 'ProviderFilteredError',
          details: { finishReason: 'filtered' },
        }),
      });
      return;
    }
    if (turn.maxStepsError !== undefined || (outcome.type !== 'failed' && outcome.cause?.reason === MAX_STEPS_REASON)) {
      const error = turn.maxStepsError ?? createMaxStepsExceededError(this.options.maxSteps() ?? 0);
      this.failStep(turn.id, turn.interruptStep, error);
      await this.endTurn(turn, { type: 'failed', steps: turn.steps, error });
      return;
    }
    if (outcome.type === 'failed' || turn.failedStep !== undefined) {
      const error = turn.failedStep?.error ?? (outcome.type === 'failed' ? outcome.error : undefined) ?? new Error('Turn failed');
      this.failStep(turn.id, turn.interruptStep, error);
      await this.endTurn(turn, { type: 'failed', steps: turn.steps, error });
      return;
    }
    if (outcome.type === 'blocked') {
      const error = new Error2(ErrorCodes.INTERNAL, outcome.cause.message ?? outcome.cause.reason);
      this.failStep(turn.id, turn.interruptStep, error);
      await this.endTurn(turn, { type: 'failed', steps: turn.steps, error });
      return;
    }
    const result: LoopRunResult = {
      type: 'completed',
      steps: turn.steps,
      truncated: turn.lastStopReason === 'truncated',
      stopReason: this.promptOnlyTurnIds.has(turn.id) ? 'prompt_only' : turn.forcedStopReason,
    };
    await this.endTurn(turn, result, this.promptOnlyTurnIds.has(turn.id));
  }

  private failStep(turnId: number, step: number | undefined, error: unknown): void {
    const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
    const interruptedError = isError2(error) && error.code === ErrorCodes.INTERNAL && error.cause !== undefined ? error.cause : error;
    this.emitStepInterrupted(turnId, step, reason, toErrorMessage(interruptedError));
  }

  private interruptRunForCancel(turn: ActiveTurn, reason: unknown): void {
    const current = turn.current;
    if (current !== undefined) turn.current = undefined;
    if (turn.interruptStep !== undefined) {
      this.emitStepInterrupted(turn.id, turn.interruptStep, 'aborted', isUserCancellation(reason) ? undefined : toErrorMessage(reason));
      turn.interruptStep = undefined;
    }
  }

  private async endTurn(turn: ActiveTurn, result: TurnResult, promptOnly = false): Promise<void> {
    if (this.active !== turn) return;
    this.lastResultValue = result;
    this.active = undefined;
    this.options.prompts.endActive(turn.prompt);
    this.disarmTurnWatch();
    turn.turn.state = result.type;
    if (!turn.readyResolved) {
      if (result.type === 'failed') turn.ready.reject(result.error);
      else if (result.type === 'cancelled') turn.ready.reject(result.reason instanceof Error ? result.reason : abortError('Turn cancelled'));
      else turn.ready.reject(new Error2(ErrorCodes.INTERNAL, 'Turn ended before first step'));
    }
    const durationMs = promptOnly ? 0 : Date.now() - turn.startedAt;
    const requestId = promptOnly || result.type === 'cancelled' ? undefined : result.type === 'completed' ? this.lastRequestId : this.activeRequestTrace?.requestId;
    const error = result.type === 'failed' ? toKimiErrorPayload(result.error) : undefined;
    const interruptReason = result.type === 'completed' ? undefined : interruptReasonFor(result);
    const turnEnded = this.options.dispatcher.dispatch(new TurnEnded({
      agentId: this.options.scopeContext.agentId,
      turnId: turn.id,
      reason: result.type,
      error,
      durationMs,
      interruptReason,
      stopReason: result.type === 'completed' ? result.stopReason : undefined,
      requestId,
    }));
    if (error !== undefined) void this.options.dispatcher.dispatch(new AgentErrorEvent({ ...error, agentId: this.options.scopeContext.agentId }));
    if (interruptReason !== undefined) {
      const interrupted: TurnInterruptedEvent = {
        turn_id: turn.id,
        at_step: result.steps,
        mode: turn.mode ?? 'agent',
        interrupt_reason: interruptReason,
        provider_type: turn.providerType,
        protocol: turn.protocol,
        request_id: requestId,
      };
      this.options.telemetry.track2('turn_interrupted', interrupted);
    }
    const ended: TurnEndedTelemetryEvent = {
      turn_id: turn.id,
      reason: result.type,
      duration_ms: durationMs,
      mode: turn.mode ?? 'agent',
      error_type: error?.code,
      provider_type: turn.providerType,
      protocol: turn.protocol,
      request_id: requestId,
      enabled_plugins: this.options.plugins.enabledPluginIds()?.join(','),
    };
    this.options.telemetry.track2('turn_ended', ended);
    this.options.telemetry.setContext({ turn_id: undefined, request_id: undefined, thinking_effort: undefined });
    this.activeRequestTrace = undefined;
    this.lastRequestId = undefined;
    await turnEnded;
    await this.options.dispatcher.flush();
    await turn.started;
    turn.result.resolve(result);
  }

  private emitStepInterrupted(turnId: number, activeStep: number | undefined, reason: LoopInterruptReason, message?: string, stepId?: string): void {
    if (activeStep === undefined) return;
    void this.options.dispatcher.dispatch(new TurnStepInterrupted({
      agentId: this.options.scopeContext.agentId,
      turnId,
      step: activeStep,
      stepId,
      reason,
      message,
    }));
  }

  private armTurnWatch(active: ActiveTurn): void {
    this.disarmTurnWatch();
    const signatureOf = (): string => [
      active.gatedSteps,
      active.steps,
      active.streamPartCount,
      active.current?.pendingToolIds.size ?? 0,
      active.retry?.nextAttempt ?? 0,
    ].join(':');
    const watch = { timer: undefined as unknown as NodeJS.Timeout, signature: signatureOf(), since: Date.now(), lastWarnAt: 0 };
    watch.timer = setInterval(() => {
      if (this.active !== active) {
        this.disarmTurnWatch();
        return;
      }
      const signature = signatureOf();
      if (signature !== watch.signature) {
        watch.signature = signature;
        watch.since = Date.now();
        return;
      }
      const silentMs = Date.now() - watch.since;
      if (silentMs < 10 * 60_000 || Date.now() - watch.lastWarnAt < 10 * 60_000) return;
      watch.lastWarnAt = Date.now();
      this.options.logger.warn('turn watchdog: no new events from the running turn', {
        agentId: this.options.scopeContext.agentId,
        turnId: active.id,
        silentMinutes: Math.round(silentMs / 60_000),
        steps: active.steps,
      });
    }, 60_000);
    watch.timer.unref();
    this.turnWatch = watch;
  }

  private disarmTurnWatch(): void {
    if (this.turnWatch === undefined) return;
    clearInterval(this.turnWatch.timer);
    this.turnWatch = undefined;
  }

  async drain(): Promise<void> {
    await Promise.all(this.ending);
  }

  close(reason: unknown): void {
    const active = this.active;
    active?.controller.abort(reason);
    active?.steerController.abort(reason);
    this.disarmTurnWatch();
  }
}

function createStepState(number: number, signal: AbortSignal): CoreStepState {
  return { number, uuid: randomUUID(), signal, pendingToolIds: new Set(), tools: [] };
}

function mergeUsage(base: TokenUsage | undefined, patch: Partial<TokenUsage>): TokenUsage {
  return {
    inputOther: patch.inputOther ?? base?.inputOther ?? 0,
    output: patch.output ?? base?.output ?? 0,
    inputCacheRead: patch.inputCacheRead ?? base?.inputCacheRead,
    inputCacheCreation: patch.inputCacheCreation ?? base?.inputCacheCreation ?? 0,
  };
}

function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

function liveContextFromHistoryEntry(entry: HistoryMessage, failed = false, answered?: ReadonlySet<string>): ContextMessage {
  const message = contextFromHistoryEntry(entry);
  if (!failed || message.role !== 'assistant' || message.toolCalls.length === 0) return message;
  return { ...message, toolCalls: message.toolCalls.filter((call) => answered?.has(call.id) === true) };
}

function interruptReasonFor(result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>): TurnInterruptReason {
  if (result.type === 'cancelled') return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) return 'filtered';
  return 'error';
}
