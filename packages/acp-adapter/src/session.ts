import {
  RequestError,
  type AgentSideConnection,
  type ClientCapabilities,
  type ContentBlock,
  type ModelId,
  type PromptResponse,
  type SessionModeId,
} from '@agentclientprotocol/sdk';
import { LocalKaos, runWithKaos, type Kaos } from '@moonshot-ai/kaos';
import {
  ErrorCodes,
  log,
  type ApprovalRequest,
  type ApprovalResponse,
  type ContextMessage,
  type KimiErrorPayload,
  type KimiHarness,
  type QuestionAnswers,
  type QuestionRequest,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';

import {
  approvalRequestToPermissionOptions,
  attachSelectedLabel,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
} from './approval';
import { buildSessionConfigOptions } from './config-options';
import { acpBlocksToPromptParts } from './convert';
import { AcpKaos } from './kaos-acp';
import {
  acpToolCallId,
  assistantDeltaToSessionUpdate,
  configOptionUpdateNotification,
  planFromDisplayBlock,
  stringifyArgs,
  thinkingDeltaToSessionUpdate,
  toolCallDeltaToSessionUpdate,
  toolCallLazyCreateToSessionUpdate,
  toolCallStartedUpgradeToSessionUpdate,
  toolCallStartToSessionUpdate,
  toolProgressToSessionUpdate,
  toolResultToSessionUpdate,
  turnEndReasonToStopReason,
} from './events-map';
import { acpModeToToggles, DEFAULT_MODE_ID, isAcpModeId, type AcpModeId } from './modes';
import { outcomeToQuestionAnswer, questionItemToPermissionOptions } from './question';

/**
 * Telemetry sink threaded into {@link AcpSession} so reverse-RPC bridges
 * (`handleApproval`, `handleQuestion`) can emit PII-free breadcrumbs
 * without reaching back through the harness. Optional — when absent,
 * the session is a silent passthrough (matches the Phase 11.2 stub-
 * tolerant pattern in `server.ts:trackSessionStarted`).
 */
export type TelemetryTrackFn = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

/**
 * Adapter-side wrapper around a {@link Session} from the Kimi node SDK.
 *
 * Stored in `AcpServer.sessions` so subsequent `session/prompt` and
 * `session/cancel` calls can locate the underlying SDK session by its
 * ACP `sessionId`. The `conn` field holds the {@link AgentSideConnection}
 * so `prompt()` can emit `session/update` chunks back to the client
 * without re-plumbing the connection through the call stack.
 */
export class AcpSession {
  /**
   * The most recently observed turnId from the underlying SDK event
   * stream. Used by {@link handleApproval} to compose the prefixed ACP
   * `toolCallId` (`${turnId}:${rawId}`) so the client can correlate the
   * permission prompt with the tool card it has already rendered.
   *
   * Updated inside the existing `onEvent` listener in {@link prompt}
   * (any event carrying a numeric `turnId` advances the value), and
   * reset to `undefined` on `turn.ended`. Approval flows are gated by
   * the SDK on the active turn so a stale value is effectively
   * unreachable in practice; the `undefined` fallback in
   * `buildPermissionToolCallUpdate` exists for defence-in-depth.
   */
  private currentTurnId: number | undefined = undefined;

  /**
   * Lazily-built inner {@link Kaos} (a {@link LocalKaos}) that the
   * per-prompt {@link AcpKaos} wraps. Cached on the session so we don't
   * re-probe the environment on every prompt. Built lazily because the
   * majority of sessions (those whose client does not advertise the FS
   * capability) never need it.
   */
  private innerKaos: Kaos | undefined = undefined;

  /**
   * The adapter-side authoritative current BASE model id (no
   * `,thinking` suffix) for the `configOptions` model picker (PLAN D11).
   * Updated by {@link setModel} after the SDK call lands. Phase 15
   * decoupled thinking from the model id — see
   * {@link currentThinkingEnabledInternal} — so this field never carries
   * a `,thinking` suffix even when the client originally sent one
   * through `unstable_setSessionModel`.
   */
  private currentModelIdInternal: string;

  /**
   * The adapter-side authoritative current thinking-toggle state.
   * Phase 15 split this out of the model id so the client renders a
   * separate boolean `SessionConfigOption` (the spec's
   * `'thought_level'` category) instead of an inlined `,thinking`
   * variant row in the model dropdown. Updated by {@link setThinking}
   * and by {@link setModel} when the caller passed a merged
   * `${id},thinking` form (legacy `unstable_setSessionModel`
   * compatibility).
   *
   * Maps to the SDK's effort-level string at the boundary:
   * `true` → `'high'` (the typical default for kimi-code), `false`
   * → `'off'`. The granularity of `'low' | 'medium' | 'xhigh' | 'max'`
   * is intentionally not surfaced — the ACP `thinking` axis is binary
   * (Phase 16 wire form: 2-entry `select` `off` / `on`; pre-Phase-16
   * was `SessionConfigBoolean`).
   */
  private currentThinkingEnabledInternal = false;

  /**
   * The adapter-side authoritative current mode id. Updated by
   * {@link setMode} after both SDK toggles (`setPlanMode` + `setPermission`)
   * land so the next `config_option_update` notification reflects the
   * new mode. Always one of the four PLAN D9 literals.
   */
  private currentModeIdInternal: AcpModeId = DEFAULT_MODE_ID;

  constructor(
    readonly conn: AgentSideConnection,
    readonly session: Session,
    /**
     * Capabilities the client declared during `initialize`. Passed in
     * by `AcpServer.newSession` so `prompt()` can decide whether to
     * route file I/O through ACP reverse-RPC (`fs.readTextFile` /
     * `fs.writeTextFile`) or fall back to local FS. Optional because
     * adapter-level unit tests still construct `AcpSession` with the
     * two-arg form; absence means "no FS reverse-RPC".
     */
    private readonly clientCapabilities?: ClientCapabilities,
    /**
     * Optional telemetry sink. `AcpServer` threads in
     * `harness.track?.bind(harness)` (Phase 11.2 PII-free pattern); unit
     * tests that construct `AcpSession` with a stub session leave this
     * undefined and the bridges become silent. Internal emits use the
     * {@link safeTrack} guard so a missing or throwing sink can never
     * crash a reverse-RPC handler.
     */
    private readonly track?: TelemetryTrackFn,
    /**
     * Initial value of the adapter-side current BASE model id, supplied by
     * the server when creating / loading the session so the first
     * `config_option_update` snapshot matches the response's
     * `configOptions.model.currentValue`. Defaults to empty string when
     * absent (adapter-level unit tests). Phase 15: must be the bare model
     * key (no `,thinking` suffix); thinking is carried separately by
     * {@link initialThinkingEnabled}.
     */
    initialModelId?: string,
    /**
     * Harness reference used by {@link emitConfigOptionUpdate} to
     * re-list available models when emitting the post-change snapshot.
     * Optional because adapter-level unit tests build `AcpSession`
     * without a harness; when absent, `emitConfigOptionUpdate` is a
     * silent no-op (matches the {@link safeTrack} pattern). Phase 14.3
     * introduces this so the model + mode picker funnel can refresh
     * the full SessionConfigOption[] snapshot on every change.
     */
    private readonly harness?: KimiHarness,
    /**
     * Initial value of the adapter-side thinking-toggle state, supplied
     * by the server when creating / loading the session. Phase 15
     * introduces this so resumed sessions whose persisted
     * `thinkingLevel` was non-`'off'` start with the toggle on.
     * Defaults to `false` when absent.
     */
    initialThinkingEnabled?: boolean,
  ) {
    this.currentModelIdInternal = initialModelId ?? '';
    this.currentThinkingEnabledInternal = initialThinkingEnabled ?? false;
    // Register the approval bridge once, at session-construction time —
    // NOT per-prompt — because `setApprovalHandler` is scoped to the
    // SDK session, not the individual turn. The handler captures `this`
    // lexically; the arrow form avoids re-binding on every event.
    //
    // Defensive: the real `Session` class always provides this method,
    // but partial-stub `Session` instances used in adapter-level unit
    // tests may omit it. Treat absence as "no approval channel" rather
    // than crashing the constructor — the SDK still works end-to-end,
    // just without reverse-RPC approvals.
    if (typeof this.session.setApprovalHandler === 'function') {
      this.session.setApprovalHandler((req) => this.handleApproval(req));
    }
    // Same pattern as the approval handler, but for the AskUserQuestion
    // reverse-RPC channel (Phase 13.1). Pre-Phase-13 builds of the SDK
    // do not expose `setQuestionHandler`, and unit-test stubs may omit
    // it; the `typeof === 'function'` guard keeps both cases working.
    if (typeof this.session.setQuestionHandler === 'function') {
      this.session.setQuestionHandler(async (req) => this.handleQuestion(req));
    }
  }

  /** ACP-level session identifier — matches the underlying SDK session id. */
  get id(): string {
    return this.session.id;
  }

  /**
   * Adapter-side authoritative current BASE model id (no `,thinking`
   * suffix), used by {@link AcpServer.setSessionConfigOption} to build
   * the response's `configOptions` snapshot after a model / mode /
   * thinking change.
   */
  get currentModelId(): string {
    return this.currentModelIdInternal;
  }

  /**
   * Adapter-side authoritative thinking-toggle state, used by
   * {@link AcpServer.setSessionConfigOption} to build the response's
   * `configOptions` snapshot.
   */
  get currentThinkingEnabled(): boolean {
    return this.currentThinkingEnabledInternal;
  }

  /**
   * Adapter-side authoritative current mode id, used by
   * {@link AcpServer.setSessionConfigOption} to build the response's
   * `configOptions` snapshot after a model / mode change.
   */
  get currentModeId(): AcpModeId {
    return this.currentModeIdInternal;
  }

  /**
   * Forward an ACP `session/cancel` notification to the underlying SDK
   * session. The SDK's `cancel()` is idempotent at the RPC layer, so
   * repeated cancels (or a cancel on an already-finished turn) are
   * acceptable.
   */
  async cancel(): Promise<void> {
    await this.session.cancel();
  }

  /**
   * Forward an ACP `session/set_model` (`unstable_setSessionModel`)
   * request to the underlying SDK session.
   *
   * ACP allows model identifiers like `"kimi-k2,thinking"` where the
   * `,thinking` suffix signals "always-thinking" mode (mirrors the
   * Python ref's `_ModelIDConv.from_acp_model_id` at
   * `kimi-cli/src/kimi_cli/acp/server.py:425-433`). Phase 15 decoupled
   * thinking from the model id at the ACP surface — it's now its own
   * `thought_level` config option (Phase 16 wire form: 2-entry `select`
   * `off` / `on`) — but this legacy compat path is
   * kept: when the caller sends a merged form, we split it into the
   * bare model key (forwarded to `Session.setModel`) plus a thinking
   * flag (forwarded to `Session.setThinking`).
   *
   * Wire semantics:
   *  - `'kimi-v2'`           → setModel('kimi-v2'); thinking state unchanged.
   *  - `'kimi-v2,thinking'`  → setModel('kimi-v2') + setThinking('high');
   *    thinking state flips on.
   *
   * Note the asymmetry: a bare model id does NOT turn thinking OFF.
   * That keeps the model / thinking axes orthogonal — model changes
   * preserve thinking state. To explicitly disable thinking, the
   * client must call `setSessionConfigOption({ configId: 'thinking',
   * value: false })` (or send `setThinking('off')` directly through
   * the SDK channel, but the ACP surface only exposes the boolean).
   *
   * `currentModelIdInternal` is updated to the bare key — the snapshot
   * therefore never carries a `,thinking` suffix in the model option's
   * `currentValue`. Thinking visibility in the snapshot is governed
   * by `currentThinkingEnabledInternal` and
   * {@link buildSessionConfigOptions}'s `thinkingSupported` gate.
   *
   * Unknown model errors bubble up from the SDK as-is; the caller in
   * `AcpServer.unstable_setSessionModel` decides how to translate them.
   */
  async setModel(modelId: ModelId): Promise<void> {
    const suffix = ',thinking';
    const hasSuffix = modelId.endsWith(suffix);
    const baseKey = hasSuffix ? modelId.slice(0, -suffix.length) : modelId;
    await this.session.setModel(baseKey);
    if (hasSuffix && typeof this.session.setThinking === 'function') {
      await this.session.setThinking(THINKING_ON_LEVEL);
      this.currentThinkingEnabledInternal = true;
    }
    this.currentModelIdInternal = baseKey;
    await this.emitConfigOptionUpdate();
  }

  /**
   * Forward an ACP thinking-toggle change to the underlying SDK.
   *
   * Phase 15 introduces this as the new canonical channel for the
   * thinking axis. Boolean → effort-level mapping:
   *  - `true`  → `Session.setThinking('high')` (kimi-code's typical
   *    default; the agent-core `resolveThinkingEffort` would also
   *    coerce a missing config to `'high'`).
   *  - `false` → `Session.setThinking('off')`.
   *
   * Tolerant to partial-stub `Session` instances (adapter-level unit
   * tests construct minimal fakes that may omit `setThinking`): when
   * the method is missing we still update the adapter-side toggle
   * state and emit the snapshot, so the ACP wire stays consistent —
   * the test simply doesn't observe an SDK call.
   *
   * Always emits a `config_option_update` notification afterwards so
   * the client sees the toggle reflect the new value, even if it
   * came in through the funnel and the response itself already
   * carries a fresh snapshot.
   */
  async setThinking(enabled: boolean): Promise<void> {
    if (typeof this.session.setThinking === 'function') {
      await this.session.setThinking(enabled ? THINKING_ON_LEVEL : THINKING_OFF_LEVEL);
    }
    this.currentThinkingEnabledInternal = enabled;
    await this.emitConfigOptionUpdate();
  }

  /**
   * Forward an ACP `session/set_mode` request to the underlying SDK
   * session.
   *
   * Phase 12.2 supports the full 4-mode taxonomy (PLAN D9 at
   * `PLAN.md:85-106`):
   *
   *  - `'default'` → `setPlanMode(false)` + `setPermission('manual')`
   *  - `'plan'`    → `setPlanMode(true)`  + `setPermission('manual')`
   *  - `'auto'`    → `setPlanMode(false)` + `setPermission('auto')`
   *  - `'yolo'`    → `setPlanMode(false)` + `setPermission('yolo')`
   *
   * Order inside every arm is `setPlanMode` → `setPermission` →
   * `emitConfigOptionUpdate`. The dispatch table lives in
   * {@link acpModeToToggles} so the registry of modes and the toggles
   * each mode maps to stay co-located.
   *
   * Phase 14.3 (PLAN D11) emits the generic `config_option_update`
   * notification in place of Phase 12's `current_mode_update` — model
   * and mode pickers share the same notification channel now so a
   * client that listens for either change has exactly one subscription
   * point.
   *
   * No idempotency optimisation (PLAN D9 line 105): even if the client
   * re-asserts the current mode, both SDK calls fire and a fresh
   * `config_option_update` notification is emitted.
   *
   * Error policy:
   *  - Unknown `modeId` → JSON-RPC `invalid_params` (-32602) BEFORE any
   *    SDK call, so the client sees a structured rejection rather than
   *    a partial state change.
   *  - SDK errors from `setPlanMode` or `setPermission` propagate
   *    as-is up to {@link AcpServer.setSessionMode}. When either throws,
   *    the `config_option_update` notification is suppressed (the client
   *    will see the rejection and can re-query state).
   */
  async setMode(modeId: SessionModeId): Promise<void> {
    if (!isAcpModeId(modeId)) {
      throw RequestError.invalidParams({ modeId }, `Unknown sessionModeId: ${modeId}`);
    }
    const { plan, permission } = acpModeToToggles(modeId);
    await this.session.setPlanMode(plan);
    await this.session.setPermission(permission);
    this.currentModeIdInternal = modeId;
    await this.emitConfigOptionUpdate();
  }

  /**
   * Push a `config_option_update` session notification carrying the
   * full {@link SessionConfigOption}[] snapshot computed from the
   * adapter-side `currentModelId` + `currentModeId` authoritative state.
   *
   * Called from {@link setModel} and {@link setMode} after the SDK
   * toggle(s) succeed. Tolerant to missing `harness` (adapter-level
   * unit tests construct `AcpSession` without one): when absent, the
   * snapshot cannot be assembled and the emit is silently skipped so
   * the SDK call path still completes. The failure mode is symmetric
   * to {@link safeTrack}.
   *
   * Errors during the underlying `listModelsFromHarness` call or
   * the `sessionUpdate` push are caught and logged at `warn` — same
   * policy as {@link emitAvailableCommandsUpdate}: pushing a session
   * update is a streaming concern, not load-bearing for the SDK call
   * that triggered it.
   */
  private async emitConfigOptionUpdate(): Promise<void> {
    if (!this.harness) return;
    try {
      const snapshot = await buildSessionConfigOptions(
        this.harness,
        this.currentModelIdInternal,
        this.currentThinkingEnabledInternal,
        this.currentModeIdInternal,
      );
      await this.conn.sessionUpdate(configOptionUpdateNotification(this.id, snapshot));
    } catch (err) {
      log.warn('acp: failed to emit config_option_update', {
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Replay the underlying SDK session's persisted history as a stream
   * of ACP `session/update` notifications.
   *
   * Used by `session/load` (`AcpServer.loadSession`) to bring a freshly
   * reattached client up to the same on-screen state it would have if
   * it had observed every prior `session/prompt` live. Replay is pure
   * event emission: no `onEvent` subscription, no `session.prompt()`
   * call, no Kaos. The method walks {@link Session.getResumeState}
   * (which the node SDK populates from the on-disk session snapshot
   * during `harness.resumeSession`) and synthesizes per-message
   * notifications:
   *
   *  - role `user`         → `user_message_chunk` per text {@link ContentPart}.
   *  - role `assistant`    → `agent_message_chunk` / `agent_thought_chunk`
   *    per text/think content, plus a `tool_call` notification per
   *    `toolCalls` entry. A monotonically increasing synthetic `turnId`
   *    starts at 1 and bumps on each assistant message so the wire ids
   *    (`${turnId}:${toolCallId}`) match the live emission scheme used
   *    in {@link runPromptBody}.
   *  - role `tool`         → `tool_call_update` with `status: 'completed'`
   *    (or `'failed'` if the SDK marked the message as an error).
   *    `toolCallId` is looked up from the bookkeeping map populated when
   *    the originating assistant message was replayed.
   *
   * Tool calls whose result we never observe (interrupted turn,
   * truncated history) are emitted as `tool_call` only — they stay in
   * `in_progress` on the client, which is honest about the underlying
   * state. Likewise, tool messages whose originating `toolCallId` we
   * cannot find are skipped with a warning rather than crashing
   * replay; the latter would deny the rest of the session a chance to
   * surface.
   *
   * Errors thrown by individual `sessionUpdate` calls are caught and
   * logged so a single transient push failure does not truncate the
   * whole replay. The method awaits every push (unlike the live
   * `runPromptBody` fire-and-forget path) because replay is a one-shot
   * batch — completion ordering is what tells the caller (`loadSession`)
   * that the response is safe to return.
   */
  async replayHistory(agentId: string = 'main'): Promise<void> {
    const sessionId = this.id;
    const conn = this.conn;
    const resumeState = this.session.getResumeState?.();
    if (!resumeState) {
      log.warn('acp: replayHistory called on session without resume state', { sessionId });
      return;
    }
    const agent = resumeState.agents?.[agentId];
    if (!agent) {
      log.warn('acp: replayHistory found no agent state for replay', {
        sessionId,
        agentId,
        knownAgents: resumeState.agents ? Object.keys(resumeState.agents) : [],
      });
      return;
    }

    let turnId = 0;
    // Map from SDK toolCallId → owning synthetic turnId, populated when
    // the assistant message that issued the call is replayed and read
    // when the tool result lands. Lives for the duration of one replay.
    const toolCallTurnIds = new Map<string, number>();

    for (const message of agent.context.history) {
      try {
        await this.replayMessage(message, sessionId, conn, {
          getTurnId: () => turnId,
          beginAssistantTurn: () => {
            turnId += 1;
          },
          recordToolCall: (toolCallId) => {
            toolCallTurnIds.set(toolCallId, turnId);
          },
          lookupToolCallTurnId: (toolCallId) => toolCallTurnIds.get(toolCallId),
        });
      } catch (err) {
        log.warn('acp: replayHistory failed to emit a message; continuing', {
          sessionId,
          role: message.role,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Emit ACP session updates for a single historical {@link ContextMessage}.
   *
   * Factored out of {@link replayHistory} so the per-message dispatch
   * stays small and the outer loop is just the turnId/tool-bookkeeping
   * shell. Awaits every `sessionUpdate` so the replay completes in
   * order (see {@link replayHistory} JSDoc for the rationale).
   */
  private async replayMessage(
    message: ContextMessage,
    sessionId: string,
    conn: AgentSideConnection,
    ctx: {
      getTurnId: () => number;
      beginAssistantTurn: () => void;
      recordToolCall: (toolCallId: string) => void;
      lookupToolCallTurnId: (toolCallId: string) => number | undefined;
    },
  ): Promise<void> {
    switch (message.role) {
      case 'user':
        for (const part of message.content) {
          if (part.type === 'text' && part.text) {
            await conn.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: part.text },
              },
            });
          }
        }
        return;
      case 'assistant': {
        ctx.beginAssistantTurn();
        const turnId = ctx.getTurnId();
        for (const part of message.content) {
          await this.replayAssistantContentPart(part, sessionId, conn, turnId);
        }
        for (const toolCall of message.toolCalls ?? []) {
          ctx.recordToolCall(toolCall.id);
          await this.replaySyntheticToolCall(toolCall, sessionId, conn, turnId);
        }
        return;
      }
      case 'tool': {
        const rawToolCallId = message.toolCallId;
        if (!rawToolCallId) {
          // Tool result with no correlation id — log and skip rather
          // than crash. The on-disk session is the source of truth;
          // we cannot synthesize a missing id.
          log.warn('acp: replayHistory skipped tool message with no toolCallId', { sessionId });
          return;
        }
        const turnId = ctx.lookupToolCallTurnId(rawToolCallId);
        if (turnId === undefined) {
          log.warn('acp: replayHistory found tool message with no matching call', {
            sessionId,
            toolCallId: rawToolCallId,
          });
          return;
        }
        const isError = message.isError === true;
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: acpToolCallId(turnId, rawToolCallId),
            status: isError ? 'failed' : 'completed',
            content: toolMessageContentToAcpToolCallContent(message.content),
          },
        });
        return;
      }
      default:
        // system / unknown roles — ACP has no analogue; skip.
        return;
    }
  }

  private async replayAssistantContentPart(
    part: ContextMessage['content'][number],
    sessionId: string,
    conn: AgentSideConnection,
    turnId: number,
  ): Promise<void> {
    if (part.type === 'text' && part.text) {
      await conn.sessionUpdate(
        assistantDeltaToSessionUpdate(sessionId, {
          type: 'assistant.delta',
          turnId,
          delta: part.text,
        }),
      );
      return;
    }
    if (part.type === 'think' && part.think) {
      await conn.sessionUpdate(
        thinkingDeltaToSessionUpdate(sessionId, {
          type: 'thinking.delta',
          turnId,
          delta: part.think,
        }),
      );
      return;
    }
    // image_url / audio_url / video_url are skipped at this layer —
    // they belong to the user input side and ACP does not have a
    // dedicated assistant-media chunk.
  }

  private async replaySyntheticToolCall(
    toolCall: NonNullable<ContextMessage['toolCalls']>[number],
    sessionId: string,
    conn: AgentSideConnection,
    turnId: number,
  ): Promise<void> {
    const name = toolCall.name;
    const argsRaw = toolCall.arguments;
    const parsedArgs = parseToolCallArguments(argsRaw);
    await conn.sessionUpdate(
      toolCallStartToSessionUpdate(sessionId, {
        type: 'tool.call.started',
        turnId,
        toolCallId: toolCall.id,
        name,
        args: parsedArgs,
      }),
    );
  }

  /**
   * Run an ACP `session/prompt` against the underlying SDK session.
   *
   * Error mapping (Phase 11.1):
   *  - Auth-coded errors (`AUTH_LOGIN_REQUIRED`, `PROVIDER_AUTH_ERROR`)
   *    surface as `RequestError.authRequired()` so the ACP client can
   *    drive its own re-auth UX rather than a generic internal error.
   *  - Everything else becomes `RequestError.internalError(...)` with
   *    the stack/message logged to the agent log file but NOT exposed
   *    to the client (the JSON-RPC layer would otherwise leak details).
   *  - Auth-coded failures may arrive on TWO paths: a `turn.ended`
   *    event with `reason: 'failed'` and an `event.error` payload, OR
   *    a synchronous `session.prompt(...)` rejection. Both are
   *    routed through {@link mapPromptError} for parity.
   *
   * Subscribes to the session event stream; for every `assistant.delta`,
   * pushes an `agent_message_chunk` `session/update` notification to the
   * client. Resolves with the ACP `PromptResponse` (containing
   * `stopReason`) when a `turn.ended` event arrives.
   *
   * Cleanup invariants:
   *  - The event subscription is unsubscribed on EVERY exit path
   *    (success, cancel, failed turn, and `session.prompt()` rejection).
   *  - If `session.prompt()` rejects synchronously or asynchronously, the
   *    rejection is propagated as a `prompt` request error so the client
   *    sees a JSON-RPC error rather than a hung request.
   */
  async prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    const parts = acpBlocksToPromptParts(blocks);
    const sessionId = this.id;
    const conn = this.conn;

    // Decide whether to bridge file I/O through ACP for this prompt.
    // We honor the client's advertised capability surface only —
    // unsupported clients silently fall back to `LocalKaos`, which keeps
    // the rest of the codebase unaware of Phase 6.
    //
    // `runWithKaos` (NOT `setCurrentKaos`) is the correct primitive:
    // `enterWith` persists for the rest of the current async context
    // with no proper restore semantics, so concurrent prompts on the
    // same process would step on each other. `run(...)` scopes the
    // binding to the callback's async subtree.
    const acpKaos = await this.maybeBuildAcpKaos();
    if (!acpKaos) {
      return this.runPromptBody(parts, sessionId, conn);
    }
    return runWithKaos(acpKaos, () => this.runPromptBody(parts, sessionId, conn));
  }

  /**
   * Build an {@link AcpKaos} for this prompt if (and only if) the
   * client advertised any FS reverse-RPC capability. Returns
   * `undefined` otherwise — the caller then runs the prompt body in
   * whatever Kaos was active before (typically the process-wide
   * `LocalKaos` set up at startup).
   *
   * The inner {@link LocalKaos} is built lazily on the first capable
   * prompt and cached on the instance (`this.innerKaos`); subsequent
   * prompts reuse it.
   */
  private async maybeBuildAcpKaos(): Promise<AcpKaos | undefined> {
    const fs = this.clientCapabilities?.fs;
    if (!fs?.readTextFile && !fs?.writeTextFile) {
      return undefined;
    }
    if (!this.innerKaos) {
      this.innerKaos = await LocalKaos.create();
    }
    return new AcpKaos(this.conn, this.id, this.innerKaos);
  }

  /**
   * The pre-Phase-6 body of {@link prompt}, extracted verbatim so that
   * the new `runWithKaos` wrapper can apply uniformly to capable
   * clients while non-capable clients hit the same code path with no
   * wrapping. Splitting it out (rather than inlining the if/else twice)
   * keeps the event-listener invariants — single `onEvent` subscription,
   * `settled` flag semantics, `currentTurnId` reset — in one place.
   */
  private runPromptBody(
    parts: ReturnType<typeof acpBlocksToPromptParts>,
    sessionId: string,
    conn: AgentSideConnection,
  ): Promise<PromptResponse> {
    return new Promise<PromptResponse>((resolve, reject) => {
      let settled = false;
      // Per-tool-call streaming args accumulator. Lives in the Promise
      // executor closure so each `prompt()` invocation gets its own
      // map and no state leaks across concurrent or sequential turns.
      // Keyed on the **SDK** `toolCallId` (not the ACP-prefixed one)
      // because the SDK delta events only carry the raw id.
      const argsByToolCall = new Map<string, { args: string }>();
      // Set of **wire-level** (turn-prefixed) tool-call ids for which
      // we have already sent the `tool_call` CREATE notification. The
      // agent-core actually emits `tool.call.delta` events BEFORE
      // `tool.call.started` (deltas come from the model's args stream;
      // the started event comes from the loop dispatching the call
      // afterwards). Without this set, the naive "started → tool_call,
      // delta → tool_call_update" mapping puts updates on the wire
      // ahead of the create, and clients such as Zed surface "Tool
      // call not found" until the create eventually lands. We instead
      // lazy-create the wire `tool_call` on the first delta and
      // downgrade the eventual started event into a `tool_call_update`
      // carrying the canonical title/kind/rawInput (and any
      // `display`-derived diff).
      //
      // Keyed on the wire id (`${turnId}:${rawToolCallId}`) — not the
      // raw SDK `toolCallId` — because providers may legitimately
      // reuse the same raw id across turns within one prompt, and
      // each turn produces a distinct wire-level tool call that needs
      // its own CREATE.
      const startedToolCalls = new Set<string>();
      const unsub = this.session.onEvent((event) => {
        // Track the active turn so `handleApproval` (registered once at
        // construction, called via `setApprovalHandler`) can compose the
        // prefixed `${turnId}:${toolCallId}` wire id that matches the
        // tool card the client already rendered. This branch is purely
        // additive: it runs before the existing dispatch and never
        // returns, so the if-chain below behaves exactly as in Phase 4.
        if ('turnId' in event && typeof event.turnId === 'number') {
          this.currentTurnId = event.turnId;
        }
        if (event.type === 'assistant.delta') {
          // `sessionUpdate` is itself async (it serializes onto the
          // ndjson stream). The text deltas form a strictly ordered
          // single-producer/single-consumer pipeline, so each await
          // would force the next delta to wait for the previous flush.
          // Fire-and-forget keeps the stream pumping; we log push
          // failures rather than dropping them silently.
          conn
            .sessionUpdate(assistantDeltaToSessionUpdate(sessionId, event))
            .catch((err) => {
              log.warn('acp: failed to push agent_message_chunk', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'thinking.delta') {
          conn
            .sessionUpdate(thinkingDeltaToSessionUpdate(sessionId, event))
            .catch((err) => {
              log.warn('acp: failed to push agent_thought_chunk', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'tool.call.started') {
          // Seed the accumulator with the **stringified initial args**.
          // The wire-level `tool_call_update` is REPLACE-content (not
          // append) so each subsequent delta emits the cumulative args
          // string; if we seeded with an empty string the first delta
          // would silently drop the initial args from the rendered card.
          argsByToolCall.set(event.toolCallId, { args: stringifyArgs(event.args) });
          // Branch on whether a streaming delta already lazy-created
          // the wire `tool_call` for this id:
          //  - YES → we cannot send a second `tool_call` CREATE; emit a
          //    `tool_call_update` (the "upgrade") so `title`/`kind`/
          //    `rawInput`/`display`-derived diff land on the existing
          //    card and `status` flips to `'in_progress'`.
          //  - NO  → no prior deltas (e.g. provider doesn't stream args);
          //    take the original path and emit the `tool_call` CREATE.
          const startedWireId = acpToolCallId(event.turnId, event.toolCallId);
          if (startedToolCalls.has(startedWireId)) {
            conn
              .sessionUpdate(toolCallStartedUpgradeToSessionUpdate(sessionId, event))
              .catch((err) => {
                log.warn('acp: failed to push tool_call_update (start upgrade)', {
                  sessionId,
                  toolCallId: event.toolCallId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          } else {
            startedToolCalls.add(startedWireId);
            conn
              .sessionUpdate(toolCallStartToSessionUpdate(sessionId, event))
              .catch((err) => {
                log.warn('acp: failed to push tool_call', {
                  sessionId,
                  toolCallId: event.toolCallId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          }
          // Phase 9.3: when the tool exposed a structured TodoList
          // display, additionally fire a `plan` session_update so ACP
          // clients can render the agent's evolving TODO list. Other
          // display kinds (diff/file_io/command/…) are already folded
          // into the tool_call card; only `todo_list` becomes a plan.
          // The emission is fire-and-forget under the same idle-stream
          // discipline as the assistant deltas above.
          if (event.display) {
            const planNote = planFromDisplayBlock(sessionId, event.turnId, event.display);
            if (planNote !== null) {
              conn.sessionUpdate(planNote).catch((err) => {
                log.warn('acp: failed to push plan', {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          }
          return;
        }
        if (event.type === 'tool.call.delta') {
          // The agent-core emits these args-stream deltas BEFORE the
          // `tool.call.started` event (deltas come from the provider's
          // streaming phase; started is dispatched afterwards). If we
          // haven't yet sent a `tool_call` CREATE for this id, do so now
          // from the delta — Zed otherwise sees a `tool_call_update`
          // for an unknown id and surfaces "Tool call not found" until
          // the start eventually lands.
          const deltaWireId = acpToolCallId(event.turnId, event.toolCallId);
          if (!startedToolCalls.has(deltaWireId)) {
            const initial = event.argumentsPart ?? '';
            argsByToolCall.set(event.toolCallId, { args: initial });
            startedToolCalls.add(deltaWireId);
            conn
              .sessionUpdate(toolCallLazyCreateToSessionUpdate(sessionId, event))
              .catch((err) => {
                log.warn('acp: failed to push tool_call (lazy create from delta)', {
                  sessionId,
                  toolCallId: event.toolCallId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            return;
          }
          // Subsequent delta — accumulate then emit an update with the
          // cumulative args text (REPLACE-content semantics).
          let acc = argsByToolCall.get(event.toolCallId);
          if (!acc) {
            acc = { args: '' };
            argsByToolCall.set(event.toolCallId, acc);
          }
          conn
            .sessionUpdate(toolCallDeltaToSessionUpdate(sessionId, event, acc))
            .catch((err) => {
              log.warn('acp: failed to push tool_call_update (delta)', {
                sessionId,
                toolCallId: event.toolCallId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'tool.progress') {
          const note = toolProgressToSessionUpdate(sessionId, event);
          if (note === null) return;
          conn.sessionUpdate(note).catch((err) => {
            log.warn('acp: failed to push tool_call_update (progress)', {
              sessionId,
              toolCallId: event.toolCallId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          return;
        }
        if (event.type === 'tool.result') {
          conn
            .sessionUpdate(toolResultToSessionUpdate(sessionId, event))
            .catch((err) => {
              log.warn('acp: failed to push tool_call_update (result)', {
                sessionId,
                toolCallId: event.toolCallId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'turn.ended') {
          if (settled) return;
          settled = true;
          if (event.reason === 'failed') {
            // Failures bubble up via the SDK `error` payload. Phase 11.1
            // upgrades the prior "log + resolve end_turn" behaviour to
            // route auth-coded failures through `RequestError.authRequired()`
            // so the client can trigger its re-auth UX. Other failure
            // codes still resolve with `end_turn` (the spec discourages
            // signaling errors through `stopReason`; the failure is
            // observable in the log).
            log.warn('acp: turn ended with failed reason', {
              sessionId,
              error: event.error,
            });
            argsByToolCall.clear();
            startedToolCalls.clear();
            this.currentTurnId = undefined;
            unsub();
            const authErr = authRequiredFromPayload(event.error);
            if (authErr) {
              reject(authErr);
              return;
            }
          } else {
            argsByToolCall.clear();
            startedToolCalls.clear();
            // Drop the turnId so a late-arriving approval (e.g. an SDK
            // reverse-RPC racing the turn boundary) falls back to the raw
            // SDK id rather than re-prefixing with a stale value.
            this.currentTurnId = undefined;
            unsub();
          }
          resolve({ stopReason: turnEndReasonToStopReason(event.reason) });
        }
      });

      this.session.prompt(parts).catch((err) => {
        if (settled) return;
        settled = true;
        unsub();
        reject(mapPromptError(err, sessionId));
      });
    });
  }

  /**
   * Bridge an SDK {@link ApprovalRequest} through the ACP reverse-RPC
   * `session/request_permission`.
   *
   * Flow:
   *  1. Build the wire-level {@link ToolCallUpdate} so the client can
   *     correlate the prompt with the tool card it already rendered
   *     (uses the prefixed `${turnId}:${rawId}` form when available).
   *  2. Forward to the client via `conn.requestPermission` with the
   *     three canonical options (`allow_once`, `allow_always`, `reject`).
   *  3. Map the response back to {@link ApprovalResponse} for the SDK.
   *
   * Error policy: any RPC failure (transport drop, client error,
   * timeout) resolves with `decision: 'rejected'` and a structured log
   * line. Rejecting on failure is strictly safer than approving when
   * the client cannot confirm intent, and matches the Python
   * reference's behaviour for the same edge case.
   *
   * The handler is registered exactly once in the constructor; this
   * method is invoked by the SDK reverse-RPC layer whenever the loop
   * needs human authorization to proceed with a tool call.
   */
  private async handleApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
    const toolCall = buildPermissionToolCallUpdate(this.currentTurnId, req);
    const options = approvalRequestToPermissionOptions(req);
    // Phase 13.2 telemetry breadcrumb: how many discrete options does
    // the plan_review surface carry? PII-free (just a count), matches
    // the Phase 11.2 telemetry discipline.
    if (req.display.kind === 'plan_review') {
      const count = req.display.options?.length ?? 0;
      this.emitTelemetry('plan_review_options_count', { count });
    }
    try {
      // `requestPermission` is an awaitable JSON-RPC request (unlike
      // the fire-and-forget `sessionUpdate` notifications elsewhere in
      // this file), so the SDK call site naturally blocks on the
      // user's decision before the tool runs.
      const response = await this.conn.requestPermission({
        sessionId: this.id,
        options: [...options],
        toolCall,
      });
      // Map the discriminator first (pure mapper, easy to unit-test),
      // then stitch the matched option's human-readable name as
      // `selectedLabel` so the SDK can surface "approved as
      // 'Approve once'" in subsequent reasoning. `attachSelectedLabel`
      // is a no-op for `cancelled` outcomes, unknown optionIds, and
      // plan_* optionIds (Phase 13.2 — the plan_review branch attaches
      // selectedLabel inside `permissionResponseToApprovalResponse`).
      return attachSelectedLabel(
        response,
        permissionResponseToApprovalResponse(req, response),
        options,
      );
    } catch (err) {
      log.warn('acp: requestPermission failed; rejecting', {
        sessionId: this.id,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      return { decision: 'rejected' };
    }
  }

  /**
   * Bridge an SDK {@link QuestionRequest} (the AskUserQuestion tool's
   * reverse-RPC) through the same ACP
   * `session/request_permission` surface used by approvals.
   *
   * ACP currently has no dedicated `session/request_question` method, so
   * the adapter re-uses `requestPermission` and tags the options with a
   * `q{n}_*` namespace so the round-trip is unambiguous.
   *
   * Degradation rules:
   *  - `req.questions.length > 1` → only the first question is asked;
   *    telemetry records the dropped count so we can observe how often
   *    multi-question prompts land in the wild.
   *  - `q.multiSelect === true` → still asked as single-select; the
   *    SDK's ask-user tool tolerates a single-key answer for a multi-
   *    select prompt so this is a graceful narrow rather than a hard
   *    fail.
   *
   * Error policy mirrors {@link handleApproval}: any RPC failure logs
   * a warning and returns `null` so the SDK resolves the tool with the
   * canonical "user dismissed" branch (`rpc.ts:567`). Returning `null`
   * is strictly safer than fabricating an answer the user did not give.
   */
  private async handleQuestion(req: QuestionRequest): Promise<QuestionAnswers | null> {
    const questions = req.questions;
    if (questions.length === 0) {
      // Pathological input — log and dismiss. No telemetry: the SDK
      // would never emit an empty `questions` payload in practice.
      log.warn('acp: handleQuestion received empty questions array', {
        sessionId: this.id,
      });
      return null;
    }
    if (questions.length > 1) {
      log.warn('acp: handleQuestion degrading to first question only', {
        sessionId: this.id,
        dropped: questions.length - 1,
      });
      this.emitTelemetry('question_degraded', {
        reason: 'multi_question',
        dropped: questions.length - 1,
      });
    }
    const q = questions[0]!;
    if (q.multiSelect === true) {
      this.emitTelemetry('question_degraded', { reason: 'multi_select' });
    }
    const options = questionItemToPermissionOptions(q, 0);
    const rawToolCallId = req.toolCallId ?? 'ask-user';
    const toolCallId =
      this.currentTurnId !== undefined
        ? acpToolCallId(this.currentTurnId, rawToolCallId)
        : rawToolCallId;
    try {
      const response = await this.conn.requestPermission({
        sessionId: this.id,
        options: [...options],
        toolCall: {
          toolCallId,
          title: 'AskUserQuestion',
          content: [{ type: 'content', content: { type: 'text', text: q.question } }],
        },
      });
      const answer = outcomeToQuestionAnswer(q, response);
      if (answer === null) {
        // Dismissed via skip / cancel / unknown optionId — telemetry
        // matches the ask-user tool's existing `question_dismissed`
        // event so dashboards stay coherent.
        this.emitTelemetry('question_dismissed');
      } else {
        this.emitTelemetry('question_answered');
      }
      return answer;
    } catch (err) {
      log.warn('acp: requestPermission (question) failed; dismissing', {
        sessionId: this.id,
        toolCallId: req.toolCallId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fire-and-forget telemetry emitter that guards a missing or
   * throwing `track` sink. Mirrors the Phase 11.2 pattern in
   * `server.ts:trackSessionStarted` — telemetry must never crash a
   * reverse-RPC handler.
   */
  private emitTelemetry(event: string, properties?: Record<string, unknown>): void {
    if (typeof this.track !== 'function') return;
    try {
      this.track(event, properties);
    } catch (err) {
      log.warn('acp: telemetry track failed', {
        sessionId: this.id,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Map a Kimi SDK error (raw `Error`, `KimiError`, or `KimiErrorPayload`)
 * into the ACP {@link RequestError} shape used by the JSON-RPC layer.
 *
 * Auth-coded inputs (`auth.login_required`, `provider.auth_error`)
 * become `RequestError.authRequired()` so the client can drive its own
 * re-auth UX. Everything else becomes `RequestError.internalError(...)`
 * with the raw error logged to the agent log file but NOT exposed in
 * the JSON-RPC response — the client only sees the canonical
 * "session prompt failed" message, preventing accidental leakage of
 * stack frames or PII through the wire.
 *
 * The kimi-cli Python reference performs the same mapping at
 * `kimi-cli/src/kimi_cli/acp/session.py:218-247`; this is the TS port.
 */
function mapPromptError(err: unknown, sessionId: string): RequestError {
  const authErr = authRequiredFromUnknown(err);
  if (authErr) {
    log.warn('acp: prompt rejected with auth error; mapping to authRequired', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return authErr;
  }
  log.error('acp: prompt failed', {
    sessionId,
    error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
  });
  return RequestError.internalError(undefined, 'session prompt failed');
}

/**
 * Inspect a {@link KimiErrorPayload} (as carried on `turn.ended`
 * failed events) and return a `RequestError.authRequired()` if its
 * `code` is one of the auth-required codes; otherwise `undefined`.
 *
 * Kept separate from {@link authRequiredFromUnknown} because the
 * `turn.ended` event hands us a serialized payload (no class identity
 * to branch on) — we only need the `code` discriminator here.
 */
function authRequiredFromPayload(payload: KimiErrorPayload | undefined): RequestError | undefined {
  if (!payload) return undefined;
  if (isAuthErrorCode(payload.code)) {
    return RequestError.authRequired();
  }
  return undefined;
}

/**
 * Type-narrowing predicate for the codes the adapter treats as
 * "the client must re-authenticate before retrying". Currently:
 *  - `auth.login_required` — Kimi Platform / OAuth login flow needed.
 *  - `provider.auth_error` — the downstream provider rejected the
 *    request with a 401 (the node SDK lifts these into `KimiError`
 *    at `kimi-code-model-provider.ts:99-103`).
 */
function isAuthErrorCode(code: unknown): boolean {
  return code === ErrorCodes.AUTH_LOGIN_REQUIRED || code === ErrorCodes.PROVIDER_AUTH_ERROR;
}

/**
 * Best-effort detection of "auth required" for the `session.prompt(...)`
 * rejection path. The thrown value MAY be:
 *  - A `KimiError` instance with a recognized `code` field.
 *  - A plain object that happens to expose a `code` (covers RPC-layer
 *    deserialized payloads that lost class identity).
 *  - Anything else — returns `undefined`.
 */
function authRequiredFromUnknown(err: unknown): RequestError | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (isAuthErrorCode(code)) {
      return RequestError.authRequired();
    }
  }
  return undefined;
}

/**
 * Effort-level strings passed to {@link Session.setThinking} when the
 * ACP `thinking` toggle flips. Phase 15 wired the ACP-side binary axis
 * (then a `SessionConfigBoolean`; Phase 16 reshaped it to a 2-entry
 * `select` `off` / `on` for Zed UI compatibility) to the SDK's
 * effort-level channel: `true` → `'high'` (kimi-code's typical default,
 * also `resolveThinkingEffort`'s fallback), `false` → `'off'`. The
 * granularity of `'low' | 'medium' | 'xhigh' | 'max'` is intentionally
 * not exposed — the ACP `thinking` axis is binary.
 */
const THINKING_ON_LEVEL = 'high';
const THINKING_OFF_LEVEL = 'off';

/**
 * Parse a tool call's `arguments` field (kosong wire format: a JSON
 * string or `null`) into the structured object expected by the live
 * {@link toolCallStartToSessionUpdate} mapper. Falls back to the raw
 * string when the payload is not valid JSON — the mapper itself uses
 * {@link stringifyArgs}, which gracefully `String(x)`s anything it
 * cannot serialize, so the worst case is a degraded preview rather
 * than a crash.
 */
function parseToolCallArguments(rawArguments: string | null): unknown {
  if (rawArguments === null || rawArguments === '') return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

/**
 * Project a `tool` role {@link ContextMessage}'s `content` array into
 * the ACP `tool_call_update.content` shape (an array of
 * `ToolCallContent` entries). The historical message's content is a
 * sequence of kosong content parts — for replay we surface text parts
 * directly and stringify anything else (image refs etc.) as a
 * `[type]` placeholder so the client still sees that something was
 * returned.
 */
function toolMessageContentToAcpToolCallContent(
  parts: ContextMessage['content'],
): Array<{ type: 'content'; content: { type: 'text'; text: string } }> {
  const result: Array<{ type: 'content'; content: { type: 'text'; text: string } }> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) {
        result.push({ type: 'content', content: { type: 'text', text: part.text } });
      }
      continue;
    }
    // image_url / audio_url / video_url / think — surface a marker so
    // the result card is not empty. Replay should not lose evidence
    // that a non-text part was present.
    result.push({
      type: 'content',
      content: { type: 'text', text: `[${part.type}]` },
    });
  }
  return result;
}
