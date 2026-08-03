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
2. ✅ `kimi-server-transport`（stdio serve）
3. ✅ `kimi-server-client`（AppServerClient{InProcess, Remote} 门面）
4. ✅ **方法族迁移完成（11 processor）**：session **44 方法**（create/prompt/cancel/run_shell/cancel_shell_command/compact/save/load/delete/fork/export/set_model/set_thinking/set_swarm_mode/set_plan_mode/clear_context/get_context/get_status/list/get_usage/get_plan/get_warnings/list_mcp_servers/list_skills/undo_history/import_context/activate_skill/steer/goal 全生命周期/start_btw/end_btw/**init/destroy/clear_plan/get_mcp_startup_metrics/reconnect_mcp_server/list_tools/add_additional_dir/remove_additional_dir/update_metadata**）+ health/config(get+set)/fs/git/approval/plugin/permission(get/set_mode/**add_rule**)/cron/bg（register/list/get/stop/output/append_output/**settle/detach**）/task——宿主可服务的全部请求方法在 Rust 协议层，与 main.rs handler 同源（`agent/*`、`host/*` 属引擎侧 stdio 协议，由 kimi-agent 原生实现；bg/event、cron/fired 为事件流 wire 常量）
5. [ ] kap-server 测试平移（377 基线，TS 面，阶段 B 收尾可选）
6. **验证**：kimi-server 27 测试 + client 2 + exec 2 全绿；workspace check 干净；0 warnings

### 阶段 C — CLI + exec
1. ✅ `kimi-cli`：clap 分发 + 子命令平移（print/sessions/resume/config/doctor/health/**export**；acp/login/provider/upgrade/vis/web 待）
2. ✅ `kimi-exec`：-p/print + run_prompt 经 AppServerClient（InProcess/Remote）
3. **验证**：`kimi -p "..."` 端到端；CLI 测试平移（55 用例）

### 阶段 D — TUI
1. `kimi-tui`：app 主循环 + custom_terminal + 事件流
2. chatwidget（transcript/streaming/tool_requests/slash）→ components/messages 平移
3. bottom_pane（composer/textarea/footer）→ controllers
4. reverse_rpc（approval/question）接线
5. **验证**：TUI 冒烟（VT100 终端仿真测试）；交互路径与 TS 版行为一致

### 阶段 E — SDK/ACP/OAuth/Config
1. `kimi-sdk`：session/harness/auth/catalog 平移；klient 并入
2. `kimi-acp`：ACP stdio 适配
3. `kimi-oauth`：流程状态机
4. `kimi-config`：TOML/env/diagnostics
5. **验证**：SDK 测试平移（425 用例）；ACP 兼容测试；node-sdk/klient 转薄壳 re-export

### 阶段 F — 退役
1. apps/kimi-code 的 TS 删除（clap 入口切到 kimi-cli）
2. packages/kap-server/node-sdk/klient/acp-adapter/oauth/protocol/kaos 移 `retired/`
3. npm 分发薄壳（参考 codex-cli：bin → 包装 Rust 二进制）
4. **验证**：CLI/TUI/web/API 全链路 Rust 端到端；旧 TS 测试删除或转 Rust

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
- [ ] 阶段 B 宿主协议层（kimi-server + transport + client）
- [ ] 阶段 C CLI + exec
- [ ] 阶段 D TUI
- [ ] 阶段 E SDK/ACP/OAuth/Config
- [ ] 阶段 F 退役
