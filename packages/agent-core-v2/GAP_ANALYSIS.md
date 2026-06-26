# agent-core-v2 功能差距清单（对照 agent-core v1）

> 目标：基于 v2 的 Domain×Scope 架构，盘点「要把 `agent-core`(v1) 的完整功能在 v2 上实现出来，还差哪些」。
>
> 生成方式：逐 Domain 对比 v1 对照源（`packages/agent-core/src/**`）与 v2 现状（`packages/agent-core-v2/src/**`），只读探索。
> 设计依据：`plan/PLAN.md`、`plan/overview.md`、`plan/ROADMAP.md`、`plan/skeleton-spec.md`。

---

## 0. 结论摘要

- **v2 当前阶段**：骨架 + 早期实现。v2 约 **6.6k 行**，v1 约 **54k 行**（≈ 12%）。多数 Domain 已完成「接口 + 构造函数 + DI 注册 + 生命周期骨架」，但**业务逻辑大量为 `TODO` 或完全缺失**。
- **已实现（基本对齐 v1，可视为完成）**：`telemetry`、`environment`（且为 v1 超集）。
- **部分实现（有可用内核，但关键能力缺）**：`log`、`kaos`、`event`、`approval`、`question`、`message`（投影很薄）、`session-activity`、`agent-lifecycle`（仅建 scope）、`tooldedup`（含 bug）。
- **骨架 / 几乎全 stub**：`records`、`config`、`kosong`、`tool`、`skill`、`permission`、`context`、`turn`、`injection`、`compaction`、`plan`、`goal`、`swarm`、`usage`、`background`、`cron`、`mcp`、`session-context`、`session`、`hooks`、`gateway`、`terminal`、`fs`、`workspace`、`filestore`、`auth`。
- **v2 完全无归宿（v1 有、v2 既未实现也未在新架构落地）**：`_base/errors`（仅留 unexpectedError）、`plugin`、`profile`、`rpc/services` facade、`coreProcess` 子进程 RPC 桥、server 端 gateway 传输层（event journal / ws broadcast / connection registry）。`_base/utils` 已落地（见 §2.3）。

**判断**：v2 的「骨架」已覆盖 PLAN §2 的绝大多数 Domain（注册表/scope 树/DI 已通）。距离「功能完整」差的是**业务逻辑回填**，其中**阻塞性缺口**集中在 6 处：`loop/turn` 引擎、`records` restore/replay、`config` 内核、`kosong` LLM 桥、`permission` 策略集、`_base/flags`。详见 §2「全局阻塞性缺口」。

---

## 1. 图例与阅读方式

每个 Domain 条目包含：

- **对照源 (v1)**：功能来源文件。
- **v2 状态**：`已实现` / `部分` / `骨架` / `缺失`。
- **已实现要点**：v2 已经做好的（简要）。
- **缺失清单**：v1 有而 v2 未实现/未落地的具体功能点（精确到类/函数/行为，附 v1 源文件）。
- **风险 / 需决策**：跨域依赖、架构差异、无归宿项。

> 「架构拆分」本身（如 `KimiCore` facade → `gateway`、`Session` god class → 5 个 Domain）**不算缺口**；只有「v1 有、v2 既未实现也未在新架构找到归宿」的功能才标为「无归宿/需决策」。

---

## 2. 全局阻塞性缺口（跨 Domain / 无归宿）

这些是 v2 当前**完全没有**、但 v1 与仓库硬规则（根 `AGENTS.md`）依赖的基础设施，应优先落地。

### 2.1 `flag`（实验特性门控）— 已实现（Core scope Service + FlagRegistry）

- **对照源**：`packages/agent-core/src/flags/{registry,resolver,types,index}.ts`
- **v2 状态**：已实现。`packages/agent-core-v2/src/flag/`（L3 注册中心）：
  - `registry.ts`：`FLAG_DEFINITIONS` + `FlagId` + `FlagRegistry`（对外暴露的定义目录）+ `ExperimentalConfigSchema`（zod，对应 v1 `[experimental]` 表）。
  - `flag.ts`：`IFlagService` 契约 + resolver 类型。
  - `flagService.ts`：`FlagService`（Core scope），四级优先级（master-env > per-feature env > config override > default）+ `enabled/snapshot/enabledIds/explain/explainAll/setConfigOverrides`。
- **落地差异**：
  - v1 是 `globalThis` `FlagResolver` 单例；v2 改为 Core scope DI Service，无隐式全局态。
  - 因要向下注册 `config` 的 `[experimental]` section 并从 `IConfigService` 读取/订阅覆盖，不能放在 `_base`（L0 禁 import L2），故归为 L3 注册中心。
  - config 覆盖改为订阅 `IConfigService.onDidChange('experimental')` 自动刷新（v1 由 `core-impl` 推 `setConfigOverrides`）；`setConfigOverrides` 保留作测试 / 无 config 主机的逃生口。
- [x] 引入FlagService（Core scope `IFlagService` + `FlagRegistry`，向下注册 `[experimental]` config section）

### 2.2 `_base/errors`（统一错误码 / 序列化）— 骨架

- **对照源**：`packages/agent-core/src/errors/{classes,codes,serialize,index}.ts`
- **v2 状态**：骨架（仅 `_base/errors/unexpectedError.ts` + `_base/di/errors.ts`）。
- **已实现**：`onUnexpectedError/setUnexpectedErrorHandler/safelyCallListener`。
- **缺失清单**：
  - `KimiError` 类 + `KimiErrorOptions`（`classes.ts`）
  - `ErrorCodes` 注册表 + `KIMI_ERROR_INFO`（retryable/public/action 元数据，约 70 个码）（`codes.ts`）
  - 序列化层 `toKimiErrorPayload/fromKimiErrorPayload/makeErrorPayload/isKimiError`，含 kosong 错误映射（429→rate_limit、401→auth_error、connection/empty）（`serialize.ts`）
- **风险**：v2 全用裸 `Error('TODO: ...')` 抛错，无协议错误码，跨进程/SDK 无法按 code 分支。

- [ ] 先学习 vscode 的错误码，然后看看是统一还是分散定义（可能分散定义，统一注册到一处，按 Domain 走比较好）

### 2.3 `_base/utils`（通用工具）— 已实现

- **对照源**：`packages/agent-core/src/utils/*.ts`
- **v2 状态**：已实现（`src/_base/utils/*`，12 个文件逐字节从 v1 迁入 + barrel `index.ts`；新增依赖 `pathe` / `nunjucks` / `undici` / `socks` + dev `@types/nunjucks`）。
- **已落地清单**：
  - `abort.ts`：`UserCancellationError`、`abortable`、`linkAbortSignal`、`createDeadlineAbortSignal`
  - `completion-budget.ts`：`resolveCompletionBudget/computeCompletionBudgetCap/applyCompletionBudget`
  - `fs.ts`：`atomicWrite`、`writeFileAtomicDurable`、`syncDir/Sync`
  - `per-id-json-store.ts`（路径穿越防护 + 原子写）
  - `render-prompt.ts`（nunjucks，`throwOnUndefined`）
  - `tokens.ts`：`estimateTokensForMessage/Tools`（WeakMap 缓存）
  - `proxy.ts`：HTTP/SOCKS dispatcher、`makeNoProxyMatcher`、`installGlobalProxyDispatcher`、`proxyEnvForChild/reconcileChildNoProxy`
  - `promise.ts`（timeoutOutcome）、`hero-slug.ts`、`workdir-slug.ts`、`types.ts`（Promisify/Promisable）、`xml-escape.ts`
- **风险（已解除）**：`records` 已改为复用 `#/_base/utils/workdir-slug` 的 `slugifyWorkDirName`，slug 行为与 v1 对齐；`proxy` 随 utils 一并落地，子进程代理环境可注入。

- [x] 统一先 mv 过来


### 2.4 `plugin`（插件系统）— 无归宿

- **对照源**：`packages/agent-core/src/plugin/**`（manager/manifest/source/store/archive/github-resolver/types/index）+ `src/plugin.ts`
- **v2 状态**：缺失（全包 grep 无 plugin）。
- **缺失清单**：
  - `PluginManager`：install（local-path / github / zip-url）/ setEnabled / setMcpServerEnabled / remove / reload（`manager.ts`）
  - `parseManifest`（`kimi.plugin.json` / `.kimi-plugin/plugin.json`、skills 路径校验、sessionStart、mcpServers、interface、diagnostics）（`manifest.ts`）
  - `resolveInstallSource` / `resolveGithubSource` / `downloadZip` / `extractZip`、`store.ts` 的 `installed.json` 持久化
  - 插件能力导出：`pluginSkillRoots` / `enabledSessionStarts` / `enabledMcpServers`、stdio `node` 原生二进制 fallback
  - `CoreAPI` plugin 一组方法
