/**
 * RustRpcClient — the SDK's Rust engine-backed RPC client.
 *
 * Implements the same `SDKRpcClientBase` surface as the retired
 * KimiCore-backed `SDKRpcClient`, but every method talks to the Rust agent
 * engine (`@moonshot-ai/kimi-agent/rust-loop`) instead of an in-process JS
 * engine shell. The SDK `Session`/`KimiHarness` classes are unchanged —
 * they call the same CoreAPI RPC shape; only the wire beneath them differs.
 *
 * Wire translation: engine snake_case records → SDK camelCase shapes via
 * `./wire`; engine `host/event` → SDK `Event` passed through verbatim.
 * Engine sessions are process-wide with `session_id` routing, so one client
 * supports many sessions; host handlers are installed once on the engine
 * singleton.
 *
 * Capability policy: methods the engine RPC surface does not back yet fail
 * loud (`nativeUnavailable`) rather than fake a result, matching the
 * native-session convention.
 */
import type { SdkRpcSurface } from '../rpc';
import type { Event } from '../events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'pathe';

import { SDKRpcClientBase } from '#/rpc';
import { ErrorCodes, KimiError } from '#/legacy/errors';
import { GlobalMcpConfigStore } from '#/legacy/global-mcp-config';
import {
  beginGlobalMcpServerAuthHost,
  cancelGlobalMcpServerAuthHost,
  completeGlobalMcpServerAuthHost,
  resetGlobalMcpServerAuthHost,
  testGlobalMcpServerHost,
} from '#/legacy/mcp-host';
import { ensureConfigFile as legacyEnsureConfigFile, readConfigFile, writeConfigFile } from '#/legacy/config';
import type {
  KimiConfig,
  KimiHostIdentity,
  ListSessionsOptions,
  ResumedSessionSummary,
  SessionSummary,
  TelemetryClient,
} from '#/types';

import {
  mapContextMessage,
  mapMcpServer,
  mapSkill,
  mapUsage,
  nativeUnavailable,
  promptText,
} from './wire';
import type {
  EngineSessionRecord,
  EngineSessionStatus,
} from './wire';

/**
 * The rust-loop surface `RustRpcClient` needs (structural subset of
 * `@moonshot-ai/kimi-agent/rust-loop`), injected for testability.
 */
