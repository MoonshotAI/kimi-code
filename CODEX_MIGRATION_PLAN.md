# Rust-First 迁移计划（Codex 方向）— 详细版

> **📌 本文档是"TS 壳 → 纯 Rust 核心"迁移的唯一权威。**
> 状态：**框架定稿（2026-08-03），待逐阶段填充。**
> 方向（用户确认 2026-08-03）：**走 Codex 方向——核心全部 Rust，TS 只留前端与分发薄壳**。
> 参考资产：`D:/kimi/参考目录/_extracted_codex_full/codex-main`（codex-rs，60+ crates）。

## 1. 现状盘点（迁移输入）

| 域 | 包 | 规模 | 迁向 |
|---|---|---|---|
| 引擎 | `kimi-agent`（Rust） | 2011+ 测试 | crates/kimi-core（保留，拆分协议/状态） |
| native 工具 | `kimi-native-tools` / `kimi-shared`（Rust） | 617/47 测试 | crates/kimi-native-tools、kimi-shared（保留） |
| CLI+TUI | `apps/kimi-code`（TS） | **59k**（tui 41k、cli 9k、i18n 4k、utils 2.6k） | crates/kimi-cli、kimi-tui、kimi-exec |
| Web 后端 | `kap-server`（TS） | **24k** | crates/kimi-server、kimi-server-transport |
| 客户端 API | `node-sdk`（TS） | **25k** | crates/kimi-sdk |
| 客户端 API | `klient`（TS） | **18k** | crates/kimi-sdk（并入） |
| ACP | `acp-adapter`（TS） | **15k** | crates/kimi-acp |
| OAuth | `oauth`（TS） | **12k** | crates/kimi-oauth（PKCE 已 Rust） |
| 协议 | `protocol`（TS） | **10k** | crates/kimi-protocol |
| LLM 抽象 | `kaos`（TS） | **9k** | crates/kimi-sdk（部分）或保持薄 TS |
| 前端 | `kimi-web`/`vscode`/`vis`（TS/Vue） | 66k+ | **保持 TS**（纯前端） |
| 其他 | `telemetry`/`transcript`/`migration-legacy`/`i18n` | 17k | 按需并入或退役 |

## 2. 目标架构（参考 codex-rs 分层）

```
层1 协议层（纯类型，零 I/O）          kimi-protocol
层2 引擎层（零 stdout，事件流输出）    kimi-core / kimi-native-tools / kimi-shared / kimi-state
层3 宿主协议层（引擎包成 JSON-RPC）    kimi-server / kimi-server-transport / kimi-server-client
层4 界面层（只消费协议）              kimi-cli / kimi-exec / kimi-tui / kimi-sdk / kimi-acp / kimi-oauth
层5 前端/分发（保持 TS）              kimi-web(Vue) / vscode / npm 薄壳 / i18n 数据
```

**主线（抄 codex）**：引擎零 I/O → server 把引擎包成协议（MessageProcessor + in_process 用同一套 JSON-RPC envelope）→ 所有界面只消费协议。TS 壳与 Rust 边界 = Rust 类型 + `ts-rs` 生成 TS 绑定 + JSON Schema 契约测试。

## 3. 完整开发目录（逐 crate 规格）

### crates/kimi-protocol — 层1 纯类型
> 源：`kimi-agent/src/rpc/types.rs` + `packages/protocol` + `kap-server/src/protocol`（v1 wire zod）合并。

```
src/
├── lib.rs            # re-export
├── rpc.rs            # JsonRpcRequest/Response/Error、方法常量（现 types.rs 前半）
├── params.rs         # 各 RPC 方法 params（SessionCreateParams 等）
├── results.rs        # 各 RPC 方法 results（SessionStatusResult、McpServerListResult…）
├── event.rs          # 事件类型（现 agent.rs emit_event 形状 + protocol AgentEvent）
├── config.rs         # KimiConfig 类型（现 legacy/config-schema + types.rs config）
├── items.rs          # approval / question / task / usage / goal 类型
└── export.rs         # ts-rs/schemars 导出（TS 绑定 + JSON Schema 生成）
```
依赖：serde、serde_json、ts-rs、schemars。**零 tokio/axum**。

### crates/kimi-core — 层2 引擎
> 源：`kimi-agent/src`（主体迁入；rpc/ 移出到 kimi-protocol，persistence/ 移出到 kimi-state）。

```
src/
├── lib.rs
├── agent/            # Agent、TurnFlow、session_status、run_prompt（现 agent.rs）
├── session/          # session 生命周期、记录、持久化接口（调 kimi-state）
├── tools/            # 工具注册表、NativeToolset、fs_search、tool_dedup
├── context/          # context 类型、tokenizer、compaction 窗口
├── goal/  plan/  approval/  permission/  mcp/  skill/  compact/
├── llm/              # NativeHttpLlm（anthropic/openai/google）、config/native_llm
├── shell_command/  git/  media/  cron/  background/  task/
├── plugin/  config/  usage/  oauth/  kaos/
└── client.rs         # 模型客户端抽象（ModelClient/ModelClientSession，对应 codex core/client.rs）
```
约束：`#![deny(clippy::print_stdout)]`（对齐 codex core 零 I/O 纪律）；所有输出走事件流。