- **需决策**：PLAN §2 未给 plugin 指定 Domain 归宿。需决定是新建 `plugin` Domain（Session/Core scope），还是并入 `skill`/`mcp`。plugin 是 skill 与 mcp 的「来源」之一，建议独立 Domain。

- [ ] 实现 PluginServices 并从 agent-core 迁移业务逻辑，在实现前先看看底层Domain 是否都 ok 了（下一章）


### 2.5 `profile`（系统提示 / Profile 加载）— 无归宿

- **对照源**：`packages/agent-core/src/profile/**`（resolve/context/load/default/types/index）
- **v2 状态**：缺失（全包 grep 无 profile）。
- **缺失清单**：
  - YAML profile 加载（`extends` 继承、环检测、subagent 链接、promptVars 合并）（`resolve.ts`）
  - `systemPromptTemplate` 渲染（`renderPrompt` + `KIMI_OS/SHELL/WORK_DIR/AGENTS_MD/SKILLS` 等变量）（`resolve.ts`）
  - `prepareSystemPromptContext`：cwd 目录列表、AGENTS.md 多级（brand/.agents/项目 root→leaf）收集、32KB 超量 warning、additionalDirs 列表（`context.ts`）
  - 内置 profile（agent / coder / explore / plan.yaml + system.md / init.md）
- **需决策**：PLAN §2 未明确 profile 归宿。它直接决定 agent 启动时的 system prompt 构造，建议归入 `agent-lifecycle`（启动装配）或新建 `profile` Domain。


- [ ] 实现 Profile Domain

### 2.6 `rpc/services` facade + `coreProcess`（跨进程边界）— 无归宿

- **对照源**：`packages/agent-core/src/rpc/**`（core-impl=KimiCore facade、core-api、sdk-api、client、events、resumed、types、index）+ `src/services/coreProcess/**` + `src/services/index.ts`
- **v2 状态**：缺失。`gateway` 域只接住 `prompt/steer/cancel`。
- **缺失清单**：
  - `KimiCore`（`core-impl.ts`）约 60 个 `CoreAPI` 方法（`core-api.ts`）：AgentAPI / SessionAPI / Plugin / Config / Export 等。v2 仅接住 prompt/steer/cancel，其余需确认由各 Domain 承接。
  - `coreProcess` 进程内 RPC 桥（`createRPC`、`BridgeClientAPI`、`SDKAPI`），用于 daemon 跨进程部署。
- **需决策**：PLAN §1 明确「保留一层薄 RPC（跨进程形态仍在），但 RPC 只负责把调用路由到 scope」。需在 `gateway` 域补这层薄 RPC 路由，并逐项核对 `CoreAPI` 方法是否都有 Domain 承接。

- [ ] 实现 CoreRPC Service，注入其他相关 Service，作为最上层，为 TUI 提供接口服务


### 2.7 server 端 gateway 传输层（断线重放 / 连接管理）— 无归宿

- **对照源**：`packages/server/src/services/gateway/**`（SessionEventJournal、WSBroadcastService、ConnectionRegistry、SessionClientsService、InFlightTurnTracker、ServerShutdownService）
- **v2 状态**：缺失。`gateway.WSGateway.broadcast` 为空、`WSBroadcastService` 不路由。
- **缺失清单**：
  - `SessionEventJournal`（持久化 seq/epoch、断线 replay）
  - `WSBroadcastService`（per-session 缓冲 + fan-out）
  - `ConnectionRegistry` / `SessionClientsService` / `InFlightTurnTracker` / `ServerShutdownService`
- **需决策**：这些在 v1 属于 server 包，不属于 agent-core。但 v2 若要支撑 server-e2e，需明确这层是留在 server 还是下沉到 v2 `gateway`。M10/M11 切换前必须定稿。


- [ ] 在最后接入到 v2，这部分暂时留在 server 层

---

## 3. 按 Domain 功能差距清单

> 顺序按 PLAN §3 分层：L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7 → 横向能力。

---

### L0 — `_base`（di / event / lifecycle / errors / utils / flags）

#### `_base/di` — 已实现
- **对照源**：`packages/agent-core/src/di/**`
- **v2 状态**：已实现（含 Scope 层）。
- **已实现要点**：`createDecorator`、`IInstantiationService`、`ServiceCollection`、`SyncDescriptor`、`createChild`、`Disposable`、`LifecycleScope`、`registerScopedService`、`Scope` 树、`IScopeHandle`、scoped `TestInstantiationService`。
- **缺失清单**：无（M0 已完成）。
- **待办**：import-boundary lint 规则（M0.6）需 CI 强制。

#### `_base/event` — 已实现
- **对照源**：`packages/agent-core/src/base/common/event.ts`
- **v2 状态**：已实现（`Emitter` / `Event` / `Disposable` 风格）。
- **缺失清单**：无实质缺口。

#### `_base/errors` — 骨架（见 §2.2）
#### `_base/utils` — 已实现（见 §2.3）
#### `_base/flags` — 缺失（见 §2.1）

---

### L1 — 抽象桥

#### `log` — 部分
- **对照源**：`packages/agent-core/src/logging/{logger,sinks,formatter,resolve-config,types,index}.ts`
- **v2 状态**：部分（Core scope，console + memory sink）。
- **已实现要点**：`ILogService/ILogger/ILogSink`、`ConsoleLogSink`、`MemoryLogSink`、`levelEnabled`、`child(ctx)`、payload 提取。
- **缺失清单**：
  - `RotatingFileSink`（按 maxBytes/files 滚动、AsyncSerialQueue、PENDING_MAX 丢弃通知、fsync + syncDir、flushSync、stderr 节流）（`sinks.ts`）
  - 每会话文件 sink：`RootLoggerImpl.attachSession/detachSession`（refCount）、global/session 双 sink、`flush/flushSession/flushSync`、`sessionId/sessionLogId` 路由（`logger.ts`）
  - `formatter`：`redactCtx`（REDACTED_KEYS + 原始密钥正则）、字节级 clip、ANSI、stack 缩进、`omitContextKeys`（`formatter.ts`）
  - `resolve-config`（`KIMI_LOG_LEVEL` 等 env）（`resolve-config.ts`）
  - 去掉 `globalThis[ROOT_SYMBOL]` 隐式单例（v2 已去，符合架构）
- **风险**：v2 仅 console/memory sink，无落盘与脱敏，生产不可用。

- [ ] 脱离

#### `telemetry` — 已实现
- **对照源**：`packages/agent-core/src/telemetry.ts` + `packages/telemetry`
- **v2 状态**：已实现（且为 v1 超集）。
- **已实现要点**：`TelemetryClient`、`noopTelemetryClient`、`ITelemetryService`（DI + `setDelegate` + `withContext({sessionId,agentId,turnId})`）。
- **缺失清单**：无（埋点调用点散落在其它 Domain，随各域回填）。


#### `environment` — 已实现
- **对照源**：`packages/agent-core/src/services/environment/**` + `packages/kaos/src/environment.ts`
- **v2 状态**：已实现（且为 v1 超集）。
- **已实现要点**：`IEnvironmentService`（homeDir/configPath + `detect()` 委托 kaos）、`IEnvironmentOptions` seed token。
- **缺失清单**：无。

#### `kaos` — 部分
- **对照源**：`packages/agent-core/src/session/index.ts`（toolKaos/persistenceKaos/systemContextKaos/additionalDirs 段）+ agent.kaos + `packages/kaos/**`
- **v2 状态**：部分。
- **已实现要点**：`IKaosFactory`（local 经 `LocalKaos.create()` + `withCwd`）、`ISessionKaosService`（tool/persistence/systemContext/additionalDirs + set/add/remove）、`IAgentKaos.chdir`。
- **缺失清单**：
  - **SSH kaos 创建**（`KaosFactory.create` 抛 `TODO: ... ssh`）；kaos 包已有完整 `SSHKaos`（`packages/kaos/src/ssh.ts`）
  - `setToolKaos` 向已就绪 agent 传播（v1 重钉每个 `agent.kaos` + `refreshAgentBuiltinTools`）（`session/index.ts:223-229`）
  - additionalDirs 持久化到 workspace-local（v1 `addAdditionalDir` 写 `.kimi-code/local.toml`）（`session/index.ts:242-267`）；v2 仅内存
  - agent chdir 后重建内置工具（v1 `ConfigState.update` 中 cwd 变更触发 `initializeBuiltinTools`）