export interface RustLoopApi {
  isRustEngineAvailable(): boolean;
  installSessionHostHandlers(handlers: {
    onEvent?: (event: unknown) => void;
    authorizeTool?: (req: unknown) => Promise<unknown>;
    llmChat?: (req: unknown) => Promise<unknown>;
    toolExecute?: (req: unknown) => Promise<unknown>;
  }): boolean;
  sessionCreate(options: {
    sessionId?: string;
    homedir?: string;
    systemPrompt?: string;
    model?: string;
    goalEnabled?: boolean;
    nativeLlm?: unknown;
    tools?: { name: string; description: string; inputSchema?: unknown }[];
    mcpServers?: unknown[];
    skills?: unknown[];
    hooks?: unknown[];
    workspaceTrusted?: boolean;
    llmStep?: (req: unknown) => Promise<unknown>;
  }): Promise<{ session_id: string } | null>;
  sessionList(): Promise<{ sessions: EngineSessionRecord[] } | null>;
  sessionGetStatus(sessionId: string): Promise<EngineSessionStatus | null>;
  sessionPrompt(
    sessionId: string,
    input: { type: 'text'; text: string }[],
    agentId?: string,
  ): Promise<{ stop_reason: string; steps: number; usage: unknown } | null>;
  sessionCancel(sessionId: string): Promise<{ cancelled: boolean } | null>;
  sessionSetModel(sessionId: string, model: string): Promise<{ ok: boolean } | null>;
  sessionSetThinking(sessionId: string, effort: string | null): Promise<{ ok: boolean } | null>;
  sessionSteer(
    sessionId: string,
    input: { type: 'text'; text: string }[],
  ): Promise<{ ok: boolean } | null>;
  sessionSetPlanMode(sessionId: string, enabled: boolean): Promise<{ ok: boolean } | null>;
  sessionSetSwarmMode(
    sessionId: string,
    enabled: boolean,
    trigger: string,
  ): Promise<{ ok: boolean } | null>;
  sessionListSkills(sessionId: string): Promise<{ skills: unknown[] } | null>;
  sessionActivateSkill(sessionId: string, name: string, args?: string): Promise<unknown>;
  sessionListMcpServers(sessionId: string): Promise<{ servers: unknown[] } | null>;
  sessionGetMcpStartupMetrics(sessionId: string): Promise<unknown>;
  sessionReconnectMcpServer(sessionId: string, name: string): Promise<unknown>;
  sessionGetUsage(sessionId: string): Promise<unknown>;
  sessionGetWarnings(sessionId: string): Promise<{ warnings: unknown[] } | null>;
  sessionGetContext(sessionId: string): Promise<unknown>;
  sessionClearContext(sessionId: string): Promise<unknown>;
  sessionImportContext(sessionId: string, content: string, source: string): Promise<unknown>;
  sessionGoalCreate(sessionId: string, objective: string, replace: boolean): Promise<unknown>;
  sessionGoalGet(sessionId: string): Promise<unknown>;
  sessionGoalPause(sessionId: string): Promise<unknown>;
  sessionGoalResume(sessionId: string): Promise<unknown>;
  sessionGoalCancel(sessionId: string): Promise<unknown>;
  sessionGetPlan(sessionId: string): Promise<unknown>;
  sessionClearPlan(sessionId: string): Promise<unknown>;
  sessionCompact(sessionId: string, instruction?: string): Promise<unknown>;
  sessionUndoHistory(sessionId: string, count: number): Promise<unknown>;
  sessionAddAdditionalDir(
    sessionId: string,
    path: string,
  ): Promise<{ additional_dirs: string[] } | null>;
  sessionRemoveAdditionalDir(sessionId: string, path: string): Promise<unknown>;
  sessionUpdateMetadata(sessionId: string, patch: Record<string, unknown>): Promise<unknown>;
  sessionStartBtw(sessionId: string): Promise<{ btw_id: string } | null>;
  sessionEndBtw(sessionId: string): Promise<{ ended: boolean } | null>;
  sessionRunShell(
    sessionId: string,
    command: string,
    timeoutS?: number,
    commandId?: string,
  ): Promise<{ output: string | null; is_error: boolean; unavailable?: boolean } | null>;
  sessionCancelShellCommand(sessionId: string, commandId: string): Promise<unknown>;
  sessionSave(sessionId: string): Promise<{ ok: boolean } | null>;
  sessionLoad(sessionId: string): Promise<{ found: boolean } | null>;
  sessionDelete(sessionId: string): Promise<{ deleted: boolean } | null>;
  sessionFork(input: {
    sessionId: string;
    forkId: string;
    title?: string;
  }): Promise<{ forked: boolean } | null>;
  sessionDelete(sessionId: string): Promise<{ deleted: boolean } | null>;
  cronList(): Promise<{ tasks: unknown[] } | null>;
  bgList(): Promise<{ tasks: unknown[] } | null>;
  bgOutput(taskId: string): Promise<{ output: string } | null>;
  bgStop(taskId: string): Promise<unknown>;
  bgDetach(taskId: string): Promise<unknown>;
  pluginList(): Promise<{ plugins: unknown[] } | null>;
  pluginGet(id: string): Promise<unknown>;
  configGet(): Promise<unknown>;
  configSet(patch: unknown): Promise<unknown>;
}

