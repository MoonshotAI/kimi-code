/**
 * App-level facade over the v2 engine (`#/core`).
 *
 * `CoreHarness` is the TUI's single entry object: it owns the App scope
 * produced by `bootstrap()`, the map of live `CoreSession`s, the auth facade,
 * and the client-side telemetry semantics (verbatim from the v1 SDK
 * `KimiHarness`). Every method resolves an App-scope service through the DI
 * accessor and forwards with at most a light projection; session-scoped work
 * lives in `CoreSession`. Construction is split so tests can inject a fake
 * scope: `new CoreHarness(deps)` takes the ready-made pieces, while
 * `createCoreHarness(options)` performs the real bootstrap.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import {
  bootstrap,
  closeSessionById,
  ensureMainAgent,
  IAgentActivityView,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IBootstrapService,
  IConfigService,
  IFileService,
  IFlagService,
  IModelCatalog,
  IPluginService,
  IProviderService,
  ISessionContext,
  ISessionExportService,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  ISessionWorkspaceContext,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  logSeed,
  MAIN_AGENT_ID,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  resolveThinkingEffortForModel,
  resumeSessionById,
  summarizeSkill,
  type FileMeta,
  type GetPluginInfoInput,
  type InstallPluginInput,
  type ISessionScopeHandle,
  type PluginCommandDef,
  type PluginInfo,
  type PluginSummary,
  type ReloadSummary,
  type RemovePluginInput,
  type Scope,
  type SetPluginEnabledInput,
  type SetPluginMcpServerEnabledInput,
  type Model,
  type SkillSummary,
  type ThinkingDefaults,
} from '@moonshot-ai/agent-core-v2';
import { assertKimiHostIdentity, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import { ICapabilityService } from '@moonshot-ai/agent-core-v2/app/capability/capability';
import type { CapabilityStatus } from '@moonshot-ai/agent-core-v2/app/capability/types';
import { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import type { McpServerConfig } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import { loadMcpServers } from '@moonshot-ai/agent-core-v2/app/mcpConfig/configLoader';

import { KimiAuthFacade, type OAuthRefreshHandler } from './auth';
import { CoreError, CoreErrorCodes } from './errors';
import { buildResumedSessionState } from './replay';
import { CoreSession } from './session';
import type {
  ConfigDiagnostic,
  CoreConfig,
  CoreConfigPatch,
  CoreSessionSummary,
  CoreStartupState,
  ExportSessionInput,
  ExportSessionResult,
  FlagExplanation,
  McpServerEntry,
  PermissionMode,
  ResumedSessionState,
  TelemetryClient,
  TelemetryContextPatch,
  TelemetryProperties,
  WorkspaceTrustInfo,
  WorkspaceTrustMcpServerInfo,
} from './types';

/** Verbatim v1 stub written by `ensureConfigFile` (agent-core `config/toml.ts`). */
const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

const DEFAULT_SESSION_STARTED_UI_MODE = 'shell';

/** Telemetry sink used when the host does not supply a client. */
export const noopTelemetry: TelemetryClient = { track: () => {} };

/** Project one gated MCP server config into the safe display shape the trust prompt renders. */
function describeWorkspaceMcpServer(
  name: string,
  config: McpServerConfig,
): WorkspaceTrustMcpServerInfo {
  if (config.transport === 'stdio') {
    return {
      name,
      transport: config.transport,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
    };
  }
  return { name, transport: config.transport, url: config.url };
}

export interface CoreHarnessOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  readonly uiMode?: string;
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: OAuthRefreshHandler;
  /** TODO(v2-gap): G-3 — v2 bootstrap has no skillDirs input; accepted and ignored. */
  readonly skillDirs?: readonly string[];
  readonly sessionStartedProperties?: TelemetryProperties;
}

/** Ready-made pieces for `new CoreHarness(...)`; built by `createCoreHarness`. */
export interface CoreHarnessDeps {
  readonly app: Scope;
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: KimiHostIdentity;
  readonly uiMode: string;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly sessionStartedProperties: TelemetryProperties;
}