- **风险**：SSH 未接线即远端执行不可用；kaos 工厂自建（v1 由外部创建注入）。


#### `kosong` — 骨架
- **对照源**：`packages/agent-core/src/services/modelCatalog/**` + `src/session/provider-manager.ts` + `src/agent/turn/kosong-llm.ts` + `src/agent/index.ts`（generate/llm 段）
- **v2 状态**：骨架（`generate` 抛 TODO）。
- **已实现要点**：`IModelCatalogService.listProviders/listModels/refresh`（读 config `kosong` 节）、`IProviderManager.resolve`（默认 provider/model）。
- **缺失清单**：
  - 完整 `ProviderManager`（`provider-manager.ts`，371 行）：6 类 provider 的 `toKosongProviderConfig`（anthropic/openai/kimi/google-genai/openai_responses/vertexai，含 baseUrl/env 回退、defaultHeaders、`prompt_cache_key`、adaptiveThinking、reasoningKey、maxOutputSize）、`resolveModelCapabilities`（declared+detected）、alwaysThinking、`resolveAuth`（OAuth token provider + 401 刷新 + `AUTH_LOGIN_REQUIRED`）、`SingleModelProvider`
  - `ModelCatalogService`（`modelCatalogService.ts`，360 行）：managed Kimi OAuth 刷新（`refreshOAuthProviderModels`/`fetchManagedKimiCodeModels`/`applyManagedKimiCodeConfig`、alias preserve/restore、default clamp）、`getProvider/setDefaultModel`、按 provider 类型的 credential 状态、`toProtocolModel/Provider`
  - `KosongLLM`（`kosong-llm.ts`）：流式桥（`onTextDelta/onThinkDelta/onToolCallDelta` + tool_call_part 索引）、排空后 per-block 重放、completion budget、`streamTiming`、`isRetryableError`、`requestLogFields`
- **风险 / 需决策**：v2 读 `kosong` 配置节，而 v1 schema 的 providers/models/defaultProvider/defaultModel 位于顶层——**配置形态不一致，需决策归宿**。

---

### L2 — 数据基座

#### `records` — 骨架
- **对照源**：`packages/agent-core/src/session/store/**` + `src/agent/records/**`（migration、blobref、persistence、types、index）+ `src/agent/replay/**`
- **v2 状态**：骨架（`SessionStore.read/write`、`AgentRecords.restore` 均为 TODO）。
- **已实现要点**：`encodeWorkDirKey`、`SessionStore.sessionDir`、`SessionMetaStore`（state.json 读写 flush）、`AgentRecords.logRecord/replay`（整文件读写，无流式）。
- **缺失清单**：
  - `SessionStore.read/write` + `create/fork/get/rename/archive/list*` + `summaryFromDir`（`session-store.ts`，520 行）、`session_index.jsonl`（`session-index.ts`）、`assertSafeSessionId/isSafeSessionId`
  - `FileSystemAgentRecordPersistence`（流式读 + 截断末行容忍、批量 drain、fsync+syncDir、rewrite/shouldClear、blobStore offload）+ `InMemoryAgentRecordPersistence`（`persistence.ts`）
  - `BlobStore`（offload/rehydrate、`blobref:` 协议、data-uri 阈值、sha256 去重、50MB LRU、`MISSING_MEDIA_PLACEHOLDER`）（`blobref.ts`）
  - wire migration v1.0→v1.4（`AGENT_WIRE_PROTOCOL_VERSION`、`resolveWireMigrations`、metadata stamping、newer-version warning、rewrite-migrated）（`migration/*`）
  - `AgentRecordEvents` 判别联合（约 30 种）+ `restoreAgentRecord` 分发（`records/index.ts:32-133`）、`replay/build.ts`
- **风险**：restore 全缺，**会话恢复 / resume 完全不可用**。

#### `config` — 骨架
- **对照源**：`packages/agent-core/src/config/{schema,toml,merge,resolve,path,env-model,kimi-env-params,workspace-local,index}.ts` + `src/services/config/**` + `src/agent/config/**`
- **v2 状态**：骨架（内存 Map，无 schema/文件/env）。
- **已实现要点**：`IConfigRegistry`（registerSection/getSection/deepMerge）、`IConfigService`（内存 Map get/set + `onDidChange` Emitter）、`IAgentConfigService`（读 `agent` 节，setModel/setThinking）。
- **缺失清单**：
  - `schema.ts`（zod `KimiConfigSchema`/`KimiConfigPatchSchema`、`validateConfig`、`getDefaultConfig`、`formatConfigValidationError`）
  - `toml.ts`（parse/stringify、snake↔camel、`ensureConfigFile`、strict/safe 双读、`loadRuntimeConfigSafe` 的坏条目丢弃 + fileWarnings/envWarnings/fileError、原子写、`configToTomlData` 保留 raw、permission allow/deny/ask 变换）
  - `merge.ts`（mergeConfigPatch+validate）、`resolve.ts`（parseBooleanEnv/parseFloatEnv）、`path.ts`（KIMI_CODE_HOME）
  - `env-model.ts`（KIMI_MODEL_* 合成 provider/model + strip 防回写）、`kimi-env-params.ts`（temperature/top_p/thinkingKeep）、`workspace-local.ts`（kaos 版 additional_dir）
  - `services/config`（RPC get/set + `event.config.changed`）、`agent/config`（`ConfigState.provider` 叠加 withThinking+sampling+thinkingKeep、`resolveThinkingEffort/Level`、alwaysThinking clamp）
- **风险**：v2 无 schema 校验、无文件持久化、无 env 覆盖、无 workspace-local、无 thinking 解析，本质是内存 Map。

---

### L3 — 注册中心

#### `tool` — 骨架
- **对照源**：`packages/agent-core/src/agent/tool/**` + `src/tools/store.ts` + `src/tools/args-validator.ts` + `src/tools/display/**` + `src/tools/support/**` + `src/tools/policies/**` + `src/tools/providers/**`
- **v2 状态**：骨架（接口 + 按名路由）。
- **已实现要点**：`ToolDefinition{name,factory}` 注册表；`ToolService.execute` 按名路由、user/mcp Map；factory 用 `ServicesAccessor` 懒构建。
- **缺失清单**：
  - **全部内置工具**（Read/Write/Edit/Grep/Glob/Bash/ReadMedia/Goal×4/Plan×2/TodoList/Agent/AgentSwarm/WebSearch/FetchURL/Skill/AskUser/Task×3/Cron×3）（`agent/tool/index.ts:359-426`）
  - 参数校验：`args-validator.ts`（AJV draft-07/2019/2020 方言选择）、`support/input-schema.ts`（zod→input schema + `additionalProperties:false` 闭合）
  - `ToolResultBuilder`（50k char / 2k line 截断、ok/error/brief）（`support/result-builder.ts`）
  - 路径安全：`policies/path-access.ts`（canonicalize/resolvePathAccess）、`sensitive.ts`、`workspace.ts`
  - 规则匹配：`rule-match.ts` + `path-glob-match.ts`（含 Win 变体）
  - MCP：注册/反注册、冲突检测（same/other server）、needs-auth 合成工具、status-change、`qualifyMcpToolName`、glob 门控（`agent/tool/index.ts:136-303`）
  - 用户工具经 RPC `toolCall` 执行；`ToolStore`（records 日志）；`setActiveTools/loopTools`（隐藏 SetGoalBudget/UpdateGoal）；`display/schemas.ts`；`createVideoUploader`；rg-locator/list-directory/git-worktree/file-type/providers
- **风险**：注入了 `IAgentKaos/IPermission/ILLM/IRecords` 但全未用（`_` 前缀）；execute 未调用 permission。