### crates/kimi-state — 层2 持久化
> 源：`kimi-agent/src/persistence/`（SqliteStore、SessionRecord）+ minidb 能力（SQLite 已 Rust）。

```
src/
├── lib.rs
├── store.rs          # SqliteStore（sessions/tasks/logs）
├── session_record.rs # SessionRecord/ModelConfig
└── schema.rs         # migrations
```
依赖：rusqlite（bundled）、serde。对齐 codex `state` crate（state_5.sqlite/logs_2.sqlite）。

### crates/kimi-server — 层3 宿主协议
> 源：`kap-server/src`（routes/services/protocol 的 Rust 化）+ `kimi-agent/rust-loop.ts` 协议化。

```
src/
├── lib.rs
├── processor.rs      # MessageProcessor（JSON-RPC 分发，对应 codex app-server）
├── request_processors/   # 按方法族拆（对齐 codex）：
│   ├── thread.rs     # session 生命周期（create/prompt/cancel/fork/export/delete）
│   ├── turn.rs       # turn 操作（steer/undo/activate_skill）
│   ├── fs.rs         # fs 浏览/读取（现 routes/fs、files）
│   ├── git.rs        # git status/diff
│   ├── config.rs     # config get/set/replace（现 routes/config + rust-loop config）
│   ├── mcp.rs        # mcp list/reconnect/startup_metrics
│   ├── skills.rs     # skills list/activate（现 routes/skills）
│   ├── plugins.rs    # plugins list/get
│   ├── approval.rs   # approval list/resolve（现 routes + reverse-rpc 面）
│   ├── usage.rs      # usage/snapshot
│   └── search.rs     # 全局搜索（现 routes meta/connections）
├── in_process.rs     # 内存通道嵌入（有界 mpsc 替代 socket，同 envelope）
├── session_service.rs # 会话服务（现 rustSession/RustSessionService 投影）
├── auth.rs           # auth 路由投影（现 routes/auth + services/auth）
├── catalog.rs        # 模型目录（现 routes/modelCatalog + node-sdk catalog）
└── export.rs         # 会话导出（现 routes/sessionExport）
```
依赖：tokio、serde、kimi-protocol、kimi-core。HTTP/WS 由 transport 层承载。

### crates/kimi-server-transport — 层3 传输
> 源：`kap-server/src/transport`（WS）+ `rust-loop.ts` stdio。

```
src/
├── lib.rs
├── transport.rs      # AppServerTransport 枚举（Stdio/UnixSocket/WebSocket）
├── stdio.rs          # stdio JSON-RPC（现 rust-loop stdio）
├── websocket.rs      # axum WS（现 kap-server WS frame fan-out）
└── auth.rs           # 连接认证（JWT/HMAC）
```

### crates/kimi-server-client — 层3 客户端门面
> 源：`node-sdk/src/rust`（RustRpcClient）+ `klient/src/transports/rust` 核心。

```
src/
├── lib.rs
├── client.rs         # AppServerClient{InProcess, Remote} 枚举（对应 codex app-server-client）
├── session_client.rs # 会话客户端（createSessionClient 等价）
└── events.rs         # 事件流订阅（必须送达/可丢分级）
```

### crates/kimi-cli — 层4 命令分发
> 源：`apps/kimi-code/src/cli`（commands/options/sub）+ main.ts。

```
src/
├── main.rs           # clap 分发器（对应 codex cli main.rs，约 30 子命令）
├── commands/
│   ├── acp.rs        # 现 sub/acp
│   ├── doctor.rs     # 现 sub/doctor
│   ├── export.rs     # 现 sub/export
│   ├── login.rs      # 现 sub/login + login-flow
│   ├── provider.rs   # 现 sub/provider
│   ├── upgrade.rs    # 现 sub/upgrade + update/
│   ├── vis.rs        # 现 sub/vis
│   └── web.rs        # 现 sub/web（启动 kimi-server）
├── options.rs        # SharedCliOptions（clap flatten，对应 codex utils/cli）
└── exit_status.rs    # 退出码
```
依赖：clap、clap_complete、kimi-server-client、kimi-exec、kimi-tui（无子命令时进入 TUI）。

### crates/kimi-exec — 层4 非交互执行
> 源：`apps/kimi-code/src/cli/run-prompt.ts` + `run-shell.ts` + `prompt-session.ts` + `headless-exit.ts`。