export interface CreateSessionOptions {
  readonly id?: string;
  readonly workDir: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: PermissionMode;
  readonly planMode?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly additionalDirs?: readonly string[];
  readonly sessionStartedProperties?: TelemetryProperties;
}

export interface ResumeSessionInput {
  readonly id: string;
  readonly additionalDirs?: readonly string[];
  /**
   * Limit each returned agent replay to the most recent N user turns. Omit to
   * return the full replay. Lets UI callers that only render the tail skip
   * folding and rehydrating the entire history (v1 `ResumeSessionPayload`
   * parity, #1976).
   */
  readonly replayTurnLimit?: number;
  readonly sessionStartedProperties?: TelemetryProperties;
}

export interface ReloadSessionInput {
  readonly id: string;
  /** TODO(v2-gap): G-5 — no v2 plugin session-start reminder replay; accepted and ignored. */
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface ForkSessionInput {
  readonly id: string;
  readonly forkId?: string;
  readonly title?: string;
}

export interface RenameSessionInput {
  readonly id: string;
  readonly title: string;
}

export interface ListSessionsOptions {
  readonly workDir?: string;
  readonly sessionId?: string;
}

export interface GetConfigOptions {
  readonly reload?: boolean;
}

/** Bootstrap the real v2 engine and wrap it in a `CoreHarness`. */
export function createCoreHarness(options: CoreHarnessOptions = {}): CoreHarness {
  const identity = assertKimiHostIdentity(options.identity);
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: options.configPath });
  // TODO(v2-gap): G-3 — v2 bootstrap has no skillDirs input; options.skillDirs is dropped.
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const { app } = bootstrap({ homeDir, configPath, clientIdentity: identity }, logSeed(logging));
  const auth = new KimiAuthFacade({ homeDir, configPath, identity, onRefresh: options.onOAuthRefresh });
  return new CoreHarness({
    app,
    homeDir,
    configPath,
    identity,
    uiMode: options.uiMode ?? DEFAULT_SESSION_STARTED_UI_MODE,
    telemetry: options.telemetry ?? noopTelemetry,
    auth,
    sessionStartedProperties: options.sessionStartedProperties ?? {},
  });
}

interface ActiveSession {
  readonly session: CoreSession;
  readonly handle: ISessionScopeHandle;
}

export class CoreHarness {
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: KimiAuthFacade;

  private readonly activeSessions = new Map<string, ActiveSession>();

  constructor(private readonly deps: CoreHarnessDeps) {
    this.homeDir = deps.homeDir;
    this.configPath = deps.configPath;
    this.auth = deps.auth;
  }

  /** Snapshot of live sessions (a fresh copy; mutating it does not affect the harness). */
  get sessions(): ReadonlyMap<string, CoreSession> {
    return new Map([...this.activeSessions].map(([id, { session }]) => [id, session]));
  }

  // -- Session lifecycle ------------------------------------------------------

  /**
   * Pre-session defaults for the TUI's initial render. Resolved from
   * App-scope services only — never creates a session. The context-window
   * fallback mirrors `CoreSession.getStatus()` and the thinking resolution
   * reuses the profile service's own helper, so the footer shows the same
   * values before and after the first session is created lazily.
   */
  async getStartupState(): Promise<CoreStartupState> {
    const app = this.deps.app.accessor;
    const config = app.get(IConfigService);
    await config.ready;
    const rawModel = config.get<unknown>('defaultModel');
    const model = typeof rawModel === 'string' ? rawModel : '';
    let resolved: Model | undefined;
    if (model.length > 0) {
      try {
        resolved = app.get(IModelCatalog).get(model);
      } catch {
        // Provider/auth not ready (e.g. logged out): degrade like getStatus.
        resolved = undefined;
      }
    }
    const rawPermission = config.get<unknown>('defaultPermissionMode');
    const rawPlanMode = config.get<unknown>('defaultPlanMode');
    const thinking = config.get<ThinkingDefaults>('thinking');
    return {
      model,
      maxContextTokens: resolved?.capabilities.max_context_tokens ?? 0,
      permissionMode:
        rawPermission === 'manual' || rawPermission === 'auto' || rawPermission === 'yolo'
          ? rawPermission
          : 'manual',
      planMode: typeof rawPlanMode === 'boolean' ? rawPlanMode : false,
      thinkingEffort: resolveThinkingEffortForModel(undefined, thinking, resolved),
    };
  }

