# 05 · CLI 与服务器（深度版）

> 时效基线：基于 commit `d4e0ad4b2`（2026-08）。`apps/kimi-code`（npm 包 `@moonshot-ai/kimi-code`，bin `kimi`）是四种形态共同的组装入口：TUI / `-p` 打印模式 / `kimi web`（kap-server）/ `kimi acp`（ACP）四种形态。本文逐条讲每种形态的启动序列与服务面，全部 file:line 可核实。

## 一、CLI 入口：`main.ts` 启动序列

`main()`（`apps/kimi-code/src/main.ts:147`）：设进程标题 → 装 crash handler（`:149`）→ **staged native 更新检查**（`:154-164`，若有已暂存的原生更新则先换入并 re-exec，任何初始化之前）；失败回退 `bootstrap()`。

`bootstrap()`（`apps/kimi-code/src/main.ts:167`）全局预检按序：

1. `installGlobalProxyDispatcher()`（`:171`）——让所有 fetch 走 HTTP(S)_PROXY，**先于任何客户端存在**；
2. `installNativeModuleHook()`（`:172`）；
3. `installMinidbTextBuildWorker()`（`:175`）——SEA 场景的 minidb 全文 worker，失败有界内联回退；
4. `installKapSearchWorker()`（`:186`，实现在 `src/native/search-worker.ts:42`）——从 SEA blob 解出全局搜索 worker 并注册运行时路径；
5. `runNativeAssetSmokeIfRequested()`（`:194`，可能就此返回）；
6. 微任务里清理过期原生缓存（`:197-203`）；
7. `createProgram(...)`（`:207`）+ `program.parse`（`:283`）。

**commander 程序结构**（`apps/kimi-code/src/cli/commands.ts:20-185`）：根选项含 `-S/--session`、`-c/--continue`、`-y/--yolo`、`--auto`、`-m/--model`、`-p/--prompt`、`--output-format text|stream-json`、`--agent`、`--add-dir`、`--plan` 等（`:37-116`）；子命令 `export/provider/acp/web/login/doctor/vis/migrate/upgrade(别名 update)` + 两个隐藏内部命令（`:118-152`）。**无子命令时**默认 action（`:154-182`）：未知首 token 报错，否则合并选项成 `CLIOptions` 交给 `onMain`。

**`handleMainCommand`**（`apps/kimi-code/src/main.ts:60-94`）：`validateOptions`（`src/cli/options.ts:64-121`，互斥表：`-p` 不得配 `--yolo/--auto/--plan`、`--agent` 不得配 `--session/--continue` 等）→ **更新预检**（`src/cli/update/preflight.ts:782`：`KIMI_CODE_NO_AUTO_UPDATE` 开关、灰度桶、npm/pnpm/native 来源的后台静默自装、失败转交互）→ 分派：有 `-p` 走 `runPrompt`（headless），否则 `runShell`（TUI）。headless 收尾有讲究：排空 stdio 后挂 **unref 的强制退出定时器**（`src/cli/headless-exit.ts:29`）；失败路径在等日志刷盘前**同步**置 `process.exitCode = 1`（`apps/kimi-code/src/main.ts:235`，注释解释了为什么顺序不能反）。

## 二、`-p` 打印模式：引擎选择的分岔口

**引擎门**：`isKimiV2Enabled()`（`src/cli/experimental-v2.ts:25-35`）= `!KIMI_CODE_LEGACY_FLAG`——v2 是默认，v1 只在设了环境变量时启用。

一个重要认知：**`-p` 的 v2 路径不走 node-sdk，直接用引擎原生服务**。`runPrompt`（`src/cli/run-prompt.ts:98`）第一句就是引擎分岔（`:103`）；v2 侧 `runV2Print`（`src/cli/v2/run-v2-print.ts:119`）直接调 agent-core-v2 的 `bootstrap()`（`:144-161`），经 `ISessionManager.create` + `mainAgentBinding` 建会话（`:395-402`）、权限强制 `auto`（`:333-344`）、`IAgentPromptService.enqueue` 驱动 turn 并 await `turn.result`（`:439-458`）、订阅 agent 的 `IEventBus` 渲染事件（`:431-437`）。turn 结束后的存活策略（goal/cron/模式）是单循环 `applyPrintBackgroundPolicy`（`:731`）。v1 路径则用 `createKimiHarness`，审批处理器装成"全自动批准"（`apps/kimi-code/src/cli/run-prompt.ts:426-429`）。

