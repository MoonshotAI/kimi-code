import type { Kaos } from '@moonshot-ai/kaos';

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'pathe';

import {
  getRootLogger,
  log,
  resolveLoggingConfig,
  type Logger,
  type SessionLogHandle,
} from '@moonshot-ai/kimi-agent/runtime';

import { ErrorCodes, KimiError } from '#/legacy/errors';
import { GlobalMcpConfigStore } from '#/legacy/global-mcp-config';
import { exportSessionDirectory } from '#/legacy/session-export/index';
import type { TelemetryClient, TelemetryContextPatch, TelemetryProperties } from '#/types';

import { Session } from '#/session';
import type { KimiAuthFacade } from '#/auth';
import type { SDKRpcClientBase } from '#/rpc';
import type {
  AuthenticateMcpServerOptions,
  ConfigDiagnostics,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  ForkSessionInput,
  GetConfigOptions,
  KimiConfig,
  KimiConfigPatch,
  KimiHostIdentity,
  ListSessionsOptions,
  McpServerConfig,
  McpTestResult,
  RenameSessionInput,
  ResumeSessionInput,
  ReloadSessionInput,
  SessionSummary,
  SkillSummary,
  TestMcpServerOptions,
} from '#/types';

/**
 * Owner-scoped [image] limits for prompt-ingestion compression. The retired
 * agent-core class is gone; hosts pass an opaque limits object (or none).
 */
export interface ImageLimits {
  readonly maxEdgePx?: number | undefined;
  readonly readByteBudget?: number | undefined;
  readonly [key: string]: unknown;
}

// Re-export the flag types (local mirror) so harness consumers get the same
// shape the retired agent-core exported.
export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '#/legacy/flags';
import type { ExperimentalFeatureState } from '#/legacy/flags';

/** Bind a context patch onto every track/setContext call of a telemetry
 *  client (local port of the retired agent-core helper). */
export function withTelemetryContext(
  telemetry: TelemetryClient,
  ctx: TelemetryContextPatch,
): TelemetryClient {
  return telemetry.withContext?.(ctx) ?? telemetry;
}

export interface KimiHarnessRuntimeOptions {
  readonly identity?: KimiHostIdentity;
  readonly uiMode?: string;
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: KimiAuthFacade;
  readonly telemetry: TelemetryClient;
  readonly ensureConfigFile: () => Promise<void>;
  readonly onClose: () => void | Promise<void>;
  readonly sessionStartedProperties?: TelemetryProperties;
  /**
   * Owner-scoped [image] limits for prompt-ingestion compression in the
   * client process (paste-time, ACP prompt conversion). In-process cores
   * (SDKRpcClient) hand over their core's instance; daemon-client hosts
   * leave it undefined and ingestion falls back to env/built-in defaults.
   */
  readonly imageLimits?: ImageLimits | undefined;
}

export class KimiHarness {
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: KimiAuthFacade;

  private readonly identity: KimiHostIdentity | undefined;
  private readonly uiMode: string;
  private readonly telemetry: TelemetryClient;
  private readonly activeSessions = new Map<string, Session>();
  private readonly sessionLogHandles = new Map<string, SessionLogHandle>();
  private readonly ensureConfigFileImpl: () => Promise<void>;
  private readonly closeImpl: () => void | Promise<void>;
  private readonly sessionStartedProperties: TelemetryProperties;

  /**
   * Ingestion-side [image] limits owned by this harness's core; undefined for
   * daemon-client hosts, where the env var / built-in defaults apply.
   */
  readonly imageLimits: ImageLimits | undefined;

  constructor(
    private readonly rpc: SDKRpcClientBase,
    options: KimiHarnessRuntimeOptions,
  ) {
    this.identity = options.identity;
    this.uiMode = options.uiMode ?? DEFAULT_SESSION_STARTED_UI_MODE;
    this.homeDir = options.homeDir;
    this.configPath = options.configPath;
    this.telemetry = options.telemetry;
    this.auth = options.auth;
    this.ensureConfigFileImpl = options.ensureConfigFile;
    this.closeImpl = options.onClose;
    this.sessionStartedProperties = options.sessionStartedProperties ?? {};
    this.imageLimits = options.imageLimits;
    // Configure the process-wide diagnostic root logger for this harness's
    // home dir (global log at `<homeDir>/logs/kimi-code.log`). The root logger
    // is a singleton shared by all harnesses; the latest construction wins, so
    // untagged diagnostics land in the most recently created harness's home.
    getRootLogger()
      .configure(resolveLoggingConfig({ homeDir: options.homeDir }))
      .catch(() => {});
  }

