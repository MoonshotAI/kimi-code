# Kimi Code CLI — 变更日志

本文档记录 kimi-code 项目的全局更改历史。各子包独立 CHANGELOG 见对应目录。

## 2026-08-02

### feat: 用户级 Skill 可视化 CRUD — 单个技能创建/编辑/删除

补齐「用户级 Skill 管理 REST 路由」的前端集成（此前仅后端就绪，标注「前端集成待后续补充」）。在设置面板「技能」tab 新增「用户自定义技能」区块，对 `<kimi-home>/skills/<name>/SKILL.md` 实现端到端可视化增删改：列表展示、内联表单（名称/描述/内容）、改名支持（先删旧再建新）、懒加载与 loading/error 状态。

| 层级 | 文件 | 改动 |
|---|---|---|
| State | `apps/kimi-web/src/composables/client/useModelProviderState.ts` | 新增 `userSkills`/`userSkillsLoading`/`userSkillsError` 状态与 `loadUserSkills`/`upsertUserSkill`/`deleteUserSkill` 动作 |
| State | `apps/kimi-web/src/composables/useKimiWebClient.ts` | 暴露用户技能状态与动作 |
| UI | `apps/kimi-web/src/components/settings/SettingsDialog.vue` | 技能 tab 新增「用户自定义技能」区块：列表 + 内联表单 + 同名校验 + 改名（删旧建新）+ 懒加载 |
| i18n | `apps/kimi-web/src/i18n/locales/{en,zh}/settings.ts` | 新增 14 个文案 key（按钮、标签、占位符、错误提示） |

### feat: MCP 服务器配置管理 — 用户级 mcp.json 可视化 CRUD

在 Web 设置面板新增独立「MCP」导航 tab，对用户级 `<kimi-home>/mcp.json` 实现端到端可视化管理（列表 / 新增 / 编辑 / 删除），前端表单支持 stdio / HTTP / SSE 三种传输模式，可编辑命令、参数、环境变量、请求头、启用开关与超时。

| 层级 | 文件 | 改动 |
|---|---|---|
| Protocol | `packages/kap-server/src/protocol/rest-mcp.ts` | 新增 `wireMcpServerConfigSchema` 等 wire schema，snake_case ↔ camelCase 预处理 |
| Route | `packages/kap-server/src/routes/mcp.ts` | 新增 `GET/POST/DELETE /mcp/config/servers`，读写 `<kimi-home>/mcp.json` |
| Route | `packages/kap-server/src/routes/registerApiV1Routes.ts` | 注册 MCP 路由 |
| Test | `packages/kap-server/test/mcp.test.ts` | 新增端到端测试 |
| Wire | `apps/kimi-web/src/api/daemon/wire.ts` | 新增 `WireMcpServerConfig` 等 wire 类型 |
| Client | `apps/kimi-web/src/api/daemon/client.ts` | 实现 `listMcpServers` / `upsertMcpServer` / `deleteMcpServer` |
| Type | `apps/kimi-web/src/api/types.ts` | 新增 `AppMcpServerConfig` + `KimiWebApi` 三个 MCP 方法 |
| State | `apps/kimi-web/src/composables/client/useWorkspaceState.ts` | 新增 MCP 状态与 `loadMcpServers`/`upsertMcpServer`/`deleteMcpServer` |
| State | `apps/kimi-web/src/composables/useKimiWebClient.ts` | 暴露 MCP 状态与动作 |
| UI | `apps/kimi-web/src/components/settings/SettingsDialog.vue` | 新增 MCP tab：列表 + 内联表单 + 重名校验 + 重命名支持 |
| i18n | `apps/kimi-web/src/i18n/locales/{en,zh}/settings.ts` | 新增 MCP 表单全套文案 |

### fix: provider PATCH 路由修复 — 前后端契约闭合

kimi-web `updateProvider` 调 `PATCH /providers/{id}` 但 kap-server 仅注册 PUT（且 PUT 要求全量字段），运行时断裂。新增 PATCH 部分更新路由，与既有 PUT 全量替换语义互补。