```
src/
├── lib.rs
├── run_main.rs       # -p/print 入口（对应 codex exec）
├── prompt.rs         # 单轮 prompt 执行（现 run-prompt）
├── shell.rs          # -s shell 执行（现 run-shell）
└── output.rs         # human / JSONL 输出（对应 codex exec --json）
```
与 kimi-tui **共用引擎与协议**（都走 kimi-server-client），仅换输出处理器。

### crates/kimi-tui — 层4 交互界面
> 源：`apps/kimi-code/src/tui`（41k，202 文件）+ `pi-tui`（依赖替换为 ratatui）。

```
src/
├── main.rs / lib.rs  # run_main → App::run（对应 codex tui）
├── app.rs            # 主事件循环（tokio::select 多源：内部事件/会话事件/键盘/服务器事件）
├── cli.rs            # TUI 专属参数（prompt/-a/--search，对应 codex tui/cli.rs）
├── custom_terminal.rs # 渲染终端（ratatui CrosstermBackend）
├── chatwidget/       # 对话主体（对应 codex tui/chatwidget）：
│   ├── transcript.rs # 会话记录渲染
│   ├── streaming.rs  # 流式输出
│   ├── tool_requests.rs # 工具调用卡片
│   ├── permission_popups.rs # 审批弹窗
│   └── slash.rs      # slash 命令（现 tui/commands 6k）
├── bottom_pane/      # 底部输入区：composer、textarea(vim)、footer、popup、mentions
├── components/       # 现 tui/components 20k：
│   ├── messages/     # 消息渲染 + tool-call + tool-renderers
│   ├── panes/        # 侧栏/面板（现 controllers 相关）
│   ├── dialogs/      # 对话框
│   ├── editor/       # 编辑器集成
│   └── media/        # 图片/媒体
├── controllers/      # 会话控制器（现 tui/controllers 4.5k）
├── reverse_rpc/      # approval/question 反向 RPC（现 tui/reverse-rpc 940）
├── theme.rs          # 主题（现 tui/theme 674）
├── markdown.rs       # markdown 渲染（pulldown-cmark + syntect）
└── history_cell/     # 消息/exec/mcp/patches 单元格（对应 codex）
```
依赖：ratatui、crossterm、pulldown-cmark、syntect、nucleo（模糊匹配）、kimi-server-client。

