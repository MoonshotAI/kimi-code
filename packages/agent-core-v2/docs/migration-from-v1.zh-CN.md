# 从 agent-core v1 迁移到 v2

日期：2026-09-19。代码基线：`ccf3d5d6`（main 上删除 v1 的 #3542 的直接父提交）。此时 v1 `@moonshot-ai/agent-core` 0.15.8 与 v2 `@moonshot-ai/agent-core-v2` 0.4.3 并存；本文所有路径与符号均以该基线逐条核对。文中路径一律从仓库根写起。

> v1 包在紧随其后的 main（#3542）中已被删除。本文记录删除时点的代码事实，供仍持有 v1 依赖的消费方完成迁移。

## 0. 先读这一节

本文写给仍在依赖 `@moonshot-ai/agent-core`（v1）的消费方维护者。读完你应当知道：你是否需要迁移、每一步改什么、什么不能做。本文不评述两版架构的优劣；v1 各域在 v2 的去向只在附录 A 的速查表里给出。

迁移完成的标准：你的代码里不再出现对 `@moonshot-ai/agent-core` 的任何引用，且可观察行为与迁移前一致（用第 2.6 节的方法对照验证）。

## 1. 现状（基线时点，已核实）

### 1.1 两个包

| | v1 | v2 |
|---|---|---|
| 包 | `packages/agent-core`，`@moonshot-ai/agent-core` 0.15.8 | `packages/agent-core-v2`，`@moonshot-ai/agent-core-v2` 0.4.3 |
| 入口 | 根 barrel（`src/index.ts`）+ 唯一具名子路径 `./session/store`；`exports` 直指 src，无预构建 dist | 根 barrel + 任意子路径（`./src/*`） |
| 形态 | `Agent` / `Session` / `KimiCore` 类 + 进程内 DI 服务层（`src/di/`、`src/services/`） | 三层 LifecycleScope（App / Session / Agent，`src/app/scopes.ts`；workspace 粒度由 `Program` 的 generation 承担）+ Service / Fiber 单元层 + Feature 缝（`src/features/`） |

### 1.2 谁还在依赖 v1

基线时点全仓库只有两处：

1. `packages/node-sdk` —— 唯一在 package.json 声明该依赖的包（`packages/node-sdk/package.json:62`，位于 `devDependencies` 块）。19 个源文件从 v1 根入口导入，内容是协议类型、错误、配置读写、日志、图像、replay / agentfile / proxy 等，**没有任何深层子路径导入**。node-sdk 同时依赖 v2（同文件 :63），是双引擎并存的完整实例（附录 B）。
2. `apps/vscode/tsdown.config.ts:22-28` —— 一条打包别名，把 `@moonshot-ai/agent-core` 解析到 v1 源码入口，将其（经 node-sdk 传递）内联进扩展产物。纯构建期行为；v1 一旦删除，扩展构建在 bundler 解析期直接失败。

### 1.3 运行时开关

`KIMI_CODE_LEGACY_FLAG`（truthy = `1` / `true` / `yes` / `on`）在 CLI 各入口做 harness 二选一：v1 `createKimiHarness`（`packages/node-sdk/src/sdk-rpc-client.ts:145`）或 v2 `createKimiHarnessV2`（`packages/node-sdk/src/sdk-rpc-client-v2.ts:2732`）。读取点：`apps/kimi-code/src/cli/experimental-v2.ts:14`。`kimi web` / `kimi acp` 不读此开关，恒走 v2。VS Code 侧的同构开关是 `LEGACY_ENGINE_ENV`（`apps/vscode/src/config/vscode-settings.ts:8`）。CI 有双引擎矩阵（`.github/workflows/ci.yml:88`）。

它是回退开关，不是长期形态：新代码一律走 v2 路径。

### 1.4 数据兼容

