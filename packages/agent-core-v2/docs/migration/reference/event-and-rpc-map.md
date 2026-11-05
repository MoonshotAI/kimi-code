# Event and RPC map: v1 CoreAPI / Event → the v2 ecosystem

Date: 2026-09-19. Code baseline: `ccf3d5d6` (the direct parent of #3542, the commit that deleted v1 on main). At this commit v1 `@moonshot-ai/agent-core` 0.15.8 and v2 `@moonshot-ai/agent-core-v2` 0.4.3 coexist; every path and symbol in this document was verified against that baseline. All paths are written from the repository root. Sub-document of [`migration-from-v1.md`](../../migration-from-v1.md); Chinese mirror: [`event-and-rpc-map.zh-CN.md`](event-and-rpc-map.zh-CN.md).

## 0. The three-layer boundary (fact coordinates)

| Layer | v1 | v2 |
|---|---|---|
| In-process call contract | `CoreAPI` in `packages/agent-core/src/rpc/core-api.ts` (method object + payloads) | the three-level facade of `packages/klient` (`global.*` / `session(id).*` / `agent(id).*`), routed underneath by "service name + method name + zod contract" (`globalContract` at `packages/klient/src/contract/index.ts:51-94`) |
| Event push | the `SDKAPI.emitEvent` callback (`packages/agent-core/src/rpc/sdk-api.ts:72-77`); `Agent.emitEvent` → `this.rpc?.emitEvent?.(event)` (`packages/agent-core/src/agent/index.ts:725-728`) | in-engine `IEventBus`/`ISessionEventBus`/`IEventService` (`packages/agent-core-v2/src/app/event/eventBus.ts:7-35`, `event.ts:7-16`); outbound via kap-server WS broadcast or the node-sdk compatibility layer |
| Cross-process | v1's `createRPC` is an in-memory bidirectional simulation (`packages/agent-core/src/rpc/client.ts:31-105`, JSON serialization + a `KimiErrorPayload` error channel); there is no network daemon | `packages/klient`'s two transports ipc/memory (`packages/klient/src/transports/`); `packages/kap-server`'s REST `/api/v1`, `/api/v2` and WS v1 |
| Shared contract package | `packages/protocol` (@moonshot-ai/protocol): v1's `Event` union actually lives here (`packages/agent-core/src/rpc/events.ts:3-51` is only a re-export) | the same protocol package is also the type source of kap-server REST/WS (`packages/protocol/src/rest/*`, `ws-control.ts`, `session.ts`, etc.) |

v1's id-injection mechanism: `CoreAPI = SessionAPIWithId & …`, via the `WithAgentId`/`WithSessionId` type wrappers (`packages/agent-core/src/rpc/types.ts:13-14`) and the runtime `proxyWithExtraPayload` (`types.ts:16-29`; used at `core-impl.ts:444`, `session/index.ts:1285`), merging `sessionId`/`agentId` into every payload.

## 1. The v1 RPC surface, in full

### 1.1 CoreAPI method signatures (`packages/agent-core/src/rpc/core-api.ts`)

Three-level inheritance: `AgentAPI` (core-api.ts:605-648) → `SessionAPI extends WithAgentId<AgentAPI>` (:652-666) → `CoreAPI extends WithSessionId<SessionAPI>` (:670-736). The v1 implementation class is `KimiCore implements PromisableMethods<CoreAPI>` (`core-impl.ts:224`).

**A. Agent control (AgentAPI, `:605-648`, all carrying `agentId`+`sessionId`)**

- Turn driving: `prompt(PromptPayload): void`, `steer(SteerPayload): void`, `cancel(CancelPayload{turnId?}): void`, `undoHistory(UndoHistoryPayload{count}): void`
- Shell: `runShellCommand(RunShellCommandPayload{command,commandId?}): Promise<ShellCommandResult{stdout,stderr,isError?,backgrounded?}>`, `cancelShellCommand({commandId}): void`
- Model / thinking / permission: `setModel({model}): SetModelResult{model,providerName?}`, `getModel({}): string`, `setThinking({effort}): void`, `setPermission({mode}): void`
- plan/swarm/compaction: `enterPlan({}): void`, `cancelPlan({id?}): void`, `clearPlan({}): void`, `enterSwarm({trigger}): void`, `exitSwarm({}): void`, `getSwarmMode({}): boolean`, `beginCompaction({instruction?}): void`, `cancelCompaction({}): void`
- Tool registration: `registerTool(RegisterToolPayload{name,description,parameters,disclosure?}): void`, `unregisterTool({name}): void`, `setActiveTools({names}): void`
- Context: `clearContext({}): void`, `importContext(ImportContextPayload{content,source}): void`
- Skill / plugin command: `activateSkill({name,args?}): void`, `activatePluginCommand({pluginId,commandName,args?}): void`
- Background tasks: `stopBackground({taskId,reason?}): void`, `detachBackground({taskId}): BackgroundTaskInfo|undefined`, `getBackground({activeOnly?,limit?}): BackgroundTaskInfo[]`, `getBackgroundOutput({taskId,tail?}): string`
- goal/cron/btw: `createGoal({objective,replace?}): GoalSnapshot`, `getGoal({}): GoalToolResult`, `pauseGoal/resumeGoal/cancelGoal({}): GoalSnapshot`, `getCronTasks({}): GetCronTasksResult`, `startBtw({}): string`
- State reads: `getContext({}): AgentContextData`, `getConfig({}): AgentConfigData`, `getPermission({}): PermissionData`, `getPlan({}): PlanData`, `getUsage({}): UsageStatus`, `getTools({}): ToolInfo[]`

**B. Session management (SessionAPI, `:652-666`)**

`renameSession({title})`, `updateSessionMetadata({metadata: SessionMetadataPatch})`, `getSessionMetadata({}): SessionMeta`, `listSkills({}): SkillSummary[]`, `listPluginCommands({}): PluginCommandDef[]`, `listMcpServers({}): McpServerInfo[]`, `getMcpStartupMetrics({}): McpStartupMetrics`, `reconnectMcpServer({name,config?})`, `generateAgentsMd({})`, `getSessionWarnings({}): SessionWarning[]`, `waitForBackgroundTasksOnPrint({})`, `handlePrintMainTurnCompleted({}): 'finish'|'continue'`, `addAdditionalDir({path,persist}): AddAdditionalDirResult`

**C. Core / global (CoreAPI, `:670-736`)**

- Session lifecycle: `createSession(CreateSessionPayload): SessionSummary` (:57-72, with workDir/model/thinking/permission/metadata/mcpServers/additionalDirs/client/drainAgentTasksOnStop/agentProfile/agentFiles), `closeSession`, `archiveSession`, `deleteSession`, `resumeSession(ResumeSessionPayload): ResumeSessionResult` (:86-100, with includeSubagents/replayTurnLimit), `reloadSession({sessionId,forcePluginSessionStartReminder?}): ResumeSessionResult`, `forkSession({sessionId,id?,title?,metadata?,turnIndex?}): ResumeSessionResult`, `listSessions({workDir?,sessionId?,includeArchive?}): SessionSummary[]`, `exportSession(ExportSessionPayload): ExportSessionResult`, `applyPersistedSecondaryModel({sessionId})`
- Config: `getKimiConfig({reload?}): KimiConfig`, `setKimiConfig(KimiConfigPatch): KimiConfig`, `getConfigDiagnostics({}): ConfigDiagnostics`, `removeKimiProvider({providerId}): KimiConfig`, `getCoreInfo({}): CoreInfo{version}`, `getExperimentalFeatures({}): ExperimentalFeatureState[]`
- Global MCP management: `listGlobalMcpServers/getGlobalMcpServer/addGlobalMcpServer/updateGlobalMcpServer/removeGlobalMcpServer` (CRUD, returning `McpManagedServerInfo[]`), `listGlobalMcpServerAuthStatuses({cwd?,verify?})`, `inspectAppMcpServers({targets?,cwd?}): AppMcpServerInspection[]`, `beginGlobalMcpServerAuth/beginMcpServerAuth: BeginGlobalMcpServerAuthResult`, `completeGlobalMcpServerAuth/completeMcpServerAuth({flowId,timeoutMs?})`, `cancelGlobalMcpServerAuth/cancelMcpServerAuth({flowId})`, `resetGlobalMcpServerAuth/resetMcpServerAuth`, `testGlobalMcpServer({name?|server?,cwd?}): GlobalMcpServerTestResult`, `addSessionMcpServer({server,persist?}+sessionId): McpServerInfo`
- Plugins: `listPlugins/installPlugin({source})/setPluginEnabled({id,enabled})/setPluginMcpServerEnabled({id,server,enabled})/removePlugin({id})/reloadPlugins({}): ReloadPluginsResult/getPluginInfo({id}): PluginInfo`
- Other: `listWorkspaceSkills({workDir}): Promise<SkillSummary[]>`

**D. The reverse channel SDKAPI (`sdk-api.ts:72-84`, core→client callbacks)**

`emitEvent(event: AgentEvent): void`, `requestApproval(ApprovalRequest{turnId?,toolCallId,toolName,action,display}): Promise<ApprovalResponse{decision,scope?,feedback?,selectedLabel?}>`, `requestQuestion(QuestionRequest{turnId?,toolCallId?,questions}): Promise<QuestionResult>`, `toolCall(ToolCallRequest{turnId?,toolCallId,args}): Promise<ToolCallResponse{output,isError?}>`. Wrapped level by level into `SDKAPI` via `WithAgentId`/`WithSessionId` (`sdk-api.ts:80-84`).

**E. Resume shapes (`resumed.ts`)**: `ResumeSessionResult extends SessionSummary` adds `sessionMetadata: SessionMeta`, `agents: Record<string,ResumedAgentState>`, `warning?`; `ResumedAgentState` (:33-45) holds `replay: AgentReplayRecord[]` (:18-31, members `message|compaction|goal_updated|plan_updated|config_updated|permission_updated|approval_result`).

### 1.2 All members of the v1 Event union (`packages/protocol/src/events.ts:1031-1087`)

`Event = AgentEvent & { agentId: string; sessionId }` (:1087); the zod union `agentEventSchema` is at :1993-2048. 54 members (type literal → interface line):

- General: `error` (ErrorEvent :690), `warning` (WarningEvent :694)
- Status: `agent.status.updated` (:542, with model/thinkingEffort/contextTokens/maxContextTokens/contextUsage/planMode/swarmMode/towerMode/permission/usage/phase, `AgentPhase` :479-540), `session.meta.updated` (:557)
- Session/workspace/global: `event.session.created` (:563), `event.workspace.created/updated/deleted` (:568/:573/:578), `event.session.work_changed` (:584, busy/main_turn_active/pending_interaction/last_turn_reason), `event.session.status_changed` (**@deprecated** :596-606), `event.config.changed` (:608), `event.config.warning` (:623), `event.model_catalog.changed` (:634), `event.plugin.changed` (:645), `event.capability.changed` (:653)
- goal/skill/plugin: `goal.updated` (:665), `skill.activated` (:671), `plugin_command.activated` (:681)
- Turn: `turn.started` (:711, origin/prompt?/promptId?/promptAttachments?), `turn.ended` (:722, reason/error?/durationMs?/interruptReason?), `turn.step.started/completed/retrying/interrupted` (:732/:739/:766/:780)
- Streaming: `assistant.delta` (:789), `thinking.delta` (:803), `tool.call.delta` (:809), `hook.result` (:795)
- Tools: `tool.call.started` (:817), `tool.progress` (:827), `tool.result` (:869), `tool.list.updated` (:1012)
- Shell: `shell.output` (:840), `shell.started` (:851), `shell.completed` (:862) (all transient, see the :834-867 comment)
- Subagents: `subagent.spawned` (:878), `subagent.started` (:903), `subagent.suspended` (:908), `subagent.completed` (:914), `subagent.failed` (:922)
- Compaction: `compaction.started` (:928), `compaction.blocked` (:934), `compaction.cancelled` (:939), `compaction.completed` (:943)
- Tasks: `task.started` (:948), `task.terminated` (:953), `background.task.started` (:964), `background.task.terminated` (:969) (:958-963 comment: v2 emits `task.*`, v1 emits `background.task.*`; both spellings stay in the union)
- cron: `cron.fired` (:974)
- Prompt queue: `prompt.submitted` (:980), `prompt.completed` (:989), `prompt.aborted` (:996), `prompt.steered` (:1002)
- MCP: `mcp.server.status` (:1018)

Volatile events: `VOLATILE_EVENT_TYPES` = assistant.delta, thinking.delta, tool.call.delta, tool.progress, shell.output, shell.started, shell.completed, agent.status.updated, event.capability.changed (`events.ts:2075-2088`, **marked @deprecated**, pointing at kap-server's `isVolatileSignal`).

## 2. Where each method / event went in the v2 ecosystem

### 2.1 The klient facade, in full (`packages/klient`, @moonshot-ai/klient 0.1.2, exports `./ipc`, `./memory`)

Entry shape: `Klient { global, events, session(id) }`; `SessionHandle extends SessionFacade { events, agent(id) }`; `AgentHandle extends AgentFacade { events }` (`packages/klient/src/core/klient.ts:29-43`).

**global.\*** (`core/facade/global.ts:327-340`; each method → service.method in the implementation at :372-654)

| Sub-object | Methods (→ engine service) |
|---|---|
| `sessions` | `list(query)`→sessionIndex.listRecent; `get(id)`→sessionIndex.get; `countActive(ids)`→sessionIndex.count; `create({workDir,additionalDirs?,title?,mcpServers?})`→sessionManager.create + sessionMetadata.setTitle/read (:396-411) |
| `workspaces` | `list/get/createOrTouch/update/delete`→workspaceService.* (:414-422) |
| `config` | `get/getAll/inspect/set/replace/replaceSections/reload/diagnostics`→configService.* (:424-448; clearing a domain with `undefined` is encoded as `null` on the wire, :432-444) |
| `kosong` | `listProviders/getProvider/addProvider/removeProvider/refreshProviders/listModels/setDefaultModel/generate(streaming)`→modelResolver/providerService/modelService/providerDiscovery (:450-510) |
| `auth` | `status/summarize/ensureReady/startLogin/flow/cancelLogin/logout/refreshProviderModels(@deprecated)`→oauthService/authSummaryService (:512-527) |
| `flags` | `list/enabled/enabledIds/explain/snapshot`→flagService (:529-536) |
| `plugins` | `list/info/install/setEnabled/setMcpServerEnabled/remove/reload/checkUpdates/listCommands`→pluginService (:538-552) |
| `capabilities` | `list/get/install`→capabilityService (:554-559) |
| `hostFs` | `browse/home`→hostFolderBrowser (:561-565) |
| `files` | `save/get/delete`→fileService (base64 encode/decode inside the facade, :567-582) |
| `mcp` | `list/get/add/update/remove/test/inspect/authStatuses/resolveByName/beginAuth/completeAuth/cancelAuth/resetAuth`→mcpManagementService (:584-651; completeAuth's IPC timeout clamp :637-646) |
| `env()` | aggregates bootstrapService scalars + clientIdentity.version (:379-393) |

**session(id).\*** (`core/facade/session.ts:85-118`): `get` (sessionMetadata.read), `setTitle`, `generateTitle({force?,source?})` (sessionTitleService), `update(patch)`, `setArchived(archived)`, `status()` (composed from sessionInteractionService.listPending + each agent's agentActivityView.state, :143-167), `close/archive/restore({additionalDirs?,mcpServers?})/delete` (sessionManager.*, :168-174), `fork/createChild({title?,metadata?})` (sessionManager.fork/createChild, :124-131,175-176), sub-objects `approvals.{list,decide}`, `questions.{list,answer,dismiss}`, `interactions.{list,respond}`, `skills.list` (sessionSkillCatalog), `agents()` (reads the metadata registry, :211-214).

**agent(id).\*** (`core/facade/agent.ts:48-105`): `prompt({input,disabledTools?,promptId?})` (agentPromptService.submit), `promptWithSkills` (agentSkillService.promptWithSkills), `steer` (agentPromptService.submitSteer), `activateSkill({name,args?})` (agentSkillService.activate), `cancel({turnId?})` (agentLoopService.cancelFromUser; the `[undefined]→[null]` wire pitfall handled at :117-120), `runShellCommand/cancelShellCommand` (agentShellCommandService), `getModel/setModel/getThinking/setThinking` (agentProfileService), `setPermission` (agentPermissionModeService.setModeAndBroadcast), `getUsage` (agentUsageService), `getContext()` (client-side merge of agentContextMemoryService.get + agentTokenCountingService.statusSize, :135-141), `listCommands/runCommand` (agentCommandService), `getRuntime/switchRuntime` (agentRuntimeBindingService), `getPlan/enterPlan/clearPlan/cancelPlan` (agentPlanService), `getTasks/stopTask/getTaskOutput` (agentTaskService), `getMcpServers` (agentMcpService), `compact({instruction?})` (agentFullCompactionService.begin, :178-181).

**The klient event vocabulary** (hub: `core/events/hub.ts`)

- Global `klient.events` (`contract/global/events.ts:43-52`): `config.changed`, `config.sectionChanged`, `kosong.providers.changed`, `kosong.models.changed`, `plugins.reloaded`, `session.archived`, `session.metaUpdated`, `kosong.changed` (bindings :94-140: emitter sources configService.onDidChangeConfiguration/onDidSectionChange, providerService.onDidChangeProviders, modelService.onDidChangeModels, pluginService.onDidReload; bus sources `event.session.archived`, `session.meta.updated`, `event.model_catalog.changed`; bus events travel as `{type,payload}` envelopes and the hub unwraps the payload, :176-195)
- `session(id).events` (`contract/session/events.ts:38-44`): `metadata.changed` (sessionMetadata.onDidChangeMetadata), `skills.changed` (sessionSkillCatalog.onDidChange), `interactions.changed` (stream `interactions`, the full pending set), `interactions.resolved` (stream `interactions:resolved`)
- `agent(id).events` (`contract/agent/events.ts:210-230`, 19 events, all filtered to the agent-scoped stream `events` in flat `{type,...}` form): `turn.started`, `turn.ended`, `assistant.delta`, `thinking.delta`, `tool.call.started`, `tool.call.delta`, `tool.progress`, `tool.result`, `prompt.completed`, `prompt.aborted`, `compaction.started/blocked/cancelled/completed`, `permission.approval.requested/resolved` (not in the protocol union, loose schema, :172-186), `error`, `warning`, `agent.status.updated`

### 2.2 CoreAPI method → v2 destination table

Legend: **K** = klient facade; **S** = kap-server REST (`/api/v1` prefix, route file:line); **N** = node-sdk `SDKRpcClientV2` override (`packages/node-sdk/src/sdk-rpc-client-v2.ts:374` onward; base-class methods without an override throw `NOT_IMPLEMENTED` "not wired to agent-core-v2 yet" via `getRpc()`, :612-617).

| v1 CoreAPI | v2 destination |
|---|---|
| `prompt` | K `agent(id).prompt`; S `POST /sessions/{sid}/prompts` (routes/prompts.ts:193); N :1971 |
| `steer` | K `agent(id).steer`; S `POST /sessions/{sid}/prompts::steer` (prompts.ts:374) and `{prompt_id}:steer` (:452-455); N :2001 |
| `cancel` | K `agent(id).cancel`; S `POST /sessions/{sid}:abort` (sessionActions.abort at sessions.ts:870-878); N :1861 |
| `undoHistory` | no klient facade; S `POST /sessions/{sid}:undo`; N :1910 (engine IAgentConversationUndoService) |
| `runShellCommand`/`cancelShellCommand` | K same names; N :2016/:2026; S no dedicated route (goes through the terminal/task surface; **unverified**: no REST counterpart found) |
| `setModel`/`getModel` | K `agent(id).setModel/getModel`; S `POST /sessions/{sid}/profile` (sessions.ts:495, via sessionProfile.ts); N :1734 (getModel unverified, no override seen) |
| `setThinking` | K `agent(id).setThinking`; S same profile route; N :1746 |
| `setPermission` | K `agent(id).setPermission`; S same profile route; N :1751 |
| `enterPlan`/`cancelPlan`/`clearPlan`/`getPlan` | K `agent(id).enterPlan/cancelPlan/clearPlan/getPlan`; N base class `setPlanMode` (rpc.ts:677, getRpc throws under V2 → **unverified**: no enterPlan/cancelPlan override seen in SDKRpcClientV2, but getPlan :1763 and clearPlan :1768 exist) |
| `enterSwarm`/`exitSwarm`/`getSwarmMode` | no klient facade; engine side is the durable ops `swarm_mode.enter/exit` (features/swarm/swarmOps.ts:17/29); N base class `setSwarmMode` (rpc.ts:691, throws NOT_IMPLEMENTED under V2) → **not wired in v2** |
| `beginCompaction` | K `agent(id).compact`; S `POST /sessions/{sid}:compact`; N base class `compact` (rpc.ts:744, not overridden under V2, **unverified**) |
| `cancelCompaction` | no klient facade; N :1888 |
| `registerTool`/`unregisterTool` | no klient facade; engine ops `tools.register_user_tool/tools.unregister_user_tool` (agent/userTool/userToolOps.ts:23/39); N not seen → **unverified** |
| `setActiveTools` | no klient facade; engine ops `tools.set_active_tools/reset_active_tools` (agent/profile/profileOps.ts:96/110); N not seen → **unverified** |
| `stopBackground` | K `agent(id).stopTask`; S `POST /sessions/{sid}/tasks/{task_id}:cancel` (tasks.ts:141-166); N base class `stopBackgroundTask` (rpc.ts:896) |
| `detachBackground` | no klient facade; S `POST .../tasks/{task_id}:detach` (tasks.ts:164); N base class `detachBackgroundTask` (rpc.ts:908) |
| `getBackground`/`getBackgroundOutput` | K `agent(id).getTasks/getTaskOutput`; S `GET /sessions/{sid}/tasks` (tasks.ts:61), `GET .../tasks/{task_id}` (:94); N base class `listBackgroundTasks/getBackgroundTaskOutput` (rpc.ts:872/884) |
| `clearContext` | no klient facade; engine op `context.clear`; N :1921 |
| `importContext` | no native v2 engine capability; N :1937 byte-level re-creation of the v1 message via `v2/import-context.ts` (see §3.4) |
| `activateSkill` | K `agent(id).activateSkill`; S `POST /sessions/{sid}/skills/{name}:activate` (skills.ts:183-205); N :2044 |
| `activatePluginCommand` | N :2060; klient unverified (agent(id).runCommand is agentCommandService, a different thing) |
| `startBtw` | S `POST /sessions/{sid}:btw`; N :2129 |
| `createGoal/getGoal/pauseGoal/resumeGoal/cancelGoal` | no klient facade; engine ops `goal.create/update/clear` + notification `goal.updated` (features/goal/goalOps.ts); S `GET /sessions/{sid}/goal` (sessions.ts:782, read-only); N :2199-2221 |
| `getCronTasks` | N :2236; engine ops `cron.add/delete/cursor/fired` (features/cron/cronOps.ts) |
| `getContext` | K `agent(id).getContext` (two reads merged); N :1805 |
| `getConfig` (AgentConfigData)/`getPermission`/`getTools` | no klient facade; N no override seen → **unverified** |
| `getPlan`/`getUsage` | K `agent(id).getPlan/getUsage`; N :1763/:1810 |
| `renameSession` | K `session(id).setTitle`; S no dedicated rename route seen (carried by `POST /sessions/{sid}/profile` or the metadata surface, **unverified**); N :1380 (temporary resume→modify→close pattern) |
| `updateSessionMetadata`/`getSessionMetadata` | K `session(id).update/get`; N :1583/base class |
| `listSkills` | K `session(id).skills.list`; S `GET /sessions/{sid}/skills` (skills.ts:115); N :1644 |
| `listPluginCommands` | K `global.plugins.listCommands`; N :900 |
| `listMcpServers` | K `agent(id).getMcpServers`; S `GET /mcp/servers` (tools.ts:83); N :2627 |
| `getMcpStartupMetrics` | no klient facade; N :2648 |
| `reconnectMcpServer` | no klient facade; S `POST /mcp/servers/{name}:restart` (tools.ts:106-122); N :2663 (via the session connection manager, validated in v2/global-mcp.ts) |
| `generateAgentsMd`/`getSessionWarnings` | N :2080/:2096; S `GET /sessions/{sid}/warnings` (sessions.ts:811) |
| `waitForBackgroundTasksOnPrint`/`handlePrintMainTurnCompleted` | print-mode only; N :2324/:2343 (printSteerStates :399) |
| `addAdditionalDir` | S `POST /workspaces/{wid}/add-dir` (workspaces.ts:278); N :1600 |
| `applyPersistedSecondaryModel` | no v2 counterpart seen → **unverified** |
| `getCoreInfo` | S `GET /meta` (meta.ts:48, a superset: serverVersion/flags/features); N not seen → **unverified** (the SDK may not expose the version through this method) |
| `getExperimentalFeatures` | K `global.flags.list/explain/snapshot`; S the flags section of `GET /meta`; N :619 |
| `getKimiConfig` | K `global.config.get/getAll`; S `GET /config` (config.ts:34); N :745 (`getConfig`, via v2/config-mapper.ts, see §3.3) |
| `setKimiConfig` | K `global.config.set/replace/replaceSections`; S `POST /config` (config.ts:50); N base class `setConfig`/`replaceConfigSections` (rpc.ts:346/372, **unverified** where the V2 override is) |
| `getConfigDiagnostics` | K `global.config.diagnostics`; N :753 (flattened into warning strings) |
| `removeKimiProvider` | K `global.kosong.removeProvider`; S `DELETE /providers/{provider_id}` (modelCatalog.ts:584); N base class `removeProvider` (rpc.ts:351) + the config-mapper cascade plan (§3.3) |
| The global MCP CRUD/inspect/auth family (13 methods) | K `global.mcp.*` (one-to-one, including `resolveByName` resolving legacy name→locator); S under **`/api/v2`**: `GET/POST /mcp/servers`, `GET/PUT/DELETE /mcp/servers/{name}`, `POST /mcp/servers::test`, `::inspect`, `GET /mcp/auth-statuses`, `POST /mcp/auth::begin/::complete/::cancel/::reset` (routes/v2/mcp.ts:217-525); N :2453-2598 overrides each |
| `addSessionMcpServer` | N :2697 (session connection manager + persist via the engine IMcpConfigStore, see the v2/global-mcp.ts:1-14 comment) |
| `createSession` | K `global.sessions.create`; S `POST /sessions` (sessions.ts:180); N :1320/doCreateSession :1330 |
| `closeSession`/`archiveSession`/`deleteSession` | K `session(id).close/archive/setArchived/delete`; S `POST /sessions/{sid}:archive` (actions) etc.; N :1444/:1460 (archive unverified) |
| `resumeSession` | K `session(id).restore`; S `POST /sessions/{sid}:restore`; N :1489 (replay rebuild in §3.5) |
| `reloadSession` | N :1517 |
| `forkSession` | K `session(id).fork` (note: v1's `turnIndex` truncation parameter does not exist in K's input, only `{title?,metadata?}`); S `POST /sessions/{sid}:fork`; N :1419 |
| `listSessions` | K `global.sessions.list` (returns a paginated `Page<SessionSummary>`; v1 was an array); S `GET /sessions` (sessions.ts:271); N :1215 |
| `exportSession` | S `POST /sessions/{sid}/export` (sessionExport.ts:48); N :1624 |
| `listWorkspaceSkills` | S `GET /workspaces/{wid}/skills` (skills.ts:147); N :648 (via IWorkspaceInstanceManager) |
| `listPlugins/installPlugin/setPluginEnabled/setPluginMcpServerEnabled/removePlugin/reloadPlugins/getPluginInfo` | K `global.plugins.*`; S `GET/POST /plugins`, `POST /plugins/{id}:enable/:disable/:remove` (plugins.ts:52-56, 236-287); N :825-855 |
| Interaction replies (reverse channel) `requestApproval`/`requestQuestion`/`toolCall` | v2 switched to a pull-style interaction kernel: durable ops `interaction.request`/`interaction.resolved` (features/interaction/interactionOps.ts:31/52), facades `session(id).approvals.{list,decide}`, `questions.{list,answer,dismiss}`, `interactions.{list,respond}`; S `GET/POST /sessions/{sid}/approvals[/{aid}]` (approvals.ts:61/91), `GET /sessions/{sid}/questions` + `POST {qid}(:resolve|:dismiss)` (questions.ts:68/98/118-123/199-202); N bridged back to v1 push-style callbacks by `SessionEventWiring` (see §3.1) |

### 2.3 The v2 engine event vocabulary (Event2, 113 unique types)

Infrastructure: the `Event2` base class (`packages/agent-core-v2/src/app/event/event2.ts:22-47`), the static flags `durable` (default false; durable events must declare a zod schema and register into `EVENT2_REGISTRY`, :68-85), `observable` (default false), `agentDomain` (`AgentEvent2`, :53-57). Buses: `IEventBus.publish(event, agent?)`, `ISessionEventBus.onAgent(...)` (`eventBus.ts:7-35`); the implementations are `EventBusService` (session scope) and `AgentEventBusView` (agent scope, filtered by agentId/source) (`eventBusService.ts:12-196`). The process-level `IEventService` (`event.ts:7-16`) carries global facts as `{type,payload}` envelopes. Grouped by domain below (type → Class@file:line, flags d=durable / o=observable; unflagged means both false):

- **turn/loop** (agent/loop/): `turn.started` TurnStarted@turnEvents.ts:43 o; `turn.step.started` :108 o; `turn.step.completed` :131 o; `turn.step.interrupted` :155 d; `turn.step.retrying` :191 d; `assistant.delta` :205 o; `thinking.delta` :217 o; `tool.call.delta` :231 o; `turn.prompt` TurnPrompt@turnOps.ts:44 d; `turn.steer` :58 d; `turn.cancel` :77 d; `turn.ended` :108 d
- **tool** (agent/toolExecutor/toolExecutorEvents.ts): `tool.call.started` :17 o; `tool.progress` :30 o; `tool.result` :45 o
- **prompt queue** (agent/prompt/): `prompt.accepted` PromptAccepted@promptOps.ts:14 d+o; `prompt.completed` PromptCompleted@promptService.ts:72 d+o; `prompt.aborted` PromptAborted@promptService.ts:92 d+o; `prompt.steered` :116 d; `prompt.queued` :147 o; `prompt.submitted` :162 o; `prompt.started` :173 o
- **context** (agent/contextMemory/contextEvents.ts): `context.append_message` :20 d; `context.append_loop_event` :37 d; `context.clear` :49 d; `context.apply_compaction` :95 d; `context.undo` :106 d; `context.spliced` :124 o
- **compaction** (agent/fullCompaction/compactionOps.ts): `full_compaction.begin` :30 d; `full_compaction.cancel` :43 d; `full_compaction.complete` :56 d; `compaction.started` :71 o; `compaction.blocked` :82 o; `compaction.cancelled` :88 o; `compaction.completed` :101 o
- **task** (agent/task/taskOps.ts): `task.started` TaskStarted@:17 d+o; **`task.terminated` has two same-named classes**: `TaskTerminated`@:34 d (with `outputTail?`) and `TaskTerminatedNotice`@:50 o; `task.notified` TaskNotified@:56 o; `task.waitDelivered` :67 d
- **usage/status**: `usage.record` @agent/usage/usageOps.ts:21 d; `agent.status.updated` @agent/usage/usageEvents.ts:19 o
- **mcp** (agent/mcp/): `mcp.tools_discovered` mcpDiscoveryOps.ts:39 d; `mcp.server.status` mcpEvents.ts:19 o; `tool.list.updated` :33 o; `error` :39 o
- **profile/config** (agent/profile/profileOps.ts): `profile.bind` :39 d; `config.update` :73 d; `tools.set_active_tools` :96 d; `tools.reset_active_tools` :110 d; `warning` :125 o
- **permission**: `permission.set_mode` permissionModeOps.ts:14 d; `permission.rules.add` permissionRulesOps.ts:19 (no flags); `permission.record_approval_result` :37 d; `permission.approval.requested` toolApprovalService.ts:44 o; `permission.approval.resolved` :58 o
- **plan/swarm/tower**: `plan_mode.enter/cancel/exit` planOps.ts:19/34/49 d; `plan.revision` :77 d; `swarm_mode.enter/exit` swarmOps.ts:17/29 d; `tower_mode.enter/exit` towerOps.ts:15/28 d
- **goal** (features/goal/goalOps.ts): `goal.create` :55 d; `goal.update` :86 d; `goal.clear` :106 d; `forked` :117 d (type has no namespace); `goal.updated` :132 o
- **subagent**: `subagent.spawned/started/completed/failed` mirrorAgentRun.ts:35/45/58/69 o; `subagent.suspended` sessionSwarmService.ts:43 o
- **skill/plugin/hook/cron/interaction**: `skill.activated` skillOps.ts:16 o; `plugin_command.activated` pluginCommand.ts:21 o; `plugin.session_start` agentPluginOps.ts:20 d; `hook.result` agentExternalHooksService.ts:57 o; `cron.add/delete/cursor` cronOps.ts:29/40/52 d, `cron.fired` :64 o; `interaction.request/resolved` interactionOps.ts:31/52 d
- **shell** (agent/shellCommand/shellCommandService.ts): `shell.output` :33 o; `shell.started` :45 o; `shell.completed` :58 o
- **other agent domains**: `runtime.set_binding` runtimeBindingOps.ts:15 d; `interruptionReminder.recorded` interruptionReminderOps.ts:19 d; `llm.tools_snapshot`/`llm.request` llmRequestOps.ts:31/67 d; `token_counting.measured/truncated/rebased/turn_recorded` tokenCountingOps.ts:24/35/48/62 d; `context.undone` undoService.ts:43 o; `tools.register_user_tool/unregister_user_tool` userToolOps.ts:23/39 d; `agent.activity.updated` activityView.ts:76 o; `tools.update_store` todoOps.ts:17 d; `file_history.tracked/checkpoint` fileHistoryOps.ts:33/54 d
- **session/global envelope facts** (none carry d/o flags; they travel as `IEventService` `{type,payload}` envelopes): `session.meta.updated` SessionMetaUpdated@session/sessionMetadata/sessionMetaEvents.ts:15 (payload shape :4-13); `event.session.created/archived` workspace/sessionLifecycle/sessionLifecycleEvents.ts:23/10; `event.workspace.created/updated/deleted` app/workspace/workspaceEvents.ts:11/22/34; `event.plugin.changed` app/plugin/pluginEvents.ts:5; `event.capability.changed` app/capability/capabilityEvents.ts:12; `event.model_catalog.changed` app/kosongConfig/discovery.ts:35; `event.config.warning/changed` app/config/configEvents.ts:14/26; `event.di.unit_changed` debug/debugCascade.ts:44

### 2.4 v1 event → v2 destination

- **Same-name pass-through** (a same-named entry exists on the v2 IEventBus, broadcast via kap-server or translated by node-sdk): `turn.started/ended`, `turn.step.*`, `assistant.delta`, `thinking.delta`, `tool.call.delta/started`, `tool.progress`, `tool.result`, `compaction.*` (4), `subagent.*` (5), `skill.activated`, `plugin_command.activated`, `hook.result`, `cron.fired`, `goal.updated`, `mcp.server.status`, `tool.list.updated`, `shell.output/started/completed`, `error`, `warning`, `agent.status.updated`, `task.started/task.terminated`, `prompt.submitted/completed/aborted/steered`, `session.meta.updated`, `event.session.created`, `event.workspace.*`, `event.config.changed/warning`, `event.model_catalog.changed`, `event.plugin.changed`, `event.capability.changed`
- **Renamed**: `task.started→background.task.started`, `task.terminated→background.task.terminated` (the v1 spellings; kap-server fans out both spellings, node-sdk translates back to the legacy spelling only — see §3.1)
- **In v1 but with no v2 engine counterpart**: `event.session.status_changed` (@deprecated in protocol, :596-606), `event.session.work_changed` (in v2 synthesized at the WS edge by kap-server's `ISessionActivityView`, broadcaster `enqueueWorkChanged`, sessionEventBroadcaster.ts:985-1005; nothing seen on the node-sdk in-process path → **unverified** whether the SDK synthesizes it)
- **New in v2 (synthesized at the WS edge, not in the v1 union)**: `agent.created`/`agent.disposed` (broadcaster :831-850, synthesized from IAgentLifecycleService.onDidCreate/onDidClose), `event.question.requested/dismissed/answered`, `event.approval.requested/resolved` (synthesized from interaction-kernel changes, :1217-1285), `event.session.archived`, `event.di.unit_changed`
- **v2-internal, never crossing the boundary**: `agent.activity.updated` (folded into the phase slice of `agent.status.updated` in kap-server, :893-908; dropped outright by node-sdk), `context.spliced`, `task.notified`, `plan.revision`, `permission.approval.*`, `prompt.accepted`, and all durable ops (`turn.prompt/steer/cancel`, the `context.*` ops, `full_compaction.*`, `profile.bind`, `config.update`, `permission.set_mode/rules.add/record_approval_result`, `llm.*`, `token_counting.*`, `usage.record`, `tools.*`, `cron.add/delete/cursor`, `interaction.request/resolved`, `plan_mode.*`, `swarm_mode.*`, `tower_mode.*`, `goal.create/update/clear`, `forked`, `task.waitDelivered`, `mcp.tools_discovered`, `plugin.session_start`, `interruptionReminder.recorded`, `file_history.*`, `runtime.set_binding`, `prompt.queued/started`, etc.)

### 2.5 The kap-server surface (packages/kap-server)

- REST `/api/v1` registration: `routes/registerApiV1Routes.ts:78-203` (healthz, meta, auth, oauth, config, modelCatalog, sessions, runtime, sessionExport, skills, capabilities, plugins, messages, search, tasks, approvals, questions, prompts, workspaces, workspaceFs, files, sessionMedia, fs, guiStore, tools, fileHistory, terminals, connections, snapshot, transcript, shutdown); `/api/v2`: `routes/registerApiV2Routes.ts:13-21` (`GET /sessions` from v2/sessions, the full v2/mcp set).
- Route style: static paths + `POST …/{tail}` action suffixes (`routes/action-suffix.ts` parses `{id}:{action}`; the ActionTable in `action-dispatch.ts`). Action tables: sessionActions=`fork|compact|undo|abort|btw|restore|archive` (sessions.ts:857-878); promptActions=`abort|steer` (prompts.ts:452); pluginActions=`enable|disable|remove` (plugins.ts:52); questionActions=`resolve|dismiss` (questions.ts:199, default resolve); providerCollectionActions=`refresh_oauth|refresh|import_catalog|import_registry` (modelCatalog.ts:826-834); plus direct `parseActionSuffix` lookups: model `set_default` (:185), provider `refresh` (:518), terminal `close` (terminals.ts:184), capability `install` (capabilities.ts:108), task `cancel|detach` (tasks.ts:164), mcp_server `restart` (tools.ts:120), skill `activate` (skills.ts:203), fs `list|read|list_many|stat|stat_many|mkdir|search|grep|git_status|diff|open|open-in|reveal` (fs.ts:115-129).
- WS v1: frame vocabulary in `packages/protocol/src/ws-control.ts` (client_hello/subscribe/unsubscribe/watch_fs_add/watch_fs_remove/abort/terminal_attach/detach/input/resize/close/ping + server-side ack/server_hello/pong/resync_required/error/terminal_output/terminal_exit); the connection handler additionally supports `subscribe_v2/unsubscribe_v2` (transport/ws/v1/wsConnectionV1.ts:163-183).
- **The Event2→WS event mapping rules of `SessionEventBroadcaster` (transport/ws/v1/sessionEventBroadcaster.ts)** (the other v1-compatibility edge, parallel to node-sdk):
  - drops `prompt.accepted` (:891);
  - `agent.activity.updated` → folded into the phase slice of `agent.status.updated` (`toLegacyPhase`, services/legacyStatus/legacyStatus.ts:129; :893-908); `agent.status.updated` carrying its own phase is not forwarded (:909-914);
  - `agent.status.updated` merged with the `readLegacyStatus(handle)` snapshot (usage/context/model etc., :867-876; legacyStatus.ts:84); the main agent's `context.spliced` triggers one legacy status re-send (:877-879);
  - `turn.started` stripped of `promptAttachments` (:917-921);
  - `content` of `prompt.steered/queued/submitted` projected via `projectPromptContentParts` (:922-928);
  - `task.started/terminated` get an **additional** legacy `background.task.*` event appended (`legacyTaskEvent`, :1110-1115);
  - the interaction kernel → `event.question.requested/answered/dismissed`, `event.approval.requested/resolved` (durable, :944-977, 1217-1285);
  - `ISessionActivityView` → `event.session.work_changed` (:791-815, 985-1005);
  - global bus envelopes (`onCoreEvent`, :616-766): `event.session.created/archived`, `event.workspace.*` (via `toWireWorkspace`), `session.meta.updated`, `event.plugin.changed`, `event.capability.changed`, `event.config.warning/changed` (zod-validated payloads), `event.model_catalog.changed`, `event.di.unit_changed` — all stamped with `agentId:'main'` and sessionId (`__global__` for global events, :127);
  - volatile classification: `isVolatileSignal` (agent events, :1093-1108: assistant/thinking/tool.call.delta, tool.progress, shell.*, agent.status.updated) and the local `isVolatileEventType` (transport/ws/v1/events.ts:238-257, additionally covering event.di.unit_changed, event.capability.changed); volatile events do not enter the journal and carry no new seq (`dispatch`, :1024-1042); the journal lives in `sessionEventJournal.ts`, resync logic in `getBufferedSince` (:420-466);
  - transcript projection suppression: `TRANSCRIPT_PROJECTED_EVENT_TYPES` (:1147-1198) are replaced by `transcript.ops/reset` when a transcript level is subscribed.

## 3. The node-sdk v2 mapping layer in detail (packages/node-sdk/src/v2/)

### 3.1 event-mapper.ts (Event2 → v1 Event, all 95 lines verified)

- **`DROPPED_DOMAIN_EVENT_TYPES`** (:31-44, 12 entries): `agent.activity.updated`, `context.spliced`, `task.notified`, `plan.revision`, `permission.approval.requested`, `permission.approval.resolved`, `prompt.accepted`, `prompt.submitted`, `prompt.completed`, `prompt.aborted`, `prompt.started`, `prompt.steered` (comment :20-30: the first 6 have no v1 counterpart; `prompt.*` in v1 was synthesized by the daemon service layer onto the global IEventService, so the in-process SDK never saw them).
- **`RENAMED_DOMAIN_EVENT_TYPES`** (:52-55): `task.started→background.task.started`, `task.terminated→background.task.terminated` (same payload fields).
- **`translateDomainEvent(event, sessionId, agentId)`** (:65-79): dropped → `undefined`; renames; `turn.started` additionally **strips `promptAttachments`** (:72-77); all other fields pass through, only **stamping `sessionId`/`agentId`** (the v2 per-agent bus does not carry them; kap-server stamps at the same place, comment :4-15); casts only bridge type declarations.
- **`translateGlobalEvent(event)`** (:89-95): only passes `session.meta.updated` from the global IEventService, **unwrapping** the `{type, payload}` envelope into `{type, ...payload}`; every other global type → `undefined`.
- Wiring (`session-wiring.ts`):
  - `SessionEventWiring` (:106-151) subscribes to `IEventBus` for every live agent at wiring time plus future onDidCreate agents, translates, and feeds `sink.receiveEvent` (synchronous, in emission order, comment :1-24);
  - **the `agent.status.updated` field completion `withStatusSnapshot`** (:283-312): every status event is merged at the boundary with `usage` (ISessionUsageService.status), `contextTokens` (ISessionTokenCountingService.statusSize), `maxContextTokens` (profile.getModelCapabilities' max_input_tokens ?? max_context_tokens), `contextUsage` (the ratio, when finite and >0), `model` (profile.getModel) — because v2 emits status in independent slices and the model slice is only emitted on bind, which subagents would never see; mirrors kap-server's readLegacyStatus (comment :273-282);
  - **the interaction bridge** (:175-269): listens to `onSessionInteractionDidChangePending`, dispatches by `interaction.kind`: `approval`→`sink.requestApproval` (stripping the extra v2 fields id/sessionId/agentId; agentId falls back to `interaction.origin.agentId ?? MAIN_AGENT_ID`) → `ISessionApprovalService.decide`; `question`→`sink.requestQuestion`→ answer/dismiss (dismissed when result is null); `user_tool`→`sink.toolCall`→`respondSessionInteraction`; the kernel's respond no-ops on a vanished id, so late replies are safe (comments :21-23, 215-218).
  - The global-event subscription is in the `SDKRpcClientV2` constructor (sdk-rpc-client-v2.ts:477-496): only `session.meta.updated` is translated; `followSessionLifecycles` additionally unwires on engine-side close.

### 3.2 session-mapper.ts shape-difference list (all 97 lines verified)

- `normalizeWorkDir` (:30-35): a mirror of v1 `normalizeWorkDir` (Windows paths go through win32.resolve + forward-slash folding; everything else resolves against process cwd), copied because of the test-alias limitation; must stay byte-identical to v1 `agent-core/session/store/workdir-key`.
- **`v2SummaryToSessionSummary(summary, facts)`** (:44-61): v2 `ISessionIndex`'s `SessionSummary` → v1 `SessionSummary`. Differences:
  - `custom` → renamed `metadata` (:57);
  - `workDir`/`sessionDir`/`additionalDirs` are **not carried by the v2 index** and are pre-resolved by the caller as `SessionSummaryFacts` (:38-42, from ISessionContext / IBootstrapService.sessionDir / the workspace catalog, header comment :1-11);
  - pass-through: id/title/lastPrompt/createdAt/updatedAt/archived;
  - **extra output `lastTurnReason: summary.lastTurnReason`** (:59) — v1 agent-core's `SessionSummary` (core-api.ts:186-197) has no such field; only node-sdk's own extension type in `#/types` does → **unverified**: the SessionSummary definition in `packages/node-sdk/src/types.ts` (that file was not read).
- **`v2MetaToSessionMeta(meta)`** (:68-80): v2 `SessionMeta` → v1 `SessionMeta`.
  - timestamps: epoch ms → ISO strings (`new Date(...).toISOString()` :70-71);
  - `title`: defaults to `''`; `isCustomTitle` derived from `meta.titleKind === 'custom'` (:72-73);
  - `cwd` → renamed `workDir` (:76);
  - `custom` → kept under the same name, defaults to `{}` (:78);
  - `agents` mapped one by one (:82-97): `type` fallback (`main`→'main', everything else→'sub', covering old documents written before the v2 registered types existed); `parentAgentId` filled with v1's explicit null via `?? null`; `homedir`/`swarmItem` pass through;
  - pass-through: lastPrompt, forkedFrom.

### 3.3 config-mapper.ts (158 lines verified)

- `KIMI_CONFIG_DOMAINS` (:23-47, 23 domains): providers, defaultProvider, defaultModel, models, thinking, planMode, yolo, defaultPermissionMode, defaultPlanMode, permission, hooks, services, mergeAllAvailableSkills, extraSkillDirs, loopControl, background, subagent, secondaryModel, mcp, image, modelCatalog, experimental, telemetry — i.e. all v1 top-level fields except `raw`; v1 field names map 1:1 onto v2 camelCase config domains, and the read mapping is field picking (:56-65); v2-only domains (cron, tools, extraAgentDirs…) are **dropped**; `raw` passthrough and v2 materialized defaults are listed in the parity KNOWN_DIFFS (:11-14).
- `diagnosticsToConfigDiagnostics` (:80-84): v2 structured `{domain,severity,message}` → v1 flat `warnings: string[]` (message only).
- `planProviderRemoval`/`removeProviderFromConfig` (:86-158): re-creates v1 removeKimiProvider's cascade (delete the provider entry, delete models pointing at it, clear defaultModel/defaultProvider when dangling; input is `inspect().userValue`, the user-layer value; `[secondary_model]` deliberately untouched, :102-106); the v2 engine's own `providerService.delete` only clears the defaultProvider pointer — the cascade is re-enacted on the SDK side.

### 3.4 import-context.ts / global-mcp.ts (verified)

- import-context.ts: the v2 engine has no importContext capability, so the SDK composes v2 primitives: `buildImportContextMessage` (:46-77) byte-level re-creates v1's wrapper text (`IMPORT_CONTEXT_GUIDANCE`, `escapeXml`/`escapeXmlAttr`) and the empty content/source `request.invalid` rejections (`import_content_empty`/`import_source_empty`); `assertImportFits` (:85-110) re-creates the overflow gate (same character estimator, `CONTEXT_OVERFLOW` + `import_context_overflow` details).
- global-mcp.ts: `mcpConfigWithoutName`/`parseInlineMcpServer`/`parseReconnectMcpServerConfig`/`normalizeServerName` (:24-67) — v1 validation text and `McpServerConfigSchema` reused; `addSessionMcpServer`'s `persist:true` goes through the engine's App-level `IMcpConfigStore` (header comment :8-13).

### 3.5 resume-replay.ts (142 lines verified)

- `foldAgentWireReplay(wirePath)` (:104-121): reads v2's per-agent `<sessionDir>/agents/<agentId>/wire.jsonl` and folds it through v1's native restore pipeline with a **one-shot v1 `Agent`** + read-only `ReadOnlyAgentRecordPersistence` (:81-97), producing `{replay, toolStore}`; any failure degrades to an empty fold.
- Record type → replay record mapping (comment :20-46): `context.append_message` (and assistant/tool messages assembled from `context.append_loop_event`) → `{type:'message'}`; `full_compaction.begin`→`{type:'compaction',instruction}`, `context.apply_compaction` fills the result, `full_compaction.cancel` marks `'cancelled'`; `goal.create/update`→`goal_updated`; `plan_mode.enter`→`plan_updated{enabled:true}`, `plan_mode.cancel/exit`→false; `config.update`→`config_updated` (with the original type/time fields, a v1 quirk); `permission.set_mode`→`permission_updated`; `permission.record_approval_result`→`approval_result`; `tools.update_store`→no replay record, last-wins into toolStore; the rest (metadata, turn.*, usage.record, tools.set_active_tools, context.update_token_count) only rebuild state; v2-only ops (profile.bind, plan.revision, task.started/terminated, skill.activate, interaction.*, token_counting.*, llm.*) pass through the v1 restore switch untouched — two consequences: a v2 profile bind never appears as a `config_updated` replay record (v1 writes `config.update`, v2 writes `profile.bind`; listed in the parity KNOWN_DIFFS); background tasks do not come from this fold (the caller reads them from the live agent scope).

## Open verification items

1. `packages/node-sdk/src/types.ts` was not read: SDK-owned extension shapes such as `SessionSummary.lastTurnReason` and `SessionStatus` must be checked against that file (the output field at session-mapper.ts:59 does not exist in the v1 agent-core type).
2. Whether the v1 methods without a `SDKRpcClientV2` override (getModel, enterPlan/cancelPlan, compact, setSwarmMode, registerTool/unregisterTool/setActiveTools, getTools, getConfig (agent-level), getPermission, archiveSession, getCoreInfo, applyPersistedSecondaryModel, setKimiConfig) really end at the base class `getRpc()` throwing `NOT_IMPLEMENTED` (sdk-rpc-client-v2.ts:612-617) — the base class `SDKRpcClientBase` (rpc.ts:183) defaults were spot-checked for setPlanMode/setSwarmMode/compact (:677-746), all `await this.getRpc()` patterns, but not every method was checked; `getCoreInfo` has no grep hit anywhere in node-sdk/src.
3. `runShellCommand/cancelShellCommand` have no kap-server REST counterpart found (only route registration and action tables were checked; the terminals surface is a separate one).
4. `event.session.work_changed` synthesis was not seen on the node-sdk in-process path (only the kap-server broadcaster synthesizes it); whether SDK users receive this event is unconfirmed.
5. The durable/observable flags of individual Event2 classes were read from grep context lines; `permission.rules.add` (permissionRulesOps.ts:19-21) and all global envelope classes confirmed flagless (neither durable nor observable); `prompt.queued/submitted/started` showed only `observable` lines — whether they are also durable was not confirmed one by one.
6. The payload contract of kap-server WS's `subscribe_v2/unsubscribe_v2` frames (wsConnectionV1.ts:171-176) was not expanded (the corresponding schema lines in protocol/ws-control.ts were not recorded).
7. **Post-baseline drift (unverified)**: every `packages/protocol/...` reference in this document was verified at the declared baseline `ccf3d5d6`; in the current workspace checkout (main after #3542) the `packages/protocol` package no longer exists at that location (its content moved, e.g. kap-server-side `src/protocol/`). The mapping statements remain baseline facts; the package's post-baseline relocation is pending verification.