### crates/kimi-sdk — 层4 客户端 API 库
> 源：`node-sdk/src`（session.ts/rpc.ts/kimi-harness.ts/auth.ts/catalog.ts/rust/*）+ `klient` 核心。

```
src/
├── lib.rs
├── session.rs        # Session 类型（现 node-sdk session.ts）
├── harness.rs        # createKimiHarness 等价（现 kimi-harness）
├── auth.rs           # KimiAuthFacade（现 auth.ts）
├── catalog.rs        # 模型目录（现 catalog.ts）
├── events.rs         # 事件 API
└── legacy/           # config 兼容（现 legacy/*）
```

### crates/kimi-acp — 层4 ACP stdio 适配
> 源：`acp-adapter`。纯 stdio 适配器，经 kimi-server-client 驱动引擎。

### crates/kimi-oauth — 层4 OAuth 流程
> 源：`oauth` 包。PKCE 已在 kimi-shared（Rust）；流程状态机/device flow 迁入。

### crates/kimi-config — 层2/4 配置
> 源：`node-sdk/src/legacy/config` + `klient config`。TOML 读写、env overlay、diagnostics。

### crates/utils/* — 微 crate（对齐 codex utils/*）
```
path/       # 绝对路径/规范化（现 kimi-native-tools path_access + kaos）
cache/      # LLM 会话缓存（现 native-tools cache）
output_truncation/  # 输出截断（现 native-tools）
fuzzy_match/ # 模糊匹配（现 fs_search 评分）
pty/        # 伪终端（现 node-pty 依赖）
token_count/ # token 估算（现 kimi-shared tokens）
```

## 4. TS → Rust 映射表（逐模块）

| 现 TS 模块 | 规模 | 目标 crate/模块 | 阶段 |
|---|---|---|---|
| `kimi-agent/rust-loop.ts` | 3.4k | kimi-server-transport/stdio + kimi-server-client | B |
| `apps/kimi-code/src/cli/commands|options|main.ts` | ~3k | kimi-cli | C |
| `apps/kimi-code/src/cli/sub/*` | ~4k | kimi-cli/commands/* | C |
| `apps/kimi-code/src/cli/run-prompt|run-shell|prompt-session` | ~2k | kimi-exec | C |
| `apps/kimi-code/src/cli/native-session|adapter|rust-engine|session-engine` | ~4k | kimi-sdk + kimi-tui/controllers | C/D |
| `apps/kimi-code/src/tui/commands` | 6k | kimi-tui/chatwidget/slash | D |
| `apps/kimi-code/src/tui/components` | 20.5k | kimi-tui/components/* | D |
| `apps/kimi-code/src/tui/controllers` | 4.5k | kimi-tui/controllers | D |
| `apps/kimi-code/src/tui/reverse-rpc` | 940 | kimi-tui/reverse_rpc | D |
| `apps/kimi-code/src/tui/utils|theme|banner|constant` | 4.5k | kimi-tui/utils、theme.rs | D |
| `apps/kimi-code/src/i18n` | 4.2k | 数据保留 TS / kimi-tui 读 | D |
| `kap-server/src/routes/*`（17 文件） | ~10k | kimi-server/request_processors/* | B |
| `kap-server/src/services/*`（rustSession/auth/…） | ~6k | kimi-server/session_service、auth | B |
| `kap-server/src/transport`（WS） | ~2k | kimi-server-transport/websocket | B |
| `kap-server/src/protocol`（v1 zod） | ~4k | kimi-protocol（schemars 生成替代） | A |
| `node-sdk/src/rust/*` | ~5k | kimi-server-client | B |
| `node-sdk/src/session|rpc|harness|auth|catalog` | ~15k | kimi-sdk | E |
| `klient/src/*`（contract/core/transports） | 18k | kimi-sdk（并入） | E |
| `acp-adapter` | 15k | kimi-acp | E |
| `oauth` | 12k | kimi-oauth | E |
| `protocol` | 10k | kimi-protocol | A |
| `kaos` | 9k | kimi-sdk（LLM 面）或保留薄 TS | E |
| `kimi-web`/`vscode`/`vis` | 66k+ | 保持 TS（纯前端） | — |
| `telemetry`/`transcript` | 8k | 并入 kimi-core（回调）或薄 TS | E |
| `migration-legacy` | 7k | 自然退役 | F |

## 5. 依赖图

```
kimi-protocol ← kimi-core ← kimi-server ← kimi-server-transport
      ↑            ↑            ↑              ↑
      └────────────┴────────────┴── kimi-server-client
                                      ↑
        kimi-cli / kimi-exec / kimi-tui / kimi-sdk / kimi-acp / kimi-oauth ──┘
                                              ↑
                               kimi-web(Vue)/vscode/npm 薄壳（TS）
```

## 6. 阶段任务清单

### 阶段 A — 框架落地 ✅（2026-08-03 完成，commit 4b4db39e0 + 6681aec78）
1. `crates/` workspace 骨架（Cargo.toml members + workspace.dependencies）
2. `kimi-protocol` crate：rpc.rs（JSON-RPC envelope + impl）、methods.rs（81 方法常量）、wire_types.rs（session params/results）+ context/usage/task/plan/goal/hooks 模块（引擎 wire 类型下沉）
3. `types.rs` 1926 → ~100 行（re-export + `SessionCreateParams`，依赖带引擎 impl 的 DTO）
4. gen-wire-contract.mjs 多源 seed + 元组变体支持；wire.gen.ts **126 types**
5. **验证**：cargo test --lib 2027 绿；node-sdk/kimi-code typecheck 0；gen:wire 幂等
6. **ts-rs 决策**：离线环境（crates.io 不可达）无法引入 ts-rs/schemars；TS 绑定由 `gen-wire-contract.mjs` 生成（自研，从 kimi-protocol Rust 类型导出，已验证覆盖 serde default/rename/tagged/元组变体/跨文件引用）。联网后可评估 ts-rs 迁移（可选优化，非必需）。

### 阶段 B — 宿主协议层（方法族迁移完成 ✅）
1. ✅ `kimi-server` crate（MessageProcessor + in_process + ServerHostCallbacks/EventBus + ServerState/Server::build）
2. ✅ `kimi-server-transport`（stdio serve + **`kimi-server-serve` 二进制**：独立进程宿主，Remote 客户端经 stdio 驱动，端到端测试；**引擎事件扇出到 stderr**，Remote `--verbose` 免第二通道）
3. ✅ `kimi-server-client`（AppServerClient{InProcess, Remote} 门面；Remote 经 stdio 全链路测试）
4. ✅ **方法族迁移完成（11 processor）**：session **44 方法**（create/prompt/cancel/run_shell/cancel_shell_command/compact/save/load/delete/fork/export/set_model/set_thinking/set_swarm_mode/set_plan_mode/clear_context/get_context/get_status/list/get_usage/get_plan/get_warnings/list_mcp_servers/list_skills/undo_history/import_context/activate_skill/steer/goal 全生命周期/start_btw/end_btw/**init/destroy/clear_plan/get_mcp_startup_metrics/reconnect_mcp_server/list_tools/add_additional_dir/remove_additional_dir/update_metadata**）+ health/config(get+set)/fs/git/approval/plugin/permission(get/set_mode/**add_rule**)/cron/bg（register/list/get/stop/output/append_output/**settle/detach**）/task——宿主可服务的全部请求方法在 Rust 协议层，与 main.rs handler 同源（`agent/*`、`host/*` 属引擎侧 stdio 协议，由 kimi-agent 原生实现；bg/event、cron/fired 为事件流 wire 常量）
5. [ ] kap-server 测试平移（377 基线，TS 面，阶段 B 收尾可选；组 A 引擎 wire 缺口已补，见下）
6. **验证**：kimi-server 40 测试 + client 4 + exec 2 全绿；CLI 集成 13 + kimi-ui 6；workspace check 干净；0 warnings
   - **2026-08-05 增强（已实测）**：kimi-server **62**（A1–A7：export web_log 256KiB 校验/注入、fs:search、prompt 成功路径、config 容错、approval 缺 decision、bg 空态）、kimi-server-client 6、kimi-server-transport lib 4 + 集成 6、kimi-cli 36 集成、kimi-sdk runtime 18 + harness 6、kimi-acp 7——全绿 0 warnings
   - **传输并发化（2026-08-05）**：stdio + WebSocket serve 帧/行并发（对齐引擎 rpc/server.rs）；`StdioClient`/`WsClient` 后台读循环 + pending id 路由，`call(&self)` 不持锁等响应——挂起 prompt 不再阻塞同客户端 cancel；新测试 `serve_dispatches_concurrently`/`remote_client_concurrent_calls`/`websocket_dispatches_concurrently`/`ws_client_concurrent_calls`

### 阶段 C — CLI + exec
1. ✅ `kimi-cli`：clap 分发 + 子命令平移（print/sessions/resume/config/doctor/health/**export**；acp/login/provider/upgrade/vis/web 待）+ **全局 `--server <bin>`**：所有子命令可选走 Remote stdio 传输（独立 `kimi-server-serve` 进程），而非内嵌 server；**doctor 含 config 文件级检查**（OK/SKIP/ERROR + 合并解析验证 + `config <path>` 单文件校验 + tui.toml 存在性，TS parity）；**事件渲染**（turn/tool/usage → 进度行，内嵌与 Remote 统一；非 verbose 在 stderr 为 TTY 时同样渲染，脚本管道保持 stdout 契约）；**print/resume 默认可读转录**（`--json` 保留原始 RPC）；**`config --set KEY=VALUE`**（点路径写盘）；**`sessions --json`**；**裸 `kimi` 打印帮助 + 阶段 D 提示**
2. ✅ `kimi-exec`：-p/print + run_prompt 经 AppServerClient（InProcess/Remote）
3. ✅ **验证**：`kimi -p "..."` 端到端；CLI 集成测试（health/sessions/export/config/doctor/--server/verbose 事件流/裸调用，13 用例）；CLI 测试平移（55 用例，TS 面待）

### 阶段 D — TUI
0. ✅ `kimi-ui` crate（渲染原语：render_event 事件→进度行、last_assistant_text 转录提取、**EventSource 统一事件源**（内嵌 EventBus / Remote stderr 捕获，CLI/TUI 共用），6 测试）
1. `kimi-tui`：app 主循环 + custom_terminal + 事件流（ratatui 依赖，离线待引入；事件源与渲染原语已就绪）
2. chatwidget（transcript/streaming/tool_requests/slash）→ components/messages 平移
3. bottom_pane（composer/textarea/footer）→ controllers
4. reverse_rpc（approval/question）接线
5. **验证**：TUI 冒烟（VT100 终端仿真测试）；交互路径与 TS 版行为一致

### 阶段 C/D 期间修复的宿主缺陷（迁移测试驱动发现）
- `session/export` 丢失 base64 编码（zip 字节被序列化成数字数组）→ 已补 `STANDARD.encode`
- `config/set` 不建 `.kimi-code/` 父目录（新目录写失败 os error 3）→ 已补 `create_dir_all`
- `CronProcessor` 未调用 `manager.start()`（main.rs 有）→ `cron/get_next_fire` 永远 None → 已修
- `session/fs` action=list 从不传 Glob `pattern`（main.rs 同款 bug 继承）→ query→pattern 映射 + 缺 pattern 报错

### 阶段 E — SDK/ACP/OAuth/Config
1. 🔶 `kimi-sdk`：**`Harness`（内嵌/Remote + 事件流 + 审批面，3 集成测试）与 `Session`（生命周期全 + goal 系列 + transcript/run_prompt）已落地**；`kimi doctor` 已改经 SDK；klient 并入
2. 🔶 `kimi-acp`：**stdio 适配器已落地 + `kimi acp` 命令**（initialize 协商 + session/new/load/resume/list/delete/prompt/**get_config/set_config_option** + notification 语义，5 测试）；ACP 兼容测试继续；session/update 通知推送留待联网
3. `kimi-oauth`：**device flow 已落地 ✅**（authorize/poll/refresh + 本地 mock 3 测试 + `kimi login` 命令）；状态机细化待续
4. `kimi-config`：TOML/env/diagnostics——`kimi-sdk::catalog` 已落地 ✅（models.dev 拉取 + 类型 + live 测试），`kimi provider` 命令面完整；config 面继续
5. **验证**：SDK 测试平移（425 用例）；ACP 兼容测试；node-sdk/klient 转薄壳 re-export

### 阶段 F — 退役
0. ✅ **npm 分发薄壳**（kimi-code-rust-bin：bin 包装 + pack.mjs CI 打包 + KIMI_RUST_BIN 覆盖）
1. ✅ **入口切换 wrapper（已落代码）**：apps/kimi-code `bin: {kimi: bin/kimi.mjs}`——wrapper 优先平台 Rust 二进制（候选命名对齐 rust-bin pack.mjs：`kimi-<platform>-<arch>[.exe]` + 通用名，Windows 需 .exe；`KIMI_RUST_BIN` 显式覆盖），找不到回退 TS `dist/main.mjs`；spawn + SIGINT/SIGTERM/SIGHUP 转发 + 退出码/信号镜像（参考 codex-cli bin 模式）；`KIMI_ENTRY_DEBUG=1` 打印命中路径。迁移期双轨并存，Rust 全绿后删除 TS 入口（`smoke:entry` 冒烟覆盖两条路径）
2. ✅ **klient 退役（2026-08-05）**：`packages/klient` → `retired/klient`（99 文件 rename + Dockerfile 删），flake.nix workspacePaths/workspaceNames 移除；`.oxlintrc` 增 `retired/` + `scripts/` ignorePatterns（退役代码冻结 + 脚本有专项 CI 检查）；locale 脚本适配跳过 retired
3. 🔶 **包退役评估（2026-08-05，阻塞确认）**：kap-server/node-sdk/acp-adapter/oauth/protocol/kaos 移 `retired/` —— **暂不可执行**。实测消费图：`apps/kimi-code` src 仍真实 import `oauth`（auth/provider/telemetry/tui 15+ 文件）、`kaos`（rust-engine.ts）、`node-sdk`（harness/rpc/session）；`apps/vscode` 依赖 `node-sdk`。这些 TS 宿主按阶段 5 保持 TS 至 Rust 前端就绪，故包退役的**前置条件未满足**。退役顺序应为：先完成 kimi-sdk（Rust）对 node-sdk auth/harness/oauth 面的替代 → 再切 apps 消费 → 最后移 retired/。`kimi-cli` 36 集成测试中 `server_mode_verbose_emits_events` 为**环境依赖预存失败**（无可达 LLM 端点），非退役阻塞
4. npm 分发薄壳（参考 codex-cli：bin → 包装 Rust 二进制）
5. **验证**：CLI/TUI/web/API 全链路 Rust 端到端；旧 TS 测试删除或转 Rust

## 7. 风险与决策点

1. **TUI 框架**：ratatui/crossterm（评估是否跟 codex 的 nornagon fork——键盘增强/焦点事件；kimi TUI 需要交互增强则跟 fork）
2. **协议契约**：TS 绑定由 `gen-wire-contract.mjs` 从 kimi-protocol 生成（126 types，已验证）；ts-rs 因离线不可用暂不引入（联网后可选迁移）
3. **i18n**：4.2k 行文案 → 数据文件保留（TS 或 JSON），Rust 读；rust-i18n 或自建
4. **kaos SSH**：无 Rust 对应且无引擎需求——评估保留薄 TS 或裁剪
5. **双轨运行**：迁移期间 TS 壳与 Rust 宿主并行（同协议），逐步切换入口
6. **node-pty**：TUI 的 pty 依赖 → Rust 侧 portable-pty 或 windows-sandbox 方案
7. **kaos generate/流式**：已 Rust（kimi-agent/src/llm），TS kaos 仅 catalog/capability 残留
8. **McpServerSpecInput/SkillMetadataInput**：带引擎转换 impl（into_registration/into_metadata），暂留 kimi-agent；后续以 free-fn 重构下沉

## 8. 状态

- [x] 阶段 A 框架落地（kimi-protocol + workspace + wire 类型下沉）✅
- [x] 阶段 B 宿主协议层（kimi-server 52 测试 + transport/serve 二进制 + client InProcess/Remote 全链路）✅
- [x] 阶段 C CLI + exec（31 集成测试 + typed client + 配置读写闭环 + chat REPL + acp 命令 + print/resume 目标模式 + 全旗标对称）✅
- [ ] 阶段 D TUI（kimi-ui 前置 ✅ + chat REPL ✅ + **kimi-tui ✅**（ratatui 事件实时渲染/角色化转录/23 全命令面 Tab 补全/审批 y-n 交互+详情/approvals 命令/Esc-Ctrl-C turn 取消/目标生命周期/**llm.delta 文本+thinking 流式**/TestBackend 冒烟，13 测试））
- [ ] 阶段 E SDK/ACP/OAuth/Config（**kimi-sdk ✅**（Session 45/45 + Harness set_config + catalog）+ **kimi-acp ✅**（set_mode/set_model + session/update 通知回放）+ **kimi-oauth ✅**（device flow）+ **catalog ✅**（models.dev）+ provider/login/logout/acp--login 命令 ✅ + **WS 传输+客户端 ✅**（serve --ws + RemoteWs + e2e））
- [ ] 阶段 F 退役（**npm 分发薄壳 ✅ 已验证**：kimi-code-rust-bin 包装 + pack.mjs CI 打包；**入口切换 wrapper ✅ 已落代码**：apps/kimi-code `bin` → `bin/kimi.mjs` 优先 Rust 回退 TS，`smoke:entry` 冒烟两条路径通过；web/vis/upgrade 已识别；TS 删除待续）

