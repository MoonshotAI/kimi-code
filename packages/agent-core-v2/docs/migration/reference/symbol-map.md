# Symbol map: v1 root barrel → v2

Date: 2026-09-19. Code baseline: `ccf3d5d6` (the direct parent of #3542, the commit that deleted v1 on main). At this commit v1 `@moonshot-ai/agent-core` 0.15.8 and v2 `@moonshot-ai/agent-core-v2` 0.4.3 coexist; every path and symbol in this document was verified against that baseline. All paths are written from the repository root. Sub-document of [`migration-from-v1.md`](../../migration-from-v1.md) (referred to below as "the main document"); Chinese mirror: [`symbol-map.zh-CN.md`](symbol-map.zh-CN.md).

## Scope and method (read first)

- **Expansion**: the v1 root barrel (`packages/agent-core/src/index.ts`, 181 lines) holds 11 `export *` chains (`./agent` `./session` `./rpc` `./config` `./flags` `./session/export` `./telemetry` `./errors` `./plugin` `./di` `./services`), recursively expanded down to leaf files (the `#/x` alias resolves to `src/x` per v1 `package.json#imports`; `errors.ts` / `plugin.ts` are shims that actually point at `errors/index.ts` / `plugin/index.ts`). The remaining named re-exports (`index.ts:10-155`, `169`) are expanded in file order. Total: **734 export records, 714 unique symbols** (20 symbols are exported twice through two chains; the tables merge them and say so).
- **v2 status determination** (v2 `package.json#exports`: `.` → `src/index.ts`, `./*` → `./src/*.ts` — any src file can be imported as a deep subpath):
  - **root** = reachable from the export chain of `packages/agent-core-v2/src/index.ts` (the v2 root barrel exports 2622 symbols in total);
  - **deep** = not exported from the root entry, but exported by some v2 src file — import as `@moonshot-ai/agent-core-v2/<the path in the table, minus .ts>`;
  - **gone** = no same-named export anywhere in v2 src; the note gives a verified replacement or rename where one exists, and **unverified** where not.
- **Same-name collision warning**: reachable from the v2 root does not mean semantically equivalent. Suspicious items were spot-checked one by one; collisions are flagged in the notes and summarized in "Same-name collisions and pitfalls" at the end.
- Consistent with Appendix A (domain mapping) of the main document.
- The v1 origin of each block is stated in the block heading; v2 paths always omit the prefix `packages/agent-core-v2/src/`. Kind: t = type, v = value (class / function / constant).
- Limitations: static regex parsing (comments stripped); `tsc` was not run to verify how `export *` conflicts actually resolve (the only doubtful spot is the Approval/Question note in the services block). The re-exports of rpc/events from `@moonshot-ai/protocol` are named type exports and their symbol names were captured directly.

**Statistics: 714 unique symbols → root 279 / deep 63 / gone 372.**

## Block 1 `export * from './agent'` (index.ts:1; source `agent/index.ts`, whose inner `export * from './goal'` expands to `agent/goal/index.ts`)

| Symbol | Kind | v2 destination |
|---|---|---|
| AgentRecord | t | gone — renamed `WireRecord` (`wire/record.ts:17`, root); persistence changed to `persistence/interface` + `agent/blob/` (main document A.2) |
| AgentRecordPersistence | t | gone — no such abstraction in v2; via `IAppendLogStore` etc. (`persistence/interface/appendLogStore.ts`, root) **unverified** |
| SwarmModeTrigger | t | root · `features/swarm/agent/swarm.ts` |
| BuiltinTool | t | gone — v2 tools are registered via `AgentToolContribution` + `tool/toolContract.ts` **unverified** |
| ToolDisclosure | t | root · `tool/toolContract.ts` |
| ToolInfo | t | root · `tool/toolContract.ts` |
| ToolSource | t | root · `tool/toolContract.ts` |
| UserToolRegistration | t | root · `agent/userTool/userTool.ts` |
| GoalStatus | t | root · `features/goal/types.ts` (also re-exported via `rpc/core-api.ts`, same symbol) |
| GoalActor | t | root · `features/goal/types.ts` |
| GoalBudgetLimits | v | root · `features/goal/types.ts` (same dup) |
| GoalBudgetReport | v | root · `features/goal/types.ts` (same dup) |
| GoalSnapshot | v | root · `features/goal/types.ts` (same dup) |
| GoalToolResult | v | root · `features/goal/types.ts` (same dup) |
| GoalChangeStats | v | root · `features/goal/types.ts` (same dup) |
| GoalChangeKind | t | root · `features/goal/types.ts` |
| GoalChange | v | root · `features/goal/types.ts` (same dup) |
| CreateGoalInput | v | root · `features/goal/types.ts` |
| GoalMode | v | gone — use `IGoalService`/`GoalService` (`features/goal/goalService.ts`, root) |
| AgentType | t | gone — no `AgentType` in v2; the type concept lives in `session/agentLifecycle/` **unverified** |
| AgentOptions | v | gone — instantiation changed to `bootstrap` + `Program` + session controller (main document 2.3) |
| Agent | v | gone — same (main document 2.3); agent-granular state via `agent/state/agentState`, runs via `agent/runtimeBinding/agentRuntime` (both root) |

## Block 2 `export * from './session'` (index.ts:2; source `session/index.ts`, tail chains `./subagent-host`, `./subagent-binding`, `./store`)

| Symbol | Kind | v2 destination |
|---|---|---|
| SessionOptions | v | gone — see main document 2.3 (sessions are managed by `Program.createSessionController()`) |
| SessionSkillConfig | v | gone — use the feature configSection (`features/skill/catalog/configSection.ts`, root) |
| SessionAgentCatalogConfig | v | gone — use `app/agentProfileCatalog/` + `session/sessionAgentProfileCatalog/` (root) |
| AgentMeta | v | root · `session/sessionMetadata/sessionMetadata.ts` |
| CreateAgentOptions | v | root · `session/agentLifecycle/agentLifecycle.ts` |
| SessionMeta | v | root · `session/sessionMetadata/sessionMetadata.ts` |
| Session | v | gone — main document 2.3 |
| DEFAULT_SUBAGENT_TIMEOUT_MS | v | deep · `session/subagent/configSection.ts` |
| DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION | v | gone |
| resolveSubagentTimeoutMs | v | deep · `session/subagent/configSection.ts` |
| formatSubagentTimeoutDescription | v | deep · `session/subagent/configSection.ts` |
| QueuedSubagentRunResult | t | gone — the v1 `subagent-batch` mechanism is gone **unverified** |
| QueuedSubagentTask | t | gone — same |
| ResumeQueuedSubagentTask | t | gone — same |
| SpawnQueuedSubagentTask | t | gone — same |
| RunSubagentOptions | v | gone — nearest neighbor `RunAgentOptions` (`session/subagent/subagent.ts:19`, root) **unverified** |
| SpawnSubagentOptions | v | root · `session/subagent/spawn.ts` |
| SubagentHandle | t | root · `agent/tools/agent/subagent-task.ts:22` |
| SessionSubagentHost | v | gone — use `ISessionSubagentService`/`SessionSubagentService` (`session/subagent/subagent.ts:51` / `subagentService.ts:58`, root) |
| SubagentModelChoice | t | gone — secondary-model moved to `session/subagent/configSection.ts` (deep) |
| SubagentModelBinding | v | gone — same |
| resolveSecondaryModel | v | gone — same |
| resolveSubagentBinding | v | deep · `session/subagent/configSection.ts` |
| buildSubagentModelDescriptions | v | deep · `session/subagent/configSection.ts` |
| stripSubagentModelParameter | v | deep · `session/subagent/configSection.ts` |
| wrapSubagentModelError | v | deep · `session/subagent/configSection.ts` |
| SessionStore | v | gone — split into `persistence/` (appendLog / atomicDocument / query store) + `app/sessionIndex/` + `app/workspace/` (main document A.3) |
| CreateSessionRecordInput | t | gone — same |
| ForkSessionRecordInput | t | gone — same |
| SessionStoreOptions | t | gone — same |
| sessionIndexPath | v | gone |
| encodeWorkDirKey | v | deep · `_base/utils/workdir-slug.ts:17` (node-sdk deep-import precedent, main document 2.2) |
| normalizeWorkDir | v | gone — v2 only has `slugifyWorkDirName` (same file, different semantics) **unverified** |
| workspaceRootKey | v | deep · `_base/utils/workdir-slug.ts:27` |

## Block 3 `export * from './rpc'` (index.ts:3; sources `rpc/client.ts` / `core-api.ts` / `core-impl.ts` / `resumed.ts` / `sdk-api.ts` / `events.ts` / `types.ts`)

The RPC layer left the engine entirely (main document 2.4): protocol types → `packages/protocol` + `packages/klient`; the server side → `packages/kap-server`; the in-process `createRPC` → `IEventBus` + `Event2` (both root). "Left the engine" below always means this and is not repeated.

| Symbol | Kind | v2 destination |
|---|---|---|
| RPCCallOptions / RPCMethods / RPCClient / createRPC / CoreRPCClient / SDKRPCClient / CoreRPC | t/v | gone — left the engine (klient) |
| PluginCommandDef | t | root · `app/plugin/types.ts` (also dup via the `plugin/types.ts` main chain, same symbol) |
| JsonPrimitive / JsonValue / JsonObject | t | root · `agent/replayBuilder/types.ts:13-15` |
| Unsubscribe | t | gone — left the engine |
| KimiConfig / KimiConfigPatch | t | gone — v2 has no single-document config; `IConfigService` + per-domain ConfigSection, see node-sdk `src/v2/config-mapper.ts` (main document 2.2) (dup with the config/schema chain, same symbol) |
| TextPromptPart / PromptPart | t | gone — v2 message parts use the `ContentPart` family (`human/llm/message`, root) **unverified** |
| PromptInput | t | root · `agent/prompt/prompt.ts` |
| EmptyPayload / SessionMetadataPatch / ClientTelemetryInfo / CreateSessionPayload / CloseSessionPayload / ArchiveSessionPayload / DeleteSessionPayload / ResumeSessionPayload / ReloadSessionPayload / ForkSessionPayload | t/v | gone — left the engine |
| ShellEnvironment | v | root · `app/sessionExport/sessionExport.ts:3` |
| ExportSessionPayload / ExportSessionManifest / ExportSessionResult | v | root · `app/sessionExport/sessionExport.ts` |
| ListSessionsPayload / CoreInfo | v | gone — left the engine |
| SessionSummary | v | root · `app/sessionIndex/sessionIndex.ts` (v2 has 3 same-named definitions; the root entry explicitly exports this one, `index.ts:731`) |
| PromptPayload | v | root · `agent/prompt/prompt.ts` |
| RunShellCommandPayload / ShellCommandResult / CancelShellCommandPayload | v | gone — left the engine (engine side: `agent/shellCommand/shellCommand.ts`, root, different shape) **unverified** |
| SteerPayload | v | root · `agent/prompt/prompt.ts` |
| CancelPayload / SetThinkingPayload / SetPermissionPayload / SetModelPayload / SetModelResult / CancelPlanPayload / EnterSwarmPayload / BeginCompactionPayload / UndoHistoryPayload / ImportContextPayload / RegisterToolPayload / UnregisterToolPayload / SetActiveToolsPayload / StopBackgroundPayload / DetachBackgroundPayload / GetBackgroundOutputPayload / GetBackgroundPayload | v | gone — left the engine |
| SkillSummary | v | root · `features/skill/catalog/types.ts` |
| ActivateSkillPayload / ListWorkspaceSkillsPayload | v | gone — left the engine |
| ActivatePluginCommandPayload | v | root · `agent/pluginCommand/pluginCommand.ts` |
| McpServerInfo / McpStartupMetrics / ReconnectMcpServerPayload / AddSessionMcpServerPayload | v | gone — left the engine |
| GlobalMcpServerConfig | t | root · `app/mcpManagement/mcpManagement.ts` |
| McpServerSource | t | root · `app/mcpRegistry/mcpRegistry.ts` |
| McpManagedServerInfo / ListGlobalMcpServersPayload / GetGlobalMcpServerPayload / PutGlobalMcpServerPayload / GlobalMcpServerNamePayload | t/v | gone — left the engine |
| McpServerLocator | t | root · `app/mcpManagement/mcpManagement.ts` |
| McpServerLocatorPayload / InspectAppMcpServersPayload / GlobalMcpServerAuthState / GlobalMcpServerAuthStatus / ListGlobalMcpServerAuthStatusesPayload / AppMcpServerAuthState / AppMcpServerConfig / AppMcpServerDescriptor / AppMcpServerInspection / BeginGlobalMcpServerAuthResult / CompleteGlobalMcpServerAuthPayload / CancelGlobalMcpServerAuthPayload / TestGlobalMcpServerPayload / GlobalMcpServerTestResult / InstallPluginPayload / SetPluginEnabledPayload / SetPluginMcpServerEnabledPayload / RemovePluginPayload / GetPluginInfoPayload / ReloadPluginsResult | t/v | gone — left the engine |
| PluginSummary / PluginInfo | t | root · `app/plugin/types.ts` (dup with the plugin/types main chain) |
| AddAdditionalDirPayload / AddAdditionalDirResult / RenameSessionPayload / UpdateSessionMetadataPayload / CreateGoalPayload / GetKimiConfigPayload / ConfigDiagnostics / SetKimiConfigPayload / RemoveKimiProviderPayload / GetCronTasksResult / AgentAPI / SessionAPI / CoreAPI | v | gone — left the engine |
| KimiCoreOptions / KimiCore | v | gone — left the engine; the server side is kap-server; in-process use `bootstrap`+`Program` (main document 2.3) |
| AgentReplayRecordPayload / AgentReplayRecord / ResumedAgentState / ResumeSessionResult | t | root · `agent/replayBuilder/types.ts` |
| ApprovalDecision | t | root · `session/approval/approval.ts` |
| ApprovalScope | t | gone — left the engine **unverified** |
| ApprovalResponse / ApprovalRequest | v | root — **trap**: the bare v2 root names are a different shape from `agent/permissionPolicy/types.ts`; the v1 protocol shapes are exported at the v2 root under the aliases `SessionApprovalResponse`/`SessionApprovalRequest` (v2 `index.ts:525-530`, source `session/approval/approval.ts`) (also dup via the services chain, same origin as rpc — see the block 13 note) |
| QuestionOption / QuestionItem | v | root · `session/question/question.ts` |
| QuestionAnswerMethod / QuestionAnswers | t | root · `session/question/question.ts` |
| QuestionResponse / QuestionResult / QuestionRequest | v | root · `session/question/question.ts` (the latter two also dup via the services chain, same origin) |
| ToolCallRequest / ToolCallResponse | v | gone — left the engine |
| SDKAgentAPI / SDKAgentRPC / SDKSessionAPI / SDKSessionRPC / SDKAPI / SDKRPC | v/t | gone — left the engine |
| MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE | v | deep · `agent/mcp/tools/auth.ts` (main document 2.2); also still held by `@moonshot-ai/protocol` |
| AgentEvent | t | the real thing stays in `@moonshot-ai/protocol`; the same-named item in v2 `human/agent/machine.ts:32` (deep) is the turn-machine event union — **a different thing** |
| AgentStatusUpdatedEvent / AssistantDeltaEvent / BackgroundTaskStartedEvent / BackgroundTaskTerminatedEvent / CompactionBlockedEvent / CompactionCancelledEvent / CompactionCompletedEvent / CompactionStartedEvent / ErrorEvent / GoalUpdatedEvent / HookResultEvent / McpServerStatusEvent / PluginCommandActivatedEvent / SessionMetaUpdatedEvent / SessionStatusChangedEvent / SessionWorkChangedEvent / SkillActivatedEvent / SubagentCompletedEvent / SubagentFailedEvent / SubagentSpawnedEvent / SubagentStartedEvent / SubagentSuspendedEvent / ThinkingDeltaEvent / ToolCallDeltaEvent / ToolCallStartedEvent / ToolListUpdatedEvent / ToolProgressEvent / TurnStepCompletedEvent / TurnStepInterruptedEvent / TurnStepRetryingEvent / TurnStepStartedEvent | t | gone — stay in `@moonshot-ai/protocol` (`packages/protocol/src/events.ts`); engine events use `IEventBus`+`Event2` (turn events are the `AgentEvent2` classes in `agent/loop/turnEvents.ts`, deep) |
| CompactionResult | t | root · `agent/fullCompaction/types.ts` (in-engine result; the protocol event payload stays in protocol) (dup with the block 10 agent/compaction chain) |
| CronFiredEvent | t | **collision**: root · `app/telemetry/events.ts:428` is a telemetry payload; the protocol event stays in protocol |
| Event | t | the real thing (the protocol union) stays in `@moonshot-ai/protocol`; `Event<T>` in v2 `_base/event.ts:11` (deep) is the emitter interface — **a different thing** (v1 root `Event` semantics = protocol) |
| McpOAuthAuthorizationUrlUpdateData | t | deep · `agent/mcp/tools/auth.ts` |
| McpServerStatusPayload | t | deep · `agent/mcp/mcpEvents.ts:5` (engine event shape, narrowed) **unverified** |
| SessionCreatedEvent | t | root · `workspace/sessionLifecycle/sessionLifecycle.ts:40` (engine lifecycle event, different shape from the protocol event) **unverified** |
| ToolInputDisplay | t | deep · `tool/toolInputDisplay.ts` |
| ToolListUpdatedReason | t | deep · `agent/mcp/mcpEvents.ts:24` (only the three mcp.* values, narrowed) **unverified** |
| ToolResultEvent | t | deep · `agent/toolExecutor/toolExecutorEvents.ts:44` (an `AgentEvent2` class, different thing); the protocol shape stays in protocol |
| ToolUpdate | t | root · `tool/toolContract.ts` |
| TurnEndedEvent / TurnStartedEvent | t | **collision**: root · `app/telemetry/events.ts:74/:55` are telemetry payloads; the protocol events stay in protocol |
| TurnEndReason | t | deep · `agent/loop/turnEvents.ts:11` |
| UsageStatus | t | root · `agent/usage/usage.ts:21` (v2 engine's own; protocol also holds a same-named one) |
| WarningEvent | t | **collision**: root · `agent/profile/profileService.ts:82` (profile warning event, different thing); the protocol event stays in protocol |
| KimiErrorPayload | t | root · `_base/errors/serialize.ts:14` (`= ErrorPayload` alias) (dup with the errors chain, same symbol) |
| WithAgentId / WithSessionId / proxyWithExtraPayload | t/v | gone — left the engine |

## Block 4 `export * from './config'` (index.ts:4; sources `config/{merge,model,migrations,path,print-defaults,resolve,schema,toml,env-model,secondary-model,workspace-local}.ts`)

v2 has no single-document schema; config is split into `IConfigService` + per-domain `ConfigSection` (main document 2.2, A.1).

| Symbol | Kind | v2 destination |
|---|---|---|
| mergeConfigPatch / effectiveModelAlias / effectiveModelAliases | v | gone — model resolution lives in `app/kosongConfig/` |
| migrateThinkingEffortMaxToHigh | v | deep · `app/config/migrations.ts` (same-named mechanism kept, main document 1.4) |
| resolveKimiHome / resolveConfigPath / ensureKimiHome | v | root · `app/bootstrap/bootstrap.ts` |
| PRINT_WAIT_CEILING_S_DEFAULT / PRINT_MAX_TURNS_DEFAULT / PRINT_SUBAGENT_TIMEOUT_MS_DEFAULT / PRINT_BASH_TASK_TIMEOUT_S_DEFAULT / applyPrintModeConfigDefaults | v | root · `agent/task/printDefaults.ts` |
| ResolveConfigValueInput / resolveConfigValue / parseFloatEnv | v | gone |
| parseBooleanEnv | v | deep · `_base/utils/env.ts` |
| ProviderTypeSchema | v | deep · `app/kosongConfig/configSection.ts` |
| ProviderType | t | root · `llm-adapter/provider/provider.ts` |
| OAuthRefSchema | v | deep · `app/kosongConfig/configSection.ts` |
| OAuthRef | t | root · `llm-adapter/provider/provider.ts` |
| ProviderConfigSchema | v | deep · `app/kosongConfig/configSection.ts` |
| ProviderConfig | t | root · `llm-adapter/provider/provider.ts` |
| ModelAliasOverrideSchema / ModelAliasOverrides / ModelAliasSchema / ModelAlias | v/t | gone **unverified** (neighboring shapes exist inside the kosongConfig section) |
| SecondaryModelConfigSchema / SecondaryModelConfig | v/t | deep · `session/subagent/configSection.ts` |
| ThinkingConfigSchema | v | deep · `app/kosongConfig/configSection.ts` |
| ThinkingConfig | t | root · `llm-adapter/model/thinking.ts` |
| PermissionModeSchema | v | gone — the enum is in `agent/permissionPolicy/types.ts` (root) **unverified** |
| PermissionRuleDecisionSchema / PermissionRuleScopeSchema / PermissionRuleSchema / PermissionConfigSchema / PermissionConfig | v/t | deep · `agent/permissionRules/configSection.ts` |
| LoopControlSchema / LoopControl | v/t | deep · `agent/loop/configSection.ts` |
| BackgroundConfigSchema / BackgroundConfig | v/t | gone — use `agent/task/configSection.ts` (root exports `AgentTaskConfig`/`resolveAgentTaskConfig`) **unverified** |
| SubagentConfigSchema / SubagentConfig | v/t | deep · `session/subagent/configSection.ts` |
| MAX_MCP_TIMEOUT_MS | v | root · `mcpCore/config-schema.ts` |
| McpConfigSchema / McpConfig | v/t | gone — use `app/mcpConfig/configSection.ts` (`McpSection`, named v2 root export) **unverified** |
| ImageConfigSchema / ImageConfig | v/t | deep · `agent/media/configSection.ts` |
| ModelCatalogConfigSchema / ModelCatalogConfig | v/t | root · `app/kosongConfig/configSection.ts` (named v2 root export, `index.ts:215-219`) |
| ExperimentalConfigSchema / ExperimentalConfig | v/t | root · `app/flag/flag.ts` |
| HookDefSchema / HookDefConfig | v/t | root · `features/externalHooks/configSection.ts` |
| MoonshotServiceConfigSchema / MoonshotServiceConfig / ServicesConfigSchema / ServicesConfig | v/t | root · `app/auth/configSection.ts` **unverified** (semantic counterpart) |
| McpServerStdioConfigSchema / McpServerStdioConfig / McpServerHttpConfigSchema / McpServerHttpConfig / McpServerSseConfigSchema / McpServerSseConfig / McpRemoteServerConfig / McpServerConfigSchema / McpServerConfig | v/t | root · `mcpCore/config-schema.ts` |
| KimiConfigSchema / KimiConfigPatchSchema / getDefaultConfig / validateConfig / formatConfigValidationError | v | gone — main document 2.2 (`IConfigService` + section registration) |
| ensureConfigFile / readConfigFile / readConfigFileForUpdate / loadRuntimeConfig / RuntimeConfigLoadResult / loadRuntimeConfigSafe / parseConfigString / writeConfigFile / configToTomlData | v | gone — same |
| transformTomlData | v | deep · `app/config/toml.ts` |
| ENV_MODEL_PROVIDER_KEY | v | deep · `app/kosongConfig/configSection.ts` |
| ENV_MODEL_ALIAS_KEY | v | deep · `app/kosongConfig/envOverlay.ts` |
| applyEnvModelConfig / stripEnvModelConfig | v | gone (the env overlay mechanism lives in `app/kosongConfig/envOverlay.ts`, internal) **unverified** |
| SECONDARY_DERIVED_MODEL_ALIAS / SECONDARY_MODEL_ENV / SECONDARY_MODEL_EFFORT_ENV / secondaryModelPatch / applySecondaryModelConfig / stripSecondaryModelConfig | v | gone — deliberately removed (main document 2.2) |
| WorkspaceAdditionalDirsLoadResult / WorkspaceLocalConfig / loadWorkspaceLocalConfig / readWorkspaceAdditionalDirs / resolveWorkspaceAdditionalDirs / appendWorkspaceAdditionalDir / normalizeAdditionalDirs | v/t | gone — use `app/projectLocalConfig/` (root); `normalizeAdditionalDirs` is an internal, unexported function in v2 `persistence/backends/node-fs/projectLocalConfigService.ts:229` |

## Block 5 `export * from './flags'` (index.ts:5; sources `flags/{types,registry,resolver}.ts`)

| Symbol | Kind | v2 destination |
|---|---|---|
| FlagSurface | t | root · `app/flag/flagRegistry.ts:6` |
| FlagDefinitionInput | v | root · `app/flag/flagRegistry.ts:10` |
| FlagDefinition | t | gone — nearest neighbor `FlagDefinitionInput` (root) **unverified** |
| ExperimentalFlagMap / ExperimentalFlagConfig / ExperimentalFlagSource / ExperimentalFeatureState | t/v | root · `app/flag/flag.ts` |
| ExperimentalFlagResolver | v | gone — use `IFlagService.enabled(id)` (main document 2.2) |
| FLAG_DEFINITIONS | v | gone — use `registerFlagDefinition` (`app/flag/flagRegistry.ts:22`, root) |
| FlagId | t | root · `app/flag/flagRegistry.ts:8` |
| MASTER_ENV | v | root · `app/flag/flagService.ts` |
| FlagResolver / flags (singleton) | v | gone — use `IFlagService` |

## Block 6 `export * from './session/export'` (index.ts:6; sources `session/export/{manifest,session-export,wire-scan,zip}.ts`)

| Symbol | Kind | v2 destination |
|---|---|---|
| WIRE_PROTOCOL_VERSION | v | root · `wire/migration/migration.ts:19` |
| buildExportManifest | v | root · `app/sessionExport/manifest.ts` |
| exportSessionDirectory | v | root · `app/sessionExport/sessionExportService.ts` |
| SessionWireScan / scanSessionWire / normalizeTimestampMs | v | root · `app/sessionExport/wire-scan.ts` |
| collectFilesRecursive / writeExportZip | v | root · `app/sessionExport/zip.ts` |
| ExtraZipEntry | t | root · `app/sessionExport/zip.ts` |

## Block 7 `export * from './telemetry'` (index.ts:7; source `telemetry.ts`)

| Symbol | Kind | v2 destination |
|---|---|---|
| TelemetryPropertyValue | t | gone — renamed `TelemetryPrimitive` (`app/telemetry/context.ts:1`, root) |
| TelemetryProperties | t | root · `app/telemetry/context.ts:3` |
| TelemetryContextPatch | v | root · `app/telemetry/context.ts:22` |
| TelemetryClient | v | gone — use `ITelemetryService` (`app/telemetry/telemetry.ts:29`, root) |
| noopTelemetryClient | v | gone — renamed `noopTelemetryService` (`app/telemetry/telemetry.ts:54`, root) |
| withTelemetryContext / withTelemetryProperties | v | gone — context is passed through the Service (main document 2.2) |

## Block 8 `export * from './errors'` (index.ts:8; source `errors/index.ts` → `{codes,classes,serialize,unexpectedError}.ts`)

| Symbol | Kind | v2 destination |
|---|---|---|
| ErrorCodes | v | root · v2 `src/errors.ts:73` (aggregated per domain) |
| isKimiErrorCode | v | gone — renamed `isErrorCode` (`_base/errors/codes.ts:34`, root) |
| KIMI_ERROR_INFO | v | gone — replaced by the function `errorInfo(code)` (`_base/errors/codes.ts:38`, root) **unverified** |
| KimiErrorCode | t | gone — renamed `ErrorCode` (v2 `src/errors.ts:109`, root) |
| KimiErrorInfo | t | gone — renamed `ErrorInfo` (`_base/errors/codes.ts:1`, root) |
| KimiError | v | gone — renamed `Error2` (`_base/errors/errors.ts:38`, root; main document 2.2) |
| KimiErrorOptions | t | gone — renamed `Error2Options` (`_base/errors/errors.ts:32`, root) |
| fromKimiErrorPayload | v | gone — renamed `fromErrorPayload` (`_base/errors/serialize.ts:91`, root) |
| isKimiError | v | gone — renamed `isError2` (`_base/errors/errors.ts:50`, root) |
| makeErrorPayload | v | root · `_base/errors/serialize.ts:33` |
| toKimiErrorPayload | v | root · `_base/errors/serialize.ts:89` (`= toErrorPayload`) |
| onUnexpectedError / resetUnexpectedErrorHandler / safelyCallListener / setUnexpectedErrorHandler / UnexpectedErrorHandler | v/t | root · `_base/errors/unexpectedError.ts` |

## Block 9 `export * from './plugin'` (index.ts:9; source `plugin/index.ts` → `types.ts` etc.)

All **root** exports, landing on same-named files under `app/plugin/`: `PluginDiagnosticSeverity` (t), `PluginDiagnostic`, `PluginAuthor`, `PluginSessionStart`, `PluginInterface`, `PluginManifest`, `PluginMcpServerState`, `PluginCapabilityState`, `PluginMcpServerInfo`, `PluginMcpServerEntry`, `PluginCommandDef` (dup with the rpc chain), `PluginCommandEntry`, `PluginManifestKind` (t), `PluginSource` (t), `PluginState` (t), `PluginGithubRef`, `PluginGithubMetadata`, `PluginRecord`, `PluginSummary`/`PluginInfo` (dup), `EnabledPluginSessionStart`, `EnabledPluginSystemPrompt`, `ReloadSummary`, `PLUGIN_NAME_REGEX`, `normalizePluginId` → all `app/plugin/types.ts`; `parseManifest`/`ParsedManifestResult` → `app/plugin/manifest.ts`; `readInstalled`/`writeInstalled`/`InstalledFile`/`InstalledRecord` → `app/plugin/store.ts`; `PluginManager`/`PluginManagerOptions` → `app/plugin/manager.ts`; `resolveInstallSource`/`InstallSource`/`ResolvedSource` → `app/plugin/source.ts`; `downloadZip`/`extractZip` → `app/plugin/archive.ts`.

## Block 10 Named re-exports (index.ts:10-155)

| Symbol | Kind | v2 destination |
|---|---|---|
| buildReplay (line 10, `agent/replay/build`) | v | gone — only types remain in the engine (`agent/replayBuilder/types.ts`, root); the implementation left the engine (main document 2.2 / the note in 2.3) |
| isAgentReplayUserTurnRecord / limitAgentReplayByTurns (line 11, `agent/replay/turns`) | v | gone — same |
| flushDiagnosticLogs / flushDiagnosticLogsSync (`logging/logger`) | v | gone — shutdown uses `drainLogCloses()` (`_base/log/logService.ts:30`, root) **unverified** (semantic counterpart) |
| getRootLogger / log | v | gone — use `ILogService` + `logSeed` (`_base/log/logConfig.ts:54`, root; main document 2.2) |
| redact | v | gone — renamed `redactCtx` (`_base/log/formatter.ts:54`, root) **unverified** |
| resolveGlobalLogPath | v | root · `_base/log/logConfig.ts` |
| resolveLoggingConfig / ResolveLoggingInput | v/t | root · `_base/log/logConfig.ts` |
| installGlobalProxyDispatcher (line 22, `utils/proxy`) | v | deep · `_base/utils/proxy.ts:218` |
| LogContext / LogEntry / LogLevel / LogPayload | t | root · `_base/log/log.ts` |
| Logger / RootLogger | t | gone — use `ILogger`/`ILogService` (`_base/log/log.ts:37`, root) **unverified** |
| LoggingConfig | t | root · `_base/log/logConfig.ts` |
| SessionAttachInput / SessionLogHandle | t | gone — session logging uses `session/sessionLog/sessionLogService` (root) **unverified** |
| USER_PROMPT_ORIGIN (line 34) | v | root · `agent/contextMemory/types.ts` |
| parseAgentFileText / resolveAgentPath (line 35) | v | root · `workspace/workspaceAgentProfileLoader/internal/agentFile.ts` / `.../paths.ts` |
| renderToolResultForModel / RenderableToolResult (lines 36-37) | v/t | deep · `agent/contextMemory/toolResultRender.ts` |
| AgentContextData / ContextMessage / PromptOrigin / UserPromptOrigin | t | root · `agent/contextMemory/types.ts` |
| AgentBackgroundTaskInfo / BackgroundTaskInfo / BackgroundTaskStatus / ProcessBackgroundTaskInfo / QuestionBackgroundTaskInfo (lines 44-50) | t | gone — use `agent/task/task.ts` (`IAgentTaskEntry` etc., root) + `app/task/` **unverified** (shape, item by item) |
| CronTaskSnapshot (line 51) | t | gone — renamed `CronTask` (`features/cron/cronTask.ts:1`, root) **unverified** |
| ToolServices (line 52, `tools/support/services`, = `{ urlFetcher?, webSearcher? }`) | t | gone — v2 injects via `app/web/providers/` + `app/auth/webSearch/` (root) |
| buildImageCompressionCaption / compressImageForModel / compressBase64ForModel / gateImageFormatParts / resolveMaxImageEdgePx / resolveReadImageByteBudget / IMAGE_BYTE_BUDGET / MAX_IMAGE_EDGE_PX / READ_IMAGE_BYTE_BUDGET | v | root · `agent/media/image-compress.ts` |
| compressImageContentParts / cropImageForModel / formatByteSize | v | deep · `agent/media/image-compress.ts` |
| MODEL_ACCEPTED_IMAGE_MIMES / buildImageConversionGuidance / buildUnsupportedImageNotice / decodeBase64Prefix / isModelAcceptedImageMime / normalizeImageMime / parseImageDataUrl / resolveEffectiveImageMime / unsupportedImageMimeFromUrl | v | root · `agent/media/image-format-policy.ts` |
| ImageLimits (line 89) | v | gone — deliberately removed (main document 2.2): use the constants + `agent/media/configSection.ts` + `IImageConfigBridge` (`agent/media/imageConfigBridge.ts`, root) |
| CompressAnnotateOptions / CompressedContentParts / CompressImageOptions / CompressImageResult / CompressBase64Result / CropImageOptions / CropImageOutcome / ImageCompressionCaptionInput / ImageCropRegion / ImageVariantDescription | t | deep · `agent/media/image-compress.ts` |
| ImageCompressionTelemetry | t | gone **unverified** |
| originalImageCacheDir | v | deep · `agent/media/image-originals.ts` |
| persistOriginalImage / sessionMediaOriginalsDir | v | root · `agent/media/image-originals.ts` |
| PersistOriginalImageOptions | t | deep · `agent/media/image-originals.ts` |
| SingleModelProvider (line 109) | v | gone — `llm-adapter/provider/` + `app/kosongConfig/` (main document A.3) **unverified** |
| BearerTokenProvider (line 111) | t | **collision**: root · `app/auth/webSearch/providers/moonshot-web-search.ts:4` (web-search token, different thing); where the v1 model-provider abstraction really went **unverified** (`llm-adapter/model/model-oauth.ts`?) |
| ModelProvider / OAuthTokenProviderResolver / ResolvedRuntimeProvider | t | gone — `llm-adapter/provider/provider.ts` + `IModelService` (`llm-adapter/model/model.ts:63`, root) **unverified** (item by item) |
| AgentRecord / AgentRecordPersistence (lines 118-123, dup with block 1) | t | see block 1 |
| AgentRecordEvents / AgentRecordOf | t | gone — the wire vocabulary moved to `wire/` + `wire-manifest.d.ts` **unverified** |
| AGENT_WIRE_PROTOCOL_VERSION (line 124) | v | gone — renamed `WIRE_PROTOCOL_VERSION` (`wire/migration/migration.ts:19`, root; 1.4→1.5) |
| AgentConfigUpdateData (line 125) | t | root · `agent/profile/profile.ts` |
| CompactionBeginData / CompactionResult (line 126) | t | root · `agent/fullCompaction/types.ts` (CompactionResult dup with the rpc/events chain) |
| COMPACT_USER_MESSAGE_HEAD_TOKENS / COMPACT_USER_MESSAGE_MAX_TOKENS / COMPACTION_ELISION_VARIANT / buildCompactionElisionText / collectCompactableUserMessages / isRealUserInput / selectCompactionUserMessages / selectRecentUserMessages | v | root · `agent/contextMemory/compactionHandoff.ts` |
| PermissionApprovalResultRecord | t | root · `agent/permissionRules/permissionRules.ts` |
| PermissionMode | t | root · `agent/permissionPolicy/types.ts` |
| UsageRecordScope | t | deep · `agent/usage/usageOps.ts` |
| ToolStoreUpdate | t | gone — `ToolStore` deliberately removed (main document 2.2) |
| LoopRecordedEvent | t | root · `agent/contextMemory/loopEventFold.ts` |
| LoopStepBeginEvent / LoopStepEndEvent / LoopContentPartEvent / LoopToolCallEvent / LoopToolResultEvent | t | gone — the engine side is the `AgentEvent2` classes in `agent/loop/turnEvents.ts` (deep); the protocol shapes stay in protocol **unverified** |
| ExecutableToolResult / ExecutableToolSuccessResult / ExecutableToolErrorResult | t | root · `tool/toolContract.ts` |

## Block 11 `export * from './di'` (index.ts:158)

Except for the 4 listed below, everything is **root**-exported with a same-named counterpart in the same-named file under v2 `_base/di/`: `ServiceIdentifier`/`ServicesAccessor`/`ServiceCollectionLike`/`BrandedService`/`IConstructorSignature`/`GetLeadingNonServiceArgs`/`createDecorator`/`refineServiceDecorator`/`IInstantiationService` → `_base/di/instantiation.ts`; `SyncDescriptor`/`SyncDescriptor0` → `_base/di/descriptors.ts`; `ServiceCollection` → `_base/di/serviceCollection.ts`; `InstantiationService` → `_base/di/instantiationService.ts`; `Disposable`/`DisposableStore`/`DisposableMap`/`DisposableSet`/`MutableDisposable`/`MandatoryMutableDisposable`/`RefCountedDisposable`/`ReferenceCollection`/`AsyncReferenceCollection`/`ImmortalReference`/`DisposableTracker`/`combinedDisposable`/`toDisposable`/`dispose`/`disposeIfDisposable`/`disposeOnReturn`/`thenIfNotDisposed`/`thenRegisterOrDispose`/`isDisposable`/`markAsSingleton`/`setDisposableTracker`/`trackDisposable`/`markAsDisposed`/`IDisposable`/`IDisposableTracker`/`IReference` → `_base/di/lifecycle.ts`; `CyclicDependencyError` → `_base/di/errors.ts`.

| Symbol | Kind | v2 destination |
|---|---|---|
| InstantiationType / registerSingleton / getSingletonServiceDescriptors / _clearRegistryForTests | v | gone — v2 has no `di/extensions.ts`; service registration changed to `ServiceCollection`/scope seeds + self-registration in `*Service.ts` (main document A.1) |

## Block 12 `export { Emitter } from './base/common/event'` (index.ts:169)

| Symbol | Kind | v2 destination |
|---|---|---|
| Emitter | v | deep · `_base/event.ts:42` — the v2 root entry does **not** export it (symmetric to the v1 root barrel deliberately not exporting `Event<T>`: the v2 root has no `_base/event` outlet; the same file also holds the `Event<T>` interface, `AsyncEmitter`, and `namespace Event`) |

## Block 13 `export * from './services'` (index.ts:181; source `services/index.ts`)

| Symbol | Kind | v2 destination |
|---|---|---|
| BridgeClientAPI / CoreProcessClientDeps / ICoreProcessService / CoreProcessServiceOptions / CoreProcessService | v/t | gone — deliberately removed (v2 is single-process, the edge is carried by kap-server; main document A.3) |
| IEventService | v | root · `app/event/event.ts` |
| EventService | v | deep · `app/event/eventService.ts` (the root holds only a side-effect import) |
| IApprovalService | v | gone — renamed `ISessionApprovalService` (`session/approval/approval.ts:24`, root) |
| ApprovalRequest / ApprovalResponse (dup) | t | **same symbol** as rpc/sdk-api (pass-through re-export at `services/approval/approval.ts:55,64`) — destination in block 3; the v1 root comment claiming "no longer exported" coexists with the actual re-export at `services/index.ts:13` — no conflict because same origin |
| approvalToAgentCoreResponse / approvalToBrokerRequest / ApprovalToBrokerRequestParams | v/t | gone — left the engine (klient/kap-server-side mapping) |
| IQuestionService | v | gone — renamed `ISessionQuestionService` (`session/question/questionService.ts`, root) |
| QuestionRequest / QuestionResult (dup) | t | same symbol as rpc (`services/question/question.ts:52,62`), destination in block 3 |
| questionToAgentCoreResponse / questionToBrokerRequest / questionDismissedResult / QuestionToBrokerRequestParams | v/t | gone — left the engine |
| IEnvironmentService | v | gone — use `IHostEnvironment` (`os/interface/hostEnvironment.ts`, root) **unverified** |
| ILogService | v | root · `_base/log/log.ts:37` |
| IFileStore / FileStore | v | gone — use `IFileService`/`FileServiceImpl` (`app/file/fileService.ts:36` / `fileServiceImpl.ts:45`, root) |
| DEFAULT_MAX_UPLOAD_BYTES | v | gone (no same-named symbol anywhere in v2 src) |
| FileNotFoundError / FileTooLargeError | v | gone — v2 file errors are aggregated in `app/file/fileService.ts` (`FileErrors`, root) **unverified** |
| SaveOptions / GetResult | t | root · `app/file/fileService.ts` |
| IFsService / FsService | v | gone — use `IHostFileSystem` (`os/interface/hostFileSystem.ts`, root) + `workspace/workspaceFs/` |
| FsAlreadyExistsError / FsPathNotFoundError / FsIsDirectoryError / FsIsBinaryError / FsTooLargeError / FsTooManyResultsError | v | gone — `workspace/workspaceFs/internal/errors.ts` (`FsErrors`, root) **unverified** (one by one) |
| FsDownloadResolved / FsPathResolved | t | root · `workspace/workspaceFs/fs.ts` |
| IFsSearchService / FsSearchService / FsGrepTimeoutError | v | gone — `workspace/workspaceFs/internal/runRg.ts` + `rgLocator.ts` (root) **unverified** |
| IFsGitService / FsGitService / FsGitUnavailableError | v | gone — use `workspace/workspaceGit/` + `app/git/` (root) **unverified** |
| parsePorcelain / parseNumstat | v | deep · `app/git/gitParsers.ts` |
| IFsWatcher / FsWatcherService / FsWatchLimitError / createConnectionLookup / FsChangedFrame / FsWatcherDeliverySink / FsWatcherConnectionLookup / FsWatcherServiceOptions | v/t | gone — use `IHostFsWatch` (`os/interface/hostFsWatch.ts`) + `workspace/workspaceFs/fsWatch.ts` (root) **unverified** |
| FsPathEscapesError / resolveSafePath / PathSafetyResult | v/t | gone **unverified** |
| IWorkspaceRegistry / WorkspaceRegistryService / WorkspaceNotFoundError / WorkspaceRootNotFoundError / WorkspacePatch | v/t | gone — use `app/workspace/` + `workspace/workspaceInstance/` (root) **unverified** |
| IWorkspaceFsService | v | root · `workspace/workspaceFs/fs.ts:247` |
| WorkspaceFsNotAbsoluteError / WorkspaceFsNotFoundError / WorkspaceFsPermissionError | v | gone — `workspace/workspaceFs/internal/errors.ts` (root) **unverified** |
| RECENT_ROOTS_LIMIT | v | root · `app/hostFolderBrowser/hostFolderBrowser.ts` |
| WorkspaceFsService | v | root · `workspace/workspaceFs/fsService.ts` |
| IAuthSummaryService / AuthProvisioningRequiredError / AuthTokenMissingError / AuthModelNotResolvedError | v | root · `app/auth/auth.ts` |
| AuthTokenUnauthorizedError | v | gone **unverified** |
| AuthSummaryService | v | root · `app/auth/authService.ts` |
| IOAuthService / OAuthService | v | root · `app/auth/auth.ts` / `app/auth/authService.ts` (v1 was device-code login orchestration; semantic counterpart verified) |
| IModelCatalogService / ModelCatalogService | v | gone — use `llm-adapter/model/catalog-service` (root, main document A.3) **unverified** (service name) |
| ModelNotFoundError / ProviderNotFoundError | v | gone — `llm-adapter/model/errors.ts` (root) **unverified** |
| modelIdsForProvider / toProtocolModel / toProtocolProvider | v | root · `llm-adapter/model/catalog.ts` |
| ProviderCredentialState | t | root · `llm-adapter/model/catalog.ts` |
| IConfigService / ConfigService | v | root · `app/config/config.ts` / `app/config/configService.ts` |
| ISessionService / SessionService / SessionNotFoundError / SessionUndoUnavailableError / toProtocolSession / SessionClientTelemetry / SessionCreateOptions | v/t | gone — use `app/sessionManager/` + `workspace/sessionLifecycle/` (root; the out-of-engine part is in kap-server) |
| SessionListQuery | t | root · `app/sessionIndex/sessionIndex.ts` |
| IMessageService / MessageService / MessageNotFoundError / deriveMessageId / parseMessageId / toProtocolMessage / MessageListQuery | v/t | gone — left the engine (kap-server-side services, main document A.3); nearest neighbor for `deriveMessageId` is `agent/contextMemory/messageId.ts` (root) **unverified** |
| readWireRecords / readWireTranscript / reduceWireRecords / TranscriptEntry / WireTranscript | v/t | gone — nearest neighbor is the `packages/transcript` reducer (main document 2.3 note) **unverified** |
| IPromptService / PromptService / PromptAlreadyCompletedError / PromptNotFoundError / SessionBusyError / AgentStateSnapshot / PromptAbortResult / PromptDispatchLogEntry / SyntheticPrompt*Event (4 of them) | v/t | gone — the engine side uses `agent/prompt/` + `agent/loop/` (root); the protocol part left the engine **unverified** |
| IToolService / ToolService / toProtocolTool / AgentCoreToolInfoLike | v/t | gone — use `agent/toolRegistry/` + `tool/toolContract.ts` (root) **unverified** |
| IMcpService / McpService / McpServerNotFoundError / toProtocolMcpServer | v/t | gone — use `app/mcpManagement/` (root, main document A.3) |
| ISkillService / SkillService / SkillNotActivatableError / toProtocolSkill | v/t | gone — use `features/skill/` (root) **unverified** |
| SkillNotFoundError | v | root · `features/skill/catalog/registry.ts:14` |
| ITaskService / TaskService | v | root · `app/task/task.ts` / `app/task/taskService.ts` |
| TaskAlreadyFinishedError / TaskNotFoundError / toProtocolTask / isTerminalStatus / TaskListQuery | v/t | gone **unverified** |
| ITerminalService / TerminalService | v | gone — use `ISessionTerminalService`/`SessionTerminalService` (`session/terminal/terminalService.ts:40,61`, root) |
| TerminalNotFoundError | v | gone **unverified** |
| TerminalAttachOptions / TerminalAttachSink / TerminalFrame / TerminalProcess / TerminalSpawnOptions | t | root · `os/interface/terminal.ts` |
| TerminalBackend / TerminalServiceOptions | t | gone **unverified** |
| NodePtyTerminalBackend | v | gone — use `HostTerminalService` (`os/backends/node-local/hostTerminalService.ts:9`, root) |

## Same-name collisions and pitfalls (summary)

1. **ApprovalRequest/ApprovalResponse**: the bare v2 root names = `agent/permissionPolicy/types.ts` (tool approval policy); the v1 protocol shapes are at the v2 root as the `SessionApprovalRequest`/`SessionApprovalResponse` aliases (`index.ts:525-530`).
2. **Event**: v1 root `Event` = the protocol union (stays in `@moonshot-ai/protocol`); v2 `_base/event.ts`'s `Event<T>` is the emitter interface (deep).
3. **AgentEvent / ToolResultEvent / SessionCreatedEvent**: the v2 same-named items are respectively the turn-machine union / an `AgentEvent2` class / an engine lifecycle event; the protocol shapes all stay in protocol.
4. **TurnStartedEvent / TurnEndedEvent / CronFiredEvent / WarningEvent**: the v2 root same-named items are telemetry / profile event payloads, not protocol events.
5. **BearerTokenProvider**: the v2 root same-named item is in the web-search provider, not the v1 model-provider abstraction.
6. **SessionSummary**: v2 has 3 definitions; the root entry explicitly binds `app/sessionIndex/sessionIndex.ts` (`index.ts:731`).
7. **Emitter / Event<T>**: not exported from the v2 root entry; deep subpath only, `@moonshot-ai/agent-core-v2/_base/event`.
8. All 20 dups in the v1 root barrel are double-chain re-exports of the same symbol (`Approval*`/`Question*` via services pass-through, `KimiConfig*` via core-api pass-through, `Goal*` via core-api pass-through, `PluginCommandDef`/`PluginSummary`/`PluginInfo` via core-api pass-through, `AgentRecord*`/`KimiErrorPayload`/`CompactionResult` via named repetition in index.ts) — no TS conflicts.

## Open verification items (unverified, evidence missing)

- Exact v2 service-name counterparts: `IModelCatalogService`, `IEnvironmentService`, the fs-family error classes one by one, the `IPromptService` family, `IToolService`, `AgentStateSnapshot`, the consumer-side replacement for the three v1 replay functions (`packages/transcript`), the three `FsPathSafety` symbols, the task errors such as `TaskNotFoundError`, `TerminalNotFoundError`, `AuthTokenUnauthorizedError`, `ImageCompressionTelemetry`.
- Semantic narrowing not diffed item by item: `McpServerStatusPayload`, `ToolListUpdatedReason`, `SessionCreatedEvent`, `KIMI_ERROR_INFO`→`errorInfo()`, `redact`→`redactCtx`, `flushDiagnosticLogs*`→`drainLogCloses()`, `normalizeWorkDir`, `RunSubagentOptions`→`RunAgentOptions`, `BackgroundConfig`→`AgentTaskConfig`, `McpConfig`→`McpSection`, `ModelAlias*`, `FlagDefinition`→`FlagDefinitionInput`, `CronTaskSnapshot`→`CronTask`, `MoonshotServiceConfig`/`ServicesConfig`, the item-by-item landing spots of `BearerTokenProvider`/`ModelProvider`/`OAuthTokenProviderResolver`/`ResolvedRuntimeProvider`/`SingleModelProvider` in `llm-adapter/`, the item-by-item landing spots of the five `BackgroundTaskInfo` types in `agent/task/`, and the retention check of the `LoopStep*` protocol shapes in `packages/protocol`.
- The 31 protocol events marked "stay in protocol" were not named-checked one by one in `packages/protocol/src/events.ts` (spot check: `UsageStatus` exists at :36).
- `export *` conflict resolution was not exercised with tsc (the dup analysis above is based on same-origin source).
- **Post-baseline drift (unverified)**: the `packages/protocol/src/events.ts` references in this document were verified at the declared baseline `ccf3d5d6`; in the current workspace checkout (main after #3542) the `packages/protocol` package no longer exists at that location. The table entries remain baseline facts; the package's post-baseline relocation is pending verification.
