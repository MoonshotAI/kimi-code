import { createHash } from 'node:crypto';

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  grandTotal,
  inputTotal,
  isContextOverflowStatusError,
  type ContentPart,
  type TokenUsage,
} from '@moonshot-ai/kosong';
import { basename } from 'pathe';

import type { Agent } from '..';
import {
  ErrorCodes,
  type KimiErrorPayload,
  isKimiError,
  makeErrorPayload,
  toKimiErrorPayload,
} from '#/errors';
import { isAbortError, isMaxStepsExceededError } from '../../loop/errors';
import {
  createLoopEventDispatcher,
  runTurn,
  type ExecutableToolResult,
  type LoopEvent,
  type LoopRecordedEvent,
  type LoopTurnInterruptedEvent,
  type LoopTurnStopReason,
} from '../../loop/index';
import type { AgentEvent, TurnEndedEvent } from '../../rpc';
import type { TelemetryPropertyValue } from '../../telemetry';
import { abortable, isUserCancellation, userCancellationReason } from '../../utils/abort';
import { USER_PROMPT_ORIGIN, type PromptOrigin } from '../context';
import { renderUserPromptHookBlockResult, renderUserPromptHookResult } from '../../session/hooks';
import { canonicalTelemetryArgs, isPlainRecord } from './canonical-args';
import { ToolCallDeduplicator } from './tool-dedup';

interface ActiveTurn {
  readonly turnId: number;
  readonly controller: AbortController;
  readonly promise: Promise<TurnEndResult>;
  readonly firstRequest: ControlledPromise<void>;
}

interface BufferedSteer {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface TurnEndResult {
  readonly event: TurnEndedEvent;
  readonly stopReason?: LoopTurnStopReason;
  readonly blockedByUserPromptHook?: boolean;
}

interface PromptHookEndResult {
  readonly event: TurnEndedEvent;
  readonly blocked: boolean;
}

const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

/** Origin tag for the synthetic "continue" prompt that drives each goal turn. */
const GOAL_CONTINUATION_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'goal_continuation' };
export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion';
export const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked';
const GOAL_RATE_LIMIT_PAUSE_REASON = 'Paused after provider rate limit';
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = 'Paused after provider connection error';
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX = 'Paused after provider authentication error';
const GOAL_PROVIDER_API_PAUSE_PREFIX = 'Paused after provider API error';
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = 'Paused after model configuration error';
const GOAL_RUNTIME_PAUSE_PREFIX = 'Paused after runtime error';

/**
 * The prompt the goal driver appends to start each continuation turn — the
 * autonomous stand-in for the user typing "continue". The model decides when to
 * stop by calling `UpdateGoal`; otherwise the driver runs another turn.
 */
