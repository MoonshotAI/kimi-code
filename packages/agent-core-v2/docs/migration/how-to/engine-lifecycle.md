# How to start, use, and shut down the v2 engine

Date: 2026-09-19. Code baseline: `ccf3d5d6` (the direct parent of #3542, the commit that deleted v1 on main). At this commit v1 `@moonshot-ai/agent-core` 0.15.8 and v2 `@moonshot-ai/agent-core-v2` 0.4.3 coexist; every path and symbol in this document was verified against that baseline. All paths are written from the repository root. Sub-document of [`migration-from-v1.md`](../../migration-from-v1.md); Chinese mirror: [`engine-lifecycle.zh-CN.md`](engine-lifecycle.zh-CN.md).

Audience: a consumer that used to do `new KimiCore(...)` / `new Session(...)` / `new Agent(...)` on v1 and now needs to drive the v2 engine in-process. The path is: **bootstrap → accessor.get(services) → Program → session controller → helper functions → drain\* shutdown**. Most of the v2 symbols named below are re-exported from `packages/agent-core-v2/src/index.ts` (bootstrap family :69-70, `mainAgent` :468, `sessionLookup` :501, `scopeContext` :738).

## 1. Bootstrap the App scope (`packages/agent-core-v2/src/app/bootstrap/bootstrap.ts`)

**`BootstrapInput`** (:95-105): `homeDir?`, `configPath?`, `env?`, `osHomeDir?`, `platform?`, `arch?`, `cwd?`, `clientIdentity: KimiHostIdentity` (the only required field), `args?: HostArgsInput`.

**Defaults** (`resolveBootstrapOptions` :107-123):

- `env` → `process.env`; `osHomeDir` → `os.homedir()`
- `homeDir` → `resolveKimiHome` (:163-169): `input.homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code')`
- `configPath` → `join(homeDir, 'config.toml')` (:111; standalone helper `resolveConfigPath` :171-176)
- `platform` → `process.platform`; `arch` → `process.arch`; `cwd` → `process.cwd()`
- `args` → `resolveHostArgs` (:36-45): only `requestHeaders` defaults to `{}`; the other fields (`agentFiles`/`skillDirs`/`displayName`/`replyStyleGuide`/`nonInteractive`) pass through as undefined

**`HostArgsInput`/`HostArgs`** (:18-34): `agentFiles?`, `skillDirs?`, `requestHeaders` (required after resolution), `displayName?`, `replyStyleGuide?`, `nonInteractive?`.

**`KimiHostIdentity`** (`packages/oauth/src/identity.ts:20-31`): `productName`, `version`, `platform`, `userAgentSuffix?`.

**`BootstrapResult`** (:134-136): `{ readonly app: Scope }`. `Scope` satisfies `IScopeHandle` (`_base/di/scope.ts:111-116`: `id`/`kind`/`accessor`/`dispose()`); `createAppScope` is at `_base/di/scope.ts:298-300`.

**`bootstrap(input, extraSeeds = [])`** (:138-144): `createAppScope({ seeds: [...bootstrapSeed(input), ...storageSeed(options), ...skillSeed(), ...extraSeeds] })`. The three built-in seeds:

- `bootstrapSeed` (:125-132): the `IBootstrapOptions` value
- `storageSeed` (:146-152): `IFileSystemStorageService` → `SyncDescriptor(FileStorageService, [homeDir, 0o700, 0o600])`
- `skillSeed` (:154-161): `ISkillDiscovery` → `SyncDescriptor(FileSkillDiscovery, [])`

**The extraSeeds mechanism**: `ScopeSeed = ReadonlyArray<readonly [ServiceIdentifier<any>, unknown]>` (`_base/di/scope.ts:101-103`); `buildCollection` (:122-130) applies `collection.set(id, value)` in order — **later writes override earlier ones**, and extraSeeds come last, so consumers can override built-in seeds (test stubs and the log seed both rely on this). Real examples: node-sdk passes `[...logSeed(resolveLoggingConfig(...))]` (`packages/node-sdk/src/sdk-rpc-client-v2.ts:466`); kap-server passes `[...logSeed(logging), ...(opts.seeds ?? [])]` (`packages/kap-server/src/start.ts:196-210`); a test passes `[[ISessionIndex, stub], [IGitService, stub]]` (`packages/kap-server/test/v2Sessions.test.ts:181-184`). `logSeed`/`resolveLoggingConfig` live at `packages/agent-core-v2/src/_base/log/logConfig.ts:41,54`.

Helper: `ensureKimiHome(homeDir)` (:178-180, `mkdirSync` recursive 0o700).

**`BootstrapService`** (`bootstrapService.ts:14-69`): registered at App scope, `ScopeActivation.OnScopeCreated` (:71). Derived directories: `sessionsDir/blobsDir/storeDir/cacheDir/logsDir = join(homeDir, ...)` (:45-49); `configKey = basename(configPath)` (:50); `scope(name: PersistenceScopeName)` (:66-68, `PersistenceScopeName` at bootstrap.ts:62-69: 'config'|'sessions'|'blobs'|'store'|'logs'|'cache'|'credentials'); `getEnv(name)` (:62-64).

## 2. Take services from the accessor

Everything after bootstrap goes through `app.accessor.get(IXxxService)`: `IConfigService`, `ISessionIndex`, `IWorkspaceInstanceManager`, `ISessionManager`, `IPluginService`, `IEventService`, and so on. On-demand services materialize on first `get`; eager services are already up. Note the readiness discipline: many services expose a `ready` promise — config/model/provider reads are synchronous only after their initial load settles (see §7's `configReady`/`modelReady` pattern).

## 3. Program: one per workspace (`packages/agent-core-v2/src/program/program.ts`)

`class Program` (:113-388). **Construction** (:126-140): `new Program(workspaceId, runtimes: RuntimeRegistry, context: IWorkspaceContext, dependencies: ProgramDependencies)`; it immediately freezes `binding = { workspaceId, runtimeId: 'local' }` (:132), subscribes to `runtimes.onDidChange`, and `reconcileGeneration()` (synchronously builds the first generation).

**Public members**:

- `binding: RuntimeBinding` (:114)
- `onDidChange: Event<ProgramSnapshot>` (:116-117)
- `ready: Promise<void>` (:123-124; resolves on success **or on degraded failure** — see `resolveProgramReady` :375-378 and :267-270/:353-358, i.e. ready does not mean healthy; check `status`)
- `status: ProgramStatus` (:142; 'preparing'|'ready'|'degraded', :47)
- Service getters (throw `program <id> has no available local runtime generation` when no generation exists, :239-242): `state/dirs/fs/watch/git/instructions/mcpConfig/mcp/trust/skills/agentProfiles` (:143-153), `sessionControllerGeneration` (:154)
- `createSessionController(): SessionLifecycleService` (:156-185): generation refcount +1, created via `dependencies.createSessionController(ProgramSessionControllerInput)`; controller dispose calls `release` back (:160-164, :179)
- `snapshot(): ProgramSnapshot` (:187-227; shape at :74-84, with `status/ready/generation/trusted/catalog/sources/runtimes`)
- `dispose()` (:229-237)

**The generation mechanism**: `PROGRAM_CAPABILITIES = ['fs','process','watch']` (:111); `createGeneration` (:276-336) takes a `RuntimeLease` via `resolver.acquire(binding, PROGRAM_CAPABILITIES)`, news up the workspace services into `disposables`, and on failure disposes in reverse order + `lease.dispose` (:331-335); a runtime-registry change triggers `reconcileGeneration` (:249-274); generations are identified by `runtime.identity.generation` and retired by refcount (`retireGeneration`/`releaseGeneration` :362-373, `references` starts at 1, each controller +1, disposed in reverse order at 0-and-retired). `observeReadiness` (:338-360) waits for six ready signals: `dirs/instructions/mcpConfig/mcp/skills/agentProfiles`.

**`ProgramDependencies`** (`programDependencies.ts:45-62`): `appState/bootstrap/config/git: LiveRef/identity/log/oauth: McpOAuthService/configStore/plugins/sessionManager: LiveRef/agentProfiles/builtinAgentProfiles/builtinSkills/telemetry/docs` + `createSessionController(input: ProgramSessionControllerInput): SessionLifecycleService`; `ProgramSessionControllerInput` :30-43.

**Ownership**: `WorkspaceInstance` (`workspace/workspaceInstance/workspaceInstance.ts:17-64`) composes `runtimes/unitHost/program` (:32); its `dispose()` (:56-63) order: program.dispose → unitHost.dispose → runtimes.dispose. `IWorkspaceInstanceManager` (`workspaceInstanceManager.ts:19-30`): `getOrCreate(ref)/get/findByRoot/findContaining/list/snapshot/close/addProvider`; registered at App scope OnScopeCreated (`workspaceInstanceManagerService.ts:312`), registering the `'local'` provider by default at construction (:81).

You do not construct `Program` yourself — reach it through `IWorkspaceInstanceManager.getOrCreate(...).program`, or through the helper `programForSession` (§5).

## 4. Session create / resume / close APIs

**The App-level facade `ISessionManager`** (`app/sessionManager/sessionManager.ts:28-52`): `create/resume/get/status/whenResumeSettled/withLifecycleSerialization/list/close/archive/restore/delete/fork/createChild`, plus 6 optional events (`onWillCreateSession` etc., `Event<...>` with `?`). Implementation `SessionManager` (`sessionManagerService.ts:36-281`, App-scope OnScopeCreated :281):

- `create` (:63-72): `workspaces.getOrCreate` → `controllerForWorkspace`; `resume` (:74-86): `pendingResumes` dedup + `serializeLifecycle` per-session serial chain (:103-115)
- `controllerForWorkspace` (:225-261) validates the generation via `program.sessionControllerGeneration`, reuses the cached controller or creates one via `program.createSessionController()`, bridges the controller's 6 events into facade events, maintains the `sessions`/`owners` maps; an idle controller (sessionCount=0) is disposed (:263-269)
- `controllerForSession` (:271-278): live → owner; cold → `ISessionIndex.get` → `workspaces.getOrCreate({workspaceId, root: summary.cwd})`
- `fork`/`createChild` use sorted multi-key serialization (:176-206); `delete` throws `Error2(SESSION_NOT_FOUND)` when not found (:166-174)

**The workspace-level `ISessionLifecycleService`** (`workspace/sessionLifecycle/sessionLifecycle.ts:72-91`): 6 events (`onDidCreateSession`/`onWillCloseSession` with `IWaitUntil`; `SessionWillCreateEvent` with `readSeed/contributeSeed/onSessionDispose` :65-70) + `create/get/list/resume/close/archive/restore/delete/fork/createChild`. Option types: `CreateSessionOptions` (:12-18: `sessionId?/workDir/additionalDirs?/mainAgentBinding?/mcpServers?`), `ResumeSessionOptions` (:28-31), `ForkSessionOptions` (:20-26), `CreateChildSessionOptions` (:33-38); `SessionCreateSource='startup'|'resume'|'fork'` (:8), `SessionCloseReason='exit'|'archive'` (:10).

The implementation `SessionLifecycleService` (`sessionLifecycleService.ts:133-881`, created by `Program.createSessionController` per workspace generation), key behaviors:

- `create` (:205-239): id defaults to `session_${randomUUID()}` (:896-898); first `workspaceSkillCatalog.reloadSources(['user','explicit','extra',PLUGIN_SKILL_SOURCE_ID])` (:126-131, :207-209, best-effort); after `materializeSession`, creates the main agent per `mainAgentBinding` and enters plan mode per `DEFAULT_PLAN_MODE_SECTION` (:211-227); `appendSessionIndexEntry` writes `session_index.jsonl` and flushes (:323-331); failure rollback: delete map entry, drainAgents, handle.dispose, `hostFs.remove(sessionDir)` (:229-236)
- `materializeSession` (:241-321): waits for `config/models/providers.ready` + `workspaceDirs.ready` (:246-247); `mergeAdditionalDirs`; `createScopedChildHandle(LifecycleScope.Session, sessionId, { seeds, configureContainer })`, seeds include `sessionContextSeed/ITelemetryService/sessionAgentProfileCatalogSeed/ISessionSkillCatalogData/ISessionInstructionsProvider/ISessionMcpHandle/ISessionWorkspaceInfo/sessionEphemeralMcpServersSeed` (:268-281); `onWillCreateSession` fires inside `configureContainer`, listeners may `contributeSeed`/`onSessionDispose` (:287-296); then waits for `ISessionMetadata.ready`, `ISessionToolPolicy.ready`, and all profile loaders ready (:305-313)
- `resume` (:346-365)/`doResume` (:373-402): `resuming` map dedup (while in flight, `get()` returns undefined, :341-344); validates the `ISessionIndex` summary exists and `workspaceId` matches, otherwise returns undefined; after materialize, a missing main agent is re-created (:391-394); `announceCreated source:'resume'` and telemetry `session_load_failed` records `resumeFailures` for `whenResumeSettled` (:367-371) to rethrow
- `close` (:412-425), `archive` (:427-447), `restore` (:449-457, resume+`setArchived(false)`), `delete` (:459-478: waits in-flight resume → not in this workspace and no live → throws `SESSION_NOT_FOUND` → live → close first → `hostFs.remove(sessionDir)` → `index.remove` → `dropFileHistorySession` → journal `{deleted:true}` + flush), `fork` (:491-679, including `SESSION_FORK_ACTIVE_TURN` rejection, quiescence hold, turnIndex truncation), `createChild` (:681-696, = fork + parent session metadata)

## 5. Consumer helper functions

All in `packages/agent-core-v2/src/app/sessionManager/sessionLookup.ts` (signatures `(accessor: ServicesAccessor, ...)`):

- `programForSession(accessor, sessionId): Promise<Program | undefined>` (:13-30): live session via `ISessionContext.workspaceId` → `IWorkspaceInstanceManager.get(workspaceId)?.program`; cold session via `ISessionIndex.get` → `getOrCreate({workspaceId, root: summary.cwd})` → `.program`
- `resumeSessionById(accessor, sessionId, opts?): Promise<ISessionScopeHandle | undefined>` (:32-48): `ISessionManager.resume`; on failure, telemetry `track2('session_load_failed', {reason})` then rethrow
- `getLiveSessionById(accessor, sessionId): ISessionScopeHandle | undefined` (:50-55): `ISessionManager.get`
- `closeSessionById(accessor, sessionId): Promise<void>` (:57-62): `ISessionManager.close`
- `followSessionLifecycles(accessor, follow): IDisposable` (:68-77): `ISessionManager`'s `onDidCloseSession`/`onDidArchiveSession` are optional — if either is missing, returns an empty disposable; otherwise `follow(manager as SessionLifecycleEvents)`
- `ensureMainAgent(session: ISessionScopeHandle, opts?): Promise<AgentContext>` (`session/agentLifecycle/mainAgent.ts:6-14`): `session.accessor.get(IAgentLifecycleService).create({...opts, agentId: MAIN_AGENT_ID})` (create-or-get). **Same-name warning**: `packages/kap-server/src/transport/mainAgent.ts:11` has another `ensureMainAgent(session): Promise<IAgentScopeHandle>` (a kap-server local variant returning a handle, not an AgentContext)
- `agentContextOf(handle: IAgentScopeHandle): AgentContext` (`agent/scopeContext/scopeContext.ts:49-51`): `handle.accessor.get(IAgentScopeContext).agentContext`; related `agentContextOfScope` (:45-47), `tryAgentContextOf` (:53-55)

## 6. Shutdown: the drain\* functions and their ordering constraints

The drain functions (all module-level, waiting on module-level pending-promise sets; the first two and the last loop until the set is empty):

- `drainAppendLogRetirements()` (`persistence/backends/node-fs/appendLogStore.ts:19-23`): waits for append-log retirement/switch flushes; the instance method `AppendLogStore.drainRetirements()` (:150-152) delegates to it (interface declared at `persistence/interface/appendLogStore.ts:51`)
- `drainSessionMetadataWrites()` (`session/sessionMetadata/sessionMetadataService.ts:27-29`): waits for session `state.json` async writes
- `drainLogCloses()` (`_base/log/logService.ts:30-34`, registration entry `trackLogClose` :21-28): waits for file log writers to close
- `drainSessionIndexMirror()` (`app/sessionIndex/sessionIndexMirrorService.ts:29-31`): waits for mirror-dispose-triggered drainage; the companion **instance method** `ISessionIndexMirror.drain()` flushes the queue into the query store (service from :33-59, automatically hooked into pendingDrains on dispose)
- `drainQueryStoreDisposals()` (`persistence/backends/minidb/miniDbQueryStore.ts:47-49`): waits for MiniDB ClusterDb async closes
- `drainGlobalSearchDisposals()` (`packages/kap-server/src/search/searchService.ts:94-98`): kap-server only, waits for the global search database/worker to close

**Single-session close order** (`SessionLifecycleService.close` sessionLifecycleService.ts:412-425): `announceWillClose` (`onWillCloseSession` IWaitUntil fired and awaited) → removed from map → `drainAgents` (one `agentLifecycle.remove` each, :484-489) → `appendLogStore.drainRetirements()` → `drainSessionMetadataWrites()` → `indexMirror.drain()` → `handle.dispose()` → `drainLogCloses()` → fire `onDidCloseSession` → telemetry `session_ended`. `archive` (:427-447) differs: `setArchived(true)` first → drainAgents → `drainRetirements` → publish `SessionArchived` → announceWillClose → … (same tail).

**Whole-engine shutdown (node-sdk)** `SDKRpcClientV2.close()` (`packages/node-sdk/src/sdk-rpc-client-v2.ts:510-535`): all sessionWirings disposed → appSubscriptions disposed → `klient.close()` → `ISessionIndexMirror.drain()` (**while the query store is still alive**, comment :519-522) → `IMcpOAuthService.shutdown()` (must precede `app.dispose()`, :524-528) → grab the `IAppendLogStore` reference → `app.dispose()` → `appendLogStore.drainRetirements()` → `drainSessionIndexMirror()` → `drainQueryStoreDisposals()` → `drainLogCloses()`.

**Whole-engine shutdown (kap-server)** `close` (`packages/kap-server/src/start.ts:293-327`): `configChangedPublisher.close()` → `app.close()` (Fastify; the onClose hook at :534-538 closes connectionRegistry/wssV1/broadcaster) → subscriptions disposed → `shutdownServerTelemetry` (:302) → `drainSessionMetadataWrites()` → `ISessionIndexMirror.drain()` → `IMcpOAuthService.shutdown()` → `fsWatchBridge.dispose()` → grab `IAppendLogStore` → `core.dispose()` → `appendLogStore.drainRetirements()` → `drainSessionIndexMirror()` → `drainGlobalSearchDisposals()` → `drainQueryStoreDisposals()` → `drainSessionMetadataWrites()` → `drainLogCloses()`; finally releases the instance registration and detaches process handlers. Shared constraints of both paths: **the mirror drain must run before scope dispose; the drain\* calls must run after scope dispose (accessors throw after disposal, so grab the service references first); tests must await the drains before deleting homeDir, or they race rm into ENOTEMPTY** (the comment at sdk-rpc-client-v2.test.ts:79-87 and kap-server's close comment :519-522).

## 7. How tests start the engine

The `packages/agent-core-v2/src/runtime/` trio:

- **`LocalRuntime`** (`runtime/localRuntime.ts:17-87`): the real local runtime, identity `{workspaceId, runtimeId:'local', generation:'local-<n>'}` (:39), capability set decided by which host services are passed in (:40-45), initial status `'ready'`; `LocalRuntimeProviderFactory` (:89-114) is the default provider, registered by `WorkspaceInstanceManager` at construction (`workspaceInstanceManagerService.ts:81`).
- **`StandaloneRuntimeFactory`** (`runtime/standaloneRuntime.ts:21-35`, App-scope OnDemand :37-43): `IStandaloneRuntimeFactory.createLocalRuntime(workspaceId)` news up a `LocalRuntime` on the spot from App-level host services (bypassing the registry/provider system).
- **`FakeRuntime`** (`runtime/fakeRuntime.ts:8-79`): fs/process/watch/terminal all undefined; capabilities/status/pathClass/environment injectable via constructor params, `setStatus()` drives the state machine — pure unit-test use (e.g. `test/app/sessionManager/sessionManagerService.test.ts:9` with handwritten `SessionLifecycleService` stubs :21-52).

Real usage per package:

- **agent-core-v2 itself**: unit tests do not go through `bootstrap` — they use `TestInstantiationService` + handwritten stubs (`test/app/gateway/gateway.test.ts:8,31-42`) or the agent-scope test harness `createTestAgent`/`testAgent` (`test/harness/agent.ts`, exports at `test/harness/index.ts:1-37`, overridable per service group).
- **klient**: a real engine. `test/helpers/engine.ts:27-33` `makeEngine()` = mkdtemp home + `bootstrap({homeDir, clientIdentity: TEST_CLIENT_IDENTITY}, [...logSeed(resolveLoggingConfig(...))])` (the header comment :1-7 explains why the logSeed is mandatory); memory transport `createKlient({ scope: app })`; cleanup `klient.close() → app.dispose() → rm homeDir` (`test/memory.test.ts:11-23`).
- **kap-server**: a real `startServer` (which bootstraps internally). Two modes: (a) shared across the suite — vitest `globalSetup` (`test/globalSetup.ts:15-36`) with a fixed token, seeds injecting an `IModelCatalog` fake, and the `search_worker`/`persistence_minidb_readmodel` flags turned off (:16-17); (b) per-file — `test/v2Sessions.test.ts:174-187`, `seeds: [[ISessionIndex, stub], [IGitService, gitStub]]`.
- **node-sdk**: `createKimiHarnessV2({ homeDir, identity })` (internally `new SDKRpcClientV2`) over an mkdtemp home (`test/sdk-rpc-client-v2.test.ts:99-103`); afterEach runs `drainSessionIndexMirror()` + `drainQueryStoreDisposals()` before rm (:79-87).

## 8. A worked example: node-sdk `sdk-rpc-client-v2.ts` call order (key line numbers)

`packages/node-sdk/src/sdk-rpc-client-v2.ts` (2817 lines total; the v2 engine import block :159-246, `createKlient` :248):

**Construction** (:432-497): `resolveKimiHome` (:436) → `resolveConfigPath` (:437-440) → `ensureKimiHome` (:441) → `KimiAuthFacade` (:443-448) → `assertKimiHostIdentity` (:450) → **`bootstrap({homeDir, configPath, clientIdentity, args:{requestHeaders, skillDirs}}, [...logSeed(resolveLoggingConfig(...))])`** (:451-467) → `this.app = app` (:468) → **`createKlient({ scope: app })` (memory transport**, :469) → `configReady = IConfigService.ready` (:470) → `installEngineTelemetry` (:471) → `modelReady = configReady + IModelService.ready + IProviderService.ready` (:472-476) → two App-level subscriptions (:477-496): `IEventService.subscribe` translated via `translateGlobalEvent` into `receiveEvent` (:483-486), `followSessionLifecycles(... onDidCloseSession → unwireSession)` (:491-495).

**Create session**: `createSession` (:1320-1328, explicit ids go through the `runSessionAccess` serial queue :943-957) → `doCreateSession` (:1330-1370): live/index double dedup (:1332-1342) → `ISessionManager.create({sessionId, workDir, additionalDirs})` (:1343-1347) → **`wireSession(handle)`** (:1350) → optional `materializeMainAgent` + set permission (:1351-1363) → `klient.session(id).update` writes metadata (:1364-1366) → `liveSessionSummary` (:1369).

**Resume**: `resumeSession` (:1489-1507): inside the queue `resumeSessionById(engineAccessor, id, {additionalDirs})` (:1497) → `wireSession` (:1501) → `resumedSessionSummary` (:1502-1505, main agent via `materializeMainAgent` :1102, subagents via `IAgentLifecycleService.create` cold restore :1119-1134). `reloadSession` (:1517-1551): busy check → `config.reload`+`plugins.reload` → `closeSessionById` (:1542) → `resumeSessionById` (:1544) → wireSession. `forkSession` (:1419-1442): `runSessionAccessAll` sorted multi-key → `programForSession` (:1427) → `ISessionManager.fork` (:1429-1435) → `resumeSessionById` (:1436) → wireSession.

**Event wiring**: `wireSession` (:1039-1042) = `new SessionEventWiring(handle, this)`, idempotent; `unwireSession` (:1044-1052) is driven by the construction-time close subscription, with no other call sites. `SessionEventWiring` (`packages/node-sdk/src/v2/session-wiring.ts:106-312`, design notes at :1-24): subscribes to every existing agent's `IEventBus` + `onDidCreate` to cover later subagents (:117 onward), back-translates with `translateDomainEvent` into the v1 `Event` shape and pushes to `receiveEvent`; the interaction bridge listens to `onSessionInteractionDidChangePending` and feeds pending approvals/questions/user-tools to the sink callbacks, writing back via `ISessionApprovalService.decide`/`ISessionQuestionService.answer`/`respond`. The header comment (sdk-rpc-client-v2.ts:109-116) explains why it deliberately bypasses the klient events hub (whose contract only covers 13 bus types).

**Main-agent materialization**: `materializeMainAgent` (:1674-1704): `modelReady` → `ensureMainAgent(session)` → `handleOf` → when unbound, `IAgentProfileService.bind({profile: DEFAULT_AGENT_PROFILE_NAME, model, thinking})`; an unbound binding with `MODEL_NOT_CONFIGURED` is tolerated (:1692-1701).

**Shutdown**: `closeSession` (:1444-1448) = `klient.session(id).close()` inside the queue; whole-engine `close()` (:510-535) order in §6.

## Open verification items / documentation drift

- **`IWorkspaceLifecycleService.handlerFor` does not exist in current source**: the workspace-root `AGENTS.md` (:22) and a node-sdk comment (`sdk-rpc-client-v2.ts:36, 917-919`) both mention it, but grep finds no match in `packages/agent-core-v2/src`. The real chain today is `IWorkspaceInstanceManager.getOrCreate` → `WorkspaceInstance.program` → `Program.createSessionController()` → `SessionLifecycleService`; and the App-level facade `ISessionManager` already exists (contradicting AGENTS.md's "there is no App-level session lifecycle facade"). If you cite the old name, rewrite per current reality.
- The `ensureMainAgent` in `kap-server/src/transport/mainAgent.ts` and the same-named export from agent-core-v2 differ in signature/return type (see §5); do not mix them up.
- Whether klient's `createKlient` options object has fields beyond `{ scope }` (e.g. ipc-variant parameters) was not verified — `packages/klient/src/transports/memory/index.ts`'s signature was not checked; if a how-to needs the full createKlient parameter list, check there.