## 三、TUI 装配（`runShell` + `src/tui/`）

与 `-p` 不同，**TUI 走 node-sdk harness**：`runShell`（`src/cli/run-shell.ts:40`）顺序：加载 `tui.toml` 主题 → 组 harness 选项 → **引擎选择**（`:88-91`，`createKimiHarnessV2` vs v1）→ `ensureConfigFile` → 旧数据迁移探测 → agent profile 选择 → `new KimiTUI(harness, {...})`（`:121-132`，传入 engineV2 标记）→ stty 保存/-ixon → crash handler → `tui.start()`。

`KimiTUI`（`src/tui/kimi-tui.ts:306`）：

- 构造（`:399-465`）：审批/提问控制器、`registerReverseRPCHandlers`（`:441-459`）+ 七个控制器（StreamingUI/AuthFlow/BtwPanel/SessionEvent/SessionReplay/TasksBrowser/EditorKeyboard）；
- `start()`（`:601-659`）：**信号处理器注册在 raw mode 之前**；**workspace 信任门是最早的交互**（`:615`，实现在 `:3724`——引擎的信任闸门在 TUI 呈现为首个弹窗）；迁移屏（可选）→ pi-tui 初始化/欢迎屏 → `finishStartup()` 里 `sessionEventHandler.startSubscription()`（`:809`）开始消费引擎事件；
- **事件→组件**：`SessionEventHandler`（`src/tui/controllers/session-event-handler.ts:207`）订阅 `session.onEvent`（`:216`），`handleEvent`（`:262`）按 `turn.started`/`assistant.delta`/`thinking.delta`/`tool.call.*`/`compaction.*`/`subagent.*`/`goal.updated` 分派——流式增量经 `StreamingUIController` 进 transcript，工具调用注册块数据；
- **终端里的审批**：`session.setApprovalHandler`（`apps/kimi-code/src/tui/kimi-tui.ts:2399-2410`）→ `ApprovalController` → `ReverseRpcModalCoordinator`（`src/tui/reverse-rpc/modal-coordinator.ts:15`，一个活动弹窗 + 队列）→ `showApprovalPanel`（`apps/kimi-code/src/tui/kimi-tui.ts:3938`）：挂起 pendingApproval、发 **OSC 终端通知**、把编辑器替换成审批面板组件，可展开输出全文或进全屏预览（`:3974`）；
- 布局：`createTUIState`（`src/tui/tui-state.ts:88`）——`ProcessTerminal` + `TuiAltScreen`（`KIMI_CODE_TUI_FULL_SCREEN=1`）或 `TuiMainScreen`，gutter 容器组出 transcript/activity/todo/queue/btw/editor 各区。改 TUI 前读 `.agents/skills/write-tui/SKILL.md`。

## 四、`kimi web`：CLI 侧 + kap-server 启动序列

**CLI 侧**（`src/cli/sub/web/run.ts`）：`handleWebCommand`（`:167`）解析选项（`--port/--host/--allowed-host/--insecure-no-tls/--allow-remote-terminals/--dangerous-bypass-auth/--debug-endpoints/--no-open` 等，`:108-165`；默认回环 127.0.0.1:58627）→ 进程内起 server → `onReady`（`:174-195`）**listen 之后**才读持久 bearer token（`<home>/server.token`，`apps/kimi-code/src/cli/sub/web/shared.ts:145`），打印 banner（红色警示 `--dangerous-bypass-auth`），打开 `#token=<令牌>` 片段携带令牌的 URL（`:96-105`——用 fragment 而非 query 避免进服务器日志）。SIGINT/SIGTERM → 排空关闭。

**kap-server `startServer`**（`packages/kap-server/src/start.ts:204`）十五步时序：