const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far. Goal mode is iterative: do one coherent slice of work, then',
  'reassess. Call UpdateGoal with `complete` only when all required work is done, any stated',
  'validation has passed, and there is no useful next action. Do not mark complete after only',
  'producing a plan, summary, first pass, or partial result. If an external condition or required',
  'user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal',
  'with `blocked`. Otherwise keep going — use the existing conversation context and your tools,',
  'and do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private activeTurn: 'resuming' | ActiveTurn | null = null;
  private readonly toolCallStartedAt = new Map<string, { name: string; startedAt: number }>();
  private readonly toolCallDupType = new Map<string, 'normal' | 'cross_step'>();
  private readonly stepToolCallKeys = new Map<number, Set<string>>();
  private readonly telemetryModeByTurn = new Map<number, 'agent' | 'plan'>();
  private readonly currentStepByTurn = new Map<number, number>();
  private readonly interruptedTelemetryTurnIds = new Set<number>();
  private readonly stepFailureByTurn = new Map<number, LoopTurnInterruptedEvent>();
  private currentStep = 0;

  constructor(protected readonly agent: Agent) {}

  /** Best-effort agent id (main / generated id) derived from the agent homedir. */
  private get agentId(): string {
    return this.agent.homedir ? basename(this.agent.homedir) : this.agent.type;
  }

  // Returns the new turnId, or null if the turn was marked as resuming.
  prompt(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.prompt',
      input,
      origin,
    });
    return this.launch(input, origin);
  }

  // Returns the new turnId, or null if the input was buffered as a steer
  // message or the turn was marked as resuming.
  steer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.steer',
      input,
      origin,
    });
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return null;
    }
    return this.launch(input, origin);
  }

  retry(trigger?: string): number | null {
    return this.prompt([], { kind: 'retry', trigger });
  }

  private launch(input: readonly ContentPart[], origin: PromptOrigin): number | null {
    if (this.activeTurn) {
      this.agent.emitEvent({
        type: 'error',
        ...makeErrorPayload(
          'turn.agent_busy',
          `Cannot launch a new turn while another turn (ID ${this.turnId}) is active`,
          { details: { turnId: this.turnId } },
        ),
      });
      return null;
    }

    // Per-turn setup (telemetry, usage window, `turn.started`, appending the
    // prompt) now lives in `runOneTurn`, so a goal-driven run emits a clean
    // start/end pair per continuation turn rather than one mega-turn.
    const turnId = this.allocateTurnId();
    const controller = new AbortController();
    const promise = this.turnWorker(turnId, input, origin, controller.signal);
    const firstRequest = createControlledPromise<void>();
    this.activeTurn = {
      turnId,
      controller,
      promise,
      firstRequest,
    };

    void firstRequest.catch(() => undefined);
    void promise.then(firstRequest.reject, firstRequest.reject);

    return turnId;
  }

  /** Allocates the next monotonic turn id. */
  private allocateTurnId(): number {
    this.turnId += 1;
    return this.turnId;
  }

  restorePrompt(): void {
    if (this.activeTurn) {
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  /**
   * Raise the turn counter to cover a turnId observed in a replayed loop event.
   * This is the authoritative source of the restored counter: every turn that
   * ran — a prompted turn, a goal continuation, or a steer-launched turn —
   * emits loop events carrying its real turnId, even though only prompted turns
   * write a `turn.prompt` record. Resuming then continues from `max + 1`. Only
   * ever raises the counter, never lowers it, so the live path (where `turnId`
   * is already allocated before any loop event) is unaffected.
   */
  observeRestoredTurnId(turnId: number): void {
    if (Number.isInteger(turnId) && turnId > this.turnId) {
      this.turnId = turnId;
    }
  }

  restoreSteer(input: readonly ContentPart[], origin: PromptOrigin): void {
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  cancel(turnId?: number, reason?: unknown): void {
    this.agent.records.logRecord({ type: 'turn.cancel', turnId });
    if (turnId !== undefined && turnId !== this.currentId) {
      return; // Ignore cancel for non-active turn
    }
    // A direct cancel (RPC / replay) is the user pressing stop. When the cancel
    // is propagated from an aborting signal (e.g. a subagent's deadline via
    // waitForCurrentTurn), carry that original reason instead so a timeout is
    // not mislabeled to the model as a deliberate user interruption.
    const cancelReason = reason ?? userCancellationReason();
    this.abortTurn(cancelReason);
    this.agent.subagentHost?.cancelAll(cancelReason);
  }

  get currentId() {
    return this.turnId;
  }

  get hasActiveTurn(): boolean {
    return this.activeTurn !== null && this.activeTurn !== 'resuming';
  }

  private ensureActiveTurn(): ActiveTurn {
    if (this.activeTurn === null || this.activeTurn === 'resuming') {
      throw new Error('No active turn');
    }
    return this.activeTurn;
  }

  waitForCurrentTurn(signal?: AbortSignal | undefined): Promise<TurnEndResult> {
    const active = this.ensureActiveTurn();
    signal?.throwIfAborted();
    if (signal === undefined) return active.promise;

    const turnId = this.currentId;
    const onAbort = (): void => {
      this.agent.turn.cancel(turnId, signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    return abortable(active.promise, signal).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  waitForTurnFirstRequest(): Promise<void> {
    return this.ensureActiveTurn().firstRequest;
  }

  private abortTurn(reason: unknown) {
    if (this.activeTurn !== 'resuming') {
      // The reason (a user cancellation by default, or the originating signal's
      // reason when propagated) travels as signal.reason so tools settling on
      // this signal can report a deliberate user interruption distinctly from a
      // timeout/system abort. linkAbortSignal forwards it to linked subagents.
      this.activeTurn?.controller.abort(reason);
    }
    this.activeTurn = null;
  }

  private flushSteerBuffer(): boolean {
    const steers = this.steerBuffer;
    if (steers.length === 0) return false;
    for (const steer of steers) {
      this.agent.context.appendUserMessage(steer.input, steer.origin);
    }
    steers.length = 0;
    return true;
  }

  finishResume(): void {
    if (this.activeTurn === 'resuming') {
      this.activeTurn = null;
    }
    this.steerBuffer.length = 0;
  }

  /**
   * The body of the single in-flight `activeTurn`. Routes to the goal driver
   * (sequential continuation turns) when a goal is active, otherwise runs exactly
   * one turn. Clears `activeTurn` when the whole run finishes (identified by the
   * launch signal, so a superseding turn is never clobbered).
   */
  private async turnWorker(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const ownsActiveTurn = (): boolean =>
      this.activeTurn !== null &&
      this.activeTurn !== 'resuming' &&
      this.activeTurn.controller.signal === signal;
    try {
      const initialGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (initialGoalStatus === 'active') {
        return await this.driveGoal(firstTurnId, input, origin, signal);
      }
      const end = await this.runOneTurn(firstTurnId, input, origin, signal, true);
      const resumedFromPausedOrBlocked =
        initialGoalStatus === 'paused' || initialGoalStatus === 'blocked';
      const currentGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (
        resumedFromPausedOrBlocked &&
        currentGoalStatus === 'active' &&
        end.event.reason !== 'cancelled' &&
        end.event.reason !== 'failed'
      ) {
        return await this.driveGoal(
          this.allocateTurnId(),
          [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }],
          GOAL_CONTINUATION_ORIGIN,
          signal,
        );
      }
      return end;
    } finally {
      if (ownsActiveTurn()) {
        this.activeTurn = null;
      }
    }
  }

  /**
   * Drives an active goal as a sequence of ordinary turns — the autonomous
   * equivalent of the user repeatedly typing "continue". Each iteration runs one
   * full turn, then reads the goal status the model set via `UpdateGoal`:
   * `complete` (the record is cleared) / `blocked` / `paused` stop the loop;
   * `active` (the model didn't decide) re-injects the goal reminder and runs the
   * next continuation turn. Aborted or failed turns pause the goal. Goal-state
   * blockers, such as explicit `UpdateGoal('blocked')`, prompt-hook blocks, and
   * budget limits, block it (all resumable). Returns the final turn's result.
   */
  private async driveGoal(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    let turnId = firstTurnId;
    let turnInput = input;
    let turnOrigin = origin;
    while (true) {
      const goalBeforeTurn = this.agent.goal.getGoal().goal;
      if (goalBeforeTurn?.status === 'active' && goalBeforeTurn.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        const ended = await this.endGoalTurnWithoutModel(turnId, turnInput, turnOrigin);
        return { event: ended };
      }

      // Count the turn about to run (no-op if the goal isn't active), so the
      // completion stats include the turn in which the model reports `complete`.
      // Wall-clock is tracked live by the store (anchored while `active`), so the
      // timer is correct even when the model completes mid-turn.
      await this.agent.goal.incrementTurn();
      const end = await this.runOneTurn(turnId, turnInput, turnOrigin, signal, false);

      if (end.event.reason === 'cancelled') {
        await this.agent.goal.pauseOnInterrupt({ reason: 'Paused after interruption' });
        return end;
      }
      if (end.event.reason === 'failed') {
        await this.agent.goal.pauseActiveGoal({ reason: goalFailurePauseReason(end.event.error) });
        return end;
      }
      if (end.blockedByUserPromptHook === true) {
        await this.agent.goal.markBlocked({ reason: 'Blocked by UserPromptSubmit hook' });
        return end;
      }

      // The model decides via UpdateGoal: a cleared record means `complete`;
      // anything non-active means it stopped (blocked / paused). Only a still
      // `active` goal continues to another turn.
      const goal = this.agent.goal.getGoal().goal;
      if (goal === null || goal.status !== 'active') {
        return end;
      }
      // Hard budgets (turn / token / wall-clock, set via the SDK) are a
      // deterministic ceiling: block when reached. `blocked` is resumable.
      if (goal.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        return end;
      }

      turnId = this.allocateTurnId();
      turnInput = [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }];
      turnOrigin = GOAL_CONTINUATION_ORIGIN;
    }
  }

  private async endGoalTurnWithoutModel(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
  ): Promise<TurnEndedEvent> {
    this.agent.usage.beginTurn();
    const startedAt = Date.now();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    this.agent.context.appendUserMessage(input, origin);
    const ended: TurnEndedEvent = {
      type: 'turn.ended',
      turnId,
      reason: 'completed',
      durationMs: Date.now() - startedAt,
    };
    this.agent.usage.endTurn();
    this.agent.emitEvent(ended);
    return ended;
  }

  /**
   * Runs exactly one logical turn end to end: per-turn bookkeeping, `turn.started`,
   * the prompt + goal reminder, the step loop, and `turn.ended`. Goal-agnostic —
   * the driver layers goal semantics on top. Never throws; abnormal ends are
   * mapped to a `cancelled`/`failed` `turn.ended` and returned.
   */
  private async runOneTurn(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    standalone: boolean,
  ): Promise<TurnEndResult> {
    this.currentStep = 0;
    this.stepToolCallKeys.clear();
    this.toolCallDupType.clear();
    const telemetryMode = this.telemetryMode();
    this.telemetryModeByTurn.set(turnId, telemetryMode);
    this.currentStepByTurn.set(turnId, 0);
    this.agent.telemetry.track('turn_started', { mode: telemetryMode });
    this.agent.fullCompaction.resetForTurn();
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    this.agent.context.appendUserMessage(input, origin);

    const startedAt = Date.now();
    let ended: TurnEndedEvent;
    let blockedByUserPromptHook = false;
    let completedStopReason: LoopTurnStopReason | undefined;
    // Emitted after turn.ended (preserving prior ordering), so the error event
    // sits just past the turn.ended boundary that consumers watch for.
    let errorEvent: AgentEvent | undefined;
    try {
      const promptHookEnded = await this.applyUserPromptHook(turnId, input, origin, signal, startedAt);
      if (promptHookEnded !== undefined) {
        ended = promptHookEnded.event;
        blockedByUserPromptHook = promptHookEnded.blocked;
      } else {
        const stopReason = await this.runStepLoop(turnId, signal);
        completedStopReason = stopReason;
        ended = {
          type: 'turn.ended',
          turnId,
          reason: stopReason === 'aborted' ? 'cancelled' : 'completed',
          durationMs: Date.now() - startedAt,
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        ended = { type: 'turn.ended', turnId, reason: 'cancelled', durationMs: Date.now() - startedAt };
      } else {
        const summary = summarizeTurnError(error, turnId);
        void this.agent.hooks?.fireAndForgetTrigger('StopFailure', {
          matcherValue: summary.name,
          inputData: { errorType: summary.name, errorMessage: summary.message },
        });
        ended = { type: 'turn.ended', turnId, reason: 'failed', error: summary, durationMs: Date.now() - startedAt };
        errorEvent = { type: 'error', ...summary };
        if (this.shouldTrackApiError(turnId)) {
          const classification = classifyApiError(error, summary);
          const properties: Record<string, TelemetryPropertyValue> = {
            error_type: classification.errorType,
            model: this.agent.config.model,
            retryable: summary.retryable,
            duration_ms: Date.now() - startedAt,
          };
          if (classification.statusCode !== undefined) {
            properties['status_code'] = classification.statusCode;
          }
          const inputTokens = currentTurnInputTokens(this.agent.usage.data().currentTurn);
          if (inputTokens !== undefined) {
            properties['input_tokens'] = inputTokens;
          }
          this.agent.telemetry.track('api_error', properties);
        }
      }
    }
    // Emit the terminal turn.ended and (for a standalone turn) release the active
    // turn in the SAME synchronous frame, so the session is observably idle the
    // instant turn.ended fires. A goal drive keeps the active turn across its
    // continuation turns and releases it in `turnWorker` instead (`standalone`
    // is false for those).
    if (this.currentId === turnId) {
      this.agent.usage.endTurn();
    }
    // A user interrupt (e.g. Esc) aborts the turn without the normal Stop hook
    // firing, so external tooling that tracks status from hooks would otherwise
    // never see the turn stop. Emit an observation-only Interrupt event for it.
    // Gate on isUserCancellation: a `cancelled` turn can also come from a
    // programmatic abort (e.g. a subagent deadline timeout, which shares this
    // hook engine), and those must not be misreported as a user interrupt.
    if (ended.reason === 'cancelled' && isUserCancellation(signal.reason)) {
      void this.agent.hooks?.fireAndForgetTrigger('Interrupt', {
        inputData: { turnId, reason: 'cancelled' },
      });
    }
    this.agent.emitEvent(ended);
    if (standalone && this.currentId === turnId) {
      this.activeTurn = null;
    }
    if (this.agent.swarmMode.shouldAutoExit) {
      this.agent.swarmMode.exit();
    }
    if (errorEvent !== undefined) {
      this.agent.emitEvent(errorEvent);
    }
    if (ended.reason !== 'completed') {
      this.trackTurnInterrupted(turnId, this.currentStepByTurn.get(turnId) ?? this.currentStep);
    }
    this.telemetryModeByTurn.delete(turnId);
    this.currentStepByTurn.delete(turnId);
    this.interruptedTelemetryTurnIds.delete(turnId);
    this.stepFailureByTurn.delete(turnId);
    return { event: ended, stopReason: completedStopReason, blockedByUserPromptHook };
  }

  private async applyUserPromptHook(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<PromptHookEndResult | undefined> {
    if (origin.kind !== 'user') return undefined;
    signal.throwIfAborted();
    const promptHookResults = await this.agent.hooks?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();
    const blockResult = renderUserPromptHookBlockResult(promptHookResults);
    if (blockResult !== undefined) {
      this.agent.context.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: blockResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      });
      this.agent.emitEvent({
        type: 'hook.result',
        turnId,
        hookEvent: blockResult.event,
        content: blockResult.message,
        blocked: true,
      });
      // The terminal turn.ended is emitted by runOneTurn (synchronously with the
      // activeTurn clear), not here, so the session is idle the moment it fires.
      return {
        event: { type: 'turn.ended', turnId, reason: 'completed', durationMs: Date.now() - startedAt },
        blocked: true,
      };
    }

    const hookResult = renderUserPromptHookResult(promptHookResults);
    if (hookResult === undefined) return undefined;

    this.agent.context.appendUserMessage([{ type: 'text', text: hookResult.text }], {
      kind: 'hook_result',
      event: 'UserPromptSubmit',
    });
    this.agent.emitEvent({
      type: 'hook.result',
      turnId,
      hookEvent: hookResult.event,
      content: hookResult.message,
    });
    return undefined;
  }

  private async runStepLoop(turnId: number, signal: AbortSignal): Promise<LoopTurnStopReason> {
    let stopHookContinuationUsed = false;
    let goalOutcomeMessageContinuationUsed = false;
    const deduper = new ToolCallDeduplicator({ telemetry: this.agent.telemetry });
    await this.agent.mcp?.waitForInitialLoad(signal);
    // Surface the active goal at the start of the turn (append-only; no-op when
    // there is no active goal). Each goal continuation is its own turn, so this
    // re-injects the reminder once per turn rather than per step, preserving prompt caching.
    await this.agent.injection.injectGoal();
    while (true) {
      signal.throwIfAborted();
      const model = this.agent.config.model;
      const loopControl = this.agent.kimiConfig?.loopControl;
      let stopForGoalBudget = false;
      try {
        const result = await runTurn({
          turnId: String(turnId),
          signal,
          llm: this.agent.llm,
          buildMessages: () => this.agent.context.messages,
          dispatchEvent: this.buildDispatchEvent(turnId),
          tools: this.agent.tools.loopTools,
          log: this.agent.log,
          maxSteps: loopControl?.maxStepsPerTurn,
          maxRetryAttempts: loopControl?.maxRetriesPerStep,
          recordStepUsage: async (usage) => {
            try {
              const snapshot = await this.agent.goal.recordTokenUsage(grandTotal(usage));
              stopForGoalBudget = snapshot?.budget.overBudget === true;
            } catch (error) {
              this.agent.log.warn('goal token accounting failed', { error });
            }
          },
          hooks: {
            beforeStep: async ({ signal: stepSignal }) => {
              this.flushSteerBuffer();
              this.agent.microCompaction.detect();
              await this.agent.fullCompaction.beforeStep(stepSignal);
              await this.agent.injection.inject();
              deduper.beginStep();
              return;
            },
            afterStep: async ({ usage }) => {
              this.agent.usage.record(model, usage, 'turn');
              await this.agent.fullCompaction.afterStep();
              deduper.endStep();
              return stopForGoalBudget ? { stopTurn: true } : undefined;
            },
            // oxlint-disable-next-line no-loop-func -- stop hook continuation state is scoped to this turn.
            shouldContinueAfterStop: async (ctx) => {
              const { signal } = ctx;
              // 1. Flush any steered user messages.
              if (this.flushSteerBuffer()) return { continue: true };
              signal.throwIfAborted();

              // 2. After UpdateGoal marks a goal terminal, ask the model for one
              //    final user-facing outcome message before the turn ends.
              if (
                !goalOutcomeMessageContinuationUsed &&
                isGoalOutcomeReminderOrigin(this.agent.context.history.at(-1)?.origin)
              ) {
                goalOutcomeMessageContinuationUsed = true;
                if (!hasStepBudgetRemaining(loopControl?.maxStepsPerTurn, ctx.stepNumber)) {
                  this.agent.context.popMatchedMessage(isGoalOutcomeReminderOrigin);
                  return { continue: false };
                }
                return { continue: true };
              }

              // 3. The external Stop hook gets exactly one continuation; the cap
              //    is intentionally separate from (and does not cap) goal mode.
              if (!stopHookContinuationUsed) {
                const stopBlock = await this.agent.hooks?.triggerBlock('Stop', {
                  signal,
                  inputData: { stopHookActive: stopHookContinuationUsed },
                });
                signal.throwIfAborted();
                if (stopBlock !== undefined) {
                  stopHookContinuationUsed = true;
                  this.agent.context.appendUserMessage(
                    [{ type: 'text', text: stopBlock.reason }],
                    {
                      kind: 'system_trigger',
                      name: 'stop_hook',
                    },
                  );
                  return { continue: true };
                }
              }

              // 4. Otherwise stop. Goal continuation is no longer driven here:
              //    each goal turn is an ordinary turn, and the goal driver decides
              //    whether to run another after this one ends.
              return { continue: false };
            },
            prepareToolExecution: async (ctx) => {
              const cached = deduper.checkSameStep(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
              );
              if (cached !== null) return { syntheticResult: cached };
              return undefined;
            },
            authorizeToolExecution: async (ctx) => {
              return this.agent.permission.beforeToolCall(ctx);
            },
            finalizeToolResult: async (ctx) => {
              // Resolve dedup BEFORE firing the PostToolUse hook so same-step
              // dups (whose ctx.result is the dedup placeholder) report the
              // original's real outcome, not an empty success.
              const finalResult = await deduper.finalizeResult(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
                ctx.result,
              );
              const { isError, output } = finalResult;
              const event = isError === true ? 'PostToolUseFailure' : 'PostToolUse';
              void this.agent.hooks?.fireAndForgetTrigger(event, {
                matcherValue: ctx.toolCall.name,
                inputData: {
                  toolName: ctx.toolCall.name,
                  toolInput: toolInputRecord(ctx.args),
                  toolCallId: ctx.toolCall.id,
                  error: isError === true ? toKimiErrorPayload(toolOutputText(output)) : undefined,
                  toolOutput: isError === true ? undefined : toolOutputText(output).slice(0, 2000),
                },
              });
              return finalResult;
            },
          },
        });

        return result.stopReason;
      } catch (error) {
        if (
          error instanceof APIContextOverflowError ||
          (isKimiError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
        ) {
          await this.agent.fullCompaction.handleOverflowError(signal, error);
          continue; // Retry with compacted context
        }
        if (isMaxStepsExceededError(error)) {
          this.agent.log.warn('turn hit max steps', {
            turnId,
            steps: this.currentStepByTurn.get(turnId) ?? this.currentStep,
            limit: isKimiError(error) ? error.details?.['maxSteps'] : undefined,
          });
        } else {
          this.agent.log.error('turn failed', { turnId, error });
        }
        throw error;
      }
    }
  }

  private buildDispatchEvent(turnId: number) {
    return createLoopEventDispatcher({
      appendTranscriptRecord: async (event: LoopRecordedEvent) => {
        this.agent.context.appendLoopEvent(event);
      },
      emitLiveEvent: (event: LoopEvent) => {
        this.noteFirstRequestEvent(event);
        this.trackLoopTelemetry(event, turnId);
        const mapped = mapLoopEvent(event, turnId);
        if (mapped !== undefined) this.agent.emitEvent(mapped);
      },
    });
  }

  private noteFirstRequestEvent(event: LoopEvent): void {
    switch (event.type) {
      case 'step.end':
      case 'content.part':
      case 'tool.call':
      case 'text.delta':
      case 'thinking.delta':
      case 'tool.call.delta': {
        const active = this.activeTurn;
        if (active === null || active === 'resuming') return;
        active.firstRequest.resolve();
        return;
      }
      default:
        return;
    }
  }

  private trackLoopTelemetry(event: LoopEvent, turnId: number): void {
    if (event.type === 'step.begin') {
      this.beginTrackedStep(turnId, event.step);
      return;
    }
    if (event.type === 'turn.interrupted') {
      if (event.reason === 'error' && event.activeStep !== undefined) {
        this.stepFailureByTurn.set(turnId, event);
      }
      this.trackTurnInterrupted(turnId, interruptedStep(event));
      return;
    }
    this.trackToolLifecycle(event, turnId);
  }

  private beginTrackedStep(turnId: number, step: number): void {
    this.currentStepByTurn.set(turnId, step);
    this.currentStep = step;
    if (!this.stepToolCallKeys.has(step)) {
      this.stepToolCallKeys.set(step, new Set());
    }
  }

  private trackToolLifecycle(event: LoopEvent, turnId: number): void {
    if (event.type === 'tool.call') {
      const dupType = this.trackDuplicateToolCall(turnId, event.step, event.name, event.args);
      this.toolCallDupType.set(
        event.toolCallId,
        dupType === 'cross_step' ? 'cross_step' : 'normal',
      );
      this.toolCallStartedAt.set(event.toolCallId, {
        name: event.name,
        startedAt: Date.now(),
      });
      return;
    }
    if (event.type === 'tool.result') {
      const started = this.toolCallStartedAt.get(event.toolCallId);
      if (started === undefined) return;
      this.toolCallStartedAt.delete(event.toolCallId);
      const dupType = this.toolCallDupType.get(event.toolCallId) ?? 'normal';
      this.toolCallDupType.delete(event.toolCallId);
      const outcome = telemetryToolOutcome(event.result);
      const properties: Record<string, TelemetryPropertyValue> = {
        tool_name: started.name,
        outcome,
        duration_ms: Date.now() - started.startedAt,
        dup_type: dupType,
      };
      const errorType = outcome === 'error' ? telemetryToolErrorType(event.result) : undefined;
      if (errorType !== undefined) {
        properties['error_type'] = errorType;
      }
      this.agent.telemetry.track('tool_call', properties);
    }
  }

  private trackDuplicateToolCall(
    turnId: number,
    step: number,
    toolName: string,
    args: unknown,
  ): 'normal' | 'same_step' | 'cross_step' {
    const argsText = canonicalTelemetryArgs(args);
    const key = `${toolName}\u0000${argsText}`;
    const stepKeys = this.stepToolCallKeys.get(step) ?? new Set<string>();
    this.stepToolCallKeys.set(step, stepKeys);

    let dupType: 'same_step' | 'cross_step' | undefined;
    if (stepKeys.has(key)) {
      dupType = 'same_step';
    } else if (this.hasPriorStepToolCallKey(step, key)) {
      dupType = 'cross_step';
    }

    stepKeys.add(key);
    if (dupType === undefined) return 'normal';

    this.agent.telemetry.track('tool_call_dedup_detected', {
      turn_id: turnId,
      step_no: step,
      tool_name: toolName,
      dup_type: dupType,
      args_hash: createHash('sha256').update(argsText).digest('hex').slice(0, 8),
    });
    return dupType;
  }

  private hasPriorStepToolCallKey(step: number, key: string): boolean {
    for (const [seenStep, keys] of this.stepToolCallKeys) {
      if (seenStep !== step && keys.has(key)) return true;
    }
    return false;
  }

  private trackTurnInterrupted(turnId: number, atStep: number): void {
    if (this.interruptedTelemetryTurnIds.has(turnId)) return;
    this.interruptedTelemetryTurnIds.add(turnId);
    this.agent.telemetry.track('turn_interrupted', {
      mode: this.telemetryModeByTurn.get(turnId) ?? this.telemetryMode(),
      at_step: atStep,
    });
  }

  private telemetryMode(): 'agent' | 'plan' {
    return this.agent.planMode.isActive ? 'plan' : 'agent';
  }

  private shouldTrackApiError(turnId: number): boolean {
    const failure = this.stepFailureByTurn.get(turnId);
    return failure?.reason === 'error' && failure.activeStep !== undefined;
  }
}

function isGoalOutcomeReminderOrigin(origin: PromptOrigin | undefined): boolean {
  return (
    origin?.kind === 'system_trigger' &&
    (origin.name === GOAL_COMPLETION_REMINDER_NAME ||
      origin.name === GOAL_BLOCKED_REMINDER_NAME)
  );
}

function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
  }
}

function summarizeTurnError(error: unknown, turnId: number): KimiErrorPayload {
  const payload = toKimiErrorPayload(error);
  const details = { ...payload.details, turnId };

  // Substitute a friendlier TUI-aware message for model-not-configured.
  // The raw "Model not set" / "Provider not set" text is not actionable;
  // this string points the user at the login flow.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }

  return { ...payload, details };
}

function goalFailurePauseReason(error: KimiErrorPayload | undefined): string {
  if (error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) return GOAL_RATE_LIMIT_PAUSE_REASON;
  if (error?.code === ErrorCodes.PROVIDER_CONNECTION_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX, error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_AUTH_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_AUTH_PAUSE_PREFIX, error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_API_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_API_PAUSE_PREFIX, error.message);
  }
  if (
    error?.code === ErrorCodes.MODEL_NOT_CONFIGURED ||
    error?.code === ErrorCodes.MODEL_CONFIG_INVALID
  ) {
    return pauseReasonWithMessage(GOAL_MODEL_CONFIG_PAUSE_PREFIX, error.message);
  }
  return pauseReasonWithMessage(GOAL_RUNTIME_PAUSE_PREFIX, error?.message);
}

function pauseReasonWithMessage(prefix: string, message: string | undefined): string {
  return message === undefined || message.length === 0 ? prefix : `${prefix}: ${message}`;
}

function toolInputRecord(args: unknown): Record<string, unknown> {
  return isPlainRecord(args) ? args : {};
}

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

function interruptedStep(event: LoopTurnInterruptedEvent): number {
  return event.activeStep ?? event.attemptedSteps;
}

interface ApiErrorClassification {
  readonly errorType: string;
  readonly statusCode?: number;
}

function classifyApiError(error: unknown, summary: KimiErrorPayload): ApiErrorClassification {
  const statusCode = apiStatusCode(error) ?? summaryStatusCode(summary);
  if (statusCode !== undefined) {
    if (statusCode === 429) return { errorType: 'rate_limit', statusCode };
    if (statusCode === 401 || statusCode === 403) return { errorType: 'auth', statusCode };
    if (statusCode >= 500) return { errorType: '5xx_server', statusCode };
    if (isContextOverflowStatusError(statusCode, summary.message)) {
      return { errorType: 'context_overflow', statusCode };
    }
    if (statusCode >= 400) return { errorType: '4xx_client', statusCode };
    return { errorType: 'api', statusCode };
  }

  if (summary.code === ErrorCodes.PROVIDER_RATE_LIMIT) return { errorType: 'rate_limit' };
  if (summary.code === ErrorCodes.PROVIDER_AUTH_ERROR) return { errorType: 'auth' };
  if (summary.code === ErrorCodes.CONTEXT_OVERFLOW) return { errorType: 'context_overflow' };
  if (isApiConnectionError(error, summary)) return { errorType: 'network' };
  if (isApiTimeoutError(error, summary)) return { errorType: 'timeout' };
  if (isApiEmptyResponseError(error, summary)) return { errorType: 'empty_response' };
  return { errorType: 'other' };
}

function apiStatusCode(error: unknown): number | undefined {
  if (error instanceof APIStatusError) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    return typeof statusCode === 'number' ? statusCode : undefined;
  }
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function summaryStatusCode(summary: KimiErrorPayload): number | undefined {
  const statusCode = summary.details?.['statusCode'];
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function isApiConnectionError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIConnectionError || summary.name === 'APIConnectionError';
}

function isApiTimeoutError(error: unknown, summary: KimiErrorPayload): boolean {
  return (
    error instanceof APITimeoutError ||
    summary.name === 'APITimeoutError' ||
    summary.name === 'TimeoutError'
  );
}

function isApiEmptyResponseError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIEmptyResponseError || summary.name === 'APIEmptyResponseError';
}

function currentTurnInputTokens(usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  return inputTotal(usage);
}

type ToolTelemetryResult = Extract<LoopEvent, { type: 'tool.result' }>['result'];

function telemetryToolOutcome(result: ToolTelemetryResult): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  const text = toolResultText(result).toLowerCase();
  return text.includes('aborted') ||
    text.includes('cancelled') ||
    text.includes('manually interrupted')
    ? 'cancelled'
    : 'error';
}

function telemetryToolErrorType(result: ToolTelemetryResult): string {
  const text = toolResultText(result);
  if (text.startsWith('Tool "') && text.includes('" not found')) return 'ToolNotFound';
  if (text.startsWith('Invalid args for tool "')) return 'ToolInputError';
  if (text.includes('prepareToolExecution hook failed')) return 'HookError';
  if (text.includes('finalizeToolResult hook failed')) return 'HookError';
  if (text.includes('blocked')) return 'ToolBlocked';
  return 'ToolError';
}

function toolResultText(result: ToolTelemetryResult): string {
  return toolOutputText(result.output);
}