| 层级 | 文件 | 改动 |
|---|---|---|
| Protocol | `packages/kap-server/src/protocol/rest-modelCatalog.ts` | 新增 `patchProviderRequestSchema`（全可选，无 models） |
| Route | `packages/kap-server/src/routes/modelCatalog.ts` | 新增 `PATCH /providers/{provider_id}`：部分合并，保留 models，不支持重命名 |
| Cleanup | `apps/kimi-web/src/api/types.ts` / `client.ts` | 清理过时 `PRESUMED` 注释（kap-server 已实现） |

### feat: 设置面板导航重构 — 提供商/偏好/引导独立导航

将提供商管理从独立弹窗改为设置面板内嵌 tab；「通用」重命名为「偏好」并加入引导区；删除冗余「账户」tab。

| 改动 | 说明 |
|---|---|
| `general` → `preferences` | 偏好 tab：外观 + 通知 + 引导（重新打开首次运行向导） |
| 新增 `providers` tab | 内嵌 `ProviderManager`（`embedded` prop 去掉 Dialog 外壳），CRUD 直接在 tab 内完成 |
| 删除 `account` tab | 账号模型标签移入「高级」tab；登录/登出在 bypass-auth 下已失效，引导按钮已移入偏好 |
| 导航顺序 | 偏好 → Agent → 提供商 → MCP → 技能 → 高级 → 已归档 |

| 层级 | 文件 | 改动 |
|---|---|---|
| UI | `apps/kimi-web/src/components/settings/ProviderManager.vue` | 新增 `embedded` prop，`<component :is>` 避免内容重复 |
| UI | `apps/kimi-web/src/components/settings/SettingsDialog.vue` | tab 重构 + providers tab 内嵌 + 偏好加引导 + 删除 account |
| i18n | `apps/kimi-web/src/i18n/locales/{en,zh}/settings.ts` | 新增 `onboardingSection` / `onboardingHint` |

### feat: 用户级 Skill 管理 REST 路由 — SKILL.md 可视化 CRUD 后端

新增用户级技能的后端管理接口（与 MCP 配置管理同模式），读写 `<kimi-home>/skills/<name>/SKILL.md`。name 限制 `^[a-zA-Z0-9_-]+$` 防路径逃逸。前端集成待后续补充。

| 层级 | 文件 | 改动 |
|---|---|---|
| Protocol | `packages/kap-server/src/protocol/rest-user-skill.ts` | 新增 `userSkillDescriptorSchema` / `listUserSkillsResponseSchema` / `upsertUserSkillRequestSchema` / `userSkillNameParamSchema` |
| Route | `packages/kap-server/src/routes/skills.ts` | 新增 `GET/POST/DELETE /skills/config/user-skills`，基于 `IHostFileSystem` 读写 SKILL.md，复用 `parseSkillText` 解析 frontmatter |

### docs: 二开版本同步官方提交指南

新建 `二开版本同步官方提交指南.md`，记录当前二开相对官方 `e22479a6` 的 11 个叠加 commit、改动文件冲突风险分级、标准 rebase 同步流程、关键接缝区合并原则与回滚方案。

---

## 2026-07-31

### feat: 彻底移除 Kimi 登录认证 — 任何功能直接可用

移除全部 Kimi OAuth 登录/认证机制，Web UI 启动后直接进入主界面，所有功能无需登录即可使用。服务端默认跳过 bearer-token 认证。

