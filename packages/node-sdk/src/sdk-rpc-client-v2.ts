/**
 * v2 wiring MVP — an `SDKRpcClientBase` backed by the agent-core-v2 engine
 * (DI × Scope) instead of the v1 `KimiCore` RPC pair. The engine is
 * bootstrapped in-process and reached through the klient facade over the
 * memory transport, so every call crosses the same contract validation and
 * JSON round-trip as the networked transports.
 *
 * Migration model: the base class still carries the v1 method surface. Any
 * method not yet overridden here falls through to `getRpc()`, which fails
 * loudly with `not_implemented` — migrated methods are the ones overridden
 * below. Once every method is migrated, the v1 `getRpc()` dependency (and
 * the v1 core) goes away entirely.
 *
 * Migrated so far:
 * - `getExperimentalFeatures` → `klient.global.flags.list()`
 * - `listWorkspaceSkills` → not covered by the klient facade, so it goes
 *   through the `engineAccessor` escape hatch (the workspace handler's
 *   `IWorkspaceSkillCatalog`) instead.
 * - `getConfig` / `setConfig` / `removeProvider` / `getConfigDiagnostics` →
 *   `klient.global.config.*`, with the v1 `KimiConfig` shape restored by the
 *   pure mapping layer in `src/v2/config-mapper.ts`.
 * - `listPlugins` / `installPlugin` / `setPluginEnabled` /
 *   `setPluginMcpServerEnabled` / `removePlugin` / `reloadPlugins` /
 *   `getPluginInfo` / `listPluginCommands` → `klient.global.plugins.*`. The
 *   wire types are field-identical between the engines, so no mapping layer
 *   is needed. Unlike the config domain, the v2 plugin service serializes
 *   every read behind its own initial load, so there is no ready trap here.
 * - `listSessions` / `createSession` / `renameSession` / `forkSession` /
 *   `closeSession` / `resumeSession` / `reloadSession` /
 *   `updateSessionMetadata` / `addAdditionalDir` → the session lifecycle
 *   batch: `klient.global.sessions.list` plus the `klient.session(id)`
 *   metadata mutations where the facade reaches, and the
 *   `IWorkspaceLifecycleService` / handler chain / session-scope services through
 *   {@link engineAccessor} where it does not (explicit session ids, resume,
 *   fork ids, the workspace-level add-dir surface). The v1 `SessionSummary` / `SessionMeta`
 *   shapes are restored by the pure mapping layer in
 *   `src/v2/session-mapper.ts`. `deleteSession` stays `not_implemented` —
 *   the v2 engine has no session-deletion capability anywhere (tracked in
 *   `.tmp/v2-migration-tracker.md`). The resumed results carry the full v1
 *   per-agent snapshot: the live slices are read from the restored agent
 *   scope (profile / permission / swarm services + the klient agent facade),
 *   while `replay` and `toolStore` are folded from each agent's `wire.jsonl`
 *   through the v1 engine's own restore pipeline
 *   (`src/v2/resume-replay.ts`) — `includeSubagents` and `replayTurnLimit`
 *   included.
 * - `setModel` / `setPermission` / `setPlanMode` / `getPlan` / `clearPlan` /
 *   `getContext` / `getUsage` / `cancel` → the `klient.session(id).agent(id)`
 *   facade; `setThinking` / `compact` / `cancelCompaction` / `undoHistory` /
 *   `clearContext` / `importContext` → agent-scope services through the live
 *   session handle (no facade exists); `getStatus` → the same six-slice
 *   aggregate the base class builds, re-read from the profile / permission /
 *   swarm services plus the facade. `importContext` composes v1's exact
 *   message + rejections over v2 primitives (`src/v2/import-context.ts`) —
 *   the engine has no import capability of its own. `createSession`'s
 *   `model` / `thinking` / `permission` options are applied in this batch
 *   too (default-profile bind + permission mode).
 * - `prompt` / `steer` / `runShellCommand` / `cancelShellCommand` → the
 *   `klient.session(id).agent(id)` facade; `activatePluginCommand` →
 *   `IAgentRPCService` through the agent scope; `activateSkill` →
 *   `IAgentSkillService` through the agent scope (the RPC service's
 *   fire-and-forget variant would swallow v1's synchronous rejections) plus
 *   v1's main-only metadata update; `generateAgentsMd` →
 *   `ISessionInitService` through the session scope; `getSessionWarnings` →
 *   rebuilt over the profile's cached AGENTS.md warning plus the engine's
 *   `prepareSystemPromptContext` (no v2 aggregate service exists).
 * - `createGoal` / `getGoal` / `pauseGoal` / `resumeGoal` / `cancelGoal` →
 *   `IAgentGoalService` through the agent scope; `getCronTasks` →
 *   `ISessionCronService` through the session scope with the v1 snapshot
 *   shape restored; `listBackgroundTasks` / `getBackgroundTaskOutput` → the
 *   `klient.session(id).agent(id)` facade; `stopBackgroundTask` /
 *   `detachBackgroundTask` → `IAgentTaskService` through the agent scope
 *   (the facade's no-reason stop substitutes a user-cancellation reason v1
 *   never records); `waitForBackgroundTasksOnPrint` /
 *   `handlePrintMainTurnCompleted` → rebuilt over the v2 print-mode config
 *   helpers and the session's per-agent task services (no v2 service owns
 *   the print policy).
 * - `listGlobalMcpServers` / `addGlobalMcpServer` / `updateGlobalMcpServer` /
 *   `removeGlobalMcpServer` / `beginGlobalMcpServerAuth` /
 *   `completeGlobalMcpServerAuth` / `cancelGlobalMcpServerAuth` /
 *   `resetGlobalMcpServerAuth` / `testGlobalMcpServer` → the v1 user-global
 *   MCP surface, rebuilt in `src/v2/global-mcp.ts`: agent-core-v2 only reads
 *   the user-global `mcp.json` (nothing in the engine writes it) and binds
 *   its OAuth orchestrator inside the session scope, so the file store and
 *   the `require*` guards are byte-identical ports, driven by the v2
 *   engine's own `McpOAuthService` / `McpConnectionManager` (deep imports —
 *   the package index does not re-export them) over the app-scope
 *   `IAtomicDocumentStore`, whose on-disk layout
 *   (`<home>/credentials/mcp/<key>-*.json`) matches v1's.
 * - `listMcpServers` / `getMcpStartupMetrics` / `reconnectMcpServer` →
 *   the seeded `ISessionMcpHandle.connectionManager` through the session
 *   scope (no klient facade exists) — one shared manager per workspace
 *   handler since the workspace-domain resource consolidation; the v2
 *   `McpServerEntry` is field-identical with v1's `McpServerInfo`.
 * - `onEvent` / `receiveEvent` → the base class registries, fed by a
 *   per-live-session wiring (`src/v2/session-wiring.ts`) that subscribes
 *   every live agent's `IEventBus` and translates each `DomainEvent` back
 *   into the v1 `Event` shape (`src/v2/event-mapper.ts`); the klient events
 *   hub is deliberately bypassed because its contract registry exposes only
 *   13 of the bus types (no `shell.*`, no `turn.step.*`, ...). The one
 *   v1-visible fact on the process-global `IEventService`
 *   (`session.meta.updated`) is forwarded from a constructor subscription.
 * - `setApprovalHandler` / `setQuestionHandler` → the base class registries,
 *   driven by the same session wiring: v1's push callbacks
 *   (`requestApproval` / `requestQuestion` / `toolCall`) are fed from the v2
 *   interaction kernel's pending set (`onDidChangePending`), and the outcome
 *   is written back through `ISessionApprovalService.decide` /
 *   `ISessionQuestionService.answer|dismiss` / the kernel's `respond`.
 * - `exportSession` → `ISessionExportService` (app scope, the v2 port of v1's
 *   export) through {@link engineAccessor}; `listSkills` → the session
 *   scope's `ISessionSkillCatalog`; `startBtw` → the session scope's
 *   `ISessionBtwService`; `setSwarmMode` / `swarm` → the agent scope's
 *   `IAgentSwarmService` (the v2 port of v1's `SwarmMode`), with `swarm()`
 *   recomposed over the `setSwarmMode` + `prompt` overrides.
 *   `createSessionWithKaos` / `resumeSessionWithKaos` deliberately keep the
 *   base class's kaos-ignoring degradation (the v2 engine has no kaos
 *   injection point — see the session-lifecycle section header), and
 *   `toolCall` keeps the base class's "not supported" answer, which the
 *   interaction bridge already relies on.
 * - `applyPersistedSecondaryModel` → the reload + loud validations + warning
 *   refresh of v1's contract, rebuilt over the live `IConfigService` recipe
 *   and `ISessionSecondaryModelWarningService.recheckSecondaryModelWarning`
 *   (the v2 spawn binding resolves the secondary model at spawn time, so
 *   there is no session snapshot to push). `getSessionWarnings` also
 *   surfaces the v2 secondary-model warning next to the AGENTS.md one,
 *   matching v1's aggregate.
 */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ensureConfigFile,
  ErrorCodes,
  HookDefSchema,
  KimiError,
  limitAgentReplayByTurns,
  noopTelemetryClient,
  type AgentContextData,
  type BeginGlobalMcpServerAuthResult,
  type ExperimentalFeatureState,
} from '@moonshot-ai/agent-core';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
import { MCP_SECTION, type McpSection } from '@moonshot-ai/agent-core-v2/app/mcpConfig/configSection';
import { IAgentIdentity } from '@moonshot-ai/agent-core-v2/app/agentIdentity/agentIdentity';
import { McpConnectionManager } from '@moonshot-ai/agent-core-v2/mcpCore/connection-manager';
import {
  AlreadyAuthorizedError,
  McpOAuthService,
  type BeginAuthorizationResult,
} from '@moonshot-ai/agent-core-v2/mcpCore/oauth/service';
import { createMcpOAuthStore } from '@moonshot-ai/agent-core-v2/app/mcpConfig/oauthStore';
import { SECONDARY_MODEL_SECTION } from '@moonshot-ai/agent-core-v2/app/kosongConfig/configSection';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { wrapSubagentModelError } from '@moonshot-ai/agent-core-v2/session/subagent/configSection';
import { loadMcpServers } from '@moonshot-ai/agent-core-v2/workspace/workspaceMcpConfig/internal/config-loader';
import {
  applyPromptMetadataUpdate,
  bootstrap,
  DEFAULT_AGENT_PROFILE_NAME,
  ensureKimiHome,
  ensureMainAgent,
  IAgentActivityView,
  IAgentContextMemoryService,
  IAgentFullCompactionService,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentProfileService,
  IAgentRPCService,
  IAgentSkillService,
  IAgentSwarmService,
  IAgentTaskService,
  IAgentTokenCountingService,
  IBootstrapService,
  IConfigService,
  IEventService,
  IHostEnvironment,
  IHostFileSystem,
  IModelCatalog,
  IModelService,
  IProviderService,
  ISessionBtwService,
  ISessionContext,
  ISessionCronService,
  ISessionExportService,
  ISessionIndex,
  ISessionInitService,
  ISessionMcpHandle,
  ISessionMetadata,
  ISessionSecondaryModelWarningService,
  ISessionSkillCatalog,
  ISessionWorkspaceContext,
  ITelemetryService,
  IWorkspaceAliases,
  IWorkspaceDirs,
  IWorkspaceMcpService,
  ISessionLifecycleService,
  IWorkspaceLifecycleService,
  IWorkspaceSkillCatalog,
  IWorkspaceTrust,
  closeSessionById,
  followWorkspaceHandlers,
  getLiveSessionById,
  handlerForSession,
  resumeSessionById,
  sessionDirOf,
  workspacePersistenceScope,
  logSeed,
  MAIN_AGENT_ID,
  prepareSystemPromptContext,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  ProfileError,
  ProfileErrors,
  promptMetadataTextFromSkill,
  resolveAgentTaskConfig,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  resolvePrintBackgroundMode,
  summarizeSkill,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
  type SecondaryModelConfig,
  type ServicesAccessor,
} from '@moonshot-ai/agent-core-v2';
import type { AgentHandle, Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';
import { assertKimiHostIdentity, createKimiDefaultHeaders } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { KimiHarness } from '#/kimi-harness';
import {
  SDKRpcClientBase,
  type ActivatePluginCommandRpcInput,
  type ActivateSkillRpcInput,
  type ImportContextRpcInput,
  type ReconnectMcpServerRpcInput,
  type ReloadSessionRpcInput,
  type SessionIdRpcInput,
  type SessionPromptRpcInput,
  type SetSessionModelRpcInput,
  type SetSessionModelRpcResult,
  type SetSessionPermissionRpcInput,
  type SetSessionPlanModeRpcInput,
  type SetSessionSwarmModeRpcInput,
  type SetSessionThinkingRpcInput,
  type UpdateSessionMetadataRpcInput,
} from '#/rpc';
import type {
  AddAdditionalDirInput,
  AddAdditionalDirResult,
  CapabilityStatus,
  BackgroundTaskInfo,
  CompactOptions,
  ConfigDiagnostics,
  CreateGoalInput,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  ForkSessionInput,
  GetConfigOptions,
  GetCronTasksResult,
  GoalSnapshot,
  GoalToolResult,
  JsonObject,
  KimiConfig,
  KimiConfigPatch,
  KimiHarnessOptions,
  KimiHostIdentity,
  ListSessionsOptions,
  McpServerConfig,
  McpServerInfo,
  McpStartupMetrics,
  McpTestResult,
  OAuthRefreshOutcome,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  ReloadSummary,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedAgentState,
  ResumedSessionSummary,
  SessionPlan,
  SessionStatus,
  SessionSummary,
  SessionUsage,
  SkillSummary,
  TelemetryClient,
  WorkspaceTrustInfo,
} from '#/types';
import {
  diagnosticsToConfigDiagnostics,
  planProviderRemoval,
  resolvedConfigToKimiConfig,
} from '#/v2/config-mapper';
import { translateGlobalEvent } from '#/v2/event-mapper';
import { assertImportFits, buildImportContextMessage } from '#/v2/import-context';
import { foldAgentWireReplay } from '#/v2/resume-replay';
import {
  GlobalMcpConfigStore,
  mcpConfigWithoutName,
  requireOAuthMcpServer,
  requireRemoteMcpServer,
  standaloneMcpTestResult,
} from '#/v2/global-mcp';
import {
  normalizeWorkDir,
  v2MetaToSessionMeta,
  v2SummaryToSessionSummary,
} from '#/v2/session-mapper';
import { SessionEventWiring } from '#/v2/session-wiring';

export interface SDKRpcClientV2Options {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  /**
   * Explicit skill directories for this process (v1's SDK `skillDirs` /
   * the CLI's `--skills-dir`): when non-empty, default user / project skill
   * discovery is skipped and these directories serve as the user skill
   * source. Passed into the engine through `BootstrapInput.args.skillDirs`.
   */
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  readonly uiMode?: string;
}

/**
 * The largest `setTimeout` delay before Node's timer overflows into an
 * immediate fire (2^31 - 1 ms ≈ 24.8 days) — the same bound v1's
 * `timeoutOutcome` clamps to.
 */
const MAX_TIMER_DELAY_MS = 0x7fffffff;

/** v1's default for `completeGlobalMcpServerAuth` when the host gives no timeout. */
const DEFAULT_GLOBAL_MCP_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

export class SDKRpcClientV2 extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly klient: Klient;

  private readonly app: Scope;
  /**
   * The engine's config reads (`get`/`getAll`/`inspect`/`diagnostics`) are
   * synchronous over state that only exists once the initial load settles;
   * unlike the mutating methods they do not await `IConfigService.ready`
   * internally, so every config override below awaits this first. Awaiting
   * the engine's own ready handle (via the accessor) instead of issuing a
   * dummy facade call keeps the reads honest no-ops.
   */
  private readonly configReady: Promise<void>;
  /**
   * Per-session print-steer state for `handlePrintMainTurnCompleted`: v1
   * keeps the deadline/turn counters on the `Session` object, so they reset
   * when the session closes (a resume builds a fresh `Session`); mirrored
   * here by deleting the entry in `closeSession` / `reloadSession`.
   */
  private readonly printSteerStates = new Map<string, { deadline?: number; turns: number }>();
  /**
   * The model/provider registries (`IModelService` / `IProviderService`)
   * share the config service's ready trap: their `get`/`list` reads are
   * synchronous over state that only exists after hydration, and every
   * agent-side model operation (profile bind, `setModel`, capability reads)
   * flows through them. Agent-interaction overrides await this before
   * touching a profile.
   */
  private readonly modelReady: Promise<void>;
  /**
   * The user-global MCP file store (`<home>/mcp.json`) — the SDK-side port in
   * `src/v2/global-mcp.ts`, because agent-core-v2 only reads that file and
   * has no write-side service for it.
   */
  private readonly globalMcpConfig: GlobalMcpConfigStore;
  /**
   * v1's per-core global OAuth orchestrator, mirrored per client. Built
   * lazily over the app-scope `IAtomicDocumentStore` (same on-disk layout as
   * v1's `<home>/credentials/mcp/` file store).
   */
  private globalMcpOAuth: McpOAuthService | undefined;
  /** In-flight OAuth flows keyed by the flowId handed to the host (v1 shape). */
  private readonly globalMcpOAuthFlows = new Map<string, { flow: BeginAuthorizationResult }>();
  /**
   * Per-live-session event/interaction wirings (`src/v2/session-wiring.ts`):
   * created when a session materializes through this client (create / resume /
   * fork / reload), dropped on close (ours or the engine's). Each wiring feeds
   * the base class's event listeners from the session's per-agent event buses
   * and bridges its pending approvals / questions / user-tool calls to the
   * registered handlers.
   */
  private readonly sessionWirings = new Map<string, SessionEventWiring>();
  /** App-scope subscriptions (global event forwarding, lifecycle tracking), disposed in {@link close}. */
  private readonly appSubscriptions: IDisposable[] = [];

  constructor(options: SDKRpcClientV2Options = {}) {
    super();
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    ensureKimiHome(this.homeDir);
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    const identity = assertKimiHostIdentity(this.identity);
    const { app } = bootstrap(
      {
        homeDir: this.homeDir,
        configPath: this.configPath,
        clientIdentity: identity,
        args: {
          // Host identity headers for the engine's outbound requests (model,
          // WebSearch, registry refresh). Without them the managed vendors go
          // out with the SDK's default User-Agent and no X-Msh-* at all.
          requestHeaders: createKimiDefaultHeaders({ homeDir: this.homeDir, ...identity }),
          // `--skills-dir` (v1 parity): explicit skill dirs replace default
          // user / project discovery for every session this client hosts.
          skillDirs: options.skillDirs,
        },
      },
      [...logSeed(resolveLoggingConfig({ homeDir: this.homeDir, env: process.env }))],
    );
    this.app = app;
    this.klient = createKlient({ scope: app });
    this.globalMcpConfig = new GlobalMcpConfigStore(this.homeDir);
    this.configReady = app.accessor.get(IConfigService).ready;
    this.installEngineTelemetry(options.telemetry);
    this.modelReady = Promise.all([
      this.configReady,
      app.accessor.get(IModelService).ready,
      app.accessor.get(IProviderService).ready,
    ]).then(() => undefined);
    this.appSubscriptions.push(
      // v1's stream carries `session.meta.updated` (the prompt metadata
      // path) — the one v1-visible fact the v2 engine publishes on the
      // process-global IEventService rather than a per-agent bus. Every other
      // global-bus type is a daemon/WS-edge event the in-process v1 client
      // never saw, so the translation filters down to that single type.
      this.app.accessor.get(IEventService).subscribe((event) => {
        const translated = translateGlobalEvent(event);
        if (translated !== undefined) this.receiveEvent(translated);
      }),
      // A session closed without going through this client (archive, an
      // engine-initiated close) drops its wiring with the scope. Close events
      // fire per workspace handler, so follow every handler — present and
      // future — through the App-scope registry.
      followWorkspaceHandlers(this.app.accessor, (service) =>
        service.onDidCloseSession((closed) => {
          this.unwireSession(closed.sessionId);
        }),
      ),
    );
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    for (const wiring of this.sessionWirings.values()) {
      wiring.dispose();
    }
    this.sessionWirings.clear();
    for (const subscription of this.appSubscriptions) {
      subscription.dispose();
    }
    await this.klient.close();
    this.app.dispose();
  }

  /**
   * Forward engine telemetry to the host-supplied client. Without this the
   * client only served `KimiHarness`-level events and every engine-side event
   * (`track2` facts from agent/session scopes) was dropped on the v2 route.
   * The `ITelemetryAppender` shape is a structural superset of the v1
   * `TelemetryClient`, so the client installs directly. The `telemetry`
   * config section gates engine events the same way the v2 print runner
   * gates them; the host keeps owning the client's lifecycle (flush /
   * shutdown stay with the host, matching the v1 core's arrangement).
   */
  private installEngineTelemetry(client: TelemetryClient | undefined): void {
    if (client === undefined) return;
    const telemetry = this.app.accessor.get(ITelemetryService);
    telemetry.setAppender(client);
    void this.configReady.then(() => {
      telemetry.setEnabled(this.engineAccessor.get(IConfigService).get('telemetry') !== false);
    });
  }

  /**
   * Escape hatch to the in-process engine's app-scope service accessor, for
   * SDK methods whose capability exists in agent-core-v2 but is not (yet)
   * exposed through the klient facade. This is a deliberate migration
   * pressure valve, not a new public API direction:
   * - it only exists because this client owns the bootstrapped `Scope` —
   *   there is nothing equivalent on a remote (ipc) transport, so anything
   *   built on it is in-process-only by construction;
   * - it resolves App-scope services only. Session/agent services need their
   *   own scope handles (via the lifecycle services), not this accessor;
   * - every use should name the klient facade method it stands in for, and
   *   move onto the facade once one exists. Remove when the migration ends.
   */
  get engineAccessor(): ServicesAccessor {
    return this.app.accessor;
  }

  protected getRpc(): Promise<never> {
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      'This SDK method is not wired to agent-core-v2 yet.',
    );
  }

  override async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return this.klient.global.flags.list();
  }

  /**
   * Through the workspace handler's `IWorkspaceSkillCatalog` — the engine's
   * own merged view (builtin / user / explicit / extra / workspace-root /
   * plugin), so the session-less list matches what a session would serve.
   * `handlerFor` is create-or-get: session creation materializes the handler
   * anyway.
   */
  override async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const handler = await this.engineAccessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ root: normalizeRequiredWorkDir('listWorkspaceSkills', workDir) });
    const catalog = handler.accessor.get(IWorkspaceSkillCatalog);
    await catalog.ready;
    return catalog.catalog.listSkills().map(summarizeSkill);
  }

  /**
   * klient has no workspace-trust facade; composed directly from the engine
   * via {@link engineAccessor} — the same `handlerFor({ root })` path
   * `createSession` takes (materializing the workspace handler is a no-op
   * cost here: session creation does it anyway). The gated-server list is
   * what the pure config loader sees with project files included vs skipped
   * (the workspaceTrust gate inside the engine's `workspaceMcpConfig`),
   * computed best-effort: an unreadable/invalid project file degrades to an
   * empty list rather than failing the caller.
   */
  override async getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo> {
    const handler = await this.engineAccessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ root: workDir });
    const trusted = await handler.accessor.get(IWorkspaceTrust).get();
    if (trusted) return { trusted: true, gatedMcpServers: [] };
    try {
      const fs = this.engineAccessor.get(IHostFileSystem);
      const [withProject, userOnly] = await Promise.all([
        loadMcpServers({ fs, cwd: workDir, homeDir: this.homeDir, includeProject: true }),
        loadMcpServers({ fs, cwd: workDir, homeDir: this.homeDir, includeProject: false }),
      ]);
      const gatedMcpServers = Object.keys(withProject)
        .filter((name) => !(name in userOnly))
        .toSorted();
      return { trusted: false, gatedMcpServers };
    } catch {
      return { trusted: false, gatedMcpServers: [] };
    }
  }

  /**
   * klient has no workspace-trust facade; see {@link getWorkspaceTrustInfo}.
   * The flip fires `IWorkspaceTrust.onDidChange`, which makes the engine's
   * `workspaceMcpConfig` reload with project files included — project MCP
   * servers connect live, no restart needed.
   */
  override async trustWorkspace(workDir: string): Promise<void> {
    const handler = await this.engineAccessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ root: workDir });
    await handler.accessor.get(IWorkspaceTrust).trust();
  }

  /**
   * v1 returns the whole config.toml document as one `KimiConfig`; v2
   * resolves the same file per config domain. `getAll()` is the effective
   * view (file + env overlays + section defaults), which matches v1's
   * runtime config (`loadRuntimeConfigSafe` + the KIMI_MODEL_* overlay);
   * `reload` mirrors v1's re-read-from-disk option.
   */
  override async getConfig(options?: GetConfigOptions): Promise<KimiConfig> {
    await this.configReady;
    if (options?.reload) {
      await this.klient.global.config.reload();
    }
    return resolvedConfigToKimiConfig(await this.klient.global.config.getAll());
  }

  override async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    await this.configReady;
    return diagnosticsToConfigDiagnostics(await this.klient.global.config.diagnostics());
  }

  /**
   * A v1 patch is one deep-merge over the whole document; v2 deep-merges
   * per domain with the same plain-object-recursive / array-replace
   * semantics, so the patch fans out one `config.set` per top-level field.
   * Unknown-to-v2 fields (`yolo`, `planMode`, `telemetry`, ...) persist as
   * unregistered pass-through domains, like v1's schema keeping them.
   */
  override async setConfig(patch: KimiConfigPatch): Promise<KimiConfig> {
    await this.configReady;
    for (const [domain, domainPatch] of Object.entries(patch)) {
      if (domainPatch === undefined) continue;
      await this.klient.global.config.set({ domain, patch: domainPatch });
    }
    return this.getConfig();
  }

  /**
   * v1's removal cascades: the provider entry, every model pointing at it,
   * and the default pointers when they dangle. The engine's own
   * `kosong.removeProvider` only clears the default-provider pointer, so the
   * full v1 cascade is computed from the user-layer values (see
   * `planProviderRemoval`) and persisted as ONE atomic multi-section replace —
   * the same single-write shape as v1's `removeKimiProvider`, so a process
   * exit can never leave the file in a halfway-cascaded state.
   */
  override async removeProvider(providerId: string): Promise<KimiConfig> {
    await this.configReady;
    const [providers, models, defaultModel, defaultProvider] = await Promise.all([
      this.klient.global.config.inspect<Record<string, unknown>>('providers'),
      this.klient.global.config.inspect<Record<string, Record<string, unknown>>>('models'),
      this.klient.global.config.inspect<string>('defaultModel'),
      this.klient.global.config.inspect<string>('defaultProvider'),
    ]);
    const plan = planProviderRemoval({
      providers: providers.userValue,
      models: models.userValue,
      defaultModel: defaultModel.userValue,
      defaultProvider: defaultProvider.userValue,
      providerId,
    });
    const sections: Record<string, unknown> = {
      providers: plan.providers,
      models: plan.models,
    };
    if (plan.clearDefaultModel) {
      sections['defaultModel'] = undefined;
    }
    if (plan.clearDefaultProvider) {
      sections['defaultProvider'] = undefined;
    }
    await this.klient.global.config.replaceSections({ sections });
    return this.getConfig();
  }

  override supportsAtomicSectionReplace(): boolean {
    return true;
  }

  override async replaceConfigSections(sections: Record<string, unknown>): Promise<void> {
    await this.configReady;
    await this.klient.global.config.replaceSections({ sections });
  }

  override async listPlugins(): Promise<readonly PluginSummary[]> {
    return this.klient.global.plugins.list();
  }

  override async installPlugin(source: string): Promise<PluginSummary> {
    return this.klient.global.plugins.install(source);
  }

  override async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    return this.klient.global.plugins.setEnabled({ id, enabled });
  }

  override async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    return this.klient.global.plugins.setMcpServerEnabled({ id, server, enabled });
  }

  override async removePlugin(id: string): Promise<void> {
    return this.klient.global.plugins.remove(id);
  }

  override async reloadPlugins(): Promise<ReloadSummary> {
    return this.klient.global.plugins.reload();
  }

  override async getPluginInfo(id: string): Promise<PluginInfo> {
    // The v2 engine's hook-event union is a superset of v1's (`TurnStarted`,
    // `UserPromptQueued`, `TaskStarted`, `SessionHeartbeat` are v2-only). The
    // SDK contract keeps the v1 `PluginInfo` shape, so hooks using v2-only
    // events are dropped from the projection — mirroring how the config
    // mapper drops config domains v1 does not know.
    const info = await this.klient.global.plugins.info(id);
    const manifest =
      info.manifest === undefined
        ? undefined
        : {
            ...info.manifest,
            hooks: info.manifest.hooks?.filter((hook) =>
              (HookDefSchema.shape.event.options as readonly string[]).includes(hook.event),
            ) as NonNullable<PluginInfo['manifest']>['hooks'],
          };
    return { ...info, manifest };
  }

  /**
   * Capability surface (v2-only): built-in product capabilities (kimi-cu,
   * kimi-webbridge) with layered readiness and idempotent installs. v1 has
   * no capability domain, so these stay off the shared base — callers
   * feature-detect via `in` before use.
   */
  async listCapabilities(): Promise<readonly CapabilityStatus[]> {
    return this.klient.global.capabilities.list();
  }

  async getCapability(id: string): Promise<CapabilityStatus> {
    return this.klient.global.capabilities.get(id);
  }

  async installCapability(id: string): Promise<CapabilityStatus> {
    return this.klient.global.capabilities.install(id);
  }

  /**
   * Scope gap: v1 answers from the session's creation-time snapshot of the
   * enabled plugin commands, while the v2 engine only exposes the app-global
   * live view (`pluginService.listPluginCommands`), so the sessionId is
   * ignored here. The two agree for any session created after the last
   * plugin change; a v1 session predating an install/toggle goes stale where
   * v2 stays live.
   */
  override async listPluginCommands(
    input: SessionIdRpcInput,
  ): Promise<readonly PluginCommandDef[]> {
    void input;
    return this.listPluginCommandsGlobal();
  }

  /** App-global live view of the enabled plugin commands, no session required. */
  override async listPluginCommandsGlobal(): Promise<readonly PluginCommandDef[]> {
    return this.klient.global.plugins.listCommands();
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  //
  // The v2 engine splits what v1's SessionStore + in-memory session map did
  // across the app-scope `ISessionIndex` (persisted read model),
  // `IWorkspaceLifecycleService` (live workspace handlers and, under them, the
  // live session scopes), and the session-scope
  // metadata/workspace services. The klient facade covers listing and the
  // metadata mutations of a LIVE session; everything that needs an explicit
  // session id, a resume, or a workspace command goes through the
  // `engineAccessor` escape hatch (named per method below).
  //
  // `createSessionWithKaos` / `resumeSessionWithKaos` are deliberately NOT
  // overridden: agent-core-v2 has no kaos injection point (its fs/process
  // abstraction is the engine-internal hostFs domain, resolved at bootstrap),
  // so the base class's degradation — ignore the kaos arguments and run a
  // plain local create/resume — is the honest behavior, the same one every
  // daemon-transport client settles for. Failing loudly instead would break
  // hosts that pass kaos opportunistically (the harness forwards it whenever
  // the host supplies one).
  // -----------------------------------------------------------------------

  private liveSession(sessionId: string): ISessionScopeHandle | undefined {
    return getLiveSessionById(this.engineAccessor, sessionId);
  }

  /** v1's `requireSession` / store lookup failure shape. */
  private static sessionNotFound(sessionId: string): KimiError {
    return new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session "${sessionId}" was not found`, {
      details: { sessionId },
    });
  }

  /** The live session handle, or the error v1 raises for a non-active session. */
  private requireLiveSession(sessionId: string): ISessionScopeHandle {
    const handle = this.liveSession(sessionId);
    if (handle === undefined) throw SDKRpcClientV2.sessionNotFound(sessionId);
    return handle;
  }

  /**
   * Attach the event/interaction wiring to a freshly materialized session
   * (idempotent). Unwiring needs no call site of its own: every close path
   * goes through the engine's lifecycle close, whose `onDidCloseSession`
   * subscription (constructor) drops the wiring.
   */
  private wireSession(handle: ISessionScopeHandle): void {
    if (this.sessionWirings.has(handle.id)) return;
    this.sessionWirings.set(handle.id, new SessionEventWiring(handle, this));
  }

  private unwireSession(sessionId: string): void {
    const wiring = this.sessionWirings.get(sessionId);
    if (wiring === undefined) return;
    this.sessionWirings.delete(sessionId);
    wiring.dispose();
  }

  /**
   * The v1 summary of a live session, read from its own scope services (the
   * metadata document, the context's cwd/sessionDir, the workspace context's
   * additional dirs) rather than the index — no disk round-trip, and the
   * additional dirs only exist on the live session in both engines.
   */
  private async liveSessionSummary(handle: ISessionScopeHandle): Promise<SessionSummary> {
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const ctx = handle.accessor.get(ISessionContext);
    const workspace = handle.accessor.get(ISessionWorkspaceContext);
    return {
      id: meta.id,
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      workDir: ctx.cwd,
      sessionDir: ctx.sessionDir,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      metadata: meta.custom as JsonObject | undefined,
      additionalDirs: workspace.additionalDirs,
    };
  }

  /**
   * The `ResumedSessionSummary` of a just-materialized session, including the
   * per-agent snapshot v1 serves: the live slices are read from the restored
   * agent scope (profile / permission / swarm services and the klient agent
   * facade for context / plan / usage / background tasks), while `replay` and
   * `toolStore` are folded from the agent's `wire.jsonl` by
   * {@link foldAgentWireReplay} (v2 has no replay builder of its own).
   * `warning` stays undefined — v2's resume has no migration-warning channel.
   */
  private async resumedSessionSummary(
    handle: ISessionScopeHandle,
    replay?: { readonly includeSubagents?: boolean; readonly replayTurnLimit?: number },
  ): Promise<ResumedSessionSummary> {
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const agents: Record<string, ResumedAgentState> = {};
    // v1 resumes the main agent eagerly; materializing here cold-restores its
    // wire into the scope (create-or-get) and applies the default binding.
    const main = await this.materializeMainAgent(handle);
    agents[MAIN_AGENT_ID] = await this.resumedAgentState(
      handle,
      main,
      'main',
      replay?.replayTurnLimit,
    );
    if (replay?.includeSubagents === true) {
      const agentsDir = join(handle.accessor.get(ISessionContext).sessionDir, 'agents');
      let subagentIds: readonly string[] = [];
      try {
        subagentIds = (await readdir(agentsDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && entry.name !== MAIN_AGENT_ID)
          .map((entry) => entry.name);
      } catch {
        // No agents directory at all → the main agent is the whole roster.
      }
      for (const agentId of subagentIds) {
        try {
          // `create` is create-or-get and cold-restores the persisted wire.
          const agent = await handle.accessor.get(IAgentLifecycleService).create({ agentId });
          agents[agentId] = await this.resumedAgentState(
            handle,
            agent,
            'sub',
            replay.replayTurnLimit,
          );
        } catch {
          // Best-effort, same as v1: a subagent whose restore fails is left
          // out of the map (v1 logs a warning and continues with the rest).
        }
      }
    }
    return {
      ...(await this.liveSessionSummary(handle)),
      sessionMetadata: v2MetaToSessionMeta(meta),
      agents,
      warning: undefined,
    };
  }

  /**
   * One agent's v1 `ResumedAgentState`. The scope reads mirror v1's
   * `resumeSessionResult` field-by-field; the casts only bridge the two
   * packages' type declarations (the wire shapes are the documented-identical
   * ports, same as the `getContext` / `listBackgroundTasks` overrides). One
   * deliberate gap: `config.provider` is always undefined — v1 resolves the
   * full runtime `ProviderConfig` into the snapshot, agent-core-v2 has no
   * equivalent read, and the TUI only falls back to `provider?.model` when
   * `modelAlias` is unset (pinned in the parity KNOWN_DIFFS).
   */
  private async resumedAgentState(
    session: ISessionScopeHandle,
    agent: IAgentScopeHandle,
    type: 'main' | 'sub',
    replayTurnLimit?: number,
  ): Promise<ResumedAgentState> {
    const facade = this.klient.session(session.id).agent(agent.id);
    const ctx = session.accessor.get(ISessionContext);
    const [context, plan, usage, background, folded] = await Promise.all([
      facade.getContext(),
      facade.getPlan(),
      facade.getUsage(),
      facade.getTasks({ activeOnly: false }),
      foldAgentWireReplay(join(ctx.sessionDir, 'agents', agent.id, 'wire.jsonl')),
    ]);
    const profile = agent.accessor.get(IAgentProfileService).data();
    return {
      type,
      config: {
        cwd: ctx.cwd,
        provider: undefined,
        modelAlias: profile.modelAlias,
        modelCapabilities: profile.modelCapabilities,
        profileName: profile.profileName,
        thinkingEffort: profile.thinkingLevel,
        systemPrompt: profile.systemPrompt,
      },
      context: context as AgentContextData,
      replay: limitAgentReplayByTurns(folded.replay, replayTurnLimit),
      permission: {
        mode: agent.accessor.get(IAgentPermissionModeService).mode,
        rules: [...agent.accessor.get(IAgentPermissionRulesService).rules],
      } as ResumedAgentState['permission'],
      plan: plan as ResumedAgentState['plan'],
      swarmMode: agent.accessor.get(IAgentSwarmService).isActive,
      usage: usage as ResumedAgentState['usage'],
      tools: agent.accessor.get(IAgentRPCService).getTools({}) as ResumedAgentState['tools'],
      toolStore: folded.toolStore,
      background: background as readonly BackgroundTaskInfo[],
    };
  }

  /**
   * Every v2 workspace-id bucket addressing `workDir` (already normalized):
   * the registered workspace's alias set when the catalog knows the root, or
   * the freshly minted bucket key for index-only sessions (mirrors how v1's
   * store lists a bucket that never touched the workspace registry).
   */
  private async workspaceIdsFor(workDir: string): Promise<readonly string[]> {
    const workspaces = await this.klient.global.workspaces.list();
    const match = workspaces.find((workspace) => normalizeWorkDir(workspace.root) === workDir);
    if (match === undefined) return [encodeWorkDirKey(workDir)];
    return this.engineAccessor.get(IWorkspaceAliases).resolveAliasIds(match.id);
  }

  override async listSessions(input: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    // v1 rejects an empty workDir and bucket-filters by the normalized path;
    // the v2 index filters by workspace-id set instead.
    const workspaceIds =
      input.workDir === undefined
        ? undefined
        : await this.workspaceIdsFor(normalizeRequiredWorkDir('listSessions', input.workDir));
    const page = await this.klient.global.sessions.list({
      workspaceIds,
      sessionId: input.sessionId,
    });
    const bootstrapService = this.engineAccessor.get(IBootstrapService);
    const workspacesById = new Map(
      (await this.klient.global.workspaces.list()).map((workspace) => [workspace.id, workspace]),
    );
    const summaries: SessionSummary[] = [];
    for (const item of page.items) {
      const workDir = item.cwd ?? workspacesById.get(item.workspaceId)?.root;
      // A session whose workDir is unrecoverable (corrupt metadata, deleted
      // workspace) cannot be resumed on either engine; v1's store never lists
      // one in the first place, so drop it here too.
      if (workDir === undefined) continue;
      summaries.push(
        v2SummaryToSessionSummary(item, {
          workDir,
          sessionDir: sessionDirOf(
            bootstrapService.homeDir,
            workspacePersistenceScope(bootstrapService.scope('sessions'), item.workspaceId),
            item.id,
          ),
        }),
      );
    }
    return summaries;
  }

  /**
   * v1 semantics: register the workDir as a workspace and create the session
   * (the handler's `ISessionLifecycleService.create` does both; the klient facade
   * wrapper is bypassed because it takes neither an explicit session id nor
   * caller metadata). The `model` / `thinking` / `permission` options are the
   * main-agent configuration v1 applies eagerly at creation: supplying any of
   * them materializes the main agent here (v2 otherwise keeps it lazy) and
   * binds the default profile with the requested model/thinking. v1 never
   * validates either at create time — an unknown alias is recorded verbatim
   * and an unlisted effort normalizes to the model default — so the bind is
   * deliberately NOT `strictThinking`, and the v2-only create-time rejections
   * that still leak through (unknown alias → `config.invalid`, no configured
   * default model → `model.not_configured`) are pinned in the parity tests.
   */
  override async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    const workDir = normalizeRequiredWorkDir('createSession', input.workDir);
    if (input.id !== undefined) {
      const existing =
        this.liveSession(input.id) ??
        (await this.engineAccessor.get(ISessionIndex).get(input.id));
      if (existing !== undefined) {
        throw new KimiError(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${input.id}" already exists`,
        );
      }
    }
    const handler = await this.engineAccessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ root: workDir });
    const handle = await handler.accessor.get(ISessionLifecycleService).create({
      sessionId: input.id,
      workDir,
      additionalDirs: input.additionalDirs,
    });
    // Wired before the optional main-agent materialization so a profile-bind
    // warning (oversized AGENTS.md) reaches the listeners like v1's create.
    this.wireSession(handle);
    if (
      input.model !== undefined ||
      input.thinking !== undefined ||
      input.permission !== undefined
    ) {
      const agent = await this.materializeMainAgent(handle, {
        model: input.model,
        thinking: input.thinking,
      });
      if (input.permission !== undefined) {
        agent.accessor.get(IAgentPermissionModeService).setMode(input.permission);
      }
    }
    if (input.metadata !== undefined) {
      await this.klient.session(handle.id).update({ custom: { ...input.metadata } });
    }
    // v1 returns the caller's metadata verbatim on create (not the merged
    // custom map a later listing would report), so override it here too.
    return { ...(await this.liveSessionSummary(handle)), metadata: input.metadata };
  }

  /**
   * v1 renames through the live session when there is one and at the store
   * level otherwise. The v2 metadata service is session-scoped (and the
   * klient session facade 404s on a non-live session), so a closed session is
   * resumed, renamed, and closed again to land in the same state. The v2
   * `setTitle` does no validation, so v1's trim + empty-title rejection lives
   * here.
   */
  override async renameSession(input: RenameSessionInput): Promise<void> {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    if (this.liveSession(input.id) !== undefined) {
      await this.klient.session(input.id).setTitle(title);
      return;
    }
    const handle = await resumeSessionById(this.engineAccessor, input.id);
    if (handle === undefined) throw SDKRpcClientV2.sessionNotFound(input.id);
    try {
      await this.klient.session(input.id).setTitle(title);
    } finally {
      await closeSessionById(this.engineAccessor, input.id);
    }
  }

  /**
   * Through `engineAccessor` (the handler chain's `ISessionLifecycleService.fork`) because the
   * klient facade fork takes no explicit target id. Known gaps vs v1: the
   * engine's fork is unconditional — it never rejects an in-flight source
   * turn (v1's SESSION_FORK_ACTIVE_TURN) — and `turnIndex` truncation has no
   * v2 counterpart at all, so it fails loudly. The default title also differs
   * by design (v1: "New Session", v2: "Fork: <source>") — pass an explicit
   * title for identical results.
   */
  override async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    if (input.turnIndex !== undefined) {
      throw new KimiError(
        ErrorCodes.NOT_IMPLEMENTED,
        'forkSession turnIndex truncation is not wired to agent-core-v2 yet.',
      );
    }
    const forkHandler = await handlerForSession(this.engineAccessor, input.id);
    if (forkHandler === undefined) throw SDKRpcClientV2.sessionNotFound(input.id);
    const handle = await forkHandler.accessor.get(ISessionLifecycleService).fork({
      sourceSessionId: input.id,
      newSessionId: input.forkId,
      title: input.title,
      metadata: input.metadata,
    });
    this.wireSession(handle);
    return this.resumedSessionSummary(handle);
  }

  override async closeSession(input: SessionIdRpcInput): Promise<void> {
    // v1's print-steer counters die with the Session object; drop ours too.
    this.printSteerStates.delete(input.sessionId);
    await this.klient.session(input.sessionId).close();
  }

  /**
   * Materializes the session through `engineAccessor`
   * (`resumeSessionById` through the handler chain; the facade only offers `restore`,
   * which would also clear the archived flag — v1's resume does not).
   * `includeSubagents` / `replayTurnLimit` shape the returned per-agent
   * snapshot exactly like v1: subagent states are folded best-effort from
   * each persisted agent wire, and every agent's replay is trimmed to the
   * most recent N user turns via the shared `limitAgentReplayByTurns`.
   */
  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    // v1 re-resolves caller-provided additional dirs on every resume and
    // merges them over the workspace-local set; the engine's resume options
    // union them into the handler's shared in-memory set while the session
    // scope is materialized. Unlike v1, the v2
    // engine has no caller `mcpServers` channel on create/resume (caller
    // servers are an ACP-side concern to be designed separately).
    const handle = await resumeSessionById(this.engineAccessor, input.id, {
      additionalDirs: input.additionalDirs,
    });
    if (handle === undefined) throw SDKRpcClientV2.sessionNotFound(input.id);
    this.wireSession(handle);
    return this.resumedSessionSummary(handle, {
      includeSubagents: input.includeSubagents,
      replayTurnLimit: input.replayTurnLimit,
    });
  }

  /**
   * v1's reload: refuse while a turn runs, re-read config + plugins, close
   * the live session, resume from disk. The v2 busy check reads each live
   * agent's activity view (turn lane only — background tasks do not block,
   * matching v1's `hasActiveTurn`). `forcePluginSessionStartReminder` has no
   * v2 channel (the engine owns plugin session-start injection) and is
   * ignored.
   */
  override async reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary> {
    const sessionId = input.sessionId;
    const live = this.liveSession(sessionId);
    if (live !== undefined) {
      for (const agent of live.accessor.get(IAgentLifecycleService).list()) {
        if (agent.accessor.get(IAgentActivityView).state().turn !== undefined) {
          throw new KimiError(
            ErrorCodes.TURN_AGENT_BUSY,
            `Session "${sessionId}" cannot be reloaded while a turn is running`,
            { details: { sessionId } },
          );
        }
      }
    } else if ((await this.engineAccessor.get(ISessionIndex).get(sessionId)) === undefined) {
      throw SDKRpcClientV2.sessionNotFound(sessionId);
    }
    await this.configReady;
    await this.klient.global.config.reload();
    await this.klient.global.plugins.reload();
    if (live !== undefined) {
      await closeSessionById(this.engineAccessor, sessionId);
    }
    // Same print-steer reset as closeSession: v1's reload rebuilds the
    // Session, and with it the counters.
    this.printSteerStates.delete(sessionId);
    const handle = await resumeSessionById(this.engineAccessor, sessionId);
    if (handle === undefined) throw SDKRpcClientV2.sessionNotFound(sessionId);
    this.wireSession(handle);
    return this.resumedSessionSummary(handle);
  }

  /**
   * The base-class contract merges the patch into the session's `custom` map
   * (v1 routes through the live session and 404s on a closed one; mirrored
   * here by {@link requireLiveSession}).
   */
  override async updateSessionMetadata(input: UpdateSessionMetadataRpcInput): Promise<void> {
    this.requireLiveSession(input.sessionId);
    const current = await this.klient.session(input.sessionId).get();
    const custom = { ...current.custom, ...input.metadata };
    await this.klient.session(input.sessionId).update({ custom });
  }

  /**
   * Through the session's handler (`IWorkspaceDirs`, workspace scope) — the
   * workspace-level add-dir surface: `persist: true` (default) appends to the
   * project-local `.kimi-code/local.toml`, `persist: false` joins the
   * handler's shared in-memory set. The set is shared by every session of
   * the workspace (a v1 `persist: false` dir was session-scoped and written
   * into session metadata to survive a resume; the v2 handler keeps it for
   * every session of the workspace until the process exits). Returns the
   * same `{additionalDirs, projectRoot, configPath, persisted}` shape as v1.
   */
  override async addAdditionalDir(input: AddAdditionalDirInput): Promise<AddAdditionalDirResult> {
    const handle = this.requireLiveSession(input.id);
    return handle.accessor
      .get(IWorkspaceDirs)
      .addDir({ path: input.path, persist: input.persist });
  }

  /**
   * Through `engineAccessor` (`ISessionExportService`, app scope) — the v2
   * port of v1's export: same payload fields, same zip writer layout, same
   * live-session flush before the read, and the same
   * `SESSION_EXPORT_NOT_FOUND` for a session without an exportable directory.
   * Works on closed sessions on both engines (v1 reads the store, v2 the
   * index). Gaps, pinned in the migration tracker: v2 additionally validates
   * the host `version` (`SESSION_EXPORT_MISSING_VERSION` on blank — v1
   * records it unchecked), the manifest's activity timestamps come from v2's
   * per-agent wire scan (v1 scans only the root `wire.jsonl`), and the
   * manifest carries v2's extra `webLogPath` field (absent unless the host
   * passes a web log, which this client never does). The zip ENTRY LIST is
   * not part of the parity surface: the two engines lay their session
   * directories out differently by design.
   */
  override async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    return this.engineAccessor.get(ISessionExportService).export({
      sessionId: input.id,
      outputPath: input.outputPath,
      includeGlobalLog: input.includeGlobalLog,
      version: input.version,
      installSource: input.installSource,
      shellEnv: input.shellEnv,
    });
  }

  /**
   * Through the session scope (`ISessionSkillCatalog`) — no klient facade
   * exists. Same merged view v1's `Session.listSkills` serves (builtin +
   * user + project + plugin skills through the same `summarizeSkill`
   * mapping), with the same snapshot-vs-live caveat as `listPluginCommands`:
   * v1 loads the registry once at session creation while the v2 catalog
   * re-merges on source changes mid-session; the two agree for any session
   * created after the last skill change.
   */
  override async listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]> {
    const catalog = this.requireLiveSession(input.sessionId).accessor.get(ISessionSkillCatalog);
    await catalog.ready;
    return catalog.catalog.listSkills().map(summarizeSkill);
  }

  // -----------------------------------------------------------------------
  // Agent interaction
  //
  // v1 serves these from the session's eagerly-created main agent, already
  // configured with the model/thinking defaults. The v2 engine splits them
  // across the klient agent facade (model / permission / plan / context /
  // usage / cancel — validated contract calls) and agent-scope services the
  // facade does not cover (thinking, compaction, undo, context mutation),
  // reached through the live session handle. Every override requires a live
  // session (v1's `requireSession`) and resolves the target agent from
  // `interactiveAgentId`: the main agent materializes on first use with the
  // default profile bound (v1's eager equivalent); any other agent must
  // already exist (v1's `AGENT_NOT_FOUND`).
  // -----------------------------------------------------------------------

  /**
   * The session's materialized main agent with v1's eager default binding
   * applied: a freshly created agent whose profile is still unbound gets the
   * default profile + configured default model (the same bind kap-server's
   * prompt route performs on first use). A home with no configured model
   * leaves the agent unbound instead of failing — v1's model-less session
   * reads (`model: undefined`, `'off'` thinking, zero capabilities) map onto
   * the unbound state exactly.
   */
  private async materializeMainAgent(
    session: ISessionScopeHandle,
    binding?: { readonly model?: string; readonly thinking?: string },
  ): Promise<IAgentScopeHandle> {
    await this.modelReady;
    const agent = await ensureMainAgent(session);
    const profile = agent.accessor.get(IAgentProfileService);
    if (binding !== undefined || profile.data().profileName === undefined) {
      try {
        await profile.bind({
          profile: DEFAULT_AGENT_PROFILE_NAME,
          model: binding?.model,
          thinking: binding?.thinking,
        });
      } catch (error) {
        if (
          binding === undefined &&
          error instanceof ProfileError &&
          error.code === ProfileErrors.codes.MODEL_NOT_CONFIGURED
        ) {
          return agent;
        }
        throw error;
      }
    }
    return agent;
  }

  /** The target agent's live scope handle (see the section header). */
  private async agentScope(sessionId: string): Promise<IAgentScopeHandle> {
    const session = this.requireLiveSession(sessionId);
    const agentId = this.interactiveAgentId;
    if (agentId === MAIN_AGENT_ID) return this.materializeMainAgent(session);
    const agent = session.accessor.get(IAgentLifecycleService).get(agentId);
    if (agent === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" was not found`);
    }
    return agent;
  }

  /**
   * The klient agent facade for the target agent. The scope is resolved
   * first so the main agent exists and carries its default binding before
   * the facade call crosses the channel (the channel's own materialization
   * leaves the profile unbound).
   */
  private async agentFacade(sessionId: string): Promise<AgentHandle> {
    await this.agentScope(sessionId);
    return this.klient.session(sessionId).agent(this.interactiveAgentId);
  }

  /**
   * Facade (`agentProfileService.setModel`). Both engines resolve the alias
   * up front, report the resolved provider name, and reject an unknown alias
   * with `config.invalid` (only the trailing message wording differs).
   */
  override async setModel(input: SetSessionModelRpcInput): Promise<SetSessionModelRpcResult> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.setModel(input.model);
  }

  /**
   * Through the agent scope (`IAgentProfileService.setThinking`) — no klient
   * facade exists. Same registry-driven strictness as v1's
   * `setThinkingEffort`: an unlisted effort on a strict-thinking model
   * rejects with `model.config_invalid` and the same message on both
   * engines; anything else normalizes through the same resolution.
   */
  override async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    agent.accessor.get(IAgentProfileService).setThinking(input.effort);
  }

  /**
   * v1 reloads the core config and pushes the resolved snapshot into the
   * session: the spawn binding, the tool descriptions, and the cached
   * startup warning all read that snapshot. The v2 engine resolves the
   * secondary model live against `IConfigService` at spawn time
   * (`resolveSubagentBinding`) and rebuilds the tool description on every
   * read, so the preceding `setConfig` write already took effect
   * session-wide — what remains of v1's contract is the reload (the recipe
   * may have been persisted through another channel), the same loud
   * validations, and the warning-cache refresh. The recipe read is NOT
   * flag-gated, mirroring v1's `setSecondaryModelConfig` (the experiment
   * gate lives at the spawn binding on both engines).
   */
  override async applyPersistedSecondaryModel(input: SessionIdRpcInput): Promise<void> {
    const session = this.requireLiveSession(input.sessionId);
    await this.klient.global.config.reload();
    await this.configReady;
    await this.modelReady;
    const secondary = this.engineAccessor
      .get(IConfigService)
      .get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
    if (secondary?.model === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        'Cannot set the secondary model: persist its recipe before applying it to a session.',
      );
    }
    try {
      this.engineAccessor.get(IModelCatalog).get(secondary.model);
    } catch (error) {
      throw wrapSubagentModelError(error, secondary.model, undefined);
    }
    session.accessor
      .get(ISessionSecondaryModelWarningService)
      .recheckSecondaryModelWarning();
  }

  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.setPermission(input.mode);
  }

  /** v1 maps the toggle onto two RPCs (`enterPlan` / `cancelPlan`); so does v2. */
  override async setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    if (!input.enabled) return agent.cancelPlan();
    return agent.enterPlan();
  }

  override async getPlan(input: SessionIdRpcInput): Promise<SessionPlan> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getPlan();
  }

  override async clearPlan(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.clearPlan();
  }

  /**
   * Facade (`agentRPCService.getContext`). The v2 `AgentContextData` is the
   * same wire shape as v1's — the cast only bridges the two packages' type
   * declarations (v2's origin union carries kinds a v1 client never sees in
   * practice); the data itself crossed the same JSON boundary on both sides.
   * Token-count semantics differ by design: v1 reports the running estimate,
   * v2 the provider-measured prefix (`0` until the first LLM round) — pinned
   * in the parity KNOWN_DIFFS.
   */
  override async getContext(input: SessionIdRpcInput): Promise<AgentContextData> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getContext() as Promise<AgentContextData>;
  }

  override async getUsage(input: SessionIdRpcInput): Promise<SessionUsage> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getUsage();
  }

  /**
   * The base class aggregates v1's per-agent `getConfig` / `getContext` /
   * `getPermission` / `getPlan` / `getSwarmMode` / `getUsage` RPCs. The v2
   * rebuild reads the same six slices: the profile's bound model alias and
   * resolved thinking level + capabilities (v1's agent `getConfig` — its
   * `provider?.model` fallback is unreachable without an alias), the
   * facade's context/plan/usage, and the permission-mode and swarm services.
   */
  override async getStatus(input: SessionIdRpcInput): Promise<SessionStatus> {
    const agent = await this.agentScope(input.sessionId);
    const facade = this.klient.session(input.sessionId).agent(this.interactiveAgentId);
    const [context, plan, usage] = await Promise.all([
      facade.getContext(),
      facade.getPlan(),
      facade.getUsage(),
    ]);
    const profile = agent.accessor.get(IAgentProfileService).data();
    const capability = profile.modelCapabilities;
    const maxContextTokens = capability.max_input_tokens ?? capability.max_context_tokens;
    const contextTokens = context.tokenCount;
    // Deliberately unclamped, same as the base class (>100% is the documented
    // overflow signal on this path).
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;
    const hasUsage =
      usage.byModel !== undefined || usage.total !== undefined || usage.currentTurn !== undefined;
    return {
      model: profile.modelAlias,
      thinkingEffort: profile.thinkingLevel,
      permission: agent.accessor.get(IAgentPermissionModeService).mode,
      planMode: plan !== null,
      swarmMode: agent.accessor.get(IAgentSwarmService).isActive,
      contextTokens,
      maxContextTokens,
      contextUsage,
      usage: hasUsage ? usage : undefined,
    };
  }

  override async cancel(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.cancel();
  }

  /**
   * Through the agent scope (`IAgentFullCompactionService.begin`) — no klient
   * facade exists. Same semantics as v1's `beginCompaction`: a manual
   * compaction launches the summarizer immediately in the background, is a
   * silent no-op while one is already running, and rejects with
   * `compaction.unable` on an empty history or an active turn.
   */
  override async compact(input: SessionIdRpcInput & CompactOptions): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    agent.accessor.get(IAgentFullCompactionService).begin({
      source: 'manual',
      instruction: input.instruction,
    });
  }

  /**
   * Through the agent scope (`IAgentRPCService.cancelCompaction`, the v2 RPC
   * surface's own cancel) — no klient facade exists. Aborts the in-flight
   * compaction; a no-op when idle, like v1.
   */
  override async cancelCompaction(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    await agent.accessor.get(IAgentRPCService).cancelCompaction({});
  }

  /**
   * Through the agent scope (`IAgentRPCService.undoHistory`, the v2 RPC
   * surface's own undo) — no klient facade exists; the returned count is
   * dropped (v1 returns void). Failure semantics differ by design: v2
   * prechecks and rejects atomically with `session.undo_unavailable`, while
   * v1 splices a partial suffix out of the live history and then throws
   * `request.invalid` — pinned in the parity KNOWN_DIFFS.
   */
  override async undoHistory(input: SessionIdRpcInput & { count: number }): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    await agent.accessor.get(IAgentRPCService).undoHistory({ count: input.count });
  }

  /**
   * Through the agent scope (`IAgentContextMemoryService.clear`) — no klient
   * facade exists. v1's `context.clear` has no busy check and does not touch
   * queued or running prompts; the memory-service clear matches that exactly
   * (the prompt service's own `clear` would additionally abort prompts).
   */
  override async clearContext(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    agent.accessor.get(IAgentContextMemoryService).clear();
  }

  /**
   * No v2 engine capability exists for import-context (nothing under
   * agent-core-v2 builds this message), so the SDK composes v1's exact
   * behavior over v2 primitives: the same busy rejection
   * (`turn.agent_busy`), the byte-identical import message and validations
   * (`src/v2/import-context.ts`), the same overflow gate, then the same wire
   * `context.append_message` Op v1 persists. Known gap: v1 also adopts the
   * post-import estimate as its reported token count, while v2's reported
   * count is provider-measured and has no public setter — post-import
   * `getContext().tokenCount` diverges (pinned in the parity KNOWN_DIFFS).
   */
  override async importContext(input: ImportContextRpcInput): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    if (
      agent.accessor.get(IAgentLoopService).status().state === 'running' ||
      agent.accessor.get(IAgentFullCompactionService).compacting !== null
    ) {
      throw new KimiError(
        ErrorCodes.TURN_AGENT_BUSY,
        'Cannot import context while the agent is busy',
      );
    }
    const message = buildImportContextMessage(input.content, input.source);
    const capability = agent.accessor.get(IAgentProfileService).data().modelCapabilities;
    const currentTokenCount = agent.accessor.get(IAgentTokenCountingService).get().size;
    assertImportFits(
      message,
      currentTokenCount,
      capability.max_input_tokens ?? capability.max_context_tokens,
    );
    agent.accessor.get(IAgentContextMemoryService).append(message);
  }

  /**
   * Facade (`agentRPCService.prompt`). The launch result (`{turn_id}`, or
   * `undefined` when the prompt queued behind a running turn) is dropped —
   * v1's RPC returns void. The pre-provider surface matches v1: the metadata
   * update (title/lastPrompt) runs through the same shared helpers before the
   * turn launches, and a model-less turn fails asynchronously exactly like
   * v1's. Two enqueue-semantics gaps vs v1, pinned in the migration tracker:
   * v1 drops a prompt submitted while a turn is active (error event only)
   * where v2 queues it FIFO, and v1 never consumes `disabledTools` (the
   * payload field reaches the agent RPC but no code reads it) where v2
   * applies it as the session tool denylist.
   */
  override async prompt(input: SessionPromptRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.prompt({ input: input.input, disabledTools: input.disabledTools });
  }

  /**
   * Facade (`agentRPCService.steer`). Mid-turn steers match v1 (the input
   * joins the running turn). The idle-session case diverges by design and is
   * pinned in the parity tests: v1 launches a fresh turn off a steer and
   * updates title/lastPrompt like a prompt; v2's enqueue launches the turn
   * first, so the follow-up `steer()` finds nothing pending and rejects with
   * `prompt.not_found` — and the v2 RPC path never touches the metadata.
   */
  override async steer(input: SessionPromptRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await agent.steer({ input: input.input });
  }

  /**
   * Facade (`agentShellCommandService.run`) — the same builtin-Bash execution
   * and `shell_command`-origin history records as v1, with an identical
   * `{stdout, stderr, isError?, backgrounded?}` result shape. The `commandId`
   * event stream (`shell.output` / `shell.started` / `shell.completed`) is
   * engine-side on both; translating it into SDK events is the event batch's
   * job, not this one's. Model-less gap, not pinned: v1's builtin tools only
   * exist on a profiled agent, so a model-less v1 session answers "Bash tool
   * is not available." where v2 runs the command.
   */
  override async runShellCommand(input: {
    sessionId: string;
    command: string;
    commandId?: string;
  }): Promise<{ stdout: string; stderr: string; isError?: boolean; backgrounded?: boolean }> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.runShellCommand({ command: input.command, commandId: input.commandId });
  }

  /** Facade (`agentShellCommandService.cancel`) — an unknown id is a silent no-op on both engines. */
  override async cancelShellCommand(input: {
    sessionId: string;
    commandId: string;
  }): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.cancelShellCommand({ commandId: input.commandId });
  }

  /**
   * Through the agent scope (`IAgentSkillService.activate`) — deliberately
   * NOT `IAgentRPCService.activateSkill`, whose `void this.skills.activate(...)`
   * fire-and-forget turns v1's synchronous rejections (`skill.not_found` /
   * `skill.type_unsupported`) into unhandled rejections. The direct call keeps
   * v1's semantics: validate first, then render the skill prompt and launch a
   * turn with it. v1's session layer then updates title/lastPrompt for the
   * MAIN agent only; replicated here over the engine's shared metadata
   * helpers. Busy-turn gap vs v1, pinned in the migration tracker: v1 drops
   * the activation into an error event while a turn runs; v2's activate
   * awaits the queued prompt's launch.
   */
  override async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    await agent.accessor.get(IAgentSkillService).activate({ name: input.name, args: input.args });
    if (this.interactiveAgentId === MAIN_AGENT_ID) {
      await this.updatePromptMetadata(input.sessionId, promptMetadataTextFromSkill(input));
    }
  }

  /**
   * Through the agent scope (`IAgentRPCService.activatePluginCommand`) — the
   * v2 RPC surface's own implementation: the same `request.invalid` rejection
   * text for an unknown command, the same argument expansion, the activation
   * event, the prompt enqueue, and the metadata update. Two gaps vs v1,
   * pinned in the migration tracker: v1 resolves the command against the
   * session's creation-time snapshot (v2 uses the app-global live view), and
   * v1 drops the activation while a turn runs where v2 queues it. v1 also
   * updates title/lastPrompt for the main agent only, where the v2 RPC does
   * it unconditionally — only observable through a non-main
   * `interactiveAgentId`.
   */
  override async activatePluginCommand(input: ActivatePluginCommandRpcInput): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    await agent.accessor.get(IAgentRPCService).activatePluginCommand({
      pluginId: input.pluginId,
      commandName: input.commandName,
      args: input.args,
    });
  }

  /**
   * Through the session scope (`ISessionInitService.generateAgentsMd`, the
   * engine's port of v1's `Session.generateAgentsMd`) — a session-level
   * operation pinned to the main agent on both engines, so
   * `interactiveAgentId` does not apply; the main agent is materialized first
   * (v1 creates it eagerly at createSession). The success path is a real
   * subagent LLM round (`/init` brief), so parity covers only the model-less
   * rejection: both engines fail with `session.init_failed`, with different
   * messages (v1 wraps the provider-resolution failure, v2 preflights the
   * missing binding) — pinned in the parity tests.
   */
  override async generateAgentsMd(input: SessionIdRpcInput): Promise<void> {
    const session = this.requireLiveSession(input.sessionId);
    await this.materializeMainAgent(session);
    await session.accessor.get(ISessionInitService).generateAgentsMd();
  }

  /**
   * No v2 service implements the session-warnings aggregate (`ISessionRPCService`
   * is an interface without an implementation), so the SDK rebuilds v1's
   * `Session.getSessionWarnings` over v2 primitives: the profile's cached
   * `agentsMdWarning` (computed on every bind, v1's bootstrap-time cache),
   * recomputed through the engine's own `prepareSystemPromptContext` when the
   * cache is empty — v1 recomputes on demand whenever no warning is cached,
   * so an AGENTS.md that outgrows the budget mid-session surfaces on both
   * engines. The single warning shape (`agents-md-oversized`, severity
   * `warning`) mirrors v1's assembly. The secondary-model half comes from the
   * session scope's `ISessionSecondaryModelWarningService` (v1's
   * `computeSecondaryModelWarnings`): v1 computes it from the session's
   * config snapshot while v2 caches the live-config check at main-agent
   * creation, so the two agree on recipes applied through
   * `applyPersistedSecondaryModel` (which refreshes the v2 cache) and on
   * recipes present at session creation; a recipe persisted but never
   * applied surfaces only on v2 (live config vs v1's snapshot).
   */
  override async getSessionWarnings(input: SessionIdRpcInput) {
    const agent = await this.agentScope(input.sessionId);
    let warning = agent.accessor.get(IAgentProfileService).getAgentsMdWarning();
    if (warning === undefined) {
      const session = this.requireLiveSession(input.sessionId);
      const prepared = await prepareSystemPromptContext(
        {
          fs: this.engineAccessor.get(IHostFileSystem),
          homeDir: this.engineAccessor.get(IHostEnvironment).homeDir,
        },
        session.accessor.get(ISessionContext).cwd,
        this.engineAccessor.get(IBootstrapService).homeDir,
        { additionalDirs: session.accessor.get(ISessionWorkspaceContext).additionalDirs },
      );
      warning = prepared.agentsMdWarning;
    }
    const warnings: { code: string; message: string; severity: 'warning' }[] =
      warning === undefined
        ? []
        : [{ code: 'agents-md-oversized', message: warning, severity: 'warning' as const }];
    const secondary = this.requireLiveSession(input.sessionId)
      .accessor.get(ISessionSecondaryModelWarningService)
      .getSecondaryModelWarning();
    if (secondary !== undefined) {
      warnings.push({ code: secondary.code, message: secondary.message, severity: 'warning' });
    }
    return warnings;
  }

  /**
   * v1's session-layer prompt-metadata update (title/lastPrompt), rebuilt
   * over the engine's shared helper so skill/plugin-command activations land
   * on the same metadata the native v2 prompt path writes.
   */
  private async updatePromptMetadata(sessionId: string, text: string | undefined): Promise<void> {
    const session = this.requireLiveSession(sessionId);
    await applyPromptMetadataUpdate(
      {
        metadata: session.accessor.get(ISessionMetadata),
        eventService: this.engineAccessor.get(IEventService),
        sessionId,
      },
      text,
    );
  }

  /**
   * Through the session scope (`ISessionBtwService`) — no klient facade
   * exists. The v2 service is the port of v1's btw fork: same inherited
   * profile/context, same byte-identical side-question reminder, same
   * tool-call deny, and the same return (the forked child's agent id). The
   * main agent is materialized first — both engines fork it as the source,
   * and v2's `fork('main')` throws on a missing source. Gaps, pinned in the
   * migration tracker: v2 always forks MAIN where v1 forks the agent
   * `interactiveAgentId` addresses (SDK hosts only ever btw the main agent),
   * and the v2 child is a regular persisted agent where v1's is memory-only
   * (`InMemoryAgentRecordPersistence`, no metadata).
   */
  override async startBtw(input: SessionIdRpcInput): Promise<string> {
    const session = this.requireLiveSession(input.sessionId);
    await this.materializeMainAgent(session);
    return session.accessor.get(ISessionBtwService).start();
  }

  /**
   * Through the agent scope (`IAgentSwarmService.enter` / `.exit`) — no
   * klient facade exists. The v2 service is the port of v1's `SwarmMode`:
   * enter is idempotent and injects the byte-identical enter reminder for
   * non-`tool` triggers, exit pops that reminder when it is the last message
   * (appending the exit reminder otherwise), and `task` / `tool` triggers
   * auto-exit on turn end. The base class's private enter/exit pair is
   * replaced wholesale; `swarm()` below recomposes it over this override.
   */
  override async setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    const swarm = agent.accessor.get(IAgentSwarmService);
    if (input.enabled) {
      swarm.enter(input.trigger);
      return;
    }
    swarm.exit();
  }

  /** v1's `swarm()` composition: enter with the one-shot `task` trigger, then prompt. */
  override async swarm(input: SessionPromptRpcInput): Promise<void> {
    await this.setSwarmMode({ sessionId: input.sessionId, enabled: true, trigger: 'task' });
    return this.prompt(input);
  }

  // -----------------------------------------------------------------------
  // Goal / cron / background tasks / print policy
  //
  // The goal service is the v2 port of v1's `GoalMode` (same state machine,
  // same validations, same error codes), so the goal overrides are thin
  // forwards through the agent scope. Cron and the task manager moved from
  // per-agent (v1) to session/agent-scope services with field-identical
  // wire shapes; the two print-policy methods have no v2 service at all
  // (the native v2 print runner re-implements the same policy inline), so
  // they are rebuilt here over the engine's config helpers and the session's
  // per-agent task services.
  // -----------------------------------------------------------------------

  /**
   * Through the agent scope (`IAgentGoalService.createGoal`) — no klient
   * facade exists for the goal domain. Gap: v2 rejects every goal command on
   * a non-main agent (`goal.unsupported_agent`) where v1 keeps a `GoalMode`
   * on every agent; only reachable through a non-main `interactiveAgentId`
   * (tracked in the migration tracker).
   */
  override async createGoal(input: SessionIdRpcInput & CreateGoalInput): Promise<GoalSnapshot> {
    const agent = await this.agentScope(input.sessionId);
    return agent.accessor
      .get(IAgentGoalService)
      .createGoal({ objective: input.objective, replace: input.replace });
  }

  override async getGoal(input: SessionIdRpcInput): Promise<GoalToolResult> {
    const agent = await this.agentScope(input.sessionId);
    return agent.accessor.get(IAgentGoalService).getGoal();
  }

  override async pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentScope(input.sessionId);
    return agent.accessor.get(IAgentGoalService).pauseGoal();
  }

  override async resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentScope(input.sessionId);
    return agent.accessor.get(IAgentGoalService).resumeGoal();
  }

  override async cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentScope(input.sessionId);
    return agent.accessor.get(IAgentGoalService).cancelGoal();
  }

  /**
   * Through the session scope (`ISessionCronService`) — no klient facade
   * exists for cron. v1's cron manager is per-agent: the main agent's
   * manager is what the v2 session-level service ports (it borrows the main
   * agent to steer fires), and a v1 subagent reports `[]` (`cron` is null) —
   * mirrored here for a non-main `interactiveAgentId`. The v1 snapshot shape
   * is restored field-by-field: `recurring` defaults to true, and the
   * post-jitter `nextFireAt` comes from the same scheduler read v1's
   * `listTaskSnapshots` forwards to.
   */
  override async getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult> {
    await this.agentScope(input.sessionId);
    if (this.interactiveAgentId !== MAIN_AGENT_ID) return { tasks: [] };
    const cron = this.requireLiveSession(input.sessionId).accessor.get(ISessionCronService);
    return {
      tasks: cron.list().map((task) => ({
        id: task.id,
        cron: task.cron,
        recurring: task.recurring !== false,
        createdAt: task.createdAt,
        lastFiredAt: task.lastFiredAt,
        nextFireAt: cron.getNextFireForTask(task.id),
      })),
    };
  }

  /**
   * Facade (`agentTaskService.list`). The v2 `AgentTaskInfo` union is the
   * same wire shape as v1's `BackgroundTaskInfo` — the process / agent /
   * question kinds are field-identical ports — so the cast only bridges the
   * two packages' type declarations. One content gap, pinned in the parity
   * KNOWN_DIFFS: after a detach, v2 rewrites the reported `timeoutMs` to the
   * detach deadline where v1 keeps the foreground one.
   */
  override async listBackgroundTasks(
    input: SessionIdRpcInput & { activeOnly?: boolean; limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getTasks({ activeOnly: input.activeOnly, limit: input.limit }) as Promise<
      readonly BackgroundTaskInfo[]
    >;
  }

  /**
   * Facade (`agentTaskService.readOutput`) — same unknown-id-returns-`''`
   * behavior and the same trailing-characters `tail` semantics as v1.
   */
  override async getBackgroundTaskOutput(
    input: SessionIdRpcInput & { taskId: string; tail?: number },
  ): Promise<string> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getTaskOutput({ taskId: input.taskId, tail: input.tail });
  }

  /**
   * Through the agent scope (`IAgentTaskService.stop`) — deliberately NOT the
   * facade's `stopTask`, whose no-reason path routes to `stopByUser` and
   * stamps a user-cancellation `stopReason` where v1's
   * `background.stop(taskId, reason)` records none. The direct call matches
   * v1 in both shapes (reason trimmed, blank → undefined). Timing gap: v1
   * fire-and-forgets the stop so its RPC returns before the kill settles;
   * the v2 service awaits the termination — a strictly stronger guarantee.
   */
  override async stopBackgroundTask(
    input: SessionIdRpcInput & { taskId: string; reason?: string },
  ): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    await agent.accessor.get(IAgentTaskService).stop(input.taskId, input.reason);
  }

  /**
   * Through the agent scope (`IAgentTaskService.detach`) — no klient facade
   * exists. Same semantics as v1's `background.detach`: releases the
   * foreground tool-call waiter, returns the live info (or the ghost / live
   * info for an already-terminal task, `undefined` for an unknown id).
   */
  override async detachBackgroundTask(
    input: SessionIdRpcInput & { taskId: string },
  ): Promise<BackgroundTaskInfo | undefined> {
    const agent = await this.agentScope(input.sessionId);
    return agent.accessor.get(IAgentTaskService).detach(input.taskId) as
      | BackgroundTaskInfo
      | undefined;
  }

  /**
   * v1's `Session.waitForBackgroundTasksOnPrint`, rebuilt over v2 primitives
   * — no v2 service owns the print policy (the native v2 print runner
   * re-implements the same drain inline in run-v2-print). Same gate (drain
   * mode only), same ceiling, same suppress + wait + re-enumerate loop over
   * every live agent's task service. Config timing note: v1 reads the
   * `background` section captured at session creation; v2 resolves the live
   * config (the `[task]` section layered over `[background]`) — identical
   * unless the config changes mid-session.
   */
  override async waitForBackgroundTasksOnPrint(input: SessionIdRpcInput): Promise<void> {
    const session = this.requireLiveSession(input.sessionId);
    await this.configReady;
    const config = this.engineAccessor.get(IConfigService);
    if (resolvePrintBackgroundMode(config) !== 'drain') return;
    const ceilingS =
      resolveAgentTaskConfig(config)?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    await this.drainBackgroundTasksOnPrint(session, ceilingS);
  }

  /**
   * v1's `Session.handlePrintMainTurnCompleted`, rebuilt over the same v2
   * primitives: `'exit'` finishes immediately, `'drain'` drains then
   * finishes, and `'steer'` keeps the run alive while background tasks are
   * pending, bounded by the wall-clock ceiling (`print_wait_ceiling_s`) and
   * the turn cap (`print_max_turns`). The steer deadline/turn counters are
   * per-session SDK state ({@link printSteerStates}), mirroring v1's
   * Session-object fields.
   */
  override async handlePrintMainTurnCompleted(
    input: SessionIdRpcInput,
  ): Promise<'finish' | 'continue'> {
    const session = this.requireLiveSession(input.sessionId);
    await this.configReady;
    const config = this.engineAccessor.get(IConfigService);
    const taskConfig = resolveAgentTaskConfig(config);
    const ceilingS = taskConfig?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    const mode = resolvePrintBackgroundMode(config);
    if (mode === 'exit') return 'finish';
    if (mode === 'drain') {
      await this.drainBackgroundTasksOnPrint(session, ceilingS);
      return 'finish';
    }
    // 'steer'
    const maxTurns = taskConfig?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT;
    const state = this.printSteerStates.get(input.sessionId) ?? { deadline: undefined, turns: 0 };
    this.printSteerStates.set(input.sessionId, state);
    const now = Date.now();
    state.deadline ??= now + ceilingS * 1000;
    state.turns += 1;
    if (now >= state.deadline) return 'finish';
    if (state.turns > maxTurns) return 'finish';
    if (this.countActiveBackgroundTasks(session) > 0) return 'continue';
    return 'finish';
  }

  /**
   * The shared drain pass of the two print-policy overrides, ported from
   * v1's `waitForBackgroundTasksOnPrint` (the native v2 print runner carries
   * the same loop): re-enumerate active tasks across every live agent until
   * none remain or the ceiling expires — a subagent may fan out new tasks
   * mid-drain — with terminal notifications suppressed up front so a
   * completing task cannot steer a finished main turn.
   */
  private async drainBackgroundTasksOnPrint(
    session: ISessionScopeHandle,
    ceilingS: number,
  ): Promise<void> {
    const deadline = Date.now() + ceilingS * 1000;
    const seen = new Set<string>();
    const allWaiters: Promise<unknown>[] = [];
    while (Date.now() < deadline) {
      const batch: Promise<unknown>[] = [];
      const suppressions: Promise<void>[] = [];
      let activeCount = 0;
      for (const agent of session.accessor.get(IAgentLifecycleService).list()) {
        const tasks = agent.accessor.get(IAgentTaskService);
        for (const task of tasks.list(true)) {
          activeCount++;
          if (seen.has(task.taskId)) continue;
          seen.add(task.taskId);
          suppressions.push(tasks.suppressTerminalNotification(task.taskId));
          // A configured ceiling above the ~24.8-day timer ceiling overflows
          // a raw `setTimeout` into an immediate resolve — clamp here (the
          // engine's `wait` clamps too; this keeps the caller side correct
          // regardless). The outer loop re-enumerates after an early return,
          // so semantics are unchanged.
          const remaining = Math.min(Math.max(1, deadline - Date.now()), MAX_TIMER_DELAY_MS);
          const waiter = tasks.wait(task.taskId, remaining);
          batch.push(waiter);
          allWaiters.push(waiter);
        }
      }
      if (suppressions.length > 0) await Promise.all(suppressions);
      if (activeCount === 0 || batch.length === 0) break;
      await Promise.all(batch);
    }
    if (allWaiters.length > 0) await Promise.all(allWaiters);
  }

  /** v1's `countActiveBackgroundTasks`: active tasks across every live agent. */
  private countActiveBackgroundTasks(session: ISessionScopeHandle): number {
    let count = 0;
    for (const agent of session.accessor.get(IAgentLifecycleService).list()) {
      count += agent.accessor.get(IAgentTaskService).list(true).length;
    }
    return count;
  }

  // -----------------------------------------------------------------------
  // MCP: the user-global surface is rebuilt over the SDK-side store port in
  // `src/v2/global-mcp.ts` plus the v2 engine's own OAuth service and
  // connection manager (agent-core-v2 has no app-scope MCP config service —
  // it only reads `mcp.json`); the session-level reads go through the
  // session scope's seeded `ISessionMcpHandle` (no klient facade exists for
  // either group).
  // -----------------------------------------------------------------------

  /**
   * Configured custom identity announced to MCP servers, so these global flows
   * match what the workspace-owned manager sends. Reads the frozen snapshot;
   * every path that reaches it awaited `globalMcpOAuthService()` first.
   */
  private resolveMcpClientName(): string | undefined {
    return this.engineAccessor.get(IAgentIdentity).current().slug;
  }

  /**
   * v1's per-core `globalMcpOAuth`, built over the app-scope document store.
   *
   * Async on purpose: the service caches providers by store key and stamps the
   * client name when it first builds one, so any path that can materialize a
   * provider must not run before the identity snapshot froze. Guarding here
   * rather than at each call site means a new entry point cannot forget to.
   */
  private async globalMcpOAuthService(): Promise<McpOAuthService> {
    await this.engineAccessor.get(IAgentIdentity).resolved();
    if (this.globalMcpOAuth === undefined) {
      this.globalMcpOAuth = new McpOAuthService({
        store: createMcpOAuthStore(this.engineAccessor.get(IAtomicDocumentStore)),
        resolveClientName: () => this.resolveMcpClientName(),
      });
    }
    return this.globalMcpOAuth;
  }

  override async listGlobalMcpServers(): Promise<readonly McpServerConfig[]> {
    return this.globalMcpConfig.list();
  }

  override async addGlobalMcpServer(
    server: McpServerConfig,
  ): Promise<readonly McpServerConfig[]> {
    return this.globalMcpConfig.add(server);
  }

  override async updateGlobalMcpServer(
    server: McpServerConfig,
  ): Promise<readonly McpServerConfig[]> {
    return this.globalMcpConfig.update(server);
  }

  override async removeGlobalMcpServer(name: string): Promise<readonly McpServerConfig[]> {
    return this.globalMcpConfig.remove(name);
  }

  /**
   * v1's flow state machine verbatim: the guards (`requireOAuthMcpServer`)
   * run before any network I/O, a begun flow is held by flowId until
   * complete/cancel, and an already-authorized server short-circuits without
   * a flowId. The OAuth work itself is the v2 engine's `McpOAuthService`
   * (same begin/complete/cancel contract as v1's).
   */
  override async beginGlobalMcpServerAuth(name: string): Promise<BeginGlobalMcpServerAuthResult> {
    const server = await this.globalMcpConfig.get(name);
    const config = requireOAuthMcpServer(server);
    try {
      const oauth = await this.globalMcpOAuthService();
      const flow = await oauth.beginAuthorization(server.name, config.url);
      const flowId = randomUUID();
      this.globalMcpOAuthFlows.set(flowId, { flow });
      return {
        status: 'authorization-required',
        flowId,
        authorizationUrl: flow.authorizationUrl.toString(),
      };
    } catch (error) {
      if (error instanceof AlreadyAuthorizedError) {
        return { status: 'already-authorized' };
      }
      throw error;
    }
  }

  override async completeGlobalMcpServerAuth(
    input: { readonly flowId: string; readonly timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const active = this.globalMcpOAuthFlows.get(input.flowId);
    if (active === undefined) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, `Unknown MCP OAuth flow: ${input.flowId}`);
    }
    try {
      await active.flow.complete({
        signal,
        timeoutMs: input.timeoutMs ?? DEFAULT_GLOBAL_MCP_AUTH_TIMEOUT_MS,
      });
    } finally {
      this.globalMcpOAuthFlows.delete(input.flowId);
    }
  }

  override async cancelGlobalMcpServerAuth(flowId: string): Promise<void> {
    const active = this.globalMcpOAuthFlows.get(flowId);
    if (active === undefined) return;
    this.globalMcpOAuthFlows.delete(flowId);
    await active.flow.cancel();
  }

  override async resetGlobalMcpServerAuth(name: string): Promise<void> {
    const server = await this.globalMcpConfig.get(name);
    const config = requireRemoteMcpServer(server);
    const oauth = await this.globalMcpOAuthService();
    await oauth.invalidate(server.name, config.url);
  }

  /**
   * v1's standalone probe: a throwaway connection manager over the global
   * file entry, never the session's. The global default timeouts come from
   * the live `[mcp]` config section (awaited first — the config service's
   * reads are synchronous over pre-ready state, the same trap as the config
   * batch); v1 resolves the same section with the same env bindings, so the
   * precedence matches.
   */
  override async testGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    const server = await this.globalMcpConfig.get(name);
    const config = mcpConfigWithoutName(server);
    await this.configReady;
    const section = this.engineAccessor.get(IConfigService).get<McpSection | undefined>(MCP_SECTION);
    const manager = new McpConnectionManager({
      stdioCwd: options.cwd,
      oauthService: await this.globalMcpOAuthService(),
      resolveClientName: () => this.resolveMcpClientName(),
      resolveDefaultTimeouts: () => ({
        startupTimeoutMs: section?.startupTimeoutMs,
        toolTimeoutMs: section?.toolTimeoutMs,
      }),
    });
    try {
      await manager.connectAll({ [server.name]: config });
      return standaloneMcpTestResult(server.name, manager);
    } finally {
      await manager.shutdown();
    }
  }

  /**
   * Through the session scope (the seeded `ISessionMcpHandle.connectionManager`
   * — the workspace handler's one shared manager). This is a live snapshot:
   * create/resume no longer waits for MCP startup, so entries may still be
   * pending. The v2 `McpServerEntry` is field-identical with v1's
   * `McpServerInfo` (the cast bridges the two packages' type declarations).
   */
  override async listMcpServers(input: SessionIdRpcInput): Promise<readonly McpServerInfo[]> {
    const mcp = this.requireLiveSession(input.sessionId).accessor.get(ISessionMcpHandle);
    return mcp.connectionManager.list() as readonly McpServerInfo[];
  }

  /**
   * Workspace-level MCP view (the handler's one shared connection set), so
   * `/mcp` is inspectable on a v2 session-less startup before any session
   * exists. Awaits `ready` so a fresh handler's initial connect settles
   * before the list is read.
   * Same `McpServerEntry`-as-`McpServerInfo` cast as listMcpServers.
   */
  override async listWorkspaceMcpServers(workDir: string): Promise<readonly McpServerInfo[]> {
    const handler = await this.engineAccessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ root: normalizeRequiredWorkDir('listWorkspaceMcpServers', workDir) });
    const mcp = handler.accessor.get(IWorkspaceMcpService);
    await mcp.ready;
    return mcp.connectionManager().list() as readonly McpServerInfo[];
  }

  override async getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics> {
    const mcp = this.requireLiveSession(input.sessionId).accessor.get(ISessionMcpHandle);
    await mcp.ready;
    return { durationMs: mcp.connectionManager.initialLoadDurationMs() };
  }

  /**
   * Same direct `reconnect` as v1's session RPC — the v2 manager raises the
   * same `mcp.server_not_found` / `mcp.server_disabled` errors, and the tool
   * re-registration rides on the status listeners in both engines.
   */
  override async reconnectMcpServer(input: ReconnectMcpServerRpcInput): Promise<void> {
    const mcp = this.requireLiveSession(input.sessionId).accessor.get(ISessionMcpHandle);
    await mcp.connectionManager.reconnect(input.name);
  }
}

export function createKimiHarnessV2(options: KimiHarnessOptions): KimiHarness {
  const rpc = new SDKRpcClientV2(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    // v1-core-owned ingestion limits; the v2 engine has no equivalent yet, so
    // ingestion falls back to env / built-in defaults like daemon-client hosts.
    imageLimits: undefined,
    sessionStartedProperties: options.sessionStartedProperties,
  });
}

/** v1's `requiredWorkDir`: reject blank and normalize to the canonical spelling. */
function normalizeRequiredWorkDir(operation: string, workDir: string): string {
  if (typeof workDir !== 'string' || workDir.trim() === '') {
    throw new KimiError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, `${operation} requires workDir`);
  }
  return normalizeWorkDir(workDir);
}