## 9. 迁移推进会话快照（2026-08，分支 feat/rust-agent-engine-migration）

**2026-08-05 追加（Rust 端补全 goal 会话，未提交）**：
- **kap-server 测试缺口 A1–A7**：export web_log 256KiB 引擎侧校验（`MAX_WEB_LOG_BYTES`，export.rs）+ 注入/拒绝测试、fs:search 3 测试、prompt 成功路径（`with_llm_step` fake LLM）、config 容错、approval 缺 decision、bg/list 空态、Remote stdio 方法族冒烟 → kimi-server 53→**63**
- **传输并发化（stdio + WS）**：serve 行/帧并发（对齐引擎 rpc/server.rs）+ `StdioClient`/`WsClient` 后台读循环 + pending id 路由，`call(&self)` 不持锁等响应——挂起 prompt 不再阻塞同客户端 cancel；新测试 `serve_dispatches_concurrently`/`remote_client_concurrent_calls`/`websocket_dispatches_concurrently`/`ws_client_concurrent_calls`
- **引擎流式**：`NativeHttpLlm` SSE `llm.delta` 发射测试（本地 SSE 服务器）；llm.delta 设计核对（native 发/host 回调宿主发，非缺口）
- **SDK 补齐**：`Session::fork` turn_index（TS `fork({turnIndex})`）、`set_permission`、background task 四方法、`session.renamed` 事件（EventBus::emit + rename handler）、import markup 断言
- **核对关闭（9 项）**：llm.delta 设计、catalog 写面（kimi-cli Provider::Add 覆盖）、MCP 合并（McpManager::list 完备）、KIMI_CODE_HOME 技能解析（宿主面）、list workDir 过滤（TS 死选项）、config 深合并/KIMI_CONFIG_PATH/无效 patch（与 TS 对齐/设计差异）、bg stop 面
- **阶段 F**：`klient` 退役 ✅（retired/klient + flake.nix 两处移除，零包级消费者复核）
- **测试基线（实测）**：kimi-server **63**、kimi-sdk runtime **19** + harness 6 + catalog 2 + probe 1、kimi-server-transport lib 4 + 集成 6、kimi-server-client 6、kimi-cli 36、kimi-acp 7、kimi-agent http 9（全量 **2044 绿，0 挂起**）；`cargo check --workspace --all-targets` 0 errors/0 warnings
- **✅ 2026-08-05 挂起测试根因修复（commit 5b1ae85bb）**：`HostLlmProxy::is_retryable_error` 恒 true → 确定性 host llm_chat 错误被指数退避重试（10 次 ~2.5min，表现为挂起）。修复为仅 RateLimit/Overload/Transient 可重试。`cargo test -p kimi-agent --lib` = **2044 passed**，`cargo test --workspace` 解锁。
- **✅ 2026-08-05 CLI Remote 事件竞态修复（commit 7cf9ee6cd）**：print renderer.abort() 抢在 Remote stdio 管道事件到达前 → `server_mode_verbose_emits_events` 预存失败清零（abort 前 200ms drain），kimi-cli 集成 **36/36**。