1. 解析 home/版本；**实例注册表**：`<home>/server/instances/` 写 `<serverId>.json`（`:209-218`，kimi-inspect 靠它发现实例；过期清扫）；
2. 暴露分类（`:219-228`）：**非回环拒绝启动除非 `--insecure-no-tls`**；`--debug-endpoints` 仅回环 + 显式 flag 才生效；
3. 非 loopback 的鉴权失败限流器（`:229-231`）；
4. **bearer token 服务**（`:235-244`，可选 `KIMI_CODE_PASSWORD`）；
5. **引擎 `bootstrap()`**（`:247-261`）——与插件/CLI 同一个 App scope 装配（在鉴权配置之后创建）；
6. 模型目录刷新调度器、workspace 目录同步、`ISessionIndex.prepare()`（`:287-309`）；
7. Fastify + 钩子链（`:311-341`）：请求日志→校验器旁路→错误处理→**DNS rebinding 主机检查**→CORS→bearer 鉴权钩子→非回环安全头；
8. `close()` 闭包（`:343-373`）：app.close → 退订 → 依次排空会话元数据/索引镜像/追加日志/搜索/日志 → 释放实例注册；
9. `ConnectionRegistry` + `TranscriptService`（`:375-377`，同时作为搜索的 live 数据源）+ `SessionEventBroadcaster`（事件日志目录 `<home>/server/events`）；
10. OpenAPI → `registerApiV1Routes` / `registerApiV2Routes` / `registerWsV1`（`:420-497`）；
11. **手工 `server.on('upgrade')`**（`:499-574`）：只放行 `/api/v1/ws`；主机检查 403 → 来源检查 403 → bearer（`Authorization` 头或 `sec-websocket-protocol` 子协议，`src/transport/ws/bearerProtocol.ts`）→ 升级；
12. `/asyncapi.json`、`/openapi.json`、dist-web 静态路由（`:582-595`）；
13. `listenWithPortRetry`（`:597`，`EADDRINUSE` 时端口 +1 最多试 100 个，`:661-694`）→ 更新实例注册端口 → 返回 `RunningServer`。

**dist-web 静态服务**（`packages/kap-server/src/routes/webAssets.ts:14`）：`index.html` 缺失快速失败；SPA fallback 带路径穿越防护（`:73-103`）；带哈希的 `/assets/*` immutable 缓存、其余 no-cache。

## 五、HTTP API 面（`/api/v1`）

注册于 `packages/kap-server/src/routes/registerApiV1Routes.ts:95`。精选清单（文件均在 `src/routes/`）：

| 路由域 | 文件 | 内容 |
|---|---|---|
| 元信息/鉴权 | `meta.ts` / `auth.ts` / `oauth.ts` | 服务器版本与 flags；登录态；OAuth 登录三段/用量/区 |
| 配置/模型 | `config.ts` / `modelCatalog.ts` | 读写 config；模型别名 + provider CRUD 与发现 |
| 会话 | `sessions.ts` | 列表/创建/动作分发/profile/标题生成/子会话/状态/goal；`v2/sessions.ts` 是按 workspace 分组的新查询面 |
| 消息/导出 | `messages.ts` / `sessionExport.ts` / `snapshot.ts` | 历史/ZIP 导出/快照（水位 + 在飞 turn + subagent） |
| 提示 | `prompts.ts` | `POST /prompts`、`::steer`、abort |
| 审批/提问 | `approvals.ts` / `questions.ts` | pending 列表 + `decide` |
| 工具/MCP | `tools.ts` | 工具清单 + MCP 服务器管理 |
| 文件/媒体 | `files.ts` / `fs.ts` / `workspaceFs.ts` / `sessionMedia.ts` | 上传下载、agent 可见 FS 工具、目录浏览 |
| 工作区 | `workspaces.ts` | 注册表 + 信任/取消信任 + 文件夹选择器 |
| 终端/任务 | `terminals.ts` / `tasks.ts` | PTY 会话（`--allow-remote-terminals` 门控）/后台任务 |
| 搜索 | `search.ts` | `POST /search` 全局全文（第七节） |
| transcript | `transcript.ts` | REST 兜底的 turn 粒度分页 + ops 补发端点 |
| 插件/技能/能力 | `plugins.ts` / `skills.ts` / `capabilities.ts` | 市场与开关 / 技能列表激活 / 能力安装 |
| 其他 | `connections.ts` / `guiStore.ts` / `shutdown.ts` / `fs.ts` 的 search/suggest | 连接注册表 / Web UI 的 localStorage 持久化 / 回环限定的关机 |

