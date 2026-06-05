import type { Kaos } from '@moonshot-ai/kaos';
import {
  ErrorCodes,
  KimiError,
  withTelemetryContext,
  type ExperimentalFeatureState,
} from '@moonshot-ai/agent-core';

import { Session } from '#/session';
import type { KimiAuthFacade } from '#/auth';
import type { SDKRpcClientBase } from '#/rpc';
import type {
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  ForkSessionInput,
  GetConfigOptions,
  KimiConfig,
  KimiConfigPatch,
  KimiHostIdentity,
  ListSessionsOptions,
  RenameSessionInput,
  ResumeSessionInput,
  SessionSummary,
  TelemetryClient,
  TelemetryContextPatch,
  TelemetryProperties,
} from '#/types';

export interface KimiHarnessRuntimeOptions {
  readonly identity?: KimiHostIdentity;
  readonly uiMode?: string;
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: KimiAuthFacade;
  readonly telemetry: TelemetryClient;
  readonly ensureConfigFile: () => Promise<void>;
  readonly onClose: () => void | Promise<void>;
}

export class KimiHarness {
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: KimiAuthFacade;

  private readonly identity: KimiHostIdentity | undefined;
  private readonly uiMode: string;
  private readonly telemetry: TelemetryClient;
  private readonly activeSessions = new Map<string, Session>();
  private readonly ensureConfigFileImpl: () => Promise<void>;
  private readonly closeImpl: () => void | Promise<void>;

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
  }

  get sessions(): ReadonlyMap<string, Session> {
    return this.activeSessions;
  }

  get interactiveAgentId(): string {
    return this.rpc.interactiveAgentId;
  }

  set interactiveAgentId(agentId: string) {
    this.rpc.interactiveAgentId = agentId;
  }

  track(event: string, properties?: TelemetryProperties): void {
    this.telemetry.track(event, properties);
  }

  setTelemetryContext(patch: TelemetryContextPatch): void {
    this.telemetry.setContext?.(patch);
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    const { planMode, kaos, persistenceKaos, ...coreOptions } = options;
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
      },
    });
    this.activeSessions.set(session.id, session);
    if (planMode === true) {
      await session.setPlanMode(true);
    }
    this.trackSessionStarted(summary.id, false);
    this.trackSessionEvent(session.id, 'session_new');
    return session;
  }

  async resumeSession(input: ResumeSessionInput): Promise<Session> {
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    const { kaos, persistenceKaos, ...resumeInput } = input;
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
      },
    });
    this.activeSessions.set(session.id, session);
    this.trackSessionStarted(summary.id, true);
    this.trackSessionEvent(session.id, 'session_resume');
    return session;
  }

  async reloadSession(input: ResumeSessionInput): Promise<Session> {
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    if (active !== undefined) {
      await active.reloadSession();
      this.trackSessionEvent(active.id, 'session_reload');
      return active;
    }

    const summary = await this.rpc.reloadSession({ sessionId: id });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
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
    });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
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

  async renameSession(input: RenameSessionInput): Promise<void> {
    await this.rpc.renameSession(input);
    this.activeSessions.get(input.id)?.emitMetaUpdated({ title: input.title });
  }

  async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const result = await this.rpc.exportSession({
      ...input,
      version: input.version ?? this.identity?.version,
    });
    this.trackSessionEvent(input.id, 'export');
    return result;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    return this.rpc.listSessions(options);
  }

  async getConfig(options: GetConfigOptions = {}): Promise<KimiConfig> {
    return this.rpc.getConfig(options);
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

  async close(): Promise<void> {
    await Promise.all(Array.from(this.activeSessions.values(), (session) => session.close()));
    await this.closeImpl();
  }

  private trackSessionEvent(eventSessionId: string, event: string): void {
    withTelemetryContext(this.telemetry, { sessionId: eventSessionId }).track(event);
  }

  private trackSessionStarted(eventSessionId: string, resumed: boolean): void {
    withTelemetryContext(this.telemetry, { sessionId: eventSessionId }).track('session_started', {
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