  async createSession(options: CreateSessionOptions): Promise<CoreSession> {
    const id = options.id ?? randomUUID();
    const app = this.deps.app.accessor;
    // The workspace must be registered before the session is created —
    // `ISessionManager.resume` refuses sessions whose workspace is
    // unknown to the registry, so skipping this would make the session
    // impossible to resume later.
    await app.get(IWorkspaceService).createOrTouch(options.workDir);
    const manager = app.get(ISessionManager);
    const handle = await manager.create({
      sessionId: id,
      workDir: options.workDir,
      additionalDirs: options.additionalDirs,
    });
    try {
      const mainContext = await ensureMainAgent(handle);
      const main = handle.accessor.get(IAgentLifecycleService).handleOf(mainContext.agentId)!;
      if (options.model !== undefined) {
        await main.accessor.get(IAgentProfileService).setModel(options.model);
      }
      if (options.thinking !== undefined) {
        main.accessor.get(IAgentProfileService).setThinking(options.thinking);
      }
      if (options.permission !== undefined) {
        main.accessor.get(IAgentPermissionModeService).setMode(options.permission);
      }
      if (options.metadata !== undefined) {
        await handle.accessor.get(ISessionMetadata).update({ custom: { ...options.metadata } });
      }
      const summary = await this.projectLiveSummary(handle);
      const session = this.registerSession(handle, summary, undefined);
      if (options.planMode === true) {
        await session.setPlanMode(true);
      }
      this.trackSessionStarted(id, false, options.sessionStartedProperties);
      this.trackSessionEvent(id, 'session_new');
      return session;
    } catch (error) {
      // A session registered before the failure (e.g. `setPlanMode` or a
      // throwing telemetry client) already owns live event subscriptions —
      // including the App-scope IEventService one — so close it through
      // CoreSession.close() to release them; its onClose handles the
      // registry removal and the v2 scope close. Before registration a
      // bare lifecycle close is all there is to unwind.
      const registered = this.activeSessions.get(id);
      if (registered !== undefined) {
        await registered.session.close().catch(() => {});
      } else {
        await manager.close(id).catch(() => {});
      }
      this.activeSessions.delete(id);
      throw error;
    }
  }

  async resumeSession(input: ResumeSessionInput): Promise<CoreSession> {
    const id = normalizeSessionId(input.id);
    // v1 semantics: a live session is returned as-is and does not re-track
    // session_started / session_resume.
    const active = this.activeSessions.get(id);
    if (active !== undefined) return active.session;
    const session = await this.resumeInternal(id, {
      additionalDirs: input.additionalDirs,
      replayTurnLimit: input.replayTurnLimit,
    });
    this.trackSessionStarted(id, true, input.sessionStartedProperties);
    this.trackSessionEvent(id, 'session_resume');
    return session;
  }

  async reloadSession(input: ReloadSessionInput): Promise<CoreSession> {
    const id = normalizeSessionId(input.id);
    // TODO(v2-gap): G-5 — v2 cannot replay plugin session-start reminders;
    // `input.forcePluginSessionStartReminder` is accepted and ignored.
    const active = this.activeSessions.get(id);
    if (active !== undefined) {
      const mainContext = await ensureMainAgent(active.handle);
      const main = active.handle.accessor.get(IAgentLifecycleService).handleOf(mainContext.agentId)!;
      const activity = main.accessor.get(IAgentActivityView).state();
      if (activity.turn !== undefined || activity.background.length > 0) {
        throw new CoreError(
          CoreErrorCodes.TURN_AGENT_BUSY,
          `Session "${id}" is busy; wait for the current turn to finish before reloading.`,
        );
      }
    }
    await this.deps.app.accessor.get(IPluginService).reloadPlugins();
    if (active !== undefined) {
      await active.session.close();
    }
    const session = await this.resumeInternal(id, {});
    this.trackSessionEvent(id, 'session_reload');
    return session;
  }

