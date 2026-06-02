# /config-reload 调研文档

## 背景

目标是新增一个 TUI 斜杠命令 `/config-reload`，用于用户手动修改配置文件后，在不重启 kimi-code 的情况下重新加载并应用配置。这里的“配置”至少涉及两类：

- Core 运行时配置：`~/.kimi-code/config.toml`，由 `packages/agent-core/src/config/*` 解析，影响 provider/model、thinking、permission、hooks、skills、runtime services、background 等。
- TUI 客户端偏好：`~/.kimi-code/tui.toml`，由 `apps/kimi-code/src/tui/config.ts` 解析，影响 theme、editor、notifications、upgrade。

本次只做代码调研和实现建议，不写 TypeScript 实现。

## 当前配置加载链路

### Core config.toml

`KimiCore` 构造时解析配置路径并读取一次运行时配置：

- `packages/agent-core/src/rpc/core-impl.ts:139-159`：解析 `homeDir/configPath`，`this.config = loadRuntimeConfig(this.configPath)`。
- `packages/agent-core/src/config/toml.ts`：`readConfigFile()` 读取 TOML；`loadRuntimeConfig()` 在磁盘配置上叠加 `KIMI_MODEL_*` 环境变量合成的 provider/model。
- `packages/agent-core/src/config/schema.ts`：`KimiConfigSchema` 当前覆盖 provider/model/thinking/permission/hooks/services/skills/loop/background/telemetry 等字段。

已有的全局配置 RPC：

- `packages/agent-core/src/rpc/core-impl.ts:382-386`：`getKimiConfig({ reload: true })` 会重新执行 `loadRuntimeConfig()` 并替换 `KimiCore.this.config`。
- `packages/agent-core/src/rpc/core-impl.ts:389-393`：`setKimiConfig()` 写回文件后也会刷新 `this.config`。
- `packages/agent-core/src/rpc/core-impl.ts:442-448`：`setModel()` 前会调用 `reloadProviderManager()`，因此同一 session 切换模型时能看到外部编辑后的 provider/model 配置。

### Session 创建/恢复时的配置消费

创建 session 时会重新读取 Core 配置，并把配置拆开传给 `Session`：

- `packages/agent-core/src/rpc/core-impl.ts:172-216`：`createSession()` 调用 `reloadProviderManager()`，然后把 `config`、`background`、`hooks`、`permissionRules`、`skills`、`mcpConfig`、`toolServices` 等传进 `Session`。
- `packages/agent-core/src/rpc/core-impl.ts:230-240`：新 main agent 初始化 `modelAlias/thinkingLevel/defaultPlanMode/permissionMode`。
- `packages/agent-core/src/rpc/core-impl.ts:711-735`：恢复 session 后会尝试用当前 config 重新校验/刷新模型 alias，但这是 resume 专用逻辑，不是通用热重载入口。

`ProviderManager` 是当前最接近热重载的部分：

- `packages/agent-core/src/rpc/core-impl.ts:677-684`：`ProviderManager` 拿到的是 `config: () => this.config`。
- 因此当 `KimiCore.this.config` 更新后，已有 Agent 的 provider/model 解析可以看到新配置，但前提是有触发点，例如 `setModel()` 或下一次构造 provider。

### Agent/Session 中固定下来的配置

大量配置在 `Session` 或 `Agent` 构造时固定，不会因为 `KimiCore.this.config` 被替换而自动更新：

- `packages/agent-core/src/session/index.ts:112-149`：`Session` 构造时创建 `HookEngine`、`SkillRegistry`、`McpConnectionManager`，并异步 `loadSkills()` / `loadMcpServers()`。
- `packages/agent-core/src/session/index.ts:325-339`：skills roots 由构造时 `options.skills` 决定。
- `packages/agent-core/src/session/index.ts:341-364`：MCP server 由构造时 `options.mcpConfig` 决定，只初始 `connectAll()`。
- `packages/agent-core/src/session/index.ts:413-432`：每个 Agent 构造时拿到 `config: this.options.config`、`toolServices`、`hookEngine`、`mcp`、`permission` 等。
- `packages/agent-core/src/agent/index.ts:128-141`：`Agent.kimiConfig`、`toolServices`、`mcp`、`hooks` 都是 readonly 引用。
- `packages/agent-core/src/agent/config/index.ts:51-55`：thinking level 解析依赖 `agent.kimiConfig?.thinking`，已有 Agent 持有的是旧 `KimiConfig` 对象。
- `packages/agent-core/src/agent/permission/index.ts:37-55`：permission rules 初始化后保存在 `PermissionManager.rules`，当前无公开替换方法。
- `packages/agent-core/src/rpc/core-impl.ts:655-663`：`resolveRuntime()` 会缓存 `this.runtime`，所以 `services.moonshotSearch/moonshotFetch` 改动不会自动重建 WebSearch/FetchURL provider。

