# 事件与 RPC 映射:v1 CoreAPI / Event → v2 生态

日期:2026-09-19。代码基线:`ccf3d5d6`(main 上删除 v1 的 #3542 的直接父提交)。此时 v1 `@moonshot-ai/agent-core` 0.15.8 与 v2 `@moonshot-ai/agent-core-v2` 0.4.3 并存;本文所有路径与符号均以该基线逐条核对。文中路径一律从仓库根写起。本文是 [`migration-from-v1.zh-CN.md`](../../migration-from-v1.zh-CN.md) 的子文档;英文原版:[`event-and-rpc-map.md`](event-and-rpc-map.md)。

## 0. 三层边界总览(事实坐标)

| 层 | v1 | v2 |
|---|---|---|
| 进程内调用契约 | `packages/agent-core/src/rpc/core-api.ts` 的 `CoreAPI`(方法对象 + payload) | `packages/klient` 的三级 facade(`global.*` / `session(id).* / agent(id).*`),底层按「服务名 + 方法名 + zod 契约」路由(`packages/klient/src/contract/index.ts:51-94` 的 `globalContract`) |
| 事件推流 | `SDKAPI.emitEvent` 回调(`packages/agent-core/src/rpc/sdk-api.ts:72-77`),`Agent.emitEvent` → `this.rpc?.emitEvent?.(event)`(`packages/agent-core/src/agent/index.ts:725-728`) | 引擎内 `IEventBus`/`ISessionEventBus`/`IEventService`(`packages/agent-core-v2/src/app/event/eventBus.ts:7-35`、`event.ts:7-16`);对外经 kap-server WS 广播或 node-sdk 兼容层 |
| 跨进程 | v1 的 `createRPC` 是内存双向模拟(`packages/agent-core/src/rpc/client.ts:31-105`,JSON 序列化 + `KimiErrorPayload` 错误通道),无网络守护进程 | `packages/klient` 的 ipc/memory 两种 transport(`packages/klient/src/transports/`);`packages/kap-server` 的 REST `/api/v1`、`/api/v2` 与 WS v1 |
| 共享契约包 | `packages/protocol`(@moonshot-ai/protocol):v1 的 `Event` 联合实际住在这里(`packages/agent-core/src/rpc/events.ts:3-51` 只是 re-export) | 同一 protocol 包同时是 kap-server REST/WS 的类型来源(`packages/protocol/src/rest/*`、`ws-control.ts`、`session.ts` 等) |

v1 的 id 注入机制:`CoreAPI = SessionAPIWithId & …`,经由 `WithAgentId`/`WithSessionId` 类型包装(`packages/agent-core/src/rpc/types.ts:13-14`)与运行时 `proxyWithExtraPayload`(`types.ts:16-29`;使用点 `core-impl.ts:444`、`session/index.ts:1285`)把 `sessionId`/`agentId` 合入每个 payload。

## 1. v1 RPC 面全量清单

### 1.1 CoreAPI 方法签名(`packages/agent-core/src/rpc/core-api.ts`)

三层继承:`AgentAPI`(core-api.ts:605-648)→ `SessionAPI extends WithAgentId<AgentAPI>`(:652-666)→ `CoreAPI extends WithSessionId<SessionAPI>`(:670-736)。v1 实现类为 `KimiCore implements PromisableMethods<CoreAPI>`(`core-impl.ts:224`)。

**A. Agent 控制(AgentAPI,`:605-648`,均带 `agentId`+`sessionId`)**

- 回合驱动:`prompt(PromptPayload): void`、`steer(SteerPayload): void`、`cancel(CancelPayload{turnId?}): void`、`undoHistory(UndoHistoryPayload{count}): void`
- shell:`runShellCommand(RunShellCommandPayload{command,commandId?}): Promise<ShellCommandResult{stdout,stderr,isError?,backgrounded?}>`、`cancelShellCommand({commandId}): void`
- 模型/推理/权限:`setModel({model}): SetModelResult{model,providerName?}`、`getModel({}): string`、`setThinking({effort}): void`、`setPermission({mode}): void`
- plan/swarm/compaction:`enterPlan({}): void`、`cancelPlan({id?}): void`、`clearPlan({}): void`、`enterSwarm({trigger}): void`、`exitSwarm({}): void`、`getSwarmMode({}): boolean`、`beginCompaction({instruction?}): void`、`cancelCompaction({}): void`
- 工具注册:`registerTool(RegisterToolPayload{name,description,parameters,disclosure?}): void`、`unregisterTool({name}): void`、`setActiveTools({names}): void`
- 上下文:`clearContext({}): void`、`importContext(ImportContextPayload{content,source}): void`
- 技能/插件命令:`activateSkill({name,args?}): void`、`activatePluginCommand({pluginId,commandName,args?}): void`
- 后台任务:`stopBackground({taskId,reason?}): void`、`detachBackground({taskId}): BackgroundTaskInfo|undefined`、`getBackground({activeOnly?,limit?}): BackgroundTaskInfo[]`、`getBackgroundOutput({taskId,tail?}): string`
- goal/cron/btw:`createGoal({objective,replace?}): GoalSnapshot`、`getGoal({}): GoalToolResult`、`pauseGoal/resumeGoal/cancelGoal({}): GoalSnapshot`、`getCronTasks({}): GetCronTasksResult`、`startBtw({}): string`
- 状态读取:`getContext({}): AgentContextData`、`getConfig({}): AgentConfigData`、`getPermission({}): PermissionData`、`getPlan({}): PlanData`、`getUsage({}): UsageStatus`、`getTools({}): ToolInfo[]`

**B. Session 管理(SessionAPI,`:652-666`)**

`renameSession({title})`、`updateSessionMetadata({metadata: SessionMetadataPatch})`、`getSessionMetadata({}): SessionMeta`、`listSkills({}): SkillSummary[]`、`listPluginCommands({}): PluginCommandDef[]`、`listMcpServers({}): McpServerInfo[]`、`getMcpStartupMetrics({}): McpStartupMetrics`、`reconnectMcpServer({name,config?})`、`generateAgentsMd({})`、`getSessionWarnings({}): SessionWarning[]`、`waitForBackgroundTasksOnPrint({})`、`handlePrintMainTurnCompleted({}): 'finish'|'continue'`、`addAdditionalDir({path,persist}): AddAdditionalDirResult`

**C. Core/全局(CoreAPI,`:670-736`)**

- 会话生命周期:`createSession(CreateSessionPayload): SessionSummary`(:57-72,含 workDir/model/thinking/permission/metadata/mcpServers/additionalDirs/client/drainAgentTasksOnStop/agentProfile/agentFiles)、`closeSession`、`archiveSession`、`deleteSession`、`resumeSession(ResumeSessionPayload): ResumeSessionResult`(:86-100,含 includeSubagents/replayTurnLimit)、`reloadSession({sessionId,forcePluginSessionStartReminder?}): ResumeSessionResult`、`forkSession({sessionId,id?,title?,metadata?,turnIndex?}): ResumeSessionResult`、`listSessions({workDir?,sessionId?,includeArchive?}): SessionSummary[]`、`exportSession(ExportSessionPayload): ExportSessionResult`、`applyPersistedSecondaryModel({sessionId})`
- 配置:`getKimiConfig({reload?}): KimiConfig`、`setKimiConfig(KimiConfigPatch): KimiConfig`、`getConfigDiagnostics({}): ConfigDiagnostics`、`removeKimiProvider({providerId}): KimiConfig`、`getCoreInfo({}): CoreInfo{version}`、`getExperimentalFeatures({}): ExperimentalFeatureState[]`
- 全局 MCP 管理:`listGlobalMcpServers/getGlobalMcpServer/addGlobalMcpServer/updateGlobalMcpServer/removeGlobalMcpServer`(CRUD,返回 `McpManagedServerInfo[]`)、`listGlobalMcpServerAuthStatuses({cwd?,verify?})`、`inspectAppMcpServers({targets?,cwd?}): AppMcpServerInspection[]`、`beginGlobalMcpServerAuth/beginMcpServerAuth: BeginGlobalMcpServerAuthResult`、`completeGlobalMcpServerAuth/completeMcpServerAuth({flowId,timeoutMs?})`、`cancelGlobalMcpServerAuth/cancelMcpServerAuth({flowId})`、`resetGlobalMcpServerAuth/resetMcpServerAuth`、`testGlobalMcpServer({name?|server?,cwd?}): GlobalMcpServerTestResult`、`addSessionMcpServer({server,persist?}+sessionId): McpServerInfo`
- 插件:`listPlugins/installPlugin({source})/setPluginEnabled({id,enabled})/setPluginMcpServerEnabled({id,server,enabled})/removePlugin({id})/reloadPlugins({}): ReloadPluginsResult/getPluginInfo({id}): PluginInfo`
- 其他:`listWorkspaceSkills({workDir}): Promise<SkillSummary[]>`

**D. 反向通道 SDKAPI(`sdk-api.ts:72-84`,core→client 回调)**

`emitEvent(event: AgentEvent): void`、`requestApproval(ApprovalRequest{turnId?,toolCallId,toolName,action,display}): Promise<ApprovalResponse{decision,scope?,feedback?,selectedLabel?}>`、`requestQuestion(QuestionRequest{turnId?,toolCallId?,questions}): Promise<QuestionResult>`、`toolCall(ToolCallRequest{turnId?,toolCallId,args}): Promise<ToolCallResponse{output,isError?}>`。经 `WithAgentId`/`WithSessionId` 逐层包装成 `SDKAPI`(`sdk-api.ts:80-84`)。

**E. resume 形状(`resumed.ts`)**:`ResumeSessionResult extends SessionSummary` 增加 `sessionMetadata: SessionMeta`、`agents: Record<string,ResumedAgentState>`、`warning?`;`ResumedAgentState`(:33-45)含 `replay: AgentReplayRecord[]`(:18-31,成员 `message|compaction|goal_updated|plan_updated|config_updated|permission_updated|approval_result`)。

### 1.2 v1 Event 联合全部成员(`packages/protocol/src/events.ts:1031-1087`)

`Event = AgentEvent & { agentId: string; sessionId }`(:1087);zod 联合 `agentEventSchema` 在 :1993-2048。54 个成员(类型字面量 → interface 行号):

- 通用:`error`(ErrorEvent :690)、`warning`(WarningEvent :694)
- 状态:`agent.status.updated`(:542,含 model/thinkingEffort/contextTokens/maxContextTokens/contextUsage/planMode/swarmMode/towerMode/permission/usage/phase,`AgentPhase` :479-540)、`session.meta.updated`(:557)
- 会话/工作区/全局:`event.session.created`(:563)、`event.workspace.created/updated/deleted`(:568/:573/:578)、`event.session.work_changed`(:584,busy/main_turn_active/pending_interaction/last_turn_reason)、`event.session.status_changed`(**@deprecated** :596-606)、`event.config.changed`(:608)、`event.config.warning`(:623)、`event.model_catalog.changed`(:634)、`event.plugin.changed`(:645)、`event.capability.changed`(:653)
- goal/skill/plugin:`goal.updated`(:665)、`skill.activated`(:671)、`plugin_command.activated`(:681)
- 回合:`turn.started`(:711,origin/prompt?/promptId?/promptAttachments?)、`turn.ended`(:722,reason/error?/durationMs?/interruptReason?)、`turn.step.started/completed/retrying/interrupted`(:732/:739/:766/:780)
- 流式:`assistant.delta`(:789)、`thinking.delta`(:803)、`tool.call.delta`(:809)、`hook.result`(:795)
- 工具:`tool.call.started`(:817)、`tool.progress`(:827)、`tool.result`(:869)、`tool.list.updated`(:1012)
- shell:`shell.output`(:840)、`shell.started`(:851)、`shell.completed`(:862)(均 transient,见 :834-867 注释)
- 子代理:`subagent.spawned`(:878)、`subagent.started`(:903)、`subagent.suspended`(:908)、`subagent.completed`(:914)、`subagent.failed`(:922)
- 压缩:`compaction.started`(:928)、`compaction.blocked`(:934)、`compaction.cancelled`(:939)、`compaction.completed`(:943)
- 任务:`task.started`(:948)、`task.terminated`(:953)、`background.task.started`(:964)、`background.task.terminated`(:969)(:958-963 注释:v2 发 `task.*`,v1 发 `background.task.*`,两种拼写都留在联合里)
- cron:`cron.fired`(:974)
- prompt 队列:`prompt.submitted`(:980)、`prompt.completed`(:989)、`prompt.aborted`(:996)、`prompt.steered`(:1002)
- MCP:`mcp.server.status`(:1018)

易变事件:`VOLATILE_EVENT_TYPES` = assistant.delta、thinking.delta、tool.call.delta、tool.progress、shell.output、shell.started、shell.completed、agent.status.updated、event.capability.changed(`events.ts:2075-2088`,**已标 @deprecated**,指向 kap-server 的 `isVolatileSignal`)。

## 2. 各方法/事件在 v2 生态的去向

### 2.1 klient facade 全量(`packages/klient`,@moonshot-ai/klient 0.1.2,exports `./ipc`、`./memory`)

入口形态:`Klient { global, events, session(id) }`;`SessionHandle extends SessionFacade { events, agent(id) }`;`AgentHandle extends AgentFacade { events }`(`packages/klient/src/core/klient.ts:29-43`)。

**global.\***(`core/facade/global.ts:327-340`;每个方法 → 服务名.方法 见实现 :372-654)

| 子对象 | 方法(→ 引擎服务) |
|---|---|
| `sessions` | `list(query)`→sessionIndex.listRecent;`get(id)`→sessionIndex.get;`countActive(ids)`→sessionIndex.count;`create({workDir,additionalDirs?,title?,mcpServers?})`→sessionManager.create + sessionMetadata.setTitle/read(:396-411) |
| `workspaces` | `list/get/createOrTouch/update/delete`→workspaceService.*(:414-422) |
| `config` | `get/getAll/inspect/set/replace/replaceSections/reload/diagnostics`→configService.*(:424-448;`undefined` 清除域在线上用 `null` 编码,:432-444) |
| `kosong` | `listProviders/getProvider/addProvider/removeProvider/refreshProviders/listModels/setDefaultModel/generate(流)`→modelResolver/providerService/modelService/providerDiscovery(:450-510) |
| `auth` | `status/summarize/ensureReady/startLogin/flow/cancelLogin/logout/refreshProviderModels(@deprecated)`→oauthService/authSummaryService(:512-527) |
| `flags` | `list/enabled/enabledIds/explain/snapshot`→flagService(:529-536) |
| `plugins` | `list/info/install/setEnabled/setMcpServerEnabled/remove/reload/checkUpdates/listCommands`→pluginService(:538-552) |
| `capabilities` | `list/get/install`→capabilityService(:554-559) |
| `hostFs` | `browse/home`→hostFolderBrowser(:561-565) |
| `files` | `save/get/delete`→fileService(base64 编解码在 facade 内,:567-582) |
| `mcp` | `list/get/add/update/remove/test/inspect/authStatuses/resolveByName/beginAuth/completeAuth/cancelAuth/resetAuth`→mcpManagementService(:584-651;completeAuth 的 IPC 超时钳制 :637-646) |
| `env()` | 聚合 bootstrapService 标量 + clientIdentity.version(:379-393) |

**session(id).\***(`core/facade/session.ts:85-118`):`get`(sessionMetadata.read)、`setTitle`、`generateTitle({force?,source?})`(sessionTitleService)、`update(patch)`、`setArchived(archived)`、`status()`(由 sessionInteractionService.listPending + 各 agent 的 agentActivityView.state 组合,:143-167)、`close/archive/restore({additionalDirs?,mcpServers?})/delete`(sessionManager.*,:168-174)、`fork/createChild({title?,metadata?})`(sessionManager.fork/createChild,:124-131,175-176)、子对象 `approvals.{list,decide}`、`questions.{list,answer,dismiss}`、`interactions.{list,respond}`、`skills.list`(sessionSkillCatalog)、`agents()`(读 metadata 注册表,:211-214)。

**agent(id).\***(`core/facade/agent.ts:48-105`):`prompt({input,disabledTools?,promptId?})`(agentPromptService.submit)、`promptWithSkills`(agentSkillService.promptWithSkills)、`steer`(agentPromptService.submitSteer)、`activateSkill({name,args?})`(agentSkillService.activate)、`cancel({turnId?})`(agentLoopService.cancelFromUser;`[undefined]→[null]` 线缆陷阱处理 :117-120)、`runShellCommand/cancelShellCommand`(agentShellCommandService)、`getModel/setModel/getThinking/setThinking`(agentProfileService)、`setPermission`(agentPermissionModeService.setModeAndBroadcast)、`getUsage`(agentUsageService)、`getContext()`(客户端合并 agentContextMemoryService.get + agentTokenCountingService.statusSize,:135-141)、`listCommands/runCommand`(agentCommandService)、`getRuntime/switchRuntime`(agentRuntimeBindingService)、`getPlan/enterPlan/clearPlan/cancelPlan`(agentPlanService)、`getTasks/stopTask/getTaskOutput`(agentTaskService)、`getMcpServers`(agentMcpService)、`compact({instruction?})`(agentFullCompactionService.begin,:178-181)。

**klient 事件词汇**(hub:`core/events/hub.ts`)

- 全局 `klient.events`(`contract/global/events.ts:43-52`):`config.changed`、`config.sectionChanged`、`kosong.providers.changed`、`kosong.models.changed`、`plugins.reloaded`、`session.archived`、`session.metaUpdated`、`kosong.changed`(绑定 :94-140:emitter 源 configService.onDidChangeConfiguration/onDidSectionChange、providerService.onDidChangeProviders、modelService.onDidChangeModels、pluginService.onDidReload;bus 源 `event.session.archived`、`session.meta.updated`、`event.model_catalog.changed`,bus 事件以 `{type,payload}` 信封传输,hub 解包 payload,:176-195)
- `session(id).events`(`contract/session/events.ts:38-44`):`metadata.changed`(sessionMetadata.onDidChangeMetadata)、`skills.changed`(sessionSkillCatalog.onDidChange)、`interactions.changed`(stream `interactions`,全量 pending 集)、`interactions.resolved`(stream `interactions:resolved`)
- `agent(id).events`(`contract/agent/events.ts:210-230`,19 个,均过滤 agent 范围 stream `events` 的 flat `{type,...}`):`turn.started`、`turn.ended`、`assistant.delta`、`thinking.delta`、`tool.call.started`、`tool.call.delta`、`tool.progress`、`tool.result`、`prompt.completed`、`prompt.aborted`、`compaction.started/blocked/cancelled/completed`、`permission.approval.requested/resolved`(不在 protocol 联合内,loose schema,:172-186)、`error`、`warning`、`agent.status.updated`

### 2.2 CoreAPI 方法 → v2 去向对照表

图例:**K**=klient facade;**S**=kap-server REST(`/api/v1` 前缀,路由文件:行号);**N**=node-sdk `SDKRpcClientV2` 覆盖(`packages/node-sdk/src/sdk-rpc-client-v2.ts:374` 起;未覆盖的基类方法经 `getRpc()` 抛 `NOT_IMPLEMENTED`「not wired to agent-core-v2 yet」,:612-617)。

| v1 CoreAPI | v2 去向 |
|---|---|
| `prompt` | K `agent(id).prompt`;S `POST /sessions/{sid}/prompts`(routes/prompts.ts:193);N :1971 |
| `steer` | K `agent(id).steer`;S `POST /sessions/{sid}/prompts::steer`(prompts.ts:374)及 `{prompt_id}:steer`(:452-455);N :2001 |
| `cancel` | K `agent(id).cancel`;S `POST /sessions/{sid}:abort`(sessions.ts:870-878 的 sessionActions.abort);N :1861 |
| `undoHistory` | klient 无 facade;S `POST /sessions/{sid}:undo`;N :1910(引擎 IAgentConversationUndoService) |
| `runShellCommand`/`cancelShellCommand` | K 同名;N :2016/:2026;S 无独立路由(走终端/任务面,**待核**:未见 REST 对应) |
| `setModel`/`getModel` | K `agent(id).setModel/getModel`;S `POST /sessions/{sid}/profile`(sessions.ts:495,经 sessionProfile.ts);N :1734(getModel 待核,未见 override) |
| `setThinking` | K `agent(id).setThinking`;S 同 profile 路由;N :1746 |
| `setPermission` | K `agent(id).setPermission`;S 同 profile 路由;N :1751 |
| `enterPlan`/`cancelPlan`/`clearPlan`/`getPlan` | K `agent(id).enterPlan/cancelPlan/clearPlan/getPlan`;N 基类 `setPlanMode`(rpc.ts:677,V2 下 getRpc 抛错→**待核**:SDKRpcClientV2 未见 enterPlan/cancelPlan override,但见 getPlan :1763、clearPlan :1768) |
| `enterSwarm`/`exitSwarm`/`getSwarmMode` | klient 无 facade;引擎侧为 durable op `swarm_mode.enter/exit`(features/swarm/swarmOps.ts:17/29);N 基类 `setSwarmMode`(rpc.ts:691,V2 下抛 NOT_IMPLEMENTED)→**v2 未接线** |
| `beginCompaction` | K `agent(id).compact`;S `POST /sessions/{sid}:compact`;N 基类 `compact`(rpc.ts:744,V2 未 override,**待核**) |
| `cancelCompaction` | klient 无 facade;N :1888 |
| `registerTool`/`unregisterTool` | klient 无 facade;引擎 op `tools.register_user_tool/tools.unregister_user_tool`(agent/userTool/userToolOps.ts:23/39);N 未见 →**待核** |
| `setActiveTools` | klient 无 facade;引擎 op `tools.set_active_tools/reset_active_tools`(agent/profile/profileOps.ts:96/110);N 未见 →**待核** |
| `stopBackground` | K `agent(id).stopTask`;S `POST /sessions/{sid}/tasks/{task_id}:cancel`(tasks.ts:141-166);N 基类 `stopBackgroundTask`(rpc.ts:896) |
| `detachBackground` | klient 无 facade;S `POST .../tasks/{task_id}:detach`(tasks.ts:164);N 基类 `detachBackgroundTask`(rpc.ts:908) |
| `getBackground`/`getBackgroundOutput` | K `agent(id).getTasks/getTaskOutput`;S `GET /sessions/{sid}/tasks`(tasks.ts:61)、`GET .../tasks/{task_id}`(:94);N 基类 `listBackgroundTasks/getBackgroundTaskOutput`(rpc.ts:872/884) |
| `clearContext` | klient 无 facade;引擎 op `context.clear`;N :1921 |
| `importContext` | v2 引擎无原生能力;N :1937 用 `v2/import-context.ts` 字节级复刻 v1 消息(见 §3.4) |
| `activateSkill` | K `agent(id).activateSkill`;S `POST /sessions/{sid}/skills/{name}:activate`(skills.ts:183-205);N :2044 |
| `activatePluginCommand` | N :2060;klient 待核(agent(id).runCommand 是 agentCommandService,非同物) |
| `startBtw` | S `POST /sessions/{sid}:btw`;N :2129 |
| `createGoal/getGoal/pauseGoal/resumeGoal/cancelGoal` | klient 无 facade;引擎 op `goal.create/update/clear` + 通知 `goal.updated`(features/goal/goalOps.ts);S `GET /sessions/{sid}/goal`(sessions.ts:782,只读);N :2199-2221 |
| `getCronTasks` | N :2236;引擎 op `cron.add/delete/cursor/fired`(features/cron/cronOps.ts) |
| `getContext` | K `agent(id).getContext`(两读合并);N :1805 |
| `getConfig`(AgentConfigData)/`getPermission`/`getTools` | klient 无 facade;N 未见 override →**待核** |
| `getPlan`/`getUsage` | K `agent(id).getPlan/getUsage`;N :1763/:1810 |
| `renameSession` | K `session(id).setTitle`;S 未见独立 rename 路由(由 `POST /sessions/{sid}/profile` 或 metadata 面承担,**待核**);N :1380(临时 resume→改→关模式) |
| `updateSessionMetadata`/`getSessionMetadata` | K `session(id).update/get`;N :1583/基类 |
| `listSkills` | K `session(id).skills.list`;S `GET /sessions/{sid}/skills`(skills.ts:115);N :1644 |
| `listPluginCommands` | K `global.plugins.listCommands`;N :900 |
| `listMcpServers` | K `agent(id).getMcpServers`;S `GET /mcp/servers`(tools.ts:83);N :2627 |
| `getMcpStartupMetrics` | klient 无;N :2648 |
| `reconnectMcpServer` | klient 无 facade;S `POST /mcp/servers/{name}:restart`(tools.ts:106-122);N :2663(走会话连接管理器,v2/global-mcp.ts 校验) |
| `generateAgentsMd`/`getSessionWarnings` | N :2080/:2096;S `GET /sessions/{sid}/warnings`(sessions.ts:811) |
| `waitForBackgroundTasksOnPrint`/`handlePrintMainTurnCompleted` | print 模式专用;N :2324/:2343(printSteerStates :399) |
| `addAdditionalDir` | S `POST /workspaces/{wid}/add-dir`(workspaces.ts:278);N :1600 |
| `applyPersistedSecondaryModel` | 未见 v2 对应 →**待核** |
| `getCoreInfo` | S `GET /meta`(meta.ts:48,超集:serverVersion/flags/features);N 未见 →**待核**(SDK 可能不经此方法暴露版本) |
| `getExperimentalFeatures` | K `global.flags.list/explain/snapshot`;S `GET /meta` 的 flags 段;N :619 |
| `getKimiConfig` | K `global.config.get/getAll`;S `GET /config`(config.ts:34);N :745(`getConfig`,经 v2/config-mapper.ts,见 §3.3) |
| `setKimiConfig` | K `global.config.set/replace/replaceSections`;S `POST /config`(config.ts:50);N 基类 `setConfig`/`replaceConfigSections`(rpc.ts:346/372,**待核** V2 override 位置) |
| `getConfigDiagnostics` | K `global.config.diagnostics`;N :753(扁平化为 warnings 字符串) |
| `removeKimiProvider` | K `global.kosong.removeProvider`;S `DELETE /providers/{provider_id}`(modelCatalog.ts:584);N 基类 `removeProvider`(rpc.ts:351)+ config-mapper 的级联计划(§3.3) |
| 全局 MCP CRUD/inspect/auth 系列(13 个) | K `global.mcp.*`(一一对应,含 `resolveByName` 消解 legacy name→locator);S 在 **`/api/v2`**:`GET/POST /mcp/servers`、`GET/PUT/DELETE /mcp/servers/{name}`、`POST /mcp/servers::test`、`::inspect`、`GET /mcp/auth-statuses`、`POST /mcp/auth::begin/::complete/::cancel/::reset`(routes/v2/mcp.ts:217-525);N :2453-2598 逐一 override |
| `addSessionMcpServer` | N :2697(会话连接管理器 + persist 走引擎 IMcpConfigStore,见 v2/global-mcp.ts:1-14 注释) |
| `createSession` | K `global.sessions.create`;S `POST /sessions`(sessions.ts:180);N :1320/doCreateSession :1330 |
| `closeSession`/`archiveSession`/`deleteSession` | K `session(id).close/archive/setArchived/delete`;S `POST /sessions/{sid}:archive`(actions)等;N :1444/:1460(archive 待核) |
| `resumeSession` | K `session(id).restore`;S `POST /sessions/{sid}:restore`;N :1489(replay 重建见 §3.5) |
| `reloadSession` | N :1517 |
| `forkSession` | K `session(id).fork`(注意:v1 的 `turnIndex` 截断参数在 K 的输入里不存在,只 `{title?,metadata?}`);S `POST /sessions/{sid}:fork`;N :1419 |
| `listSessions` | K `global.sessions.list`(返回 `Page<SessionSummary>` 分页,v1 是数组);S `GET /sessions`(sessions.ts:271);N :1215 |
| `exportSession` | S `POST /sessions/{sid}/export`(sessionExport.ts:48);N :1624 |
| `listWorkspaceSkills` | S `GET /workspaces/{wid}/skills`(skills.ts:147);N :648(经 IWorkspaceInstanceManager) |
| `listPlugins/installPlugin/setPluginEnabled/setPluginMcpServerEnabled/removePlugin/reloadPlugins/getPluginInfo` | K `global.plugins.*`;S `GET/POST /plugins`、`POST /plugins/{id}:enable/:disable/:remove`(plugins.ts:52-56、236-287);N :825-855 |
| 交互应答(反向通道)`requestApproval`/`requestQuestion`/`toolCall` | v2 改为拉取式交互内核:durable op `interaction.request`/`interaction.resolved`(features/interaction/interactionOps.ts:31/52),facade `session(id).approvals.{list,decide}`、`questions.{list,answer,dismiss}`、`interactions.{list,respond}`;S `GET/POST /sessions/{sid}/approvals[/{aid}]`(approvals.ts:61/91)、`GET /sessions/{sid}/questions` + `POST {qid}(:resolve|:dismiss)`(questions.ts:68/98/118-123/199-202);N 由 `SessionEventWiring` 桥回 v1 推式回调(见 §3.1) |

### 2.3 v2 引擎事件词汇(Event2,共 113 个唯一 type)

基础设施:`Event2` 基类(`packages/agent-core-v2/src/app/event/event2.ts:22-47`),静态标志 `durable`(默认 false,durable 必须声明 zod schema 并注册进 `EVENT2_REGISTRY`,:68-85)、`observable`(默认 false)、`agentDomain`(`AgentEvent2`,:53-57)。总线:`IEventBus.publish(event, agent?)`、`ISessionEventBus.onAgent(...)`(`eventBus.ts:7-35`);实现 `EventBusService`(session 范围)与 `AgentEventBusView`(agent 范围,按 agentId/来源过滤)(`eventBusService.ts:12-196`)。进程级 `IEventService`(`event.ts:7-16`)携带 `{type,payload}` 信封式全局事实。以下按域分组(type → 类@文件:行,标志 d=durable / o=observable,无标记者两者皆 false):

- **turn/loop**(agent/loop/):`turn.started` TurnStarted@turnEvents.ts:43 o;`turn.step.started` :108 o;`turn.step.completed` :131 o;`turn.step.interrupted` :155 d;`turn.step.retrying` :191 d;`assistant.delta` :205 o;`thinking.delta` :217 o;`tool.call.delta` :231 o;`turn.prompt` TurnPrompt@turnOps.ts:44 d;`turn.steer` :58 d;`turn.cancel` :77 d;`turn.ended` :108 d
- **tool**(agent/toolExecutor/toolExecutorEvents.ts):`tool.call.started` :17 o;`tool.progress` :30 o;`tool.result` :45 o
- **prompt 队列**(agent/prompt/):`prompt.accepted` PromptAccepted@promptOps.ts:14 d+o;`prompt.completed` PromptCompleted@promptService.ts:72 d+o;`prompt.aborted` PromptAborted@promptService.ts:92 d+o;`prompt.steered` :116 d;`prompt.queued` :147 o;`prompt.submitted` :162 o;`prompt.started` :173 o
- **context**(agent/contextMemory/contextEvents.ts):`context.append_message` :20 d;`context.append_loop_event` :37 d;`context.clear` :49 d;`context.apply_compaction` :95 d;`context.undo` :106 d;`context.spliced` :124 o
- **compaction**(agent/fullCompaction/compactionOps.ts):`full_compaction.begin` :30 d;`full_compaction.cancel` :43 d;`full_compaction.complete` :56 d;`compaction.started` :71 o;`compaction.blocked` :82 o;`compaction.cancelled` :88 o;`compaction.completed` :101 o
- **task**(agent/task/taskOps.ts):`task.started` TaskStarted@:17 d+o;**`task.terminated` 有两个同类名类**:`TaskTerminated`@:34 d(含 `outputTail?`)与 `TaskTerminatedNotice`@:50 o;`task.notified` TaskNotified@:56 o;`task.waitDelivered` :67 d
- **usage/status**:`usage.record` @agent/usage/usageOps.ts:21 d;`agent.status.updated` @agent/usage/usageEvents.ts:19 o
- **mcp**(agent/mcp/):`mcp.tools_discovered` mcpDiscoveryOps.ts:39 d;`mcp.server.status` mcpEvents.ts:19 o;`tool.list.updated` :33 o;`error` :39 o
- **profile/config**(agent/profile/profileOps.ts):`profile.bind` :39 d;`config.update` :73 d;`tools.set_active_tools` :96 d;`tools.reset_active_tools` :110 d;`warning` :125 o
- **permission**:`permission.set_mode` permissionModeOps.ts:14 d;`permission.rules.add` permissionRulesOps.ts:19(无标志);`permission.record_approval_result` :37 d;`permission.approval.requested` toolApprovalService.ts:44 o;`permission.approval.resolved` :58 o
- **plan/swarm/tower**:`plan_mode.enter/cancel/exit` planOps.ts:19/34/49 d;`plan.revision` :77 d;`swarm_mode.enter/exit` swarmOps.ts:17/29 d;`tower_mode.enter/exit` towerOps.ts:15/28 d
- **goal**(features/goal/goalOps.ts):`goal.create` :55 d;`goal.update` :86 d;`goal.clear` :106 d;`forked` :117 d(type 无命名空间);`goal.updated` :132 o
- **subagent**:`subagent.spawned/started/completed/failed` mirrorAgentRun.ts:35/45/58/69 o;`subagent.suspended` sessionSwarmService.ts:43 o
- **skill/plugin/hook/cron/interaction**:`skill.activated` skillOps.ts:16 o;`plugin_command.activated` pluginCommand.ts:21 o;`plugin.session_start` agentPluginOps.ts:20 d;`hook.result` agentExternalHooksService.ts:57 o;`cron.add/delete/cursor` cronOps.ts:29/40/52 d,`cron.fired` :64 o;`interaction.request/resolved` interactionOps.ts:31/52 d
- **shell**(agent/shellCommand/shellCommandService.ts):`shell.output` :33 o;`shell.started` :45 o;`shell.completed` :58 o
- **其他 agent 域**:`runtime.set_binding` runtimeBindingOps.ts:15 d;`interruptionReminder.recorded` interruptionReminderOps.ts:19 d;`llm.tools_snapshot`/`llm.request` llmRequestOps.ts:31/67 d;`token_counting.measured/truncated/rebased/turn_recorded` tokenCountingOps.ts:24/35/48/62 d;`context.undone` undoService.ts:43 o;`tools.register_user_tool/unregister_user_tool` userToolOps.ts:23/39 d;`agent.activity.updated` activityView.ts:76 o;`tools.update_store` todoOps.ts:17 d;`file_history.tracked/checkpoint` fileHistoryOps.ts:33/54 d
- **session/全局信封事实**(均无 d/o 标志,走 IEventService `{type,payload}` 信封):`session.meta.updated` SessionMetaUpdated@session/sessionMetadata/sessionMetaEvents.ts:15(payload 形状 :4-13);`event.session.created/archived` workspace/sessionLifecycle/sessionLifecycleEvents.ts:23/10;`event.workspace.created/updated/deleted` app/workspace/workspaceEvents.ts:11/22/34;`event.plugin.changed` app/plugin/pluginEvents.ts:5;`event.capability.changed` app/capability/capabilityEvents.ts:12;`event.model_catalog.changed` app/kosongConfig/discovery.ts:35;`event.config.warning/changed` app/config/configEvents.ts:14/26;`event.di.unit_changed` debug/debugCascade.ts:44

### 2.4 v1 事件 → v2 去向对照

- **同名直通**(v2 IEventBus 上有同名词条,经 kap-server 广播或 node-sdk 翻译):`turn.started/ended`、`turn.step.*`、`assistant.delta`、`thinking.delta`、`tool.call.delta/started`、`tool.progress`、`tool.result`、`compaction.*`(4 个)、`subagent.*`(5 个)、`skill.activated`、`plugin_command.activated`、`hook.result`、`cron.fired`、`goal.updated`、`mcp.server.status`、`tool.list.updated`、`shell.output/started/completed`、`error`、`warning`、`agent.status.updated`、`task.started/task.terminated`、`prompt.submitted/completed/aborted/steered`、`session.meta.updated`、`event.session.created`、`event.workspace.*`、`event.config.changed/warning`、`event.model_catalog.changed`、`event.plugin.changed`、`event.capability.changed`
- **改名**:`task.started→background.task.started`、`task.terminated→background.task.terminated`(v1 拼写;kap-server 两种拼写都扇出,node-sdk 只翻回 legacy 拼写,见 §3.1)
- **v1 有、v2 引擎内无对应**:`event.session.status_changed`(protocol 里已 @deprecated,:596-606)、`event.session.work_changed`(v2 由 kap-server 的 `ISessionActivityView` 在 WS 边合成,broadcaster `enqueueWorkChanged`,sessionEventBroadcaster.ts:985-1005;node-sdk 进程内路径未见 →**待核** SDK 是否合成)
- **v2 新增(WS 边合成,不在 v1 联合)**:`agent.created`/`agent.disposed`(broadcaster :831-850,由 IAgentLifecycleService.onDidCreate/onDidClose 合成)、`event.question.requested/dismissed/answered`、`event.approval.requested/resolved`(由交互内核变化合成,:1217-1285)、`event.session.archived`、`event.di.unit_changed`
- **v2 内部、不越界**:`agent.activity.updated`(在 kap-server 折算进 `agent.status.updated` 的 phase 切片,:893-908;node-sdk 直接丢弃)、`context.spliced`、`task.notified`、`plan.revision`、`permission.approval.*`、`prompt.accepted`、全部 durable op(`turn.prompt/steer/cancel`、`context.*` op、`full_compaction.*`、`profile.bind`、`config.update`、`permission.set_mode/rules.add/record_approval_result`、`llm.*`、`token_counting.*`、`usage.record`、`tools.*`、`cron.add/delete/cursor`、`interaction.request/resolved`、`plan_mode.*`、`swarm_mode.*`、`tower_mode.*`、`goal.create/update/clear`、`forked`、`task.waitDelivered`、`mcp.tools_discovered`、`plugin.session_start`、`interruptionReminder.recorded`、`file_history.*`、`runtime.set_binding`、`prompt.queued/started` 等)

### 2.5 kap-server 面(packages/kap-server)

- REST `/api/v1` 注册:`routes/registerApiV1Routes.ts:78-203`(healthz、meta、auth、oauth、config、modelCatalog、sessions、runtime、sessionExport、skills、capabilities、plugins、messages、search、tasks、approvals、questions、prompts、workspaces、workspaceFs、files、sessionMedia、fs、guiStore、tools、fileHistory、terminals、connections、snapshot、transcript、shutdown);`/api/v2`:`routes/registerApiV2Routes.ts:13-21`(v2/sessions 的 `GET /sessions`、v2/mcp 全套)。
- 路由风格:静态路径 + `POST …/{tail}` 动作后缀(`routes/action-suffix.ts` 解析 `{id}:{action}`;`action-dispatch.ts` 的 ActionTable)。动作表:sessionActions=`fork|compact|undo|abort|btw|restore|archive`(sessions.ts:857-878);promptActions=`abort|steer`(prompts.ts:452);pluginActions=`enable|disable|remove`(plugins.ts:52);questionActions=`resolve|dismiss`(questions.ts:199,默认 resolve);providerCollectionActions=`refresh_oauth|refresh|import_catalog|import_registry`(modelCatalog.ts:826-834);另有 `parseActionSuffix` 直查:model `set_default`(:185)、provider `refresh`(:518)、terminal `close`(terminals.ts:184)、capability `install`(capabilities.ts:108)、task `cancel|detach`(tasks.ts:164)、mcp_server `restart`(tools.ts:120)、skill `activate`(skills.ts:203)、fs `list|read|list_many|stat|stat_many|mkdir|search|grep|git_status|diff|open|open-in|reveal`(fs.ts:115-129)。
- WS v1:帧词汇在 `packages/protocol/src/ws-control.ts`(client_hello/subscribe/unsubscribe/watch_fs_add/watch_fs_remove/abort/terminal_attach/detach/input/resize/close/ping + server 侧 ack/server_hello/pong/resync_required/error/terminal_output/terminal_exit);连接处理器另支持 `subscribe_v2/unsubscribe_v2`(transport/ws/v1/wsConnectionV1.ts:163-183)。
- **`SessionEventBroadcaster`(transport/ws/v1/sessionEventBroadcaster.ts)的 Event2→WS 事件映射规则**(与 node-sdk 平行的另一条 v1 兼容边):
  - 丢弃 `prompt.accepted`(:891);
  - `agent.activity.updated` → 折算为 `agent.status.updated` 的 phase 切片(`toLegacyPhase`,services/legacyStatus/legacyStatus.ts:129;:893-908);自带 phase 的 `agent.status.updated` 不再转发(:909-914);
  - `agent.status.updated` 合并 `readLegacyStatus(handle)` 快照(usage/context/model 等,:867-876;legacyStatus.ts:84);main agent 的 `context.spliced` 触发一次 legacy status 补发(:877-879);
  - `turn.started` 剥离 `promptAttachments`(:917-921);
  - `prompt.steered/queued/submitted` 的 `content` 经 `projectPromptContentParts` 投影(:922-928);
  - `task.started/terminated` 除原名外**追加**一条 legacy `background.task.*`(`legacyTaskEvent`,:1110-1115);
  - 交互内核 → `event.question.requested/answered/dismissed`、`event.approval.requested/resolved`(durable,:944-977、1217-1285);
  - `ISessionActivityView` → `event.session.work_changed`(:791-815、985-1005);
  - 全局总线信封(`onCoreEvent`,:616-766):`event.session.created/archived`、`event.workspace.*`(经 `toWireWorkspace`)、`session.meta.updated`、`event.plugin.changed`、`event.capability.changed`、`event.config.warning/changed`(zod 校验 payload)、`event.model_catalog.changed`、`event.di.unit_changed`,全部补 `agentId:'main'` 与 sessionId(全局事件用 `__global__`,:127);
  - 易变分类:`isVolatileSignal`(agent 事件,:1093-1108:assistant/thinking/tool.call.delta、tool.progress、shell.*、agent.status.updated)与本地 `isVolatileEventType`(transport/ws/v1/events.ts:238-257,另含 event.di.unit_changed、event.capability.changed);volatile 不入 journal、不带新 seq(`dispatch`,:1024-1042);journal 在 `sessionEventJournal.ts`,resync 逻辑 `getBufferedSince`(:420-466);
  - transcript 投影抑制:`TRANSCRIPT_PROJECTED_EVENT_TYPES`(:1147-1198)在订阅了 transcript 等级时被 `transcript.ops/reset` 取代。

## 3. node-sdk v2 映射层细节(packages/node-sdk/src/v2/)

### 3.1 event-mapper.ts(Event2 → v1 Event,95 行全文已核)

- **`DROPPED_DOMAIN_EVENT_TYPES`**(:31-44,12 个):`agent.activity.updated`、`context.spliced`、`task.notified`、`plan.revision`、`permission.approval.requested`、`permission.approval.resolved`、`prompt.accepted`、`prompt.submitted`、`prompt.completed`、`prompt.aborted`、`prompt.started`、`prompt.steered`(注释 :20-30:前 6 个无 v1 对应;`prompt.*` 在 v1 由 daemon 服务层合成到全局 IEventService,进程内 SDK 从未见过)。
- **`RENAMED_DOMAIN_EVENT_TYPES`**(:52-55):`task.started→background.task.started`、`task.terminated→background.task.terminated`(payload 字段相同)。
- **`translateDomainEvent(event, sessionId, agentId)`**(:65-79):丢弃→`undefined`;改名;`turn.started` 额外**剥离 `promptAttachments`**(:72-77);其余字段原样,仅**补齐 `sessionId`/`agentId` 戳**(v2 per-agent bus 不携带,kap-server 同样在此处 stamping,注释 :4-15);cast 仅桥接类型声明。
- **`translateGlobalEvent(event)`**(:89-95):仅放行全局 IEventService 的 `session.meta.updated`,把 `{type, payload}` 信封**解包**为 `{type, ...payload}`;其他全局类型一律 `undefined`。
- 接线处(`session-wiring.ts`):
  - `SessionEventWiring`(:106-151)对 wiring 时全部 live agent + 后续 onDidCreate 的 agent 订阅 `IEventBus`,翻译后喂 `sink.receiveEvent`(同步、按发射序,:1-24 注释);
  - **`agent.status.updated` 的字段补齐 `withStatusSnapshot`**(:283-312):每条 status 事件在边界合并 `usage`(ISessionUsageService.status)、`contextTokens`(ISessionTokenCountingService.statusSize)、`maxContextTokens`(profile.getModelCapabilities 的 max_input_tokens ?? max_context_tokens)、`contextUsage`(两者相除,有限且 >0 时)、`model`(profile.getModel)——因为 v2 按独立切片发 status,model 切片只在 bind 时发,子代理等不到;镜像 kap-server 的 readLegacyStatus(:273-282 注释);
  - **交互桥**(:175-269):监听 `onSessionInteractionDidChangePending`,按 `interaction.kind` 分派:`approval`→`sink.requestApproval`(剥掉 v2 多出的 id/sessionId/agentId 字段,agentId 缺省回退 `interaction.origin.agentId ?? MAIN_AGENT_ID`)→ `ISessionApprovalService.decide`;`question`→`sink.requestQuestion`→ answer/dismiss(result 为 null 时 dismiss);`user_tool`→`sink.toolCall`→`respondSessionInteraction`;内核 respond 对已不存在 id 空操作,晚期应答安全(:21-23、215-218 注释)。
  - 全局事件订阅在 `SDKRpcClientV2` 构造函数(sdk-rpc-client-v2.ts:477-496):只翻 `session.meta.updated`;另 `followSessionLifecycles` 监听引擎侧 close 以拆 wiring。

### 3.2 session-mapper.ts 形状差异清单(97 行全文已核)

- `normalizeWorkDir`(:30-35):v1 `normalizeWorkDir` 的镜像(Windows 路径走 win32.resolve + 正斜杠折叠;其余按进程 cwd resolve),因测试 alias 限制而复制,须与 v1 `agent-core/session/store/workdir-key` 字节一致。
- **`v2SummaryToSessionSummary(summary, facts)`**(:44-61):v2 `ISessionIndex` 的 `SessionSummary` → v1 `SessionSummary`。差异:
  - `custom` → 改名 `metadata`(:57);
  - `workDir`/`sessionDir`/`additionalDirs` **v2 index 不携带**,由调用方以 `SessionSummaryFacts` 预解析注入(:38-42,来源 ISessionContext / IBootstrapService.sessionDir / workspace catalog,头注释 :1-11);
  - 直通:id/title/lastPrompt/createdAt/updatedAt/archived;
  - **附加输出 `lastTurnReason: summary.lastTurnReason`**(:59)——v1 `agent-core` 的 `SessionSummary`(core-api.ts:186-197)无此字段,node-sdk 的 `#/types` 自有扩展类型才有 →**待核** `packages/node-sdk/src/types.ts` 中 SessionSummary 的定义(我未读该文件)。
- **`v2MetaToSessionMeta(meta)`**(:68-80):v2 `SessionMeta` → v1 `SessionMeta`。
  - 时间戳:epoch ms → ISO 字符串(`new Date(...).toISOString()`:70-71);
  - `title`:缺省 `''`;`isCustomTitle` 由 `meta.titleKind === 'custom'` 派生(:72-73);
  - `cwd` → 改名 `workDir`(:76);
  - `custom` → 同名保留,缺省 `{}`(:78);
  - `agents` 逐条映射(:82-97):`type` 缺省回退(`main`→'main',其余→'sub',覆盖 v2 注册类型存在之前的旧文档);`parentAgentId` 以 `?? null` 补 v1 的显式 null;`homedir`/`swarmItem` 直通;
  - 直通:lastPrompt、forkedFrom。

### 3.3 config-mapper.ts(158 行已核)

- `KIMI_CONFIG_DOMAINS`(:23-47,23 个):providers、defaultProvider、defaultModel、models、thinking、planMode、yolo、defaultPermissionMode、defaultPlanMode、permission、hooks、services、mergeAllAvailableSkills、extraSkillDirs、loopControl、background、subagent、secondaryModel、mcp、image、modelCatalog、experimental、telemetry —— 即除 `raw` 外的全部 v1 顶层字段;v1 字段名与 v2 camelCase 配置域 1:1,读映射是字段拾取(:56-65);v2 独有域(cron、tools、extraAgentDirs…)**丢弃**;`raw` passthrough 与 v2 物化默认列入 parity KNOWN_DIFFS(:11-14)。
- `diagnosticsToConfigDiagnostics`(:80-84):v2 结构化 `{domain,severity,message}` → v1 扁平 `warnings: string[]`(只取 message)。
- `planProviderRemoval`/`removeProviderFromConfig`(:86-158):复刻 v1 removeKimiProvider 级联(删 provider 条目、删指向它的 model、悬空时清 defaultModel/defaultProvider;输入为 `inspect().userValue` 用户层值;`[secondary_model]` 故意不动,:102-106);v2 引擎自有 `providerService.delete` 只清 defaultProvider 指针,级联由 SDK 侧重演。

### 3.4 import-context.ts / global-mcp.ts(已核)

- import-context.ts:v2 引擎无 importContext 能力,SDK 用 v2 原语组合:`buildImportContextMessage`(:46-77)字节级复刻 v1 包装文本(`IMPORT_CONTEXT_GUIDANCE`、`escapeXml`/`escapeXmlAttr`)与空 content/source 的 `request.invalid` 拒绝(`import_content_empty`/`import_source_empty`);`assertImportFits`(:85-110)复刻溢出闸门(同一字符估算器,`CONTEXT_OVERFLOW` + `import_context_overflow` details)。
- global-mcp.ts:`mcpConfigWithoutName`/`parseInlineMcpServer`/`parseReconnectMcpServerConfig`/`normalizeServerName`(:24-67)——v1 校验文本与 `McpServerConfigSchema` 复用;`addSessionMcpServer` 的 `persist:true` 改走引擎 App 级 `IMcpConfigStore`(头注释 :8-13)。

### 3.5 resume-replay.ts(142 行已核)

- `foldAgentWireReplay(wirePath)`(:104-121):读 v2 每个 agent 的 `<sessionDir>/agents/<agentId>/wire.jsonl`,用**一次性 v1 `Agent`** + 只读 `ReadOnlyAgentRecordPersistence`(:81-97)跑 v1 原生 restore 管线折叠出 `{replay, toolStore}`;任何失败降级为空折叠。
- 记录类型 → replay 记录映射(:20-46 注释):`context.append_message`(及由 `context.append_loop_event` 装配出的 assistant/tool 消息)→`{type:'message'}`;`full_compaction.begin`→`{type:'compaction',instruction}`、`context.apply_compaction` 补 result、`full_compaction.cancel` 标 `'cancelled'`;`goal.create/update`→`goal_updated`;`plan_mode.enter`→`plan_updated{enabled:true}`、`plan_mode.cancel/exit`→false;`config.update`→`config_updated`(含原始 type/time 字段,v1 怪癖);`permission.set_mode`→`permission_updated`;`permission.record_approval_result`→`approval_result`;`tools.update_store`→无 replay 记录,last-wins 进 toolStore;其余(metadata、turn.*、usage.record、tools.set_active_tools、context.update_token_count)只重建状态;v2 独有 op(profile.bind、plan.revision、task.started/terminated、skill.activate、interaction.*、token_counting.*、llm.*)穿过 v1 restore switch 不动 —— 两个后果:v2 的 profile 绑定永不出现为 `config_updated` replay 记录(v1 写 `config.update`,v2 写 `profile.bind`,已列入 parity KNOWN_DIFFS);后台任务不来自此折叠(由调用方从 live agent scope 读)。

## 待核清单

1. `packages/node-sdk/src/types.ts` 未读:`SessionSummary.lastTurnReason`、`SessionStatus` 等 SDK 自有扩展形状需以该文件为准(session-mapper.ts:59 的输出字段在 v1 agent-core 类型里不存在)。
2. `SDKRpcClientV2` 未见 override 的 v1 方法(getModel、enterPlan/cancelPlan、compact、setSwarmMode、registerTool/unregisterTool/setActiveTools、getTools、getConfig(agent 级)、getPermission、archiveSession、getCoreInfo、applyPersistedSecondaryModel、setKimiConfig)是否真以基类 `getRpc()` 抛 `NOT_IMPLEMENTED`(sdk-rpc-client-v2.ts:612-617)收尾——基类 `SDKRpcClientBase`(rpc.ts:183)逐方法的默认实现抽查了 setPlanMode/setSwarmMode/compact(:677-746),均为 `await this.getRpc()` 模式,但未逐一核对全部方法;`getCoreInfo` 在整个 node-sdk/src 中 grep 无命中。
3. `runShellCommand/cancelShellCommand` 在 kap-server REST 未见对应路由(只查了路由注册与 action 表;terminals 面是另一套)。
4. `event.session.work_changed` 在 node-sdk 进程内路径未见合成(只有 kap-server broadcaster 合成);SDK 用户是否收得到此事件未确认。
5. Event2 个别类的 durable/observable 标志系从 grep 上下文行读取;`permission.rules.add`(permissionRulesOps.ts:19-21)与全部全局信封类确认无标志(即非 durable 非 observable),`prompt.queued/submitted/started` 只见 `observable` 行,未逐一确认它们是否同时 durable。
6. kap-server WS 的 `subscribe_v2/unsubscribe_v2` 帧(wsConnectionV1.ts:171-176)的 payload 契约未展开(protocol/ws-control.ts 内对应 schema 行号未记录)。
7. **基线后漂移(待核)**:本文全部 `packages/protocol/...` 引用已在声明基线 `ccf3d5d6` 核实;在当前工作区检出(#3542 之后的 main)中,`packages/protocol` 包已不在原位置(内容已迁移,如 kap-server 侧 `src/protocol/`)。映射结论仍是基线事实;该包的基线后去向待核。
