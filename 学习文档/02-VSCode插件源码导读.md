# 02 · VS Code 插件源码导读

> 时效基线：基于 commit `d4e0ad4b2`（2026-08），行号会漂移，以路径为准。
> 插件版本 0.7.2（`apps/vscode/package.json`），npm 包名 `kimi-code`，publisher `moonshot-ai`。

## 先建立正确的全局认知

这一节如果理解错了，后面全白读：

1. **引擎跑在扩展宿主进程里**。插件不 spawn `kimi` CLI、不连接 kap-server、不使用 ACP。它通过 `@moonshot-ai/kimi-code-sdk`（即 `packages/node-sdk`）把整个 agent 引擎**编译进自己的产物**（tsdown 打包时把 workspace 包 resolve 到源码并 `alwaysBundle`，见 `apps/vscode/tsdown.config.ts`），在扩展宿主内进程内调用。
2. **唯一跨进程边界是 webview postMessage**。聊天 UI 是 React webview（沙箱内无 Node 能力），与扩展宿主之间走一套自定义 JSON-RPC。
3. **唯一的网络流量来自引擎本身**：调用模型 provider 的 HTTPS API、连接 MCP 服务器。
4. 权威佐证：`apps/vscode/docs/node-sdk-migration.md`（0.6.0 架构迁移设计文档）明确写道"生产路径中没有 Python 进程、第二个 Node 进程或本地 HTTP 服务"。这篇设计文档是本目录下最好的架构资料，本文只做导读不重复它。

## 三层架构

```
┌─────────────────────────────────────────────────────────┐
│ webview（独立沙箱进程）  webview-ui/                     │
│ React 19 + zustand + tailwind4 + radix                  │
│ services/bridge.ts ── postMessage ──┐                   │
└─────────────────────────────────────┼───────────────────┘
                                      │ JSON-RPC（shared/bridge.ts 定义协议）
┌─────────────────────────────────────┼───────────────────┐
│ extension host（Node 进程）  src/    ▼                   │
│ KimiWebviewProvider → BridgeHandler → handlers/*         │
│        │                                                 │
│        ▼                                                 │
│ KimiRuntime ──► SessionRuntime（每个会话一个）            │
│        │                                                 │
│        ▼  进程内调用                                      │
│ @moonshot-ai/kimi-code-sdk 的 KimiHarness                │
│   ├─ 默认：createKimiHarnessV2 → v2 引擎（经 klient）    │
│   └─ 回退：createKimiHarness → v1 KimiCore               │
└─────────────────────────────────────────────────────────┘
```

## 目录地图（apps/vscode）

```
apps/vscode/
├── src/                      扩展宿主侧（Node）
│   ├── extension.ts          入口 activate()/deactivate()
│   ├── KimiWebviewProvider.ts webview 生命周期（侧边栏 view + 编辑器 tab 面板）、HTML/CSP
│   ├── bridge-handler.ts     RPC 总入口：校验 + 分发 + KimiRuntime/Manager 装配
│   ├── config/vscode-settings.ts  kimi.* 设置读取 + 引擎选择（v2/v1 一次性决定）
│   ├── handlers/             按域拆分的 RPC 处理器（见下表）
│   ├── managers/             baseline.manager.ts（diff 基线）、file.manager.ts（文件面板）
│   ├── migration/            旧版 ~/.kimi 数据迁移
│   ├── runtime/              ★ 插件最核心的一层（见下节）
│   └── utils/                登录态、workspace 路径约束等
├── shared/                   宿主与 webview 共享的类型与协议
│   ├── bridge.ts             RPC 方法/事件常量表 + validateRpcMessage 校验
│   ├── types.ts              ExtensionConfig、UIStreamEvent 等形状
│   ├── legacy-sdk.ts         UI 侧兼容类型
│   ├── errors.ts / fork-turn-index.ts / utils.ts
├── webview-ui/               webview 侧（浏览器环境）
│   └── src/
│       ├── App.tsx           事件订阅总装（StreamEvent 等都在这里挂）
│       ├── components/       ~35 个聊天组件（ChatMessage、ApprovalDialog、FileChangesPanel…）
│       ├── inputarea/        输入框（文件选择、斜杠命令菜单、历史）
│       ├── stores/           zustand：chat.store、approval.store、settings.store、event-handlers
│       ├── services/         bridge.ts（postMessage RPC 客户端）、config、recommended-mcp
│       └── hooks/            useAppInit 等
├── docs/node-sdk-migration.md  ★ 架构设计文档（必读）
├── scripts/                  dev watch / VSIX 打包 / 冒烟
└── test/                     16 个 vitest 套件
```

