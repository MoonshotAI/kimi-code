# 02 · VS Code 插件源码导读（深度版）

> 时效基线：基于 commit `d4e0ad4b2`（2026-08），行号会漂移，以路径为准。
> 插件版本 0.7.2（`apps/vscode/package.json`），npm 包名 `kimi-code`。本文所有结论来自逐文件通读（含 `session-runtime.ts` 全 655 行）；引擎侧启动链见 `00` 第一节，调试方法见 `03`。

## 〇、全局认知

1. **引擎在扩展宿主进程内**。插件不 spawn CLI、不连 kap-server、不用 ACP；通过 `@moonshot-ai/kimi-code-sdk`（= `packages/node-sdk`）把整个引擎编译进 `dist/extension.js`（tsdown `alwaysBundle: /^@moonshot-ai\//`），激活即启动。
2. **唯一跨进程边界是 webview postMessage**。聊天 UI 是 React webview（沙箱，无 Node 能力），与宿主之间走自定义 JSON-RPC；唯一网络流量来自引擎自身（模型 API、MCP）。
3. **分层记忆法**：webview（渲染）→ shared/bridge（协议）→ handlers（RPC 实现）→ runtime（会话状态机）→ SDK（引擎门面）。前两层是"平面"的，真正的复杂性集中在 runtime 层。
4. 权威佐证：`apps/vscode/docs/node-sdk-migration.md`（0.6.0 架构设计文档，含运行时图与 8 条维护不变量）。

### 〇.1 四条逐条展开（黑话→人话）

**第 1 条：引擎在扩展宿主进程内** —— kimi 的"大脑"直接跑在 VS Code 给插件开辟的那个进程里，不另起炉灶。

- **扩展宿主进程（Extension Host）**：VS Code 不让插件跑在自己的主进程里（防止插件卡死编辑器），而是单独开一个 Node.js 进程专门装所有插件——这个进程就叫扩展宿主。插件代码全在这里跑。
- **"不 spawn CLI、不连 kap-server、不用 ACP"**：这是在和其他形态划清界限——
  - CLI 形态：终端里直接跑引擎；
  - Web 形态：浏览器页面连 `kap-server`（服务器）；
  - **ACP**（Agent Client Protocol，外部编辑器接入 agent 的标准协议，Zed 这类编辑器用的；本仓库 `packages/acp-server` 就是其服务端实现，包描述原话 "Agent Client Protocol (ACP) host"）；
  - 插件形态**以上都不占**：不启动 CLI 子进程（spawn＝启动子进程）、不连服务器、不走 ACP。
- **怎么做到的**：引擎通过 `@moonshot-ai/kimi-code-sdk`（就是 `packages/node-sdk` 这个包，声明在 `apps/vscode/package.json:292`）**整个编译进 `dist/extension.js` 这一个文件**。
- **`alwaysBundle: /^@moonshot-ai\//`**：tsdown 打包配置（`apps/vscode/tsdown.config.ts:42`），意思是"凡 `@moonshot-ai/` 开头的依赖（和 zod）必须打进产物，不许留成外部 import"。普通 npm 包发布时依赖是留给用户装的，但 VSIX 插件包要自包含，所以全部打进一个文件。注意旁边还有 `neverBundle: ['vscode']`——`vscode` 这个内置模块由宿主提供，打进去反而找不着。
- **激活即启动**：VS Code 插件是懒加载的——装了不等于跑；触发条件满足（如打开 kimi 面板）时 VS Code 调 `activate()`，那一刻引擎就在宿主进程里跑起来了。

**第 2 条：唯一跨进程边界是 webview postMessage** —— 整个插件只有两块：宿主进程里的引擎（逻辑）、webview 里的 React 网页（界面），两者之间只靠一条消息通道说话。