  async forkSession(input: ForkSessionInput): Promise<CoreSession> {
    const sourceId = normalizeSessionId(input.id);
    // v1 `forkId` maps onto the v2 `ForkSessionOptions.newSessionId`. The
    // manager throws `session.not_found` for an unknown source (mirroring
    // kap-server's fork route); pre-check through the index to keep the
    // CoreError contract.
    const app = this.deps.app.accessor;
    if ((await app.get(ISessionIndex).get(sourceId)) === undefined) {
      throw new CoreError(
        CoreErrorCodes.SESSION_NOT_FOUND,
        `Session "${sourceId}" was not found.`,
      );
    }
    const handle = await app.get(ISessionManager).fork({
      sourceSessionId: sourceId,
      newSessionId: input.forkId,
      title: input.title,
    });
    const session = await this.hydrateSession(handle);
    this.trackSessionStarted(session.id, true);
    this.trackSessionEvent(session.id, 'session_fork');
    return session;
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    if (active !== undefined) {
      await active.handle.accessor.get(ISessionMetadata).setTitle(input.title);
      // v2's `setTitle` persists the rename but publishes no global
      // `session.meta.updated` event (verified against sessionMetadataService),
      // so re-emit one locally for the session's own listeners.
      active.session.emitEvent({
        type: 'session.meta.updated',
        title: input.title,
        agentId: MAIN_AGENT_ID,
        sessionId: id,
      });
      return;
    }
    // Cold rename: load, retitle, and put the session back to rest.
    const app = this.deps.app.accessor;
    const handle = await resumeSessionById(app, id);
    if (handle === undefined) {
      throw new CoreError(CoreErrorCodes.SESSION_NOT_FOUND, `Session "${id}" was not found.`);
    }
    try {
      await handle.accessor.get(ISessionMetadata).setTitle(input.title);
    } finally {
      await closeSessionById(app, id).catch(() => {});
    }
  }

  async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const id = normalizeSessionId(input.id);
    const result = await this.deps.app.accessor.get(ISessionExportService).export({
      sessionId: id,
      outputPath: input.outputPath,
      includeGlobalLog: input.includeGlobalLog,
      version: input.version,
      installSource: input.installSource,
      shellEnv: input.shellEnv,
    });
    this.trackSessionEvent(id, 'export');
    return result;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<readonly CoreSessionSummary[]> {
    const app = this.deps.app.accessor;
    const page = await app.get(ISessionIndex).listRecent({});
    const bootstrapService = app.get(IBootstrapService);
    let items = page.items;
    if (options.sessionId !== undefined) {
      items = items.filter((summary) => summary.id === options.sessionId);
    }
    if (options.workDir !== undefined) {
      items = items.filter((summary) => summary.cwd === options.workDir);
    }
    return items.map((summary) => ({
      id: summary.id,
      title: summary.title,
      lastPrompt: summary.lastPrompt,
      // `cwd` is optional only for sessions persisted before v2 recorded it.
      workDir: summary.cwd ?? '',
      sessionDir: join(bootstrapService.sessionsDir, summary.workspaceId, summary.id),
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      archived: summary.archived,
      metadata: summary.custom,
    }));
  }

  /**
   * Keyset-paged variant of `listSessions` for the session picker. Entries
   * dropped by the workDir filter shrink a page, so keep pulling pages until
   * the requested size is filled — the picker never sees a short page that
   * still carries a cursor.
   */
  async listSessionsPage(
    options: ListSessionsOptions & { readonly limit?: number; readonly before?: string } = {},
  ): Promise<{ items: readonly CoreSessionSummary[]; nextCursor: string | undefined }> {
    const app = this.deps.app.accessor;
    const index = app.get(ISessionIndex);
    const bootstrapService = app.get(IBootstrapService);
    const collected: CoreSessionSummary[] = [];
    let before = options.before;
    for (;;) {
      const remaining = options.limit === undefined ? undefined : options.limit - collected.length;
      if (remaining !== undefined && remaining <= 0) break;
      const page = await index.listRecent({
        sessionId: options.sessionId,
        limit: remaining,
        before,
      });
      if (page.items.length === 0) return { items: collected, nextCursor: undefined };
      let items = page.items;
      if (options.workDir !== undefined) {
        items = items.filter((summary) => summary.cwd === options.workDir);
      }
      collected.push(
        ...items.map((summary) => ({
          id: summary.id,
          title: summary.title,
          lastPrompt: summary.lastPrompt,
          // `cwd` is optional only for sessions persisted before v2 recorded it.
          workDir: summary.cwd ?? '',
          sessionDir: join(bootstrapService.sessionsDir, summary.workspaceId, summary.id),
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          archived: summary.archived,
          metadata: summary.custom,
        })),
      );
      if (page.nextCursor === undefined) return { items: collected, nextCursor: undefined };
      before = page.nextCursor;
      if (options.limit === undefined) return { items: collected, nextCursor: before };
    }
    return { items: collected, nextCursor: before };
  }

