/**
 * `PromptService` — adapter between the protocol-shaped REST surface and
 * agent-core's `prompt` / `cancel` RPC.
 *
 * **Three responsibilities**:
 *
 *   1. **Submit**: validate session existence + busy-check, mint a ULID
 *      `prompt_id`, derive the `user_message_id` (so the response matches
 *      SCHEMAS §5), and fire-and-forget `core.rpc.prompt(...)`. agent-core
 *      streams events synchronously from inside; they reach WS subscribers
 *      via the event service.
 *
 *   2. **Lifecycle observation**: subscribes to the event service via
 *      `IEventService.onDidPublish(handler)` (VSCode-style
 *      accessor returning an `IDisposable`) in its constructor. We use this
 *      to:
 *      - capture `turn.started` → record `promptId ↔ turnId` mapping (so
 *        later abort can pass the correct numeric `turnId` to
 *        `core.rpc.cancel({turnId})`).
 *      - capture `turn.ended` for the prompt's top-level turn → SYNTHESIZE a
 *        `prompt.completed` (reason='completed' or 'failed') or
 *        `prompt.aborted` (reason='cancelled') event. The event service then
 *        broadcasts these. agent-core's event union has no prompt-level
 *        types.
 *      VSCode-style accessors `onDidComplete: Event<...>` /
 *      `onDidAbort: Event<...>` are also exposed so callers can observe the
 *      typed synthetic events without filtering the raw event stream.
 *
 *   3. **Abort**: existence-check the prompt id, dispatch
 *      `core.rpc.cancel({sessionId, agentId:'main', turnId?})`. Idempotent:
 *      subsequent aborts on a completed/aborted prompt return
 *      `PromptAlreadyCompletedError` (→ envelope code 40903 with
 *      `data: {aborted: false}` per REST.md §3.5).
 *
 * **prompt_id ↔ turnId mapping**:
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
 * **session.busy detection**: the impl
 * maintains `Map<sessionId, PromptState>` where `PromptState` carries
 * `promptId`, `turnId | null`, and a terminal flag. A second submit while a
 * non-terminal prompt exists for the same session throws
 * `SessionBusyError → 40901`.
 *
 * **`user_message_id` derivation**: SCHEMAS §5 mandates a `user_message_id`
 * in the submit response. When the full message history adapter is available,
 * message ids are `msg_{sessionId}_{6-digit-index}`. We don't yet know the
 * index of the new
 * user message (it'll be appended to the history during prompt execution).
 * Until agent-core surfaces "new message id" inline, we synthesize the id
 * from the prompt id itself — `msg_{sessionId}_pending_{promptId}`. Real
 * per-message ids can replace this when agent-core exposes a per-message
 * store.
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for type-only
 * `Event` / `TurnStartedEvent` etc. Runtime calls go through
 * `ICoreProcessService.rpc.<method>`. Lifecycle synthesis emits events through
 * `IEventService.publish` (also a daemon-side interface; agent-core not touched).
 */

import { createDecorator, Disposable } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/agent-core/base/common/event';
import type {
  PromptSubmission,
  PromptSubmitResult,
} from '@moonshot-ai/protocol';
import { ulid } from 'ulid';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IAuthSummaryService } from '../authSummary/authSummary';
import { IEventService } from '../event/event';
import { SessionNotFoundError } from '../session/session';

export interface PromptAbortResult {
  /** True iff this call performed the cancel (false on idempotent already-completed). */
  aborted: boolean;
  /** Per-session seq at the moment the abort was issued (informational). */
  at_seq?: number;
}

/**
 * Partial bag of runtime controls accepted by `applyAgentState`. Mirrors the
 * four fields the per-session shadow tracks (`model`, `thinking`,
 * `permission_mode`, `plan_mode`) on protocol's wire vocabulary. Every key is
 * optional: only present keys diff-dispatch a setter.
 *
 * Used by both `PromptService.submit` (when the caller carries per-turn
 * overrides on the body) and by `SessionService.update` (when `POST
 * /v1/sessions/{sid}/profile` patches `agent_config`).
 */
export interface AgentStatePatch {
  model?: string;
  thinking?: string;
  permission_mode?: string;
  plan_mode?: boolean;
}

/**
 * Where an `applyAgentState` call originated. `'prompt'` is the
 * `POST /prompts` body override path; `'meta'` is the legacy source label for
 * the `POST /sessions/{sid}/profile` path. Recorded in `PromptDispatchLogEntry.source` so the debug surface can
 * attribute every dispatched setter to its triggering endpoint without the
 * caller having to interleave its own log entries.
 */
export type AgentStateSource = 'prompt' | 'meta';

export interface IPromptService {
  readonly _serviceBrand: undefined;

  /**
   * `POST /v1/sessions/{sid}/prompts` — submit a prompt for execution.
   *
   * Throws `SessionNotFoundError` (→ 40401) for unknown `sid`.
   * Throws `SessionBusyError`     (→ 40901) when another prompt is active.
   */
  submit(sid: string, body: PromptSubmission): Promise<PromptSubmitResult>;

  /**
   * `POST /v1/sessions/{sid}/prompts/{pid}:abort` — cancel an in-flight prompt.
   *
   * Per REST.md §3.5: aborting an already-completed prompt returns
   * `PromptAlreadyCompletedError` (→ 40903 with `data.aborted: false`).
   * Idempotent calls (same id, multiple aborts) collapse to a single cancel
   * RPC + subsequent calls return 40903.
   *
   * Throws `SessionNotFoundError` (→ 40401) for unknown `sid`.
   * Throws `PromptNotFoundError`  (→ 40402) when `pid` is unknown for `sid`.
   */
  abort(sid: string, pid: string): Promise<PromptAbortResult>;