| 层级 | 文件 | 改动 |
|---|---|---|
| Server | `packages/kap-server/src/start.ts` | `disableAuth` 默认跳过认证（仅显式 `false` 时启用）；`dangerousBypassAuth` 默认 true；WebSocket 升级同理 |
| CLI | `apps/kimi-code/src/cli/sub/web/run.ts` | 始终 `disableAuth: true`，移除 danger 警告横幅，废弃 `--dangerous-bypass-auth` |
| API | `apps/kimi-web/src/api/types.ts` | 移除 `OAuthLoginStartResult`、`startOAuthLogin()`/`pollOAuthLogin()`/`cancelOAuthLogin()`/`logout()`/`refreshOAuthProviderModels()` |
| API | `apps/kimi-web/src/api/daemon/client.ts` | 移除全部 OAuth 方法 |
| API | `apps/kimi-web/src/api/daemon/wire.ts` | 移除 `WireManagedProvider`/`WireOAuth*`/`WireLogoutResult` |
| 状态 | `apps/kimi-web/src/composables/useAuthGate.ts` | `showAuthGate` 恒为 false |
| 状态 | `apps/kimi-web/src/composables/useKimiWebClient.ts` | `authReady` 恒为 true，移除 `managedProviderStatus`/OAuth 导出 |
| 状态 | `apps/kimi-web/src/composables/client/useWorkspaceState.ts` | logout 改为 no-op，checkAuth 简化 |
| UI | `apps/kimi-web/src/App.vue` | 移除认证门全页、LoginDialog、`openLogin()`、`showLogin` |
| UI | `apps/kimi-web/src/components/settings/SettingsDialog.vue` | 移除"登录 Kimi"按钮、managed 标签、登出按钮 |
| UI | `apps/kimi-web/src/components/settings/ProviderManager.vue` | 移除"登录 Kimi"按钮 |
| UI | `apps/kimi-web/src/components/mobile/MobileSettingsSheet.vue` | 移除登录/登出按钮 |

### feat: 提供商管理重构 — 去重、真实 vendor 类型、模型持久化

- **去重**：`addProvider` 用 UI 类型作为稳定 provider id（如 `deepseek`），重复添加触发服务端 `PROVIDER_ALREADY_EXISTS`
- **模型持久化**：添加时传完整预设模型列表，重启后无需 refresh 也能看到模型
- **共享预设**：新建 `src/lib/providerPresets.ts`，统一管理类型列表 / 自动填充 / 模型目录
- **编辑修复**：`updateProvider` 改用 PUT（服务端 replace 语义），修复 404

| 层级 | 文件 | 改动 |
|---|---|---|
| API | `apps/kimi-web/src/lib/providerPresets.ts` | 新建共享 `PROVIDER_TYPES` + 预设模型 |
| API | `apps/kimi-web/src/api/daemon/client.ts` | `addProvider` 去重 + 完整模型；`updateProvider` 改 PUT |
| API | `apps/kimi-web/src/api/daemon/http.ts` | 新增 `put()` 方法 |
| UI | `SettingsDialog.vue` / `ProviderManager.vue` | 从共享模块导入，列表显示 `p.id` 的本地化名称 |

### feat: 模型不再需要 wire type 映射

服务端 `providerWireTypeSchema` 原本只接受 6 种 wire type，导致 deepseek/qwen 等必须映射为 `openai`。现在：

- **agent-core-v2** 新建 `vendors.contrib.ts`，注册 DeepSeek/Qwen/Zhipu/Baichuan/MiniMax/Ollama/Custom 的 provider definition（均 `baseProtocol: 'openai'`）
- **kap-server** 扩展 `providerWireTypeSchema`，直接接受这些 vendor id
- **前端** 移除 `WIRE_TYPE_MAP`，UI 类型即服务端 vendor id（`moonshot` → `kimi`）

### fix: 删除 provider 的孤儿引用与列表同步

- **前端** `deleteProvider` 失败时也刷新列表，服务端不存在的条目自动清除
- **服务端** 删除 provider 后清理孤儿 `default_model`（指向已删 provider 模型别名的引用）

### fix: 对话框层叠 z-index

`Dialog.vue` + `dialogStack.ts`：对话框 z-index 改为动态递增，后打开的对话框始终覆盖先前的，修复 ConfirmDialogHost 被 Provider Manager 遮挡的问题。

---

## 2026-07-30

### feat: Kimi 生态解耦 — 方案 B 标准解耦 (`b630fb3c`)

将 CLI 从 Kimi 深度绑定中解耦，支持任意 OpenAI-compatible provider（DeepSeek / 通义千问 / 智谱 GLM / 百川 / MiniMax / Ollama 等），无需 Kimi 认证即可使用全部功能。全部向后兼容，现有 Kimi 用户不受影响。

