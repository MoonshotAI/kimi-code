# 符号映射:v1 根 barrel → v2

日期:2026-09-19。代码基线:`ccf3d5d6`(main 上删除 v1 的 #3542 的直接父提交)。此时 v1 `@moonshot-ai/agent-core` 0.15.8 与 v2 `@moonshot-ai/agent-core-v2` 0.4.3 并存;本文所有路径与符号均以该基线逐条核对。文中路径一律从仓库根写起。本文是 [`migration-from-v1.zh-CN.md`](../../migration-from-v1.zh-CN.md)(下称「主文档」)的子文档;英文原版:[`symbol-map.md`](symbol-map.md)。

## 口径与方法(先读)

- **展开方式**:v1 根 barrel(`packages/agent-core/src/index.ts`,181 行)中 11 条 `export *` 链(`./agent` `./session` `./rpc` `./config` `./flags` `./session/export` `./telemetry` `./errors` `./plugin` `./di` `./services`)已递归展开到叶文件(`#/x` 别名按 v1 `package.json#imports` 解析到 `src/x`;`errors.ts`/`plugin.ts` 为 shim,实指 `errors/index.ts`/`plugin/index.ts`);其余具名 re-export(index.ts:10-155、169)按文件顺序展开。共 **734 行导出记录、714 个唯一符号**(20 个为同一 symbol 经两条链重复导出,表内合一并注明)。
- **v2 状态判定**(v2 `package.json#exports`:`.` → `src/index.ts`,`./*` → `./src/*.ts`,任意 src 文件均可深子路径导入):
  - **根** = 从 `packages/agent-core-v2/src/index.ts` 的 export 链可达(v2 根 barrel 共导出 2622 个符号);
  - **深** = 根入口未导出、但某 v2 src 文件导出,可经 `@moonshot-ai/agent-core-v2/<下表路径去 .ts>` 导入;
  - **无** = v2 全 src 无同名导出,备注给出已核实的替代/改名,无把握处标**待核**。
- **同名碰撞警告**:v2 根可达≠语义对应。已逐一抽查可疑项,碰撞在备注标明;汇总见文末「同名碰撞与陷阱」。
- 与主文档的附录 A 域映射一致。
- 表中 v1 出处列在各块标题;v2 路径一律省略前缀 `packages/agent-core-v2/src/`。类:t=类型,v=值(类/函数/常量)。
- 局限:正则静态解析(已剥离注释),未跑 tsc 验证 `export *` 冲突的实际解析结果(唯一存疑处见 services 块 Approval/Question 备注);rpc/events 从 `@moonshot-ai/protocol` 的 re-export 为具名 type 导出,已直接捕获符号名。

**统计:714 唯一符号 → 根 279 / 深 63 / 无 372。**

## 块 1 `export * from './agent'`(index.ts:1;源 `agent/index.ts`,其内 `export * from './goal'` 展开至 `agent/goal/index.ts`)

| 符号 | 类 | v2 去向 |
|---|---|---|
| AgentRecord | t | 无 — 改名 `WireRecord`(`wire/record.ts:17`,根);持久化改 `persistence/interface` + `agent/blob/`(主文档 A.2) |
| AgentRecordPersistence | t | 无 — v2 无此抽象;经 `IAppendLogStore` 等(`persistence/interface/appendLogStore.ts`,根)**待核** |
| SwarmModeTrigger | t | 根 · `features/swarm/agent/swarm.ts` |
| BuiltinTool | t | 无 — v2 工具经 `AgentToolContribution` + `tool/toolContract.ts` 注册 **待核** |
| ToolDisclosure | t | 根 · `tool/toolContract.ts` |
| ToolInfo | t | 根 · `tool/toolContract.ts` |
| ToolSource | t | 根 · `tool/toolContract.ts` |
| UserToolRegistration | t | 根 · `agent/userTool/userTool.ts` |
| GoalStatus | t | 根 · `features/goal/types.ts`(另经 `rpc/core-api.ts` 重复导出,同一 symbol) |
| GoalActor | t | 根 · `features/goal/types.ts` |
| GoalBudgetLimits | v | 根 · `features/goal/types.ts`(同上 dup) |
| GoalBudgetReport | v | 根 · `features/goal/types.ts`(同上 dup) |
| GoalSnapshot | v | 根 · `features/goal/types.ts`(同上 dup) |
| GoalToolResult | v | 根 · `features/goal/types.ts`(同上 dup) |
| GoalChangeStats | v | 根 · `features/goal/types.ts`(同上 dup) |
| GoalChangeKind | t | 根 · `features/goal/types.ts` |
| GoalChange | v | 根 · `features/goal/types.ts`(同上 dup) |
| CreateGoalInput | v | 根 · `features/goal/types.ts` |
| GoalMode | v | 无 — 改 `IGoalService`/`GoalService`(`features/goal/goalService.ts`,根) |
| AgentType | t | 无 — v2 无 `AgentType`;类型概念在 `session/agentLifecycle/` **待核** |
| AgentOptions | v | 无 — 实例化改 `bootstrap` + `Program` + session controller(主文档 2.3) |
| Agent | v | 无 — 同上(主文档 2.3);agent 粒度状态经 `agent/state/agentState`、运行经 `agent/runtimeBinding/agentRuntime`(均根) |

## 块 2 `export * from './session'`(index.ts:2;源 `session/index.ts`,尾链 `./subagent-host`、`./subagent-binding`、`./store`)

| 符号 | 类 | v2 去向 |
|---|---|---|
| SessionOptions | v | 无 — 见主文档 2.3(session 由 `Program.createSessionController()` 托管) |
| SessionSkillConfig | v | 无 — 改 feature configSection(`features/skill/catalog/configSection.ts`,根) |
| SessionAgentCatalogConfig | v | 无 — 改 `app/agentProfileCatalog/` + `session/sessionAgentProfileCatalog/`(根) |
| AgentMeta | v | 根 · `session/sessionMetadata/sessionMetadata.ts` |
| CreateAgentOptions | v | 根 · `session/agentLifecycle/agentLifecycle.ts` |
| SessionMeta | v | 根 · `session/sessionMetadata/sessionMetadata.ts` |
| Session | v | 无 — 主文档 2.3 |
| DEFAULT_SUBAGENT_TIMEOUT_MS | v | 深 · `session/subagent/configSection.ts` |
| DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION | v | 无 |
| resolveSubagentTimeoutMs | v | 深 · `session/subagent/configSection.ts` |
| formatSubagentTimeoutDescription | v | 深 · `session/subagent/configSection.ts` |
| QueuedSubagentRunResult | t | 无 — v1 `subagent-batch` 机制消失 **待核** |
| QueuedSubagentTask | t | 无 — 同上 |
| ResumeQueuedSubagentTask | t | 无 — 同上 |
| SpawnQueuedSubagentTask | t | 无 — 同上 |
| RunSubagentOptions | v | 无 — 近邻 `RunAgentOptions`(`session/subagent/subagent.ts:19`,根)**待核** |
| SpawnSubagentOptions | v | 根 · `session/subagent/spawn.ts` |
| SubagentHandle | t | 根 · `agent/tools/agent/subagent-task.ts:22` |
| SessionSubagentHost | v | 无 — 改 `ISessionSubagentService`/`SessionSubagentService`(`session/subagent/subagent.ts:51` / `subagentService.ts:58`,根) |
| SubagentModelChoice | t | 无 — secondary-model 改 `session/subagent/configSection.ts`(深) |
| SubagentModelBinding | v | 无 — 同上 |
| resolveSecondaryModel | v | 无 — 同上 |
| resolveSubagentBinding | v | 深 · `session/subagent/configSection.ts` |
| buildSubagentModelDescriptions | v | 深 · `session/subagent/configSection.ts` |
| stripSubagentModelParameter | v | 深 · `session/subagent/configSection.ts` |
| wrapSubagentModelError | v | 深 · `session/subagent/configSection.ts` |
| SessionStore | v | 无 — 拆为 `persistence/`(appendLog/atomicDocument/query store)+ `app/sessionIndex/` + `app/workspace/`(主文档 A.3) |
| CreateSessionRecordInput | t | 无 — 同上 |
| ForkSessionRecordInput | t | 无 — 同上 |
| SessionStoreOptions | t | 无 — 同上 |
| sessionIndexPath | v | 无 |
| encodeWorkDirKey | v | 深 · `_base/utils/workdir-slug.ts:17`(node-sdk 深导入先例,主文档 2.2) |
| normalizeWorkDir | v | 无 — v2 仅 `slugifyWorkDirName`(同文件,语义不同)**待核** |
| workspaceRootKey | v | 深 · `_base/utils/workdir-slug.ts:27` |

## 块 3 `export * from './rpc'`(index.ts:3;源 `rpc/client.ts` / `core-api.ts` / `core-impl.ts` / `resumed.ts` / `sdk-api.ts` / `events.ts` / `types.ts`)

RPC 层整体出引擎(主文档 2.4):协议类型 → `packages/protocol` + `packages/klient`;服务端 → `packages/kap-server`;进程内 `createRPC` → `IEventBus` + `Event2`(均根)。下表「出引擎」均指此,不再重复。

| 符号 | 类 | v2 去向 |
|---|---|---|
| RPCCallOptions / RPCMethods / RPCClient / createRPC / CoreRPCClient / SDKRPCClient / CoreRPC | t/v | 无 — 出引擎(klient) |
| PluginCommandDef | t | 根 · `app/plugin/types.ts`(另经 `plugin/types.ts` 本体链 dup,同一 symbol) |
| JsonPrimitive / JsonValue / JsonObject | t | 根 · `agent/replayBuilder/types.ts:13-15` |
| Unsubscribe | t | 无 — 出引擎 |
| KimiConfig / KimiConfigPatch | t | 无 — v2 无单文档配置;`IConfigService` + 分域 ConfigSection,参照 node-sdk `src/v2/config-mapper.ts`(主文档 2.2)(与 config/schema 链 dup,同一 symbol) |
| TextPromptPart / PromptPart | t | 无 — v2 消息 part 用 `ContentPart` 族(`human/llm/message`,根)**待核** |
| PromptInput | t | 根 · `agent/prompt/prompt.ts` |
| EmptyPayload / SessionMetadataPatch / ClientTelemetryInfo / CreateSessionPayload / CloseSessionPayload / ArchiveSessionPayload / DeleteSessionPayload / ResumeSessionPayload / ReloadSessionPayload / ForkSessionPayload | t/v | 无 — 出引擎 |
| ShellEnvironment | v | 根 · `app/sessionExport/sessionExport.ts:3` |
| ExportSessionPayload / ExportSessionManifest / ExportSessionResult | v | 根 · `app/sessionExport/sessionExport.ts` |
| ListSessionsPayload / CoreInfo | v | 无 — 出引擎 |
| SessionSummary | v | 根 · `app/sessionIndex/sessionIndex.ts`(v2 有 3 处同名定义,根入口显式导出此份,`index.ts:731`) |
| PromptPayload | v | 根 · `agent/prompt/prompt.ts` |
| RunShellCommandPayload / ShellCommandResult / CancelShellCommandPayload | v | 无 — 出引擎(引擎侧 `agent/shellCommand/shellCommand.ts`,根,形状不同)**待核** |
| SteerPayload | v | 根 · `agent/prompt/prompt.ts` |
| CancelPayload / SetThinkingPayload / SetPermissionPayload / SetModelPayload / SetModelResult / CancelPlanPayload / EnterSwarmPayload / BeginCompactionPayload / UndoHistoryPayload / ImportContextPayload / RegisterToolPayload / UnregisterToolPayload / SetActiveToolsPayload / StopBackgroundPayload / DetachBackgroundPayload / GetBackgroundOutputPayload / GetBackgroundPayload | v | 无 — 出引擎 |
| SkillSummary | v | 根 · `features/skill/catalog/types.ts` |
| ActivateSkillPayload / ListWorkspaceSkillsPayload | v | 无 — 出引擎 |
| ActivatePluginCommandPayload | v | 根 · `agent/pluginCommand/pluginCommand.ts` |
| McpServerInfo / McpStartupMetrics / ReconnectMcpServerPayload / AddSessionMcpServerPayload | v | 无 — 出引擎 |
| GlobalMcpServerConfig | t | 根 · `app/mcpManagement/mcpManagement.ts` |
| McpServerSource | t | 根 · `app/mcpRegistry/mcpRegistry.ts` |
| McpManagedServerInfo / ListGlobalMcpServersPayload / GetGlobalMcpServerPayload / PutGlobalMcpServerPayload / GlobalMcpServerNamePayload | t/v | 无 — 出引擎 |
| McpServerLocator | t | 根 · `app/mcpManagement/mcpManagement.ts` |
| McpServerLocatorPayload / InspectAppMcpServersPayload / GlobalMcpServerAuthState / GlobalMcpServerAuthStatus / ListGlobalMcpServerAuthStatusesPayload / AppMcpServerAuthState / AppMcpServerConfig / AppMcpServerDescriptor / AppMcpServerInspection / BeginGlobalMcpServerAuthResult / CompleteGlobalMcpServerAuthPayload / CancelGlobalMcpServerAuthPayload / TestGlobalMcpServerPayload / GlobalMcpServerTestResult / InstallPluginPayload / SetPluginEnabledPayload / SetPluginMcpServerEnabledPayload / RemovePluginPayload / GetPluginInfoPayload / ReloadPluginsResult | t/v | 无 — 出引擎 |
| PluginSummary / PluginInfo | t | 根 · `app/plugin/types.ts`(与 plugin/types 本体链 dup) |
| AddAdditionalDirPayload / AddAdditionalDirResult / RenameSessionPayload / UpdateSessionMetadataPayload / CreateGoalPayload / GetKimiConfigPayload / ConfigDiagnostics / SetKimiConfigPayload / RemoveKimiProviderPayload / GetCronTasksResult / AgentAPI / SessionAPI / CoreAPI | v | 无 — 出引擎 |
| KimiCoreOptions / KimiCore | v | 无 — 出引擎;服务端为 kap-server;进程内改 `bootstrap`+`Program`(主文档 2.3) |
| AgentReplayRecordPayload / AgentReplayRecord / ResumedAgentState / ResumeSessionResult | t | 根 · `agent/replayBuilder/types.ts` |
| ApprovalDecision | t | 根 · `session/approval/approval.ts` |
| ApprovalScope | t | 无 — 出引擎 **待核** |
| ApprovalResponse / ApprovalRequest | v | 根 — **陷阱**:v2 根裸名是 `agent/permissionPolicy/types.ts` 的另一形状;v1 协议形状在 v2 根以 `SessionApprovalResponse`/`SessionApprovalRequest` 别名导出(v2 `index.ts:525-530`,源 `session/approval/approval.ts`)(另经 services 链 dup,与 rpc 同源,见块 13 备注) |
| QuestionOption / QuestionItem | v | 根 · `session/question/question.ts` |
| QuestionAnswerMethod / QuestionAnswers | t | 根 · `session/question/question.ts` |
| QuestionResponse / QuestionResult / QuestionRequest | v | 根 · `session/question/question.ts`(后两者另经 services 链 dup,同源) |
| ToolCallRequest / ToolCallResponse | v | 无 — 出引擎 |
| SDKAgentAPI / SDKAgentRPC / SDKSessionAPI / SDKSessionRPC / SDKAPI / SDKRPC | v/t | 无 — 出引擎 |
| MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE | v | 深 · `agent/mcp/tools/auth.ts`(主文档 2.2);`@moonshot-ai/protocol` 仍持有 |
| AgentEvent | t | 真身留 `@moonshot-ai/protocol`;v2 `human/agent/machine.ts:32` 同名(深)是 turn 机器事件 union,**不同物** |
| AgentStatusUpdatedEvent / AssistantDeltaEvent / BackgroundTaskStartedEvent / BackgroundTaskTerminatedEvent / CompactionBlockedEvent / CompactionCancelledEvent / CompactionCompletedEvent / CompactionStartedEvent / ErrorEvent / GoalUpdatedEvent / HookResultEvent / McpServerStatusEvent / PluginCommandActivatedEvent / SessionMetaUpdatedEvent / SessionStatusChangedEvent / SessionWorkChangedEvent / SkillActivatedEvent / SubagentCompletedEvent / SubagentFailedEvent / SubagentSpawnedEvent / SubagentStartedEvent / SubagentSuspendedEvent / ThinkingDeltaEvent / ToolCallDeltaEvent / ToolCallStartedEvent / ToolListUpdatedEvent / ToolProgressEvent / TurnStepCompletedEvent / TurnStepInterruptedEvent / TurnStepRetryingEvent / TurnStepStartedEvent | t | 无 — 留 `@moonshot-ai/protocol`(`packages/protocol/src/events.ts`);引擎事件改 `IEventBus`+`Event2`(turn 事件为 `agent/loop/turnEvents.ts` 的 `AgentEvent2` 类,深) |
| CompactionResult | t | 根 · `agent/fullCompaction/types.ts`(引擎内结果;协议事件 payload 仍留 protocol)(与块 10 agent/compaction 链 dup) |
| CronFiredEvent | t | **碰撞**:根 · `app/telemetry/events.ts:428` 为埋点 payload;协议事件留 protocol |
| Event | t | 真身(协议 union)留 `@moonshot-ai/protocol`;v2 `_base/event.ts:11` 的 `Event<T>`(深)是 emitter 接口,**不同物**(v1 根 `Event` 语义 = 协议) |
| McpOAuthAuthorizationUrlUpdateData | t | 深 · `agent/mcp/tools/auth.ts` |
| McpServerStatusPayload | t | 深 · `agent/mcp/mcpEvents.ts:5`(引擎事件形状,收窄)**待核** |
| SessionCreatedEvent | t | 根 · `workspace/sessionLifecycle/sessionLifecycle.ts:40`(引擎生命周期事件,与协议事件形状不同)**待核** |
| ToolInputDisplay | t | 深 · `tool/toolInputDisplay.ts` |
| ToolListUpdatedReason | t | 深 · `agent/mcp/mcpEvents.ts:24`(仅 mcp.* 三值,收窄)**待核** |
| ToolResultEvent | t | 深 · `agent/toolExecutor/toolExecutorEvents.ts:44`(`AgentEvent2` 类,不同物);协议形状留 protocol |
| ToolUpdate | t | 根 · `tool/toolContract.ts` |
| TurnEndedEvent / TurnStartedEvent | t | **碰撞**:根 · `app/telemetry/events.ts:74/:55` 为埋点 payload;协议事件留 protocol |
| TurnEndReason | t | 深 · `agent/loop/turnEvents.ts:11` |
| UsageStatus | t | 根 · `agent/usage/usage.ts:21`(v2 引擎自有;protocol 亦持有同名) |
| WarningEvent | t | **碰撞**:根 · `agent/profile/profileService.ts:82`(profile 警告事件,不同物);协议事件留 protocol |
| KimiErrorPayload | t | 根 · `_base/errors/serialize.ts:14`(`= ErrorPayload` 别名)(与 errors 链 dup,同一 symbol) |
| WithAgentId / WithSessionId / proxyWithExtraPayload | t/v | 无 — 出引擎 |

## 块 4 `export * from './config'`(index.ts:4;源 `config/{merge,model,migrations,path,print-defaults,resolve,schema,toml,env-model,secondary-model,workspace-local}.ts`)

v2 无单文档 schema;配置拆为 `IConfigService` + 各域 `ConfigSection`(主文档 2.2、A.1)。

| 符号 | 类 | v2 去向 |
|---|---|---|
| mergeConfigPatch / effectiveModelAlias / effectiveModelAliases | v | 无 — 模型解析在 `app/kosongConfig/` |
| migrateThinkingEffortMaxToHigh | v | 深 · `app/config/migrations.ts`(机制同名保留,主文档 1.4) |
| resolveKimiHome / resolveConfigPath / ensureKimiHome | v | 根 · `app/bootstrap/bootstrap.ts` |
| PRINT_WAIT_CEILING_S_DEFAULT / PRINT_MAX_TURNS_DEFAULT / PRINT_SUBAGENT_TIMEOUT_MS_DEFAULT / PRINT_BASH_TASK_TIMEOUT_S_DEFAULT / applyPrintModeConfigDefaults | v | 根 · `agent/task/printDefaults.ts` |
| ResolveConfigValueInput / resolveConfigValue / parseFloatEnv | v | 无 |
| parseBooleanEnv | v | 深 · `_base/utils/env.ts` |
| ProviderTypeSchema | v | 深 · `app/kosongConfig/configSection.ts` |
| ProviderType | t | 根 · `llm-adapter/provider/provider.ts` |
| OAuthRefSchema | v | 深 · `app/kosongConfig/configSection.ts` |
| OAuthRef | t | 根 · `llm-adapter/provider/provider.ts` |
| ProviderConfigSchema | v | 深 · `app/kosongConfig/configSection.ts` |
| ProviderConfig | t | 根 · `llm-adapter/provider/provider.ts` |
| ModelAliasOverrideSchema / ModelAliasOverrides / ModelAliasSchema / ModelAlias | v/t | 无 **待核**(kosongConfig section 内有近邻形状) |
| SecondaryModelConfigSchema / SecondaryModelConfig | v/t | 深 · `session/subagent/configSection.ts` |
| ThinkingConfigSchema | v | 深 · `app/kosongConfig/configSection.ts` |
| ThinkingConfig | t | 根 · `llm-adapter/model/thinking.ts` |
| PermissionModeSchema | v | 无 — 枚举在 `agent/permissionPolicy/types.ts`(根)**待核** |
| PermissionRuleDecisionSchema / PermissionRuleScopeSchema / PermissionRuleSchema / PermissionConfigSchema / PermissionConfig | v/t | 深 · `agent/permissionRules/configSection.ts` |
| LoopControlSchema / LoopControl | v/t | 深 · `agent/loop/configSection.ts` |
| BackgroundConfigSchema / BackgroundConfig | v/t | 无 — 改 `agent/task/configSection.ts`(根导出 `AgentTaskConfig`/`resolveAgentTaskConfig`)**待核** |
| SubagentConfigSchema / SubagentConfig | v/t | 深 · `session/subagent/configSection.ts` |
| MAX_MCP_TIMEOUT_MS | v | 根 · `mcpCore/config-schema.ts` |
| McpConfigSchema / McpConfig | v/t | 无 — 改 `app/mcpConfig/configSection.ts`(`McpSection`,v2 根具名导出)**待核** |
| ImageConfigSchema / ImageConfig | v/t | 深 · `agent/media/configSection.ts` |
| ModelCatalogConfigSchema / ModelCatalogConfig | v/t | 根 · `app/kosongConfig/configSection.ts`(v2 根具名导出,`index.ts:215-219`) |
| ExperimentalConfigSchema / ExperimentalConfig | v/t | 根 · `app/flag/flag.ts` |
| HookDefSchema / HookDefConfig | v/t | 根 · `features/externalHooks/configSection.ts` |
| MoonshotServiceConfigSchema / MoonshotServiceConfig / ServicesConfigSchema / ServicesConfig | v/t | 根 · `app/auth/configSection.ts` **待核**(语义对应) |
| McpServerStdioConfigSchema / McpServerStdioConfig / McpServerHttpConfigSchema / McpServerHttpConfig / McpServerSseConfigSchema / McpServerSseConfig / McpRemoteServerConfig / McpServerConfigSchema / McpServerConfig | v/t | 根 · `mcpCore/config-schema.ts` |
| KimiConfigSchema / KimiConfigPatchSchema / getDefaultConfig / validateConfig / formatConfigValidationError | v | 无 — 主文档 2.2(`IConfigService` + section 注册) |
| ensureConfigFile / readConfigFile / readConfigFileForUpdate / loadRuntimeConfig / RuntimeConfigLoadResult / loadRuntimeConfigSafe / parseConfigString / writeConfigFile / configToTomlData | v | 无 — 同上 |
| transformTomlData | v | 深 · `app/config/toml.ts` |
| ENV_MODEL_PROVIDER_KEY | v | 深 · `app/kosongConfig/configSection.ts` |
| ENV_MODEL_ALIAS_KEY | v | 深 · `app/kosongConfig/envOverlay.ts` |
| applyEnvModelConfig / stripEnvModelConfig | v | 无(env overlay 机制在 `app/kosongConfig/envOverlay.ts`,内部)**待核** |
| SECONDARY_DERIVED_MODEL_ALIAS / SECONDARY_MODEL_ENV / SECONDARY_MODEL_EFFORT_ENV / secondaryModelPatch / applySecondaryModelConfig / stripSecondaryModelConfig | v | 无 — 刻意消失(主文档 2.2) |
| WorkspaceAdditionalDirsLoadResult / WorkspaceLocalConfig / loadWorkspaceLocalConfig / readWorkspaceAdditionalDirs / resolveWorkspaceAdditionalDirs / appendWorkspaceAdditionalDir / normalizeAdditionalDirs | v/t | 无 — 改 `app/projectLocalConfig/`(根);`normalizeAdditionalDirs` 在 v2 为 `persistence/backends/node-fs/projectLocalConfigService.ts:229` 的内部函数(未导出) |

## 块 5 `export * from './flags'`(index.ts:5;源 `flags/{types,registry,resolver}.ts`)

| 符号 | 类 | v2 去向 |
|---|---|---|
| FlagSurface | t | 根 · `app/flag/flagRegistry.ts:6` |
| FlagDefinitionInput | v | 根 · `app/flag/flagRegistry.ts:10` |
| FlagDefinition | t | 无 — 近邻 `FlagDefinitionInput`(根)**待核** |
| ExperimentalFlagMap / ExperimentalFlagConfig / ExperimentalFlagSource / ExperimentalFeatureState | t/v | 根 · `app/flag/flag.ts` |
| ExperimentalFlagResolver | v | 无 — 改 `IFlagService.enabled(id)`(主文档 2.2) |
| FLAG_DEFINITIONS | v | 无 — 改 `registerFlagDefinition`(`app/flag/flagRegistry.ts:22`,根) |
| FlagId | t | 根 · `app/flag/flagRegistry.ts:8` |
| MASTER_ENV | v | 根 · `app/flag/flagService.ts` |
| FlagResolver / flags(单例) | v | 无 — 改 `IFlagService` |

## 块 6 `export * from './session/export'`(index.ts:6;源 `session/export/{manifest,session-export,wire-scan,zip}.ts`)

| 符号 | 类 | v2 去向 |
|---|---|---|
| WIRE_PROTOCOL_VERSION | v | 根 · `wire/migration/migration.ts:19` |
| buildExportManifest | v | 根 · `app/sessionExport/manifest.ts` |
| exportSessionDirectory | v | 根 · `app/sessionExport/sessionExportService.ts` |
| SessionWireScan / scanSessionWire / normalizeTimestampMs | v | 根 · `app/sessionExport/wire-scan.ts` |
| collectFilesRecursive / writeExportZip | v | 根 · `app/sessionExport/zip.ts` |
| ExtraZipEntry | t | 根 · `app/sessionExport/zip.ts` |

## 块 7 `export * from './telemetry'`(index.ts:7;源 `telemetry.ts`)

| 符号 | 类 | v2 去向 |
|---|---|---|
| TelemetryPropertyValue | t | 无 — 改名 `TelemetryPrimitive`(`app/telemetry/context.ts:1`,根) |
| TelemetryProperties | t | 根 · `app/telemetry/context.ts:3` |
| TelemetryContextPatch | v | 根 · `app/telemetry/context.ts:22` |
| TelemetryClient | v | 无 — 改 `ITelemetryService`(`app/telemetry/telemetry.ts:29`,根) |
| noopTelemetryClient | v | 无 — 改名 `noopTelemetryService`(`app/telemetry/telemetry.ts:54`,根) |
| withTelemetryContext / withTelemetryProperties | v | 无 — 上下文经 Service 传递(主文档 2.2) |

## 块 8 `export * from './errors'`(index.ts:8;源 `errors/index.ts` → `{codes,classes,serialize,unexpectedError}.ts`)

| 符号 | 类 | v2 去向 |
|---|---|---|
| ErrorCodes | v | 根 · v2 `src/errors.ts:73`(按域聚合) |
| isKimiErrorCode | v | 无 — 改名 `isErrorCode`(`_base/errors/codes.ts:34`,根) |
| KIMI_ERROR_INFO | v | 无 — 改函数 `errorInfo(code)`(`_base/errors/codes.ts:38`,根)**待核** |
| KimiErrorCode | t | 无 — 改名 `ErrorCode`(v2 `src/errors.ts:109`,根) |
| KimiErrorInfo | t | 无 — 改名 `ErrorInfo`(`_base/errors/codes.ts:1`,根) |
| KimiError | v | 无 — 改名 `Error2`(`_base/errors/errors.ts:38`,根;主文档 2.2) |
| KimiErrorOptions | t | 无 — 改名 `Error2Options`(`_base/errors/errors.ts:32`,根) |
| fromKimiErrorPayload | v | 无 — 改名 `fromErrorPayload`(`_base/errors/serialize.ts:91`,根) |
| isKimiError | v | 无 — 改名 `isError2`(`_base/errors/errors.ts:50`,根) |
| makeErrorPayload | v | 根 · `_base/errors/serialize.ts:33` |
| toKimiErrorPayload | v | 根 · `_base/errors/serialize.ts:89`(`= toErrorPayload`) |
| onUnexpectedError / resetUnexpectedErrorHandler / safelyCallListener / setUnexpectedErrorHandler / UnexpectedErrorHandler | v/t | 根 · `_base/errors/unexpectedError.ts` |

## 块 9 `export * from './plugin'`(index.ts:9;源 `plugin/index.ts` → `types.ts` 等)

全部 **根** 导出,目标文件 `app/plugin/` 下同名:`PluginDiagnosticSeverity`(t)、`PluginDiagnostic`、`PluginAuthor`、`PluginSessionStart`、`PluginInterface`、`PluginManifest`、`PluginMcpServerState`、`PluginCapabilityState`、`PluginMcpServerInfo`、`PluginMcpServerEntry`、`PluginCommandDef`(与 rpc 链 dup)、`PluginCommandEntry`、`PluginManifestKind`(t)、`PluginSource`(t)、`PluginState`(t)、`PluginGithubRef`、`PluginGithubMetadata`、`PluginRecord`、`PluginSummary`/`PluginInfo`(dup)、`EnabledPluginSessionStart`、`EnabledPluginSystemPrompt`、`ReloadSummary`、`PLUGIN_NAME_REGEX`、`normalizePluginId` → 均 `app/plugin/types.ts`;`parseManifest`/`ParsedManifestResult` → `app/plugin/manifest.ts`;`readInstalled`/`writeInstalled`/`InstalledFile`/`InstalledRecord` → `app/plugin/store.ts`;`PluginManager`/`PluginManagerOptions` → `app/plugin/manager.ts`;`resolveInstallSource`/`InstallSource`/`ResolvedSource` → `app/plugin/source.ts`;`downloadZip`/`extractZip` → `app/plugin/archive.ts`。

## 块 10 具名 re-export(index.ts:10-155)

| 符号 | 类 | v2 去向 |
|---|---|---|
| buildReplay(行 10,`agent/replay/build`) | v | 无 — 引擎内只剩类型(`agent/replayBuilder/types.ts`,根),实现出引擎(主文档 2.2/2.3 注意) |
| isAgentReplayUserTurnRecord / limitAgentReplayByTurns(行 11,`agent/replay/turns`) | v | 无 — 同上 |
| flushDiagnosticLogs / flushDiagnosticLogsSync(`logging/logger`) | v | 无 — 关闭改 `drainLogCloses()`(`_base/log/logService.ts:30`,根)**待核**(语义对应) |
| getRootLogger / log | v | 无 — 改 `ILogService` + `logSeed`(`_base/log/logConfig.ts:54`,根;主文档 2.2) |
| redact | v | 无 — 改名 `redactCtx`(`_base/log/formatter.ts:54`,根)**待核** |
| resolveGlobalLogPath | v | 根 · `_base/log/logConfig.ts` |
| resolveLoggingConfig / ResolveLoggingInput | v/t | 根 · `_base/log/logConfig.ts` |
| installGlobalProxyDispatcher(行 22,`utils/proxy`) | v | 深 · `_base/utils/proxy.ts:218` |
| LogContext / LogEntry / LogLevel / LogPayload | t | 根 · `_base/log/log.ts` |
| Logger / RootLogger | t | 无 — 改 `ILogger`/`ILogService`(`_base/log/log.ts:37`,根)**待核** |
| LoggingConfig | t | 根 · `_base/log/logConfig.ts` |
| SessionAttachInput / SessionLogHandle | t | 无 — session 日志改 `session/sessionLog/sessionLogService`(根)**待核** |
| USER_PROMPT_ORIGIN(行 34) | v | 根 · `agent/contextMemory/types.ts` |
| parseAgentFileText / resolveAgentPath(行 35) | v | 根 · `workspace/workspaceAgentProfileLoader/internal/agentFile.ts` / `.../paths.ts` |
| renderToolResultForModel / RenderableToolResult(行 36-37) | v/t | 深 · `agent/contextMemory/toolResultRender.ts` |
| AgentContextData / ContextMessage / PromptOrigin / UserPromptOrigin | t | 根 · `agent/contextMemory/types.ts` |
| AgentBackgroundTaskInfo / BackgroundTaskInfo / BackgroundTaskStatus / ProcessBackgroundTaskInfo / QuestionBackgroundTaskInfo(行 44-50) | t | 无 — 改 `agent/task/task.ts`(`IAgentTaskEntry` 等,根)+ `app/task/` **待核**(逐项形状) |
| CronTaskSnapshot(行 51) | t | 无 — 改名 `CronTask`(`features/cron/cronTask.ts:1`,根)**待核** |
| ToolServices(行 52,`tools/support/services`,= `{ urlFetcher?, webSearcher? }`) | t | 无 — v2 经 `app/web/providers/` + `app/auth/webSearch/`(根)注入 |
| buildImageCompressionCaption / compressImageForModel / compressBase64ForModel / gateImageFormatParts / resolveMaxImageEdgePx / resolveReadImageByteBudget / IMAGE_BYTE_BUDGET / MAX_IMAGE_EDGE_PX / READ_IMAGE_BYTE_BUDGET | v | 根 · `agent/media/image-compress.ts` |
| compressImageContentParts / cropImageForModel / formatByteSize | v | 深 · `agent/media/image-compress.ts` |
| MODEL_ACCEPTED_IMAGE_MIMES / buildImageConversionGuidance / buildUnsupportedImageNotice / decodeBase64Prefix / isModelAcceptedImageMime / normalizeImageMime / parseImageDataUrl / resolveEffectiveImageMime / unsupportedImageMimeFromUrl | v | 根 · `agent/media/image-format-policy.ts` |
| ImageLimits(行 89) | v | 无 — 刻意消失(主文档 2.2):用常量 + `agent/media/configSection.ts` + `IImageConfigBridge`(`agent/media/imageConfigBridge.ts`,根) |
| CompressAnnotateOptions / CompressedContentParts / CompressImageOptions / CompressImageResult / CompressBase64Result / CropImageOptions / CropImageOutcome / ImageCompressionCaptionInput / ImageCropRegion / ImageVariantDescription | t | 深 · `agent/media/image-compress.ts` |
| ImageCompressionTelemetry | t | 无 **待核** |
| originalImageCacheDir | v | 深 · `agent/media/image-originals.ts` |
| persistOriginalImage / sessionMediaOriginalsDir | v | 根 · `agent/media/image-originals.ts` |
| PersistOriginalImageOptions | t | 深 · `agent/media/image-originals.ts` |
| SingleModelProvider(行 109) | v | 无 — `llm-adapter/provider/` + `app/kosongConfig/`(主文档 A.3)**待核** |
| BearerTokenProvider(行 111) | t | **碰撞**:根 · `app/auth/webSearch/providers/moonshot-web-search.ts:4`(web 搜索令牌,不同物);v1 model-provider 抽象的真身 **待核**(`llm-adapter/model/model-oauth.ts`?) |
| ModelProvider / OAuthTokenProviderResolver / ResolvedRuntimeProvider | t | 无 — `llm-adapter/provider/provider.ts` + `IModelService`(`llm-adapter/model/model.ts:63`,根)**待核**(逐项) |
| AgentRecord / AgentRecordPersistence(行 118-123,与块 1 dup) | t | 见块 1 |
| AgentRecordEvents / AgentRecordOf | t | 无 — wire 词汇改 `wire/` + `wire-manifest.d.ts` **待核** |
| AGENT_WIRE_PROTOCOL_VERSION(行 124) | v | 无 — 改名 `WIRE_PROTOCOL_VERSION`(`wire/migration/migration.ts:19`,根;1.4→1.5) |
| AgentConfigUpdateData(行 125) | t | 根 · `agent/profile/profile.ts` |
| CompactionBeginData / CompactionResult(行 126) | t | 根 · `agent/fullCompaction/types.ts`(CompactionResult 与 rpc/events 链 dup) |
| COMPACT_USER_MESSAGE_HEAD_TOKENS / COMPACT_USER_MESSAGE_MAX_TOKENS / COMPACTION_ELISION_VARIANT / buildCompactionElisionText / collectCompactableUserMessages / isRealUserInput / selectCompactionUserMessages / selectRecentUserMessages | v | 根 · `agent/contextMemory/compactionHandoff.ts` |
| PermissionApprovalResultRecord | t | 根 · `agent/permissionRules/permissionRules.ts` |
| PermissionMode | t | 根 · `agent/permissionPolicy/types.ts` |
| UsageRecordScope | t | 深 · `agent/usage/usageOps.ts` |
| ToolStoreUpdate | t | 无 — `ToolStore` 刻意消失(主文档 2.2) |
| LoopRecordedEvent | t | 根 · `agent/contextMemory/loopEventFold.ts` |
| LoopStepBeginEvent / LoopStepEndEvent / LoopContentPartEvent / LoopToolCallEvent / LoopToolResultEvent | t | 无 — 引擎侧为 `agent/loop/turnEvents.ts` 的 `AgentEvent2` 类(深);协议形状留 protocol **待核** |
| ExecutableToolResult / ExecutableToolSuccessResult / ExecutableToolErrorResult | t | 根 · `tool/toolContract.ts` |

## 块 11 `export * from './di'`(index.ts:158)

除下述 4 个外全部 **根** 导出且与 v2 `_base/di/` 同名同文件对应:`ServiceIdentifier`/`ServicesAccessor`/`ServiceCollectionLike`/`BrandedService`/`IConstructorSignature`/`GetLeadingNonServiceArgs`/`createDecorator`/`refineServiceDecorator`/`IInstantiationService` → `_base/di/instantiation.ts`;`SyncDescriptor`/`SyncDescriptor0` → `_base/di/descriptors.ts`;`ServiceCollection` → `_base/di/serviceCollection.ts`;`InstantiationService` → `_base/di/instantiationService.ts`;`Disposable`/`DisposableStore`/`DisposableMap`/`DisposableSet`/`MutableDisposable`/`MandatoryMutableDisposable`/`RefCountedDisposable`/`ReferenceCollection`/`AsyncReferenceCollection`/`ImmortalReference`/`DisposableTracker`/`combinedDisposable`/`toDisposable`/`dispose`/`disposeIfDisposable`/`disposeOnReturn`/`thenIfNotDisposed`/`thenRegisterOrDispose`/`isDisposable`/`markAsSingleton`/`setDisposableTracker`/`trackDisposable`/`markAsDisposed`/`IDisposable`/`IDisposableTracker`/`IReference` → `_base/di/lifecycle.ts`;`CyclicDependencyError` → `_base/di/errors.ts`。

| 符号 | 类 | v2 去向 |
|---|---|---|
| InstantiationType / registerSingleton / getSingletonServiceDescriptors / _clearRegistryForTests | v | 无 — v2 无 `di/extensions.ts`;服务注册改 `ServiceCollection`/scope seed + `*Service.ts` 自注册(主文档 A.1) |

## 块 12 `export { Emitter } from './base/common/event'`(index.ts:169)

| 符号 | 类 | v2 去向 |
|---|---|---|
| Emitter | v | 深 · `_base/event.ts:42` — v2 根入口**不导出**(v1 根 barrel 刻意不导 `Event<T>` 的备注对称:v2 根无 `_base/event` 出口;同文件还有 `Event<T>` 接口、`AsyncEmitter`、`namespace Event`) |

## 块 13 `export * from './services'`(index.ts:181;源 `services/index.ts`)

| 符号 | 类 | v2 去向 |
|---|---|---|
| BridgeClientAPI / CoreProcessClientDeps / ICoreProcessService / CoreProcessServiceOptions / CoreProcessService | v/t | 无 — 刻意消失(v2 单进程,边缘由 kap-server 承担,主文档 A.3) |
| IEventService | v | 根 · `app/event/event.ts` |
| EventService | v | 深 · `app/event/eventService.ts`(根仅 side-effect import) |
| IApprovalService | v | 无 — 改名 `ISessionApprovalService`(`session/approval/approval.ts:24`,根) |
| ApprovalRequest / ApprovalResponse(dup) | t | 与 rpc/sdk-api **同一 symbol**(`services/approval/approval.ts:55,64` 转口 re-export),去向见块 3;v1 根注释所称「不再导出」与 `services/index.ts:13` 的实际 re-export 并存——因同源故无冲突 |
| approvalToAgentCoreResponse / approvalToBrokerRequest / ApprovalToBrokerRequestParams | v/t | 无 — 出引擎(klient/kap-server 侧映射) |
| IQuestionService | v | 无 — 改名 `ISessionQuestionService`(`session/question/questionService.ts`,根) |
| QuestionRequest / QuestionResult(dup) | t | 与 rpc 同一 symbol(`services/question/question.ts:52,62`),去向见块 3 |
| questionToAgentCoreResponse / questionToBrokerRequest / questionDismissedResult / QuestionToBrokerRequestParams | v/t | 无 — 出引擎 |
| IEnvironmentService | v | 无 — 改 `IHostEnvironment`(`os/interface/hostEnvironment.ts`,根)**待核** |
| ILogService | v | 根 · `_base/log/log.ts:37` |
| IFileStore / FileStore | v | 无 — 改 `IFileService`/`FileServiceImpl`(`app/file/fileService.ts:36` / `fileServiceImpl.ts:45`,根) |
| DEFAULT_MAX_UPLOAD_BYTES | v | 无(v2 全 src 无同名) |
| FileNotFoundError / FileTooLargeError | v | 无 — v2 文件错误聚合 `app/file/fileService.ts`(`FileErrors`,根)**待核** |
| SaveOptions / GetResult | t | 根 · `app/file/fileService.ts` |
| IFsService / FsService | v | 无 — 改 `IHostFileSystem`(`os/interface/hostFileSystem.ts`,根)+ `workspace/workspaceFs/` |
| FsAlreadyExistsError / FsPathNotFoundError / FsIsDirectoryError / FsIsBinaryError / FsTooLargeError / FsTooManyResultsError | v | 无 — `workspace/workspaceFs/internal/errors.ts`(`FsErrors`,根)**待核**(逐个) |
| FsDownloadResolved / FsPathResolved | t | 根 · `workspace/workspaceFs/fs.ts` |
| IFsSearchService / FsSearchService / FsGrepTimeoutError | v | 无 — `workspace/workspaceFs/internal/runRg.ts` + `rgLocator.ts`(根)**待核** |
| IFsGitService / FsGitService / FsGitUnavailableError | v | 无 — 改 `workspace/workspaceGit/` + `app/git/`(根)**待核** |
| parsePorcelain / parseNumstat | v | 深 · `app/git/gitParsers.ts` |
| IFsWatcher / FsWatcherService / FsWatchLimitError / createConnectionLookup / FsChangedFrame / FsWatcherDeliverySink / FsWatcherConnectionLookup / FsWatcherServiceOptions | v/t | 无 — 改 `IHostFsWatch`(`os/interface/hostFsWatch.ts`)+ `workspace/workspaceFs/fsWatch.ts`(根)**待核** |
| FsPathEscapesError / resolveSafePath / PathSafetyResult | v/t | 无 **待核** |
| IWorkspaceRegistry / WorkspaceRegistryService / WorkspaceNotFoundError / WorkspaceRootNotFoundError / WorkspacePatch | v/t | 无 — 改 `app/workspace/` + `workspace/workspaceInstance/`(根)**待核** |
| IWorkspaceFsService | v | 根 · `workspace/workspaceFs/fs.ts:247` |
| WorkspaceFsNotAbsoluteError / WorkspaceFsNotFoundError / WorkspaceFsPermissionError | v | 无 — `workspace/workspaceFs/internal/errors.ts`(根)**待核** |
| RECENT_ROOTS_LIMIT | v | 根 · `app/hostFolderBrowser/hostFolderBrowser.ts` |
| WorkspaceFsService | v | 根 · `workspace/workspaceFs/fsService.ts` |
| IAuthSummaryService / AuthProvisioningRequiredError / AuthTokenMissingError / AuthModelNotResolvedError | v | 根 · `app/auth/auth.ts` |
| AuthTokenUnauthorizedError | v | 无 **待核** |
| AuthSummaryService | v | 根 · `app/auth/authService.ts` |
| IOAuthService / OAuthService | v | 根 · `app/auth/auth.ts` / `app/auth/authService.ts`(v1 为 device-code 登录编排,语义对应已核) |
| IModelCatalogService / ModelCatalogService | v | 无 — 改 `llm-adapter/model/catalog-service`(根,主文档 A.3)**待核**(服务名) |
| ModelNotFoundError / ProviderNotFoundError | v | 无 — `llm-adapter/model/errors.ts`(根)**待核** |
| modelIdsForProvider / toProtocolModel / toProtocolProvider | v | 根 · `llm-adapter/model/catalog.ts` |
| ProviderCredentialState | t | 根 · `llm-adapter/model/catalog.ts` |
| IConfigService / ConfigService | v | 根 · `app/config/config.ts` / `app/config/configService.ts` |
| ISessionService / SessionService / SessionNotFoundError / SessionUndoUnavailableError / toProtocolSession / SessionClientTelemetry / SessionCreateOptions | v/t | 无 — 改 `app/sessionManager/` + `workspace/sessionLifecycle/`(根;出引擎部分在 kap-server) |
| SessionListQuery | t | 根 · `app/sessionIndex/sessionIndex.ts` |
| IMessageService / MessageService / MessageNotFoundError / deriveMessageId / parseMessageId / toProtocolMessage / MessageListQuery | v/t | 无 — 出引擎(kap-server 侧 services,主文档 A.3);`deriveMessageId` 近邻 `agent/contextMemory/messageId.ts`(根)**待核** |
| readWireRecords / readWireTranscript / reduceWireRecords / TranscriptEntry / WireTranscript | v/t | 无 — 近邻 `packages/transcript` reducer(主文档 2.3 注意)**待核** |
| IPromptService / PromptService / PromptAlreadyCompletedError / PromptNotFoundError / SessionBusyError / AgentStateSnapshot / PromptAbortResult / PromptDispatchLogEntry / SyntheticPrompt*Event(4 个) | v/t | 无 — 引擎侧改 `agent/prompt/` + `agent/loop/`(根);协议部分出引擎 **待核** |
| IToolService / ToolService / toProtocolTool / AgentCoreToolInfoLike | v/t | 无 — 改 `agent/toolRegistry/` + `tool/toolContract.ts`(根)**待核** |
| IMcpService / McpService / McpServerNotFoundError / toProtocolMcpServer | v/t | 无 — 改 `app/mcpManagement/`(根,主文档 A.3) |
| ISkillService / SkillService / SkillNotActivatableError / toProtocolSkill | v/t | 无 — 改 `features/skill/`(根)**待核** |
| SkillNotFoundError | v | 根 · `features/skill/catalog/registry.ts:14` |
| ITaskService / TaskService | v | 根 · `app/task/task.ts` / `app/task/taskService.ts` |
| TaskAlreadyFinishedError / TaskNotFoundError / toProtocolTask / isTerminalStatus / TaskListQuery | v/t | 无 **待核** |
| ITerminalService / TerminalService | v | 无 — 改 `ISessionTerminalService`/`SessionTerminalService`(`session/terminal/terminalService.ts:40,61`,根) |
| TerminalNotFoundError | v | 无 **待核** |
| TerminalAttachOptions / TerminalAttachSink / TerminalFrame / TerminalProcess / TerminalSpawnOptions | t | 根 · `os/interface/terminal.ts` |
| TerminalBackend / TerminalServiceOptions | t | 无 **待核** |
| NodePtyTerminalBackend | v | 无 — 改 `HostTerminalService`(`os/backends/node-local/hostTerminalService.ts:9`,根) |

## 同名碰撞与陷阱(汇总)

1. **ApprovalRequest/ApprovalResponse**:v2 根裸名 = `agent/permissionPolicy/types.ts`(工具审批策略);v1 协议形状在 v2 根为 `SessionApprovalRequest`/`SessionApprovalResponse` 别名(`index.ts:525-530`)。
2. **Event**:v1 根 `Event` = 协议 union(留 `@moonshot-ai/protocol`);v2 `_base/event.ts` 的 `Event<T>` 是 emitter 接口(深)。
3. **AgentEvent / ToolResultEvent / SessionCreatedEvent**:v2 同名物分别是 turn 机器 union / `AgentEvent2` 类 / 引擎生命周期事件;协议形状均留 protocol。
4. **TurnStartedEvent / TurnEndedEvent / CronFiredEvent / WarningEvent**:v2 根同名物是埋点/Profile 事件 payload,非协议事件。
5. **BearerTokenProvider**:v2 根同名物在 web-search provider,非 v1 model-provider 抽象。
6. **SessionSummary**:v2 有 3 处定义;根入口显式绑定 `app/sessionIndex/sessionIndex.ts`(`index.ts:731`)。
7. **Emitter / Event<T>**:v2 根入口不导出,仅深子路径 `@moonshot-ai/agent-core-v2/_base/event`。
8. v1 根 barrel 的 20 个 dup 全部是同一 symbol 的双链 re-export(`Approval*`/`Question*` 经 services 转口、`KimiConfig*` 经 core-api 转口、`Goal*` 经 core-api 转口、`PluginCommandDef`/`PluginSummary`/`PluginInfo` 经 core-api 转口、`AgentRecord*`/`KimiErrorPayload`/`CompactionResult` 经 index.ts 具名重复),无 TS 冲突。

## 待核清单(缺证据项)

- v2 服务名精确对应:`IModelCatalogService`、`IEnvironmentService`、fs 系错误类逐个、`IPromptService` 族、`IToolService`、`AgentStateSnapshot`、v1 replay 三函数的消费方替代(`packages/transcript`)、`FsPathSafety` 三符号、`TaskNotFoundError` 等 task 错误、`TerminalNotFoundError`、`AuthTokenUnauthorizedError`、`ImageCompressionTelemetry`。
- 语义收窄未逐项 diff:`McpServerStatusPayload`、`ToolListUpdatedReason`、`SessionCreatedEvent`、`KIMI_ERROR_INFO`→`errorInfo()`、`redact`→`redactCtx`、`flushDiagnosticLogs*`→`drainLogCloses()`、`normalizeWorkDir`、`RunSubagentOptions`→`RunAgentOptions`、`BackgroundConfig`→`AgentTaskConfig`、`McpConfig`→`McpSection`、`ModelAlias*`、`FlagDefinition`→`FlagDefinitionInput`、`CronTaskSnapshot`→`CronTask`、`MoonshotServiceConfig`/`ServicesConfig`、`BearerTokenProvider`/`ModelProvider`/`OAuthTokenProviderResolver`/`ResolvedRuntimeProvider`/`SingleModelProvider` 在 `llm-adapter/` 的逐项落点、`BackgroundTaskInfo` 五类型在 `agent/task/` 的逐项落点、`LoopStep*` 协议形状在 `packages/protocol` 的留存核对。
- 协议事件 31 个「留 protocol」未逐一在 `packages/protocol/src/events.ts` 点名核对(抽查 `UsageStatus` 在 :36 存在)。
- `export *` 冲突解析未经 tsc 实测(上述 dup 分析基于源码同源性)。
- **基线后漂移(待核)**:本文 `packages/protocol/src/events.ts` 引用已在声明基线 `ccf3d5d6` 核实;在当前工作区检出(#3542 之后的 main)中,`packages/protocol` 包已不在原位置。表中条目仍是基线事实;该包的基线后去向待核。