- **webview**：VS Code 插件里嵌入的网页。聊天界面是 React 写的，就跑在 webview 里。
- **沙箱、无 Node 能力**：webview 本质是个浏览器标签页，只有浏览器 API（画页面），**不能读文件、不能起进程**——所以引擎（Node 代码）绝不可能放 webview 里，只能放宿主。这就是为什么必然分成两边。
- **postMessage**：浏览器标准的跨上下文消息 API，是 webview ↔ 宿主之间**唯一**的数据通道。
- **自定义 JSON-RPC**：两边在这条通道上约定用 JSON 消息互相"调函数"——JSON-RPC＝用 JSON 表达"调哪个方法、传什么参数、返回什么/报什么错"的协议格式。
- **"唯一网络流量来自引擎自身"**：插件对外只由引擎发两类网络请求——模型 API（调 LLM）和 MCP（Model Context Protocol，外接工具服务器的标准协议）。webview 自己不发请求，一切都经宿主。

**第 3 条：分层记忆法** —— 五层从外到里，读代码按这个顺序钻：

| 层 | 角色 | 人话 |
|---|---|---|
| webview | 渲染 | React 网页，画聊天界面 |
| shared/bridge | 协议 | 定义两边消息的格式（说什么话） |
| handlers | RPC 实现 | 宿主侧收到消息后真正干活的函数 |
| runtime | 会话状态机 | 会话的状态与迁移规则——**复杂度大头在这** |
| SDK | 引擎门面 | 引擎对外的"前台窗口" |

- **门面（facade）**：设计模式词——SDK 把引擎内部一大堆能力收拢成少数几个干净入口，插件代码只面对前台，不碰内脏。
- **状态机**：把"一次会话"建模成一组状态（空闲/等用户/等审批/流式输出中…）和状态间怎么迁移的规则。
- **"前两层是平面的"**：webview 和 bridge 层基本只是"传来传去"，逻辑薄；读源码时快速过，时间砸在 runtime。

**第 4 条：权威佐证** —— `apps/vscode/docs/node-sdk-migration.md`（已验证存在，396 行），0.6.0 版本迁移时的**架构设计文档**，内含运行时结构图和 **8 条维护不变量**（invariant＝改代码时永远必须成立的规则，如"引擎必须在宿主进程内"；违反即架构被破坏）。想深挖架构决策先读它。

```
webview 进程                extension host 进程
──────────────             ─────────────────────────────────────────────
React + zustand    postMessage（Methods 50 / Events 9）
services/bridge ──────────► KimiWebviewProvider（视图生命周期 + HTML/CSP）
stores/chat.store            │
event-handlers               ▼
components/…            BridgeHandler（校验→分发→trace）
                            │ createContext → HandlerContext
                            ▼
                        handlers/*（chat/session/config/mcp/auth/file/workspace）
                            │ getOrCreateSession / resumeSession
                            ▼
                        KimiRuntime（会话池 + 视图路由）
                            │ 每会话一个
                            ▼
                        SessionRuntime（事件订阅/审批/伪turn/取消）
                            │ session.prompt / onEvent / setApprovalHandler
                            ▼
                        KimiHarness →（v2 默认 / v1 回退）→ 引擎
```

## 一、激活与 webview 装配

### 1.1 activate() 全程（`src/extension.ts:19`）

激活触发：`package.json` `activationEvents: []` + `contributes.views` 声明 `kimi.webview`，VS Code 自动生成 `onView:kimi.webview`——**用户第一次点开侧边栏才激活**。步骤（每步的行号）：

1. 建 "Kimi Code" 输出通道（`:20`）；
2. `new KimiWebviewProvider(...)`（`:24`）→ 构造 `BridgeHandler`（`src/KimiWebviewProvider.ts:29`）→ 构造 `KimiRuntime`（`src/bridge-handler.ts:42`）→ **引擎在此刻同步启动**（链路见 `00` 阶段 A/B）；失败不静默降级，直接抛错并附"回退 v1"提示（`src/bridge-handler.ts:51-61`）；
3. 检查登录态（`:34`）；注册 `kimi-baseline` 虚拟文档 provider（`:39-53`，diff 子系统用，见第五节）；
4. 注册设置变更广播（`yoloMode` 变更会推送到所有活跃会话，`:55-70`）与 view provider（`retainContextWhenHidden: true`——切走不丢 React 状态）；
5. 注册 10 个命令（`:88-131`）：`openInTab`/`openInSideBar`/`focusInput`/`insertMention`/`newConversation`/`showLogs`/`resetKimi`/`logout`/`migrateLegacyData`/`clearAllState`（dev）；
6. 后台发现旧版 `~/.kimi` 数据（`:133`）。