#### 核心包 — Provider 抽象层

| 层级 | 文件 | 改动 |
|---|---|---|
| oauth | `packages/oauth/src/open-platform.ts` | `OpenPlatformDefinition` 新增 `providerType` 字段；新增 `fetchGenericOpenAIModels()` 标准 `/v1/models` 模型发现；新增 `GENERIC_MODEL_FALLBACKS` 内置模型能力表（DeepSeek V4 / Qwen3.7 / GLM-5.1 / Kimi K3 / Baichuan4 / MiniMax-M3 等 30+ 国内模型） |
| oauth | `packages/oauth/src/refreshProviderModels.ts` | 新增 §2.6 "Generic OpenAI-compatible providers" 刷新分支，对 `type: 'openai'` 的 provider 自动调用 `fetchGenericOpenAIModels` |
| oauth | `packages/oauth/src/index.ts` | 导出 `fetchGenericOpenAIModels` |
| oauth | `packages/oauth/src/identity.ts` | `createKimiDefaultHeaders()` 新增 `includeDeviceHeaders` 参数，非 Kimi 场景可抑制 `X-Msh-*` 头 |
| agent-core | `packages/agent-core/src/config/kimi-env-params.ts` | `instanceof KimiChatProvider` → 运行时 `provider.name` 检查 + `KimiProviderApi` / `AnthropicProviderApi` 类型窄化 |
| agent-core | `packages/agent-core/src/agent/llm-request-recorder.ts` | `instanceof KimiChatProvider` → `provider.name` 检查 |

#### TUI — 首次启动体验

| 层级 | 文件 | 改动 |
|---|---|---|
| TUI | `apps/kimi-code/src/tui/controllers/auth-flow.ts` | 新增 `enterStartupWizardState()`：无 provider 时立即弹出平台选择器，不再等待用户输入 `/login` |
| TUI | `apps/kimi-code/src/tui/commands/auth.ts` | 新增 `handleGenericProviderLogin()`：选厂商→输 Key→拉模型→选模型→写配置 完整流程 |
| TUI | `apps/kimi-code/src/tui/commands/prompts.ts` | 新增 `promptGenericProviderSetup()` + 国内 6 大厂商预设（DeepSeek/Qwen/Zhipu/Baichuan/MiniMax/Ollama） |
| TUI | `apps/kimi-code/src/tui/components/dialogs/platform-selector.ts` | 新增 "Generic Provider" 选项 + `GENERIC_PLATFORM_MARKER` |
| TUI | `apps/kimi-code/src/tui/kimi-tui.ts` | `AUTH_LOGIN_REQUIRED` → `enterStartupWizardState` 自动弹出向导 |

#### Web 界面

| 层级 | 文件 | 改动 |
|---|---|---|
| Web | `apps/kimi-web/src/components/settings/ProviderManager.vue` | `PROVIDER_TYPES` 全面更新：模型名升级为最新版本（DeepSeek V4 / Qwen3.7 / Kimi K3 / GLM-5.1），新增智谱/百川/MiniMax，移除 OpenAI/Anthropic |
| Web | `apps/kimi-web/src/i18n/locales/en/providers.ts` | 新增 `zhipu` / `baichuan` / `minimax` 标签，移除 `openai` / `anthropic` |
| Web | `apps/kimi-web/src/i18n/locales/zh/providers.ts` | 同上（中文） |

#### 文档

| 层级 | 文件 | 改动 |
|---|---|---|
| docs | `kimi-binding-analysis.md` | 新建完整分析文档，包含 6 层绑定分析、解绑方案、迁移路径、变更日志 |

### feat: 提供商编辑功能（设置页面 + ProviderManager）

在设置页面和提供商管理弹窗中新增编辑提供商功能，支持修改 API Key / Base URL / 默认模型。