**会话触达模式**（所有路由共用）：`ISessionIndex.get/listRecent` 查摘要 → `getLiveSessionById`（`packages/agent-core-v2/src/app/sessionManager/sessionLookup.ts:50`）拿活句柄，不活则 `resumeSessionById` + `ensureMainAgent`（`packages/kap-server/src/routes/sessions.ts:1052-1059`）→ `handle.accessor.get(<服务>)`。注意：`packages/kap-server/AGENTS.md` 写的 `IWorkspaceLifecycleService.handlerFor` **在代码中不存在**，是过时措辞——以本段为准。

## 六、WS 层（`/api/v1/ws`）

- **连接生命周期**（`src/transport/ws/v1/wsConnectionV1.ts:82`）：注册进 `ConnectionRegistry` → 加入 broadcaster 全局扇出 → 立即发 `server_hello`（协议版本、心跳 10s、缓冲上限）→ 心跳收割（静默两周期）。入站帧经 `controlQueue` 串行化（`:214-217`）——**订阅状态写入永不交错**；连接后 `client_hello` 会再做一次令牌校验（纵深防御，`:489`）。
- **订阅模型**：全局事件族（`session.meta.updated`、`event.session/workspace/config/plugin/capability/di.*`，`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts:1255` 的 `isGlobalEvent`）**免订阅全发**；会话/agent 粒度事件只发给订阅了的连接，且遵守 per-connection 的 `AgentFilter` 白名单；`event.di.*` 只有 `client_id: 'kimi-inspect'` 的连接能收到。
- **断线重连补发**：broadcaster 给每个会话开事件日志 `<home>/server/events/<sessionId>.jsonl`（`packages/kap-server/src/transport/ws/v1/sessionEventJournal.ts:195`），非 volatile 事件派发时分配**持久 seq** 并落日志；重连带游标时 `replay()` 合并内存 tail + `journal.readSince(seq)`，日志已滚动则回 `resync_required`（原因：`buffer_overflow`/`session_recreated`/`epoch_changed`）。
- **节流**：订阅流量走 16ms/64 帧的批量缓冲 + 背压延迟（`:508-585`），**相邻的 `assistant.delta`/`thinking.delta` 帧合并**（`:675-697`）；控制帧立即发。
- **transcript 通道**：`subscribe_v2`（`packages/kap-server/src/transport/ws/v1/wsConnectionV1.ts:307`）带 per-agent 粒度（grade）与 `transcript_since` 游标。补发优先**精确重放错过的 op 批**（`getOpsSince` 环形日志命中时），否则发按粒度脱敏的 `transcript.reset` 快照；live 的 transcript 帧全部 **volatile**——携带水位 seq 但不推进 seq、不落日志（`buildTranscriptEnvelope`，`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts:524`）。这套 seq 语义的 schema 归属 `packages/transcript`（见 `06` 第 3 节）。

## 七、全局搜索

`POST /search`（`src/routes/search.ts:77`）→ `IGlobalSearchService`（`src/search/searchService.ts:268`）：flag `search_worker`（默认开，`KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER`）选 **worker 线程后端**（`SearchWorkerHost`，`src/search/worker/host.ts:56`：15s 就绪握手、每请求 60s 看门狗、崩溃指数退避、孤儿锁宽限）或内联后端；查询预算 32 词 / 500ms / 25 万 postings 访问（`:45-53`）；live transcript 作为增量同步源（`packages/kap-server/src/start.ts:377` 接线）。索引本体是 minidb（`06` 第 4 节）。

## 八、ACP 双代

**native（默认）**：路由在 `src/cli/sub/acp.ts:40-44`——默认走 v2 native，`KIMI_CODE_LEGACY_FLAG` 才落 legacy。`apps/kimi-code/src/cli/sub/acp-native.ts:30`：动态 import `@moonshot-ai/acp-server`（懒加载避免 CLI 解析期就启动引擎）→ `runAcpServer`。服务端 `packages/acp-server/src/start.ts:94`：`bootstrap()` 建 App scope → klient memory facade → 把出站 ACP 客户端绑进 `IAcpConnection` → 注册 `AcpRuntimeProviderFactory`。四个值得记住的机制：