export interface RustRpcClientOptions {
  /** Real: `@moonshot-ai/kimi-agent/rust-loop`. */
  readonly rustLoop: RustLoopApi;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity | undefined;
  readonly skillDirs?: readonly string[];
  readonly resolveOAuthTokenProvider?: unknown;
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: unknown;
  readonly uiMode?: string;
  /**
   * Host-proxy model step: answer one engine model request. When set, the
   * engine runs turns against this callback instead of a native-LLM provider
   * (the SDK's host-proxy path).
   */
  readonly llmStep?: (req: unknown) => Promise<unknown>;
}

/** A no-op telemetry client (default when the host supplies none). */
const noopTelemetryClient: TelemetryClient = {
  track: () => {},
  setContext: () => {},
};

/** Deep-merge a config patch onto a base (objects merge recursively; other
 *  values replace). `undefined`/null patch values keep the base. */
function deepMergeConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const existing = out[key];
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMergeConfig(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Map an engine session record onto the SDK `SessionSummary`. */
function mapSessionRecord(
  record: EngineSessionRecord,
  _homeDir: string,
): SessionSummary {
  const now = Date.now();
  return {
    id: record.id,
    title: record.title,
    workDir: record.work_dir ?? '',
    sessionDir: record.work_dir ?? '',
    createdAt: parseTime(record.created_at, now),
    updatedAt: parseTime(record.updated_at, now),
  };
}

function parseTime(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fallback : ms;
}

export class RustRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;

  private readonly rustLoop: RustLoopApi;
  private readonly llmStep: ((req: unknown) => Promise<unknown>) | undefined;
  /** SDK-owned sessionId → workDir map (the engine's work_dir is only
   *  populated when the host routes it through; the SDK is the authority). */
  private readonly workDirs = new Map<string, string>();
  /** Host mirror of sessions created by this client. The engine's store is
   *  process-global (shared across harnesses/tests), so listing must filter on
   *  what this client actually created rather than the whole store. */
  private readonly sessionSummaries = new Map<string, SessionSummary>();
  private readonly ready: Promise<SdkRpcSurface>;

  constructor(options: RustRpcClientOptions) {
    super();
    this.rustLoop = options.rustLoop;
    this.homeDir = options.homeDir ?? '';
    this.configPath = options.configPath ?? '';
    this.identity = options.identity;
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.llmStep = options.llmStep;
    this.rustLoop.installSessionHostHandlers({
      onEvent: (raw) => this.dispatchEngineEvent(raw),
      authorizeTool: (raw) => this.authorizeTool(raw),
      // Host-proxy model step: without it the engine cannot run a turn
      // unless a native-LLM provider is configured.
      llmChat: options.llmStep ?? (() => Promise.reject(new Error('no llmStep provided'))),
    });
    this.ready = Promise.resolve(this.buildRpc());
  }

  // ── Event + approval plumbing ──────────────────────────────────────────

  /** Pass an engine `host/event` through verbatim (protocol-toward-engine):
   *  the engine emits the SDK event shape (snake_case) already, so the host
   *  only stamps the `sessionId`/`agentId` routing fields. */
  private dispatchEngineEvent(raw: unknown): void {
    const event = (raw ?? {}) as { type?: string; session_id?: string | null };
    const sessionId = event.session_id ?? '';
    if (sessionId.length === 0) return;
    const { session_id: _drop, ...payload } = event;
    this.receiveEvent({ ...payload, sessionId, agentId: 'main' } as never);
  }

  private async authorizeTool(raw: unknown): Promise<{ block: boolean; resolved: boolean }> {
    const req = (raw ?? {}) as {
      session_id?: string | null;
      tool_name?: string;
      tool_call_id?: string;
      arguments?: unknown;
    };
    const sessionId = req.session_id ?? '';
    // The base class routes to the per-session handler set by
    // `Session.setApprovalHandler`; no handler → auto-allow (permission auto).
    const response = await this.requestApproval({
      sessionId,
      agentId: 'main',
      toolCallId: req.tool_call_id ?? '',
      toolName: req.tool_name ?? '',
      action: req.tool_name ?? '',
      display: { kind: 'generic', summary: req.tool_name ?? '', detail: req.arguments },
    });
    return { block: response.decision !== 'approved', resolved: true };
  }

  // ── CoreAPI implementation ─────────────────────────────────────────────

  private buildRpc(): SdkRpcSurface {
    const r = this.rustLoop;
    // Wide implementation type: the exact CoreAPI shape is enforced at the
    // return boundary (see the cast below); payload fields are structurally
    // matched per method.
    const impl: Record<string, unknown> = {
      // ── Session lifecycle ──────────────────────────────────────────────
      createSession: async ({ id, workDir, model, additionalDirs, permission }: any) => {
        // Model resolution is host-side: an explicit option wins, else the
        // host config's defaultModel (config is SDK-owned data).
        const effectiveModel = model ?? readConfigFile(this.configPath).defaultModel;
        const created = await r.sessionCreate({
          sessionId: id,
          homedir: this.homeDir,
          model: effectiveModel,
          llmStep: this.llmStep,
        });
        if (created === null) {
          throw new Error('Rust engine unavailable: cannot create session');
        }
        const sessionId = created.session_id;
        if (workDir !== undefined && workDir.length > 0) {
          this.workDirs.set(sessionId, workDir);
        }
        // Apply the effective permission mode: explicit option wins, else the
        // host config's default_permission_mode (the engine gate is
        // process-wide; the last-set mode is the session-visible one).
        const effectivePermission =
          permission ?? readConfigFile(this.configPath).defaultPermissionMode;
        if (effectivePermission !== undefined) {
          await (
            r as unknown as { permissionSetMode?(mode: string): Promise<unknown> }
          ).permissionSetMode?.(effectivePermission);
        }
        const now = Date.now();
        const summary: SessionSummary = {
          id: sessionId,
          workDir,
          sessionDir: workDir,
          createdAt: now,
          updatedAt: now,
          metadata: {},
          additionalDirs: additionalDirs ?? [],
        };
        this.sessionSummaries.set(sessionId, summary);
        return summary;
      },
      closeSession: async ({ sessionId }: any) => {
        await r.sessionSave(sessionId);
        this.clearSessionHandlers(sessionId);
      },
      listSessions: async ({ workDir, sessionId }: ListSessionsOptions) => {
        if (typeof workDir === 'string' && workDir.trim() === '') {
          throw new KimiError(
            ErrorCodes.REQUEST_WORK_DIR_REQUIRED,
            'listSessions requires workDir',
          );
        }
        // Host mirror: list what this client created, so a harness only sees
        // its own sessions even though the engine store is process-global.
        const summaries = Array.from(this.sessionSummaries.values());
        return summaries.filter(
          (summary) =>
            (workDir === undefined || summary.workDir === workDir) &&
            (sessionId === undefined || summary.id === sessionId),
        );
      },
      resumeSession: async ({ sessionId }: any) => {
        await r.sessionLoad(sessionId);
        const status = await r.sessionGetStatus(sessionId);
        const summary = await this.sessionSummaryFor(sessionId);
        return this.resumedSummary(summary, status);
      },
      reloadSession: async ({ sessionId }: any) => {
        const found = await r.sessionLoad(sessionId);
        if (!found) throw new Error('Session not found for reload');
        const status = await r.sessionGetStatus(sessionId);
        const summary = await this.sessionSummaryFor(sessionId);
        return this.resumedSummary(summary, status);
      },
      forkSession: async ({ sessionId, id, title, workDir }: any) => {
        let result: { forked: boolean } | null;
        try {
          result = await r.sessionFork({ sessionId, forkId: id ?? `${sessionId}_fork`, title });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('active turn')) {
            throw new KimiError(
              ErrorCodes.SESSION_FORK_ACTIVE_TURN,
              'Cannot fork a session with an active turn',
            );
          }
          throw error;
        }
        if (!result || !result.forked) {
          throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`);
        }
        const forkId = id ?? `${sessionId}_fork`;
        const now = Date.now();
        const summary: SessionSummary = {
          id: forkId,
          workDir: workDir ?? this.workDirs.get(sessionId) ?? '',
          sessionDir: workDir ?? this.workDirs.get(sessionId) ?? '',
          title,
          createdAt: now,
          updatedAt: now,
          metadata: {},
        };
        if (summary.workDir.length > 0) this.workDirs.set(forkId, summary.workDir);
        return summary;
      },
      archiveSession: async () => nativeUnavailable('archiveSession'),
      deleteSession: async ({ sessionId }: any) => {
        const result = await r.sessionDelete(sessionId);
        if (!result || !result.deleted) {
          throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`);
        }
        this.workDirs.delete(sessionId);
        this.sessionSummaries.delete(sessionId);
        this.clearSessionHandlers(sessionId);
      },
      exportSession: async () => nativeUnavailable('exportSession'),

      // ── Turn control ───────────────────────────────────────────────────
      prompt: async ({ sessionId, input }: any) => {
        await r.sessionPrompt(sessionId, [{ type: 'text', text: promptText(input) }]);
      },
      steer: async ({ sessionId, input }: any) => {
        await r.sessionSteer(sessionId, [{ type: 'text', text: promptText(input) }]);
      },
      cancel: async ({ sessionId }: any) => {
        await r.sessionCancel(sessionId);
      },
      generateAgentsMd: async ({ sessionId }: any) => {
        await r.sessionActivateSkill(sessionId, 'init');
      },
      setModel: async ({ sessionId, model }: any) => {
        await r.sessionSetModel(sessionId, model);
      },
      setThinking: async ({ sessionId, effort }: any) => {
        await r.sessionSetThinking(sessionId, effort ?? null);
      },
      setPermission: async ({ sessionId, mode }: any) => {
        // The engine gate mode is process-wide; a per-session value is
        // approximated by the last-set mode (documented limitation).
        await (r as unknown as { permissionSetMode?(mode: string): Promise<unknown> })
          .permissionSetMode?.(mode);
      },
      enterPlan: async ({ sessionId }: any) => {
        await r.sessionSetPlanMode(sessionId, true);
      },
      cancelPlan: async ({ sessionId }: any) => {
        await r.sessionSetPlanMode(sessionId, false);
      },
      clearPlan: async ({ sessionId }: any) => {
        await r.sessionClearPlan(sessionId);
      },
      enterSwarm: async ({ sessionId, trigger }: any) => {
        await r.sessionSetSwarmMode(sessionId, true, trigger);
      },
      exitSwarm: async ({ sessionId }: any) => {
        await r.sessionSetSwarmMode(sessionId, false, 'exit');
      },
      getSwarmMode: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        return status?.swarm_mode ?? false;
      },
      beginCompaction: async ({ sessionId }: any) => {
        await r.sessionCompact(sessionId);
      },
      cancelCompaction: async () => nativeUnavailable('cancelCompaction'),
      registerTool: async () => {},
      unregisterTool: async () => {},
      setActiveTools: async () => {},
      getTools: async () => [] as never,
      addAdditionalDir: async ({ sessionId, path, persist }: any) => {
        // NOTE: the engine `session/add_additional_dir` RPC has no `persist`
        // parameter today — the SDK flag is accepted for contract parity but
        // silently dropped by the wire (persisted vs ephemeral dirs is an
        // engine-side gap; see RUST_MIGRATION_PLAN TODO).
        const result = await r.sessionAddAdditionalDir(sessionId, path);
        return { additionalDirs: result?.additional_dirs ?? [] };
      },
      updateSessionMetadata: async ({ sessionId, patch }: any) => {
        await r.sessionUpdateMetadata(sessionId, patch);
      },
      renameSession: async ({ sessionId, title }: any) => {
        // Missing sessions are unknown to the engine agent map ("no agent for
        // session"); surface the SDK's session.not_found contract instead.
        if (!this.sessionSummaries.has(sessionId)) {
          throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`, {
            details: { sessionId },
          });
        }
        await r.sessionUpdateMetadata(sessionId, { title });
        const summary = this.sessionSummaries.get(sessionId);
        if (summary !== undefined) {
          this.sessionSummaries.set(sessionId, { ...summary, title });
          await this.patchSessionStateFile(summary.sessionDir, {
            title,
            isCustomTitle: true,
          }).catch(() => {});
        }
      },
      runShellCommand: async ({ sessionId, command, commandId }: any) => {
        const result = await r.sessionRunShell(sessionId, command, undefined, commandId);
        if (result?.unavailable) return { stdout: '', stderr: '', isError: true };
        return {
          stdout: result?.output ?? '',
          stderr: '',
          isError: result?.is_error,
        };
      },
      cancelShellCommand: async ({ sessionId, commandId }: any) => {
        await r.sessionCancelShellCommand(sessionId, commandId);
      },
      startBtw: async ({ sessionId }: any) => {
        const result = await r.sessionStartBtw(sessionId);
        return result?.btw_id ?? '';
      },

      // ── State reads ────────────────────────────────────────────────────
      getConfig: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        if (status === null) throw new Error('Session not found');
        return {
          modelAlias: status.model ?? undefined,
          provider: status.model != null ? { model: status.model } : undefined,
          thinkingEffort: status.thinking_effort,
          modelCapabilities: {
            max_context_tokens: status.max_context_tokens,
            max_input_tokens: status.max_context_tokens,
          },
          planMode: status.plan_mode,
          swarmMode: status.swarm_mode,
        } as never;
      },
      getPermission: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        return { mode: status?.permission ?? 'manual' } as never;
      },
      getModel: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        return status?.model ?? '';
      },
      getSessionMetadata: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        return {
          createdAt: '0',
          updatedAt: '0',
          title: sessionId,
          isCustomTitle: false,
          custom: {},
          agents: {},
          ...(status?.model !== undefined ? { model: status.model } : {}),
        } as never;
      },
      getUsage: async ({ sessionId }: any) => {
        return mapUsage(await r.sessionGetUsage(sessionId)) as never;
      },
      getSessionWarnings: async ({ sessionId }: any) => {
        const result = await r.sessionGetWarnings(sessionId);
        return (result?.warnings ?? []) as never;
      },
      listSkills: async ({ sessionId }: any) => {
        const result = await r.sessionListSkills(sessionId);
        return (result?.skills ?? []).map((s) => mapSkill(s as never));
      },
      activateSkill: async ({ sessionId, name, args }: any) => {
        await r.sessionActivateSkill(sessionId, name, args);
      },
      listMcpServers: async ({ sessionId }: any) => {
        const result = await r.sessionListMcpServers(sessionId);
        return (result?.servers ?? []).map((s) => mapMcpServer(s as never));
      },
      getMcpStartupMetrics: async ({ sessionId }: any) => {
        return (await r.sessionGetMcpStartupMetrics(sessionId)) as never;
      },
      reconnectMcpServer: async ({ sessionId, name }: any) => {
        await r.sessionReconnectMcpServer(sessionId, name);
      },
      getContext: async ({ sessionId }: any) => {
        const raw = await r.sessionGetContext(sessionId);
        return this.mapContext(raw) as never;
      },
      clearContext: async ({ sessionId }: any) => {
        await r.sessionClearContext(sessionId);
      },
      importContext: async ({ sessionId, content, source }: any) => {
        await r.sessionImportContext(sessionId, content, source);
      },
      undoHistory: async ({ sessionId, count }: any) => {
        await r.sessionUndoHistory(sessionId, count ?? 1);
      },
      getPlan: async ({ sessionId }: any) => {
        return (await r.sessionGetPlan(sessionId)) as never;
      },
      createGoal: async ({ sessionId, objective, replace }: any) => {
        return (await r.sessionGoalCreate(sessionId, objective, replace ?? false)) as never;
      },
      getGoal: async ({ sessionId }: any) => {
        return (await r.sessionGoalGet(sessionId)) as never;
      },
      pauseGoal: async ({ sessionId }: any) => {
        return (await r.sessionGoalPause(sessionId)) as never;
      },
      resumeGoal: async ({ sessionId }: any) => {
        return (await r.sessionGoalResume(sessionId)) as never;
      },
      cancelGoal: async ({ sessionId }: any) => {
        return (await r.sessionGoalCancel(sessionId)) as never;
      },
      getCronTasks: async () => {
        const result = await r.cronList();
        return { tasks: result?.tasks ?? [] } as never;
      },
      getBackground: async () => {
        const result = await r.bgList();
        return (result?.tasks ?? []) as never;
      },
      getBackgroundOutput: async ({ taskId }: any) => {
        const result = await r.bgOutput(taskId);
        return (result?.output ?? '') as never;
      },
      stopBackground: async ({ taskId }: any) => {
        // Stopping an unknown task is a no-op (v1 semantics), not an error.
        try {
          await r.bgStop(taskId);
        } catch (error) {
          if (isTaskNotFound(error)) return;
          throw error;
        }
      },
      detachBackground: async ({ taskId }: any) => {
        await r.bgDetach(taskId);
      },
      waitForBackgroundTasksOnPrint: async () => {},
      handlePrintMainTurnCompleted: async () => 'finish' as const,

      // ── Harness-level config / plugins ─────────────────────────────────
      getCoreInfo: async () => {
        return { version: this.identity?.version ?? '' } as never;
      },
      getExperimentalFeatures: async () => [] as never,
      getKimiConfig: async () => {
        // Config is host data: read the SDK-owned config.toml locally (the
        // engine's config/get serves the engine's own resolved view).
        return readConfigFile(this.configPath);
      },
      setKimiConfig: async (patch: any) => {
        // Deep-merge the patch onto the on-disk config and persist it
        // locally (v1 config semantics live host-side, not in the engine).
        const base = readConfigFile(this.configPath);
        const merged = deepMergeConfig(base, patch ?? {});
        // The legacy writer's config type is its own schema; the SDK config
        // shape is structurally compatible (both camelCase KimiConfig).
        await writeConfigFile(
          this.configPath,
          merged as unknown as Parameters<typeof writeConfigFile>[1],
        );
        return merged as KimiConfig;
      },
      removeKimiProvider: async () => nativeUnavailable('removeKimiProvider'),
      getConfigDiagnostics: async () => ({ warnings: [] }) as never,
      listGlobalMcpServers: async () => new GlobalMcpConfigStore(this.homeDir).list(),
      addGlobalMcpServer: async ({ server }: any) =>
        new GlobalMcpConfigStore(this.homeDir).add(server),
      updateGlobalMcpServer: async ({ server }: any) =>
        new GlobalMcpConfigStore(this.homeDir).update(server),
      removeGlobalMcpServer: async ({ name }: any) =>
        new GlobalMcpConfigStore(this.homeDir).remove(name),
      beginGlobalMcpServerAuth: async ({ name }: any) => {
        const server = await new GlobalMcpConfigStore(this.homeDir).get(name);
        return beginGlobalMcpServerAuthHost(server);
      },
      completeGlobalMcpServerAuth: async ({ flowId }: any) => {
        completeGlobalMcpServerAuthHost(flowId);
      },
      cancelGlobalMcpServerAuth: async ({ flowId }: any) => {
        cancelGlobalMcpServerAuthHost(flowId);
      },
      resetGlobalMcpServerAuth: async ({ name }: any) => {
        const server = await new GlobalMcpConfigStore(this.homeDir).get(name);
        resetGlobalMcpServerAuthHost(server);
      },
      testGlobalMcpServer: async ({ name }: any) => {
        const server = await new GlobalMcpConfigStore(this.homeDir).get(name);
        return testGlobalMcpServerHost(server);
      },
      listWorkspaceSkills: async () => [],
      listPlugins: async () => {
        const result = await r.pluginList();
        return (result?.plugins ?? []) as never;
      },
      getPluginInfo: async ({ id }: any) => {
        return (await r.pluginGet(id)) as never;
      },
      installPlugin: async () => nativeUnavailable('installPlugin'),
      setPluginEnabled: async () => nativeUnavailable('setPluginEnabled'),
      setPluginMcpServerEnabled: async () => nativeUnavailable('setPluginMcpServerEnabled'),
      removePlugin: async () => nativeUnavailable('removePlugin'),
      reloadPlugins: async () => nativeUnavailable('reloadPlugins'),
      listPluginCommands: async () => [],
      activatePluginCommand: async () => nativeUnavailable('activatePluginCommand'),
    };
    return impl as unknown as SdkRpcSurface;
  }

  private async patchSessionStateFile(
    sessionDir: string | undefined,
    patch: Record<string, unknown>,
  ): Promise<void> {
    if (sessionDir === undefined || sessionDir.length === 0) return;
    const statePath = join(sessionDir, 'state.json');
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // No host-side state.json (Rust engine persists sessions in its own
      // store); nothing to sync.
      return;
    }
    await writeFile(statePath, `${JSON.stringify({ ...state, ...patch }, null, 2)}\n`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async sessionSummaryFor(sessionId: string): Promise<SessionSummary> {
    const records = (await this.rustLoop.sessionList())?.sessions ?? [];
    const record = records.find((r) => r.id === sessionId);
    const summary = mapSessionRecord(
      record ?? { id: sessionId, created_at: '', updated_at: '' },
      this.homeDir,
    );
    const sdkWorkDir = this.workDirs.get(sessionId);
    if (sdkWorkDir !== undefined) {
      return { ...summary, workDir: sdkWorkDir, sessionDir: sdkWorkDir };
    }
    return summary;
  }

  private resumedSummary(
    summary: SessionSummary,
    _status: EngineSessionStatus | null,
  ): ResumedSessionSummary {
    const now = Date.now();
    return {
      ...summary,
      sessionMetadata: {
        createdAt: String(summary.createdAt),
        updatedAt: String(summary.updatedAt),
        title: summary.title ?? summary.id,
        isCustomTitle: false,
        ...(summary.workDir !== undefined ? { workDir: summary.workDir } : {}),
        custom: {},
        agents: {},
      },
      agents: {},
      warning: undefined,
      createdAt: summary.createdAt,
      updatedAt: now,
    };
  }

  private mapContext(raw: unknown): unknown {
    if (raw === null || typeof raw !== 'object') return { history: [], tokenCount: 0 };
    const obj = raw as Record<string, unknown>;
    const history = Array.isArray(obj['history'])
      ? (obj['history'] as Record<string, unknown>[]).map(mapContextMessage)
      : [];
    return {
      history,
      tokenCount: typeof obj['token_count'] === 'number' ? obj['token_count'] : 0,
      ...(obj['projectRoot'] !== undefined ? { projectRoot: obj['projectRoot'] } : {}),
      ...(obj['cwd'] !== undefined ? { cwd: obj['cwd'] } : {}),
      ...(obj['additionalDirs'] !== undefined ? { additionalDirs: obj['additionalDirs'] } : {}),
    };
  }

  async ensureConfigFile(): Promise<void> {
    // Config is host data: materialize the default scaffold under the SDK's
    // config path (the engine does not own the host config file).
    await legacyEnsureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    // The engine process is host-owned; nothing to release client-side.
  }

  protected async getRpc(): Promise<SdkRpcSurface> {
    return this.ready;
  }
}

function isTaskNotFound(error: unknown): boolean {
  return /task .* not found/i.test(error instanceof Error ? error.message : String(error));
}

/** Default agent id stamped onto engine events (side-agent turns override it). */
const MAIN_AGENT_ID = 'main';