- **wire 记录（journal）**：两引擎的记录词汇同源。v1 `AGENT_WIRE_PROTOCOL_VERSION = '1.4'`（`packages/agent-core/src/agent/records/migration/index.ts:11`），v2 `WIRE_PROTOCOL_VERSION = '1.5'`（`packages/agent-core-v2/src/wire/migration/migration.ts:19`），v2 的迁移链是 v1 的超集（多出 v1.5 一步）。v2 读 journal 时按链逐条 fold 升级；读到比当前新的版本时不做迁移、原样透传（`src/wire/wireService.ts:141-166`）。
- **损坏修复**：v2 `src/wire/repair.ts` 在读路径遇到截断的 journal 时，把有效前缀重写回原文件，损坏尾部备份为 `<key>.bak`。
- **配置一次性迁移**：机制同名保留（v1 `config/migrations.ts` → v2 `app/config/migrations.ts`），以 `<home>/migrations-effort.json` 标记已执行项，重复执行无害。
- `packages/migration-legacy` 是 kimi-cli（Python）→ kimi-code 的用户数据迁移器，与本文的代码迁移无关；但它只依赖 v2，是「消费方完全切到 v2」的已完成案例。

## 2. 迁移步骤

### 2.1 第 1 步：判断你在用 v1 的哪一层

v1 的用法分三类，迁移路径不同，先归类：

- (a) 只用类型与纯函数（协议类型、配置读写、错误、日志、图像、schema 校验）→ 走 2.2；
- (b) 实例化引擎（`new KimiCore` / `new Session` / `new Agent`）→ 走 2.3；
- (c) 走 RPC 协议与事件面（`CoreAPI` / rpc `Event`）→ 走 2.4。

node-sdk 三类都有，本文以它为参照。

### 2.2 第 2 步：依赖与导入面切换

`package.json` 把 `@moonshot-ai/agent-core` 换成 `@moonshot-ai/agent-core-v2`（可以像 node-sdk 一样先并存、再删 v1）。v2 的 `exports` 允许任意子路径导入，但优先从根入口导入；只有根入口未导出的符号才用子路径（node-sdk 的先例：`_base/utils/workdir-slug`、`mcpCore/connection-manager`、`app/mcpConfig/configLoader`、`workspace/workspaceFs/fs`、`persistence/interface/appendLogStore`、`mcpCore/config-schema`）。

逐组对照（v1 符号 → v2 对应物；v2 路径均在 `packages/agent-core-v2/src/` 下）：

**配置**

| v1 | v2 | 备注 |
|---|---|---|
| `resolveConfigPath` / `resolveKimiHome` | 同名（`app/bootstrap/bootstrap.ts:171` / `:163`） | 直接对应 |
| `ensureKimiHome` | 同名（`app/bootstrap/bootstrap.ts`） | 直接对应 |
| `loadRuntimeConfigSafe` / `KimiConfig` / `readConfigFile` / `writeConfigFile` / `ensureConfigFile` / `parseConfigString` | **无对应** | v2 没有单文档配置 schema：改用 `IConfigService`（`app/config/configService.ts`）+ 分域 `ConfigSection` 注册。需要 v1 形状时参照 node-sdk `src/v2/config-mapper.ts`，把分域视图折回 `KimiConfig` |
| `SECONDARY_DERIVED_MODEL_ALIAS` | **消失** | v2 无此常量 |
| `HookDefSchema` | `features/externalHooks/configSection.ts` | |
| `McpServerConfigSchema` | `mcpCore/config-schema.ts` | |
| `effectiveModelAlias` 等模型解析 | `app/kosongConfig/` | |

**错误**

| v1 | v2 | 备注 |
|---|---|---|
| `KimiError` | `Error2`（`_base/errors/errors.ts:38`） | `isKimiError` → `isError2`。node-sdk 的做法：内部以 `Error2 as V2Error2` 别名并用，对外仍暴露 v1 `KimiError` 形状 |
| `ErrorCodes` | 同名（v2 根 `errors.ts:73`，按域聚合） | 错误码字符串基本沿用 |

**日志**

| v1（`logging/`） | v2（`_base/log/`，经根入口导出） |
|---|---|
| `getRootLogger()` / `log` | `ILogService`；初始化用 `logSeed(resolveLoggingConfig({ homeDir, env }))` 作为 scope seed，关闭用 `drainLogCloses()`（用法见 node-sdk `sdk-rpc-client-v2.ts:466,534`） |

**图像**

