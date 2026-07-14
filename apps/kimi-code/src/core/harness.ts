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
import { dirname } from 'node:path';

import {
  bootstrap,
  ensureMainAgent,
  IAgentPermissionModeService,
  IAgentProfileService,
  IBootstrapService,
  IBuiltinSkillSource,
  IConfigService,
  IFlagService,
  IModelResolver,
  InMemorySkillCatalog,
  IPluginService,
  IProviderService,
  ISessionActivity,
  ISessionContext,
  ISessionExportService,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionWorkspaceContext,
  ISkillCatalogRuntimeOptions,
  ISkillDiscovery,
  IUserFileSkillSource,
  IWorkspaceRegistry,
  logSeed,
  MAIN_AGENT_ID,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  projectRoots,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  resolveThinkingEffortForModel,
  SKILL_SOURCE_PRIORITY,
  summarizeSkill,
  type GetPluginInfoInput,
  type InstallPluginInput,
  type ISessionScopeHandle,
  type MergeAllAvailableSkillsConfig,
  type PluginCommandDef,
  type PluginInfo,
  type PluginSummary,
  type ReloadSummary,
  type RemovePluginInput,
  type Scope,
  type SetPluginEnabledInput,
  type SetPluginMcpServerEnabledInput,
  type SkillContribution,
  type SkillSummary,
  type Model,
  type ThinkingDefaults,
} from '@moonshot-ai/agent-core-v2';
import { assertKimiHostIdentity, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

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
  PermissionMode,
  ResumedSessionState,
  TelemetryClient,
  TelemetryContextPatch,
  TelemetryProperties,
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
  const identity = options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: options.configPath });
  // TODO(v2-gap): G-3 — v2 bootstrap has no skillDirs input; options.skillDirs is dropped.
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const { app } = bootstrap({ homeDir, configPath }, logSeed(logging));
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

  /**
   * Synchronous view of the `[image]` limits for ingestion-time compression
   * (paste). Mirrors the v1 harness's `imageLimits`: v2's config service
   * resolves the section as env > config.toml > default on every read, so a
   * config reload applies immediately. Before the config service is ready (or
   * if the section is absent) the accessor yields `undefined` and
   * `compressImageForModel` falls back to its own env/built-in default.
   */
  readonly imageLimits = {
    maxEdgePx: (): number | undefined => {
      try {
        return this.deps.app.accessor
          .get(IConfigService)
          .get<{ maxEdgePx?: number } | undefined>('image')?.maxEdgePx;
      } catch {
        return undefined;
      }
    },
  };

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
        resolved = app.get(IModelResolver).resolve(model);
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
    // `ISessionLifecycleService.resume` refuses sessions whose workspace is
    // unknown to the registry, so skipping this would make the session
    // impossible to resume later.
    await app.get(IWorkspaceRegistry).createOrTouch(options.workDir);
    const handle = await app.get(ISessionLifecycleService).create({ sessionId: id, workDir: options.workDir });
    try {
      const main = await ensureMainAgent(handle);
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
      // TODO(v2-gap): G-8 — additional dirs only live on the session-scope
      // workspace context; they are not persisted across resumes.
      for (const dir of options.additionalDirs ?? []) {
        handle.accessor.get(ISessionWorkspaceContext).addAdditionalDir(dir);
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
        await app.get(ISessionLifecycleService).close(id).catch(() => {});
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
    const session = await this.resumeInternal(id, { additionalDirs: input.additionalDirs });
    this.trackSessionStarted(id, true, input.sessionStartedProperties);
    this.trackSessionEvent(id, 'session_resume');
    return session;
  }

  async reloadSession(input: ReloadSessionInput): Promise<CoreSession> {
    const id = normalizeSessionId(input.id);
    // TODO(v2-gap): G-5 — v2 cannot replay plugin session-start reminders;
    // `input.forcePluginSessionStartReminder` is accepted and ignored.
    const active = this.activeSessions.get(id);
    if (active !== undefined && active.handle.accessor.get(ISessionActivity).status() !== 'idle') {
      throw new CoreError(
        CoreErrorCodes.TURN_AGENT_BUSY,
        `Session "${id}" is busy; wait for the current turn to finish before reloading.`,
      );
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
    // v1 `forkId` maps onto the v2 `ForkSessionOptions.newSessionId`.
    const handle = await this.deps.app.accessor.get(ISessionLifecycleService).fork({
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
    const lifecycle = this.deps.app.accessor.get(ISessionLifecycleService);
    const handle = await lifecycle.resume(id);
    if (handle === undefined) {
      throw new CoreError(CoreErrorCodes.SESSION_NOT_FOUND, `Session "${id}" was not found.`);
    }
    try {
      await handle.accessor.get(ISessionMetadata).setTitle(input.title);
    } finally {
      await lifecycle.close(id).catch(() => {});
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
    const page = await app.get(ISessionIndex).list({});
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
      sessionDir: bootstrapService.sessionDir(summary.workspaceId, summary.id),
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      archived: summary.archived,
      metadata: summary.custom,
    }));
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

  /**
   * Skills listable before any session exists (session-less startup). v2's
   * skill catalog is Session-scoped, but its pieces are App-level: the
   * builtin and user sources are App services, and `skillRoots` +
   * `skillDiscovery` compose a workspace's skills from a bare workDir (this
   * is the composition `skillRoots` is exported for). Session-only sources
   * (explicit dirs, extra dirs, plugin skills) join once the lazy session
   * lands — `refreshSkillCommands(session)` then replaces this list.
   */
  async listStartupSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const app = this.deps.app.accessor;
    const config = app.get(IConfigService);
    await config.ready;
    const contributions: { c: SkillContribution; priority: number }[] = [
      { c: await app.get(IBuiltinSkillSource).load(), priority: SKILL_SOURCE_PRIORITY.builtin },
      { c: await app.get(IUserFileSkillSource).load(), priority: SKILL_SOURCE_PRIORITY.user },
    ];
    if ((app.get(ISkillCatalogRuntimeOptions).explicitDirs?.length ?? 0) === 0) {
      const mergeAllAvailableSkills =
        config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
      contributions.push({
        c: await app.get(ISkillDiscovery).discover(await projectRoots(workDir, { mergeAllAvailableSkills })),
        priority: SKILL_SOURCE_PRIORITY.workspace,
      });
    }
    const merged = new InMemorySkillCatalog();
    for (const { c } of contributions.toSorted((a, b) => a.priority - b.priority)) {
      for (const skill of c.skills) merged.register(skill, { replace: true });
    }
    return merged.listSkills().map((skill) => summarizeSkill(skill));
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
    input: { additionalDirs?: readonly string[] },
  ): Promise<CoreSession> {
    const handle = await this.deps.app.accessor.get(ISessionLifecycleService).resume(id);
    if (handle === undefined) {
      throw new CoreError(CoreErrorCodes.SESSION_NOT_FOUND, `Session "${id}" was not found.`);
    }
    // TODO(v2-gap): G-8 — additional dirs only live on the session-scope
    // workspace context; they are not persisted across resumes.
    for (const dir of input.additionalDirs ?? []) {
      handle.accessor.get(ISessionWorkspaceContext).addAdditionalDir(dir);
    }
    return this.hydrateSession(handle);
  }

  /** Ensure main, rebuild the resume snapshot, and register a `CoreSession`. */
  private async hydrateSession(handle: ISessionScopeHandle): Promise<CoreSession> {
    const main = await ensureMainAgent(handle);
    // TODO(v2-gap): G-30 — v2 resume has no warning channel;
    // `resumeState.warning` stays undefined.
    const resumeState = await buildResumedSessionState(handle, main);
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
        await this.deps.app.accessor.get(ISessionLifecycleService).close(id);
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
      client_name: this.deps.identity?.userAgentProduct ?? null,
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