  /**
   * Apply a partial runtime-controls patch to a session's shadow,
   * diff-dispatching the matching `core.rpc.*` setter for any field that
   * differs. Used by both `submit` (per-turn override path) and
   * `SessionService.update` (POST /sessions/{sid}/profile path).
   *
   * Throws `SessionNotFoundError` (→ 40401) for unknown `sid`. Throws any
   * error the underlying setter throws. Idempotent: calling with values
   * equal to the shadow is a no-op (zero dispatch-log entries appended).
   *
   * `promptId` is recorded on each appended dispatch-log entry so the
   * debug surface can attribute setters to the prompt that triggered
   * them. Pass `undefined` for non-prompt callers (the `/profile` path) —
   * the entry's `promptId` will be the empty string.
   */
  applyAgentState(
    sid: string,
    patch: AgentStatePatch,
    source: AgentStateSource,
    promptId?: string,
  ): Promise<void>;

  /**
   * VSCode-style accessor for `prompt.completed` synthetic events. The
   * listener fires synchronously when a top-level `turn.ended`
   * (reason='completed'|'failed') is synthesised into a prompt-lifecycle
   * event, BEFORE `bus.publish(synth)`.
   *
   * Returns an `IDisposable`. Owners stash it via
   * `Disposable._register(svc.onDidComplete(handler))`.
   */
  readonly onDidComplete: Event<SyntheticPromptCompletedEvent>;

  /**
   * VSCode-style accessor for `prompt.aborted` synthetic events. Same
   * `IDisposable` contract as `onDidComplete`. The listener fires when a
   * top-level `turn.ended` (reason='cancelled') or an abort RPC synthesises
   * a prompt-lifecycle event, BEFORE `bus.publish(synth)`.
   */
  readonly onDidAbort: Event<SyntheticPromptAbortedEvent>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPromptService = createDecorator<IPromptService>('promptService');

/**
 * Sentinel — REST → 40901 `session.busy`. Carries the active prompt id so the
 * route layer can include it in `details`.
 */
export class SessionBusyError extends Error {
  readonly sessionId: string;
  readonly activePromptId: string;
  constructor(sessionId: string, activePromptId: string) {
    super(`session ${sessionId} is busy (prompt ${activePromptId} in flight)`);
    this.name = 'SessionBusyError';
    this.sessionId = sessionId;
    this.activePromptId = activePromptId;
  }
}

/**
 * Sentinel — REST → 40402 `prompt.not_found`.
 */
export class PromptNotFoundError extends Error {
  readonly sessionId: string;
  readonly promptId: string;
  constructor(sessionId: string, promptId: string) {
    super(`prompt ${promptId} does not exist in session ${sessionId}`);
    this.name = 'PromptNotFoundError';
    this.sessionId = sessionId;
    this.promptId = promptId;
  }
}

/**
 * Sentinel — REST → 40903 `prompt.already_completed`. Carries the prompt id
 * and a flag so the route layer can emit the documented
 * `data: {aborted: false}` envelope despite the non-zero code.
 */
export class PromptAlreadyCompletedError extends Error {
  readonly sessionId: string;
  readonly promptId: string;
  constructor(sessionId: string, promptId: string) {
    super(`prompt ${promptId} in session ${sessionId} is already completed`);
    this.name = 'PromptAlreadyCompletedError';
    this.sessionId = sessionId;
    this.promptId = promptId;
  }
}

/**
 * `prompt.completed` synthetic event shape. Matches the agent-core `Event`
 * type contract (`AgentEvent & { agentId, sessionId }`) so it flows through
 * the existing `IEventService` path. The `type` string is namespaced under
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

/**
 * Per-session shadow of the four stateless prompt controls. Exposed
 * via `PromptService._agentStateForTest(sid)` for debug-only routes
 * and unit tests; not part of the day-to-day surface.
 */
export interface AgentStateSnapshot {
  model?: string;
  thinking?: string;
  permissionMode?: string;
  planMode?: boolean;
}

/**
 * One dispatch record appended to the per-session ring buffer whenever
 * `PromptService._applyAgentState` actually issues a setter RPC against
 * `core.rpc.*`. Absence of an entry between two prompts proves the
 * shadow suppressed a redundant call — which is the property
 * `daemon-e2e` scenarios need to assert directly, since WS frames
 * alone can't distinguish "state held" from "setter re-dispatched".
 */
export interface PromptDispatchLogEntry {
  /** ISO-8601 timestamp captured immediately after the setter resolves. */
  readonly ts: string;
  /** Which setter ran. */
  readonly kind: 'setModel' | 'setThinking' | 'setPermission' | 'enterPlan' | 'cancelPlan';
  /** Verbatim payload passed to the setter (sessionId redacted by caller if needed). */
  readonly payload: Record<string, unknown>;
  /**
   * Prompt id this dispatch was made on behalf of. Minted at the top of
   * `submit()` so setter RPCs and the eventual `core.rpc.prompt(...)`
   * carry the same id. Empty string when the dispatch came from the
   * `/sessions/{sid}/profile` path (no prompt context).
   */
  readonly promptId: string;
  /**
   * Which endpoint triggered the dispatch — `'prompt'` for a body
   * override on `POST /sessions/{sid}/prompts`, `'meta'` for a patch on
   * `POST /sessions/{sid}/profile`. Lets the debug surface
   * (`GET /debug/prompts/{sid}/dispatch-log`) and unit/e2e tests
   * attribute every setter to the request that caused it without
   * threading an extra log of its own.
   */
  readonly source: AgentStateSource;
}
