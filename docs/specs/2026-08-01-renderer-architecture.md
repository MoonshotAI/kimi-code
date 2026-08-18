# Renderer 架构与组件化规范

Date: 2026-08-01
Status: Active（自 P1 合并起强制；review 对照本文档执行）

本文档是 renderer 架构的**长期规范**：目标架构、代码归属、平台分叉规则、组件化标准与 store 规范。
执行排期（阶段划分、每阶段范围）见 `docs/plans/2026-08-01-renderer-architecture-refactor.md`（下称"总计划"），本文档不重复排期，只规定"做完长什么样、过程中守什么纪律"。

## 1. 目标架构

### 1.1 静态分层

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 应用层（只保留 app 专属）                                                    │
│                                                                            │
│  apps/web                            apps/desktop                          │
│  ├─ main.ts（i18n / Pinia / 注入接线）  ├─ main/    Electron 主进程（不动） │
│  ├─ App.vue + components/               ├─ preload  window.kimiDesktop     │
│  │   chat/ settings/ dialogs/ mobile/   ├─ renderer main.ts（同上接线）     │
│  ├─ debug/trace（Tracer 实现）           ├─ renderer App.vue + components/ │
│  ├─ style.css（design tokens）           │  └─ desktop 专属：               │
│  └─ vite.config（iconsDir 指向包内）      │     useNativeTerminal ·         │
│                                         │     useShortcuts + keymap ·      │
│                                         │     lib/track(IPC) · vibrancy ·  │
│                                         │     tray / jump-list 联动        │
└──────────────────────┬─────────────────────────────────┬───────────────────┘
                       │      注入（见 §2.2）              │
                       ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ @moonshot-ai/app-client —— Vue 状态层                                       │