  getSession(id: string): CoreSession | undefined {
    return this.activeSessions.get(id)?.session;
  }

  async closeSession(id: string): Promise<void> {
    await this.activeSessions.get(id)?.session.close();
  }

  // -- Config -------------------------------------------------------------------

  async getConfig(options: GetConfigOptions = {}): Promise<CoreConfig> {
    const config = this.deps.app.accessor.get(IConfigService);
    await config.ready;
    if (options.reload === true) {
      await config.reload();
    }
    // TODO(v2-gap): G-11 — v2 exposes only the resolved config; there is no
    // raw config-text projection on this surface.
    return config.getAll();
  }

  async setConfig(patch: CoreConfigPatch): Promise<CoreConfig> {
    const config = this.deps.app.accessor.get(IConfigService);
    await config.ready;
    for (const [domain, value] of Object.entries(patch)) {
      await config.set(domain, value);
    }
    return config.getAll();
  }

  async getConfigDiagnostics(): Promise<readonly ConfigDiagnostic[]> {
    const config = this.deps.app.accessor.get(IConfigService);
    await config.ready;
    return config.diagnostics();
  }

  async removeProvider(providerId: string): Promise<CoreConfig> {
    const app = this.deps.app.accessor;
    await app.get(IProviderService).delete(providerId);
    return app.get(IConfigService).getAll();
  }

  async getExperimentalFeatures(): Promise<readonly FlagExplanation[]> {
    return this.deps.app.accessor.get(IFlagService).explainAll();
  }