### MCP 和插件

MCP 配置不是 `config.toml`，而是：

- `~/.kimi-code/mcp.json`
- `<cwd>/.kimi-code/mcp.json`

相关代码：

- `packages/agent-core/src/mcp/config-loader.ts`：加载 user/project 两处 `mcp.json`，project 覆盖 user。
- `packages/agent-core/src/mcp/session-config.ts`：`resolveSessionMcpConfig()` 包装成 session 配置。
- `packages/agent-core/src/rpc/core-impl.ts:686-694`：插件 MCP server 会合并进 session MCP config。

当前 MCP 连接管理器的能力：

- `packages/agent-core/src/mcp/connection-manager.ts:145-186`：`connectAll()` 会把传入配置写进 entries 并连接，但不是安全的 reload API；它不会处理已删除 server，也不会先关闭同名旧 client。
- `packages/agent-core/src/mcp/connection-manager.ts:189-205`：`reconnect(name)` 只重连已有 server。
- `packages/agent-core/src/mcp/connection-manager.ts:208-213`：`shutdown()` 可以关闭全部并清空。

插件 reload 已存在：

- `packages/agent-core/src/rpc/core-impl.ts:616-629`：`reloadPlugins()` 只刷新 `PluginManager` 中的插件记录。
- `packages/agent-core/src/plugin/manager.ts:180-199`：`PluginManager.reload()` 返回 added/removed/errors。
- 但已存在 session 的 `SkillRegistry`、plugin MCP server、plugin sessionStart 不会因为 `/plugins reload` 自动更新。

## TUI 侧链路

### Slash 命令注册和分发

新增 slash 命令的热路径：

- `apps/kimi-code/src/tui/commands/registry.ts`：注册命令名、描述、优先级、availability。
- `apps/kimi-code/src/tui/commands/dispatch.ts`：`handleBuiltInSlashCommand()` 分发到具体 handler。
- `apps/kimi-code/src/tui/commands/config.ts`：现有 model/theme/editor/permission/settings 等配置类命令集中在这里。

### TUI 状态同步

启动时：

- `apps/kimi-code/src/tui/kimi-tui.ts:470-536`：`init()` 先 `authFlow.refreshAvailableModels()`，再 create/resume session。
- `apps/kimi-code/src/tui/controllers/auth-flow.ts:29-36`：`refreshAvailableModels()` 调用 `harness.getConfig({ reload: true })`，并更新 `availableModels/availableProviders`。

运行时状态：

- `apps/kimi-code/src/tui/kimi-tui.ts:1004-1018`：`syncRuntimeState()` 从 `session.getStatus()` 同步当前 model/thinking/permission/plan/context。
- `apps/kimi-code/src/tui/kimi-tui.ts:1531-1541`：`applyTheme()` 可立即应用 theme 到 TUI。
- `apps/kimi-code/src/tui/commands/config.ts:334-344`：`persistModelSelection()` 已会 `getConfig({ reload: true })` 后再写默认模型。

TUI 偏好配置：

- `apps/kimi-code/src/tui/config.ts`：`loadTuiConfig()` / `saveTuiConfig()` 管理 `tui.toml`。
- `apps/kimi-code/src/cli/run-shell.ts:33-47`：`tui.toml` 只在 shell 启动时读取一次，`theme = "auto"` 也只在启动时解析一次初始 terminal theme。
- 已有 `/theme`、`/editor`、settings 命令会保存并即时更新局部 TUI state，但没有“重新读取 tui.toml 并应用”的命令。