`deactivate()`（`:144`）→ `provider.shutdown()` → 逐会话 close → harness close（引擎 drain 语义见 `00` 的 3.7 小节）。

### 1.2 KimiWebviewProvider：视图生命周期（`src/KimiWebviewProvider.ts`）

- **两种视图**：侧边栏 `resolveWebviewView`（`:51`）与编辑器面板 `createPanel`（`:61`）。每个视图拿唯一 `webviewId`（`sidebar_<uuid>` / `panel_<uuid>`），这是会话路由的键；
- `setupWebview`（`:97`）：开 `enableScripts`、限 `localResourceRoots` 为扩展目录、注入 HTML、把 `webview.onDidReceiveMessage` 接到 `bridgeHandler.handle` 并 `postMessage` 回执（`:106-109`）——RPC 的宿主端入口就这一处；
- **HTML 与 CSP**（`getHtml`，`:152-181`）：`default-src 'none'` 白名单式 CSP；脚本只允许带 nonce 的 `dist/webview.js`（vite 构建的单 IIFE，CSS 由 JS 注入）；`connect-src`/`worker-src` 限 `cspSource`——webview 无法访问任意外部网络。`<body>` 上带 `data-baseuri`/`data-webviewid`，React 侧据此初始化；
- 广播与重载：`broadcastInternal`（`:112`，可定向单视图或全部）、`reloadWebview`/`reloadAllWebviews`（`:124-135`，重设 HTML 即"刷新"）、`resetAllWebviews`（先 disposeView 再重载）。

## 二、bridge 协议与分发（`shared/bridge.ts` + `src/bridge-handler.ts`）

### 2.1 协议

- `Methods`（`shared/bridge.ts:12-64`）：50 个方法常量（`streamChat`、`respondApproval`、`forkKimiSession`、`openFileDiff`…）；`Events`（`:89-99`）：9 个单向广播（`streamEvent`、`loginUrl`、`fileChangesUpdated`…）。加新交互 = 协议常量 + 宿主 handler + webview 客户端三处联动；
- **webview 不可信**：`validateRpcMessage`（`:104`）在任何 handler 运行前校验形状 + 方法白名单（`src/bridge-handler.ts:68` 调用）；
- 宿主侧全链 `BridgeHandler.handle`（`:66-88`）：校验 → `dispatch`（`:141-146`，查 `handlers` 总表）→ 包装 `{id, result|error}` 回执。每个请求过 `trace`（`:304-309`）——注意其**隐私设计**：日志刻意只含 id/method/耗时/成败，不含参数、prompt 文本、路径与凭据。

### 2.2 HandlerContext：handlers 的全部能力面（`src/handlers/types.ts:14`）

handlers 不直接摸 runtime 内部——`createContext`（`src/bridge-handler.ts:148-208`）给每个请求现场组装一个上下文，关键成员及其实现：

| 成员 | 实现 | 说明 |
|---|---|---|
| `getOrCreateSession` | `runtime.openSession`（`:168-179`） | 创建或复用会话，并登记 fileManager |
| `resumeSession` | `:180-200` | 复用活会话或 `harness.resumeSession`；**workDir 不匹配直接拒**（拒绝的会话会被 close） |
| `closeSession` | `detachView` + 清 fileManager | 视图与会话解绑（引用计数机制见 3.1 小节） |
| `saveAllDirty` | `:210-213` | 保存所有脏文档（autosave 前置） |
| `getSession/getSessionId` | runtime / fileManager | 当前视图绑定的会话 |
| `fileManager`/`baselineManager`/`harness` | 直通 | diff 子系统与 SDK 门面 |
| `workDir` 系列 | `:98-139` | 见下 |

