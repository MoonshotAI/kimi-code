import {
  RequestError,
  type AgentSideConnection,
  type ClientCapabilities,
  type AvailableCommand,
  type ContentBlock,
  type ModelId,
  type PromptResponse,
  type SessionModeId,
} from '@agentclientprotocol/sdk';
import {
  ErrorCodes,
  log,
  sessionMediaOriginalsDir,
  type ApprovalRequest,
  type ApprovalResponse,
  type BackgroundTaskInfo,
  type ContextMessage,
  type Event,
  type KimiHarness,
  type McpServerInfo,
  type PromptPart,
  type QuestionAnswers,
  type QuestionRequest,
  type Session,
  type SessionStatus,
  type SessionUsage,
} from '@moonshot-ai/kimi-code-sdk';

import {
  approvalRequestToPermissionOptions,
  attachSelectedLabel,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
} from './approval';
import {
  ACP_BUILTIN_SLASH_COMMANDS,
  type AcpBuiltinSlashCommandName,
} from './builtin-commands';
import { buildSessionConfigOptions } from './config-options';
import { listModelsFromHarness } from './model-catalog';
import { acpBlocksToPromptParts, compressPromptImageParts } from './convert';
import {
  assistantDeltaToSessionUpdate,
  configOptionUpdateNotification,
  thinkingDeltaToSessionUpdate,
  toolCallStartToSessionUpdate,
  toolResultToSessionUpdate,
  turnStopReasonToAcpStopReason,
} from './events-map';
import { acpModeToToggles, DEFAULT_MODE_ID, isAcpModeId, type AcpModeId } from './modes';
import { outcomeToQuestionAnswer, questionItemToPermissionOptions } from './question';
import { detectSlashIntent } from './slash';

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
   * The most recently observed `turn_id` from the underlying SDK event
   * stream. Retained for {@link runTurnBody}'s turn-busy guard: the
   * `initialActiveTurnId` snapshot lets the adapter tell whether a
   * `session.turn.started` belongs to THIS prompt or to a pre-existing
   * turn, so a `turn.agent_busy` error is only fatal when our own turn
   * never started.
   *
   * Updated inside the existing `onEvent` listener in {@link runTurnBody}
   * (any event carrying a numeric `turn_id` advances the value), and
   * reset to `undefined` on `session.turn.ended`. The retired
   * `${turnId}:${toolCallId}` wire-id prefix is gone — the engine's
   * `session.tool.*` events carry no `turn_id`, so approvals and tool
   * cards now correlate on the raw `tool_call_id` verbatim.
   */
  private currentTurnId: number | undefined = undefined;

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
   * The adapter-side authoritative current thinking effort — `'off'`,
   * `'on'` (legacy boolean alias), or one of the current model's
   * declared effort levels (`'low' | 'medium' | 'high' | …`). Phase 15
   * split thinking out of the model id so the client renders a separate
   * `SessionConfigOption` (the spec's `'thought_level'` category)
   * instead of an inlined `,thinking` variant row in the model dropdown.
   * Updated by {@link setThinking} and by {@link setModel} when the
   * caller passed a merged `${id},thinking` form (legacy
   * `unstable_setSessionModel` compatibility).
   *
   * The value is forwarded to the SDK as-is (`Session.setThinking`),
   * then reconciled with the engine-normalized effort read back from
   * `Session.getStatus()` when that channel exists — so engine-side
   * clamping (e.g. `always_thinking` rejecting `'off'`, or a level the
   * newly-selected model does not declare) is reflected in the next
   * snapshot instead of the adapter's requested value.
   */
  private currentThinkingEffortInternal: string = 'off';

  /**
   * The adapter-side authoritative current mode id. Updated by
   * {@link setMode} after both SDK toggles (`setPlanMode` + `setPermission`)
   * land so the next `config_option_update` notification reflects the
   * new mode. Always one of the four PLAN D9 literals.
   */
  private currentModeIdInternal: AcpModeId = DEFAULT_MODE_ID;

  /**
   * Per-session `slash command name → skill name` map, seeded by
   * {@link AcpServer.emitAvailableCommandsUpdate} from the same
   * `listSkills()` snapshot that builds the client palette. Consulted
   * by {@link prompt} to intercept `/skill:<name> ...` inputs and
   * route them to {@link Session.activateSkill} instead of forwarding
   * the raw slash text to {@link Session.prompt} — which is what made
   * Zed fall back to model-driven Bash exploration of
   * `~/.kimi-code/skills/` and incurred permission prompts. Defaults
   * to an empty map so adapter-level unit tests (which never call
   * `setSkillCommandMap`) behave as a no-op passthrough.
   */
  private skillCommandMap: ReadonlyMap<string, string> = new Map();

  // One token per in-flight `prompt()` that is still awaiting image compression
  // (before any turn exists). A `session/cancel` in that window has no turn to
  // abort, so it flips every token and each affected `prompt()` returns
  // `cancelled` instead of launching. A set (not a single field) so concurrent
  // prompts are all covered rather than only the most recent.
  private readonly pendingPromptAborts = new Set<{ aborted: boolean }>();

  /**
   * The most recent command palette advertised to the ACP client. Used by
   * `/help` so the response matches the client's `available_commands_update`
   * snapshot, including dynamically discovered skill commands.
   */
  private availableCommands: readonly AvailableCommand[] = [];

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
     * Initial value of the adapter-side thinking effort, supplied
     * by the server when creating / loading the session from the
     * engine-resolved status (or the persisted resume-state effort).
     * Defaults to `'off'` when absent.
     */
    initialThinkingEffort?: string,
  ) {
    this.currentModelIdInternal = initialModelId ?? '';
    this.currentThinkingEffortInternal = initialThinkingEffort ?? 'off';
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
   * Adapter-side authoritative current thinking effort, used by
   * {@link AcpServer.setSessionConfigOption} to build the response's
   * `configOptions` snapshot.
   */
  get currentThinkingEffort(): string {
    return this.currentThinkingEffortInternal;
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
    // If any prompt is mid-compression (no turn yet), mark them aborted so they
    // do not launch once compression finishes.
    for (const pending of this.pendingPromptAborts) {
      pending.aborted = true;
    }
    await this.session.cancel();
  }

  /**
   * Seed the per-session `slash command name → skill name` map used by
   * {@link prompt} to intercept `/skill:<name> ...` inputs. Called by
   * {@link AcpServer.emitAvailableCommandsUpdate} from the same
   * `listSkills()` snapshot that builds the client palette, so the map
   * stays in lockstep with what the client advertises.
   */
  setSkillCommandMap(map: ReadonlyMap<string, string>): void {
    this.skillCommandMap = map;
  }

  /**
   * Seed the advertised command palette and the skill-routing map from one
   * resolver snapshot. This keeps `available_commands_update`, `/help`, and
   * skill slash interception in lockstep.
   */
  setAvailableCommands(
    commands: readonly AvailableCommand[],
    skillCommandMap: ReadonlyMap<string, string>,
  ): void {
    this.availableCommands = commands.slice();
    this.skillCommandMap = skillCommandMap;
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
   * `thought_level` config option (a `select` of effort levels) — but
   * this legacy compat path is kept: when the caller sends a merged
   * form, we split it into the bare model key (forwarded to
   * `Session.setModel`) plus the new model's default effort (forwarded
   * to `Session.setThinking`).
   *
   * Wire semantics:
   *  - `'kimi-v2'`           → setModel('kimi-v2'); requested thinking
   *    effort unchanged (the engine re-resolves it against the new
   *    model; see below).
   *  - `'kimi-v2,thinking'`  → setModel('kimi-v2') + setThinking(<default
   *    effort for that model>); thinking flips on at the default level.
   *
   * Note the asymmetry: a bare model id does NOT turn thinking OFF.
   * That keeps the model / thinking axes orthogonal — model changes
   * preserve the requested effort. To explicitly disable thinking, the
   * client must call `setSessionConfigOption({ configId: 'thinking',
   * value: 'off' })`.
   *
   * After the SDK calls land, the adapter-side effort is reconciled
   * with `Session.getStatus()` when available: the engine re-resolves
   * the requested effort against the new model (`ConfigState.update`),
   * so a level the new model does not declare shows up in the next
   * snapshot as the engine-normalized value, not the stale request.
   *
   * `currentModelIdInternal` is updated to the bare key — the snapshot
   * therefore never carries a `,thinking` suffix in the model option's
   * `currentValue`. Thinking visibility in the snapshot is governed
   * by `currentThinkingEffortInternal` and
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
    // Update BEFORE resolving the on-effort so a merged `,thinking`
    // switch picks the NEW model's default level, not the old one's.
    this.currentModelIdInternal = baseKey;
    if (hasSuffix && typeof this.session.setThinking === 'function') {
      const onEffort = await this.thinkingOnEffort();
      await this.session.setThinking(onEffort);
      this.currentThinkingEffortInternal =
        (await this.readEffectiveThinkingEffort()) ?? onEffort;
    } else if (!hasSuffix) {
      this.currentThinkingEffortInternal =
        (await this.readEffectiveThinkingEffort()) ?? this.currentThinkingEffortInternal;
    }
    await this.emitConfigOptionUpdate();
  }

  /**
   * Forward an ACP thinking-effort change to the underlying SDK.
   *
   * Accepted values mirror the rows advertised by the `thinking`
   * config option:
   *  - `'off'`         → `Session.setThinking('off')`;
   *  - `'on'`          → legacy boolean alias, mapped to the current
   *    model's default effort (see {@link thinkingOnEffort});
   *  - `<level>`       → a declared `support_efforts` level of the
   *    current model, forwarded unchanged. Anything else is rejected
   *    with JSON-RPC `invalid_params` (-32602) BEFORE the SDK call so
   *    the client sees a structured rejection rather than a
   *    half-applied state change. When the catalog is unavailable
   *    (harness-less unit tests) or the current model is unknown to
   *    it, levels pass through unvalidated — the engine's own resolve
   *    remains the final arbiter.
   *
   * Tolerant to partial-stub `Session` instances (adapter-level unit
   * tests construct minimal fakes that may omit `setThinking`): when
   * the method is missing we still update the adapter-side effort
   * state and emit the snapshot, so the ACP wire stays consistent —
   * the test simply doesn't observe an SDK call.
   *
   * After the SDK call lands, the recorded effort is reconciled with
   * `Session.getStatus()` when that channel exists, so engine-side
   * clamping (e.g. `always_thinking` rejecting `'off'`) is what the
   * next snapshot renders.
   *
   * Always emits a `config_option_update` notification afterwards so
   * the client sees the picker reflect the new value, even if it
   * came in through the funnel and the response itself already
   * carries a fresh snapshot.
   */
  async setThinking(effort: string): Promise<void> {
    const resolved = await this.resolveEffortForCurrentModel(effort);
    if (typeof this.session.setThinking === 'function') {
      await this.session.setThinking(resolved);
    }
    this.currentThinkingEffortInternal =
      (await this.readEffectiveThinkingEffort()) ?? resolved;
    await this.emitConfigOptionUpdate();
  }

  /**
   * Validate an ACP-supplied thinking value against the current model's
   * catalog row and resolve the legacy `'on'` alias. Returns the effort
   * string to forward to the SDK. See {@link setThinking} for the
   * acceptance rules.
   */
  private async resolveEffortForCurrentModel(effort: string): Promise<string> {
    if (!this.harness) return effort;
    const models = await listModelsFromHarness(this.harness);
    const entry = models.find((m) => m.id === this.currentModelIdInternal);
    if (effort === 'on') return entry?.defaultThinkingEffort ?? 'on';
    if (effort === 'off') return 'off';
    if (entry !== undefined && !entry.supportEfforts.includes(effort)) {
      throw RequestError.invalidParams(
        { effort, modelId: entry.id },
        `Unknown thinking effort for model "${entry.id}": ${effort}`,
      );
    }
    return effort;
  }

  /**
   * The engine-normalized thinking effort reported by the SDK session's
   * status channel, or `undefined` when the channel is missing
   * (partial-stub unit tests), fails, or carries no usable value — the
   * caller then keeps its own projected value. Reading status is the
   * same swallow-and-fallback policy as
   * {@link AcpServer.resolveCurrentThinkingEffort}.
   */
  private async readEffectiveThinkingEffort(): Promise<string | undefined> {
    if (typeof this.session.getStatus !== 'function') return undefined;
    try {
      const effort = (await this.session.getStatus()).thinkingEffort;
      return typeof effort === 'string' && effort.length > 0 ? effort : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The effort the legacy `'on'` value maps to: the current model's
   * declared default effort (or middle `support_efforts`), falling back
   * to `'on'` for boolean models or when the catalog is unavailable
   * (harness-less unit tests). The `always_thinking` constraint is
   * enforced downstream by agent-core's resolve, so this adapter no
   * longer clamps an explicit off request here.
   */
  private async thinkingOnEffort(): Promise<string> {
    if (!this.harness) return 'on';
    const models = await listModelsFromHarness(this.harness);
    return models.find((m) => m.id === this.currentModelIdInternal)?.defaultThinkingEffort ?? 'on';
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
        this.currentThinkingEffortInternal,
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
   *    `toolCalls` entry. The wire `toolCallId` is the raw SDK id
   *    verbatim — the engine's `session.tool.*` events carry no
   *    `turn_id`, so there is no `${turnId}:${toolCallId}` prefix to
   *    synthesize (matches the live emission scheme in
   *    {@link runTurnBody}).
   *  - role `tool`         → `tool_call_update` with `status: 'completed'`
   *    (or `'failed'` if the SDK marked the message as an error),
   *    keyed on the raw SDK `toolCallId`.
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
   * `runTurnBody` fire-and-forget path) because replay is a one-shot
   * batch — completion ordering is what tells the caller (`loadSession`)
   * that the response is safe to return.
   */
  async replayHistory(agentId: string = MAIN_AGENT_ID): Promise<void> {
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

    for (const message of agent.context.history) {
      try {
        await this.replayMessage(message, sessionId, conn);
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
   * stays small and the outer loop stays a plain walk. Awaits every
   * `sessionUpdate` so the replay completes in order (see
   * {@link replayHistory} JSDoc for the rationale).
   */
  private async replayMessage(
    message: ContextMessage,
    sessionId: string,
    conn: AgentSideConnection,
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
        for (const part of message.content) {
          await this.replayAssistantContentPart(part, sessionId, conn);
        }
        for (const toolCall of message.toolCalls ?? []) {
          await this.replaySyntheticToolCall(toolCall, sessionId, conn);
        }
        return;
      }
      case 'tool': {
        const toolCallId = message.toolCallId;
        if (!toolCallId) {
          // Tool result with no correlation id — log and skip rather
          // than crash. The on-disk session is the source of truth;
          // we cannot synthesize a missing id.
          log.warn('acp: replayHistory skipped tool message with no toolCallId', { sessionId });
          return;
        }
        const isError = message.isError === true;
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
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
  ): Promise<void> {
    if (part.type === 'text' && part.text) {
      await conn.sessionUpdate(assistantDeltaToSessionUpdate(sessionId, part.text));
      return;
    }
    if (part.type === 'think' && part.think) {
      await conn.sessionUpdate(thinkingDeltaToSessionUpdate(sessionId, part.think));
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
  ): Promise<void> {
    const name = toolCall.name;
    const argsRaw = toolCall.arguments;
    const parsedArgs = parseToolCallArguments(argsRaw);
    await conn.sessionUpdate(
      toolCallStartToSessionUpdate(sessionId, {
        type: 'session.tool.started',
        tool_call_id: toolCall.id,
        tool_name: name,
        arguments: parsedArgs,
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
   *  - Auth-coded failures arrive as a `session.prompt(...)` rejection
   *    (the engine's `session.turn.ended` carries only a `stop_reason`
   *    string — no error payload) and are routed through
   *    {@link mapPromptError}.
   *
   * Subscribes to the session event stream; for every `llm.delta` text
   * part, pushes an `agent_message_chunk` `session/update` notification
   * to the client. Resolves with the ACP `PromptResponse` (containing
   * `stopReason`) when a `session.turn.ended` event arrives.
   *
   * Cleanup invariants:
   *  - The event subscription is unsubscribed on EVERY exit path
   *    (success, cancel, failed turn, and `session.prompt()` rejection).
   *  - If `session.prompt()` rejects synchronously or asynchronously, the
   *    rejection is propagated as a `prompt` request error so the client
   *    sees a JSON-RPC error rather than a hung request.
   */
  async prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    // Compression happens before any turn exists, so honor a `session/cancel`
    // that arrives during it: flip the flag from cancel() and bail out here
    // rather than launching a turn the client already asked to stop.
    const pending = { aborted: false };
    this.pendingPromptAborts.add(pending);
    let parts: readonly PromptPart[];
    try {
      const sessionDir = this.session.summary?.sessionDir;
      const track = this.track;
      parts = await compressPromptImageParts(acpBlocksToPromptParts(blocks), {
        originalsDir:
          sessionDir === undefined ? undefined : sessionMediaOriginalsDir(sessionDir),
        maxImageEdgePx: this.harness?.imageLimits?.maxEdgePx,
        telemetry:
          track === undefined
            ? undefined
            : {
                track: (event, properties) =>
                  track(event, properties === undefined ? undefined : { ...properties }),
              },
      });
    } finally {
      this.pendingPromptAborts.delete(pending);
    }
    if (pending.aborted) {
      return { stopReason: 'cancelled' };
    }
    const sessionId = this.id;
    const conn = this.conn;

    // ACP clients send slash commands as plain text `ContentBlock`s in
    // `session/prompt`. Intercept only commands the adapter can execute
    // directly: skills route to `Session.activateSkill(...)`, ACP-owned
    // built-ins route to local SDK queries, and unknown slash commands are
    // reported locally instead of being forwarded to the model as text.
    const intent = detectLeadingSlashIntent(blocks, this.skillCommandMap);
    if (intent.kind === 'skill') {
      this.emitTelemetry('acp_skill_activated', { skill_name: intent.skillName });
      const skillName = intent.skillName;
      const skillArgs = intent.args;
      return this.runTurnBody(sessionId, conn, () =>
        // `activateSkill` accepts `args?: string | undefined`; pass the
        // empty string through verbatim — the SDK's
        // `normalizeOptionalString` converts `''` to `undefined`, which
        // is the canonical "no args" form for the skill renderer.
        this.session.activateSkill(skillName, skillArgs.length > 0 ? skillArgs : undefined),
      );
    }
    if (intent.kind === 'builtin') {
      return this.runBuiltInCommand(intent.name, intent.args);
    }
    if (intent.kind === 'unknown') {
      return this.runUnknownSlashCommand(intent.name);
    }

    return this.runTurnBody(sessionId, conn, () => this.session.prompt(parts));
  }

  private async runBuiltInCommand(
    name: AcpBuiltinSlashCommandName,
    args: string,
  ): Promise<PromptResponse> {
    try {
      switch (name) {
        case 'compact':
          await this.runCompactCommand(args);
          break;
        case 'status':
          await this.emitLocalCommandMessage(formatStatusReport(await this.session.getStatus()));
          break;
        case 'usage':
          await this.emitLocalCommandMessage(
            formatUsageReport(await this.session.getUsage(), await this.session.getStatus()),
          );
          break;
        case 'mcp':
          await this.emitLocalCommandMessage(formatMcpReport(await this.session.listMcpServers()));
          break;
        case 'tasks':
          await this.emitLocalCommandMessage(
            formatTasksReport(await this.session.listBackgroundTasks()),
          );
          break;
        case 'help':
          await this.emitLocalCommandMessage(formatHelpReport(this.availableCommands));
          break;
      }
    } catch (error) {
      await this.emitLocalCommandMessage(`/${name} failed: ${errorMessage(error)}`);
    }
    return { stopReason: 'end_turn' };
  }

  private async runUnknownSlashCommand(name: string): Promise<PromptResponse> {
    await this.emitLocalCommandMessage(
      `Unknown ACP command: /${name}. Use /help to see available commands.`,
    );
    return { stopReason: 'end_turn' };
  }

  private async emitLocalCommandMessage(text: string): Promise<void> {
    await this.conn.sessionUpdate({
      sessionId: this.id,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }

  private async runCompactCommand(args: string): Promise<void> {
    const instruction = args.trim() || undefined;
    let started = false;
    let unsubscribe: (() => void) | undefined;
    // The engine's compaction worker emits `session.compaction.started`
    // when the round begins and has no terminal event — completion is
    // signalled by `compact()` resolving (the SDK returns `void`, so no
    // result payload to surface). The subscription only records whether
    // a compaction actually started; a rejected `compact()` is surfaced
    // by `runBuiltInCommand`'s catch as `/compact failed: …`.
    unsubscribe = this.session.onEvent((event: Event) => {
      if (event.agentId !== undefined && event.agentId !== MAIN_AGENT_ID) return;
      if (event.type === 'session.compaction.started') {
        started = true;
        void this.emitLocalCommandMessage(
          instruction === undefined
            ? 'Compacting conversation context…'
            : `Compacting conversation context with instruction: ${instruction}`,
        );
      }
    });
    try {
      await this.session.compact({ instruction });
      if (!started) {
        await this.emitLocalCommandMessage('Compaction was not started.');
        return;
      }
      await this.emitLocalCommandMessage('Compaction complete.');
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * Body of {@link prompt}, extracted so the event-listener invariants
   * — single `onEvent` subscription, `settled` flag semantics,
   * `currentTurnId` reset — live in one place and can be driven by
   * either `Session.prompt(parts)` or `Session.activateSkill(name, args)`.
   * Both entry points trigger the same downstream turn (skill
   * activation internally calls `agent.turn.prompt(...)` after
   * injecting the `<kimi-skill-loaded>` block — see
   * `packages/agent-core/src/agent/skill/index.ts`), so the event
   * subscription's `session.turn.started` / `session.turn.ended`
   * semantics apply uniformly.
   */
  private runTurnBody(
    sessionId: string,
    conn: AgentSideConnection,
    kick: () => Promise<unknown>,
  ): Promise<PromptResponse> {
    return new Promise<PromptResponse>((resolve, reject) => {
      let settled = false;
      const isFromMainAgent = (event: { agentId?: string }): boolean =>
        event.agentId === undefined || event.agentId === MAIN_AGENT_ID;
      const initialActiveTurnId = this.currentTurnId;
      let hasReceivedOwnTurnStarted = false;
      const unsub = this.session.onEvent((event) => {
        if (
          event.type === 'session.turn.started' &&
          isFromMainAgent(event) &&
          (initialActiveTurnId === undefined || event.turn_id !== initialActiveTurnId)
        ) {
          hasReceivedOwnTurnStarted = true;
        }
        // Track the active turn so the busy-turn guard above can tell a
        // `session.turn.started` belonging to THIS prompt apart from a
        // pre-existing turn. Subagent turn events carry their own
        // `turn_id`; filtering on `agentId` keeps `currentTurnId`
        // aligned with the main-agent turn.
        if (
          'turn_id' in event &&
          typeof event.turn_id === 'number' &&
          isFromMainAgent(event)
        ) {
          this.currentTurnId = event.turn_id;
        }
        if (event.type === 'error') {
          if (settled) return;
          if (!isFromMainAgent(event)) return;
          if (event.code !== ErrorCodes.TURN_AGENT_BUSY) return;
          if (hasReceivedOwnTurnStarted) return;
          settled = true;
          this.currentTurnId = undefined;
          unsub();
          log.warn('acp: prompt rejected because another turn is active', {
            sessionId,
            details: event.details,
          });
          reject(
            RequestError.invalidRequest(
              { code: event.code, details: event.details },
              event.message,
            ),
          );
          return;
        }
        if (event.type === 'llm.delta') {
          if (!isFromMainAgent(event)) return;
          // `sessionUpdate` is itself async (it serializes onto the
          // ndjson stream). The text deltas form a strictly ordered
          // single-producer/single-consumer pipeline, so each await
          // would force the next delta to wait for the previous flush.
          // Fire-and-forget keeps the stream pumping; we log push
          // failures rather than dropping them silently.
          const part = event.part;
          if (part.type === 'text' && part.text !== undefined) {
            conn
              .sessionUpdate(assistantDeltaToSessionUpdate(sessionId, part.text))
              .catch((err) => {
                log.warn('acp: failed to push agent_message_chunk', {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          } else if (part.type === 'think' && part.think !== undefined) {
            conn
              .sessionUpdate(thinkingDeltaToSessionUpdate(sessionId, part.think))
              .catch((err) => {
                log.warn('acp: failed to push agent_thought_chunk', {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          }
          return;
        }
        if (event.type === 'session.tool.started') {
          if (!isFromMainAgent(event)) return;
          conn
            .sessionUpdate(toolCallStartToSessionUpdate(sessionId, event))
            .catch((err) => {
              log.warn('acp: failed to push tool_call', {
                sessionId,
                toolCallId: event.tool_call_id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'session.tool.settled') {
          if (!isFromMainAgent(event)) return;
          conn
            .sessionUpdate(toolResultToSessionUpdate(sessionId, event))
            .catch((err) => {
              log.warn('acp: failed to push tool_call_update (result)', {
                sessionId,
                toolCallId: event.tool_call_id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'session.turn.ended') {
          if (settled) return;
          if (!isFromMainAgent(event)) return;
          settled = true;
          this.currentTurnId = undefined;
          unsub();
          resolve({ stopReason: turnStopReasonToAcpStopReason(event.stop_reason) });
        }
      });

      kick().catch((err) => {
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
   *     (uses the raw SDK `toolCallId` — the engine's `session.tool.*`
   *     events carry no `turn_id`, so there is no prefix to compose).
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
    const toolCall = buildPermissionToolCallUpdate(req);
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
    // Raw SDK toolCallId verbatim (or the canonical 'ask-user'
    // placeholder when the request carries none) — the engine's
    // tool events carry no turn_id, so no `${turnId}:` prefix.
    const toolCallId = req.toolCallId ?? 'ask-user';
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
        this.emitTelemetry('question_answered', { answered: Object.keys(answer).length });
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
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatHelpReport(commands: readonly AvailableCommand[]): string {
  const visibleCommands: readonly AvailableCommand[] =
    commands.length > 0 ? commands : ACP_BUILTIN_SLASH_COMMANDS;
  return [
    'Available ACP commands:',
    ...visibleCommands.map((command) => {
      const hint = command.input?.hint ? ` ${command.input.hint}` : '';
      return `- /${command.name}${hint} — ${command.description}`;
    }),
  ].join('\n');
}

function formatStatusReport(status: SessionStatus): string {
  const maxTokens = status.maxContextTokens > 0 ? status.maxContextTokens.toLocaleString('en-US') : 'unknown';
  const usage = formatContextUsage(status.contextUsage);
  return [
    'Session status:',
    `- Model: ${status.model ?? '(not set)'}`,
    `- Thinking: ${status.thinkingEffort}`,
    `- Permission: ${status.permission}`,
    `- Plan mode: ${status.planMode ? 'on' : 'off'}`,
    `- Context: ${status.contextTokens.toLocaleString('en-US')} / ${maxTokens}${usage}`,
  ].join('\n');
}

function formatUsageReport(usage: SessionUsage, status: SessionStatus): string {
  const lines = ['Session usage:'];
  if (usage.total !== undefined) {
    lines.push(`- Total: ${formatTokenUsage(usage.total)}`);
  }
  if (usage.currentTurn !== undefined) {
    lines.push(`- Current turn: ${formatTokenUsage(usage.currentTurn)}`);
  }
  for (const [model, modelUsage] of Object.entries(usage.byModel ?? {})) {
    lines.push(`- ${model}: ${formatTokenUsage(modelUsage)}`);
  }
  lines.push(
    `- Context: ${status.contextTokens.toLocaleString('en-US')} / ${status.maxContextTokens.toLocaleString('en-US')}${formatContextUsage(status.contextUsage)}`,
  );
  return lines.join('\n');
}

function formatMcpReport(servers: readonly McpServerInfo[]): string {
  if (servers.length === 0) return 'No MCP servers are configured for this session.';
  return [
    `MCP servers (${servers.length}):`,
    ...servers.map((server) => {
      const base = `- ${server.name}: ${server.status} (${server.transport}, ${server.toolCount} tools)`;
      return server.error === undefined ? base : `${base}\n  Error: ${server.error}`;
    }),
  ].join('\n');
}

function formatTasksReport(tasks: readonly BackgroundTaskInfo[]): string {
  if (tasks.length === 0) return 'No background tasks for this session.';
  return [
    `Background tasks (${tasks.length}):`,
    ...tasks.map((task) => {
      const parts = [`- ${task.taskId}: ${task.status}`, task.description];
      if (task.kind === 'process') parts.push(`command=${task.command}`);
      if (task.kind === 'agent' && task.subagentType !== undefined) parts.push(`subagent=${task.subagentType}`);
      if (task.stopReason !== undefined) parts.push(`reason=${task.stopReason}`);
      return parts.join(' · ');
    }),
  ].join('\n');
}

function formatTokenUsage(usage: NonNullable<SessionUsage['total']>): string {
  return [
    `input ${usage.inputOther.toLocaleString('en-US')}`,
    `output ${usage.output.toLocaleString('en-US')}`,
    `cache read ${usage.inputCacheRead.toLocaleString('en-US')}`,
    `cache creation ${usage.inputCacheCreation.toLocaleString('en-US')}`,
  ].join(', ');
}

// agent-core emits `contextUsage` as a 0..1 fraction (`contextTokens /
// maxContextTokens` — see agent-core/src/agent/index.ts:419-422). It can
// briefly exceed 1.0 when a turn overflows the budget; we still surface
// that as ">100%" rather than collapsing back into 0..1.
function formatContextUsage(contextUsage: number): string {
  if (!Number.isFinite(contextUsage) || contextUsage < 0) return '';
  return ` (${(contextUsage * 100).toFixed(1)}%)`;
}

/**
 * Inspect the leading `ContentBlock` of an ACP prompt for a
 * `/skill:<name>` form. Only the first block is examined — when Zed
 * (or any other ACP client) sends a slash command, it always lives in
 * the first text block; multi-part prompts that interleave images or
 * resources before text are typed by humans and do not start with a
 * slash. Non-text leading blocks short-circuit to passthrough.
 *
 * The parsing/resolution itself is delegated to `./slash` —
 * deliberately duplicated from the TUI's
 * `apps/kimi-code/src/tui/commands/parse.ts` and `resolve.ts` to
 * avoid an app→package import inversion. See `./slash`'s top-of-file
 * comment for the sync target.
 */
function detectLeadingSlashIntent(
  blocks: readonly ContentBlock[],
  skillCommandMap: ReadonlyMap<string, string>,
): ReturnType<typeof detectSlashIntent> {
  const first = blocks[0];
  if (!first || first.type !== 'text') return { kind: 'passthrough' };
  return detectSlashIntent(first.text, skillCommandMap);
}

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
 * Identifier the engine session emits for the main (user-facing)
 * agent. Subagents are issued generated ids by `Session.spawnAgent`;
 * filtering on this constant keeps `session.turn.ended` / `error`
 * events from a child agent from settling the parent's `session/prompt`
 * promise.
 */
const MAIN_AGENT_ID = 'main';

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