## 已有能力可以直接复用的部分

1. 重读 Core config 文件：
   - `harness.getConfig({ reload: true })` 已可触发 Core 重新读取 `config.toml`。

2. 刷新 TUI 的可选模型列表：
   - `authFlow.refreshAvailableModels()` 已封装读取配置并更新 `availableModels/availableProviders`。

3. 应用当前 session 的 model/thinking/permission：
   - `session.setModel(alias)` 会触发 Core 先刷新配置再解析新 alias。
   - `session.setThinking(level)` / `session.setPermission(mode)` 可更新已有 Agent 的运行态。
   - `syncRuntimeState()` 可重新拉取并同步 footer/status 需要的 session 状态。

4. 应用 TUI theme：
   - `loadTuiConfig()` 可重新读取 `tui.toml`。
   - `applyTheme()` 可即时更新 UI theme。
   - editor/notifications/upgrade 可以直接 `setAppState()`。

## 关键缺口

### 缺口 1：没有 Core 级 `reloadConfig` 语义

`getKimiConfig({ reload: true })` 只保证 Core 内存配置更新，不表达“应用到当前 session/agent”。如果 TUI 自己拼装 reload 行为，会导致 SDK/API 语义不清，其他客户端也无法复用。

建议新增 Core RPC：

- `reloadKimiConfig(payload): ReloadConfigResult`
- SDK 暴露 `KimiHarness.reloadConfig()` 或 `Session.reloadConfig()`，具体取决于是否允许一次刷新所有 active sessions。

### 缺口 2：已有 Agent 持有旧 `KimiConfig`

已有 Agent 的 `agent.kimiConfig` 是 readonly，thinking 默认值、loopControl 等都基于旧对象。只替换 `KimiCore.this.config` 不足以更新这些状态。

可选方向：

- 保守方向：reload 后只应用 provider/model 列表和当前默认 model/thinking/permission，不承诺更新 loopControl/background/hooks/services。
- 完整方向：让 `Session`/`Agent` 支持 `refreshRuntimeConfig(nextConfig)`，替换或更新 `kimiConfig`、permission rules、hook engine、tool services 等。

### 缺口 3：MCP reload 需要新 lifecycle

直接调用 `connectAll(nextServers)` 不够安全，因为删除的 server 不会消失，同名 server 的旧 client 也未显式关闭。需要给 `McpConnectionManager` 增加 `reload(configs)` 或 `replaceAll(configs)`：

- 对删除项：emit disconnected/disabled 后关闭 client 并移除。
- 对新增项：按现有 connect 逻辑连接。
- 对变更项：关闭旧 client，重新连接。
- 对未变更项：尽量保留连接，避免无谓中断。

### 缺口 4：skills/plugin roots 不会自动更新

`Session.loadSkills()` 是 private，并且 `skillsReady` 是一次性 Promise。config 中 `extraSkillDirs/mergeAllAvailableSkills` 或插件 skill roots 改动后，当前 session 的 `SkillRegistry` 不会刷新，TUI 的 skill-derived slash commands 也不会更新。

需要为 `Session` 增加可调用的 reload skills 能力，完成后 TUI 调 `refreshSkillCommands(session)`。

### 缺口 5：services/runtime provider 被缓存

`KimiCore.resolveRuntime()` 会缓存 `this.runtime`。配置里 `services.moonshotSearch/moonshotFetch` 改了，现有 toolServices 不会重建，Agent 的 WebSearch/FetchURL 工具也不会刷新。完整热重载需要清空或重建 runtime，并触发 `agent.tools.initializeBuiltinTools()`。

### 缺口 6：TUI tui.toml reload 只存在读写函数，没有命令级入口

`loadTuiConfig()` 可以读，但 TUI 需要定义应用策略：

- theme：读取后调用 `applyTheme(next.theme, resolved)`，`auto` 时调用/保留 terminal theme tracking。
- editor：更新 `appState.editorCommand`。
- notifications/upgrade：更新 `appState.notifications/upgrade`。
- 解析失败：沿用 `TuiConfigParseError` 行为，显示错误，不覆盖当前 UI state。

## 推荐实现分层