**范围**：本会话在阶段 A/B/C ✅ 之上，完成阶段 D 全部（TUI 聊天组件 + 流式）与阶段 E 大部分（ACP/传输/SDK/config 面），并全面加固测试。

**新增/加固的 crate 与测试基线**：
- `kimi-server`：52 测试（12 方法族全覆盖：session 44 方法含 btw、bg 全、cron 全、approval 全、permission/plugin/fs/git/config/health/task）
- `kimi-cli`：12 子命令（print/sessions/resume/config/doctor/health/export/chat/acp/completions/provider/login/**logout** + upgrade/web/vis 识别）+ 全局 `--server` Remote 模式 + print/resume/chat `--model`、print/resume `--plan`、print/chat `--continue` + `doctor config|tui` + **login 持久化**（providers.kimi.apiKey）+ **--verbose 实时文本流式**（TTY 滚动）+ 31 二进制级集成测试
- `kimi-ui`：渲染原语（render_event 15/19 引擎事件类型 + last_assistant_text + **stream_delta**）+ `EventSource`，7 测试
- `kimi-sdk`：Harness（内嵌/Remote + 事件流 + 审批 + 列表/配置读写 set_config + 导出 + list_models + run_prompt）+ Session **44/44 方法面**（生命周期全 + goal + 模式控制 + steer/undo + fork/import/clear + btw/activate_skill + skill/plan/usage/mcp/warnings/tools/dir/metadata/destroy/init/cancel_shell 读面），7 测试
- `kimi-acp`：stdio 适配器 + `kimi acp` 命令（initialize + session 生命周期 + **set_mode/set_model** + notification 语义），6 测试
- `kimi-tui`：ratatui 聊天界面（角色化转录/23 全命令面 Tab 补全/审批 y-n+详情/turn 取消/目标生命周期/**llm.delta 文本+thinking 流式**/TestBackend 冒烟），13 测试
- `kimi-server-transport`：stdio + **websocket**（serve + `kimi-server-serve --ws`），7 测试（含二进制 WS e2e）
- `kimi-server-client`：AppServerClient{InProcess, **Remote** stdio, **RemoteWs** websocket}，4 测试
- 全 workspace 测试基线 **2890+**（kimi-agent 2027 + native-tools 617 + 宿主 260+）；**迁移测试驱动修复 12 个**（含 goal 孤儿/顺序类 6 个：run_turn 失败孤儿、print-goal 顺序、跨进程持久化、resume 顺序、--continue 加载、TUI/SDK load）；三传输路径（in-process/stdio/ws）全端到端通过