#### `skill` — 骨架
- **对照源**：`packages/agent-core/src/skill/**`（builtin 含 sub-skill、parser、scanner、registry、types、index）+ `src/agent/skill/**`
- **v2 状态**：骨架。
- **已实现要点**：Registry Map（`loadRoots` 仅记 root 不扫描）；`activate`→`turn.prompt("Activate skill: X")`。
- **缺失清单**：
  - `parser.ts`：frontmatter 解析、参数展开（`$ARGUMENTS/$0/$name/${KIMI_SKILL_DIR}`）、mermaid/d2 抽取
  - `scanner.ts`：root 发现（project/user/extra/builtin/plugin + .git 根）、SKILL.md bundle + 平铺 .md + sub-skill 递归、`extendWorkspaceWithSkillRoots`
  - `registry.ts`：byName+byPlugin 双索引、`renderSkillPrompt`（含 plugin instructions）、`listInvocableSkills`、模型清单分组渲染
  - builtin skills（mcp-config / update-config / write-goal / sub-skill parent / review / consolidate）
  - `SkillManager.activate`（类型校验、telemetry、turn origin）+ `prompt.ts` 的 `<kimi-skill-loaded>` 块
- **风险**：v2 `SkillDefinition` 仅 `{name,root}`，丢失 description/content/metadata/source/plugin；activate 不传 args、不校验 type。

#### `permission` — 骨架
- **对照源**：`packages/agent-core/src/agent/permission/**`（manager + policies 目录全部策略 + matches-rule + types + index）
- **v2 状态**：骨架（registry 首个非 undefined 胜出 + yolo/manual/auto）。
- **已实现要点**：Policy 注册表（默认 allow）；`beforeToolCall`（yolo→allow、manual/ask→approval）。
- **缺失清单**：
  - **20 个策略全部未注册**：PreToolCallHook、AgentSwarmExclusiveDeny、AutoModeAskUserQuestionDeny、PlanModeGuardDeny、UserConfigured Deny/Ask/Allow、AutoModeApprove、SessionApprovalHistory、ExitPlanModeReviewAsk、GoalStartReviewAsk、PlanModeToolApprove、SensitiveFileAccessAsk、GitControlPathAccessAsk、YoloModeApprove、SwarmModeAgentSwarmApprove、DefaultToolApprove、GitCwdWriteApprove、FallbackAsk（`policies/index.ts:28-70`）
  - `matches-rule.ts`：DSL `parsePattern`（`Bash(rm *)`/`Read(/etc/**)`）+ `matchPermissionRule`
  - `PermissionRule{decision,scope,pattern,reason}` 模型 + `PermissionData(mode,rules)`；`ApprovalRequest{toolCallId,action,display}` / `ApprovalResponse{scope,feedback,selectedLabel}`
  - mode 硬编码 `'auto'`，不可从 config 切换；无 `resolveApproval/resolveError` 异步合成结果
- **风险**：底层域有归宿（`hooks.runPreToolCall`、`plan.active`、`goal.current` 已存在）但 permission 未对接；敏感文件 / git 控制路径检测依赖 tools/policies（v2 无对应）。

---

### L4 — Agent 行为

#### `context` — 部分（toy 级）
- **对照源**：`packages/agent-core/src/agent/context/**`（projector、notification-xml、types、index）
- **v2 状态**：部分（扁平数组 + toy token）。
- **已实现要点**：history 数组、appendMessage/appendSystemReminder/project（恒等）、applyCompaction（snapshot）、undo（pop/恢复 snapshot）、tokenUsage（chars/4）。
- **缺失清单**：
  - `appendLoopEvent` 状态机（step.begin/end/content.part/tool.call/tool.result）+ openSteps/pendingToolResultIds/deferredMessages（`context/index.ts:257-349`）
  - 开 tool exchange 不变量 + flushDeferred（`:363-373`）
  - `projector.ts`：mergeAdjacentUserMessages、partial 过滤、空 text 剥离、`trimTrailingOpenToolExchange`
  - 真实 token：provider usage + `estimateTokensForMessages` + `tokenCountCoveredMessageCount` 不变量（`:281-303`）
  - 多 origin 类型（skill_activation/injection/compaction_summary/background_task/cron/hook_result…）（`types.ts`）
  - 真实 applyCompaction（替换前缀 + compactedCount + tokensBefore/After）；`undo(count)` 边界（跳 injection、止 compaction_summary）+ REQUEST_INVALID（`:105-194`）
  - `notification-xml.ts`、clear/popMatchedMessage/finishResume/closePendingToolResults
  - 跨域：records / microCompaction / injection / replayBuilder / background.markDeliveredNotification
- **风险**：`IAgentRecords` 注入未用；microCompaction/injection/replay 接线点缺失。

#### `message` — 骨架
- **对照源**：`packages/agent-core/src/services/message/**`（含 transcript）
- **v2 状态**：骨架。
- **已实现要点**：list/get，把 `context.project()` 映射为 `{id=msg-${i},role,content}`。
- **缺失清单**：
  - 稳定 id：`deriveMessageId('msg_<sessionId>_<6位index>')` + `parseMessageId` 反解（`message.ts:114-139`）；v2 用 `msg-${i}`，undo/compaction 后漂移
  - 协议内容映射：content part（think→thinking / image / audio→`[audio:]` / video→`[video:]`）、assistant toolCalls→tool_use、tool role→tool_result（含 is_error）、`metadata.origin`（`:145-267`）
  - 分页（before/after_id、page_size 50-100）+ role filter + created_at 单调
  - **transcript 全量历史**：`readWireTranscript` 从 wire.jsonl 还原（含被 compaction 折叠前缀）+ `reduceWireRecords`（镜像 ContextMemory）+ live tail 合并 + size/mtime LRU 缓存（`transcript.ts`、`messageService.ts:155-216`）
  - **blobref 还原**（`blobref:<mime>;<hash>`→data URI，`[media missing]`）（`transcript.ts:358-405`）
  - SessionNotFoundError / MessageNotFoundError（40401/40403）
- **风险 / 需决策**：v1 message 是 daemon/REST 面向服务，v2 定位为纯 L4 投影属架构调整；但**稳定 id + 内容映射是 web/vis UI 必需**，归宿需决策。

#### `turn` — 骨架（心脏为空）
- **对照源**：`packages/agent-core/src/agent/turn/**`（index、kosong-llm、tool-dedup、canonical-args）+ `src/loop/**`（run-turn、turn-step、tool-call、tool-scheduler、retry、events、llm、tool-access、types、errors、index）+ `src/agent/index.ts`（turn 驱动 / goal 驱动段）
- **v2 状态**：骨架（`ILoopRunner.run` 空、`TurnService.retry`=TODO）。
- **已实现要点**：turn 生命周期事件发射器、prompt/steer/cancel 壳、active 标志。
- **缺失清单**：
  - 整个 `loop/` 步骤引擎：`runTurn` 收敛循环 + maxSteps + `shouldContinueAfterStop`（run-turn.ts）；`executeLoopStep` 的 beforeStep/afterStep hook、step.begin/end 事件、`deriveStepStopReason`、provider diagnostics（turn-step.ts）；`chatWithRetry` 指数退避 + `step.retrying` 事件（retry.ts）
  - `runToolCallBatch`：参数校验、`prepareToolExecution`/`authorizeToolExecution`/`finalizeToolResult` 三 hook、provider-order 事件、abort + 2s grace timeout、`coerceToolResult`/`normalizeToolResult`、`stopBatchAfterThis`（tool-call.ts，726 行）
  - `ToolScheduler` + `ToolAccesses` 冲突感知并发调度（tool-scheduler.ts / tool-access.ts）
  - `KosongLLM` 桥（streaming 回调、completion budget、streamTiming、`buildMessagesWithSystem`）
  - `TurnFlow`：turnId 单调分配 + `observeRestoredTurnId` 重放、`firstRequest` ControlledPromise、`applyUserPromptHook`(UserPromptSubmit)、`runStepLoop` 中 micro/full compaction + `injectGoal` 编排、Stop hook 续轮、goal outcome 续轮、`classifyApiError` 遥测、turn_interrupted 遥测、`mapLoopEvent` 全套事件映射
  - Turn scope 工厂：`createTurnScope(parentAgentScope, turnId)` + `ITurnContext` + `IInjectionQueue`（per-turn scratch）
- **需决策**：loop 是 L4 心脏，v2 目前 `ILoopRunner` 单方法 `run()`，需决定如何拆分到 Turn scope 服务群（PLAN §1/§6.2 已给出方向）。