### 阶段 1：实现保守可用的 `/config-reload`

先实现用户最直接可感知的热重载，不承诺所有 session 构造期配置都能无重启生效。

行为建议：

1. 命令注册：
   - 新增 `/config-reload`，availability 建议 `idle-only`。
   - 原因：重载 model/tools/MCP/permission 时如果正 streaming，容易造成当前 turn 状态和工具列表不一致。

2. TUI handler：
   - 调 `harness.getConfig({ reload: true })` 或未来 `harness.reloadConfig()`。
   - 调 `authFlow.refreshAvailableModels()` 更新 `/model` 列表。
   - 重新读取 `tui.toml` 并应用 theme/editor/notifications/upgrade。
   - 对当前 session：
     - 如果新 config 有 `defaultModel` 且存在于 `config.models`，可选择是否自动切到 default model。
     - 更稳妥的策略是“保持当前 runtime model，只刷新可选列表；如果当前 model 已无法解析则提示用户运行 `/model` 选择”。
     - 如果 config 明确设置 `defaultPermissionMode`，是否覆盖当前 session mode 需要产品确认。当前 session 的 `/yolo`/`/auto` 是运行态选择，自动覆盖可能让用户意外改变审批策略。

3. 状态提示：
   - 输出简短摘要，例如 `Config reloaded: 3 models, 2 providers. TUI settings updated.`
   - 如果当前模型不再存在，提示 `Current model alias is no longer configured; run /model to choose another.`

阶段 1 能解决：

- 用户修改 `config.toml` 后，`/model` 能看到新增/删除的模型 alias。
- 用户修改默认 provider/model 后，后续 `/model`/`setModel` 能按新配置解析。
- 用户修改 `tui.toml` 后，theme/editor/notifications/upgrade 能反映到 TUI。

阶段 1 暂不解决：

- 已连接 MCP server 增删改。
- 当前 session 的 skills roots 变更。
- hooks、background、loopControl、services 的完整热替换。

### 阶段 2：新增 Core/SDK 正式 reload API

推荐 API 形状：

```ts
interface ReloadKimiConfigPayload {
  readonly sessionId?: string;
}

interface ReloadKimiConfigResult {
  readonly config: KimiConfig;
  readonly models: { readonly count: number; readonly defaultModel?: string };
  readonly providers: { readonly count: number };
  readonly sessions: readonly {
    readonly id: string;
    readonly model?: string;
    readonly modelValid: boolean;
    readonly skillsReloaded: boolean;
    readonly mcpReloaded: boolean;
  }[];
  readonly warnings: readonly string[];
}
```

Core 负责：

- 重新 `loadRuntimeConfig()`。
- 清理/重建 `runtime` 或比较 services 后按需重建。
- 对目标 active session 调用 `session.reloadConfig(nextConfig, derivedOptions)`。
- 返回结构化结果给 TUI，而不是让 TUI 猜测发生了什么。

SDK 负责：

- `KimiHarness.reloadConfig()`
- 可选 `Session.reloadConfig()`，只刷新当前 session。

TUI 负责：

- 调 SDK API。
- 调 `authFlow.refreshAvailableModels()`。
- 调 `syncRuntimeState()` 和 `refreshSkillCommands()`。
- 展示摘要和 warnings。

### 阶段 3：完整 session runtime reload

需要新增或调整：

- `Session.reloadRuntimeConfig(input)`：
  - 替换 hooks：需要 `HookEngine` 支持更新 hooks，或者重建并让 Agent 引用新 engine。
  - 替换 permission rules：`PermissionManager` 增加 `setRules()`，保留 session-runtime approval rules。
  - 重载 skills：`SkillRegistry` 支持重新 load roots，并保留/处理已激活 skill 的状态。
  - 重载 MCP：`McpConnectionManager.reload(nextServers)`。
  - 更新 background config：已有 background task 不强制杀掉，新 task 用新配置。
  - 重建 toolServices 并重新 `initializeBuiltinTools()`。
  - 重新解析当前 model alias；当前 alias 消失时保留显示但返回 warning，避免静默切模型。

## 命令语义建议

`/config-reload` 默认建议只 reload，不写回配置文件。

