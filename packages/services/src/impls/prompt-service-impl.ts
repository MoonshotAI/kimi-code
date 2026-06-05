/**
 * `PromptServiceImpl` (Chain 4 / P1.4, W7.2; abort logic for Chain 4b / W7.3) —
 * adapter between protocol-shaped REST surface and agent-core's `prompt` /
 * `cancel` RPC.
 *
 * **Three responsibilities**:
 *
 *   1. **Submit**: validate session existence + busy-check, mint a ULID
 *      `prompt_id`, derive the `user_message_id` (so the response matches
 *      SCHEMAS §5), and fire-and-forget `bridge.rpc.prompt(...)`. agent-core
 *      streams events synchronously from inside; they reach WS subscribers
 *      via the bus.
 *
 *   2. **Lifecycle observation (W7.2)**: implements `IPromptLifecycleObserver`
 *      so the daemon's event bus invokes `observeEvent(e)` on every published
 *      event. We use this to:
 *      - capture `turn.started` → record `promptId ↔ turnId` mapping (so
 *        later abort can pass the correct numeric `turnId` to
 *        `bridge.rpc.cancel({turnId})`).
 *      - capture `turn.ended` for the prompt's top-level turn → SYNTHESIZE a
 *        `prompt.completed` (reason='completed' or 'failed') or
 *        `prompt.aborted` (reason='cancelled') event. The bus then broadcasts
 *        these. agent-core's event union has no prompt-level types — see W7
 *        §critical discovery point #2.
 *
 *   3. **Abort (W7.3)**: existence-check the prompt id, dispatch
 *      `bridge.rpc.cancel({sessionId, agentId:'main', turnId?})`. Idempotent:
 *      subsequent aborts on a completed/aborted prompt return
 *      `PromptAlreadyCompletedError` (→ envelope code 40903 with
 *      `data: {aborted: false}` per REST.md §3.5).
 *
 * **prompt_id ↔ turnId mapping** (W7 §critical discovery point #4):
 * - Daemon mints `prompt_<ULID>` on submit. This is a daemon-only id; agent-core
 *   knows nothing about it.
 * - `turn.started.turnId: number` is the agent-core counterpart. On the FIRST
 *   `turn.started` after a submit, we associate `promptId ↔ turnId` for the
 *   session's active prompt. Future `turn.started` events on the same session
 *   without an intervening submit are nested turns — they don't reset the
 *   mapping.
 * - On `turn.ended` matching the top-level turn (turnId equal to the original
 *   mapping), we synthesize the lifecycle event and clear `activePromptId`.
 *
 * **session.busy detection** (W7 §critical discovery point #3): the impl
 * maintains `Map<sessionId, PromptState>` where `PromptState` carries
 * `promptId`, `turnId | null`, and a terminal flag. A second submit while a
 * non-terminal prompt exists for the same session throws
 * `SessionBusyError → 40901`.
 *
 * **`user_message_id` derivation**: SCHEMAS §5 mandates a `user_message_id`
 * in the submit response. Per W7.1's adapter, message ids are
 * `msg_{sessionId}_{6-digit-index}`. We don't yet know the index of the new
 * user message (it'll be appended to the history during prompt execution).
 * Until agent-core surfaces "new message id" inline, we synthesize the id
 * from the prompt id itself — `msg_{sessionId}_pending_{promptId}` — and
 * note this in STATUS Decisions. Real per-message ids land when agent-core
 * exposes a per-message store (deferred to a later chain).
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for type-only
 * `Event` / `TurnStartedEvent` etc. Runtime calls go through
 * `IHarnessBridge.rpc.<method>`. Lifecycle synthesis emits events through
 * `IEventBus.publish` (also a daemon-side interface; agent-core not touched).
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type {
  Event,
  PromptSubmission,
  PromptSubmitResult,
} from '@moonshot-ai/protocol';
import { ulid } from 'ulid';

import { IHarnessBridge } from '../bridge/harness-bridge';
import { IAuthSummaryService } from '../interfaces/auth-summary-service';
import { IEventBus } from '../interfaces/event-bus';
import {
  IPromptService,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  SessionBusyError,
  type IPromptLifecycleObserver,
  type PromptAbortResult,
} from '../interfaces/prompt-service';
import { SessionNotFoundError } from '../interfaces/session-service';

const MAIN_AGENT_ID = 'main';

/**
 * Per-session "active prompt" state. Cleared on completion/abort.
 *
 * `turnId === null` when the prompt has been submitted but the first
 * `turn.started` hasn't arrived yet (the RPC pair queues calls before
 * `ready()` so the gap is small but non-zero in practice).
 *
 * `terminal === true` is set when `turn.ended` arrives — we keep the record
 * around so abort-on-already-completed surfaces as 40903, not 40402.
 */