**workDir 模型**：`workspaceRoot`（第一个 workspace folder）+ per-webview 的 `customWorkDirs`（`SetWorkDir` RPC 设置，必须落在 workspace 内，`:110-127`）。所有路径相关 handler 都经 `utils/workspace-path.ts` 的包含性校验——这是插件级的路径安全边界。

### 2.3 handlers 七域（`src/handlers/index.ts:12-20`）

`workspace`（checkWorkspace/setWorkDir）、`config`（模型/effort/设置）、`mcp`（CRUD/OAuth/测试）、`session`（列表/resume/fork/删除/历史）、`chat`（发消息/中止/审批/提问，见第四节）、`file`（打开/diff/回滚/媒体）、`auth`（登录登出）。

## 三、runtime 层精读（插件的心脏）

### 3.1 KimiRuntime：会话池与视图路由（`src/runtime/kimi-runtime.ts`）

两个 Map 构成路由表：`sessions: Map<sessionId, SessionRuntime>` 与 `sessionByView: Map<webviewId, sessionId>`。`openSession`（`:88-144`）的逻辑：

1. 当前视图已绑同一会话且 workDir 未变 → 只应用设置变更并 `announceStatus`（复用）；
2. 目标会话已存在于池 → 校验 workDir、应用设置、先 `detachView` 再换绑（多视图共享）；
3. 否则创建（`harness.createSession`，权限由 legacy yolo/afk 标志映射，`:110-118`）或 resume（`:119`）；**旧会话的审批标志从 metadata 恢复**，迁移自旧版的会话还有兜底读取（`:122-124`）；任何失败都会 close 掉刚拿到的会话再抛错（`:132-137`）；
4. `wrapSession` 建 `SessionRuntime` 入池，视图订阅，`announceStatus` 推送模型/effort/plan 状态。

引用计数：`detachView`（`:187-198`）只在**最后一个订阅视图**退订时才 close 会话——侧边栏和面板开同一会话，关掉一个不影响另一个。`setYoloModeForActiveSessions`（`:218`）把全局设置推到所有活跃会话。

### 3.2 SessionRuntime：单会话状态机（`src/runtime/session-runtime.ts`，全 655 行）

这是插件里唯一"有状态"的地方，逐块讲：

**挂接（构造函数，`:93-108`）**：`setApprovalHandler`/`setQuestionHandler` 转给 reverse-rpc（`:105-106`）——注意源码注释：引擎权限模式（yolo/auto 映射）已在内部自动放行大部分操作，**能到达这个 handler 的都是例外**（敏感文件、plan 评审、ask 规则），必须用户决定。唯一的 SDK 事件订阅在 `:107`。

**prompt 与重入保护（`runTurnAction`，`:178-223`）**：`prompt()`（`:174`）= `runTurnAction(input, () => session.prompt(toSdkPromptInput(input)))`。核心难点是**重入**：turn 进行中再发消息只失败自己、不打扰进行中的 turn（`:183-196`）——且区分两种情况：普通 turn 结束会有终止事件解锁视图（非终止错误即可），而独占操作（如 fork 物化化）没有终止事件，必须终止性拒绝避免 UI 挂到握手超时。`ActivePrompt` 的 `started` 标记由 `turn.started`（main agent）事件置位（`:450-452`），用于区分 preflight/runtime 两个错误阶段。

**host action 伪 turn（`:225-292`）**：宿主斜杠命令（/init、/export 等，不是模型 turn）要在 UI 上呈现为一次"回合"：`beginHostAction` 手工发 `TurnBegin`+`StepBegin`，`emitHostText` 发文本块，`completeHostAction` 发 `stream_complete`。取消通过 `cancelledHostActions` 集合传递。

**compaction 桥接（`compactHostAction`，`:294-327`）**：`session.compact()` 不会自然终止伪 turn，所以挂一个 pending promise，由 `compaction.completed/cancelled` 事件（`:442-448`）resolve——事件驱动，无轮询。