建议用户可见行为：

- 成功：`Config reloaded. Models: N, providers: M.`
- TUI 偏好变更：追加 `TUI settings updated.`
- 当前模型失效：追加 warning，要求用户 `/model`。
- 配置解析失败：显示 `Error: Invalid configuration ...`，保持当前运行态不变。
- `tui.toml` 解析失败：显示 TUI config error，保持当前 TUI state 不变；Core config reload 不受影响。

需要产品确认的点：

1. 是否要在 `/config-reload` 后自动切到新的 `default_model`？
   - 推荐：不自动切。当前 session 的 model 是运行态选择，自动切换会改变后续请求行为。

2. 是否要自动应用新的 `default_permission_mode`？
   - 推荐：不自动覆盖当前 session mode。审批模式属于安全敏感运行态，用户可以用 `/permission`、`/auto`、`/yolo` 显式切换。

3. 是否包含 `mcp.json` 和插件 reload？
   - 推荐：阶段 1 不包含；阶段 2/3 在 Core API 中返回明确结果。否则容易出现“状态显示已 reload，但工具实际没有变化”的半成功体验。

## 测试建议

### Agent Core

新增/扩展：

- `packages/agent-core/test/harness/model-alias-session.test.ts`
  - 覆盖外部修改 `config.toml` 后 reload API 更新 Core config。
  - 覆盖当前 session 保持旧 model alias，不自动切到新 default。
  - 覆盖 current alias 仍存在但 provider 配置改变后，下一次 `getConfig/getStatus` 能看到新 provider/modelCapabilities。
  - 覆盖 invalid config reload 失败且旧 config 保留。

- MCP 完整 reload 若进入实现：
  - `packages/agent-core/test/mcp/connection-manager.test.ts`
  - 覆盖新增、删除、变更、未变更 server。

### Node SDK

新增/扩展：

- `packages/node-sdk/test/config.test.ts` 或单独近邻现有 config 测试
  - `harness.reloadConfig()` 返回结构化结果。
  - `session.reloadConfig()` 若实现，关闭 session 后调用应符合 `session.closed` 行为。

### TUI

扩展：

- `apps/kimi-code/test/tui/commands/registry.test.ts`
  - `/config-reload` 能被识别，availability 符合预期。

- `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`
  - 输入 `/config-reload` 后调用 `getConfig({ reload: true })` 或 `reloadConfig()`。
  - `availableModels/availableProviders` 更新，`/model` picker 看到新 alias。
  - 正在 streaming 时命令被 idle-only 逻辑阻止。
  - `tui.toml` reload 成功时 appState theme/editor/notifications/upgrade 更新。
  - reload 失败时显示错误，旧 appState 不变。

## 风险与边界

- 热重载不是简单“重读文件”：当前 Core 有一部分配置是动态读取，一部分是 session/agent 构造期固定。
- 自动应用默认模型和默认权限会改变当前会话行为，尤其权限属于安全敏感状态，建议不要隐式覆盖。
- MCP reload 涉及外部进程/HTTP 连接生命周期，必须有明确 diff/关闭策略，不能直接复用 `connectAll()`。
- skills reload 可能改变 slash autocomplete 和 Skill tool 可见范围；需要同步 TUI `refreshSkillCommands()`。
- services reload 会改变 WebSearch/FetchURL 工具背后的 provider，需要清理 `KimiCore.runtime` 缓存并重新初始化 builtin tools。
- `KIMI_MODEL_*` 环境变量是运行时配置的一部分；`/config-reload` 重读 `config.toml` 时仍会叠加这些 env overrides，文案上不应暗示只来自磁盘文件。

## 结论

现有代码已经支持“重新读取 Core config 并刷新模型列表”的一部分能力，但还没有一个能把配置变更完整应用到已存在 Session/Agent 的 reload API。推荐先实现保守版 `/config-reload`：刷新 `config.toml`、刷新 TUI 可用模型/provider、重读并应用 `tui.toml`、同步当前 session 状态并展示 warning。随后再补 Core/SDK 的正式 reload API，把 MCP、skills、permission rules、services、hooks/background 等构造期配置纳入可测试的 session runtime reload 流程。
