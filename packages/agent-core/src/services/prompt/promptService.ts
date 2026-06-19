/**
 * `PromptService` — implementation of `IPromptService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { Emitter } from '../../base/common/event';
import type {
  Event,
  PromptItem,
  PromptListResponse,
  PromptSubmission,
  PromptSteerResult,
  PromptSubmitResult,
  PromptThinking,
} from '@moonshot-ai/protocol';
import type { PermissionMode } from '../../agent/permission';
import { ulid } from 'ulid';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IAuthSummaryService } from '../authSummary/authSummary';
import { IEventService } from '../event/event';
import { ILogService } from '../logger/logger';
import { ISessionService, SessionNotFoundError } from '../session/session';
import {
  IPromptService,
  PromptNotFoundError,
  PromptAlreadyCompletedError,
  type AgentStatePatch,
  type AgentStateSnapshot,
  type AgentStateSource,
  type PromptAbortResult,
  type PromptDispatchLogEntry,
  type SyntheticPromptCompletedEvent,
  type SyntheticPromptAbortedEvent,
  type SyntheticPromptSteeredEvent,
  type SyntheticPromptSubmittedEvent,
} from './prompt';

const MAIN_AGENT_ID = 'main';

function promptKey(sessionId: string, agentId: string): string {
  return `${sessionId}\u0000${agentId}`;
}

/** Cap per-session dispatch-log entries; ring-buffer drops oldest on overflow. */
const DISPATCH_LOG_CAP = 100;

/**
 * `true` iff any of the runtime-control fields is defined on the patch.
 * Used to short-circuit `applyAgentState` / the prompt-body override path
 * when the caller carries nothing actionable.
 */
function hasAnyAgentStateField(patch: AgentStatePatch): boolean {
  return (
    patch.model !== undefined ||
    patch.thinking !== undefined ||
    patch.permission_mode !== undefined ||
    patch.plan_mode !== undefined ||
    patch.swarm_mode !== undefined ||
    patch.goal_objective !== undefined ||
    patch.goal_control !== undefined
  );
}

/**
 * Extract the runtime-control fields from a `PromptSubmission` body into a
 * shadow-shaped patch. Returns `undefined` when the body carries none of the
 * fields — the submit path skips both shadow bootstrap and diff-dispatch in
 * that case, saving RPCs on hot content-only prompts.
 */
function pickAgentStatePatch(body: PromptSubmission): AgentStatePatch | undefined {
  const patch: AgentStatePatch = {};
  if (body.model !== undefined) patch.model = body.model;
  if (body.thinking !== undefined) patch.thinking = body.thinking;
  if (body.permission_mode !== undefined) patch.permission_mode = body.permission_mode;
  if (body.plan_mode !== undefined) patch.plan_mode = body.plan_mode;
  if (body.swarm_mode !== undefined) patch.swarm_mode = body.swarm_mode;
  if (body.goal_objective !== undefined) patch.goal_objective = body.goal_objective;
  if (body.goal_control !== undefined) patch.goal_control = body.goal_control;
  return hasAnyAgentStateField(patch) ? patch : undefined;
}

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
  agentId: string;
  promptId: string;
  userMessageId: string;
  body: PromptSubmission;
  createdAt: string;
  turnId: number | null;
  /** Set on `turn.ended` for the top-level turn (reason='completed'|'failed'). */
  completed: boolean;
  /** Set on `turn.ended` with reason='cancelled' or after a successful abort RPC. */
  aborted: boolean;
}

type CorePromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly imageUrl: { readonly url: string } }
  | { readonly type: 'video_url'; readonly videoUrl: { readonly url: string } };

function toPromptItem(state: PromptState, status: 'running' | 'queued'): PromptItem {
  return {
    prompt_id: state.promptId,
    user_message_id: state.userMessageId,
    status,
    content: state.body.content,
    created_at: state.createdAt,
  };
}

function contentToCoreParts(content: PromptSubmission['content']): CorePromptPart[] {
  const input: CorePromptPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        input.push({ type: 'text', text: part.text });
        break;
      case 'image':
        if (part.source.kind === 'url') {
          input.push({
            type: 'image_url',
            imageUrl: { url: part.source.url },
          });
        } else if (part.source.kind === 'base64') {
          input.push({
            type: 'image_url',
            imageUrl: {
              url: `data:${part.source.media_type};base64,${part.source.data}`,
            },
          });
        }
        break;
      case 'video':
        if (part.source.kind === 'url') {
          input.push({
            type: 'video_url',
            videoUrl: { url: part.source.url },
          });
        } else if (part.source.kind === 'base64') {
          input.push({
            type: 'video_url',
            videoUrl: {
              url: `data:${part.source.media_type};base64,${part.source.data}`,
            },
          });
        }
        break;
      case 'file':
      case 'thinking':
      case 'tool_result':
      case 'tool_use':
        break;
    }
  }
  return input;
}