`src/handlers/` 一文件一域：`chat`（发消息/中止/steer）、`session`（会话列表/resume/fork）、`config`（模型/effort）、`mcp`（MCR CRUD/OAuth/测试）、`auth`（OAuth 登录）、`file`（打开文件/diff/回滚）、`workspace`、`slash-command`、`types`、`index`（组装成总表）。

## 扩展宿主侧的启动链

1. **激活**：`package.json` 的 `activationEvents: []`——激活靠 `contributes.views` 声明的 `kimi.webview` view 隐式触发（VS Code 自动生成 `onView:kimi.webview`）。`activate()` 在 `src/extension.ts:19`。
2. `activate()` 依次：建 "Kimi Code" 输出通道（`src/extension.ts:20`）→ 实例化 `KimiWebviewProvider`（`src/extension.ts:24`）——构造链上**立即**创建 `BridgeHandler` 并在 `src/bridge-handler.ts:42` 起 `KimiRuntime`，引擎启动失败会直接抛错并附回退提示（`src/bridge-handler.ts:51-61`，"No silent fallback"）→ 检查登录态（`src/extension.ts:34`）→ 注册 `kimi-baseline` 虚拟文档 provider（`src/extension.ts:39-53`）→ 注册设置变更广播、view provider（`retainContextWhenHidden: true`）、10 个命令（`src/extension.ts:88-131`）→ 后台发现旧版数据（`src/extension.ts:133`）。
3. **引擎选择**只发生一次：`KimiRuntime` 构造函数里 `src/runtime/kimi-runtime.ts:65`——`options.useAgentCoreV1 ? createKimiHarness : createKimiHarnessV2`；该选项在 `config/vscode-settings.ts` 里由 `kimi.useAgentCoreV1` 设置或 `KIMI_CODE_LEGACY_FLAG` 环境变量解析，改设置需重载窗口才生效。harness 参数：`homeDir`（`KIMI_CODE_HOME` 或 `~/.kimi-code`）、`identity: { productName: "kimi-code-vscode", … }`、`uiMode: "vscode"`（`src/runtime/kimi-runtime.ts:66-76`）。
4. **会话与视图的路由**：`KimiRuntime`（`src/runtime/kimi-runtime.ts:51`）持有 SDK 的一个 harness 和 `Map<sessionId, SessionRuntime>`；侧边栏与 "Open in New Tab" 面板是多个 webview，可共享/refcount 同一会话（`openSession`，`src/runtime/kimi-runtime.ts:88` 起）。

## runtime/ 层：插件真正的心脏

| 文件 | 职责 |
|---|---|
| `kimi-runtime.ts` | 拥有 harness；webview↔会话路由；关闭/清理 |
| `session-runtime.ts` | **每个会话一个**：唯一的 SDK 事件订阅、prompt 生命周期（防并发重复发送）、审批/提问处理器挂接（`src/runtime/session-runtime.ts:93` 构造）。类声明在 `src/runtime/session-runtime.ts:70`，文件头注释点明"任意数量 webview 订阅而不互相覆盖审批处理器、不重复流事件" |
| `event-adapter.ts` | SDK 事件 → webview 的 `UIStreamEvent`（v1/v2 事件形状归一） |
| `replay-adapter.ts` | resume/replay 会话时重建 UI 状态（历史消息、工具结果折叠） |
| `reverse-rpc.ts` | **反向 RPC**：引擎要审批/要提问 → 推给 webview 弹窗 → 等用户点按钮 → resolve 给引擎 |
| `legacy-approval.ts` | 老的 `yolo`/`afk` 标志 ↔ 引擎 PermissionMode 的映射 |
| `tool-display.ts` | 工具输入 → 聊天区展示块（ToolRenderers 的数据源） |

为什么这层最重要：webview 的组件和 handlers 都是"平面"的胶水，而**会话状态机**（流式中、待审批、可 steer、compaction 进行中、错误抑制）全部集中在 `src/runtime/session-runtime.ts`。读懂它，插件就懂了八成。

## bridge 协议（shared/bridge.ts）

- `Methods`（`shared/bridge.ts:12-64`）：50 个 RPC 方法常量，从 `streamChat`、`respondApproval` 到 `openFileDiff`、`forkKimiSession`。加新交互通常就是这里加一个常量 + handlers 加一个分支 + webview 加一个调用。
- `Events`（`shared/bridge.ts:89-99`）：9 个宿主→webview 单向广播，如 `streamEvent`、`loginUrl`、`fileChangesUpdated`。
- webview 是**不可信**的：`validateRpcMessage`（`shared/bridge.ts:104`）在宿主侧任何 handler 运行前校验消息形状与方法白名单（`src/bridge-handler.ts:68` 调用）。
- webview 侧客户端：`webview-ui/src/services/bridge.ts`，调用形如 `bridge.streamChat(...)` → `this.call(Methods.StreamChat, …)`（`webview-ui/src/services/bridge.ts:187`）。

