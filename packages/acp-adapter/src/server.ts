/**
 * ACP `AgentSideConnection` wrapper.
 *
 * Phase 3 implements `initialize`, `session/new`, and `session/cancel`
 * against {@link KimiHarness}. `prompt` is wired in step 3.4. `initialize`
 * advertises the terminal-auth method (see {@link TERMINAL_AUTH_METHOD}).
 */

import { Readable, Writable } from 'node:stream';

import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
  type Agent,
  type AgentCapabilities,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { KimiHarness, Session, SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';

import { TERMINAL_AUTH_METHOD, buildTerminalAuthMethod } from './auth-methods';
import { redirectConsoleToStderr } from './log-guard';
import { AcpSession, type TelemetryTrackFn } from './session';
import { buildSessionConfigOptions } from './config-options';
import { availableCommandsUpdateNotification } from './events-map';
import { acpMcpServersToConfigs } from './mcp';
import { listModelsFromHarness } from './model-catalog';
import { DEFAULT_MODE_ID } from './modes';
import { negotiateVersion, type AcpVersionSpec } from './version';

/**
 * Inline auth gate — moved out of `KimiAuthFacade.hasUsableToken()` so
 * the SDK doesn't have to carry an ACP-specific convenience method.
 * Mirrors the original semantics exactly: any provider with `hasToken`
 * set counts as authed.
 */
async function harnessIsAuthed(harness: KimiHarness): Promise<boolean> {
  const status = await harness.auth.status();
  return status.providers.some((entry) => entry.hasToken === true);
}

/**
 * Agent-side ACP handler. Routes `initialize` + `session/new` + `session/cancel`
 * into {@link KimiHarness}; refuses methods that are not yet wired with a
 * JSON-RPC "method not found" error so clients see a structured failure
 * rather than a silent hang.
 *
 * The harness is captured eagerly so Phase 3 routes `session/new`,
 * `session/cancel` (and Phase 3.4: `session/prompt`) into it without
 * changing the public constructor. The {@link AgentSideConnection} (if
 * supplied) is forwarded to every {@link AcpSession} so the session can
 * push `session/update` chunks back to the client.
 */
export class AcpServer implements Agent {
  private negotiated: AcpVersionSpec | undefined;
  private clientCapabilities: ClientCapabilities | undefined;
  private readonly sessions = new Map<string, AcpSession>();
  private readonly agentInfo: Implementation | undefined;
  private readonly terminalAuthEnv: Readonly<Record<string, string>> | undefined;
  private readonly terminalAuthLegacyCommand: string | undefined;

  constructor(
    private readonly harness: KimiHarness,
    private readonly conn?: AgentSideConnection | undefined,
    opts?: {
      agentInfo?: Implementation;
      /**
       * Env vars to advertise in `authMethods[0].env` so the `kimi login`
       * subprocess the client spawns (via `terminal-auth`) lands its
       * token under the same data root the ACP server uses. Intended for
       * sandboxed test setups (e.g. `{ KIMI_CODE_HOME: '/tmp/...' }`);
       * leave undefined in production so the advertised env stays empty.
       */
      terminalAuthEnv?: Readonly<Record<string, string>>;
      /**
       * Absolute binary path advertised in `_meta['terminal-auth'].command`
       * for clients that don't yet honor the first-class
       * `AuthMethodTerminal` (Zed without `AcpBetaFeatureFlag`, JetBrains
       * plugin). Clients on this legacy path spawn `<command> login`
       * directly. Defaults to undefined (the `_meta` fallback is omitted).
       */
      terminalAuthLegacyCommand?: string;
    },
  ) {
    this.agentInfo = opts?.agentInfo;
    this.terminalAuthEnv = opts?.terminalAuthEnv;
    this.terminalAuthLegacyCommand = opts?.terminalAuthLegacyCommand;
  }

  /** Returns the {@link AcpVersionSpec} chosen during `initialize`, if any. */
  get negotiatedVersion(): AcpVersionSpec | undefined {
    return this.negotiated;
  }

  /** Returns the client capabilities advertised during `initialize`, if any. */
  get clientCaps(): ClientCapabilities | undefined {
    return this.clientCapabilities;
  }

  /** @internal — for tests/inspection only. */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.negotiated = negotiateVersion(params.protocolVersion);
    this.clientCapabilities = params.clientCapabilities;

    const agentCapabilities: AgentCapabilities = {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: false,
      },
      mcpCapabilities: {
        http: true,
        sse: false,
      },
      sessionCapabilities: {
        list: {},
        resume: {},
      },
    };

    return {
      protocolVersion: this.negotiated.protocolVersion,
      agentCapabilities,
      authMethods: [
        this.terminalAuthEnv !== undefined || this.terminalAuthLegacyCommand !== undefined
          ? buildTerminalAuthMethod({
              env: this.terminalAuthEnv,
              legacyCommand: this.terminalAuthLegacyCommand,
            })
          : TERMINAL_AUTH_METHOD,
      ],
      ...(this.agentInfo ? { agentInfo: this.agentInfo } : {}),
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!(await harnessIsAuthed(this.harness))) {
      throw RequestError.authRequired();
    }
    // ACP's `cwd` maps to the SDK's `workDir`. `model`, `planMode`, and
    // similar fields are wired in Phase 8 (per PLAN D3) — Phase 3.2 keeps
    // the surface minimal. Phase 10.1 adds `mcpServers` forwarding so
    // ACP-supplied servers (Zed config, JetBrains config) are passed
    // alongside the on-disk config; unsupported transports (sse/acp)
    // are warn-dropped inside the conversion. `mcpServers` is NOT a
    // declared field on `CreateSessionOptions` — the SDK is a
    // transparent passthrough for unknown fields (see
    // `packages/node-sdk/src/kimi-harness.ts:createSession` and
    // `packages/node-sdk/src/rpc.ts:createSession`), so the kernel
    // (`CreateSessionPayload.mcpServers` in agent-core) receives the
    // record verbatim. The `@ts-expect-error` documents this contract;
    // if the SDK ever switches from spread-passthrough to explicit field
    // copy, this line breaks and we revisit the boundary.
    const mcpServers = acpMcpServersToConfigs(params.mcpServers);
    const session = await this.harness.createSession({
      workDir: params.cwd,
      // @ts-expect-error — `mcpServers` is a kernel-side extension
      // (agent-core `CreateSessionPayload`) the SDK transparently
      // forwards via spread. See block comment above.
      mcpServers,
    });
    if (!this.conn) {
      // Defensive: every code path that constructs `AcpServer` (the
      // runners below, and any test that intends to drive `newSession`)
      // must supply the connection. Surface a clear internal error
      // rather than letting Phase 3.4's `prompt` discover a missing
      // connection mid-stream.
      throw RequestError.internalError(undefined, 'AcpServer is missing its AgentSideConnection');
    }
    const currentModelId = await this.resolveCurrentModelId();
    const currentThinkingEnabled = await this.resolveCurrentThinkingEnabled();
    const acpSession = new AcpSession(
      this.conn,
      session,
      this.clientCapabilities,
      this.makeTelemetryTrack(),
      currentModelId,
      this.harness,
      currentThinkingEnabled,
    );
    this.sessions.set(session.id, acpSession);
    // Telemetry breadcrumb so we can observe ACP adoption (number of
    // sessions started via this surface, vs. TUI / SDK direct). The
    // property set is deliberately minimal: `mode` distinguishes
    // `newSession` from `loadSession`; no user content / PII.
    this.trackSessionStarted(session.id, 'new');
    await this.emitAvailableCommandsUpdate(session.id);
    // Phase 14 (PLAN D11) advertises both the model and mode pickers as
    // a unified `configOptions: SessionConfigOption[]` surface. The
    // dedicated Phase 12 `modes:` field is gone — see
    // `docs/{zh,en}/reference/kimi-acp.md` and the changeset for the
    // pre-release breaking note. `currentModeId` always starts at
    // `default` (PLAN D9); `currentModelId` is resolved from the harness
    // config (`defaultModel` if set, else the first listed alias) so
    // the dropdown's "current" highlight matches the session the SDK
    // just constructed. Phase 15 adds the `thinking` toggle when the
    // current model's catalog row advertises `thinkingSupported`;
    // Phase 16 reshaped that toggle from `boolean` to a 2-entry
    // `select` so Zed actually renders it.
    return {
      sessionId: session.id,
      configOptions: await buildSessionConfigOptions(
        this.harness,
        currentModelId,
        currentThinkingEnabled,
        DEFAULT_MODE_ID,
      ),
    };
  }

  /**
   * Handle ACP `session/load`. Mirrors {@link newSession}'s auth gate
   * and connection guard, but resumes an existing on-disk session
   * via the shared {@link setupSessionFromExisting} helper instead of
   * creating a new one. After the AcpSession is wired up, replays the
   * persisted history as a synchronous batch of `session/update`
   * notifications so the client sees the prior turns before the
   * response settles.
   *
   * The ACP `LoadSessionResponse` shape allows an empty body — every
   * field (`configOptions`, `models`, `modes`) is optional. Phase 12.1
   * starts populating `modes` so a resumed session re-renders Zed's
   * mode dropdown identically to a freshly created one; the
   * `currentModeId` is always `default` on load because the SDK does
   * not persist mode across runs (PLAN D9).
   *
   * The non-trivial setup (auth gate, connection guard, harness
   * resume, AcpSession construction, session registration, configOptions
   * computation) is shared with {@link resumeSession} via
   * {@link setupSessionFromExisting}; the ONE differentiator is that
   * `loadSession` calls `replayHistory()` here, whereas `resumeSession`
   * deliberately skips it (per ACP spec G4 / plan gap-4.3).
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const { session, acpSession, configOptions } = await this.setupSessionFromExisting({
      cwd: params.cwd,
      sessionId: params.sessionId,
      mcpServers: params.mcpServers,
    });
    // Same telemetry breadcrumb as `newSession`, but `mode: 'load'`
    // so we can distinguish session creation from resumption. No PII.
    this.trackSessionStarted(session.id, 'load');
    // Synchronously replay history — the response must not settle
    // until every historical `session/update` has been pushed,
    // otherwise the client would race the load completion against
    // its own UI bootstrap. This is the ONE difference vs.
    // `resumeSession`, which intentionally omits this step.
    await acpSession.replayHistory();
    await this.emitAvailableCommandsUpdate(session.id);
    return { configOptions };
  }

  /**
   * Handle ACP `session/resume`. Per ACP spec, `session/resume` is the
   * lighter-weight sibling of `session/load`: same on-disk session
   * rehydration, same `configOptions:` advertisement — but the client
   * is expected to have already seen the prior turns, so the agent
   * deliberately does NOT replay history. This makes `resumeSession`
   * the right surface for clients that maintain their own transcript
   * (e.g. external session managers, or a TUI reattaching to a still-
   * running session) and would only flicker if the agent re-emitted
   * the historical `session/update` notifications.
   *
   * Setup is shared verbatim with {@link loadSession} via
   * {@link setupSessionFromExisting} (auth gate, conn guard, harness
   * `resumeSession` with `session.not_found` mapping, AcpSession
   * construction, configOptions build). The only differences are:
   * (a) telemetry mode is `'resume'` (vs `'load'`), and (b) no
   * `replayHistory()` call. See plan G4 (lines 106-170) for the
   * rationale, and gap-4.1 for the matching capability advertisement.
   */
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const { session, configOptions } = await this.setupSessionFromExisting({
      cwd: params.cwd,
      sessionId: params.sessionId,
      mcpServers: params.mcpServers,
    });
    // Telemetry breadcrumb — distinguishes resume from new/load so we
    // can observe which clients adopt the lighter-weight resume
    // surface vs the history-replaying load surface. No PII.
    this.trackSessionStarted(session.id, 'resume');
    await this.emitAvailableCommandsUpdate(session.id);
    return { configOptions };
  }

  /**
   * Shared setup for `session/load` and `session/resume`: gates auth,
   * checks the connection, resolves MCP servers, asks the harness to
   * resume the on-disk session, computes the current model/thinking
   * projection (with a resume-state fallback), constructs the
   * {@link AcpSession}, registers it under `session.id`, and builds
   * the unified `configOptions:` surface (PLAN D11) that both handlers
   * return.
   *
   * Behavior is byte-for-byte identical to the pre-refactor
   * `loadSession` body minus the `replayHistory()` call — which lives
   * in `loadSession` itself because `resumeSession` per ACP spec must
   * NOT replay history (the client is expected to have already seen
   * those turns; replay is a load-only behavior). See plan G4
   * (lines 106-170) for the rationale.
   *
   * The `@ts-expect-error` boundary at the SDK `resumeSession` call
   * is preserved verbatim — `mcpServers` is a kernel-only extension
   * the SDK forwards via spread (see the `newSession` comment block
   * for the full contract). The `session.not_found` → `invalidParams`
   * mapping is also preserved so unknown-session errors surface as a
   * structured JSON-RPC failure rather than a generic internal error.
   */
  private async setupSessionFromExisting(params: {
    cwd: string;
    sessionId: string;
    mcpServers?: ReadonlyArray<McpServer>;
  }): Promise<{
    session: Session;
    acpSession: AcpSession;
    configOptions: SessionConfigOption[];
  }> {
    if (!(await harnessIsAuthed(this.harness))) {
      throw RequestError.authRequired();
    }
    if (!this.conn) {
      throw RequestError.internalError(undefined, 'AcpServer is missing its AgentSideConnection');
    }
    // ACP `cwd` → SDK `workDir` for parity with `newSession`. The
    // harness's `resumeSession` only takes `{ id }` today; the cwd
    // arrives on the request for future validation but is not enforced
    // here (the on-disk session already has its own workDir). Phase
    // 10.1 also forwards `mcpServers` so a resumed session can pick up
    // ACP-supplied MCP servers (matching `newSession` behaviour). Same
    // `@ts-expect-error` boundary as `newSession` — the SDK's
    // `resumeSession` spreads `input` so unknown fields ride to the
    // kernel.
    const mcpServers = acpMcpServersToConfigs(params.mcpServers);
    let session: Session;
    try {
      session = await this.harness.resumeSession({
        id: params.sessionId,
        // @ts-expect-error — see block comment above; mcpServers is a
        // kernel-only field that the SDK forwards via spread.
        mcpServers,
      });
    } catch (err) {
      // Surface unknown-session as invalid_params so the JSON-RPC layer
      // returns a structured failure rather than a generic internal
      // error. Other errors propagate as-is.
      const code = (err as { code?: string } | undefined)?.code;
      if (code === 'session.not_found') {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `Unknown sessionId: ${params.sessionId}`,
        );
      }
      throw err;
    }
    // Phase 14 (PLAN D11) — same `configOptions:` advertisement as
    // `newSession`. `currentModeId` is `default` on every load (mode
    // is session-scoped per PLAN D9); `currentModelId` is read from
    // the resumed session's main-agent config when available so the
    // dropdown's highlight matches the model the resumed turn will
    // actually use — falling back to the harness-level default
    // resolution when the resume state lacks a `modelAlias`.
    const resumeState = session.getResumeState?.();
    const resumedModelAlias = resumeState?.agents?.['main']?.config?.modelAlias;
    const currentModelId =
      typeof resumedModelAlias === 'string' && resumedModelAlias.length > 0
        ? resumedModelAlias
        : await this.resolveCurrentModelId();
    // Phase 15 reads the resumed thinking level off the main-agent
    // config and projects it onto the binary toggle: any non-`'off'`
    // effort level reads as "thinking on" because the ACP surface only
    // exposes the boolean axis. Falls back to the harness-level default
    // when the resume state lacks the field.
    const resumedThinkingLevel = resumeState?.agents?.['main']?.config?.thinkingLevel;
    const currentThinkingEnabled =
      typeof resumedThinkingLevel === 'string'
        ? resumedThinkingLevel.trim().toLowerCase() !== 'off' &&
          resumedThinkingLevel.trim().length > 0
        : await this.resolveCurrentThinkingEnabled();
    const acpSession = new AcpSession(
      this.conn,
      session,
      this.clientCapabilities,
      this.makeTelemetryTrack(),
      currentModelId,
      this.harness,
      currentThinkingEnabled,
    );
    this.sessions.set(session.id, acpSession);
    const configOptions = await buildSessionConfigOptions(
      this.harness,
      currentModelId,
      currentThinkingEnabled,
      DEFAULT_MODE_ID,
    );
    return { session, acpSession, configOptions };
  }

  /**
   * Re-check whether the on-disk token is usable; does NOT trigger an
   * actual OAuth flow. The stdio JSON-RPC channel has no TTY to render
   * the device-code prompt — clients are expected to spawn
   * `kimi login` themselves via the terminal-auth method advertised in
   * `initialize.authMethods` (`args:['login']`, see {@link TERMINAL_AUTH_METHOD})
   * and then re-invoke `authenticate('login')` to confirm the token
   * landed on disk. Mirrors kimi-cli `acp/server.py:374-398` semantics
   * (plan G3, lines 68-104).
   */
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    if (params.methodId !== 'login') {
      throw RequestError.invalidParams(
        { methodId: params.methodId },
        `Unknown auth method: ${params.methodId}`,
      );
    }
    if (!(await harnessIsAuthed(this.harness))) {
      throw RequestError.authRequired();
    }
    // void = empty success body (ACP allows AuthenticateResponse | void).
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    }
    return acpSession.prompt(params.prompt);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      // `cancel` is a JSON-RPC notification — the spec forbids notifications
      // returning errors. Log so unknown sessionIds aren't silently absorbed.
      log.warn('acp: cancel for unknown sessionId', { sessionId: params.sessionId });
      return;
    }
    try {
      await acpSession.cancel();
    } catch (err) {
      // Same notification-cannot-error rule: log and swallow.
      log.warn('acp: error while cancelling session', {
        sessionId: params.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle ACP `session/set_mode`. Looks the session up by id and
   * forwards to {@link AcpSession.setMode}. Unknown session ids throw
   * `invalid_params`; unknown modeIds throw `invalid_params` from
   * inside {@link AcpSession.setMode}.
   *
   * The ACP schema models the response as a `_meta`-only object; we
   * return `undefined` (allowed by the `Agent` interface's
   * `SetSessionModeResponse | void` union) so the wire payload is the
   * canonical empty success.
   */
  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    await acpSession.setMode(params.modeId);
  }

  /**
   * Handle the experimental ACP `session/set_model`
   * (`unstable_setSessionModel`). Looks the session up by id and
   * forwards to {@link AcpSession.setModel}. Errors from the SDK
   * (e.g. an unknown model) propagate as-is so the JSON-RPC layer can
   * surface a structured failure.
   */
  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    await acpSession.setModel(params.modelId);
  }

  /**
   * Handle ACP `session/set_config_option` — the spec's generic
   * config-picker dispatch (PLAN D11). Routes by `params.configId`:
   *
   *  - `'model'` → {@link AcpSession.setModel} (same path as
   *    {@link unstable_setSessionModel}).
   *  - `'mode'`  → {@link AcpSession.setMode} (same path as
   *    {@link setSessionMode}).
   *  - anything else → JSON-RPC `invalid_params` (-32602) BEFORE any
   *    SDK call, so the client sees a structured rejection rather
   *    than a half-applied state change.
   *
   * The underlying {@link AcpSession} methods already emit
   * `config_option_update` via {@link AcpSession.emitConfigOptionUpdate}
   * after the SDK call lands, so the response handler does NOT
   * double-emit — it only builds a fresh snapshot from the now-current
   * `currentModelId` + `currentModeId` and returns it on the wire.
   * This funnels all three input paths
   * (`unstable_setSessionModel` / `setSessionMode` / `setSessionConfigOption`)
   * through the same notification channel with identical shape.
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    const value = (params as { value: unknown }).value;
    switch (params.configId) {
      case 'model':
        await acpSession.setModel(String(value));
        break;
      case 'mode':
        await acpSession.setMode(String(value));
        break;
      case 'thinking': {
        // Phase 16 changed the wire shape from boolean to a 2-entry
        // `select` (`'on'` / `'off'`) for Zed UI compatibility. Strict
        // equality with `'on'` keeps the parse deterministic — any
        // other string (including a stale `true` / `false` boolean
        // sent by a pre-Phase-16 client) reads as "off" rather than
        // silently flipping based on truthiness.
        await acpSession.setThinking(value === 'on');
        break;
      }
      default:
        throw RequestError.invalidParams(
          { configId: params.configId },
          `Unknown configId: ${params.configId}`,
        );
    }
    return {
      configOptions: await buildSessionConfigOptions(
        this.harness,
        acpSession.currentModelId,
        acpSession.currentThinkingEnabled,
        acpSession.currentModeId,
      ),
    };
  }

  /**
   * Handle ACP `session/list`. Forwards to
   * {@link KimiHarness.listSessions} (optionally filtered by `cwd` —
   * the SDK calls it `workDir`) and projects each
   * {@link SessionSummary} into an ACP {@link SessionInfo}.
   *
   * No pagination support in this version — `nextCursor` is always
   * `null`. Mirrors the Python reference at `acp/server.py:303-322`
   * where the response is built in a single shot from the harness'
   * full snapshot.
   */
  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP `cwd` ↔ SDK `workDir`. The filter is optional; treat
    // `null` (the schema-allowed sentinel for "no filter") the same
    // as `undefined`.
    const cwd = params.cwd ?? undefined;
    const summaries = await this.harness.listSessions(
      cwd === undefined ? {} : { workDir: cwd },
    );
    const sessions: SessionInfo[] = summaries.map((summary) =>
      sessionSummaryToSessionInfo(summary),
    );
    return { sessions, nextCursor: null };
  }

  /**
   * Stub the ACP `ext/<method>` extension surface. The interface
   * declares both `extMethod` and `extNotification` as optional, but
   * implementing them explicitly with a structured `MethodNotFound`
   * response gives clients a uniform failure shape (mirrors the
   * `authenticate` pattern at {@link AcpServer.authenticate}) — some
   * clients treat "method absent on the agent" differently from an
   * explicit error reply.
   *
   * Future work (PLAN D9): route slash-command bridge / model-list /
   * mode-list extensions through here once the adapter has access to
   * the kimi-code app's registry. Phase 11 keeps it as a no-op stub.
   */
  async extMethod(
    method: string,
    _params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    throw RequestError.methodNotFound(method);
  }

  /**
   * Stub the ACP extension-notification surface. Symmetric to
   * {@link extMethod}: throwing `MethodNotFound` here surfaces a
   * structured failure on the JSON-RPC channel rather than a silent
   * drop. The ACP SDK currently models notifications as void-returning
   * promises; throwing is the only way to signal "unsupported" back to
   * the connection layer.
   */
  async extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    throw RequestError.methodNotFound(method);
  }

  /**
   * Compute the `currentValue` for the `model` config option when the
   * caller (either `newSession` or `loadSession`'s fallback path) does
   * not have a more specific signal. Prefers the harness's configured
   * `defaultModel`; otherwise falls back to the first listed catalog
   * alias so the dropdown's "current" highlight is always one of the
   * options the client will render. Returns the empty string when the
   * harness has no models at all — a degenerate config the UI can still
   * render (an empty dropdown with an empty `currentValue`).
   *
   * Tolerant to partial-stub harnesses (`getConfig` missing or
   * throwing) — adapter-level unit tests routinely construct minimal
   * `KimiHarness` shapes that only stub `auth.status` + `createSession`.
   * Production callers always supply a real harness with both methods;
   * the swallow-and-fallback path exists purely for test ergonomics
   * (matches the `track?.bind(...)` pattern at `trackSessionStarted`).
   *
   * Logged at `warn` when a fallback fires so a dev who forgot to set
   * `default_model = ...` sees a breadcrumb in the agent log.
   */
  private async resolveCurrentModelId(): Promise<string> {
    // Minimal-stub harnesses (no `getConfig`) skip the catalog entirely
    // and return the empty string silently. The old code path was the
    // same — `listAvailableModels` used to live behind a
    // `typeof harness.listAvailableModels === 'function'` guard, and we
    // preserve that ergonomic so adapter unit tests with bare-bones
    // stubs don't fire spurious "no models" warnings.
    if (typeof this.harness.getConfig !== 'function') return '';
    try {
      const config = await this.harness.getConfig();
      const declared = config.defaultModel;
      if (typeof declared === 'string' && declared.length > 0) {
        return declared;
      }
    } catch (err) {
      log.warn('acp: harness.getConfig threw during configOptions assembly; falling back', {
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
    try {
      const models = await listModelsFromHarness(this.harness);
      if (models.length === 0) {
        log.warn('acp: harness exposes no models; configOptions will ship an empty model picker');
        return '';
      }
      log.warn(
        'acp: harness has no defaultModel; falling back to first catalog entry for configOptions.currentValue',
        { fallbackModelId: models[0]!.id },
      );
      return models[0]!.id;
    } catch (err) {
      log.warn('acp: listModelsFromHarness threw during configOptions assembly', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return '';
  }

  /**
   * Compute the initial value for the `thinking` toggle when
   * a session is created (or loaded with no persisted thinking state).
   * Reads the harness's `getConfig().defaultThinking` flag if exposed —
   * the same source `Session.createSession` would consult for new
   * sessions. Returns `false` when the harness has no opinion, so the
   * toggle starts off.
   *
   * Tolerant to partial-stub harnesses for the same reason
   * {@link resolveCurrentModelId} is — adapter-level unit tests
   * routinely omit `getConfig`. The swallow-and-fallback path keeps
   * the test ergonomics symmetric.
   */
  private async resolveCurrentThinkingEnabled(): Promise<boolean> {
    if (typeof this.harness.getConfig !== 'function') return false;
    try {
      const config = await this.harness.getConfig();
      const declared = (config as { defaultThinking?: unknown }).defaultThinking;
      if (typeof declared === 'boolean') return declared;
      if (typeof declared === 'string') {
        const normalized = declared.trim().toLowerCase();
        return normalized !== 'off' && normalized.length > 0;
      }
      return false;
    } catch (err) {
      log.warn('acp: harness.getConfig threw during thinking toggle resolution; defaulting to off', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Build a {@link TelemetryTrackFn} wrapper bound to the underlying
   * harness so the {@link AcpSession} (and its reverse-RPC bridges in
   * Phase 13) can emit PII-free breadcrumbs through the same
   * `harness.track` channel `trackSessionStarted` uses. The wrapper
   * shape is required by the broader `Record<string, unknown>` properties
   * type {@link TelemetryTrackFn} uses — the harness's own `track` is
   * typed against the narrower `TelemetryProperties` (a
   * `Readonly<Record<string, boolean | number | string | undefined | null>>`),
   * and TS won't widen the parameter type implicitly when assigning into
   * a function-valued field. Phase 13's call sites (`session.ts:790,797,820,822,717`)
   * only emit primitive-valued properties so the runtime narrowing is
   * upheld by construction; the cast is purely a compile-time bridge.
   *
   * Returns `undefined` when the harness lacks `.track` (unit-test
   * stubs); {@link AcpSession} treats absence as "silent passthrough"
   * via {@link safeTrack}.
   */
  private makeTelemetryTrack(): TelemetryTrackFn | undefined {
    const harness = this.harness;
    if (typeof harness.track !== 'function') return undefined;
    return (event, properties) => {
      // Cast: the harness expects the narrower `TelemetryProperties`
      // shape (Readonly<Record<string, primitive>>); Phase 13 callers
      // only pass primitive values so the runtime contract holds.
      harness.track(event, properties as Parameters<typeof harness.track>[1]);
    };
  }

  /**
   * Push the one-shot `available_commands_update` session_update that
   * ACP clients use to populate a slash-command palette. Called once
   * per session, immediately after the {@link AcpSession} is
   * registered (so the wire id is stable when the notification
   * arrives) but before the public RPC reply is returned (so a client
   * that synchronously sets up listeners on session creation cannot
   * miss the event).
   *
   * The kimi-code slash-command registry lives in
   * `apps/kimi-code/src/tui/commands/registry.ts` — i.e. an app-level
   * concern that the acp-adapter (a `packages/` library) has no
   * access to. We emit an empty list so the client sees a
   * deterministic update; a richer surface is deferred to a future
   * step (PLAN D9 / ext_method).
   *
   * Errors are caught and logged, never thrown: pushing
   * `session/update` is a streaming concern, not load-bearing for
   * the `session/new` (or `session/load`) reply.
   */
  private async emitAvailableCommandsUpdate(sessionId: string): Promise<void> {
    if (!this.conn) return;
    try {
      await this.conn.sessionUpdate(availableCommandsUpdateNotification(sessionId));
    } catch (err) {
      log.warn('acp: failed to push available_commands_update', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Emit the single ACP-adapter telemetry event.
   *
   * Wraps {@link KimiHarness.track} so a partial harness stub
   * (common in unit tests — see `auth-gate.test.ts`, `session-new.test.ts`)
   * cannot crash the request path. Production callers always supply a
   * real harness with `.track`; the swallow-and-log fallback exists
   * purely for test ergonomics.
   *
   * Property set is deliberately minimal: `sessionId` + `mode`. No
   * user content, no IDE identity, no client capabilities — keeping
   * the breadcrumb PII-free.
   */
  private trackSessionStarted(sessionId: string, mode: 'new' | 'load' | 'resume'): void {
    const track = this.harness.track?.bind(this.harness);
    if (typeof track !== 'function') return;
    try {
      track('acp_session_started', { sessionId, mode });
    } catch (err) {
      log.warn('acp: telemetry track failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Drive an {@link AcpServer} over an arbitrary ACP {@link Stream}.
 *
 * Useful for tests that build the stream with `ndJsonStream` over an
 * in-memory pair instead of process stdio.
 */
export async function runAcpServerWithStream(
  harness: KimiHarness,
  stream: Stream,
  opts?: {
    agentInfo?: Implementation;
    terminalAuthEnv?: Readonly<Record<string, string>>;
    terminalAuthLegacyCommand?: string;
  },
): Promise<void> {
  const conn = new AgentSideConnection((c) => new AcpServer(harness, c, opts), stream);
  await conn.closed;
}

/**
 * Drive an {@link AcpServer} over Node stdio (or the supplied streams).
 *
 * The ACP SDK speaks Web `ReadableStream` / `WritableStream`, so Node stdio
 * is bridged through `Readable.toWeb` / `Writable.toWeb`.
 *
 * Phase 11.1 wires SIGINT / SIGTERM to a single-shot cleanup that calls
 * {@link KimiHarness.close} so an editor terminating the agent process
 * (Zed closing the panel, JetBrains stopping the run config, the user
 * pressing Ctrl-C) drains in-flight sessions before the OS reaps the
 * process. The handlers are installed via `.once(...)` and explicitly
 * uninstalled in `finally` so repeat invocations from tests do not
 * pollute the process-wide listener set.
 *
 * The `signals` option exists primarily for tests — production callers
 * use the default of `process`. A test can pass a fresh
 * `EventEmitter`, emit `'SIGINT'` on it, and assert `harness.close()`
 * was called exactly once without touching the real Node signal
 * handlers (which vitest itself relies on).
 */
export async function runAcpServer(
  harness: KimiHarness,
  opts?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    /**
     * Optional agent identity metadata advertised in the `initialize`
     * response (`InitializeResponse.agentInfo`). When omitted, the
     * field is left out of the response rather than serialized as
     * `null`, matching the kimi-cli reference implementation.
     */
    agentInfo?: Implementation;
    /**
     * Env vars to forward to the `kimi login` subprocess clients spawn
     * via `terminal-auth`. See {@link AcpServer} ctor for the use case.
     */
    terminalAuthEnv?: Readonly<Record<string, string>>;
    /**
     * Absolute path to the agent binary, advertised in the legacy
     * `_meta['terminal-auth'].command` fallback. See {@link AcpServer}
     * ctor for compatibility rationale.
     */
    terminalAuthLegacyCommand?: string;
    /**
     * @internal Test seam — supply a fake `EventEmitter` (or a
     * subset that exposes `.once` / `.off`) to drive SIGINT / SIGTERM
     * without touching the real `process` listener set. Defaults to
     * `process` in production.
     */
    signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'>;
  },
): Promise<void> {
  // Stdout is the JSON-RPC channel; protect it before anything else
  // (a dependency, harness, etc.) can emit non-JSON via console.log.
  redirectConsoleToStderr();
  const input = (opts?.input ?? process.stdin) as Readable;
  const output = (opts?.output ?? process.stdout) as Writable;
  const stream = ndJsonStream(Writable.toWeb(output), Readable.toWeb(input));
  const signals = opts?.signals ?? process;

  let cleanedUp = false;
  const cleanup = async (signal?: NodeJS.Signals): Promise<void> => {
    // Idempotent: signal-then-natural-close (or vice-versa) must not
    // call `harness.close()` twice. `cleanedUp` is checked-and-set
    // synchronously so concurrent invocations cannot race.
    if (cleanedUp) return;
    cleanedUp = true;
    if (signal) {
      log.info('acp: received signal, draining harness', { signal });
    }
    try {
      await harness.close();
    } catch (err) {
      // The process is exiting either way; log so the diagnostic is
      // preserved rather than disappearing into a thrown promise.
      log.error('acp: harness close failed during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onSigint = (): void => {
    void cleanup('SIGINT');
  };
  const onSigterm = (): void => {
    void cleanup('SIGTERM');
  };
  signals.once('SIGINT', onSigint);
  signals.once('SIGTERM', onSigterm);

  try {
    // Resolves when `AgentSideConnection.closed` settles — either
    // because the client disconnected stdin (natural EOF) or because
    // a signal handler closed the underlying stream.
    await runAcpServerWithStream(harness, stream, {
      agentInfo: opts?.agentInfo,
      terminalAuthEnv: opts?.terminalAuthEnv,
      terminalAuthLegacyCommand: opts?.terminalAuthLegacyCommand,
    });
  } finally {
    // Uninstall BEFORE the final cleanup so a second SIGINT (a user
    // double-tapping Ctrl-C while the drain is in flight) propagates
    // to the default handler and force-kills the process — exactly
    // the behaviour terminal users expect.
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    await cleanup();
  }
}

/**
 * Project a Kimi SDK {@link SessionSummary} into the ACP
 * {@link SessionInfo} shape used by `session/list`.
 *
 * Field mapping (mirrors the Python reference at
 * `acp/server.py:303-322`):
 *  - `sessionId` ← `summary.id`.
 *  - `cwd`        ← `summary.workDir` (the SDK's name for the same
 *                    concept; ACP picked `cwd` and the rename happens
 *                    at every boundary in this adapter).
 *  - `title`      ← `summary.title` when present; otherwise omitted
 *                    (ACP's `title` is `string | null | undefined`).
 *                    Empty strings are normalized to `null` so the
 *                    client can detect "no title" via `=== null`
 *                    rather than chasing falsy semantics.
 *  - `updatedAt`  ← `new Date(summary.updatedAt).toISOString()`. The
 *                    SDK stores epoch ms (`number`); ACP wants ISO 8601.
 *                    Invalid timestamps fall back to `null` rather
 *                    than producing `Invalid Date` strings on the wire.
 */
function sessionSummaryToSessionInfo(summary: SessionSummary): SessionInfo {
  let updatedAt: string | null = null;
  if (typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)) {
    const date = new Date(summary.updatedAt);
    if (!Number.isNaN(date.getTime())) {
      updatedAt = date.toISOString();
    }
  }
  const titleRaw = summary.title;
  const title = typeof titleRaw === 'string' && titleRaw.length > 0 ? titleRaw : null;
  return {
    sessionId: summary.id,
    cwd: summary.workDir,
    title,
    updatedAt,
  };
}