**cancel（`:329-352`）**：设计要点（源码注释）：**总是直达引擎**（宿主记账可能漂移，`session.cancel()` 空闲时是无害 no-op，但这是找回"宿主跟丢的 turn"的唯一手段）；同时取消 turn 与 compaction 两个面（Stop 按钮对两者都正确）；先 `reverseRpc.cancelAll` 把挂着的审批/提问全部以 cancelled 收尾。

**事件管线（`onSdkEvent`，`:439-495`）**——每个 SDK 事件经过的检查站，按序：

1. compaction 事件 → resolve pending（`:442-448`）；
2. `turn.started`(main) → `activePrompt.started = true`（`:450-452`）；
3. `tool.call.started` 且工具是 Write/Edit → **抓基线快照**（`:454-456`，`:497-513`，diff 子系统的触发点）；
4. `turn.step.retrying` → 记录 provider 重试日志（`:458-463`）；
5. 抑制错误去重（`:465-467`，见下）；
6. `adaptSdkEvent` 纯投影（3.3 小节）→ terminal 或普通 UI 事件；
7. **中途 error 强制 `terminal: false`**（`:481-494`）：turn 仍在跑时的 error 若被 UI 当成终止事件，界面会提前解锁、下一次发送撞上还在跑的 prompt——所以改写为非终止；未 started 的 error 则直接判 failed。

**终止事件（`emitTerminal`，`:515-557`）**：terminal 元数据带稳定 key（`sessionId:agentId:turnId`），`terminalKeys` 集合**幂等去重**——同一 turn 的终止只处理一次。completed/cancelled → `stream_complete`；其余 reason → error 事件 + 记 `suppressedError`，之后引擎若再广播同一错误（`:559-564`）就吞掉，避免双报。

**关闭（`close`，`:395-418`）**：顺序固定——标记关闭、reject pending compaction、cancelAll 反向 RPC、退订事件、摘掉审批/提问 handler、有活 turn 则 cancel 并 settle、最后 `session.close()`。

### 3.3 event-adapter：纯函数投影（`src/runtime/event-adapter.ts`）

`adaptSdkEvent(state, event, options) → {state, event?, terminal?}`（`:83-172`）——**纯状态机**：state 不可变、必须回传下次调用（`SessionRuntime.adapterState` 持有）。为什么纯：同一份逻辑被 replay-adapter 复用来重放历史。要点：

- **subagent 路由**：`subagent.spawned` 记录父子关系（`:90-108`），子 agent 的事件被改挂到父的 tool call 下显示（`:404` 带 `parent_tool_call_id`）；
- **TurnBegin 合成**：SDK 的 `turn.started` 故意不重复 prompt 内容（`:64-66` 注释），适配器用宿主侧的 `pendingInput` 合成 `TurnBegin`；
- `turn.ended`（main）→ 产出 `terminal` 元数据而非事件（`:127-140`），终止语义由 SessionRuntime 统一转换；
- `mapLegacyWireEvent`（`:196` 起）把其余事件映射成 webview 协议：`turn.step.*`/`assistant.delta`/`thinking.delta`/`tool.call.started|delta`/`tool.result`/`agent.status.updated`/`compaction.*`（CompactionBegin/End）；工具名做新旧映射（`Bash→Shell`、`Read→ReadFile`…，`:174-184`）——webview 协议是历史兼容层；
- usage 事件做 **delta 计算**（`:338-359`）：引擎报累计值，UI 要增量。

### 3.4 reverse-rpc：审批与提问（`src/runtime/reverse-rpc.ts`）

引擎回调 → `requestApproval`（`:23`）生成 uuid、把 resolve 存进 Map、推 `ApprovalRequest` 事件给 webview → 用户点击 → `respondApproval`（`:54-66`）把 UI 的三态映射成引擎决策（`approve_for_session` → `{decision:'approved', scope:'session'}`）；`cancelAll`（`:76-85`）在 turn 结束/取消时把所有挂起项以 cancelled 收尾——**引擎侧的 Promise 永远不会被悬空**。提问（ask-user-question 工具）同构。