function steerContentToCoreParts(states: readonly PromptState[]): CorePromptPart[] {
  const textBodies: string[] = [];
  let allText = true;
  for (const state of states) {
    const texts: string[] = [];
    for (const part of state.body.content) {
      if (part.type !== 'text') {
        allText = false;
        break;
      }
      texts.push(part.text);
    }
    if (!allText) break;
    textBodies.push(texts.join('\n'));
  }
  if (allText) {
    return [{ type: 'text', text: textBodies.join('\n\n') }];
  }

  const input: CorePromptPart[] = [];
  states.forEach((state, index) => {
    if (index > 0) input.push({ type: 'text', text: '\n\n' });
    input.push(...contentToCoreParts(state.body.content));
  });
  return input;
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
 * Type guard for `agent.status.updated` agent-core events. Carries the
 * subset of fields we mirror into the per-session shadow on every live
 * change (model / permission / planMode). `thinkingLevel` is NOT on this
 * event — bootstrap seeds it from `getConfig` and per-request diff dispatch
 * keeps it in sync from there.
 */
function isAgentStatusUpdated(e: Event): e is Event & {
  type: 'agent.status.updated';
  model?: string;
  permission?: PermissionMode;
  planMode?: boolean;
} {
  return (e as { type?: string }).type === 'agent.status.updated';
}

/**
 * Per-session shadow of `model` / `thinking` / `permissionMode` /
 * `planMode`. Type re-exported from `./prompt` so the daemon debug route
 * can consume it without reaching into `PromptService` internals.
 * Absent until first `submit` bootstraps. See `_bootstrapAgentState` +
 * `_applyAgentState`.
 */

export class PromptService
  extends Disposable
  implements IPromptService
{
  readonly _serviceBrand: undefined;

  /** Active prompt per session. Cleared on completion / abort emission. */
  private readonly _active = new Map<string, PromptState>();

  private readonly _queued = new Map<string, PromptState[]>();

  /**
   * Per-session shadow of `model` / `thinking` / `permissionMode` /
   * `planMode`. Absent until first `submit` bootstraps. See
   * `_bootstrapAgentState` + `_applyAgentState`.
   */
  private readonly _agentState = new Map<string, AgentStateSnapshot>();

  /**
   * Per-session ring buffer of stateless-control setter dispatches.
   * Each entry records `{ts, kind, payload, promptId}` immediately after
   * the underlying `core.rpc.*` setter resolves inside `_applyAgentState`.
   * The buffer is capped at `DISPATCH_LOG_CAP`; on overflow the oldest
   * entry is dropped. Cleared on `ISessionService.onDidClose` together
   * with the shadow. Exposed via `_dispatchLogForTest` for the daemon's
   * `/debug/prompts/{sid}/dispatch-log` route + unit tests — never read
   * on the hot path.
   */
  private readonly _dispatchLog = new Map<string, PromptDispatchLogEntry[]>();

  /**
   * VSCode-style Emitter for `prompt.completed` synthetic events. Listener
   * exceptions route to `onUnexpectedError` inside `Emitter.fire()`. Owned
   * via `_register(...)` so it disposes when PromptService is torn down.
   */
  private readonly _onDidComplete = this._register(
    new Emitter<SyntheticPromptCompletedEvent>(),
  );
  readonly onDidComplete = this._onDidComplete.event;
  /**
   * VSCode-style Emitter for `prompt.aborted` synthetic events. Same
   * ownership + exception-routing semantics as `_onDidComplete`.
   */
  private readonly _onDidAbort = this._register(
    new Emitter<SyntheticPromptAbortedEvent>(),
  );
  readonly onDidAbort = this._onDidAbort.event;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEventService private readonly eventService: IEventService,
    @IAuthSummaryService private readonly auth: IAuthSummaryService,
    @ISessionService private readonly sessionService: ISessionService,
    @ILogService private readonly _logger: ILogService,
  ) {
    super();
    // Self-subscribe to the event stream for lifecycle synthesis.
    // `onDidPublish` is the VSCode-style accessor — calling it registers
    // `_handleBusEvent` and returns an `IDisposable` that detaches when
    // disposed. We register it through `this._register(...)` so the
    // listener tears down when PromptService disposes (which happens BEFORE
    // the event service disposes per start.ts wiring order). Re-entrance
    // is safe: synthesised `prompt.*` events don't match the `turn.*`
    // predicates below.
    this._register(
      this.eventService.onDidPublish(this._handleBusEvent.bind(this)),
    );
    // Drop the per-session shadow when a session closes so the next
    // submit for a freshly-recreated session re-bootstraps cleanly.
    this._register(
      this.sessionService.onDidClose(({ sessionId }) => {
        this._agentState.delete(sessionId);
        this._dispatchLog.delete(sessionId);
        for (const key of this._queued.keys()) {
          if (key.startsWith(`${sessionId}\u0000`)) this._queued.delete(key);
        }
      }),
    );
  }

  // --- IPromptService --------------------------------------------------------

  async list(sid: string): Promise<PromptListResponse> {
    await this._requireSession(sid);
    const key = promptKey(sid, MAIN_AGENT_ID);
    const active = this._active.get(key);
    return {
      active:
        active !== undefined && !active.completed && !active.aborted
          ? toPromptItem(active, 'running')
          : null,
      queued: (this._queued.get(key) ?? []).map((state) =>
        toPromptItem(state, 'queued'),
      ),
    };
  }

  async submit(sid: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    await this._requireSession(sid);
    await this.core.rpc.resumeSession({ sessionId: sid });

    // Readiness gate. Throws AuthProvisioningRequired /
    // AuthTokenMissing / AuthModelNotResolved before we mint a prompt_id and
    // hand off to agent-core. Daemon route layer maps to 40110/40111/40113.
    await this.auth.ensureReady();

    const promptId = `prompt_${ulid()}`;
    const state = this._createPromptState(sid, promptId, body);
    const key = promptKey(sid, state.agentId);

    const existing = this._active.get(key);
    if (existing !== undefined && !existing.completed && !existing.aborted) {
      this._enqueue(sid, state);
      const item = toPromptItem(state, 'queued');
      this._publishSubmitted(sid, state, item);
      return item;
    }

    const item = toPromptItem(state, 'running');
    await this._startPrompt(sid, state, () => {
      this._publishSubmitted(sid, state, item);
    });
    return item;
  }

  async startBtw(sid: string): Promise<string> {
    await this._requireSession(sid);
    await this.core.rpc.resumeSession({ sessionId: sid });
    await this.auth.ensureReady();
    return this.core.rpc.startBtw({ sessionId: sid, agentId: MAIN_AGENT_ID });
  }

  async steer(sid: string, promptIds: readonly string[]): Promise<PromptSteerResult> {
    await this._requireSession(sid);
    if (promptIds.length === 0) {
      throw new PromptNotFoundError(sid, '');
    }
    const key = promptKey(sid, MAIN_AGENT_ID);
    const active = this._active.get(key);
    if (active === undefined || active.completed || active.aborted) {
      throw new PromptNotFoundError(sid, promptIds[0]!);
    }

    const queue = this._queued.get(key) ?? [];
    const selected: PromptState[] = [];
    for (const promptId of promptIds) {
      const state = queue.find((item) => item.promptId === promptId);
      if (state === undefined) {
        throw new PromptNotFoundError(sid, promptId);
      }
      selected.push(state);
    }

    const selectedIds = new Set(promptIds);
    const remaining = queue.filter((item) => !selectedIds.has(item.promptId));
    this._replaceQueue(sid, MAIN_AGENT_ID, remaining);

    try {
      await this.core.rpc.steer({
        sessionId: sid,
        agentId: MAIN_AGENT_ID,
        input: steerContentToCoreParts(selected),
      });
    } catch (error) {
      this._restoreSteeredQueueItems(sid, selected);
      throw error;
    }

    const event: SyntheticPromptSteeredEvent = {
      type: 'prompt.steered',
      agentId: MAIN_AGENT_ID,
      sessionId: sid,
      activePromptId: active.promptId,
      promptIds: [...promptIds],
      content: selected.flatMap((state) => state.body.content),
      steeredAt: new Date().toISOString(),
    };
    this.eventService.publish(event as unknown as Event);
    return { steered: true, prompt_ids: [...promptIds] };
  }

  private async _startPrompt(
    sid: string,
    state: PromptState,
    onStarted?: () => void,
  ): Promise<void> {
    const overridePatch = state.agentId === MAIN_AGENT_ID ? pickAgentStatePatch(state.body) : undefined;
    if (overridePatch !== undefined) {
      await this._ensureAgentStateBootstrapped(sid);
      await this._applyAgentStateInternal(sid, overridePatch, 'prompt', state.promptId);
    }

    const key = promptKey(sid, state.agentId);
    this._active.set(key, state);
    const input = contentToCoreParts(state.body.content);
    onStarted?.();

    // Fire-and-forget. agent-core streams events via the SDK side of the
    // RPC pair which lands on `BridgeClientAPI.emitEvent → IEventService.publish`.
    // The submit RPC returns synchronously (PromptPayload → void); errors
    // would manifest as later `error` events, not as a rejection here.
    try {
      this._logger.debug(
        { sid, promptId: state.promptId, agentId: state.agentId, partCount: input.length },
        '[DBG prompt-service.submit] -> core.rpc.prompt(...)',
      );
      await this.core.rpc.prompt({
        sessionId: sid,
        agentId: state.agentId,
        input,
      });
      this._logger.debug(
        { sid, promptId: state.promptId },
        '[DBG prompt-service.submit] core.rpc.prompt(...) resolved',
      );
    } catch (error) {
      // Clear our active-prompt state so the next submit succeeds; surface
      // the error to the route layer.
      if (this._active.get(key)?.promptId === state.promptId) {
        this._active.delete(key);
      }
      this._logger.debug(
        { sid, promptId: state.promptId, err: (error as Error)?.message ?? error },
        '[DBG prompt-service.submit] core.rpc.prompt(...) threw',
      );
      throw error;
    }
  }

  private _publishSubmitted(sid: string, state: PromptState, item: PromptSubmitResult): void {
    const event: SyntheticPromptSubmittedEvent = {
      type: 'prompt.submitted',
      agentId: state.agentId,
      sessionId: sid,
      promptId: item.prompt_id,
      userMessageId: item.user_message_id,
      status: item.status,
      content: item.content,
      createdAt: item.created_at,
    };
    this.eventService.publish(event);
  }

  private _publishAborted(sid: string, agentId: string, pid: string): void {
    const ev: SyntheticPromptAbortedEvent = {
      type: 'prompt.aborted',
      agentId,
      sessionId: sid,
      promptId: pid,
      abortedAt: new Date().toISOString(),
    };
    // Fire typed listeners BEFORE publishing the synth event: PromptService
    // must still trigger the typed event THEN call publish() for the synthetic
    // event.
    this._onDidAbort.fire(ev);
    this.eventService.publish(ev as unknown as Event);
  }

  async abort(sid: string, pid: string): Promise<PromptAbortResult> {
    await this._requireSession(sid);
    const key = promptKey(sid, MAIN_AGENT_ID);
    const state = this._active.get(key);
    if (state !== undefined && state.promptId === pid) {
      if (state.completed || state.aborted) {
        throw new PromptAlreadyCompletedError(sid, pid);
      }
      // Mark aborted optimistically — _handleBusEvent will not re-synthesize.
      state.aborted = true;
      try {
        const cancelArgs: { sessionId: string; agentId: string; turnId?: number } = {
          sessionId: sid,
          agentId: state.agentId,
        };
        if (state.turnId !== null) cancelArgs.turnId = state.turnId;
        await this.core.rpc.cancel(cancelArgs);
      } catch (error) {
        // Roll back the optimistic flag so the route surfaces a real error;
        // the caller will see a 50001 (internal) via the global error handler.
        state.aborted = false;
        throw error;
      }
      this._publishAborted(sid, state.agentId, pid);
      return { aborted: true };
    }

    // Queued prompt: remove it from the queue and synthesize prompt.aborted.
    // No core RPC is needed because the prompt was never dispatched.
    const queue = this._queued.get(key) ?? [];
    const index = queue.findIndex((item) => item.promptId === pid);
    if (index === -1) {
      throw new PromptNotFoundError(sid, pid);
    }
    queue.splice(index, 1);
    if (queue.length === 0) {
      this._queued.delete(key);
    }
    this._publishAborted(sid, MAIN_AGENT_ID, pid);
    return { aborted: true };
  }

  async abortBySession(sid: string): Promise<PromptAbortResult> {
    await this._requireSession(sid);
    const state = this._active.get(promptKey(sid, MAIN_AGENT_ID));
    if (state !== undefined && !state.completed && !state.aborted) {
      // Normal prompt path: let abort() handle turnId mapping and event synthesis.
      return this.abort(sid, state.promptId);
    }
    // No daemon-managed active prompt. Cancel whatever agent-core turn is
    // running (e.g. a skill activation) without requiring a turnId.
    // TurnFlow.cancel(undefined) is a safe no-op when idle.
    await this.core.rpc.cancel({ sessionId: sid, agentId: MAIN_AGENT_ID });
    return { aborted: true };
  }

  getCurrentPromptId(sid: string): string | undefined {
    const state = this._active.get(promptKey(sid, MAIN_AGENT_ID));
    if (state === undefined || state.completed || state.aborted) {
      return undefined;
    }
    return state.promptId;
  }

  /**
   * `IPromptService.applyAgentState` — entry point shared by
   * `submit` (per-turn override) and `SessionService.update`
   * (`POST /sessions/{sid}/profile`). Validates the session exists,
   * bootstraps the shadow lazily, then diff-dispatches each non-shadow
   * field through the matching `core.rpc.*` setter. Dispatch-log
   * entries are tagged with the `source` so downstream observers can
   * tell prompt-driven and profile-driven setters apart.
   *
   * No-op when every field matches the shadow; throws on setter failure
   * (the caller / route layer surfaces the error). Empty `patch` is
   * accepted and bootstraps nothing — useful for SessionService.update
   * paths that need to no-op cleanly when the body carries no runtime
   * controls.
   */
  async applyAgentState(
    sid: string,
    patch: AgentStatePatch,
    source: AgentStateSource,
    promptId?: string,
  ): Promise<void> {
    if (!hasAnyAgentStateField(patch)) return;
    await this._requireSession(sid);
    await this._ensureAgentStateBootstrapped(sid);
    await this._applyAgentStateInternal(sid, patch, source, promptId ?? '');
  }

  // --- IPromptService typed event accessors ---------------------------------
  //
  // `onDidComplete` / `onDidAbort` are declared above as `Emitter<T>.event`
  // getters; consumers subscribe via `svc.onDidComplete(handler)` (returns
  // IDisposable) and own the detach lifetime through
  // `Disposable._register(...)`.

  // --- Stateless session controls (per-request diff dispatch) ---------------

  /**
   * Seed the per-session shadow from `getConfig` / `getPermission` /
   * `getPlan` if not yet bootstrapped. Idempotent across submits within a
   * session lifetime; cleared on `ISessionService.onDidClose`.
   *
   * The three RPCs run in parallel — they share no preconditions.
   */
  private async _ensureAgentStateBootstrapped(sid: string): Promise<void> {
    if (this._agentState.has(sid)) return;
    const [config, permission, plan, swarmMode] = await Promise.all([
      this.core.rpc.getConfig({ sessionId: sid, agentId: MAIN_AGENT_ID }),
      this.core.rpc.getPermission({ sessionId: sid, agentId: MAIN_AGENT_ID }),
      this.core.rpc.getPlan({ sessionId: sid, agentId: MAIN_AGENT_ID }),
      this.core.rpc.getSwarmMode({ sessionId: sid, agentId: MAIN_AGENT_ID }),
    ]);
    const snapshot: AgentStateSnapshot = {};
    if (config.modelAlias !== undefined) snapshot.model = config.modelAlias;
    // `AgentConfigData.thinkingLevel` is typed `string` but in practice
    // takes one of the `PromptThinking` literals (`off|low|...|max`); the
    // narrow cast lets diff comparisons stay typed without forcing
    // protocol to import from agent-core.
    snapshot.thinking = config.thinkingLevel as PromptThinking;
    snapshot.permissionMode = permission.mode;
    snapshot.planMode = plan !== null;
    snapshot.swarmMode = swarmMode;
    this._agentState.set(sid, snapshot);
  }

  /**
   * Diff-dispatch: for each of the four controls present on `patch`,
   * call the matching `core.rpc.*` setter ONLY when the value differs
   * from the shadow. Each setter runs serially so any failure surfaces
   * to the caller. Each successful setter also appends to the per-session
   * dispatch-log ring buffer; absence of an entry between two prompts is
   * the proof that the shadow suppressed a redundant dispatch.
   *
   * Pre-condition: `_ensureAgentStateBootstrapped(sid)` already ran (the
   * shadow Map carries `sid`). Callers must guard.
   */
  private async _applyAgentStateInternal(
    sid: string,
    patch: AgentStatePatch,
    source: AgentStateSource,
    promptId: string,
  ): Promise<void> {
    const shadow = this._agentState.get(sid);
    if (shadow === undefined) {
      // Bootstrap is a precondition; a missing shadow here is a bug,
      // not a recoverable state.
      throw new Error(
        `PromptService._applyAgentStateInternal: shadow not bootstrapped for sid=${sid}`,
      );
    }
    const agentId = MAIN_AGENT_ID;

    if (patch.model !== undefined && patch.model !== shadow.model) {
      const payload = { sessionId: sid, agentId, model: patch.model };
      await this.core.rpc.setModel(payload);
      shadow.model = patch.model;
      this._recordDispatch(sid, 'setModel', payload, promptId, source);
    }
    if (patch.thinking !== undefined && patch.thinking !== shadow.thinking) {
      const payload = { sessionId: sid, agentId, level: patch.thinking as PromptThinking };
      await this.core.rpc.setThinking(payload);
      shadow.thinking = patch.thinking;
      this._recordDispatch(sid, 'setThinking', payload, promptId, source);
    }
    if (
      patch.permission_mode !== undefined &&
      patch.permission_mode !== shadow.permissionMode
    ) {
      const payload = {
        sessionId: sid,
        agentId,
        mode: patch.permission_mode as PermissionMode,
      };
      await this.core.rpc.setPermission(payload);
      shadow.permissionMode = patch.permission_mode as PermissionMode;
      this._recordDispatch(sid, 'setPermission', payload, promptId, source);
    }
    if (patch.plan_mode !== undefined && patch.plan_mode !== shadow.planMode) {
      const payload = { sessionId: sid, agentId };
      if (patch.plan_mode) {
        await this.core.rpc.enterPlan(payload);
        this._recordDispatch(sid, 'enterPlan', payload, promptId, source);
      } else {
        // `cancelPlan({id?})` accepts an omitted id — `PlanMode.cancel`
        // clears whatever id is currently active. Shadow doesn't track
        // ids, so we always omit.
        await this.core.rpc.cancelPlan(payload);
        this._recordDispatch(sid, 'cancelPlan', payload, promptId, source);
      }
      shadow.planMode = patch.plan_mode;
    }

    // Swarm mode toggle. enterSwarm/exitSwarm are idempotent no-throw on
    // the agent side; we still guard with the shadow to avoid redundant
    // dispatch-log entries.
    if (patch.swarm_mode !== undefined && patch.swarm_mode !== shadow.swarmMode) {
      const payload = { sessionId: sid, agentId };
      if (patch.swarm_mode) {
        const enterPayload = { ...payload, trigger: 'manual' as const };
        await this.core.rpc.enterSwarm(enterPayload);
        this._recordDispatch(sid, 'enterSwarm', enterPayload, promptId, source);
      } else {
        await this.core.rpc.exitSwarm(payload);
        this._recordDispatch(sid, 'exitSwarm', payload, promptId, source);
      }
      shadow.swarmMode = patch.swarm_mode;
    }

    // Goal creation. createGoal throws KimiError on invalid input
    // (GOAL_OBJECTIVE_EMPTY, GOAL_OBJECTIVE_TOO_LONG) or when a goal is
    // already active without replace=true (GOAL_ALREADY_EXISTS). Let these
    // propagate so the REST route layer can map them to the right code.
    if (patch.goal_objective !== undefined) {
      const payload = {
        sessionId: sid,
        agentId,
        objective: patch.goal_objective,
        replace: false,
      };
      await this.core.rpc.createGoal(payload);
      this._recordDispatch(sid, 'createGoal', payload, promptId, source);
      // `goal_objective` is a one-shot creation trigger; do not keep it on
      // the shadow.
    }

    // Goal lifecycle control. Each action maps to its own RPC; errors
    // (GOAL_NOT_FOUND, GOAL_STATUS_INVALID, GOAL_NOT_RESUMABLE) propagate.
    if (patch.goal_control !== undefined) {
      const payload = { sessionId: sid, agentId };
      switch (patch.goal_control) {
        case 'pause':
          await this.core.rpc.pauseGoal(payload);
          this._recordDispatch(sid, 'pauseGoal', payload, promptId, source);
          break;
        case 'resume':
          await this.core.rpc.resumeGoal(payload);
          this._recordDispatch(sid, 'resumeGoal', payload, promptId, source);
          break;
        case 'cancel':
          await this.core.rpc.cancelGoal(payload);
          this._recordDispatch(sid, 'cancelGoal', payload, promptId, source);
          break;
      }
      // `goal_control` is a one-shot action trigger; do not keep it on the
      // shadow.
    }
  }

  /**
   * Append a dispatch entry to the per-session ring buffer, evicting the
   * oldest entry when the cap is hit. Called only from
   * `_applyAgentStateInternal` after the underlying setter resolves
   * successfully.
   */
  private _recordDispatch(
    sid: string,
    kind: PromptDispatchLogEntry['kind'],
    payload: Record<string, unknown>,
    promptId: string,
    source: AgentStateSource,
  ): void {
    let buf = this._dispatchLog.get(sid);
    if (buf === undefined) {
      buf = [];
      this._dispatchLog.set(sid, buf);
    }
    buf.push({
      ts: new Date().toISOString(),
      kind,
      // Shallow copy so future shadow mutations / callers can't mutate
      // the recorded payload retroactively.
      payload: { ...payload },
      promptId,
      source,
    });
    if (buf.length > DISPATCH_LOG_CAP) {
      buf.splice(0, buf.length - DISPATCH_LOG_CAP);
    }
  }

  // --- Private event handler (replaces IPromptLifecycleObserver) ----------

  private _handleBusEvent(event: Event): void {
    const sid = (event as { sessionId?: string }).sessionId;
    if (sid === undefined || sid === '') return;

    // Mirror live `agent.status.updated` into the per-session shadow. This
    // keeps the shadow honest when out-of-band callers (TUI / SDK / agent
    // itself) mutate `model` / `permission` / `planMode` between prompts.
    // Only fields present on the event update the shadow — `thinking` is
    // not carried here and stays whatever the last `setThinking` (or
    // bootstrap getConfig) put there.
    if (isAgentStatusUpdated(event)) {
      const shadow = this._agentState.get(sid);
      if (shadow !== undefined) {
        if (event.model !== undefined) shadow.model = event.model;
        if (event.permission !== undefined) shadow.permissionMode = event.permission;
        if (event.planMode !== undefined) shadow.planMode = event.planMode;
      }
      // status events are also published normally; fall through to allow
      // other event-type handlers below — but there's no overlap today.
      return;
    }

    const agentId = (event as { agentId?: string }).agentId ?? MAIN_AGENT_ID;
    const key = promptKey(sid, agentId);
    const state = this._active.get(key);
    if (state === undefined) return;

    if (isTurnStarted(event)) {
      // Capture the FIRST turn.started after submit as the "top-level" turn.
      // Subsequent nested turns (e.g. subagent) carry different turnId values
      // and are NOT promoted to the prompt's top-level.
      state.turnId ??= event.turnId;
      return;
    }

    if (isTurnEnded(event)) {
      // Only fire on the top-level turn end. Nested turn.ended events fly
      // through without prompt-level synthesis.
      if (state.turnId === null || event.turnId !== state.turnId) return;

      // If we already synthesized via abort RPC, don't double-emit. Mark
      // completed to prevent stale lookups, but emit nothing.
      if (state.aborted) {
        this._active.delete(key);
        void this._startNextQueued(sid, state.agentId);
        return;
      }

      const reason = event.reason;
      if (reason === 'cancelled') {
        // The model produced a cancellation that we didn't initiate via
        // abort RPC (or it slipped past the optimistic flag). Synthesize
        // prompt.aborted.
        state.aborted = true;
        const synth: SyntheticPromptAbortedEvent = {
          type: 'prompt.aborted',
          agentId: state.agentId,
          sessionId: sid,
          promptId: state.promptId,
          abortedAt: new Date().toISOString(),
        };
        this._active.delete(key);
        // Fire typed listeners BEFORE publishing the synth event.
        this._onDidAbort.fire(synth);
        this.eventService.publish(synth as unknown as Event);
        void this._startNextQueued(sid, state.agentId);
        return;
      }

      state.completed = true;
      const synth: SyntheticPromptCompletedEvent = {
        type: 'prompt.completed',
        agentId: state.agentId,
        sessionId: sid,
        promptId: state.promptId,
        finishedAt: new Date().toISOString(),
        reason: reason === 'failed' ? 'failed' : 'completed',
      };
      this._active.delete(key);
      // Fire typed listeners BEFORE publishing the synth event.
      this._onDidComplete.fire(synth);
      this.eventService.publish(synth as unknown as Event);
      void this._startNextQueued(sid, state.agentId);
    }
  }

  /**
   * Test helper — peek at active prompt state.
   */
  _activeForTest(sid: string): Readonly<PromptState> | undefined {
    const state = this._active.get(promptKey(sid, MAIN_AGENT_ID));
    return state === undefined ? undefined : { ...state };
  }

  /**
   * Read the current runtime-controls shadow for a session, if it has been
   * bootstrapped. Returns a copy so callers cannot mutate internal state.
   */
  getAgentStateSnapshot(sid: string): AgentStateSnapshot | undefined {
    const snap = this._agentState.get(sid);
    return snap === undefined ? undefined : { ...snap };
  }

  /**
   * Test helper — peek at the per-session stateless-controls shadow.
   * Undefined before first submit on a session.
   */
  _agentStateForTest(sid: string): Readonly<AgentStateSnapshot> | undefined {
    return this.getAgentStateSnapshot(sid);
  }

  /**
   * Test / debug helper — return the per-session dispatch-log ring buffer
   * (newest-last). Returns `undefined` when the session has never
   * triggered a setter; an empty array means "saw submits but every
   * field matched the shadow". The daemon's `/debug/prompts/{sid}/dispatch-log`
   * route consumes this; unit tests assert against it directly.
   */
  _dispatchLogForTest(sid: string): readonly PromptDispatchLogEntry[] | undefined {
    const buf = this._dispatchLog.get(sid);
    if (buf === undefined) return undefined;
    // Defensive copy — callers may iterate while a parallel submit
    // pushes new entries.
    return buf.slice();
  }

  /**
   * Test helper — inject an active prompt record. Used by daemon e2e tests
   * that need to exercise the lifecycle-synthesis path WITHOUT driving a
   * real `core.rpc.prompt(...)` call (which would require an in-memory
   * KimiCore loaded with provider credentials). Not part of the public
   * contract; the underscore prefix is a "do not use in prod" signal.
   */
  _injectActiveForTest(sid: string, promptId: string, turnId: number | null): void {
    this._active.set(promptKey(sid, MAIN_AGENT_ID), {
      agentId: MAIN_AGENT_ID,
      promptId,
      userMessageId: `msg_${sid}_pending_${promptId}`,
      body: { content: [{ type: 'text', text: 'test' }] },
      createdAt: new Date().toISOString(),
      turnId,
      completed: false,
      aborted: false,
    });
  }

  // --- internals -----------------------------------------------------------

  private _createPromptState(
    sid: string,
    promptId: string,
    body: PromptSubmission,
  ): PromptState {
    return {
      agentId: body.agent_id ?? MAIN_AGENT_ID,
      promptId,
      userMessageId: `msg_${sid}_pending_${promptId}`,
      body,
      createdAt: new Date().toISOString(),
      turnId: null,
      completed: false,
      aborted: false,
    };
  }

  private _enqueue(sid: string, state: PromptState): void {
    const key = promptKey(sid, state.agentId);
    let queue = this._queued.get(key);
    if (queue === undefined) {
      queue = [];
      this._queued.set(key, queue);
    }
    queue.push(state);
  }

  private _replaceQueue(sid: string, agentId: string, queue: PromptState[]): void {
    const key = promptKey(sid, agentId);
    if (queue.length === 0) {
      this._queued.delete(key);
      return;
    }
    this._queued.set(key, queue);
  }

  private _restoreSteeredQueueItems(sid: string, selected: readonly PromptState[]): void {
    const queue = this._queued.get(promptKey(sid, MAIN_AGENT_ID)) ?? [];
    const queueIds = new Set(queue.map((state) => state.promptId));
    const missing = selected.filter((state) => !queueIds.has(state.promptId));
    this._replaceQueue(sid, MAIN_AGENT_ID, [...missing, ...queue]);
  }

  private async _startNextQueued(sid: string, agentId = MAIN_AGENT_ID): Promise<void> {
    const key = promptKey(sid, agentId);
    const active = this._active.get(key);
    if (active !== undefined && !active.completed && !active.aborted) return;
    const queue = this._queued.get(key);
    const next = queue?.shift();
    if (queue !== undefined && queue.length === 0) {
      this._queued.delete(key);
    }
    if (next === undefined) return;
    await this._startPrompt(sid, next).catch(() => {
      void this._startNextQueued(sid, agentId);
    });
  }

  private async _requireSession(sid: string): Promise<void> {
    const all = await this.core.rpc.listSessions({});
    if (!all.some((s) => s.id === sid)) {
      throw new SessionNotFoundError(sid);
    }
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    this._active.clear();
    this._queued.clear();
    this._agentState.clear();
    this._dispatchLog.clear();
    // `_onDidComplete` and `_onDidAbort` are registered via `this._register(...)`,
    // so `super.dispose()` flushes their listeners.
    super.dispose();
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected (@ICoreProcessService / @IEventService / @IAuthSummaryService);
// `staticArguments = []`. `supportsDelayedInstantiation = false` preserves
// current reverse-dispose semantics.
registerSingleton(IPromptService, PromptService, InstantiationType.Delayed);