| v1（`tools/support/`） | v2（`agent/media/`） |
|---|---|
| `compressImageForModel` 等压缩函数 | 同名（`agent/media/image-compress.ts`，根入口导出） |
| `ImageLimits` 类 | **消失**，改为常量与解析函数：`IMAGE_BYTE_BUDGET` / `MAX_IMAGE_EDGE_PX` / `READ_IMAGE_BYTE_BUDGET` / `resolveMaxImageEdgePx`（根入口导出） |
| 格式策略（MIME 门控等） | `agent/media/image-format-policy.ts` |

**其余**

| v1 | v2 |
|---|---|
| `parseAgentFileText` / `resolveAgentPath` | 同名（`workspace/workspaceAgentProfileLoader/internal/`，根入口导出） |
| `installGlobalProxyDispatcher` | 同名（`_base/utils/proxy.ts:218`） |
| `Emitter` / `Event`（`base/common/event.ts`） | 同名（`_base/event.ts`） |
| flags 类型与中央 registry | `registerFlagDefinition`（`app/flag/flagRegistry.ts`）+ `IFlagService.enabled(id)` |
| `noopTelemetryClient` / `withTelemetryContext` | `app/telemetry/`：`ITelemetryService` / `noopTelemetryService` 与 context 类型；自由函数 `withTelemetryContext` 无同名对应，上下文经 Service 传递 |
| `AGENT_WIRE_PROTOCOL_VERSION` | `WIRE_PROTOCOL_VERSION`（`wire/migration/migration.ts:19`） |
| `limitAgentReplayByTurns` / `ReplayBuilder` | 引擎内只剩类型（`agent/replayBuilder/types.ts`），实现出引擎——见 2.3 的注意 |
| `MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE` | `agent/mcp/tools/auth.ts` |
| `ToolStore`（`tools/store.ts`） | **消失**：工具态并入 state / replayable key 与各域 Ops |

### 2.3 第 3 步：引擎实例化切换

v1 的形态（node-sdk `sdk-rpc-client.ts:77-89`）：

```ts
const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
this.core = new KimiCore(coreRpc, { homeDir, configPath, ... });
// core.createSession() / core.shutdown()
```

`Session`（`packages/agent-core/src/session/index.ts:230`）与 `Agent`（`packages/agent-core/src/agent/index.ts:115`）由 KimiCore / Session 托管创建；`resume()` 重放 wire 记录，`turn.prompt()` 驱动对话。

v2 的形态（模板：`packages/kap-server/src/start.ts:196`）：

1. `bootstrap(input, extraSeeds?)`（`app/bootstrap/bootstrap.ts:138`）返回 App scope。`input` 负责解析 `KIMI_CODE_HOME`、`config.toml`、clientIdentity；`extraSeeds` 放日志等种子（如 `logSeed`）。
2. 之后一切经 `scope.accessor.get(IXxxService)` 取服务：`IConfigService`、`ISessionIndex`、`IWorkspaceInstanceManager`、`IPluginService`、`IEventService` 等。
3. 每个 workspace 一个 `Program`（`program/program.ts:113`），构造即建立 workspace 代（state / dirs / fs / watch / git / instructions / mcp / skills / agentProfiles）；`program.createSessionController()` 是 session 生命周期入口；agent 由 session controller 内部创建。
4. 消费方助手函数（v2 根导出）：`programForSession` / `resumeSessionById` / `closeSessionById` / `getLiveSessionById` / `followSessionLifecycles` / `ensureMainAgent` / `agentContextOf`。
5. 关闭路径：`drainSessionIndexMirror` / `drainQueryStoreDisposals` / `drainLogCloses` / `IMcpOAuthService.shutdown()`。

完整的迁移后形态参照 node-sdk `sdk-rpc-client-v2.ts`（约 2700 行）——它就是「同一套对外 SDK，内部从 v1 切到 v2」的成品；其 `src/v2/` 目录的六个 mapper 文件是逐块范例（附录 B）。

**注意**：node-sdk `src/v2/resume-replay.ts:108-113` 目前借助 v1 的 `Agent` / `AgentRecords` 把 v2 的 wire.jsonl fold 成 v1 形状的 replay——这一用法依赖 v1 包仍然存在，v1 删除后必须改为在消费方自行 fold（`packages/transcript` 提供 reducer）。迁移时不要把这个模式带进新代码。

### 2.4 第 4 步：RPC 与事件面切换

v1 的 `rpc/` 层在 v2 整层移出引擎：