| 层级 | 文件 | 改动 |
|---|---|---|
| API | `apps/kimi-web/src/api/types.ts` | `KimiWebApi` 接口新增 `updateProvider(id, input)` |
| API | `apps/kimi-web/src/api/daemon/client.ts` | 实现 `updateProvider`，`PATCH /providers/{id}` 部分更新 |
| 状态 | `apps/kimi-web/src/composables/client/useModelProviderState.ts` | 新增 `updateProvider()` 函数，更新后自动刷新列表 |
| 状态 | `apps/kimi-web/src/composables/useKimiWebClient.ts` | 重新导出 `updateProvider` |
| Web | `apps/kimi-web/src/components/settings/SettingsDialog.vue` | 新增编辑按钮 + 编辑表单（预填、类型禁用、API Key 选填）；`PROVIDER_TYPES` 同步为完整列表（含 deepseek/qwen/zhipu 等 8 种） |
| Web | `apps/kimi-web/src/components/settings/ProviderManager.vue` | 同步新增编辑功能 + `@update` emit |
| Web | `apps/kimi-web/src/App.vue` | 连接 `handleUpdateProvider` 事件处理 |
| i18n | `apps/kimi-web/src/i18n/locales/{zh,en}/providers.ts` | 新增 `apiKeyOptional` / `editTitle` 键 |

---

## 2026-07-29

### feat: MCP 文件编辑、superpowers-zh 安装、分支选择器 (`5cc0efa2`)

三大功能合入 `main` 分支。

#### 1. MCP 直接编辑 .mcp.json

SettingsDialog 的 MCP `projectFile` 模式现在通过 `fs:write` API 直写工作区 `.mcp.json` 文件，不再仅存于 `config.raw`。切换到 `projectFile` 时异步读取真实文件内容。

| 层级 | 文件 | 改动 |
|---|---|---|
| Schema | `packages/agent-core-v2/src/session/sessionFs/fs.ts` | 新增 `fsWriteRequestSchema` / `fsWriteResponseSchema` |
| Service | `packages/agent-core-v2/src/session/sessionFs/fsService.ts` | 实现 `write()` 方法，基于 `IHostFileSystem.writeText` |
| Route | `packages/kap-server/src/routes/fs.ts` | `FS_ACTIONS` 新增 `'write'`，`handleWrite` 处理函数 |
| API | `apps/kimi-web/src/api/daemon/client.ts` | 新增 `writeFile(sessionId, { path, content })` |
| UI | `apps/kimi-web/src/components/settings/SettingsDialog.vue` | `saveMcpAll` + `setMcpSource` 更新 |

#### 2. superpowers-zh 安装与进度反馈

安装卡片从「复制命令到剪贴板」升级为真实安装流程：通过 `:exec` session action 执行 `npx superpowers-zh`，显示安装状态（idle → installing → done/error）、执行日志，成功后自动刷新技能列表。新增「已安装技能」区域展示非 builtin 技能。

| 层级 | 文件 | 改动 |
|---|---|---|
| Route | `packages/kap-server/src/routes/sessions.ts` | 新增 `exec` session action |
| API | `apps/kimi-web/src/api/daemon/client.ts` | 新增 `execCommand(sessionId, { command, cwd, timeoutMs })` |
| UI | `apps/kimi-web/src/components/settings/SettingsDialog.vue` | 安装 UI、状态管理、技能刷新、已安装技能展示 |
| i18n | `en/settings.ts` + `zh/settings.ts` | `skillInstalling` / `skillInstallDone` / `skillInstallFailed` / `skillRefreshHint` / `skillInstalledSkills` |

#### 3. 顶部栏 Git 分支下拉选择器

ChatHeader 的分支名从纯文本改为可点击下拉选择器，列出所有本地分支并支持一键切换。切换成功后自动刷新 git 状态并打开变更面板。

| 层级 | 文件 | 改动 |
|---|---|---|
| Interface | `packages/agent-core-v2/src/app/git/git.ts` | `IGitService` 新增 `listBranches(cwd)` / `checkout(cwd, branch)` |
| Service | `packages/agent-core-v2/src/app/git/gitService.ts` | 实现两个方法 |
| Route | `packages/kap-server/src/routes/sessions.ts` | 新增 `git-branches` / `git-checkout` session actions |
| API | `apps/kimi-web/src/api/daemon/client.ts` | 新增 `listBranches(sessionId)` / `switchBranch(sessionId, branch)` |
| UI | `apps/kimi-web/src/components/chat/ChatHeader.vue` | 分支下拉选择器（Teleport to body 布局） |
| UI | `apps/kimi-web/src/components/chat/ConversationPane.vue` | `@git-refresh` 事件绑定 |