  async ensureConfigFile(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.configPath, 'wx', 0o600);
      await handle.writeFile(DEFAULT_CONFIG_FILE_TEXT, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  // -- Plugins --------------------------------------------------------------------

  async listPlugins(): Promise<readonly PluginSummary[]> {
    return this.deps.app.accessor.get(IPluginService).listPlugins();
  }

  async installPlugin(input: InstallPluginInput): Promise<PluginSummary> {
    return this.deps.app.accessor.get(IPluginService).installPlugin(input);
  }

  async setPluginEnabled(input: SetPluginEnabledInput): Promise<void> {
    await this.deps.app.accessor.get(IPluginService).setPluginEnabled(input);
  }

  async setPluginMcpServerEnabled(input: SetPluginMcpServerEnabledInput): Promise<void> {
    await this.deps.app.accessor.get(IPluginService).setPluginMcpServerEnabled(input);
  }

  async removePlugin(input: RemovePluginInput): Promise<void> {
    await this.deps.app.accessor.get(IPluginService).removePlugin(input);
  }

  async reloadPlugins(): Promise<ReloadSummary> {
    return this.deps.app.accessor.get(IPluginService).reloadPlugins();
  }

  async getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo> {
    const info = await this.deps.app.accessor.get(IPluginService).getPluginInfo(input);
    if (info === undefined) {
      throw new CoreError(CoreErrorCodes.PLUGIN_NOT_FOUND, `Plugin "${input.id}" was not found.`);
    }
    return info;
  }

  async listPluginCommands(): Promise<readonly PluginCommandDef[]> {
    return this.deps.app.accessor.get(IPluginService).listPluginCommands();
  }

  // -- Capabilities (built-in product capabilities, v2-only domain) -------------------

  async listCapabilities(): Promise<readonly CapabilityStatus[]> {
    return this.deps.app.accessor.get(ICapabilityService).listCapabilities();
  }

  async getCapability(id: string): Promise<CapabilityStatus> {
    return this.deps.app.accessor.get(ICapabilityService).getCapability(id);
  }

  async installCapability(id: string): Promise<CapabilityStatus> {
    return this.deps.app.accessor.get(ICapabilityService).installCapability(id);
  }

  // -- Files (daemon file store) ---------------------------------------------------

  async uploadFile(
    data: Uint8Array,
    options: { readonly name: string; readonly mimeType?: string; readonly expiresInSec?: number },
  ): Promise<FileMeta> {
    return this.deps.app.accessor
      .get(IFileService)
      .save(Readable.from([data]), options.name, {
        expiresInSec: options.expiresInSec,
        mimeType: options.mimeType,
      });
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.deps.app.accessor.get(IFileService).delete(fileId);
  }

  // -- Workspace trust (startup gate) ------------------------------------------------

  /**
   * Trust state for the startup prompt: materializing the workspace handler is
   * a no-op cost here (session creation does it anyway). The gated-server list
   * is what the config loader sees with project files included vs skipped,
   * computed best-effort: an unreadable/invalid project file degrades to an
   * empty list rather than failing the caller.
   */
  async getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo> {
    const handler = await this.deps.app.accessor
      .get(IWorkspaceInstanceManager)
      .getOrCreate({ root: workDir });
    const trusted = await handler.program.trust.get();
    if (trusted) return { trusted: true, gatedMcpServers: [] };
    try {
      const fs = this.deps.app.accessor.get(IHostFileSystem);
      const [withProject, userOnly] = await Promise.all([
        loadMcpServers({ fs, cwd: workDir, homeDir: this.homeDir, includeProject: true }),
        loadMcpServers({ fs, cwd: workDir, homeDir: this.homeDir, includeProject: false }),
      ]);
      const gatedMcpServers = Object.entries(withProject)
        .filter(([name]) => !(name in userOnly))
        .map(([name, config]) => describeWorkspaceMcpServer(name, config))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      return { trusted: false, gatedMcpServers };
    } catch {
      return { trusted: false, gatedMcpServers: [] };
    }
  }

  /** Flipping trust fires the engine's change event, so project MCP servers connect live. */
  async trustWorkspace(workDir: string): Promise<void> {
    const handler = await this.deps.app.accessor
      .get(IWorkspaceInstanceManager)
      .getOrCreate({ root: workDir });
    await handler.program.trust.trust();
  }

  /**
   * The workspace handler's merged skill catalog (builtin / user / explicit /
   * extra / workspace-root / plugin), available before any session exists —
   * the same view a session would serve. `getOrCreate` is a no-op cost here:
   * session creation materializes the handler anyway.
   */
  async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const handler = await this.deps.app.accessor
      .get(IWorkspaceInstanceManager)
      .getOrCreate({ root: workDir });
    const catalog = handler.program.skills;
    await catalog.ready;
    return catalog.catalog.listSkills().map(summarizeSkill);
  }

  /**
   * `/mcp` is inspectable on a session-less startup before any session
   * exists: the MCP connection set is workspace-scoped. Awaits `ready` so a
   * fresh handler's initial connect settles before the list is read.
   */
  async listWorkspaceMcpServers(workDir: string): Promise<readonly McpServerEntry[]> {
    const handler = await this.deps.app.accessor
      .get(IWorkspaceInstanceManager)
      .getOrCreate({ root: workDir });
    const mcp = handler.program.mcp;
    await mcp.ready;
    return mcp.connectionManager().list();
  }

  // -- Telemetry / shutdown ----------------------------------------------------------

  track(event: string, properties?: TelemetryProperties): void {
    this.deps.telemetry.track(event, properties);
  }

  setTelemetryContext(patch: TelemetryContextPatch): void {
    this.deps.telemetry.setContext?.(patch);
  }