#### `injection` — 部分（仅 FIFO）
- **对照源**：`packages/agent-core/src/agent/injection/**`（injector、manager、goal、permission-mode、plan-mode、plugin-session-start、todo-list）
- **v2 状态**：部分（仅 FIFO push/flush 队列）。
- **已实现要点**：Agent-scope `IInjectionService` + Turn-scope `IInjectionQueue`。
- **缺失清单**：
  - `DynamicInjector` 抽象与 `injectedAt` 索引生命周期修正（`onContextClear/Compacted/MessageRemoved`）（injector.ts）
  - `InjectionManager` 的 per-step `inject()` + boundary `injectGoal()` 编排（manager.ts）
  - `GoalInjector`（active/blocked/paused 三档 + budget guidance + `<untrusted_objective>`）（goal.ts）
  - `PlanModeInjector`（full/sparse/reentry 变体去重）（plan-mode.ts）
  - `PermissionModeInjector`（auto 进/出提醒）
  - `PluginSessionStartInjector`（skill 渲染）
  - `TodoListReminderInjector`（基于 history 的 turn 计数）
- **需决策**：v2 的 push/flush 模型与 v1「索引 + 生命周期修正」语义不同，需重新设计归宿。

#### `compaction` — 骨架
- **对照源**：`packages/agent-core/src/agent/compaction/**`（full、micro、strategy、render-messages、types、index）
- **v2 状态**：骨架（仅 token 阈值 → push `compaction_summary` injection；`compact()`=TODO）。
- **已实现要点**：`onDidEndStep` 阈值检测。
- **缺失清单**：
  - `FullCompaction`：多轮摘要生成 + completion budget + `MAX_COMPACTION_RETRY_ATTEMPTS` 重试 + overflow 时 `reduceCompactOnOverflow` + truncated/empty 处理 + `handleOverflowError` + `beforeStep/afterStep` 自动触发与 block + `maxCompactionPerTurn` + PreCompact/PostCompact hook + todo 后处理 + telemetry + records/replay（full.ts，422 行）
  - `DefaultCompactionStrategy`：`shouldCompact/Block`、`computeCompactCount`（`canSplitAfter` 安全切分）、`reduceCompactOnOverflow`、`fitCompactCountToWindow`（strategy.ts）
  - `MicroCompaction`：cache age+ratio detect、tool result 截断、experimental flag `micro_compaction`（micro.ts）
  - `render-messages.ts` + `compaction-instruction.md` 模板
- **风险**：v2 仅「push 一条 injection」，远未覆盖摘要 LLM 调用与历史改写。

#### `plan` — 骨架
- **对照源**：`packages/agent-core/src/agent/plan/**`
- **v2 状态**：骨架（仅 boolean + 一条 plan injection）。
- **已实现要点**：active 标志、enter 推 reminder、turn end 复位。
- **缺失清单**：
  - planId 生成（hero-slug + uuid）
  - plan 文件路径解析（homedir/plans vs cwd/plan）+ `ensurePlanDirectory` + `writeEmptyPlanFile`(kaos)
  - `data()` 读取
  - records `plan_mode.enter/cancel/exit` + replayBuilder `plan_updated`
  - `restoreEnter` 重放
  - `emitStatusUpdated`（plan/index.ts）

#### `goal` — 骨架
- **对照源**：`packages/agent-core/src/agent/goal/**` + `src/agent/turn/index.ts`（driveGoal 段）
- **v2 状态**：骨架（仅 `{objective,status}`，continuation drive=TODO）。
- **已实现要点**：create/update/clear 状态字段。
- **缺失清单**：
  - 完整状态机 active/paused/blocked/complete 语义（goal/index.ts，764 行）
  - `createGoal`（长度校验/replace）/ `pauseGoal` / `resumeGoal` / `cancelGoal` / `markBlocked` / `markComplete` / `pauseOnInterrupt`
  - `setBudgetLimits` + `GoalBudgetReport`（token/turn/wallClock + overBudget）
  - wallClock 锚定计时（`liveWallClockMs`）
  - `recordTokenUsage` / `incrementTurn` 会计
  - `normalizeAfterReplay`（active→paused）
  - `restoreCreate/Update/Clear/Forked`
  - records `goal.create/update/clear` + `goal.updated` 事件 + `GoalChange`(lifecycle/completion)
  - telemetry
  - `driveGoal` continuation 循环 + `GOAL_CONTINUATION_PROMPT` + `goalFailurePauseReason`（turn/index.ts:357）
- **风险**：预算强制与 continuation driver 跨 turn/goal 两域，是最大行为缺口之一。

#### `swarm` — 骨架
- **对照源**：`packages/agent-core/src/agent/swarm/**`
- **v2 状态**：骨架（仅 boolean）。
- **已实现要点**：active 标志、enter/exit。
- **缺失清单**：
  - `SwarmModeTrigger` 三态（manual/task/tool）
  - enter/exit 注入 `SWARM_MODE_ENTER/EXIT_REMINDER`(md)
  - exit 时 `popMatchedMessage` 移除 injection
  - `shouldAutoExit`(task/tool) + turn 末 auto exit
  - records `swarm_mode.enter/exit` + `restoreEnter`
  - 子 agent 编排（经 `IAgentLifecycleService`，后续接）

#### `usage` — 部分
- **对照源**：`packages/agent-core/src/agent/usage/**`
- **v2 状态**：部分（仅 input/output 两数累加）。
- **已实现要点**：`record(input,output)` + `totals`。
- **缺失清单**：
  - `byModel` 分组累计 + `totalUsage`
  - `currentTurn` 窗口（`beginTurn/endTurn`）+ turn-scope record
  - `UsageRecordScope`(session/turn)
  - records `usage.record` + `emitStatusUpdated`
  - `data()/status()` → `UsageStatus`(byModel/total/currentTurn)
  - model 维度记录（usage/index.ts）

#### `tooldedup` — 部分（含 bug）
- **对照源**：`packages/agent-core/src/agent/turn/tool-dedup.ts` + `canonical-args.ts`
- **v2 状态**：部分（含 bug）。
- **已实现要点**：same-step Set 检测 + streak 计数。
- **缺失 / 错误清单**：
  - `fingerprint=JSON.stringify` 非 canonical（key 顺序敏感；v1 用 `canonicalTelemetryArgs`）（canonical-args.ts）
  - `finalize(toolCallId)` 误用 toolCallId 作指纹，致 streak 逻辑错误
  - 缺 same-step deferred 结果复用（`ToolCallDeduplicator.checkSameStep/finalizeResult`，重复调用返回占位、finalize await 原调用 deferred 免重复执行）（tool-dedup.ts）
  - 缺跨步 streak 的 r1/r2/r3/stop 升级（3/5/8/12）+ system-reminder + `stopTurn` 强停
  - 缺 `beginStep/endStep` 生命周期与悬挂 deferred 错误收尾
  - 缺 `syntheticCallIds/originalCallIndex/callKeyByCallId`（处理 `updatedArgs` 改写）
  - 缺 telemetry `tool_call_repeat`
- **风险**：v2 `checkSameStep` 返回 boolean，无法表达「复用原结果」语义，接口需重构。

---

### L5 — 异步生命周期

#### `background` — 骨架
- **对照源**：`packages/agent-core/src/agent/background/**`（task、process-task、agent-task、question-task、persist、index）
- **v2 状态**：骨架（仅内存 map + 空 output 字符串）。
- **已实现要点**：`start/stop/list/getOutput` 形状。
- **缺失清单**：
  - 三类具体任务（process / agent / question）完全缺失（`process-task.ts`/`agent-task.ts`/`question-task.ts`）
  - SIGTERM→5s grace→SIGKILL 停止、stream drain、超时、前台/后台 detach（`index.ts:431-507,714-838`）
  - 1MiB ring buffer + `output.log` 持久化 + 字节窗口读取（`persist.ts`、`index.ts:576-625`）
  - 启动 reconcile：磁盘 ghost → `lost` 重分类 + 终端通知恢复（`index.ts:516-560,627-701`）
  - legacy snake_case 记录迁移（`persist.ts:169-238`）
  - `maxRunningTasks` 准入、`Notification` hook 触发（`index.ts:237-251,688-701`）
- **需决策**：持久化归宿未明（v2 `records` 域？）；任务与 `IAgentKaos` / subagent 尚未接线。