1. **方法面**（`packages/acp-server/src/server.ts:696-713`）：`initialize/authenticate/logout/session/new|load|resume|list|close|delete|fork|setMode|setConfigOption|prompt|cancel`；
2. **事件翻译**：`AcpSession`（`packages/acp-server/src/session.ts:177`）订阅 agent 事件流一次性翻译成 `session/update`（`agent_message_chunk`、`tool_call`/`tool_call_update` 的 lazy-create 与 REPLACE 语义有明确文档，`:764-772`）；
3. **审批桥**（`packages/acp-server/src/interaction-bridge.ts:34`）：`interactions.changed` → ACP `requestPermission`；提问优先 `elicitation/create`（客户端声明支持时），否则降级 request_permission；
4. **文件与终端反向 RPC**：`AcpHostFileSystem`（`packages/acp-server/src/acp-fs/acpFsService.ts:1`）以 Session 级 `IHostFileSystem` 影子替换本地实现——引擎的 **Edit 工具经 ACP `fs.readTextFile/writeTextLines` 在编辑器侧落盘**；Bash 在客户端声明 terminal 能力时反向 RPC 到客户端终端执行。

**legacy（v1）**：`apps/kimi-code/src/cli/sub/acp.ts:46-136` 用 `createKimiHarness`（`uiMode: 'acp'`）+ `@moonshot-ai/acp-adapter` 的 `runAcpServer`，文件布局与 acp-server 镜像（session/approval/question/convert/events-map），底层换成本仓的 v1 SDK 面与每会话 `AcpKaos` 沙箱。

## 九、其他子命令速查

| 命令 | 文件 | 一句话 |
|---|---|---|
| `login` | `src/cli/sub/login.ts:13` | 设备码 OAuth，可选区（mainland-cn/global） |
| `provider` | `src/cli/sub/provider.ts:454` | 非交互 provider 管理：从自定义 registry 批量导入/删除/列表/目录 |
| `doctor` | `src/cli/sub/doctor.ts:83` | 校验 config.toml/tui.toml，有 ERROR 退出 1 |
| `export` | `src/cli/sub/export.ts:110` | 会话 ZIP 导出（CLI 胶水，导出本体在引擎） |
| `vis` | `src/cli/sub/vis.ts:103` | 进程内起会话可视化（vis-server 动态 import），自动选端口开浏览器 |
| `upgrade`/`update` | `src/cli/sub/upgrade.ts` + `apps/kimi-code/src/main.ts:101` | 手动更新：刷新缓存→选目标→安装（标记 `--manual`） |
| `__update_download`（隐藏） | `src/cli/sub/update-download.ts:84` | native 自装下载器：版本锁、在飞下载收养、暂存待下次启动换入 |
| `migrate` | `src/migration/command.ts` | 旧数据迁移（复用 runShell 的迁移屏） |

## 十、读代码切入顺序与练习

顺序：`main.ts` → `commands.ts` → `run-shell.ts`（TUI 装配）→ `tui/kimi-tui.ts` 的 `start()` 与 `session-event-handler.ts`（事件→组件）→ `cli/sub/web/run.ts` → `kap-server/src/start.ts`（对照第四节时序逐行认）→ `transport/ws/v1/sessionEventBroadcaster.ts`（本包最复杂的服务）→ `acp-server/src/start.ts`。

练习：

- [ ] `pnpm dev:server` + kimi-inspect 建会话发消息，浏览器 DevTools 看 `server_hello`/`subscribe`/`transcript.ops` 帧的时序；断线重连（刷新页面）观察 `transcript_since` 补发；
- [ ] 断点 `startServer` 十五步中的实例注册与 token 解析，对照 `<home>/server/instances/` 与 `server.token`；
- [ ] `kimi -p "..."` 跑一次，断点 `runV2Print`，确认它没经过 node-sdk（调用栈里没有 KimiHarness）；
- [ ] 读 `sessionEventBroadcaster.ts` 的 `isGlobalEvent` 与 `enqueueDurable`，回答：哪些事件会进 `<home>/server/events/*.jsonl`、哪些只走内存？
- [ ] 用支持 ACP 的编辑器连 `kimi acp`，在 `AcpHostFileSystem` 断点观察一次 Edit 的反向落盘。

## 下一步

→ `06-支撑包速览.md`（transcript/minidb/oauth 等的实现深读）