| v1 | v2 去向 |
|---|---|
| 协议类型（`CoreAPI` / rpc `Event` / `SDKAPI`） | `packages/protocol` + `packages/klient`（`global.*` / `session(id).*` / `agent(id).*` facade，zod 校验） |
| 服务端实现（`KimiCore`，`packages/agent-core/src/rpc/core-impl.ts:224`） | `packages/kap-server`（REST + WebSocket；v1 REST 形状经 v2 `app/sessionLegacy/` 投影） |
| 进程内 `createRPC` 对 | 引擎内事件：`IEventBus`（`app/event/eventBus`）+ `Event2`（`app/event/event2`） |

需要把事件维持成 v1 形状的，照 node-sdk `src/v2/event-mapper.ts` 做纯映射（补 sessionId / agentId 戳）；session 元数据的形状差异（ISO 时间 ↔ epoch 毫秒、`workDir` ↔ `cwd`）参照 `src/v2/session-mapper.ts`。

### 2.5 第 5 步：数据兼容确认

按 1.4 逐条核对：wire journal 自动升级旧版本、新版本原样透传；配置一次性迁移机制不变；`~/.kimi-code/` 目录布局不变。如果你的消费方持久化过 v1 私有形状（例如 replay 快照），用真实数据起一遍 v2 验证。

### 2.6 第 6 步：验证

1. 类型与构建：消费方构建与 typecheck 通过，且 `rg "@moonshot-ai/agent-core"` 在你的包内零命中（注意排除 `agent-core-v2` 前缀误匹配）。
2. 行为对照：利用 `KIMI_CODE_LEGACY_FLAG` 在双引擎间切换跑同一流程（CI 即此矩阵），两边可观察行为一致。
3. 数据：用真实 session 目录起 v2，确认 journal 迁移、replay 重建、配置读取一致。

## 3. 纪律

1. 不新增对 v1 的任何依赖。v1 已在 main 删除（#3542），新的 v1 引用无法进入 main。
2. `KIMI_CODE_LEGACY_FLAG` 是回退开关，不是长期形态；新代码一律落在 v2 路径上。
3. 不在 v2 引擎内为 v1 形状加兼容层。兼容层只能长在消费方（参照 node-sdk `src/v2/*.ts`）。
4. v1 侧禁止新增深子路径引用；v2 侧优先根入口，子路径仅限根入口未导出的符号。
5. 不把 v1 的实现复制进 v2。附录 A 指出了每个域在 v2 的既有去向；标明「消失」的条目（如 `ToolStore`、`ImageLimits` 类、`SECONDARY_DERIVED_MODEL_ALIAS`）是刻意消失，按 2.2 的替代写法改写消费方代码。

## 附录 A：域映射速查表

去向一列的路径均在 `packages/agent-core-v2/src/` 下；「→ 外部包」表示能力整层移出引擎。

### A.1 v1 `src/` 顶层

| v1（`packages/agent-core/src/`） | v2 去向 | 关系 |
|---|---|---|
| `di/` | `_base/di/` | 直接移植，并新增 scope / fiber / service / collection |
| `base/common/event.ts` | `_base/event.ts` | 同名 |
| `errors/` | `_base/errors/` + 根 `errors.ts` | `KimiError` → `Error2`；`ErrorCodes` 按域聚合 |
| `logging/` | `_base/log/` | `getRootLogger()` → `ILogService` + `logSeed` |
| `telemetry.ts` | `app/telemetry/` | Client → Service |
| `flags/` | `app/flag/` | 中央 registry → `registerFlagDefinition` + `IFlagService` |
| `config/` | `app/config/` + `app/kosongConfig/` + `app/projectLocalConfig/` | 拆分；单文档 schema → 分域 section；`migrations.ts` → `app/config/migrations.ts`（同名机制） |
| `loop/` | `agent/loop/` + `human/agent/`（turn 机器） | 拆分 |
| `mcp/` | `mcpCore/`（传输层）+ `app/mcpRegistry/` + `app/mcpConfig/` + `app/mcpManagement/` + workspace / session / agent 各粒度 `mcp` | 拆分 |
| `plugin/` | `app/plugin/` + `agent/plugin/` + `agent/pluginCommand/` | 同名移植 + agent 粒度下沉 |
| `profile/` | `app/agentProfileCatalog/` + `workspace/workspaceAgentProfileLoader/` + `agent/profile/` + `session/sessionAgentProfileCatalog/` | 拆分 |
| `skill/` | `features/skill/` | feature 化 |
| `tools/` | `agent/tools/` + `tool/` + `agent/toolPolicy/` + `app/web/providers/` + `agent/media/` + `agent/task/` + `app/task/` + `features/cron/` | 拆分；`store.ts`（`ToolStore`）消失 |
| `rpc/` | → 外部包：`packages/protocol` + `packages/kap-server` + `packages/klient` | 整层出引擎；`Emitter` / `Event` 留在 `_base/event.ts` |
| `services/`（22 个域的进程内服务层） | 各 scope 域的 Service（同一套 `createDecorator` 约定），见 A.3 | 按 scope 拆分；`coreProcess/` 消失（v2 单进程） |
| `session/` | 见 A.3 | |
| `agent/` | 见 A.2 | |
| `utils/` | `_base/utils/`（proxy / retry / canonical-args 等同名）+ 个别归属 | `tokens.ts` → `agent/tokenCounting/`；`per-id-json-store.ts` 消失 |
| `version.ts` | `_base/version.ts` | 同名 |

