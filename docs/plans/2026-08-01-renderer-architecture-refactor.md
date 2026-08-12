# Renderer 架构治理总计划：共享收敛 → God Object 拆解 → Pinia → 组件化

> 交给执行者的实施计划。本文档自包含，不需要其他上下文。
> 调研结论（§1）均为 2026-08-01 实测，含文件清单与差异行数，执行时不必重查。
> **执行进度与实测偏差记录在文末「执行进度台账」——每个阶段开工前先读台账最新条目，完工后追加新条目。**
> 每个阶段 = 一个可独立合并、独立可运行的 PR；除明确列出的对齐点外，迁移 PR 的原则是 **逻辑零变化，只动位置与 import**。
> 仓库硬约束：Conventional Commits；每 PR 按 `.agents/skills/changeset` 规则（一律 `patch`、只写 `kimi-code-app`；纯文档/测试/无用户可见变化可免）；UI 变更必须亮+暗色视觉验证。

## 0. 决策记录（已拍板，2026-08-01）

| 决策点 | 结论 |
|---|---|
| Pinia 引入范围 | **全量引入**：app-client 内 domain stores 全部用 Pinia setup store 承载，`useKimiWebClient` facade 降级为兼容聚合层逐步废弃；`apps/web` 与 `apps/desktop` 同步引入 |
| 共享代码落点 | **两包分工**：纯逻辑进现有 `packages/app-core`；Vue composables / 状态层 / Pinia stores 进新建 `@moonshot-ai/app-client` |
| 组件化标准落地 | **规范文档 + 示范重构 PR**（1-2 个参照实现），后续 review 对照执行 |
| 执行顺序 | **先收敛副本，再拆解**——拆解只在唯一正本里做一次 |
| kimi-code 仓 `apps/kimi-web` 第三副本 | 本计划不动 submodule，冻结处理，处置建议见 §7 |

## 1. 背景：调研结论

### 1.1 双份副本现状（实测）

`apps/web/src` 与 `apps/desktop/src/renderer` 的共有文件（composables + lib + types + api 壳，~80 个）按差异性质分五类：

**A. 字节一致（8 个）**——直接可搬：

`composables/client/applyRecordDiff.ts`、`composables/client/turnsProjector.ts`、`composables/client/useSideChat.ts`、`composables/messagesToTurns.ts`、`composables/swarmGroups.ts`、`composables/useFollowScroll.ts`、`composables/useResizable.ts`、`composables/useTerminal.ts`

**B. 仅头注释差异（37 个）**——web 侧头注释仍是 `// apps/kimi-web/src/...`（更早期拷贝残留），desktop 侧是 `// apps/web/src/...`。lib 下绝大多数纯函数（`parseDiff`、`toolMeta`、`toolDiff`、`slashCommands`、`shellDanger`、`sessionRoute`、`serverAuth`、`snapshotMessages`、`mergeWorkspaces`、`swarmCardRows`、`searchHighlight`、`readOutput`、`planUsage`、`pathBasename`、`pathRelativeTo`、`parseSwarmResult`、`openFileAttachment`、`cronHumanize`、`codeLanguage`、`clipboard`、`workspaceOrder`、`activitySummary` 等）+ `types.ts` + `api/devBackend.ts`。

**C. 纯格式化差异（3 个）**——web 侧未经 oxfmt 重排，内容等价：`useDetailPanel.ts`、`useAuxiliaryTranscripts.ts`、`lib/auxiliaryTranscriptToTurns.ts`。

**D. Additive（desktop = web + 增量，可取并集）**：

| 文件 | 差异行数 | desktop 多出什么 |
|---|---|---|
| `lib/storage.ts` | 15 | 3 个 storage key（shortcutOverrides / dockIconChoice / openInDefaultTarget 改名） |
| `lib/desktopFlag.ts` | 8 | `isWindowsDesktop` |
| `lib/icons.ts` | 47 | 3 个图标条目（eye / eye-off / keyboard，仅 keyboard 有本地 SVG） |
| `composables/client/useNotification.ts` | 19 | `track()` 通知埋点 |
| `composables/useAttachmentUpload.ts` | 42 | `track()` + via 参数 |
| `composables/useOAuthLoginFlow.ts` | 65 | `track()` oauth 阶段埋点 |
| `composables/useUpdateStatus.ts` | 31 | `track()` + source 参数 |
| `api/bootstrap.ts` | 1 | `mainAgentOnly: true`（`DaemonKimiWebApi` 既有选项，app-core `ws.ts:101`） |

**E. 实质分叉（需逐点对齐）**：

| 文件 | 差异行数 | 分叉内容 |
|---|---|---|
| `composables/usePageTitle.ts` | 62 | web：运行中标题加转圈动画、标题 `Kimi Code Web`；desktop：静态 `Kimi Code`（转圈会漏进 macOS Dock 菜单，native-todos.md 记录为有意分叉） |
| `api/config.ts` | ~10 | identity 常量：web 硬编码 `kimi-code-web`/`web`；desktop 用 `shared/identity.ts` |
| `composables/client/useModelProviderState.ts` | 184 | desktop 为超集（getProvider/AddProviderInput/loadConfig+checkAuth 依赖）；**错误处理路径不同**：web `pushOperationFailure` toast，desktop 返回错误字符串给表单 inline banner |
| `composables/client/useWorkspaceState.ts` | 111 | desktop = web + `track()` + `session-intent` + `skipTrack` 参数 + 日志前缀 `[kimi-code]` vs `[kimi-web]` |
| `composables/useKimiWebClient.ts` | 89 | desktop = web + `track()`（connection_lost/restored）+ native terminal teardown（session/workspace 删除时 `useNativeTerminal().destroySession`）+ `workspaceName` 兜底 `kimi-code` vs `kimi-web` |

**desktop-only（16 个，留在 desktop，不进共享包）**：`useNativeTerminal`、`useShortcuts`、`useFullscreen`、`useVibrancy`、`useTrayAttention`、`useJumpList`、`lib/keymap`、`lib/nativeOpenIn`、`lib/nativeWorkspacePicker`、`lib/track`、`lib/session-intent`、`lib/approvalTelemetry`、`lib/dockIconChoice`、`lib/loginSource`、`lib/windowsMenuAccess`、`lib/providerForm`（待核，P4 时确认 web 侧对应逻辑位置）。

**web-only**：仅测试文件（`activitySummary.test.ts`、`shellDanger.test.ts`、`transcriptSelectAll.test.ts`、`useResizable.test.ts`）与 `InternalBuildBanner.vue`。

**第三份副本（冻结）**：`kimi-code/` 子模块内 `apps/kimi-web` 是同源更早版本，已明显漂移（`agentEventProjector` 1582 行 vs 本仓 1482、`messagesToTurns` 945 vs 1124）。不在本 workspace（pnpm-workspace.yaml 注释明确排除），本计划不动，见 §7。

### 1.2 God object 现状

- `composables/useKimiWebClient.ts`：3577 行，模块级单例，**return 对象 188 个 key**（`:3349-3573`），`ExtendedState` 60+ 字段（`:316-424`）。职责横跨 localStorage 持久化、事件接入/合批/副作用、重连 baseline、快照同步、WS 订阅 LRU、view-model 转换（`buildApprovalBlock` 122 行）、~750 行 computed view props、workspace 排序分组、通知回调。
- `composables/client/useWorkspaceState.ts`：**单函数 2989 行**（`:294-3282`），return ~90 个 action，deps 接口 70+ 字段（`:223-292`）。名为 "State" 实为应用层全部写操作。
- 写入纪律靠注释维持（`:234-235`），已被 `useTaskPoller.ts:34-38` 打破（整体替换 `tasksBySession`，与 `applyRecordDiff` 纪律自相矛盾）。
- 两端 `main.ts` 已 `provide(KimiWebClientFacadeKey, useKimiWebClient())`（`apps/web/src/main.ts:33`、`apps/desktop/src/renderer/main.ts:34`）但**全仓无任何 inject**——死供给。