interface PromptState {
  promptId: string;
  turnId: number | null;
  /** Set on `turn.ended` for the top-level turn (reason='completed'|'failed'). */
  completed: boolean;
  /** Set on `turn.ended` with reason='cancelled' or after a successful abort RPC. */
  aborted: boolean;
}

/**
 * Type guard for `turn.started` agent-core events.
 */
function isTurnStarted(e: Event): e is Event & { type: 'turn.started'; turnId: number } {
  return (e as { type?: string }).type === 'turn.started';
}

/**
 * Type guard for `turn.ended` agent-core events.
 */
function isTurnEnded(e: Event): e is Event & {
  type: 'turn.ended';
  turnId: number;
  reason: 'completed' | 'cancelled' | 'failed';
} {
  return (e as { type?: string }).type === 'turn.ended';
}

/**
 * `prompt.completed` synthetic event shape. Matches the agent-core `Event`
 * type contract (`AgentEvent & { agentId, sessionId }`) so it flows through
 * the existing `IEventBus` path. The `type` string is namespaced under
 * `prompt.*` (not part of agent-core's union — see service header).
 */
export interface SyntheticPromptCompletedEvent {
  readonly type: 'prompt.completed';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason: 'completed' | 'failed';
}

/**
 * `prompt.aborted` synthetic event shape.
 */
export interface SyntheticPromptAbortedEvent {
  readonly type: 'prompt.aborted';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly abortedAt: string;
}