### A.2 v1 `agent/` 子域

| v1 `agent/` | v2 去向 |
|---|---|
| `background/` | `agent/task/` + `app/task/` + `agent/tools/task/` |
| `compaction/` | `agent/fullCompaction/` + `agent/contextMemory/compactionHandoff.ts`；`micro.ts` 消失 |
| `config/` | `llm-adapter/model/thinking.ts` + 各域 configSection（分散） |
| `context/` | `agent/contextMemory/` + `agent/contextProjector/`；`dynamic-tools.ts` → `agent/toolSelect/dynamicTools.ts`；tool-result 渲染 → `agent/toolResultTruncation/` |
| `cron/` | `features/cron/` |
| `goal/` | `features/goal/` |
| `injection/` | `features/reminder/` + `agent/agentsMdReminder/` + `agent/interruptionReminder/`（提示注入体系 feature 化，逐项对应以代码为准） |
| `permission/` | `agent/permissionGate` / `permissionMode` / `permissionPolicy` / `permissionRules/`（`matchesRule.ts` 同名）+ `session/sessionToolPolicy(Gate)/` + `session/approval/` + `session/question/` |
| `plan/` | `features/plan/` |
| `records/` | `wire/`（record / wireService / migration；协议版本 1.4 → 1.5）+ `agent/blob/` + `persistence/interface/blobStore` |
| `replay/` | `agent/replayBuilder/types.ts`（仅类型）；实现出引擎 |
| `skill/` | `features/skill/` |
| `swarm/` | `features/swarm/` |
| `tool/` | `agent/toolExecutor` / `toolRegistry` / `toolActivation` / `userTool/` + `tool/toolContract.ts` |
| `turn/` | `_base/utils/canonical-args.ts` + `llm-adapter/` + `human/agent/machine.ts` + `agent/media/mediaResolver.ts` + `agent/toolDedupe/` + `agent/toolResultTruncation/` |
| `usage/` | `agent/usage/` + `session/usage/` + `features/usage/` |
| `llm-request-recorder.ts` / `llm-request-logger.ts` | `llm-adapter/contract/request-trace.ts` + `agent/llmRequester/` |

### A.3 v1 `session/` 与 `services/`

| v1 `session/` | v2 去向 |
|---|---|
| `store/` | `persistence/`（appendLog / atomicDocument / query store）+ `app/sessionIndex/` + `app/workspace/` |
| `export/` | `app/sessionExport/` |
| `git-context.ts` | `session/agentLifecycle/profile/gitContext.ts` |
| `hooks/` | `features/externalHooks/`（app / session / agent 三层） |
| `provider-manager.ts` | `llm-adapter/provider/` + `app/kosongConfig/` |
| `subagent-*.ts` | `session/subagent/` |
| `rpc.ts` | → 外部包：kap-server 路由 / klient |