## 一条消息的完整旅程（断点就下在这些地方）

**发送路径**：

1. 用户在 `webview-ui/src/components/inputarea/InputArea.tsx` 提交 → `webview-ui/src/stores/chat.store.ts:191` 的 `sendMessage`；
2. → `webview-ui/src/services/bridge.ts:187` 发出 RPC `Methods.StreamChat`（postMessage）；
3. → 宿主 `BridgeHandler.handle`（`src/bridge-handler.ts:66`）校验后 dispatch 到 `src/handlers/chat.handler.ts:74` 的 `streamChat` 处理器（编辑器上下文注入、自动保存等前置处理都在这附近）；
4. → `src/handlers/chat.handler.ts:139` 调 `runtime.prompt(...)`（即 `SessionRuntime.prompt`）→ `session.prompt(input)`（SDK `Session` 对象）；
5. → SDK 内部（`packages/node-sdk`）把请求交给引擎——v2 默认路径经 klient memory transport 进 `agent-core-v2` 的 agent loop（从此进入 `04` 的范围）。

**回流路径**：

6. 引擎产生流式事件 → SDK `session.onEvent` → `SessionRuntime` 的唯一订阅（`src/runtime/session-runtime.ts` 构造时挂接）；
7. → `event-adapter.ts` 的 `adaptSdkEvent` 转成 `UIStreamEvent` → `broadcast(Events.StreamEvent, …)`；
8. → webview `webview-ui/src/App.tsx:23` 的 `bridge.on(Events.StreamEvent, …)` → `webview-ui/src/stores/event-handlers.ts:570` 的 `processEvent` 归约进 zustand → React 重渲染。

**中途被打断的分支**：

- 工具调用需要审批 → `reverse-rpc.ts` 推 `approval` 事件 → webview `ApprovalDialog` → 用户点击 → `Methods.RespondApproval` RPC → resolve 引擎的等待。
- 会话从历史恢复 → `replay-adapter.ts` 把 `wire.jsonl` 重放成 UI 状态。

## 其他子系统速览

- **Diff / File Changes**：`src/managers/baseline.manager.ts` 在 Write/Edit 工具执行前抓取文件快照存为基线；`src/handlers/file.handler.ts` 打开 diff 时用 `kimi-baseline:` 虚拟 scheme（`src/extension.ts:40` 注册的 provider 提供基线内容）与磁盘现状对比；Keep Changes / Revert 走 `src/managers/file.manager.ts`。
- **OAuth 登录**：`handlers/auth.handler.ts` 调 `harness.auth.login`，设备码流程的外链通过 `Events.LoginUrl` 推给 webview 弹出。
- **@文件引用、斜杠命令、模型/effort 切换、MCP 管理**：分别在 `bridge-handler.ts` 的 mention 处理、`handlers/slash-command.ts`、`handlers/config.handler.ts`、`handlers/mcp.handler.ts`。
- **没有的东西**（避免白找）：无集成终端集成（命令在引擎内执行、输出流回聊天区）、无状态栏、无 tree view——全部 UI 都在 webview 里。

## 推荐阅读顺序

1. `apps/vscode/README.md` + `docs/node-sdk-migration.md`（设计文档，先看运行时图和组件对照表）
2. `src/extension.ts` → `KimiWebviewProvider.ts`（骨架）
3. `shared/bridge.ts`（协议全貌，两分钟扫完常量表）
4. `src/bridge-handler.ts` → `src/handlers/chat.handler.ts`（一条 RPC 的宿主侧全链）
5. `src/runtime/`（重点，`session-runtime.ts` 精读）
6. `webview-ui/src/App.tsx` → `stores/chat.store.ts` + `event-handlers.ts`（UI 侧数据流）
7. `managers/baseline.manager.ts`（diff 子系统，读它练手正合适）

## 动手练习

- [ ] 按 `03-调试指南.md` F5 拉起插件，在 `src/handlers/chat.handler.ts:74` 与 `src/runtime/session-runtime.ts` 的事件订阅处下断点，发一条 "hi"，把调用栈抄下来——这就是你对本插件的第一张地图。
- [ ] 在 `shared/bridge.ts` 加一个无操作的新 Method，走通 handler + webview 调用（体会"三处联动"：协议常量、宿主 handler、webview 客户端）。
- [ ] 打开 diff 面板，断点观察基线快照的抓取时机（提示：从 `captureBaseline` 回调反向找）。

## 下一步

→ `03-调试指南.md`（把断点真正跑起来）
→ `04-agent引擎入门.md`（顺着 `session.prompt()` 往下钻引擎）