  async close(): Promise<void> {
    // TODO(v2-gap): G-4 — v2 has no exit-drain API. When pending background
    // work must finish before exit, the TUI layer waits before calling
    // close(); the facade does not implement its own wait loop.
    const active = [...this.activeSessions.values()];
    await Promise.all(active.map(({ session }) => session.close().catch(() => {})));
    try {
      this.deps.app.dispose();
    } catch {
      // The exit path must not throw.
    }
  }

  // -- Internals -----------------------------------------------------------------

  /** Cold-load a session and register it; shared by resume and reload. */
  private async resumeInternal(
    id: string,
    input: { additionalDirs?: readonly string[]; replayTurnLimit?: number },
  ): Promise<CoreSession> {
    const handle = await resumeSessionById(this.deps.app.accessor, id, {
      additionalDirs: input.additionalDirs,
    });
    if (handle === undefined) {
      throw new CoreError(CoreErrorCodes.SESSION_NOT_FOUND, `Session "${id}" was not found.`);
    }
    return this.hydrateSession(handle, input.replayTurnLimit);
  }

  /** Ensure main, rebuild the resume snapshot, and register a `CoreSession`. */
  private async hydrateSession(
    handle: ISessionScopeHandle,
    replayTurnLimit?: number,
  ): Promise<CoreSession> {
    const mainContext = await ensureMainAgent(handle);
    const main = handle.accessor.get(IAgentLifecycleService).handleOf(mainContext.agentId)!;
    // TODO(v2-gap): G-30 — v2 resume has no warning channel;
    // `resumeState.warning` stays undefined.
    const resumeState = await buildResumedSessionState(handle, main, replayTurnLimit);
    const summary = await this.projectLiveSummary(handle);
    return this.registerSession(handle, summary, resumeState);
  }

  private registerSession(
    handle: ISessionScopeHandle,
    summary: CoreSessionSummary,
    resumeState: ResumedSessionState | undefined,
  ): CoreSession {
    const id = handle.id;
    const session = new CoreSession({
      id,
      handle,
      app: this.deps.app,
      summary,
      resumeState,
      onClose: async () => {
        this.activeSessions.delete(id);
        await closeSessionById(this.deps.app.accessor, id);
      },
    });
    this.activeSessions.set(id, { session, handle });
    return session;
  }

  /** Project a live session's metadata + context into `CoreSessionSummary`. */
  private async projectLiveSummary(handle: ISessionScopeHandle): Promise<CoreSessionSummary> {
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const context = handle.accessor.get(ISessionContext);
    const workspace = handle.accessor.get(ISessionWorkspaceContext);
    return {
      id: meta.id,
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      workDir: meta.cwd ?? context.cwd,
      sessionDir: context.sessionDir,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      metadata: meta.custom,
      additionalDirs: workspace.additionalDirs,
    };
  }

  private scoped(sessionId: string): TelemetryClient {
    return this.deps.telemetry.withContext?.({ sessionId }) ?? this.deps.telemetry;
  }

  private trackSessionEvent(sessionId: string, event: string): void {
    this.scoped(sessionId).track(event);
  }

  private trackSessionStarted(
    sessionId: string,
    resumed: boolean,
    sessionScoped?: TelemetryProperties,
  ): void {
    this.scoped(sessionId).track('session_started', {
      ...this.deps.sessionStartedProperties,
      ...sessionScoped,
      // Canonical fields are owned by the harness and must win over any
      // caller-supplied sessionStartedProperties that happen to share a key.
      // `client_id` is always null here: a single-process host has no
      // per-connection client id (that concept only exists for daemon
      // clients). Kept as an explicit key so both producers share the same
      // session_started schema.
      client_id: null,
      client_name: this.deps.identity?.productName ?? null,
      client_version: this.deps.identity?.version ?? null,
      ui_mode: this.deps.uiMode,
      resumed,
    });
  }
}

function normalizeSessionId(value: string): string {
  if (typeof value !== 'string') {
    throw new CoreError(CoreErrorCodes.SESSION_ID_REQUIRED, 'Session id is required.');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new CoreError(CoreErrorCodes.SESSION_ID_EMPTY, 'Session id cannot be empty.');
  }
  return normalized;
}