### 3.5 其余三件

- `replay-adapter.ts`：resume/fork 时用同一套 adaptSdkEvent 重放 wire 历史，重建 UI 状态（消息列表、工具块、折叠）；
- `legacy-approval.ts`：`yolo`/`afk` 双布尔 → 引擎 permission 的映射与 metadata 存取；`applyLegacyApproval`（`src/runtime/session-runtime.ts:421-438`）在 metadata 写失败时会回滚权限（写权限→写元数据→失败→恢复原权限）；
- `tool-display.ts`：工具输入 → 聊天展示块（审批弹窗与工具渲染共用的数据源）。

## 四、chat 域与宿主斜杠命令

### 4.1 streamChat 八步（`src/handlers/chat.handler.ts:74-145`）

workDir 校验（无 workspace 则提示并返回）→ 可选 `saveAllDirty`（autosave）→ `getOrCreateSession` → `getStatus` 后按需 `setModel`/`setThinking`/`setPlanMode`（**resumed 会话保留自身设置，只应用本次提交的值**，`:104-125`）→ `announceSessionStart` → 宿主斜杠命令分流（`:127-135`）→ `buildSystemContext` 注入编辑器上下文（`:137-139`）→ `runtime.prompt(...)`。

`buildSystemContext`（`:37-59`）三种模式（`kimi.editorContext` 设置）：`never` / `onConversationStart`（每会话只注入一次）/ `onFileChange`（文件变了才重注入）；注入形如 `<system>Editor context: path:line (L1-2 selected), unsaved.</system>`，并标注"仅在与问题相关时使用"。

### 4.2 宿主斜杠命令（`src/handlers/slash-command.ts`）

11 个宿主命令（`:16-28`）：`init`（`session.init()` 生成 AGENTS.md）、`compact`（走 3.2 小节的 compaction 桥）、`clear`/`reset`（清上下文）、`yolo`/`auto`/`afk`（切权限标志）、`plan`（on/off/view/clear 子命令）、`add-dir`（加附加目录，不持久化）、`export`（导出 markdown，带敏感信息提醒 `:209-212`）、`import`（文件或**另一个会话**导入，10MB 上限、UTF-8 校验、敏感文件名检测 `:219-278`）、`skill:<name>`（激活技能）。全部走 host-action 伪 turn 模式（3.2 小节）；取消感知贯穿始终。

## 五、diff 与 File Changes 子系统

链路：`SessionRuntime.onSdkEvent` 捕获 `tool.call.started`（Write/Edit，`src/runtime/session-runtime.ts:498-514`）→ `BridgeHandler.captureFileBaseline`（`src/bridge-handler.ts:244-290`，双重路径包含校验后调 manager）→ **BaselineManager**（`src/managers/baseline.manager.ts`）：

- 存储为 manifest（版本化）+ 内容快照（sha256 命名，`:20-21`、`writeSnapshot :369`），去重靠哈希（`removeUnreferencedSnapshots :413`）；
- API：`capture`（`:84`，跳过已有/旧版基线）、`getChanges`（`:118`，与磁盘 diff 出 FileChange 列表）、`getContent`（`:166`，供虚拟文档）、`undo`/`undoAll`（还原）、`keep`/`keepAll`（确认变更）、`materializeToFork`（`:251`，fork 会话带走基线）；
- 兼容：旧版插件存在 `~/.kimi` 下的基线有读取兜底（`:100-101`、`:437-453`）；
- 展示：`file.manager.ts` 的 `trackFile`/`refreshChanges` 广播 `Events.FileChangesUpdated`；打开 diff 用 `kimi-baseline:` 虚拟 scheme（`src/extension.ts:40` 的 provider 经 `getBaselineContent` 取内容）+ `vscode.diff`。

## 六、webview 侧（`webview-ui/`）

React 19 + zustand + tailwind4 + radix。数据流是"**事件 → 归约 → 渲染**"的单向流：