**本会话提交链（48，41→48）**：a008dd6dc 角色化转录+Tab 补全 → b60ffc5ab 审批 y/n → 66c663d6b TestBackend 冒烟 → 720cf5702 turn 取消 → 980fbf8fb chat 审批命令面 → 75e0142c6 upgrade/web/vis 识别 → 15fa8cffa print --model/--plan/--continue → 2ea0a0d72 审批详情 → 24c497cf0/2241e7e4e setup 旗标+回退 → de6387593 ACP set_mode/set_model → f4a6a307d WS 传输 → 7e7860c00 doctor tui → cbcf0aa19 llm.delta 流式 → 4596e8d7f llm.step 渲染 → f19cf536a WS 客户端 → 15027eabb SDK 44/44 → 7c26bc820 Harness::set_config → 0285086c5 serve_bin --ws e2e → 2f532d193 session/rename → 1206455be CLI 流式 → f678d1f98 旗标对称 → 1414d064d login 持久化+logout → d41c3ef0a thinking 流式 → 82aaf22ad 快照① → c1bc2a155 sessions updated_at → f841ab3b3 acp --login → 1ed1235a4 ACP 通知回放 → 54d0cb904 npm 薄壳验证 → da826c866 阶段状态刷新 → 9765b8963 config --delete → 9fb8a2013 日志 → f44a4cead lockfile → 9d62d3dc3 print resume 提示 → 3d04c7098 /undo /fork /steer → a2f03416e /import → 8eed1c93e doctor exit 1 → 4b1bd68f0 goal 孤儿三链路修复 → ed771c02c resume 顺序+--continue 加载 → d7acf6b33 TUI/SDK load 闭环 → 5b35ba989 resume TTY 捕获 → bce7444a7 chat --continue 测试 → **export 成功路径测试 → REPL /resume load → CLI thinking 流式 → 门禁结论/AGENTS.md/快照 ③ 等**