export class PromptServiceImpl
  extends Disposable
  implements IPromptService, IPromptLifecycleObserver
{
  /** Active prompt per session. Cleared on completion / abort emission. */
  private readonly _active = new Map<string, PromptState>();

  constructor(
    @IHarnessBridge private readonly bridge: IHarnessBridge,
    @IEventBus private readonly eventBus: IEventBus,
    @IAuthSummaryService private readonly auth: IAuthSummaryService,
  ) {
    super();
  }

  // --- IPromptService --------------------------------------------------------

  async submit(sid: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    await this._requireSession(sid);

    // P2.1 D1 — readiness gate. Throws AuthProvisioningRequired /
    // AuthTokenMissing / AuthModelNotResolved before we mint a prompt_id and
    // hand off to agent-core. Daemon route layer maps to 40110/40111/40113.
    await this.auth.ensureReady();

    const existing = this._active.get(sid);
    if (existing !== undefined && !existing.completed && !existing.aborted) {
      throw new SessionBusyError(sid, existing.promptId);
    }

    const promptId = `prompt_${ulid()}`;
    const userMessageId = `msg_${sid}_pending_${promptId}`;

    this._active.set(sid, {
      promptId,
      turnId: null,
      completed: false,
      aborted: false,
    });

    // Translate protocol MessageContent → agent-core ContentPart. Only text /
    // image content survive the kosong-shape boundary; tool_use / tool_result
    // / thinking originate from the model, not from client submission.
    const input = body.content
      .map((part) => {
        switch (part.type) {
          case 'text':
            return { type: 'text' as const, text: part.text };
          case 'image':
            if (part.source.kind === 'url') {
              return {
                type: 'image_url' as const,
                imageUrl: { url: part.source.url },
              };
            }
            return undefined;
          // Other content kinds (file / tool_use / tool_result / thinking) are
          // not accepted from client submissions in this stage.
          default:
            return undefined;
        }
      })
      .filter((part): part is NonNullable<typeof part> => part !== undefined);

    // Fire-and-forget. agent-core streams events via the SDK side of the
    // RPC pair which lands on `BridgeClientAPI.emitEvent → IEventBus.publish`.
    // The submit RPC returns synchronously (PromptPayload → void); errors
    // would manifest as later `error` events, not as a rejection here.
    try {
      await this.bridge.rpc.prompt({
        sessionId: sid,
        agentId: MAIN_AGENT_ID,
        input,
      });
    } catch (err) {
      // Clear our active-prompt state so the next submit succeeds; surface
      // the error to the route layer.
      this._active.delete(sid);
      throw err;
    }

    return { prompt_id: promptId, user_message_id: userMessageId };
  }

  async abort(sid: string, pid: string): Promise<PromptAbortResult> {
    await this._requireSession(sid);
    const state = this._active.get(sid);
    if (state === undefined || state.promptId !== pid) {
      throw new PromptNotFoundError(sid, pid);
    }
    if (state.completed || state.aborted) {
      throw new PromptAlreadyCompletedError(sid, pid);
    }
    // Mark aborted optimistically — observeEvent will not re-synthesize.
    state.aborted = true;
    try {
      const cancelArgs: { sessionId: string; agentId: string; turnId?: number } = {
        sessionId: sid,
        agentId: MAIN_AGENT_ID,
      };
      if (state.turnId !== null) cancelArgs.turnId = state.turnId;
      await this.bridge.rpc.cancel(cancelArgs);
    } catch (err) {
      // Roll back the optimistic flag so the route surfaces a real error;
      // the caller will see a 50001 (internal) via the global error handler.
      state.aborted = false;
      throw err;
    }
    // Synthesize the prompt.aborted event immediately. agent-core may also
    // emit a turn.ended(cancelled) later; observeEvent suppresses a second
    // synthesis since `state.aborted === true`.
    const ev: SyntheticPromptAbortedEvent = {
      type: 'prompt.aborted',
      agentId: MAIN_AGENT_ID,
      sessionId: sid,
      promptId: pid,
      abortedAt: new Date().toISOString(),
    };
    this.eventBus.publish(ev as unknown as Event);
    return { aborted: true };
  }

  // --- IPromptLifecycleObserver --------------------------------------------

  observeEvent(event: Event): readonly Event[] {
    const sid = (event as { sessionId?: string }).sessionId;
    if (sid === undefined || sid === '') return [];
    const state = this._active.get(sid);
    if (state === undefined) return [];

    if (isTurnStarted(event)) {
      // Capture the FIRST turn.started after submit as the "top-level" turn.
      // Subsequent nested turns (e.g. subagent) carry different turnId values
      // and are NOT promoted to the prompt's top-level.
      if (state.turnId === null) {
        state.turnId = event.turnId;
      }
      return [];
    }

    if (isTurnEnded(event)) {
      // Only fire on the top-level turn end. Nested turn.ended events fly
      // through without prompt-level synthesis.
      if (state.turnId === null || event.turnId !== state.turnId) return [];

      // If we already synthesized via abort RPC, don't double-emit. Mark
      // completed to prevent stale lookups, but emit nothing.
      if (state.aborted) {
        this._active.delete(sid);
        return [];
      }

      const reason = event.reason;
      if (reason === 'cancelled') {
        // The model produced a cancellation that we didn't initiate via
        // abort RPC (or it slipped past the optimistic flag). Synthesize
        // prompt.aborted.
        state.aborted = true;
        const synth: SyntheticPromptAbortedEvent = {
          type: 'prompt.aborted',
          agentId: MAIN_AGENT_ID,
          sessionId: sid,
          promptId: state.promptId,
          abortedAt: new Date().toISOString(),
        };
        this._active.delete(sid);
        return [synth as unknown as Event];
      }

      state.completed = true;
      const synth: SyntheticPromptCompletedEvent = {
        type: 'prompt.completed',
        agentId: MAIN_AGENT_ID,
        sessionId: sid,
        promptId: state.promptId,
        finishedAt: new Date().toISOString(),
        reason: reason === 'failed' ? 'failed' : 'completed',
      };
      this._active.delete(sid);
      return [synth as unknown as Event];
    }
    return [];
  }

  /**
   * Test helper — peek at active prompt state.
   */
  _activeForTest(sid: string): Readonly<PromptState> | undefined {
    const state = this._active.get(sid);
    return state === undefined ? undefined : { ...state };
  }

  /**
   * Test helper — inject an active prompt record. Used by daemon e2e tests
   * that need to exercise the lifecycle-synthesis path WITHOUT driving a
   * real `bridge.rpc.prompt(...)` call (which would require an in-memory
   * KimiCore loaded with provider credentials). Not part of the public
   * contract; the underscore prefix is a "do not use in prod" signal.
   */
  _injectActiveForTest(sid: string, promptId: string, turnId: number | null): void {
    this._active.set(sid, {
      promptId,
      turnId,
      completed: false,
      aborted: false,
    });
  }

  // --- internals -----------------------------------------------------------

  private async _requireSession(sid: string): Promise<void> {
    const all = await this.bridge.rpc.listSessions({});
    if (!all.some((s) => s.id === sid)) {
      throw new SessionNotFoundError(sid);
    }
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this._active.clear();
    super.dispose();
  }
}