---

### fix: 服务端导入修复 (`2bb74ebe`)

- `packages/agent-core-v2/src/index.ts` — 添加 `export { IGitService }`（kap-server 依赖）
- `packages/kap-server/src/routes/sessions.ts` — 添加 `import { exec } from 'node:child_process'` 和 `pathResolve`（exec handler 运行时依赖），改进 catch 块错误日志

---

### fix: 浏览器兼容性 (`67b4c734`)

- `apps/kimi-web/src/components/settings/SettingsDialog.vue` — `Array.toSorted()` → `Array.sort()`（ES2023 方法旧浏览器不支持）

---

### docs: 包级 CHANGELOG 更新 (`e0a66769`)

- `apps/kimi-web/CHANGELOG.md` — 记录三大功能
- `packages/agent-core-v2/CHANGELOG.md` — 记录 sessionFs write + IGitService 扩展
- `packages/kap-server/CHANGELOG.md` — 记录 fs:write + :exec + :git-branches + :git-checkout

---

### fix: 技能列表自动加载 + 分支下拉层级修复 (`16854366`)

- SettingsDialog 切换到 Skills tab 时自动加载已安装技能（之前仅安装后刷新）
- 分支下拉 `z-index` 从 `--z-dropdown`(200) 提升到 `--z-overlay`(300)

### fix: Teleport 分支下拉防裁剪 (`385033ab`)

分支下拉菜单改用 Vue `<Teleport to="body">` 渲染，绕过父容器 `overflow` 和层叠上下文限制。

### fix: 下拉宽度修正 (`c0f058d1`)

Teleport 后显式设置 `width`，防止下拉菜单宽度塌陷成细条。

### fix: 分支加载时机 (`882c05a8`)

新增 `watch(sessionId)` 确保 session 就绪后自动加载分支列表，新增空状态提示和 `min-height` 防塌陷。

### fix: 调试日志 (`01eb8f99`)

`loadBranches` 失败时输出 `console.warn` 便于排查。

---

## 2026-07-30 (续)

### feat: 分支切换后自动打开变更面板

ChatHeader 分支切换成功后自动 emit `openChanges`，不再需要手动点击。

| 层级 | 文件 | 改动 |
|---|---|---|
| UI | `apps/kimi-web/src/components/chat/ChatHeader.vue` | `switchToBranch` 成功后 emit `openChanges` |

### feat: 绕过认证模式隐藏登录门

Web UI 检测 `dangerousBypassAuth` 状态，绕过模式下自动隐藏登录页面，开发调试无需每次登录。

| 层级 | 文件 | 改动 |
|---|---|---|
| UI | `apps/kimi-web/src/composables/useAuthGate.ts` | `showAuthGate` 新增 `!client.dangerousBypassAuth` 条件 |
| Config | `apps/kimi-code/package.json` | dev 命令增加 `--dangerous-bypass-auth` + `--log-level info` |

### fix: toSorted → sort 浏览器兼容

延续此前兼容性修复，替换其余 5 处 `Array.toSorted()` 调用。

| 层级 | 文件 | 改动 |
|---|---|---|
| Web | `apps/kimi-web/src/composables/swarmGroups.ts` | 2 处 `toSorted()` → `[...members].sort()` |
| Web | `apps/kimi-web/src/lib/workspaceOrder.ts` | 3 处 `toSorted()` → `[...items].sort()` |

### i18n: 新增通用按钮文案

| 层级 | 文件 | 改动 |
|---|---|---|
| i18n | `apps/kimi-web/src/i18n/locales/en/common.ts` | 新增 `save/edit/delete/add` |
| i18n | `apps/kimi-web/src/i18n/locales/zh/common.ts` | 新增 `保存/编辑/删除/添加` |