  get sessions(): ReadonlyMap<string, Session> {
    return this.activeSessions;
  }

  get interactiveAgentId(): string {
    return this.rpc.interactiveAgentId;
  }

  withInteractiveAgent<T>(agentId: string, fn: () => T): T {
    return this.rpc.withInteractiveAgent(agentId, fn);
  }

  track(event: string, properties?: TelemetryProperties): void {
    this.telemetry.track(event, properties);
  }

  setTelemetryContext(patch: TelemetryContextPatch): void {
    this.telemetry.setContext?.(patch);
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    const { planMode, kaos, persistenceKaos, sessionStartedProperties, ...coreOptions } = options;
    const summary =
      kaos === undefined && persistenceKaos === undefined
        ? await this.rpc.createSession(coreOptions)
        : await this.rpc.createSessionWithKaos(coreOptions, kaos ?? persistenceKaos as Kaos, persistenceKaos);
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
        this.detachSessionLog(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    this.attachSessionLog(summary);
    if (planMode === true) {
      await session.setPlanMode(true);
    }
    this.trackSessionStarted(summary.id, false, sessionStartedProperties);
    this.trackSessionEvent(session.id, 'session_new');
    return session;
  }

  async resumeSession(input: ResumeSessionInput): Promise<Session> {
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    const { kaos, persistenceKaos, sessionStartedProperties, ...resumeInput } = input;
    if (active !== undefined) {
      if (kaos !== undefined || persistenceKaos !== undefined) {
        await this.rpc.resumeSessionWithKaos({ ...resumeInput, id }, kaos ?? persistenceKaos as Kaos, persistenceKaos);
      }
      return active;
    }

    const summary =
      kaos === undefined && persistenceKaos === undefined
        ? await this.rpc.resumeSession({ ...resumeInput, id })
        : await this.rpc.resumeSessionWithKaos({ ...resumeInput, id }, kaos ?? persistenceKaos as Kaos, persistenceKaos);
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
        this.detachSessionLog(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    this.attachSessionLog(summary);
    this.trackSessionStarted(summary.id, true, sessionStartedProperties);
    this.trackSessionEvent(session.id, 'session_resume');
    return session;
  }

  async reloadSession(input: ReloadSessionInput): Promise<Session> {
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    if (active !== undefined) {
      await active.reloadSession({
        forcePluginSessionStartReminder: input.forcePluginSessionStartReminder,
      });
      this.trackSessionEvent(active.id, 'session_reload');
      return active;
    }

    const summary = await this.rpc.reloadSession({
      sessionId: id,
      forcePluginSessionStartReminder: input.forcePluginSessionStartReminder,
    });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
        this.detachSessionLog(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    this.attachSessionLog(summary);
    this.trackSessionStarted(summary.id, true);
    this.trackSessionEvent(session.id, 'session_reload');
    return session;
  }

  async forkSession(input: ForkSessionInput): Promise<Session> {
    const summary = await this.rpc.forkSession({
      id: normalizeSessionId(input.id),
      forkId: input.forkId,
      title: input.title,
      metadata: input.metadata,
      turnIndex: input.turnIndex,
    });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
        this.detachSessionLog(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    this.attachSessionLog(summary);
    this.trackSessionStarted(summary.id, true);
    this.trackSessionEvent(session.id, 'session_fork');
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.activeSessions.get(id);
  }

  async closeSession(id: string): Promise<void> {
    await this.activeSessions.get(id)?.close();
  }

  async deleteSession(id: string): Promise<void> {
    const sessionId = normalizeSessionId(id);
    await this.activeSessions.get(sessionId)?.close();
    await this.rpc.deleteSession({ sessionId });
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    await this.rpc.renameSession(input);
    this.activeSessions.get(input.id)?.emitMetaUpdated({ title: input.title });
  }

  async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    // Host-side export: the engine persists sessions in its own store, so the
    // host assembles the debug zip from the session directory plus the
    // engine's wire records (fetched via the engine `session/export` RPC).
    const summary = (await this.rpc.listSessions({ sessionId: input.id })).find(
      (item) => item.id === input.id,
    );
    if (summary === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${input.id}`, {
        details: { sessionId: input.id },
      });
    }
    // Session-scoped logger so flush-failure warnings route to the session log.
    const exportLog = log.createChild({ sessionId: input.id });
    await warnIfLogFlushFails(exportLog, 'export session log flush failed', () =>
      getRootLogger().flushSession(input.id),
    );
    if (input.includeGlobalLog === true) {
      await warnIfLogFlushFails(exportLog, 'export global log flush failed', () =>
        getRootLogger().flushGlobal(),
      );
    }
    // Materialize the engine's wire records into the host session directory
    // (SDK layout `agents/main/wire.jsonl`), so the archive keeps the shape
    // the old host session tree produced. A failed engine fetch degrades to an
    // empty wire log rather than failing the whole export.
    let wireRecords: readonly unknown[] = [];
    try {
      const engineData = (await this.rpc.exportSession({
        id: input.id,
        version: input.version ?? this.identity?.version ?? '',
      })) as unknown as {
        wireRecords?: readonly unknown[];
      };
      wireRecords = engineData?.wireRecords ?? [];
    } catch {
      // Engine wire unavailable — export proceeds with an empty wire log.
    }
    if (summary.sessionDir !== undefined && summary.sessionDir.length > 0) {
      await writeExportWireFile(summary.sessionDir, wireRecords);
    }
    const result = await exportSessionDirectory({
      request: {
        sessionId: input.id,
        outputPath: input.outputPath,
        version: input.version ?? this.identity?.version ?? '',
        includeGlobalLog: input.includeGlobalLog,
        installSource: input.installSource,
        shellEnv: input.shellEnv,
      },
      summary,
      homeDir: this.homeDir,
      // Bundle the active root global log path (the most recently constructed
      // harness's home), not this harness's own home.
      globalLogPath: getRootLogger().getConfig()?.globalLogPath,
    });
    this.trackSessionEvent(input.id, 'export');
    return result;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    return this.rpc.listSessions(options);
  }

  /** Skills visible to a new session in `workDir`, without creating that session. */
  async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    return this.rpc.listWorkspaceSkills(workDir);
  }

  async getConfig(options: GetConfigOptions = {}): Promise<KimiConfig> {
    return this.rpc.getConfig(options);
  }

  /** Warnings from the most recent config.toml load; empty when the config is fully valid. */
  async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    return this.rpc.getConfigDiagnostics();
  }

  async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return this.rpc.getExperimentalFeatures();
  }

  async ensureConfigFile(): Promise<void> {
    await this.ensureConfigFileImpl();
  }

  async setConfig(patch: KimiConfigPatch): Promise<KimiConfig> {
    return this.rpc.setConfig(patch);
  }

  async removeProvider(providerId: string): Promise<KimiConfig> {
    return this.rpc.removeProvider(providerId);
  }

  /** User-global MCP entries from `<KIMI_CODE_HOME>/mcp.json` only. */
  async listMcpServers(): Promise<readonly McpServerConfig[]> {
    return new GlobalMcpConfigStore(this.homeDir).list();
  }

  async addMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    return new GlobalMcpConfigStore(this.homeDir).add(server);
  }

  async updateMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    return new GlobalMcpConfigStore(this.homeDir).update(server);
  }

  async removeMcpServer(name: string): Promise<readonly McpServerConfig[]> {
    return new GlobalMcpConfigStore(this.homeDir).remove(name);
  }

  async authenticateMcpServer(
    name: string,
    options: AuthenticateMcpServerOptions,
  ): Promise<void> {
    const started = await this.rpc.beginGlobalMcpServerAuth(name);
    if (started.status === 'already-authorized') return;
    try {
      const opened = await options.onAuthorizationUrl(started.authorizationUrl);
      if (opened === false) {
        throw new KimiError(ErrorCodes.REQUEST_INVALID, 'MCP OAuth authorization was cancelled');
      }
      await this.rpc.completeGlobalMcpServerAuth(
        { flowId: started.flowId, timeoutMs: options.timeoutMs },
        options.signal,
      );
    } catch (error) {
      await this.rpc.cancelGlobalMcpServerAuth(started.flowId).catch(() => {});
      throw error;
    }
  }

  async resetMcpServerAuth(name: string): Promise<void> {
    return this.rpc.resetGlobalMcpServerAuth(name);
  }

  async testMcpServer(
    name: string,
    options: TestMcpServerOptions = {},
  ): Promise<McpTestResult> {
    return this.rpc.testGlobalMcpServer(name, options);
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.activeSessions.values(), (session) => session.close()));
    // Defensive sweep for session logs whose session was never closed through
    // the Session surface (sessions already detach via their onClose).
    for (const sessionId of Array.from(this.sessionLogHandles.keys())) {
      this.detachSessionLog(sessionId);
    }
    // Flush the process-wide diagnostic logs (global + open sessions) so the
    // last entries survive close.
    await getRootLogger().flush();
    await this.closeImpl();
  }

  private attachSessionLog(summary: SessionSummary): void {
    const sessionDir = summary.sessionDir ?? summary.workDir;
    if (sessionDir === undefined || sessionDir.length === 0) return;
    const handle = getRootLogger().attachSession({
      sessionId: summary.id,
      sessionDir,
    });
    this.sessionLogHandles.set(summary.id, handle);
  }

  private detachSessionLog(sessionId: string): void {
    const handle = this.sessionLogHandles.get(sessionId);
    if (handle === undefined) return;
    this.sessionLogHandles.delete(sessionId);
    void handle.close().catch(() => {});
  }

  private trackSessionEvent(eventSessionId: string, event: string): void {
    withTelemetryContext(this.telemetry, { sessionId: eventSessionId }).track(event);
  }

  private trackSessionStarted(
    eventSessionId: string,
    resumed: boolean,
    sessionScoped?: TelemetryProperties,
  ): void {
    withTelemetryContext(this.telemetry, { sessionId: eventSessionId }).track('session_started', {
      ...this.sessionStartedProperties,
      ...sessionScoped,
      // Canonical fields are owned by the harness and must win over any
      // caller-supplied sessionStartedProperties that happen to share a key.
      // `client_id` is always null here: a single-process host has no
      // per-connection client id (that concept only exists for daemon clients,
      // see core-impl.ts). Kept as an explicit key so both producers share the
      // same session_started schema.
      client_id: null,
      client_name: this.identity?.userAgentProduct ?? null,
      client_version: this.identity?.version ?? null,
      ui_mode: this.uiMode,
      resumed,
    });
  }
}

const DEFAULT_SESSION_STARTED_UI_MODE = 'shell';

function normalizeSessionId(value: string): string {
  if (typeof value !== 'string') {
    throw new KimiError(ErrorCodes.SESSION_ID_REQUIRED, 'Session id is required.');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new KimiError(ErrorCodes.SESSION_ID_EMPTY, 'Session id cannot be empty.');
  }
  return normalized;
}

/** Flush a diagnostic log sink, logging a warning into `exportLog` (the
 *  session-scoped logger, so the warning lands in the session log) when the
 *  flush fails, then retry once — a failed flush still leaves the archive
 *  assembled with whatever reached disk. */
async function warnIfLogFlushFails(
  exportLog: Logger,
  message: string,
  flush: () => Promise<boolean>,
): Promise<void> {
  try {
    if (await flush()) return;
    exportLog.warn(message);
  } catch (error) {
    exportLog.warn(message, { error });
  }
  try {
    await flush();
  } catch {
    // Second attempt is best-effort — the archive is still assembled.
  }
}

/** Write the engine's wire records into `<sessionDir>/agents/main/wire.jsonl`
 *  (one JSON record per line) so the export archive keeps the SDK layout. */
async function writeExportWireFile(
  sessionDir: string,
  records: readonly unknown[],
): Promise<void> {
  const wireDir = join(sessionDir, 'agents', 'main');
  await mkdir(wireDir, { recursive: true });
  const lines = records.map((record) => JSON.stringify(record));
  const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  await writeFile(join(wireDir, 'wire.jsonl'), content, 'utf-8');
}