#### `cron` — 骨架
- **对照源**：`packages/agent-core/src/tools/cron/**`（scheduler、clock、jitter、cron-expr、persist、session-store、cron-create/list/delete、telemetry-events、time-format、types、cron-fire-xml）+ `src/agent/cron/**`（manager、index）
- **v2 状态**：骨架（最小 `tick`，数字 ms 当间隔）。
- **已实现要点**：`create/list/delete/tick`、`onDidFire`、idle-gate、one-shot 删除、`CronFireCoordinator` steer main。
- **缺失清单**：
  - 5 字段 cron 解析 + dom/dow OR 规则 + 5 年窗口 / 永不触发检测（`cron-expr.ts`）
  - 确定性 jitter（`jitter.ts`）、wall/mono 双时钟 + `KIMI_CRON_CLOCK`（`clock.ts`）
  - coalescedCount 合并、`lastFiredAt` 游标持久化防 resume 重放（`scheduler.ts:249-407`）
  - 7 天 stale 判定 + 自动过期删除（`agent/cron/manager.ts:376-442`）
  - per-id JSON 持久化 + loadFromDisk（`persist.ts`、`session-store.ts`、`manager.ts:198-306`）
  - SIGUSR1 manual-tick、`KIMI_DISABLE_CRON`/`MANUAL_TICK`、`cron_fire` XML 渲染（`cron-fire-xml.ts`）
  - CronCreate/List/Delete 工具（校验、50 上限、8KiB prompt、一次性 350 天回滚保护、`cron_scheduled/deleted` 遥测）
- **需决策**：v2 缺 `tick()` 的 setInterval 驱动；`CronFiredEvent.origin` 未建模 cron/coalescedCount。