**迁移测试驱动的宿主缺陷修复（7 个）**：
- `session/export` 缺 base64 编码（zip 变数字数组）
- `config/set` 不建 `.kimi-code/` 父目录
- `CronProcessor` 未启动 scheduler（next_fire 永远 None）
- `session/fs` action=list 从不传 Glob pattern（永拒）
- chat/print goal 模式需先建 session 再 goal_create
- 引擎 llm.delta 已发但宿主静默/原始 JSON（stream_delta + TUI 流式接线）
- （附）测试基建：① 并行测试 KIMI_AGENT_HOME 环境变量竞争 → STORE_LOCK 串行化；② run() 共用 cwd 竞态 → 每次调用唯一 cwd

**离线边界更新（网络已恢复，2026-08）**：ratatui TUI、clap_complete、catalog（models.dev）、OAuth（kimi-oauth device flow）、npm 分发薄壳全部落地；剩余：ts-rs 绑定生成（可选）。

**下一步建议**：① 阶段 E 剩余：kimi-sdk 测试平移（TS 425 用例，大项）按需；② 阶段 F 剩余：TS 宿主退役（kap-server/node-sdk/klient/acp-adapter/oauth/protocol/kaos → retired/，Rust 全绿后删除 TS 入口）；③ 真实 LLM 端点恢复后的 `kimi print`/TUI 流式端到端验证（含 ACP 逐 token 通知）。