│                                                                            │
│  stores/   Pinia setup stores（共享状态唯一正本；写路径只走 action）         │
│            connection · sessions · prompt · approvals · files · workspace │
│            · models · notifications                                       │
│  composables/  UI 逻辑（无持久状态，可多实例）                               │
│  icons/    icons.ts 注册表 + icons/kimi/*.svg（两端 vite iconsDir 同指此）   │
│  contracts.ts  ProductTracker / TerminalHooks / SessionIntent（默认 no-op）│
└──────────────────────────────────────┬─────────────────────────────────────┘
                                       │ depends on
                                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ @moonshot-ai/app-core —— 纯逻辑 + 传输（无 DOM 依赖）                        │
│                                                                            │
│  api/       DaemonKimiWebApi = REST(http) + WS(ws) + wire/mappers          │
│             + frameClassifier + agentEventProjector（t 注入）+ eventReducer │
│             + createKimiWebApi(deps) 组合工厂                              │
│  client/    createKimiWebClientCore（状态机）· eventBatcher ·              │
│             applyRecordDiff · turnsProjector · messagesToTurns ·          │
│             swarmGroups · latestTodos · auxiliaryTranscriptToTurns ·      │
│             渲染类型（ChatTurn / TurnBlock）                                │
│  lib/       纯函数：parseDiff · toolMeta · storage · desktopFlag · log · … │
│  contracts/ Tracer · CredentialStore · ClientIdentity                      │
└──────────────────────────────────────┬─────────────────────────────────────┘
                                       │ REST + WebSocket /api/v1
                                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ kimi-code（submodule）：kap-server · agent-core-v2 · sdk                   │
└────────────────────────────────────────────────────────────────────────────┘

既有旁路（不动）：app-ui（primitives，IconResolverKey 桥到 app-client/icons）
                 app-i18n（locales + KimiI18nKey）· app-markdown · vite-preset
```

### 1.2 运行时数据流

读路径：

```
kap-server
  │ WS raw frames
  ▼
DaemonEventSocket（app-core/api：握手 / 心跳 / 重连 / 订阅 LRU / seq+epoch 光标）
  │ frameClassifier 分流
  ├─ protocol 帧 → mappers.toAppEvent ─────────┐
  └─ agent 帧   → agentEventProjector（t 注入）─┤ AppEvent[]
                                                ▼
                            eventBatcher（合并连续 delta，控制事件做排序屏障）
                                                ▼
                 reduceAppEvent（纯函数）→ applyRecordDiff 逐 key 写回
                                                ▼
      useConnectionStore（socket 生命周期 / resync / 快照同步 / 订阅 LRU）
      useSessionsStore · usePromptStore · useApprovalsStore · …（按域切片）
                                                ▼
      turnsProjector + messagesToTurns（增量缓存投影 → ChatTurn[]，store getter）
                                                ▼
      组件（store 直取；props 仅私有输入；无多层透传链）
```

写路径：`组件事件 → store action → DaemonKimiWebApi（REST 30s 超时 / WS）→ kap-server`。

## 2. 代码归属

### 2.1 归属矩阵

| 代码 | 去向 |
|---|---|
| `lib/*` 纯函数（含 `storage`、`desktopFlag`、`log`） | `packages/app-core/src/lib` |
| 渲染类型（ChatTurn/TurnBlock 等） | `packages/app-core/src/client` |
| `eventBatcher` / `turnsProjector` / `applyRecordDiff` / `messagesToTurns` / `latestTodos` / `swarmGroups` / `auxiliaryTranscriptToTurns` | `packages/app-core/src/client` |
| `agentEventProjector` | `packages/app-core/src/api/daemon`（`t` 注入解耦 i18n） |
| api 壳 | 纯部分（纯 URL builder、`errors`、`types` re-export、wire/mappers）下沉 `packages/app-core/src/api`；`bootstrap` 为 `createKimiWebApi(deps)` 工厂，tracer / credentialStore / identity / mainAgentOnly 全注入。**runtime config 留两端 `src/api/` 接线层**：读 `window` / `import.meta.env` / sessionStorage / 各端 identity 常量的代码不进 app-core |
| UI 层 composables（`useFilePreview`、`useSlashMenu`、`useMentionMenu`、`useComposerDraft` 等） | `packages/app-client/src/composables` |
| 状态层（`useKimiWebClient`、`useWorkspaceState`、`client/*`） | `packages/app-client/src/client`（迁移期原样，拆解后逐步清空） |
| Pinia domain stores | `packages/app-client/src/stores` |
| `icons.ts` + `icons/kimi/*.svg` | `packages/app-client/src/icons`；两端 vite `iconsDir` 指向包内路径 |
| desktop 专属（`useNativeTerminal`、`useShortcuts`、`lib/keymap`、`lib/track`、`lib/session-intent` 等桥依赖代码） | 留 `apps/desktop/src/renderer` |
| `ProductTracker` 埋点契约 | `packages/app-client` 定义接口 + no-op 默认；desktop 注入 `lib/track`（IPC）实现，web 注入 no-op |

### 2.2 注入缝（apps → packages，平台差异的唯一通道）

| 注入物 | apps/web | apps/desktop | 注入点 |
|---|---|---|---|
| Tracer | `debug/trace` | `debug/trace`（主进程 renderer-log 脱敏落盘） | `createKimiWebApi` |
| CredentialStore | `lib/serverAuth` | 同左 | `createKimiWebApi` |
| identity（clientName/uiMode） | `kimi-code-web` / `web` | `DESKTOP_PRODUCT_NAME` / `DESKTOP_UI_MODE` | `createKimiWebApi` |
| mainAgentOnly | `false` | `true` | `createKimiWebApi` |
| t（翻译） | `i18n.global.t` | 同左 | projector / client-core 工厂 |
| ProductTracker | no-op | `lib/track`（IPC → 主进程遥测） | app-client 接线 |
| TerminalHooks | no-op | `useNativeTerminal().destroySession` | stores 接线 |
| SessionIntent | 无 | `lib/session-intent` | sessions store 接线 |

## 3. 平台分叉规则

替代"整目录 re-copy 保留分叉块"的旧工作流：

1. **注入优先**：telemetry、terminal teardown、tracer、credentialStore 一律经构造参数/工厂注入，web 端 no-op。
2. **包内分支**：平台分支仅限 UI 行为差异（如 `usePageTitle` 转圈动画），统一走 `lib/desktopFlag.ts` 的 `isDesktop`，分支集中在共享实现内部，不再整文件分叉。
3. **品牌/持久化协议**：日志前缀统一 `[kimi-code]`、`workspaceName` 兜底统一 `kimi-code`；**`kimi-web.*` localStorage key 与 `kimiWeb.optimisticUserMessage` metadata key 保持不变**（持久化协议，禁止清理）。

## 4. 组件化标准

### 4.1 逻辑归属

- 纯函数进 `lib`（无 Vue 依赖）。
- 跨组件状态进 store。
- 组件只留视图状态（hover/focus/本地输入）。

### 4.2 通信

- **跨层共享一律 store 直取**，禁止经 props 多层透传。同一 prop 透传 ≥3 层，或 emit 纯转发 ≥3 个，即应下沉 store。
- **props/emit 仅用于父子私有输入**（如 `ChatPane` 的渲染输入 `turns`）。
- **provide/inject 必须用类型化 `InjectionKey<T>`**，禁裸字符串 key。现存待改造反例（均为裸字符串 key）：`pinScroll`（`ConversationPane.vue` / `SideChatPanel.vue` / `AgentDetailPanel.vue`）、`resolveImage`（两端 `App.vue` / `FilePreview.vue`）、`resolveAgentTaskId`（`ConversationPane.vue`）、`resolveSwarmMembers`（desktop `App.vue`）。既有合法用例：`KimiI18nKey`、`IconResolverKey` 这类类型化局部桥保留。

### 4.3 复用

- 变体用**注册表 + 共享壳**（tool-calls 的 `toolRegistry.ts` + `ToolDisclosure` 为范本）。
- mobile/desktop 优先**同组件 + 断点适配**，禁止整组件复制（`MobileSwitcherSheet` 复制 `SessionRow` 为反例）。

### 4.4 尺寸红线

`<script setup>` 超 ~300 行，或响应式声明超 ~50 个，进 review 重点，原则上拆分。

### 4.5 i18n 零容忍

任何用户可见字符串（含对话框、placeholder、回退文案）必须走 `t()`。`ServerAuthDialog.vue` 为现存反例（修复见总计划 P17）。

### 4.6 样式只用 token

沿用根 AGENTS.md 硬约束：颜色 / 字体 / 圆角 / 间距 / 阴影 / z-index / 动效一律取 `style.css` 的 CSS 变量，禁止手写 ad-hoc 值；UI 改动必须亮色 + 暗色验证。

## 5. Store 规范（Pinia）

P8 起生效。首个 store：`kimi.sessions`（`packages/app-client/src/stores/sessions.ts`）。

- **pinia 实例由包持有**：`stores/pinia.ts` 导出 `clientPinia`，两端 `main.ts` 以 `app.use(clientPinia)` 安装同一实例。包内模块级代码（client 单例在 import 时构造，先于任何 app 存在）经每个 store 的 `xxxStore()` accessor 解析（内部 `useXStore(clientPinia)` 显式传实例），**禁止依赖 `getActivePinia()` 时序**；组件内直接 `useXStore()`（走 inject，解析到同一实例）。
- **全部 setup store 形态**（`defineStore('kimi.<domain>', () => { ... })`，id 带 `kimi.` 前缀），不用 options store。
- **state 消费端只读，写路径只走 action**；写入纪律由模块边界强制，不靠注释。迁移期例外：facade `rawState` 的桥接 accessor（P8 的 `sessions` / `activeSessionId` 为 getter/setter；P11 的 `approvalsBySession` / `questionsBySession` 与 P12 的 `gitStatusBySession` 为 getter-only——整表替换在编译期即被拒绝）让存量读取点零改动——这是过渡形态，新代码必须直接使用 store，P9–P15 拆解时存量读取点逐步显式化。
- **禁用 `$patch` 整表替换**——沿用 `applyRecordDiff` 逐 key 写回纪律（`useTaskPoller.ts:74`（另 :133、:255）的整体替换为现存反例，拆解期修复）。
- **高频流式 delta 只经 eventBatcher 合批后落地**。devtools 无需特殊规避：setup store 的 state 变化本就不产生 devtools mutation 记录（无时间旅行回滚），action 调用日志量可接受。
- store 间依赖单向化（如 approvals → sessions 只允许一个方向），禁止环。
- **测试**：store 层直接 import accessor 测；facade 集成层 `vi.resetModules` 后动态 import facade 与 store（同一 fresh 模块图共享 fresh `clientPinia`）。参照 `packages/app-client/test/sessions-store.test.ts`。

## 6. 迁移期纪律（自 P1 合并起生效，直到 god object 拆解收尾）

- 共有文件的任何改动只改 `packages/` 正本；desktop↔web 双向同步工作流即刻停止。
- 新功能若需动共有代码，一律在 packages 里改；reviewer 拒绝任何让两端副本新增差异的 PR。
- 迁移 PR 的原则是**逻辑零变化，只动位置与 import**；行为对齐点（日志前缀、兜底名、标题、埋点有无等）必须逐条列在 PR 描述里。

## 7. 每个代码 PR 的验收模板

1. `pnpm test && pnpm typecheck && pnpm lint` 全绿。
2. 冒烟：`pnpm dev:desktop`（内嵌 server）发一条消息跑通工具调用与审批；`pnpm dev:web`（代理模式）发消息正常。涉及连接/事件层的 PR 加测 `KIMI_SERVER_URL` 外部 server 模式。
3. 涉及 UI/图标的 PR：亮+暗色、hover/focus 视觉验证；`pnpm --filter kimi-code-web check:style` 无新增 findings。
4. changeset 按 `.agents/skills/changeset` 规则（一律 `patch`，只写 `kimi-code-app`；纯文档/测试/无用户可见变化可免）。