v1 `services/` 的 22 个域按 scope 落到 v2 同名语义的域目录，代表性的对应：`approval` → `session/approval/`；`question` → `session/question/`；`event` → `app/event/`；`config` → `app/config/`；`session` → `app/sessionManager/` + `workspace/sessionLifecycle/`；`mcp` → `app/mcpManagement/`；`oauth` → `app/mcpConfig/` + `packages/oauth`；`fs` → `workspace/workspaceFs/`；`logger` → `_base/log/`；`terminal` → `os/interface/terminal.ts` + `session/terminal/`；`skill` → `features/skill/`；`modelCatalog` → `llm-adapter/model/catalog-service`；`message` → kap-server 侧 services（引擎外）；`coreProcess` → 消失（v2 单进程内 DI，边缘由 kap-server 承担）。其余域按同一套 `createDecorator` + `_serviceBrand` 约定落在对应 scope 的域目录。

## 附录 B：node-sdk 的双引擎并存实例

node-sdk 在基线时点同时依赖两个引擎（`packages/node-sdk/package.json:62-63`），自身对外 API 不变，内部按 harness 分流——这是「消费方先并存、再切净」的完整参照：

- `src/sdk-rpc-client.ts` —— v1 harness：`createKimiCore` 路径（第 145 行 `createKimiHarness`）。
- `src/sdk-rpc-client-v2.ts` —— v2 harness 主体：从 v2 根入口导入 `bootstrap` / `ensureKimiHome`、全部 `I*Service` token、`Error2 as V2Error2` / `ErrorCodes as V2ErrorCodes`、session 助手函数族，另加少量深子路径导入（见 2.2）。
- `src/v2/session-wiring.ts` —— 每个 live session 的事件与交互接线（订阅各 agent 的 `IEventBus` 转发）。
- `src/v2/event-mapper.ts` —— v2 `Event2` → v1 SDK 事件形状的纯映射。
- `src/v2/session-mapper.ts` —— v2 `SessionMeta` ↔ v1 `SessionSummary` 的形状映射。
- `src/v2/config-mapper.ts` —— v2 分域 config 视图 → v1 `KimiConfig` 单文档形状。
- `src/v2/import-context.ts` —— 用 v2 原语复制 v1 `ContextMemory.importContext` 的用户消息。
- `src/v2/resume-replay.ts` —— 借助 v1 实现 fold v2 wire.jsonl（依赖 v1，属待清债，见 2.3 注意）。
- `src/v2/global-mcp.ts` —— 沿用 v1 `McpServerConfigSchema` 的 session 级 MCP 校验。

## 子文档

- [migration/reference/symbol-map.zh-CN.md](migration/reference/symbol-map.zh-CN.md) —— 全部 714 个 v1 根入口符号到 v2 去向的穷尽映射,含同名碰撞与陷阱汇总与待核清单。
- [migration/reference/event-and-rpc-map.zh-CN.md](migration/reference/event-and-rpc-map.zh-CN.md) —— v1 CoreAPI 方法清单与 Event 联合成员,及各自在 klient / protocol / kap-server / IEventBus / Event2 的去向,附 node-sdk v2 映射层规则。
- [migration/reference/wire-and-data.zh-CN.md](migration/reference/wire-and-data.zh-CN.md) —— wire 迁移链、版本判定与失败行为、journal 修复、`~/.kimi-code` 磁盘布局对照、resume-replay 的 v1 依赖点。
- [migration/explanation/architecture.zh-CN.md](migration/explanation/architecture.zh-CN.md) —— 给 v1 读者的 v2 架构解说:DI 与 services、LifecycleScope 层级、Feature 缝、迁移史与关键决策。
- [migration/how-to/engine-lifecycle.zh-CN.md](migration/how-to/engine-lifecycle.zh-CN.md) —— 如何启动、使用、关闭 v2 引擎:bootstrap、accessor、Program、session controller、助手函数、drain* 顺序与测试起引擎方式。
- [migration/tutorials/first-consumer-migration.zh-CN.md](migration/tutorials/first-consumer-migration.zh-CN.md) —— 引导式教程:以「读配置 → 建 session → 发 prompt → 收事件 → 关闭」最小闭环迁移你的第一个消费方。

每篇子文档在同路径下有英文原版(去掉 `.zh-CN` 后缀)。llms.txt 格式的索引见 [llms.txt](llms.txt)。