#### `mcp` — 骨架
- **对照源**：`packages/agent-core/src/mcp/**`（client-http/sse/stdio/remote、client-shared、connection-manager、config-loader、session-config、tool-naming、output、types、auth-tool、index、oauth/**）+ `src/services/mcp/**`
- **v2 状态**：骨架（connect/disconnect 只改 map 字符串）。
- **已实现要点**：状态事件 `onDidChangeServerStatus`；fan-out 落点 `IToolService.registerMcpTools` 已存在。
- **缺失清单**：
  - 三种 transport 客户端（stdio/http/sse/remote）+ 工具发现 + unexpected-close（`client-*.ts`、`connection-manager.ts`）
  - 配置加载：user/project-root/project-local 三层 `mcp.json` 合并（`config-loader.ts`、`session-config.ts`）
  - 工具名 `mcp__server__tool` 限定 + 64 字符 hash 截断 + 冲突检测（`tool-naming.ts`、`agent/tool/index.ts:136-200`）
  - 输出管线：MCP content→ContentPart、媒体 `<mcp_tool_result>` 包裹、100K 文本 / 10MB 二进制限额（`output.ts`）
  - enabled/disabledTools 过滤、启动超时、needs-auth 状态机（`connection-manager.ts:258-377`）
  - **MCP OAuth 整套**：RFC 9728/8414/7591 发现、localhost callback、token store、DCR、`authenticate` 合成工具（`oauth/*`、`auth-tool.ts`）
  - agent 工具扇入/扇出 + `tool.list.updated` 事件（`agent/tool/index.ts:61-75,206-303`）
- **需决策**：v2 `IOAuthService` 仅是通用 login/status，**MCP OAuth 无归宿**；stdio 远端 executor v1 也是 NOT_IMPLEMENTED（非差距）。

---

### L6 — 协调

#### `agent-lifecycle` — 部分
- **对照源**：`packages/agent-core/src/session/index.ts`（createAgent/instantiateAgent/resumeAgent 段）+ `src/session/subagent-host.ts` + `src/session/subagent-batch.ts`
- **v2 状态**：部分（DI 子 scope 创建已实现，业务语义缺失）。
- **已实现要点**：`create` 建 Agent 子 scope + `IScopeHandle`、`createMain('main')`、handle map get/list/remove。
- **缺失清单**：
  - `instantiateAgent`：装配 Agent（kaos.withCwd、provider、permission、hookEngine、subagentHost、mcp、additionalDirs）（`session/index.ts:661-706`）
  - profile bootstrap + AGENTS.md 超大 warning（`session/index.ts:463-483`）
  - `resumeAgent`：从 metadata 恢复 + 父子链环检测 + lazy replay（`session/index.ts:724-771`）
  - subagent 整套：`spawn/resume/retry`、父子配置继承、`startBtw` 侧问（`subagent-host.ts`）
  - swarm batch 调度：5 并发 ramp、rate-limit 退避/恢复（`subagent-batch.ts`）
- **需决策**：handle 当前仅 `accessor`，不含 Agent 业务对象；parent/cwd 选项已声明但未生效。

#### `session-context` — 部分
- **对照源**：`packages/agent-core/src/session/index.ts`（sessionId/metadata 段）
- **v2 状态**：部分（按设计只承载 seed）。
- **已实现要点**：`ISessionContext{sessionId, meta}` token + `sessionContextSeed`。
- **缺失清单**：
  - v1 `Session.metadata`（title/isCustomTitle/createdAt/updatedAt/agents/custom）+ `writeMetadata/readMetadata/flushMetadata` 串行写盘（`session/index.ts:164-172,555-579`）
  - `state.json` 路径、homedir、kaos 切换（`setToolKaos`）、additionalDirs 管理（`session/index.ts:242-285`）
- **需决策**：metadata 所有权拆分给 `records` / `session-context` 何处，需决策。

#### `session-activity` — 部分
- **对照源**：`packages/agent-core/src/session/index.ts`（_computeStatus 段）+ `src/services/session/sessionService.ts`
- **v2 状态**：部分实现。
- **已实现要点**：`isIdle()` 遍历 handle 读 `ITurnService.hasActiveTurn`。
- **缺失清单**：
  - v1 `_computeStatus` 五态优先级：awaiting_approval → awaiting_question → running → aborted → idle（`sessionService.ts:139-156`）
  - 状态变化事件 `event.session.status_changed` + 总线监听（active/aborted turns）（`sessionService.ts:175-232`）
  - approval/question 依赖接入
- **需决策**：v2 `ISessionService.status()` 仅 idle/running，缺 awaiting_approval/question/aborted。

#### `session` — 骨架
- **对照源**：`packages/agent-core/src/services/session/**` + `src/session/rpc.ts` + `src/session/index.ts`（会话级逻辑）+ `src/session/export/**`（manifest、session-export、wire-scan、zip、index）+ `src/session/git-context.ts` + `src/session/prompt-metadata.ts`
- **v2 状态**：骨架（facade，4 个核心方法 TODO 抛错）。
- **已实现要点**：`status()`、`agents()` 委托 lifecycle。
- **缺失清单**：
  - `fork`/`createChild`/`listChildren`（`sessionService.ts:356-433`）
  - `compact`（`beginCompaction`）、`undo`（`canUndoHistory` + 分页）、`archive`（`sessionService.ts:495-556`）
  - CRUD：create/list/get/update/getStatus/getSessionWarnings + 分页/排序/过滤（`sessionService.ts:234-354,445-493`）
  - RPC 层 `SessionAPIImpl`：prompt/steer/cancel/model/thinking/permission/plan/swarm/goal/background/skill/mcp 等 30+ 方法（`session/rpc.ts`）
  - prompt 元数据自动标题 + 敏感信息脱敏（`prompt-metadata.ts`）
  - explore subagent `<git-context>` 注入（`git-context.ts`）
  - session export zip：manifest + wire 扫描 + global log（`session/export/*`）
  - `generateAgentsMd`、AGENTS.md warning、`SessionStart/End` hook 触发
- **需决策**：v2 `fork` 返回 `IScopeHandle`，但 v1 fork 语义是会话级 records 复制，归属 session vs records 未定。

#### `hooks` — 骨架
- **对照源**：`packages/agent-core/src/session/hooks/**`（engine、runner、types、user-prompt、index）
- **v2 状态**：骨架（全部 passthrough `continue:true`）。
- **已实现要点**：4 个 run 方法签名（UserPromptSubmit/PreToolCall/SessionStart/SessionEnd）。
- **缺失清单**：
  - 16 种事件类型 + matcher 正则匹配 + command 去重（`types.ts`、`engine.ts`）
  - 子进程 spawn 执行：stdin JSON、exit 2=block、超时、SIGTERM/SIGKILL、abort（`runner.ts`）
  - 结构化输出解析（`hookSpecificOutput.permissionDecision=deny`）（`runner.ts:151-179`）
  - 其余事件：PreToolUse / PostToolUse(Failure) / PermissionRequest / PermissionResult / Stop / Interrupt / SubagentStart / Stop / PreCompact / PostCompact / Notification
  - UserPromptSubmit 结果渲染 `<hook_result>` 注入（`user-prompt.ts`）
  - block 决策聚合、`onTriggered/onResolved` 回调、camelToSnake input 转换
- **风险**：v2 `HookResult` 仅 `continue/message`，缺 action/stdout/stderr/exitCode/timedOut/structuredOutput。

---

### L7 — 边界

#### `event` — 已实现（极简）
- **对照源**：`packages/agent-core/src/services/event/**`
- **v2 状态**：已实现（极简）。
- **已实现要点**：`Set<Listener>` 同步 fan-out、subscribe 返回 IDisposable。
- **缺失清单**：
  - `onDidPublish: Event<ProtocolEvent>` VSCode 风格访问器（v2 改为命令式 subscribe），导致 server `WSBroadcastService` 无法订阅（v1 `event.ts:48-56`、`eventService.ts:30-31`）
  - dispose 后 publish no-op 语义（v1 `eventService.ts:34-35`）

#### `approval` — 部分
- **对照源**：`packages/agent-core/src/services/approval/**` + `packages/server/src/services/approval/**`
- **v2 状态**：部分（裸内存 broker 可用）。
- **已实现要点**：`request/decide/listPending`、`Map<id,Pending>`。
- **缺失清单**：
  - ULID id + createdAt/expiresAt；60s 超时 + `ApprovalExpiredError` + `event.approval.expired`（server `approvalService.ts:93-95,206-224`）
  - 事件发布 `event.approval.requested/resolved`；`byToolCallId` 索引、`recentlyResolved` 去重（cap 1024）
  - 协议适配 `toBrokerRequest/toAgentCoreResponse`（snake_case + 12-arm display 透传）（`approval.ts:118-150`）
  - DisposableMap 生命周期、dispose 拒 promise；sessionId/agentId 路由、`isPending`
- **风险**：`ApprovalRequest` 仅 `{id,toolName}`，缺 toolCallId/action/display/sessionId/agentId；id 调用方自填易碰撞。

#### `question` — 部分
- **对照源**：`packages/agent-core/src/services/question/**` + `packages/server/src/services/question/**`
- **v2 状态**：部分（裸内存 broker）。
- **已实现要点**：`request/answer/listPending`。
- **缺失清单**：
  - ULID + 超时 + `QuestionExpiredError` + `event.question.requested/answered/dismissed/expired`
  - `dismiss()` 语义（→null）（`question.ts:82-84,229-230`）（v2 无 dismiss）
  - 协议适配：`q_<idx>`/`opt_<p>_<o>` 合成 id、5-kind answer 扁平化（single/multi/other/multi_with_other/skipped）、`allow_other` 恒 true、`method:'click'` 丢弃（`question.ts:116-222`）
- **风险**：`QuestionRequest` 仅 `{id,prompt}`，无 QuestionItem/options/multiSelect/other/turnId，无法表达 AskUserQuestion 真实结构。

#### `gateway` — 骨架
- **对照源**：`packages/agent-core/src/rpc/**`（core-impl=KimiCore facade、core-api、sdk-api、client、events、resumed、types、index）+ `packages/server/src/services/gateway/**` + `src/services/coreProcess/**`
- **v2 状态**：骨架。
- **已实现要点**：`ScopeRegistry`（Session 子 scope 创建/get/close）、`RestGateway` 路由 prompt/steer/cancel→`ITurnService`。
- **缺失清单**：
  - **WS 全 TODO**：`WSGateway.broadcast` 空实现、`WSBroadcastService` 不路由（`gatewayService.ts:110,120`）
  - **整个 server 传输层无归宿**（见 §2.7）：`SessionEventJournal`（seq/epoch/replay）、`WSBroadcastService`、`ConnectionRegistry`、`SessionClientsService`、`InFlightTurnTracker`、`ServerShutdownService`
  - `KimiCore` facade 的约 60 个 `CoreAPI` 方法（`core-api.ts:340-419`）：v2 只接住 prompt/steer/cancel；其余 AgentAPI/SessionAPI/Plugin/Config/Export 需确认由各 Domain 承接
  - `coreProcess` 子进程/进程内 RPC 桥（`coreProcess.ts`、`client.ts createRPC` 双向 RPC）v2 无等价物（见 §2.6）

---

### 横向能力（cross-cutting）

#### `terminal` — 骨架
- **对照源**：`packages/agent-core/src/services/terminal/**`
- **v2 状态**：骨架。
- **已实现要点**：通过 session kaos `exec` spawn、按 pid 记录、write/kill。
- **缺失清单**：
  - **伪终端**：v1 用 `node-pty` 的 `NodePtyTerminalBackend`（`terminalService.ts:237-256`），v2 用 `kaos.exec` 无 PTY、无 cols/rows
  - list/get/attach/detach/`detachAllForSink`、frame 环形缓冲（`maxBufferedFrames=2000`）+ `sinceSeq` replay、resize、`terminal_output`/`terminal_exit` 协议帧、`TerminalNotFoundError`、path safety cwd 解析（`terminal.ts:49-74`）

#### `fs` — 骨架
- **对照源**：`packages/agent-core/src/services/fs/**`（fs、fsGit、fsSearch、fsWatcher、fsPathSafety、*Service）
- **v2 状态**：骨架（薄 kaos 封装）。
- **已实现要点**：read/write/stat/mkdir 透传 kaos；grep 用 `grep -r`、glob 用 `find`、git status/diff/log 用 `git` CLI。
- **缺失清单**：
  - 协议化 list/listMany/stat/statMany（深度/limit/gitignore/exclude_globs/sort/binary/mime/language_id/etag/line_count/children_by_path/truncated）（`fsService.ts:60-329`）
  - `resolveSafePath` 路径逃逸防护（empty/absolute/dotdot/symlink_outside）（`fsPathSafety.ts:38-74`）
  - read 的 offset/length、二进制探测、base64/auto 编码、`resolveDownload`/`resolvePath`（`fsService.ts:163-407`）
  - FsSearch：`search` 模糊打分、rg `--json` 解析 + context_lines + 超时 + Node 兜底（`fsSearchService.ts:54-424`）
  - FsGit：porcelain/numstat 解析、ahead/behind、`gh pr view` PR 缓存、untracked `/dev/null` diff（`fsGitService.ts`、`fsGit.ts:39-159`）
  - FsWatcher：chokidar 引用计数、debounce 合并窗口、`event.fs.changed` 帧、按 connection 投递、`FsWatchLimitError`（`fsWatcherService.ts:94-376`）；v2 仅 `Set<string>`

#### `workspace` — 骨架
- **对照源**：`packages/agent-core/src/services/workspace/**`（workspaceFs、workspaceRegistry、*Service、index）
- **v2 状态**：骨架（内存）。
- **已实现要点**：`register/get/list` 内存 Map、`resolve(workspaceId, rel)`。
- **缺失清单**：
  - 持久化 `workspaces.json`（version/opQueue 串行写 / 原子 rename）（`workspaceRegistryService.ts:211-292`）
  - `createOrTouch/update/delete/resolveRoot` + `encodeWorkDirKey` id、git 检测（detectGit 含 worktree）、session_count、last_opened_at 排序、`event.workspace.created/updated/deleted`（`:60-186`）
  - WorkspaceFs：`browse`/`home`（recent_roots、dir-only、git 标记）、`WorkspaceFsNotAbsolute/NotFound/Permission`（`workspaceFsService.ts`）

#### `filestore` — 骨架
- **对照源**：`packages/agent-core/src/services/fileStore/**`
- **v2 状态**：骨架（内存 Map）。
- **已实现要点**：put/get/delete `Uint8Array`。
- **缺失清单**：
  - 持久化到 `<home>/files/<fileId>` 磁盘 blob + `index.json` 元数据索引（`fileStoreService.ts:46-204`）
  - 流式 `save(source, filename, options)` + `DEFAULT_MAX_UPLOAD_BYTES=50MB` `FileTooLargeError`（`:55-104`）
  - `FileMeta`（id/media_type/size/expires_at）、`FileNotFoundError`、blob 丢失自愈（`:106-126`）

#### `auth` — 骨架
- **对照源**：`packages/agent-core/src/services/oauth/**` + `src/services/auth/**`（managedAuth）+ `src/services/authSummary/**`
- **v2 状态**：骨架（内存 loggedIn Set）。
- **已实现要点**：login/logout/status/summarize 内存态。
- **缺失清单**：
  - **device-code OAuth 编排**：startLogin/getFlow/cancelLogin/logout、FlowState/AbortController、supersede、5min GC、15min TTL、`DeviceCodeTimeoutError→expired`/`OAuthError→denied/cancelled` 映射（`oauthService.ts:77-283`）
  - `managedAuth` facade：`KimiOAuthToolkit` 配置 provisioning、token 缓存、`getCachedAccessToken`、`resolveOAuthTokenProvider`（`managedAuth.ts:48-174`）
  - AuthSummary 真 readiness：`get()` 读 `config.toml`+cached token、`ensureReady()` 四个哨兵错误 `AuthProvisioningRequired/TokenMissing/TokenUnauthorized/ModelNotResolved`（40110-40113）（`authSummaryService.ts:36-103`、`authSummary.ts:55-111`）

---

## 4. 落地优先级建议（映射 ROADMAP）

> 以下为「功能完整」视角的优先级，**与 `plan/ROADMAP.md` 的 M0–M11 原子步骤一致**，可直接按里程碑推进。

### P0 — 阻塞性基础设施（必须先于业务回填）
1. ~~`_base/flags`~~ → `flag` domain（实验门控，根 AGENTS.md 硬规则）— **已完成**（Core scope `IFlagService` + `FlagRegistry` + `[experimental]` config section）
2. `_base/errors`（KimiError / ErrorCodes / serialize）— M1 前
3. `_base/utils`（abort / completion-budget / fs / proxy / tokens / render-prompt）— ✅ 已完成（见 §2.3）
4. `log` 落盘 + 脱敏（RotatingFileSink / 每会话 sink / formatter）— M1.1
5. `records` 全链路（restore / migration v1.1–v1.4 / BlobStore / FileSystemPersistence / session store）— M2.1–M2.3
6. `config` 内核（zod schema / TOML 读写 / env-model / workspace-local / thinking 解析 / safe-load）— M2.4–M2.6
7. `kosong` LLM 桥（6 类 provider ProviderManager + OAuth + 能力探测 + managed Kimi 刷新 + KosongLLM 流式桥）— M1.6–M1.7

### P1 — L3/L4 核心引擎（turn 跑通的最小闭环）
8. `loop/` 步骤引擎 + `tool-call` 生命周期 + `ToolScheduler` — M5.2
9. `turn` Turn scope 工厂 + `ITurnService` 核心 + 生命周期事件 — M5.3–M5.5
10. `permission` 20 策略 + matches-rule DSL + mode 可配 — M3.2–M3.3、M9.7
11. `tool` 内置工具 + args 校验 + 路径/敏感守卫 + ResultBuilder + MCP 注册 — M3.4–M3.5、M9
12. `context` loop-event 状态机 + projector + 真实 token + 真实 compaction/undo — M4.1
13. `message` 稳定 id + 内容映射 + transcript 还原 — M4.2
14. `injection` DynamicInjector 体系（Goal/Plan/Permission/Plugin/Todo）— M6.1
15. `compaction` Full + Strategy + Micro — M6.3

### P2 — 行为 Domain（订阅式装配）
16. `plan` / `goal`（状态机 + 预算 + driveGoal continuation）— M6.4–M6.5
17. `swarm` / `usage` / `tooldedup`（修 bug + deferred 复用 + streak 升级）— M6.2、M6.6–M6.7
18. `skill`（parser / scanner / 激活 / builtin skills）— M3.6、M9.6

### P3 — 协调 + 异步
19. `agent-lifecycle`（instantiateAgent / resumeAgent / 父子继承 / subagent host+batch）— M7.4–M7.5
20. `session-context` / `session-activity` / `session` facade（fork/compact/undo/archive + 30+ RPC）— M7.1–M7.2、M7.6
21. `hooks`（16 事件 + matcher + 子进程执行 + 结构化输出 + UserPromptSubmit 注入）— M7.3
22. `background`（process/agent/question 任务 + 生命周期 + 持久化 reconcile）— M8.1
23. `cron`（5 字段解析 + jitter + 双时钟 + coalesce + stale + 工具）— M8.3–M8.4
24. `mcp`（三种 transport + 配置加载 + 命名/冲突 + 输出管线 + OAuth）— M8.2

### P4 — 边界 + 横向 + 切换
25. `event`（onDidPublish 访问器）— M10.1
26. `approval` / `question`（ULID + 超时 + 事件 + 协议适配 + dismiss + RPC 桥）— M3.1、M10.5
27. `gateway`（WS fan-out + event journal + connection registry + 薄 RPC 路由）— M10.2–M10.4、§2.6/§2.7
28. `terminal`（PTY）/ `fs`（协议 + 安全 + rg + git + watcher）/ `workspace` / `filestore`（持久化）/ `auth`（device-code OAuth + managedAuth + AuthSummary）— 横向能力（ROADMAP 未单列，需补排期）
29. `plugin` / `profile`（无归宿，需先定 Domain 归属再落地）— §2.4/§2.5
30. server/SDK 切到 v2 + server-e2e + 删 v1 + changeset — M11

---

## 5. 附：v1 → v2 子系统处置速查（摘自 PLAN §2）

| v1 子系统 | 处置 | v2 归宿 |
|---|---|---|
| `di/`、`base/common/event.ts`、`di/lifecycle.ts` | 必拿 | `_base` |
| `rpc/core-impl.ts`（KimiCore） | 扔 | 替换为 `IScopeRegistry` + 薄 gateway |
| `session/index.ts`（Session god） | 扔形重塑 | `session`/`agent-lifecycle`/`session-context`/`session-activity`/`hooks` |
| `session/store/` | 拿 | `records.ISessionStore` |
| `session/provider-manager.ts` | 拿 | `kosong.IProviderManager` |
| `session/hooks.ts` | 拿 | `hooks.IHookEngine` |
| `session/mcp/` | 拿 | `mcp.IMcpService` |
| `session/subagent-host.ts` | 拿形重塑 | 并入 `agent-lifecycle` |
| `session/rpc.ts`（SessionAPIImpl） | 扔形重塑 | 自动标题等并入 `session` facade；RPC 适配由 `gateway` 负责 |
| `agent/index.ts`（Agent god） | 扔形重塑 | Agent 变 Scope 容器 + 薄 composition |
| `agent/turn/index.ts`（TurnFlow） | 拿形重塑 | `turn.ITurnService` + Turn scope + 生命周期事件 |
| `loop/` | 必拿 | `turn.ILoopRunner` |
| `agent/context/`、`agent/records/`、`agent/config/` | 拿 | `context`/`records`/`config` |
| `agent/cron/` + `tools/cron/` | 拿形重塑 | per-Agent → `cron`(Session) + `ICronFireCoordinator` |
| `agent/background/`、`agent/compaction/`、`agent/plan/`、`agent/goal/`、`agent/swarm/`、`agent/usage/`、`agent/injection/` | 拿 | 同名 Domain |
| `agent/turn/tool-dedup.ts` | 拿 | `tooldedup` |
| `agent/permission/` + `policies/` | 拿 + 拿形重塑 | `permission.IPermissionService` + `IPermissionPolicyRegistry`，策略迁回所属 Domain |
| `agent/tool/` + `tools/builtin/**` | 拿形重塑 | `tool.IToolService` + `IToolDefinitionRegistry`，工具迁回所属 Domain `tools/` |
| `agent/skill/` + `skill/registry.ts` | 拿 | `skill` |
| `config/` | 拿 | `config` |
| `services/*`（session/message/tool/skill/task/mcp/config…） | 扔形重塑 | 去 RPC 化，并入对应 Domain |
| `services/event`/`approval`/`question`/`terminal`/`fs`/`workspace`/`fileStore`/`oauth`/`authSummary`/`modelCatalog`/`environment`/`logger` | 拿 | 同名 Domain / `event`/`approval`/`question`/`terminal`/`fs`/`workspace`/`filestore`/`auth`/`kosong`/`environment`/`log` |
| `telemetry.ts` + `packages/telemetry`、`logging/`、`flags/`、`errors/`、`utils/` | 拿 / 必拿 | `telemetry` / `log` / `flag` / `_base` |

> **本速查未覆盖的 v1 子系统**（需补决策，见 §2）：`plugin/**`、`profile/**`、`rpc/**`（coreProcess）、`services/coreProcess`、server 端 `gateway` 传输层。