### 1.3 props drilling 现状

- `App.vue` → `ConversationPane`：**47 props + ~40 emits**（`App.vue:1421-1507`）；`ConversationPane` → `ChatDock` ~35+25；`ChatDock` → `Composer` 38 个绑定；`ConversationPane` 又直连 `Composer` 一份。
- `models` / `starredIds` / `managedMembership` / `searchFiles` 等约 20 个 prop 在 4 层 `defineProps` 重复声明；`ConversationPane` 模板 28 处 `@x="emit('x', $event)"` 纯转发。
- 两种风格混用：同一透传链上，`SettingsDialog` / `UserMenu` / `ProvidersPanel` / `ProviderForm` / `AddProviderFlow` / `MobileSettingsSheet` 6 个组件直接调 `useKimiWebClient()` 单例，`useNativeTerminal()` 被 7 处直抓。
- `App.vue` 模板手动 `client.xxx.value` 解包 144 次。

### 1.4 有利条件（已存在的基础）

- `packages/app-core` 已承载 api/reducer/ws/http/mappers 与 `client/createKimiWebClientCore.ts`（per-call reactive、非单例、`t` 注入先例、`install/dispose` 生命周期钩子）；`KimiWebClientFacadeKey.ts` 也在 app-core。peer vue，exports→src 免构建。
- 测试基础：`apps/web/test/` 8 个（event-batcher / event-reducer / agent-event-projector / workspace-state / task-poller / ws-lifecycle / side-chat / daemon-client），`packages/app-core/test/` 13 个，`apps/desktop/tests/renderer/` 若干。根 `vitest.config.ts` 以 projects 覆盖 `apps/*` 与 `packages/*`，测试随迁后 `pnpm test` 自然跑到。注意 `apps/web/test/event-reducer.test.ts` 与 `app-core/test/eventReducer.test.ts` 疑似重复，P3 时去重。
- 两端 `main.ts` 结构一致（i18n / KimiI18nKey / IconResolverKey / facade provide），desktop 仅多 vibrancy 初始化。
- 图标集合已参数化：两端 vite 配置都用 `kimiRendererViteConfig({ iconsDir })`（vite-preset），仅 `iconsDir` 指向各自目录。
- 组件复用抽象已正确：tool-calls 注册表（`toolRegistry.ts:24`）+ `ToolDisclosure` 共享壳；`ChatPane` 三处复用。
- i18n 词条集中在 `packages/app-i18n/src/locales`，双端共享。

## 2. 目标 / 非目标

**目标**

1. 消灭双份源码：共有代码在 `packages/` 有唯一正本，`apps/web` 与 `apps/desktop/src/renderer` 只保留 app 专属代码。
2. 拆解 god object：`useWorkspaceState` / `useKimiWebClient` 按域拆成 Pinia stores；`rawState` 写入从注释纪律变成模块边界（store 外只读）。
3. 消灭 props drilling：跨层共享状态一律 store 直取；透传只保留组件私有输入。
4. 组件化标准成文（`docs/specs/`）并以 1-2 个示范 PR 落地。

**非目标**

- kimi-code 仓 `apps/kimi-web` 第三副本的收敛（仅给建议，§7）。
- chat 组件下沉 `packages/app-ui`（组件共享是下一步独立计划；本计划只动 ts 层与必要的组件 import 适配）。
- 主进程安全加固（CSP / openExternal 白名单 / 死 channel 清理）——独立小 PR，见附录 A，可与本计划穿插。
- 任何功能新增与视觉变更（§5 明确列出的行为对齐点除外）。

## 3. 目标架构与代码归属矩阵

### 3.1 静态分层（全部阶段完成后的代码归属）

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
                       │      注入（见表 3.3）              │
                       ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ @moonshot-ai/app-client —— Vue 状态层（新建包）                              │
