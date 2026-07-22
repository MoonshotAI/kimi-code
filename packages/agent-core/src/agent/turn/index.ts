import { createHash } from 'node:crypto';

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  inputTotal,
  isContextOverflowStatusError,
  type ContentPart,
  type Message,
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
  type LLMRequestTrace,
  type ExecutableToolResult,
  type LoopEvent,
  type LoopRecordedEvent,
  type LoopTurnInterruptedEvent,
  type LoopTurnStopReason,
} from '../../loop/index';
import type { AgentEvent, TurnEndedEvent, TurnEndReason } from '../../rpc';
import type { TelemetryPropertyValue } from '../../telemetry';
import { gateImageFormatParts } from '../../tools/support/image-compress';
import { abortable, isUserCancellation, userCancellationReason } from '../../utils/abort';
import { USER_PROMPT_ORIGIN, type PromptOrigin } from '../context';
import {
  captureMediaStripSnapshot,
  stripMediaPartsBySnapshot,
  type MediaStripSnapshot,
} from '../context/projector';
import { renderUserPromptHookBlockResult, renderUserPromptHookResult } from '../../session/hooks';
import { canonicalTelemetryArgs, isPlainRecord } from './canonical-args';
import { degradeUnresolvedVideoToTag, resolvePromptMedia } from './media-resolve';
import { ToolCallDeduplicator } from './tool-dedup';
import { budgetToolResultForModel } from './tool-result-budget';

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
const GOAL_RATE_LIMIT_PAUSE_REASON = 'Paused after provider rate limit';
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = 'Paused after provider connection error';
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX = 'Paused after provider authentication error';
const GOAL_PROVIDER_API_PAUSE_PREFIX = 'Paused after provider API error';
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = 'Paused after model configuration error';
const GOAL_RUNTIME_PAUSE_PREFIX = 'Paused after runtime error';
const GOAL_PROVIDER_FILTERED_PAUSE_REASON = 'Paused after provider safety policy block';

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
  'against the work done so far, choose one bounded, useful slice of work, and use the existing',
  'conversation context and your tools. Do not try to finish a broad goal in one turn unless the',
  'whole goal is genuinely small. Most goal turns should not call UpdateGoal: after completing a',
  'useful slice, if material work remains, end the turn normally without calling UpdateGoal so',
  'the runtime can continue the goal in the next turn. Call UpdateGoal with `complete` only when',
  'all required work is done, any stated validation has passed, and there is no useful next',
  'action. Completion audit: before calling `complete`, verify the current state against the',
  'actual objective and every explicit requirement. Treat weak or indirect evidence as not',
  'complete. Do not mark complete after only producing a plan, summary, first pass, or partial',
  'result. Do not mark complete merely because a budget is nearly exhausted or you want to stop.',
  'Blocked audit: do not call UpdateGoal with `blocked` the first time you hit a blocker. Use',
  '`blocked` only for a genuine impasse: an external condition, required user input, missing',
  'credentials or permissions, or a persistent technical failure. For those non-terminal',
  'blockers, the same blocking condition must repeat for at least 3 consecutive goal turns before',
  'you call `blocked`, counting the original/user-triggered turn and automatic continuations.',
  'If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit.',
  'Exception: if the objective itself is impossible, unsafe, or contradictory, call UpdateGoal',
  'with `blocked` in the same turn; do not run more goal turns just to satisfy the audit. Do not',
  'use `blocked` because the work is large, hard, slow, uncertain, incomplete, still needs',
  'validation, would benefit from clarification, or needs more goal turns. Once the 3-turn',
  'threshold is met and you cannot make meaningful progress without user input or an',
  'external-state change, call UpdateGoal with `blocked`; do not keep reporting the blocker while',
  'leaving the goal active. Do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private activeTurn: 'resuming' | ActiveTurn | null = null;
  private readonly toolCallStartedAt = new Map<
    string,
    { name: string; startedAt: number; traceId: string | undefined }
  >();
  private readonly toolCallDupType = new Map<string, 'normal' | 'cross_step'>();
  private readonly stepToolCallKeys = new Map<number, Set<string>>();
  private readonly telemetryModeByTurn = new Map<number, 'agent' | 'plan'>();
  private readonly currentStepByTurn = new Map<number, number>();
  private readonly interruptedTelemetryTurnIds = new Set<number>();
  private readonly interruptedTraceIdByTurn = new Map<number, string | undefined>();
  private readonly stepFailureByTurn = new Map<number, LoopTurnInterruptedEvent>();
  private activeRequestTrace: LLMRequestTrace | undefined;
  private latestTraceId: string | undefined;
  private currentStep = 0;

  constructor(protected readonly agent: Agent) {}

  /** Best-effort agent id (main / generated id) derived from the agent homedir. */
  private get agentId(): string {
    return this.agent.homedir ? basename(this.agent.homedir) : this.agent.type;
  }

  // Returns the new turnId, or null if the turn was marked as resuming.
  prompt(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    // The last funnel before a prompt lands in the session history: images
    // in formats providers reject (AVIF, HEIC, …) become text notices here,
    // so no caller — the SDK/RPC prompt path included — can poison the
    // session. Upstream ingestion points already gate; this is the backstop.
    const gated = gateImageFormatParts(input);
    this.agent.records.logRecord({
      type: 'turn.prompt',
      input: gated,
      origin,
    });
    return this.launch(gated, origin);
  }

  // Returns the new turnId, or null if the input was buffered as a steer
  // message or the turn was marked as resuming.
  steer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    // Same format gate as prompt() — steer input enters the history too.
    const gated = gateImageFormatParts(input);
    this.agent.records.logRecord({
      type: 'turn.steer',
      input: gated,
      origin,
    });
    // Buffer while a turn is active OR a manual compaction holds the context;
    // `onCompactionFinished` replays the buffer once compaction's full lifecycle
    // (summary + reinjection) is done. Returning null means "buffered" — which is
    // exactly what fire-and-forget callers (background notifications, cron) assume.
    if (this.activeTurn || this.agent.fullCompaction.isCompacting) {
      this.steerBuffer.push({ input: gated, origin });
      return null;
    }
    return this.launch(gated, origin);
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

    // While a manual/SDK compaction holds the context, defer the launch instead
    // of rejecting it: buffer the input and replay it from `onCompactionFinished`
    // once compaction's full lifecycle (summary + reinjection) completes. The
    // deferred turn's eventual `turn.started` lets PromptService associate the
    // pending prompt, so a prompt submitted mid-compaction completes normally
    // rather than getting stuck "running". (Auto compaction runs inside an active
    // turn, so the `activeTurn` check above already covers it.)
    if (this.agent.fullCompaction.isCompacting) {
      this.steerBuffer.push({ input, origin });
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

  activeRequestTraceId(): string | undefined {
    return this.activeRequestTrace?.traceId;
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
      // Steer flushes happen at sites that cannot await an upload, so any
      // prompt-attached local video is degraded to an always-safe `<video
      // path>` tag here; the model uploads it in-turn via ReadMediaFile.
      this.agent.context.appendUserMessage(
        degradeUnresolvedVideoToTag(steer.input),
        steer.origin,
      );
    }
    steers.length = 0;
    return true;
  }

  /**
   * Replay inputs (prompts or steers) that were deferred while a manual compaction
   * held the context. Called by `FullCompaction` once the compaction lifecycle
   * (summary + reinjection) is done — and on cancel/failure — so deferred input is
   * never lost or stuck. If a turn is somehow already active (e.g. one that raced
   * and cancelled the compaction), let it consume the buffer like any other steer;
   * otherwise launch a fresh turn from the first buffered item, with the rest
   * draining into it via `flushSteerBuffer`.
   */
  onCompactionFinished(): void {
    if (this.steerBuffer.length === 0) return;
    if (this.activeTurn !== null) {
      this.flushSteerBuffer();
      return;
    }
    const next = this.steerBuffer.shift()!;
    this.launch(next.input, next.origin);
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
      // A goal can become active during an ordinary turn: the model creates one
      // with CreateGoal, or resumes a paused/blocked goal via UpdateGoal. Either
      // way, hand the now-active goal to the driver so it is actually pursued,
      // instead of stopping after the turn that merely started it. (The
      // already-active case took the early return above.)
      const goalBecameActive = this.agent.goal.getGoal().goal?.status === 'active';
      if (
        goalBecameActive &&
        end.event.reason !== 'cancelled' &&
        end.event.reason !== 'failed' &&
        end.event.reason !== 'blocked'
      ) {
        // The ordinary turn created or resumed the goal, so it counts as the
        // first active goal turn before the continuation driver takes over.
        const countedGoal = await this.agent.goal.incrementTurn();
        if (countedGoal?.budget.overBudget === true) {
          await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
          return end;
        }
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
   * `complete` (the record is cleared) / `blocked` stop the loop; `active`
   * (the model didn't decide) re-injects the goal reminder and runs the
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
      if (end.event.reason === 'blocked' || end.blockedByUserPromptHook === true) {
        await this.agent.goal.markBlocked({ reason: 'Blocked by UserPromptSubmit hook' });
        return end;
      }

      // The model decides via UpdateGoal: a cleared record means `complete`;
      // `blocked` remains as a non-active record. Runtime failures and user
      // interrupts can still leave the goal paused. Only a still `active` goal
      // continues to another turn.
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
    // The budget-exhausted goal turn does not run the model, so it cannot
    // await an upload — degrade any local video to the always-safe tag form.
    this.agent.context.appendUserMessage(degradeUnresolvedVideoToTag(input), origin);
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
    this.agent.telemetry.track('turn_started', { turn_id: turnId, mode: telemetryMode, thinking_effort: this.agent.config.thinkingEffort, ...this.requestProtocolProps() });
    this.agent.fullCompaction.resetForTurn();
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });

    const startedAt = Date.now();
    let ended: TurnEndedEvent;
    let blockedByUserPromptHook = false;
    let completedStopReason: LoopTurnStopReason | undefined;
    // Emitted after turn.ended (preserving prior ordering), so the error event
    // sits just past the turn.ended boundary that consumers watch for.
    let errorEvent: AgentEvent | undefined;
    try {
      // Resolve any prompt-attached local video (a `file://` video_url) into
      // its final delivered form — an uploaded `ms://` reference or an
      // inline/tag fallback — BEFORE it lands in history, so no unresolved
      // `file://` reference reaches the model or is persisted for resume. Auth
      // rejections surface as a failed turn via the catch below.
      const resolvedInput = await resolvePromptMedia(this.agent, input, signal);
      this.agent.context.appendUserMessage(resolvedInput, origin);
      const promptHookEnded = await this.applyUserPromptHook(turnId, resolvedInput, origin, signal, startedAt);
      if (promptHookEnded !== undefined) {
        ended = promptHookEnded.event;
        blockedByUserPromptHook = promptHookEnded.blocked;
      } else {
        const stopReason = await this.runStepLoop(turnId, signal);
        completedStopReason = stopReason;
        if (stopReason === 'filtered') {
          const summary = providerFilteredPayload(turnId);
          ended = {
            type: 'turn.ended',
            turnId,
            reason: 'failed',
            error: summary,
            durationMs: Date.now() - startedAt,
          };
          errorEvent = { type: 'error', ...summary };
        } else {
          const reason: TurnEndReason = stopReason === 'aborted' ? 'cancelled' : 'completed';
          ended = {
            type: 'turn.ended',
            turnId,
            reason,
            durationMs: Date.now() - startedAt,
          };
        }
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
            alias: this.agent.config.modelAlias,
            ...this.requestProtocolProps(),
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
          // The failed request's own trace id: from the error response
          // headers when it is a status error; otherwise from the in-flight
          // capture — a failure after response headers arrived (mid-stream
          // decode error, empty response) carries no trace on the error
          // itself, but the request's headers were captured. Failures before
          // any response (network errors, local aborts) leave the per-step
          // capture empty, so those still report no trace.
          const traceId = this.activeRequestTrace?.traceId;
          if (traceId !== undefined) {
            properties['trace_id'] = traceId;
          }
          this.agent.telemetry.track('api_error', properties);
        }
      }
    }
    // A live turn must never end with recorded tool calls still awaiting
    // results; if one does (a dispatch failure mid-batch broke the "every
    // recorded call gets a result" invariant), close the exchange now so the
    // context state machine cannot strand later messages in deferredMessages.
    this.closeAbandonedToolExchange(ended);
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
    const terminalTraceId =
      ended.reason === 'completed'
        ? this.latestTraceId
        : this.interruptedTraceIdByTurn.has(turnId)
          ? this.interruptedTraceIdByTurn.get(turnId)
          : this.activeRequestTrace?.traceId;
    this.agent.telemetry.track('turn_ended', {
      turn_id: turnId,
      reason: ended.reason,
      duration_ms: ended.durationMs,
      mode: this.telemetryModeByTurn.get(turnId) ?? this.telemetryMode(),
      thinking_effort: this.agent.config.thinkingEffort,
      ...this.requestProtocolProps(),
      trace_id: terminalTraceId,
    });
    this.agent.emitEvent(ended);
    // Release the active turn in the same frame as turn.ended for a standalone
    // turn, so the session is observably idle the instant turn.ended fires.
    // Exception: if the model turned the goal active during this turn (e.g.
    // CreateGoal), the session is NOT idle — turnWorker is about to drive the
    // goal. Keep the active turn alive (as the already-active goal path does) so
    // those autonomous continuations stay cancelable and exclude concurrent
    // turns; turnWorker releases it after the drive.
    if (
      standalone &&
      this.currentId === turnId &&
      this.agent.goal.getGoal().goal?.status !== 'active'
    ) {
      this.activeTurn = null;
    }
    if (this.agent.swarmMode.shouldAutoExit) {
      this.agent.swarmMode.exit();
    }
    if (errorEvent !== undefined) {
      this.agent.emitEvent(errorEvent);
    }
    if (ended.reason !== 'completed') {
      // Fallback for turns that end abnormally without a `turn.interrupted`
      // loop event reaching `trackLoopTelemetry` (e.g. a user-prompt hook block
      // or an abort that bypasses the step loop). `ended.reason` maps onto the
      // same interrupt-reason taxonomy the loop-event path uses; for a
      // `cancelled` end the signal's reason decides user_cancelled vs aborted.
      const interruptReason = telemetryInterruptReason(ended.reason, isUserCancellation(signal.reason));
      this.trackTurnInterrupted(
        turnId,
        this.currentStepByTurn.get(turnId) ?? this.currentStep,
        interruptReason,
        this.activeRequestTrace?.traceId,
      );
    }
    this.telemetryModeByTurn.delete(turnId);
    this.currentStepByTurn.delete(turnId);
    this.interruptedTelemetryTurnIds.delete(turnId);
    this.interruptedTraceIdByTurn.delete(turnId);
    this.stepFailureByTurn.delete(turnId);
    this.activeRequestTrace = undefined;
    this.latestTraceId = undefined;
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
        event: { type: 'turn.ended', turnId, reason: 'blocked', durationMs: Date.now() - startedAt },
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
    let goalOutcomeToolResultPending = false;
    const deduper = new ToolCallDeduplicator({ telemetry: this.agent.telemetry });
    await this.agent.mcp?.waitForInitialLoad(signal);
    // Surface the active goal at the start of the turn (append-only; no-op when
    // there is no active goal). Each goal continuation is its own turn, so this
    // re-injects the reminder once per turn rather than per step, preserving prompt caching.
    await this.agent.injection.injectGoal();
    // Announce loadable-tool changes at the same boundary cadence: a diff is
    // appended only when the loadable set actually changed, so quiet turns
    // keep the prompt cache fully warm.
    this.agent.injection.injectToolsDiff();
    let mediaStripSnapshot: MediaStripSnapshot | undefined;
    const buildMessagesMediaStripped = (): Message[] => {
      const messages = this.agent.context.messages;
      mediaStripSnapshot ??= captureMediaStripSnapshot(messages);
      return stripMediaPartsBySnapshot(messages, mediaStripSnapshot);
    };
    while (true) {
      signal.throwIfAborted();
      const model = this.agent.config.model;
      const loopControl = this.agent.kimiConfig?.loopControl;
      const maxStepsPerTurn = resolveMaxStepsPerTurn(loopControl?.maxStepsPerTurn);
      const maxRetriesPerStep = resolveMaxRetriesPerStep(loopControl?.maxRetriesPerStep);
      let stopForGoalBudget = false;
      try {
        const result = await runTurn({
          turnId: String(turnId),
          signal,
          llm: this.agent.llm,
          buildMessages: () => this.agent.context.messages,
          buildMessagesStrict: () => this.agent.context.strictMessages,
          buildMessagesMediaDegraded: () => this.agent.context.mediaDegradedMessages,
          buildMessagesMediaStripped,
          dispatchEvent: this.buildDispatchEvent(turnId),
          // Re-read per step (not snapshotted per turn) so a select_tools load
          // is dispatchable on the very next step of the same turn.
          buildTools: () => this.agent.tools.loopTools,
          describeMissingTool: (name) => this.agent.tools.missingToolMessage(name),
          log: this.agent.log,
          maxSteps: maxStepsPerTurn,
          maxRetryAttempts: maxRetriesPerStep,
          recordStepUsage: async (usage) => {
            try {
              const snapshot = await this.agent.goal.recordTokenUsage(usage.output);
              stopForGoalBudget = snapshot?.budget.overBudget === true;
            } catch (error) {
              this.agent.log.warn('goal token accounting failed', { error });
            }
          },
          onRequestTrace: (trace) => {
            this.activeRequestTrace = trace;
            deduper.beginStep(trace);
          },
          hooks: {
            beforeStep: async ({ signal: stepSignal }) => {
              this.agent.microCompaction.detect();
              await this.agent.fullCompaction.beforeStep(stepSignal);
              // Flush steered messages (background-task / cron notifications,
              // user interrupts) AFTER compaction so they land in the
              // post-compaction context instead of being dropped by it. The
              // keep/drop decision lives in
              // `compactionUserMessageDisposition()`; these origins are not
              // re-injected later, so append them only after compaction runs.
              this.flushSteerBuffer();
              await this.agent.injection.inject();
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
              const flushedSteeredMessages = this.flushSteerBuffer();
              // 0. A reached hard goal budget is a deterministic ceiling. While
              //    the goal is still active, never extend the turn — neither a
              //    steered message nor a Stop-hook continuation — past it; end
              //    the turn so the goal driver blocks the goal at the boundary.
              //    Buffered steers are still flushed above so real-time user
              //    input is preserved in context even when the budget stops the
              //    turn. A goal the model just marked terminal is no longer
              //    active, so its final outcome message (step 2 below) still runs.
              if (stopForGoalBudget && this.agent.goal.getActiveGoal() !== null) {
                return { continue: false };
              }
              // 1. If steered user messages were flushed and no active-goal
              //    budget stopped the turn, let the model react to them.
              if (flushedSteeredMessages) return { continue: true };
              signal.throwIfAborted();

              // Print-mode drain: when `kimi -p` ends a turn while background
              // subagents are still running, hold the turn open and idle-wait
              // until they finish. Their completions steer into the buffer
              // during the wait and are flushed afterward, so the model gets
              // one wrap-up step to react (nominate, backfill, ...) before the
              // turn ends. The wait is bounded by each subagent's own timeout,
              // not by a separate drain deadline, so late-spawned or long-
              // running subagents are still observed. Gated on a session flag
              // so interactive / goal modes are unaffected.
              if (this.agent.printDrainAgentTasksOnStop) {
                const hasActiveAgentTask = this.agent.background
                  .list(true)
                  .some((task) => task.kind === 'agent');
                if (hasActiveAgentTask) {
                  await this.agent.background.waitForActiveTasks(
                    (task) => task.kind === 'agent',
                    { signal },
                  );
                  this.flushSteerBuffer();
                  return { continue: true };
                }
              }

              // 2. After UpdateGoal marks a goal terminal, its tool result carries
              //    the final-message reminder. Let the model read that result and
              //    produce one user-facing outcome message before the turn ends.
              if (
                !goalOutcomeMessageContinuationUsed &&
                goalOutcomeToolResultPending
              ) {
                goalOutcomeMessageContinuationUsed = true;
                goalOutcomeToolResultPending = false;
                if (!hasStepBudgetRemaining(maxStepsPerTurn, ctx.stepNumber)) {
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
              const modelResult = await budgetToolResultForModel({
                homedir: this.agent.homedir,
                toolName: ctx.toolCall.name,
                toolCallId: ctx.toolCall.id,
                result: finalResult,
              });
              if (isTerminalUpdateGoalResult(ctx.toolCall.name, ctx.args, finalResult)) {
                goalOutcomeToolResultPending = true;
              }
              return modelResult;
            },
          },
        });

        return result.stopReason;
      } catch (error) {
        const isContextOverflow =
          error instanceof APIContextOverflowError ||
          (isKimiError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW);
        const estimatedRequestTokens = isContextOverflow
          ? this.agent.fullCompaction.estimateCurrentRequestTokens()
          : undefined;
        if (
          isContextOverflow ||
          this.agent.fullCompaction.shouldRecoverFromContextOverflow(error, estimatedRequestTokens)
        ) {
          this.agent.fullCompaction.observeContextOverflow(
            estimatedRequestTokens ?? this.agent.fullCompaction.estimateCurrentRequestTokens(),
          );
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

  // Guarded so this repair can never turn a finished turn into a crash: a
  // failure to close (e.g. record persistence still broken) is logged and the
  // projection-level safeguards remain the last line of defense.
  private closeAbandonedToolExchange(ended: TurnEndedEvent): void {
    try {
      const closed = this.agent.context.closeAbandonedToolExchange(
        abandonedToolResultOutput(ended),
      );
      if (closed === 0) return;
      this.agent.log.warn('closed abandoned tool exchange at turn end', {
        turnId: ended.turnId,
        reason: ended.reason,
        closed,
      });
      this.agent.telemetry.track('tool_exchange_abandoned', {
        reason: ended.reason,
        closed,
      });
    } catch (error) {
      this.agent.log.warn('failed to close abandoned tool exchange', { error });
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
    if (event.type === 'step.end') {
      // Final write: the completed step's last attempt wins over any earlier
      // mid-stream capture (e.g. from a retried attempt).
      this.latestTraceId = event.traceId;
      this.activeRequestTrace = undefined;
      return;
    }
    if (event.type === 'turn.interrupted') {
      this.interruptedTraceIdByTurn.set(turnId, event.traceId);
      if (event.reason === 'error' && event.activeStep !== undefined) {
        this.stepFailureByTurn.set(turnId, event);
      }
      this.trackTurnInterrupted(
        turnId,
        interruptedStep(event),
        event.interruptReason ?? telemetryInterruptReason(event.reason, false),
        event.traceId,
      );
      return;
    }
    this.trackToolLifecycle(event, turnId);
  }

  private beginTrackedStep(turnId: number, step: number): void {
    this.currentStepByTurn.set(turnId, step);
    this.currentStep = step;
    this.activeRequestTrace = undefined;
    if (!this.stepToolCallKeys.has(step)) {
      this.stepToolCallKeys.set(step, new Set());
    }
  }

  private trackToolLifecycle(event: LoopEvent, turnId: number): void {
    if (event.type === 'tool.call') {
      const dupType = this.trackDuplicateToolCall(
        turnId,
        event.step,
        event.name,
        event.args,
        event.traceId,
      );
      this.toolCallDupType.set(
        event.toolCallId,
        dupType === 'cross_step' ? 'cross_step' : 'normal',
      );
      this.toolCallStartedAt.set(event.toolCallId, {
        name: event.name,
        startedAt: Date.now(),
        traceId: event.traceId,
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
        turn_id: turnId,
        tool_name: started.name,
        outcome,
        duration_ms: Date.now() - started.startedAt,
        dup_type: dupType,
        trace_id: event.traceId ?? started.traceId,
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
    traceId: string | undefined,
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
      trace_id: traceId,
    });
    return dupType;
  }

  private hasPriorStepToolCallKey(step: number, key: string): boolean {
    for (const [seenStep, keys] of this.stepToolCallKeys) {
      if (seenStep !== step && keys.has(key)) return true;
    }
    return false;
  }

  private trackTurnInterrupted(
    turnId: number,
    atStep: number,
    interruptReason: TelemetryInterruptReason,
    traceId: string | undefined,
  ): void {
    if (this.interruptedTelemetryTurnIds.has(turnId)) return;
    this.interruptedTelemetryTurnIds.add(turnId);
    this.interruptedTraceIdByTurn.set(turnId, traceId);
    this.agent.telemetry.track('turn_interrupted', {
      turn_id: turnId,
      mode: this.telemetryModeByTurn.get(turnId) ?? this.telemetryMode(),
      thinking_effort: this.agent.config.thinkingEffort,
      at_step: atStep,
      interrupt_reason: interruptReason,
      ...this.requestProtocolProps(),
      trace_id: traceId,
    });
  }

  private telemetryMode(): 'agent' | 'plan' {
    return this.agent.planMode.isActive ? 'plan' : 'agent';
  }

  /**
   * Resolve the current model's provider wire type and any model-level protocol
   * override for request telemetry. Never throws — telemetry must not break a
   * turn over an unresolvable provider config (the step loop will surface that
   * error on its own).
   */
  private requestProtocolProps(): { provider_type?: string; protocol?: string } {
    const model = this.agent.config.modelAlias;
    if (model === undefined) return {};
    try {
      const resolved = this.agent.modelProvider?.resolveProviderConfig(model);
      if (resolved === undefined) return {};
      return {
        provider_type: resolved.type,
        protocol: resolved.protocol ?? resolved.type,
      };
    } catch {
      return {};
    }
  }

  private shouldTrackApiError(turnId: number): boolean {
    const failure = this.stepFailureByTurn.get(turnId);
    return failure?.reason === 'error' && failure.activeStep !== undefined;
  }
}

const MAX_STEPS_PER_TURN_ENV = 'KIMI_LOOP_MAX_STEPS_PER_TURN';
const MAX_RETRIES_PER_STEP_ENV = 'KIMI_LOOP_MAX_RETRIES_PER_STEP';

/**
 * Resolve the effective per-turn step cap. Precedence:
 * `KIMI_LOOP_MAX_STEPS_PER_TURN` (non-negative integer) → config
 * (`loop_control.max_steps_per_turn`) → `undefined` (no cap). `0` means no
 * cap, same as the config field; an invalid env value is ignored.
 */
export function resolveMaxStepsPerTurn(configValue?: number): number | undefined {
  return nonNegativeIntFromEnv(MAX_STEPS_PER_TURN_ENV) ?? configValue;
}

/**
 * Resolve the effective per-step retry budget. Precedence:
 * `KIMI_LOOP_MAX_RETRIES_PER_STEP` (non-negative integer) → config
 * (`loop_control.max_retries_per_step`) → `undefined` (the loop's built-in
 * default). An invalid env value is ignored.
 */
export function resolveMaxRetriesPerStep(configValue?: number): number | undefined {
  return nonNegativeIntFromEnv(MAX_RETRIES_PER_STEP_ENV) ?? configValue;
}

function nonNegativeIntFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

function isTerminalUpdateGoalResult(
  toolName: string,
  args: unknown,
  result: ExecutableToolResult,
): boolean {
  if (toolName !== 'UpdateGoal' || result.isError === true || result.stopTurn !== true) {
    return false;
  }
  if (!isPlainRecord(args)) return false;
  const status = args['status'];
  return status === 'complete' || status === 'blocked';
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
        llmRequestBuildMs: event.llmRequestBuildMs,
        llmServerFirstTokenMs: event.llmServerFirstTokenMs,
        llmServerDecodeMs: event.llmServerDecodeMs,
        llmClientConsumeMs: event.llmClientConsumeMs,
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

function providerFilteredPayload(turnId: number): KimiErrorPayload {
  return {
    code: ErrorCodes.PROVIDER_FILTERED,
    message: 'Provider safety policy blocked the response.',
    name: 'ProviderFilteredError',
    details: { finishReason: 'filtered', turnId },
    retryable: false,
  };
}

function goalFailurePauseReason(error: TurnEndedEvent['error']): string {
  if (error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) return GOAL_RATE_LIMIT_PAUSE_REASON;
  if (error?.code === ErrorCodes.PROVIDER_CONNECTION_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX, error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_AUTH_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_AUTH_PAUSE_PREFIX, error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_FILTERED) {
    return GOAL_PROVIDER_FILTERED_PAUSE_REASON;
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

/**
 * Telemetry-facing interrupt reason. The loop reports `LoopInterruptReason`
 * (`aborted` | `max_steps` | `error`); we split `aborted` into a deliberate
 * user cancel vs. any other programmatic abort so telemetry can tell them
 * apart. `filtered` is folded in for the fallback path (turn ends flagged
 * `filtered` never emit a `turn.interrupted` loop event).
 */
type TelemetryInterruptReason =
  | 'user_cancelled'
  | 'aborted'
  | 'max_steps'
  | 'error'
  | 'filtered'
  | 'blocked';

function telemetryInterruptReason(
  reason: LoopTurnInterruptedEvent['reason'] | Exclude<TurnEndedEvent['reason'], 'completed'>,
  userCancelled: boolean,
): TelemetryInterruptReason {
  if ((reason === 'aborted' || reason === 'cancelled') && userCancelled) {
    return 'user_cancelled';
  }
  if (reason === 'aborted' || reason === 'cancelled') return 'aborted';
  if (reason === 'failed') return 'error';
  if (reason === 'blocked') return 'blocked';
  // Remaining values are `max_steps` | `error` | `filtered`, which match the
  // telemetry enum.
  return reason;
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

// Output for a tool call abandoned by its turn (see closeAbandonedToolExchange):
// name the cause so the model treats the gap as an interruption to reason about,
// not a tool outcome. Mirrors the phrasing of the resume-time synthesis in
// `ContextMemory`.
function abandonedToolResultOutput(ended: TurnEndedEvent): string {
  const cause =
    ended.reason === 'cancelled'
      ? 'the turn was cancelled'
      : ended.reason === 'failed'
        ? `the turn failed${ended.error !== undefined ? ` (${ended.error.message})` : ''}`
        : 'the turn ended';
  return `Tool call did not complete: ${cause} before its result was recorded. Do not assume the tool completed successfully.`;
}