- `webview-ui/src/App.tsx:23` 总装所有 `bridge.on(Events.*)` 订阅；`webview-ui/src/hooks/useAppInit.ts:77` 六步初始化（checkWorkspace → 并行拉配置/MCP/斜杠命令 → 登录态+模型 → `resolveAppView :28` 路由 login/status/main）；
- `stores/chat.store.ts`：`ChatState`（`:90`）以 `messages: ChatMessage[]` 为核心；`sendMessage`（`:191`）处理草稿媒体、清空输入；**排队消息机制**（`:253-274`）：turn 进行中发送的消息进队列，`stream_complete`/error 后自动续发下一条；
- `webview-ui/src/stores/event-handlers.ts:570` 的 `processEvent(draft, event)`：纯函数归约器，逐 case 处理 `StepBegin`/`ContentPart`/`ToolCall`/`ToolCallPart`（参数流式增量）/`ToolResult`/`CompactionBegin|End`/`StatusUpdate`/`error`/`stream_complete`…——**UI 状态的全部变化都从事件来**，没有旁路；
- `webview-ui/src/services/bridge.ts:187` 的 `streamChat` 是发送入口。

## 七、一条消息的完整旅程（修订版，全部节点已核实）

**发送**：`InputArea.tsx` → `webview-ui/src/stores/chat.store.ts:191` `sendMessage` → `webview-ui/src/services/bridge.ts:187`（RPC `streamChat`）→ 宿主 `src/bridge-handler.ts:66` 校验分发 → `src/handlers/chat.handler.ts:74` 八步前置 → `src/runtime/session-runtime.ts:175` `runTurnAction` → SDK `session.prompt` →（引擎，见 `00` 阶段 F 与 `04`）。

**回流**：引擎事件 → SDK `session.onEvent` → `src/runtime/session-runtime.ts:440` 七检查站管线 → `src/runtime/event-adapter.ts:83` 纯投影 → `emitStreamEvent`（`:581`，只发给订阅视图）→ postMessage `Events.StreamEvent` → `webview-ui/src/App.tsx:23` → `webview-ui/src/stores/event-handlers.ts:570` `processEvent` 归约 → zustand → React。

**分支**：需要审批 → `src/runtime/reverse-rpc.ts:23` 挂起 → `ApprovalDialog` → `Methods.RespondApproval` → `:54` resolve；斜杠命令 → `src/handlers/slash-command.ts:47` host-action 伪 turn；历史会话恢复 → `replay-adapter` 重放。

## 八、阅读顺序与练习

阅读顺序（由骨架到心脏）：`docs/node-sdk-migration.md` → `extension.ts` → `KimiWebviewProvider.ts` → `shared/bridge.ts` → `bridge-handler.ts` + `handlers/types.ts` → `handlers/chat.handler.ts` + `slash-command.ts` → **`runtime/session-runtime.ts` 精读** → `event-adapter.ts` → webview 三件（App/useAppInit/stores）→ `baseline.manager.ts`。

练习（按难度递进）：

- [ ] F5 后在 `src/handlers/chat.handler.ts:74`、`src/runtime/session-runtime.ts:440`（事件管线）、`src/runtime/event-adapter.ts:83` 三处下断点，发一条 "hi"，把三类断点的触发顺序与调用栈各抄一份；
- [ ] 发送 `/plan on` 再发普通消息，对照 3.2 小节的伪 turn 机制，在断点里看清两种回合的事件序列差异；
- [ ] 走通"三处联动"：加一个无操作的 Method（协议常量 + handler + webview 调用）；
- [ ] 让模型编辑一个文件，断点 `captureFileBaseline`，画出一张"工具调用→基线→diff 面板"的时序图；
- [ ] 打开两个面板开同一会话，观察 `detachView` 的引用计数行为（关掉一个，会话是否存活）。

## 下一步

→ `03-调试指南.md`（把上面的断点跑起来）／`04-agent引擎入门.md`（顺着 `session.prompt()` 下钻）