│                                                                            │
│  stores/   Pinia setup stores（共享状态唯一正本；写路径只走 action）         │
│            connection · sessions · prompt · approvals · files · workspace │
│            · models · notifications                                       │
│  composables/  UI 逻辑（无持久状态，可多实例）                               │
│            useFilePreview · useSlashMenu · useMentionMenu ·               │
│            useComposerDraft · useInputHistory · useSidebarLayout ·        │
│            useConfirmDialog · useTerminal · useFollowScroll ·             │
│            usePageTitle · useOAuthLoginFlow · useAttachmentUpload · …     │
│  icons/    icons.ts 注册表 + icons/kimi/*.svg（两端 vite iconsDir 同指此）   │
│  contracts.ts  ProductTracker / TerminalHooks / SessionIntent（默认 no-op）│
└──────────────────────────────────────┬─────────────────────────────────────┘
                                       │ depends on
                                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ @moonshot-ai/app-core —— 纯逻辑 + 传输（既有包扩展；无 DOM 依赖）            │
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
│ kimi-code（submodule，本计划不动）：kap-server · agent-core-v2 · sdk        │
└────────────────────────────────────────────────────────────────────────────┘

既有旁路（不动）：app-ui（primitives，IconResolverKey 桥到 app-client/icons）
                 app-i18n（locales + KimiI18nKey）· app-markdown · vite-preset
```

### 3.2 运行时数据流（server → 屏幕 → server）

```
读路径

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
        组件（store 直取；props 仅私有输入；无 4 层透传链）
                                                  ▼
                                                 屏幕

写路径

  组件事件 → store action → DaemonKimiWebApi（REST 30s 超时 / WS）→ kap-server

  约束：禁 $patch 整表替换（沿用 applyRecordDiff 逐 key 写回纪律）；
       高频流式 delta 只经 eventBatcher 合批后落地；devtools 不开时间旅行。
```

### 3.3 注入缝（apps → packages，平台差异的唯一通道）

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

### 3.4 组件通信标准（最终态）

- **共享状态**：任何层级组件 `useXxxStore()` 直取，禁止经 props 多层透传。
- **props/emit**：仅父子私有输入（如 `ChatPane` 的渲染输入 `turns`）；同一 prop 透传 ≥3 层或 emit 纯转发 ≥3 个即下沉 store。
- **provide/inject**：仅类型化 `InjectionKey<T>` 的局部桥（`pinScroll`、`resolveImage`、`KimiI18nKey`、`IconResolverKey`），禁裸字符串 key。

### 3.5 归属矩阵

| 代码 | 去向 |
|---|---|
| `lib/*` 纯函数（含 `storage`、`desktopFlag`、`log`） | `packages/app-core/src/lib`（exports `./lib` 已存在） |
| 渲染类型 `types.ts`（ChatTurn/TurnBlock 等） | `packages/app-core/src/client` |
| `eventBatcher` / `turnsProjector` / `applyRecordDiff` / `messagesToTurns` / `latestTodos` / `swarmGroups` / `auxiliaryTranscriptToTurns` | `packages/app-core/src/client` |
| `agentEventProjector` | `packages/app-core/src/api/daemon`（`t` 注入解耦 i18n） |
| api 壳（`bootstrap`/`config`/`devBackend`/`errors`/`index`/`types` re-export） | `packages/app-core/src/api`；bootstrap 改 `createKimiWebApi(deps)` 工厂，tracer / credentialStore / identity / mainAgentOnly 全注入 |
| UI 层 composables（`useFilePreview`、`useSlashMenu`、`useMentionMenu`、`useComposerDraft` 等） | `packages/app-client/src/composables` |
| 状态层（`useKimiWebClient`、`useWorkspaceState`、`client/*`） | `packages/app-client/src/client`（迁移期原样） |
| Pinia domain stores | `packages/app-client/src/stores` |
| `icons.ts` + `icons/kimi/*.svg` | `packages/app-client/src/icons`；两端 vite `iconsDir` 指向包内路径 |
| desktop 专属（§1.1 清单） | 留 `apps/desktop/src/renderer` |
| `ProductTracker` 埋点契约 | `packages/app-client` 定义接口 + no-op 默认；desktop 注入 `lib/track`（IPC）实现，web 注入 no-op |

**平台分叉规则**（替代"整目录 re-copy 保留分叉块"）：

1. **注入优先**：telemetry、terminal teardown、tracer、credentialStore 一律经构造参数/工厂注入，web 端 no-op。
2. 平台分支仅限 UI 行为差异（如 `usePageTitle` 转圈动画），统一走 `lib/desktopFlag.ts` 的 `isDesktop`，分支集中在共享实现内部，不再整文件分叉。
3. 品牌/持久化协议：日志前缀统一 `[kimi-code]`、`workspaceName` 兜底统一 `kimi-code`（web 跟随 desktop 已完成的品牌清理）；**`kimi-web.*` localStorage key 与 `kimiWeb.optimisticUserMessage` metadata key 保持不变**（持久化协议，native-todos.md 明确禁止清理）。

**迁移期纪律（自 P1 合并起生效，直到 P13 收尾）**：

- 共有文件的任何改动只改 `packages/` 正本；desktop↔web 双向同步工作流即刻停止。
- 新功能若需动共有代码，一律在 packages 里改；不得让两端副本新增差异（P1 后副本逐步消失，自然强制）。
- 迁移 PR 逻辑零变化；行为对齐点单独列在 PR 描述里。

**每个代码 PR 的验收模板**：

1. `pnpm test && pnpm typecheck && pnpm lint` 全绿。
2. 冒烟：`pnpm dev:desktop`（内嵌 server）发一条消息跑通工具调用与审批；`pnpm dev:web`（代理模式）发消息正常。涉及连接/事件层的 PR 加测 `KIMI_SERVER_URL` 外部 server 模式。
3. 涉及 UI/图标的 PR：亮+暗色、hover/focus 视觉验证；`pnpm --filter kimi-code-web check:style` 无新增 findings。
4. changeset 按 skill 规则。

## 4. 阶段总览

| PR | 阶段 | 规模 | 依赖 |
|---|---|---|---|
| P0 | 架构与组件化规范文档 | 小 | — |
| P1 | lib 纯函数下沉 app-core | 中 | P0 |
| P2 | 渲染类型 + 热路径纯模块下沉 | 中 | P1 |
| P3 | agentEventProjector 下沉（i18n 解耦）+ api 壳合并 | 中 | P1 |
| P4 | 新建 `@moonshot-ai/app-client` + ProductTracker 契约 + 无分叉 composables 迁移 | 中 | P2 |
| P5 | icons 资产与注册表统一 | 小 | P4 |
| P6 | telemetry/平台分叉 composables 迁移 | 中 | P4 |
| P7a | client 状态模块迁移（task-poller/side-chat/aux/model-provider） | 中 | P6 |
| P7b | **两大单例迁移，副本正式消灭** | 大 | P7a |
| P8 | Pinia 引入 + 首个 domain store + store 规范 | 中 | P7b |
| P9–P15 | 按域拆 god object（每域一个 PR） | 各中 | P8 |
| P16–P17 | 组件层示范改造（drilling 消除 / 滚动机器抽离） | 各中 | P9 起可穿插 |
| P18 | 收尾：约定核对（AGENTS.md / native-todos.md） | 小 | 全部 |

## 5. 阶段明细

### P0 — 架构与组件化规范文档

新增 `docs/specs/2026-08-01-renderer-architecture.md`，内容：

- 目标架构图 + §3 归属矩阵 + 平台分叉规则 + 迁移期纪律。
- **组件化标准**（后续 review 对照执行）：
  - 逻辑归属：纯函数进 `lib`（无 Vue 依赖）；跨组件状态进 store；组件只留视图状态（hover/focus/本地输入）。
  - 通信：跨层共享一律 store；`provide/inject` 必须用 `InjectionKey<T>`（禁裸字符串 key，现存 `pinScroll`/`resolveImage`/`resolveAgentTaskId`/`resolveSwarmMembers` 四处为待改造反例）；props 只用于父子私有输入；同一 prop 透传 ≥3 层或 emit 纯转发 ≥3 个即应下沉 store。
  - 复用：变体用注册表 + 共享壳（tool-calls 为范本）；mobile/desktop 优先同组件 + 断点适配，禁止整组件复制（`MobileSwitcherSheet` 复制 `SessionRow` 为反例）。
  - 尺寸红线：`<script setup>` 超 ~300 行或响应式声明超 ~50 个，进 review 重点，原则上拆分。
  - i18n 零容忍：任何用户可见字符串（含对话框、placeholder、回退文案）必须走 `t()`；`ServerAuthDialog.vue` 为反例（P17 修）。
  - 样式只用 token（沿用既有硬约束）。
- **store 规范**（Pinia）：全部 setup store 形态；state 不直接导出可变引用，消费端只读；写路径只走 action，**禁用 `$patch` 整表替换**（沿用 `applyRecordDiff` 逐 key 写回纪律）；高频 delta 路径（eventBatcher → reducer → 写回）不进 devtools 时间旅行，store 创建时 `devtools: false` 或按 action 粒度规避。
- 无 changeset（纯文档）。

### P1 — lib 纯函数下沉 app-core

- 范围：`lib/` 下 B 类（仅头注释）+ A 类纯函数 + `storage.ts` / `desktopFlag.ts` / `log.ts`（D 类并集）+ 随附测试（`searchHighlight.test`、`formatTokens.test`、`modelThinking.test`、`icons.test` 除外——icons 在 P5）。`nativeWorkspaceDrop.ts` 先核实是否触碰 `window.kimiDesktop`：无桥依赖则同批下沉，有则归 P6。
- 步骤：文件移入 `packages/app-core/src/lib/`（`git mv` 保留历史）→ `lib/index.ts` 补导出 → 两端 import 批量改 `@moonshot-ai/app-core/lib` → 删双份 → 头注释统一改为新路径。
- `storage.ts` 取并集时保留全部 `kimi-web.*` key 名不变。
- `log.ts` 前缀统一 `[kimi-code]`（行为对齐点，写入 PR 描述）。
- 验收：标准模板。

### P2 — 渲染类型 + 热路径纯模块下沉

- 范围：`src/types.ts`（仅头注释差异）→ `packages/app-core/src/client/types.ts`；`composables/client/{eventBatcher,turnsProjector,applyRecordDiff}.ts`、`composables/{messagesToTurns,latestTodos,swarmGroups}.ts`、`lib/auxiliaryTranscriptToTurns.ts` → `packages/app-core/src/client/`。
- `messagesToTurns` 等对 `../types` 与 `../lib/*` 的 import 改为包内相对路径（P1 已就位）。
- 测试随迁：`apps/web/test/event-batcher.test.ts` → `packages/app-core/test/`。
- `applyRecordDiff.ts` 头注释的 "Pure logic (no Vue)" 声明保留。
- 验收：标准模板。

### P3 — agentEventProjector 下沉 + api 壳合并

- projector 的 4 处 `i18n.global.t`（`agentEventProjector.ts:28, 216, 1125, 1294`）改为构造注入 `t`（沿用 `CreateCoreDeps.t` 模式，`createKimiWebClientCore.ts:35` 为先例）；`createAgentProjector(deps)` 签名扩展，两端 bootstrap 传 `i18n.global.t`。注意：注入 `t` 只影响之后投影的新事件，**已写入 state 的投影文本不会随切语言重算**——"切语言后已投影文本不更新"的正经修法是存 translation key/params 渲染时翻译，或切语言时重投影相关事件；P3 不承诺修复，列为已知问题待后续阶段评估（避免执行者误以为已解决）。
- projector 移入 `packages/app-core/src/api/daemon/`；测试随迁（`agent-event-projector.test.ts`、`ws-lifecycle.test.ts`、`daemon-client.test.ts`），与 app-core 既有 `eventReducer.test.ts` 去重。
- api 壳合并：`bootstrap.ts` 改 `createKimiWebApi(deps: { tracer, credentialStore, identity, mainAgentOnly, t })` 工厂放 app-core；两端各自保留 ~20 行接线（tracer 来自 app 侧 `debug/trace`，identity 各自常量——web `kimi-code-web`/`web`、desktop `shared/identity`）。`mainAgentOnly` 保持各端自选（desktop `true`、web 不传），写入归属矩阵。
- 完成后两端 `src/api/` 仅剩 config/identity 接线和 re-export，或整目录删除。
- 验收：标准模板 + 外部 server 模式冒烟。

### P4 — 新建 `@moonshot-ai/app-client` + 无分叉 composables 迁移

- 包骨架：`packages/app-client/package.json`（`exports` → `./src/index.ts` 等子路径、peer `vue`、deps `@moonshot-ai/app-core` / `@moonshot-ai/app-i18n`）、`tsconfig.json`、纳入根 `vitest.config.ts` 的 packages include 列表与 `pnpm-workspace.yaml`（`packages/*` 已覆盖，无需改）。**两端 `package.json` 必须声明 `@moonshot-ai/app-client` workspace 依赖**（pnpm 包隔离，不声明则 app 内 import 不可解析）；P8 的 `pinia` 同理（apps 直接 `import { createPinia }` 就要声明，或经 app-client re-export）。
- **约束条目随阶段更新**：本 PR 同步更新根 `AGENTS.md`「目录地图」与 apps/web 依赖约束（放行 `@moonshot-ai/app-client`），不等 P18。
- **注入缝先行**：迁移列表中直接 import app 侧 api 单例（`getKimiWebApi`）或 `vue-i18n` 的文件（如 `useTerminal`、`useFilePreview`）不是纯移动——先按 §3.3 落 api/t 构造注入，再迁；迁入前逐文件核实运行时依赖。
- 定义 `ProductTracker` 契约（`src/contracts.ts`：`track(event, payload)` + no-op 默认实现），先不接线。
- 迁移 A/B/C 类 composables（逻辑零变化）：`useIsMobile`、`useViewportWidth`、`useFollowScroll`、`useResizable`（web 侧测试随迁）、`useTerminal`、`useConfirmDialog`、`useComposerDraft`、`useComposerAutoFocus`、`useInputHistory`、`useSlashMenu`、`useMentionMenu`、`useSidebarLayout`、`useFilePreview`、`useDetailPanel`。
- `usePageTitle` 合并：标题字符串参数化（默认 `Kimi Code`，web 传 `Kimi Code Web`），转圈动画按 `isDesktop` 分支关闭（行为对齐点：两端标题逻辑单源）。
- 验收：标准模板。

### P5 — icons 资产与注册表统一

- `apps/desktop/src/renderer/icons/kimi/*.svg` 与 `apps/web/src/icons/kimi/*.svg` 合并（desktop 多 `keyboard.svg`）移入 `packages/app-client/src/icons/kimi/`。
- 两端 vite 配置 `iconsDir` 改指包内路径（注意：`import.meta.resolve('@moonshot-ai/app-client/package.json')` 对带 exports map 的包会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`——app-client 需显式 export `./package.json`，或改用 `createRequire` / workspace 相对 URL，执行时确定写法）。
- `lib/icons.ts` 取并集（含 desktop 的 eye/eye-off/keyboard）下沉 `packages/app-client/src/icons/`；`icons.test.ts` 随迁。
- 验收：标准模板 + **全量图标视觉验证**（DesignSystemView §02 图标目录页逐排核对）。

### P6 — telemetry / 平台分叉 composables 迁移

- `ProductTracker` 接线：desktop 在 `main.ts`/bootstrap 注入 `lib/track` 适配器；web 注入 no-op（行为对齐点：web 不产生这些埋点，与现状一致）。
- 迁移（D 类取 desktop 版、track 改走 `ProductTracker`）：`useNotification`、`useAttachmentUpload`、`useOAuthLoginFlow`、`useUpdateStatus`。
- `useAuxiliaryTranscripts`（C 类格式化差异）同批迁移。
- `nativeWorkspaceDrop.ts` 若 P1 核实有桥依赖，在此批迁移（桥探测+无桥降级注入）。
- 验收：标准模板 + desktop 侧埋点冒烟（notification_shown / attachment_added / oauth_login_step 各触发一次，主进程日志可见）。

### P7a — client 状态模块迁移

- 迁移：`useTaskPoller`、`useSideChat`、`useAuxiliaryTranscripts`（若 P6 未做）、`useModelProviderState`。
- `useModelProviderState` 错误处理对齐（**需产品确认**，见 §6 R4）：统一为 desktop 的 return-error-string 模式，web 侧 `AddProviderFlow` 等表单组件改为消费返回值显示 inline banner（组件在两端各自适配）。
- `useTaskPoller.ts:34` 的整体替换**本阶段不修**（逻辑零变化），列入 P9+ 拆解期修复清单。
- 验收：标准模板 + provider 增删改全流程冒烟（两端）。

### P7b — 两大单例迁移（副本消灭点）

- `useWorkspaceState.ts`、`useKimiWebClient.ts` 原样移入 `packages/app-client/src/client/`。
- native terminal teardown 改注入：`useKimiWebClient` 新增 deps `onSessionDestroyed(sessionId)` / `onWorkspaceDestroyed(workspaceId, root)`；desktop 在接线处注入 `useNativeTerminal` 实现，web no-op。
- `session-intent`（desktop-only lib）作为可选 deps 注入；`track` 改走 `ProductTracker`。
- 品牌字符串统一：`[kimi-code]` 日志前缀、`workspaceName` 兜底 `kimi-code`（行为对齐点）。
- 两端 `main.ts` 的 facade provide 改为从 `@moonshot-ai/app-client` 导入；`apps/web/src/composables/` 与 `apps/desktop/src/renderer/composables/` 至此只剩 desktop 专属文件。
- 建议 commit 拆分：① `git mv` + 包内接线（纯移动）② 两端 import 切换 ③ 注入点接线，便于 review。
- 验收：标准模板 + 会话全链路冒烟（新建/选择/归档/删除会话、工作区增删、prompt/审批/问题、断线重连，两端各一遍）。

### P8 — Pinia 引入 + 首个 domain store

- `packages/app-client` deps 加 `pinia`；两端 `main.ts` `app.use(createPinia())`。两端 `package.json` 声明 `pinia`（或经 app-client re-export `createPinia`，执行时定）；同步更新 `apps/web/AGENTS.md` 的 no-Pinia 约定与根 `AGENTS.md` 相关条目——约束实际变化随本阶段生效，不等 P18。
- 首个 store 建议 `useSessionsStore`（sessions 列表 + activeSessionId + select/archive/delete action）：自洽、消费方多（Sidebar/App/ConversationPane），能立刻开始消 drilling。
- facade 对应字段改为 store 委托（getter 转发），导出数开始下降；store 外不再暴露该切片可变引用——写入纪律开始由模块边界强制。
- store 规范随此 PR 落入规范文档 §store 章节（P0 已写初稿，此 PR 按实践校准）。
- 验收：标准模板 + Pinia devtools 人工核对 state 变化正确。

### P9–P15 — 按域拆 god object（每域一个 PR）

建议顺序（先易后难，每个 PR 只做一域）：

| PR | store | 从 facade / workspaceState 收编的内容 |
|---|---|---|
| P9 | `useNotificationsStore` | turn-end / question / approval 通知回调与去重 |
| P10 | `useModelsStore` | `useModelProviderState` 整体转 store |
| P11 | `useApprovalsStore` | approvals + questions + `buildApprovalBlock`（顺带合并 `messagesToTurns.ts:275` 与 `useKimiWebClient.ts:2144` 的双份实现） |
| P12 | `useFilesStore` | fileDiff / git status / diff 相关 |
| P13 | `useWorkspaceStore` | workspace 排序 / pin / 分组 |
| P14 | `usePromptStore` | prompt 提交 / queue / local turn 生命周期（`submitPromptInternal` 147 行拆小） |
| P15 | `useConnectionStore` | connect / reconnect / baseline / resync / 快照同步 / WS 订阅 LRU（风险最高，放最后；`connectEventsIfNeeded` 196 行拆小） |

拆解期顺手修复清单（随所属域的 PR 一并做，每个都在 PR 描述中声明）：

- `useTaskPoller.ts:34` 整体替换 → `applyRecordDiff` 逐 key 写回。
- `errorName`/`errorMessage` 重复函数（`useKimiWebClient.ts:1650-1664`）合并。
- `PersistSessionProfilePatch` 双定义（`useWorkspaceState.ts:213-221` vs `useModelProviderState.ts:54-62`）合并。
- facade 死 provide（`KimiWebClientFacadeKey`）在组件改造完成后删除。
- 过时头注释（自称 "the only place that imports both src/api/* and src/types.ts"）随迁移修正。

### P16 — 组件示范改造 A：Composer 链 drilling 消除

- `App.vue` → `ConversationPane` → `ChatDock` → `Composer` 链上属于共享状态的 ~20 个 prop（`models` / `starredIds` / `managedMembership` / `searchFiles` 等）改 store 直取；删除 28 处 `@x="emit('x')"` 纯转发；保留组件私有 props。
- `App.vue` 模板 144 处 `client.xxx.value` 手动解包顺手清理（script 内解构/计算化）。
- 作为"组件化标准"的参照实现，PR 描述里附前后对照。
- 验收：标准模板 + composer 全功能人工回归（附件/斜杠/提及/历史/草稿/发送门禁）。

### P17 — 组件示范改造 B：滚动机器抽离 + App.vue 瘦身

- `ConversationPane.vue:534-1690` 的 ~1150 行滚动/跟随/pin/TOC/session-settle 状态机抽为 `useConversationScroll`（与既有 `useFollowScroll` 合并或取代，执行时定边界）。
- `App.vue:996-1108` 的 slash 命令解释器下沉 `lib/slashCommands.ts`（纯函数化 + 单测）；9 个 dialog 可见性状态收一个 composable。
- `ServerAuthDialog.vue` 补 i18n（`app-i18n` locales 双端补词条）。
- 验收：标准模板 + 滚动行为专项回归（跟随/钉住/折叠/TOC 锚点/Esc-undo）。

### P18 — 收尾：约定核对

- 根 `AGENTS.md`：「开发顺序」「双仓工作流 - web 改动同步」「目录地图」核对补齐为 packages 正本模式；删"同步副本"描述（app-client 依赖放行与 Pinia 约定已分别在 P4 / P8 随阶段更新，本阶段只做一致性核对与补漏）。
- `apps/desktop/docs/native-todos.md`：重写为"平台分叉已收编为包内注入/分支，剩余 desktop 专属实现清单"。
- `apps/web/AGENTS.md`（如适用）：核对 P4/P8 已更新的条目无遗漏。
- 无 changeset（文档）。

## 6. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | 迁移期团队继续在两端副本上叠功能，造成新差异 | 迁移期纪律写进 P0 规范文档 + 根 AGENTS.md；P1 起 reviewer 拒绝任何双副本新增差异的 PR |
| R2 | P7b 三千行级文件搬迁 review 困难 | commit 按"纯移动 / import 切换 / 注入接线"拆分；`git mv` 保历史；冒烟清单加长 |
| R3 | web 跟随 desktop 版本后的行为微变（日志前缀、兜底名、标题、埋点有无） | 每个对齐点在对应 PR 描述逐条声明；§3 已统一决策 |
| R4 | `useModelProviderState` 错误处理分叉（toast vs inline banner）是产品决策 | P7a 开工前与产品确认；默认建议保留 desktop 的 inline banner（更新的设计），web 跟随 |
| R5 | 图标路径变更导致两端构建产物缺图标 | P5 全量图标视觉验证 + 两端 `build` 验证 |
| R6 | Pinia 高频 mutation 拖慢开发态（devtools 时间旅行） | store 规范禁时间旅行；`eventBatcher` 合批后的事件才进 store action |
| R7 | P15 连接域拆解引入重连/丢事件回归 | 放最后做；既有 `ws-lifecycle` / `daemon-client` 测试护网 + 外部 server 模式冒烟 |
| R8 | 双份 `buildApprovalBlock` 等"为避免循环依赖而复制"的代码，合并时引入新循环 | P11 时先画依赖图；store 间依赖单向化（approvals → sessions 只允许一个方向） |

## 7. kimi-code 仓 `apps/kimi-web` 处置建议（不在本计划执行范围）

kimi-code 仓的 `apps/kimi-web` 是第三份冻结副本，本计划不动 submodule。本计划完成（P7b）后，建议在 kimi-code 仓另立计划：其 `apps/kimi-web` 切换为消费 `@moonshot-ai/app-client` / `app-core`（需要 kimi-code 仓把这两个包纳入其 workspace 或发布渠道），或确认废弃删除。在此之前，kimi-code 仓对 `apps/kimi-web` 的任何修改与本仓无关、不回迁。

## 附录 A：可穿插的独立小 PR（不阻塞主线）

- **主进程安全三件套**：`app://` 响应与 dev HTML 加 CSP（`default-src 'self'` 起步，dev 单独放宽）；`kimi:open-external` 加 http(s) 白名单（复用 `external-links.ts` 的 `isHttpUrl`）；删死 channel `onMenu` / `kimi:menu`（`preload.ts:361-365`）。
- **内嵌 server loopback 鉴权评估**：`server.ts:86-88` `disableAuth: true` 的风险显式记录或加 loopback token（对齐外部 server 模式）。
- **主进程循环依赖拆解**：`window ↔ menu` 等三处运行时环（把 `setTerminalMenuFocus` 等移到独立小模块）。

## 执行进度台账

每阶段合并后追加一条目：完成范围、与计划的偏差及原因、留给后面的尾巴。下一阶段执行者先读最新条目，再看 §5 自己阶段的明细。

### P0 — 已完成（2026-08-05）

- 产物：`docs/specs/2026-08-01-renderer-architecture.md`（目标架构、归属矩阵、注入缝、平台分叉规则、组件化标准、store 规范、迁移期纪律、PR 验收模板）。
- 文档引用的反例已在代码中逐一核实：四个裸字符串 provide key（`pinScroll` / `resolveImage` / `resolveAgentTaskId` / `resolveSwarmMembers`）、`MobileSwitcherSheet` 复制 `SessionRow`、`ServerAuthDialog` 硬编码字符串。
- 2026-08-05 按 Codex review（#184，7 条 P2）修订总计划与规范：① AGENTS.md / apps/web 约定的更新从 P18 拆到约束实际变化的阶段（P4 放行 app-client 依赖、P8 解除 no-Pinia），P18 降为一致性核对；② P3 删除"t 注入顺带修复切语言不更新"的过度承诺（注入只影响新事件，正经修法是存 key/params 或重投影，列为已知问题）；③ P4 补"注入缝先行"（`useTerminal`/`useFilePreview` 等依赖 app api 单例或 vue-i18n，非纯移动）与两端 package.json 必须声明 app-client/pinia；④ P5 修正 iconsDir 推导建议（exports map 下 `import.meta.resolve('…/package.json')` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，需显式 export）；⑤ spec 归属矩阵澄清 config 只下沉纯 builder，runtime config 留两端接线层；⑥ 台账 P1 条目在代码 PR 合并前标「进行中」，避免后续执行者误判基线。
- 无 changeset（纯文档）。

### P1 — 已完成（2026-08-05 开 PR；2026-08-11 #185 合入 main squash 20964142）

- 完成：32 个 lib 纯函数模块下沉 `packages/app-core/src/lib/`（git mv 自 desktop 副本，头注释统一为新路径）；9 个测试迁入 `packages/app-core/test/`；两端 135 个文件 import 改指 `@moonshot-ai/app-core/lib`；web 侧副本删除。
- **与计划的偏差（实测驱动，§1.1 的分类未考虑依赖方向）**：
  - 依赖 `src/types`（P2 才动）→ 并入 P2：`parseDiff`、`diffLines`、`diffFullTexts`、`toolDiff`、`notificationXml`、`swarmCardRows`（后者依赖 `composables/swarmGroups`）。
  - 运行时依赖 app 侧 api 单例（`getKimiWebApi`）→ P3 工厂化后处理：`openFileAttachment`、`mediaPreview`（含 `.css`）。
  - 运行时 import `../i18n` → 需 t 注入解耦（同 P3 projector 模式）：`toolMeta`、`activitySummary`（另依赖 `components/chatTurnRendering` 的 `formatDuration`，其 web-only 测试一并滞留）。
  - `icons.ts` / `icons.test.ts`：按计划留 P5。
- **测试随迁的实际口径**：`searchHighlight.test` / `formatTokens.test` 实测为纯 vitest 用例（计划括号标注除外），已随迁合并去重；`shellDanger.test` / `transcriptSelectAll.test` 双份内容相同，合并为一份；desktop 独有的 `nativeWorkspaceDrop` / `planUsage` / `log` / `riveInputs` / `transcriptSearch` 测试一并迁入。`modelThinking.test` 实测 import `useModelProviderState` / `useKimiWebClient`（计划除外它的原因成立），滞留两端、仅改 import 路径，P7 后清理。
- **storage 并集**：`openInLastTarget`（web `OpenInMenu` 在用）与 `openInDefaultTarget`（desktop `nativeOpenIn` 在用）并存；全部 `kimi-web.*` key 名不变，两端零行为变化。
- **app-core package.json** 新增 `shiki` peer + dev 依赖（`codeLanguage` 仅类型引用 `BundledLanguage`，与 vue 同模式）。
- `nativeWorkspaceDrop` 实测桥门控、无桥惰性，按 P1 允许口径同批下沉。
- **坑**：desktop 主进程有自己的 `src/main/log.ts`，与 renderer `lib/log.ts` 同名——批量改写 import 时勿误扫 `src/main/`（本次误改已全部还原并验证）。
- **合入 main（2026-08-05，#178/#182/#183）的冲突处置**：冲突均为 import 块——保留 main 的新 import、路径改指包。main 对已下沉 lib 模块的修改经 rename-merge 自动落进 app-core 副本（mergeWorkspaces / modelThinking / storage / nativeWorkspaceDrop 已逐一 diff 核实零丢失）。main 新增的 `lib/rootKey.ts`（mergeWorkspaces 的依赖）与 `mergeWorkspaces.test.ts` 一并下沉 app-core；`apps/web/test/log.test.ts` 与 app-core 侧重复已删除。main 还新增了双份 `lib/rootKey.ts`（已收编）、`components/sessionRowStatus.ts` 与 `lib/providerForm.ts`（web 侧新增）——后者两个是 P2+ 待收编的新共享副本。
- **第 2/3 轮合 main（2026-08-08，#189 CI PR 等）的冲突处置**：14 个 UU 文件均为 import 块，同口径处理；`taskMerge` 遇 DU（modify/delete）——main 侧修改经 rename-merge 落进包内副本，diff 核实零丢失后 `git rm` 旧路径，`taskMerge.test.ts` 随迁并修正 import。坑：submodule 指针 bump 后必须重新 `pnpm install` 再生 lockfile，否则 CI `--frozen-lockfile` 必挂；`git add` 含不存在路径会整批静默失败，stage 后必跑 `git status` 核对。
- **main 新增双副本的最终登记**（P1 期间 #191/#192/#194 等合入）：`lib/modelDisplay.ts`、`components/sessionRowStatus.ts`、`lib/providerForm.ts` 三个已随 P2 收编；`lib/attachmentsToContent.ts` 依赖 `useKimiWebClient` 的 `PromptAttachment` 类型，P7+ 再收。
- 验收：`pnpm test` 2414 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅（合入 main 后复测全绿）；双端发消息冒烟未跑（需人工补）。
- **包改名（2026-08-05，随本 PR 落地）**：共享包与 desktop 共用，"web-" 前缀名不副实——`@moonshot-ai/{web-core,web-ui,web-markdown,web-i18n}` → `app-{core,ui,markdown,i18n}`，目录 `packages/web-*` 同步改 `packages/app-*`；计划中的 `web-client` 以 `app-client` 落地；`vite-preset` 不动；app 包名 `kimi-code-web` / `kimi-code-app` 不动（AGENTS.md 硬约束）。历史 plan/spec 文档保留旧名不改。改名后复测全绿（test 2414 / typecheck / lint / build）。注意根 `vitest.config.ts` 的 packages include 是花括号写法，批量 sed 会漏，需手改。
- 无 changeset（纯重构）。

### P2 — 已完成（2026-08-11；PR #196 合入 main squash 61135322）

- 完成：14 个模块下沉 `packages/app-core/src/client/`——`types.ts`（32 个渲染类型，两端仅头注释差异）+ `eventBatcher` / `turnsProjector` / `applyRecordDiff` / `messagesToTurns` / `latestTodos` / `swarmGroups` / `auxiliaryTranscriptToTurns` + P1 缓批 `parseDiff` / `diffLines` / `diffFullTexts` / `toolDiff` / `notificationXml` / `swarmCardRows`。两端 `src/types.ts` 改 re-export 壳（照 `api/types.ts` 先例，46 个 `./types` import 站点零改动）；app-core exports 新增 `./client` 与 `./client/types` 子路径；两端 50 个文件 import 改指包。
- **P1 缓批 6 个 lib 模块落 `client/` 而非 `lib/`**：全部依赖 client/types（渲染层 helper），保持分层单向（client → lib，不倒挂）。
- **`normalizeToolName` 抽取**：`messagesToTurns` / `latestTodos` / `toolDiff` 引它，但它住的 `toolMeta.ts` 顶层 import `../i18n`（P3 批）——纯函数部分（NAME_ALIASES + normalizeToolName）抽到 `app-core/src/lib/normalizeToolName.ts`，app 侧 `toolMeta` import 并 re-export，全部调用点不动。
- **收编 P1 期间 main 新增双副本**（P1 台账登记「P2+ 待收编」）：`lib/modelDisplay.ts` / `lib/providerForm.ts` / `components/sessionRowStatus.ts` → `app-core/src/lib/`（均纯、仅依赖 api/types），desktop 侧 3 个测试随迁，web 重复的 `sessionRowStatus.test.ts` 删除。`lib/attachmentsToContent.ts` 依赖 `useKimiWebClient` 的 `PromptAttachment` 类型，P7+ 再收。
- **测试随迁与去重**：desktop `applyRecordDiff` / `auxiliaryTranscriptToTurns` / `diffFullTexts` / `notificationXml` / `turnsProjector` + web `swarm-card-rows` / `swarm-groups` / `turn-logic` 随迁入 `packages/app-core/test/`；web `apply-record-diff.test.ts`（desktop 版复制品）与 `turns-projector.test.ts`（desktop 版子集，desktop 多 SessionPlan 历史重建用例）删除。`event-batcher.test.ts` 拆分：resync / snapshot recency 两个套件动态 import `useKimiWebClient`（P7+ god object）拆出留 `apps/web/test/`（`pendingDelta` helper 两端各留一份），3 个纯套件进包。
- 验收：`pnpm test` 2409 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅ / `check:style` 无新增 findings（.vue 仅 import 行变动）✅；双端发消息冒烟待人工补。
- 无 changeset（纯重构）。

### P3 — 已完成（2026-08-11；PR #197 合入 main squash d718ea3f）

- 完成：`agentEventProjector.ts`（1559 行）下沉 `packages/app-core/src/api/daemon/`；api 壳合并——`createKimiWebApi(deps: { origin, identity, tracer, credentialStore, t, mainAgentOnly? })` 工厂落 `packages/app-core/src/api/createKimiWebApi.ts`，两端 `api/bootstrap.ts` 各瘦身为 ~75 行接线（tracer / credentialStore / runtime config / i18n t），`mainAgentOnly` desktop `true`、web 不传（spec 归属矩阵 §102/117 原已预登记，无需改）。两端 `src/api/` 剩 `bootstrap.ts`（接线）+ `config.ts`（runtime config，按计划留端）+ re-export 壳（index/types/errors）+ desktop 独有 `devBackend.ts`。
- **t 注入口径**：`contracts.ts` 新增 `Translator` 类型；`createAgentProjector(deps: { t: Translator })`；模块级 helper（`patchSubagent` / `projectSubagentProgress` / `subagentProgressText` / `toolArgSummary`）逐线穿参。两端 bootstrap 传 `(k, p) => p === undefined ? i18n.global.t(k) : i18n.global.t(k, p)`（沿用 useKimiWebClient 的 CreateCoreDeps.t 先例）。**已知问题（计划内不修）**：已投影进 state 的文本不随切语言重算。
- **toolMeta 拆解（P1 遗留 i18n 批）**：`toolLabel` / `toolSummary` / `toolChip` + `ToolChipInput` 下沉 `lib/toolText.ts`（t 首参）；`toolIconName` / `toolGlyph` 依赖 `./icons`（P5）滞留 app 侧；app `lib/toolMeta.ts` 改薄壳——绑定 app i18n 的柯里化 re-export，全部调用点零改动。
- **activitySummary 拆解（同上批）**：下沉 `lib/activitySummary.ts`（`summarizeActivity` / `summarizeLive` t 首参）；其依赖的 `formatDuration` 从 `components/chatTurnRendering.ts` 抽至 `lib/formatDuration.ts`（chatTurnRendering 改 re-export，与 formatTokens 同模式）；app `lib/activitySummary.ts` 改薄壳。
- **测试**：projector 两端测试本就互补（desktop 8 套件 retry/goal/subagent-model + web 13 套件 streaming/cron/BTW/lifecycle），合并为包侧单文件 52 用例，identity t 桩（断言本就不依赖本地化文案）；`ws-lifecycle` / `daemon-client`（tracer 换录制假桩，web_log 脱敏断言改对录制记录——脱敏发生在包内 client.ts:739）随迁；web 独有 `activitySummary.test.ts` 随迁并改用真 `createKimiI18n`（app-core devDeps +`@moonshot-ai/app-i18n`，无循环）；删除 P2 漏网的 web 重复 `src/lib/providerForm.test.ts`（17 条与包侧全同，总数 2409→2392 全部来自此删）。
- **app-core tsconfig**：`noPropertyAccessFromIndexSignature` 显式设 `false` 与消费者对齐（web tsconfig 独立未开、desktop renderer 显式关）——否则迁入的 projector 在包自检下报 102 个 TS4111，而实际编译面（apps typecheck）一直是关的。注意：包级 `vue-tsc -p packages/app-core` 无任何门禁在跑，main 上本就有 79 个存量 error（desktopFlag 的 `__KIMI_WEB_DESKTOP__` 全局声明在 app 侧 env.d.ts 等），P3 未治理。
- **openFileAttachment / mediaPreview 未收，改归 P4（app-client）**：两者除 api 单例外还拖 PhotoSwipe / CSS / `@moonshot-ai/app-ui` 等 UI 层依赖，不该进 app-core；P4 建 client 包时连同注入缝一起处理更顺（偏差登记）。
- 验收：`pnpm test` 2392 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅；动了连接/事件层，外部 server 模式（`KIMI_SERVER_URL`）+ 双端冒烟待人工补。
- 无 changeset（纯重构）。

### P4 — 已完成（2026-08-11；PR #198 合入 main）

- 完成：新建 `@moonshot-ai/app-client` 包（`packages/app-client/`，exports `.` / `./composables` / `./contracts`，deps app-core + app-i18n，peer vue；纳入根 vitest include 花括号列表；两端 package.json 声明 workspace 依赖）。`src/contracts.ts` 定义 `ProductTracker`（`track(event, payload)` + `noopProductTracker`），**未接线**（P6 desktop 接 track 适配器、web 接 no-op）。
- **迁移 15 个 composables**（`packages/app-client/src/composables/`）：纯批 `useIsMobile` / `useViewportWidth` / `useFollowScroll` / `useResizable` / `useConfirmDialog` / `useComposerDraft` / `useComposerAutoFocus` / `useInputHistory` / `useSlashMenu` / `useMentionMenu` / `useSidebarLayout` 零改动直迁（两端副本实测仅头注释差异）；`useTerminal` / `useFilePreview` / `useDetailPanel` 落注入缝后迁；`usePageTitle` 两端合并。
- **注入缝（§3.3 模式）**：`useTerminal(sessionId, api: KimiWebApi)`（原 `getKimiWebApi()` 单例 ×3）；`useFilePreview({ client, detailTarget, t, api })`——t 注入替 `useI18n()`，api 窄化为 `Pick<KimiWebApi, 'getFileBlob'>`，god object 类型耦合改窄结构接口 `FilePreviewClient`；`useDetailPanel` 同理定义 `DetailPanelClient` / `DetailPanelAuxiliaryTranscripts` 窄接口（turns / activeAppTasks / auxiliaryTranscripts / sideChat 系列）。`TurnFileChange` 类型从 `components/chatTurnRendering.ts` 上移 `app-core/src/client/types.ts`（chatTurnRendering 改 import + re-export，8 个组件 import 站点零改动）。调用点：Terminal.vue / App.vue 两端各一处适配新签名（t 沿用 `(k, p) => …i18n.global.t` 包装先例）。
- **usePageTitle 合并**：标题参数化（默认 `Kimi Code`，web 传 `Kimi Code Web`），转圈动画按计划按 `isDesktop`（app-core/lib desktopFlag）分支关闭——desktop 静态标题、web 动画，两端行为逐字保持（行为对齐点：两端标题逻辑单源）。
- **测试**：8 个测试随迁 `packages/app-client/test/`（desktop useFollowScroll/useResizable/useMentionMenu/useDetailPanel.agentTranscript/detail-panel-toggle + web composer-draft/input-history/slash-menu），77 用例全绿；web `mention-menu` / `detail-panel-toggle` 与 desktop 版逐行相同（仅 import 路径）删除（总数 2392→2375 全部来自此）；detail-panel-toggle 随新签名去掉 vue-i18n mock 改传 t/假 api。desktop 独有 `useNativeTerminal.test.ts` 滞留（原生桥相关）。
- **约束条目随阶段更新（计划要求）**：根 AGENTS.md 目录地图 packages 清单 + apps/web 依赖约束放行 app-client；apps/web/AGENTS.md 的 api/composables/lib 布局描述与 wire.ts 引用一并刷到 P1–P4 后的实际结构。
- **openFileAttachment 收编 / mediaPreview 缓迁**：`openFileAttachment` 实测仅依赖 `getKimiWebApi().getFileBlob`，注入 api（`Pick<KimiWebApi,'getFileBlob'>` 首参）后落 `packages/app-client/src/lib/`（新增 `./lib` 出口），ChatPane/Composer 两端 4 个调用点适配；web 侧 11 用例随迁（vi.mock api 单例改直接传假 api）。`mediaPreview` 拖 PhotoSwipe + CSS 资产 + `@moonshot-ai/app-ui`（openDialogCount）——收编需要先决策 app-client 的依赖面（是否引 app-ui/photoswipe、包内 CSS 出口形态），不属于本批；登记待后续阶段（P5 icons 批前后）专项处理。
- 验收：`pnpm test` 2375 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅；双端冒烟待人工补。
- 无 changeset（纯重构）。

### P5 — 已完成（2026-08-11；PR #199 合入 main squash 3488055c）

- 完成：两端 `icons/kimi/*.svg` 合并（71 个，共有文件逐字节相同，desktop 仅多 `keyboard.svg`）移入 `packages/app-client/src/icons/kimi/`；`lib/icons.ts` 取并集（desktop 版，仅多 keyboard 一项）落 `packages/app-client/src/icons/icons.ts`，新增 `./icons` 出口；两端 16 个 import 站点改指 `@moonshot-ai/app-client/icons`。
- **vite iconsDir 指包内**：app-client 显式 export `./package.json`，四个配置（两端 vite.config + vitest.config）统一 `fileURLToPath(new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')))`——`import.meta.resolve` 对带 exports map 的包必须显式声明该子路径，否则抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`（计划预判的坑，按预案落地）。
- **icons.test 随迁的连锁**：`~icons/*` 虚拟模块需要 unplugin-icons 插件，根 vitest 的 packages 内联 project 无插件——app-client 新增自己的 `vitest.config.ts`（复用 vite-preset 的 plugins），根 config 把 app-client 从花括号列表拆出为独立 project 条目；app-client devDeps +`@moonshot-ai/vite-preset`。web 侧 icons.test 与 desktop 版仅头注释差异，删除（总数 2375→2366 全部来自此）。
- **mediaPreview 收编（P3/P4 登记的尾巴）**：落 `packages/app-client/src/lib/mediaPreview.ts`（css 随迁，侧效应 import 在包内源码下由消费者 vite 处理，无需 CSS 出口）；api 注入（`Pick<KimiWebApi,'getFileBlob'>` 进 `ImagePreviewOptions`，MediaLightbox 两端各一处适配）。依赖面决策：app-client deps +`photoswipe` + `@moonshot-ai/app-ui`（openDialogCount 是无头计数器，app-ui 不反向依赖 app-client，无环）——自此 app-client 分层修正为「Vue composables + 浏览器层 UI helper」，根 AGENTS.md 描述沿用。
- 验收：`pnpm test` 2366 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅ / `check:style` 29 findings 与 main 基线相同 ✅；**全量图标视觉验证**（DesignSystemView §02 图标目录页逐排核对）+ 双端冒烟待人工补。
- 无 changeset（纯重构）。

### P6 — 🚧 进行中（2026-08-12 本地实施 + 验收完成；待提交 PR，合并后本条转「已完成」）

- 完成：`ProductTracker` 接线落地 + 5 个 telemetry/平台分叉 composable 收编 `packages/app-client/src/composables/`，两端副本（10 个文件）删除。
- **注入缝形态（计划只写「app-client 接线」，实测定为模块级 registry）**：`contracts.ts` 追加 `setProductTracker` / `track` 委托（no-op 默认）；desktop 在 `main.ts`（`installClientErrorCapture` 后）`setProductTracker(productTracker)`——适配器放 `lib/track.ts`（`track(event as RendererEventName, payload as never)`，包内事件绕开 desktop 编译期契约，主进程 zod schema 仍是运行时边界）；web 不动（no-op 默认即「注入 no-op」，行为与现状一致）。参数透传方案被否：track 调用点散在 4 个 composable 深层，registry 让迁移 diff 只剩 import 行。
- **useNotification**：desktop 版为正本；`NotificationKind` 改本地联合类型（对齐 track-events.ts:183 zod enum，摆脱 shared/track-events import）；i18n 解耦走 P3 模式——copy 三函数 `t: Translator` 首参（`@moonshot-ai/app-core/contracts`），`useNotification(deps: { t })`，两端 `useKimiWebClient` 传 `(k, p) => …i18n.global.t` 包装；`shouldNotifyCompletion` 保持无参纯函数。
- **useAttachmentUpload**：desktop 版为正本；`AttachmentUploadDeps` 新增必填 `api: Pick<KimiWebApi,'getFileBlob'>`（替 `getKimiWebApi()` 单例），两端 `Composer.vue` 传 `api: getKimiWebApi()`。
- **useOAuthLoginFlow / useUpdateStatus**：仅 track 改 contracts + 头注释，其余逐字节不动。行为对齐点两条（随 PR 描述声明）：① web 两处 `setAutoDownload` 调用补 `source` 参数（UpdateIndicator `'update_prompt'` / SettingsDialog `'settings'`，与 desktop 一致）；② web 获得 desktop 的 oauth `flowCancelled` poll 守卫（D 类并集）。`useUpdateStatus` 头注释保留 "Desktop-only" 字样（描述功能归属，web 无桥降级说明文件内已有）。
- **useAuxiliaryTranscripts**：两端实测已字节一致，纯移动（无头注释，未加）。
- **测试合并随迁 5 文件进 `packages/app-client/test/`**：desktop 超集版 oauth（20 例）/ updateStatus（19 例）直接收编，web 子集版删除；attachment-upload 合并 = web 上传逻辑 24 例 + desktop 埋点 4 例（无逐行重复）；notification-logic（23 例）改 `createKimiI18n({ locale: 'en' })`；useAuxiliaryTranscripts（7 例）仅改 import。埋点断言统一从「mock window.kimiDesktop / vi.mock lib/track」改为 `setProductTracker({ track: spy })` + afterEach 复位 `noopProductTracker`。
- **基线偏差**：P5 台账记的 2366 已过时——P5 后 main 前进（#200–#204），HEAD 实测 2383；本次净 -27 → 2356，全部来自 web 两个子集测试文件删除（oauth -13 / updateStatus -14），其余删除均在包内 1:1 重建。
- **环境坑**：`pnpm build` 首跑挂在 kimi-code submodule 的 node-sdk（缺 `@microsoft/api-extractor`，submodule 根 manifest 有声明但未装）——`kimi-code/` 内补跑一次 `pnpm install` 即可，tracked 内容不受影响。
- 验收：`pnpm test` 2356 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅ / `check:style` 29 findings 与基线同 ✅；**desktop 侧埋点冒烟**（notification_shown / attachment_added / oauth_login_step 各触发一次，主进程日志可见）**+ 双端发消息冒烟待人工补**。
- 无 changeset（纯重构）。
