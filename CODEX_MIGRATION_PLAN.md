# Rust-First 迁移计划（Codex 方向）— 详细版

> **📌 本文档是"TS 壳 → 纯 Rust 核心"迁移的唯一权威。**
> 状态：**框架定稿（2026-08-03），方向收紧（2026-08-06），待逐阶段填充。**
> 方向（用户确认 2026-08-03）：**走 Codex 方向——核心全部 Rust，TS 只留前端与分发薄壳**。
> 方向（用户收紧 2026-08-06）：**只有 web 是 TS。除浏览器前端外，一切 TS 迁 Rust 或退役。**（本修订节优先于旧表述）
> 参考资产：`D:/kimi/参考目录/_extracted_codex_full/codex-main`（codex-rs，60+ crates）。

---

# 2026-08-06 修订：只有 web 是 TS（权威版）

## R-1. 目标定义（收紧自 2026-08-03 版）

旧目标允许"前端与分发薄壳"留在 TS。本次收紧为：

> **最终只有浏览器前端是 TS。** 其余所有 TypeScript——CLI/TUI 宿主、server、SDK、协议、OAuth、ACP、LLM 抽象、i18n 数据、rust-loop 桥——全部迁入 Rust 或退役。

| 类别 | 保留 TS | 说明 |
|---|---|---|
| ✅ 保留（web 前端） | `kimi-web`(Vue3, 25.9k) / `kimi-inspect`(8.6k) / `vis/web`(≈6k) | 浏览器 UI，纯前端 |
| ✅ 保留（前端壳，非引擎逻辑） | `vscode`(18.7k) / npm bin 包装(`kimi.mjs` 几 KB) | VS Code 宿主 API 必须 JS；webview 归 web。仅壳，逻辑全走 Rust RPC |
| ❌ 迁 Rust | 见 R-3 迁移三态表 | 全部宿主层 |
| ❌ 退役 | `pi-tui`(13.2k) / `transcript` / `migration-legacy` / `klient`(已退) / TS i18n 数据 | TUI 迁 Rust 后 pi-tui 无存在意义 |

**明确不建**：`sdk/typescript`。codex 保留了一个 2.9k 的 TS SDK，但按本决策我们不建——外部消费者使用 `kimi-sdk`(Rust) 或 HTTP 协议。`i18n` 文案沉淀为 JSON 数据文件（非 TS 源码）。

## R-2. codex 校准规模（2026-08-06 实测）

codex 全 Rust 分层的规模 = 我们迁移目标的下限参考：

| codex crate | Rust 行数 | 我们的对应 | 现状（实测） |
|---|---|---|---|
| `core` | 161k | kimi-agent（保留） | **99k** ✅ |
| `tui` | **206.8k** | kimi-tui | TS 41k → **Rust 3.4k**（长杆） |
| `cli` | 19.7k | kimi-cli | TS 9k → Rust 2.8k |
| `app-server(+protocol/transport/client/daemon)` | 88k | kimi-server 系 | TS 16k → Rust 7.5k |
| `exec` + `exec-server` | 20.1k | kimi-exec | TS 2k → Rust 0.2k |
| `codex-api` | 10.3k | kimi-sdk | TS 16k → Rust 2.4k |
| `protocol` / `config` / `state` | 54.6k | kimi-protocol/config/state | TS 5.2k → Rust 2.2k |
| `login` | 8.4k | kimi-oauth | TS 5.5k → Rust 0.3k |
| **`sdk/typescript`** | 2.9k | **不建** | 按 R-1 决策取消 |

**当前语言构成（实测，排除 dist/生成物）**：TS src **232k** + TS test 167k；Rust **147k**（含内联测试）。迁移完成后：TS 仅剩 web+壳 ≈ **60k**，Rust ≈ **240k+**，比例从 1.6:1 反转为 **Rust 主导（≈75%+）**，TS 全部为前端 UI 与分发包装。

## R-3. 迁移三态表（全部 TS 按此归类）

| 现 TS 包 | 行数 | 处理 | 目标 |
|---|---|---|---|
| `apps/kimi-code` TUI | 41k | 迁 Rust | kimi-tui（长杆，见 R-4 分片） |
| `apps/kimi-code` CLI | 9k | 迁 Rust | kimi-cli（大部分已落地） |
| `apps/kimi-code` i18n/utils/constant | 9.4k | 迁/数据化 | kimi-tui + JSON 数据 |
| `kap-server` | 16.2k | 迁 Rust | kimi-server（骨架已有 6.3k） |
| `node-sdk` | 16.2k | 迁 Rust | kimi-sdk（骨架已有 2.4k） |
| `kosong` | 11.1k | 迁 Rust | kimi-sdk LLM 面 |
| `oauth` | 5.5k | 迁 Rust | kimi-oauth（device flow ✅） |
| `acp-adapter` | 5.4k | 迁 Rust | kimi-acp（✅ 已落地） |
| `protocol` | 5.2k | 迁 Rust | kimi-protocol |
| `kaos` | 3.1k | 退役/并 | SSH 面评估后裁并 |
| `transcript` / `telemetry` | 5k | 退役/并 | 引擎回调 / 并入 kimi-core |
| `migration-legacy` | 4.2k | 退役 | 数据迁移一次性，退役 |
| `pi-tui` | 13.2k | 退役 | kimi-tui 完成后删除 |
| `kimi-agent` 内 TS（rust-loop 3.4k + runtime 兼容 4k） | 7.4k | 退役 | Rust transport 已覆盖；runtime 兼容层缩至最小或删 |
| `kimi-web`/`kimi-inspect`/`vis/web`/`vscode` | 60k | **保留** | 唯一 web/壳 |

## R-4. 收口路线（在阶段 A–F 之上新增，最终指向 web-only）

> 阶段 A–E 已完成/大部分完成（见 §6/§8 历史）。R-4 是**把 TS 宿主从 232k 清到 ≈60k** 的执行顺序，按"杠杆 × 自包含 × 消费依赖"排序：

| 步 | 内容 | 规模 | 前置 |
|---|---|---|---|
| **G-0** | 基线锁定：`cargo test --workspace` 全绿 + TS 侧存量冻结（新增 TS 逻辑先与 Rust 核对） | — | — |
| **G-1** | `node-sdk → kimi-sdk` 补齐（session/harness/auth/catalog/legacy 全部面）→ `apps` 消费点(221 refs) 逐个切 Rust | 16k | 消最大消费面，解锁包退役 |
| **G-2** | `kap-server → kimi-server`（routes/services/protocol 全量）→ `kimi web`/kimi-inspect 改连 Rust server | 16k | G-1（共用 client 面） |
| **G-3** | `apps/kimi-code` CLI 消费面切 `kimi-cli`（auth/provider/telemetry 面，native-session 已完成 plugin/cron/archive） | 9k | G-1/G-2 |
| **G-4** | `apps/kimi-code` TUI → `kimi-tui` 分片搬运（**长杆**）：① app 主循环/事件源 ✅ → ② chatwidget 组件树（components/messages 20k）→ ③ bottom_pane/controllers → ④ theme/media/reverse_rpc → ⑤ 对拍测试 | 41k | G-3 |
| **G-5** | `kosong/kaos/protocol` LLM 面并入 kimi-sdk/kimi-protocol；`transcript/telemetry` 收编 | 20k | G-1 |
| **G-6** | 退役：`node-sdk/kap-server/acp-adapter/oauth/protocol/kaos` → `retired/`；删 `rust-loop.ts`、TS i18n、TS 入口 `dist/main.mjs`、`pi-tui` | — | G-1..G-5 全部 |
| **G-7** | web-only 验证：CLI/TUI/API 全 Rust 端到端；`kimi-web`/`kimi-inspect`/`vscode` 直连 Rust server；删除全部旧 TS 测试 | — | G-6 |

**G-4 TUI 推进（2026-08-06，chatwidget 组件树起步）**：
- **历史 transcript 渲染 tool-call 卡片 ✅**（`crates/kimi-tui/src/transcript.rs`）：`parse_history` 从 text 二元组改为 `HistoryPart`（Text/ToolCall/ToolResult），解析 `tool_use`/`tool_result` 内容部件——恢复会话时显示 `⚙ name(args)` / `⚙ → result` 卡片（参数/结果压到 120 字符单行）。修 2 个解析 bug（tool_result 被并进 text、缺 input 时 args="null"）。kimi-tui **56/56 绿**
- **实时 tool 事件渲染增强 ✅**（`crates/kimi-ui/src/render.rs`）：`session.tool.started` 显示参数 `tool Read({...})`、`session.tool.settled` 显示结果 `tool Read -> ok: file contents`（80 字符预览）。kimi-ui 11/11 绿
- **通用 Selector 组件 ✅**（`crates/kimi-tui/src/picker.rs`）：交互选择器（↑/↓ 移动、Enter 选择、Esc/Ctrl-C 取消，空列表直接 None）；已接线 **4 处**：`/model`（无参弹别名选择器）、`/skills`（name+description 选择器，选中显示详情）、`/sessions`（picker 切换会话，与 `/resume` 共用 `switch_to_session` 提取方法，消除重复）、启动 session picker（重构复用，删除重复 `PickerState`/`render_picker`）。kimi-tui **57/57 绿**
- **状态/用量可读化 ✅**：`/status` 渲染 `model · mode · permission · thinking · ctx` 单行摘要（`format_status`）、`/usage` 渲染 `total (in/out)`（`format_usage`），不再裸 JSON；各 +1 纯函数测试。kimi-tui **59/59 绿**
- **B3 事件渲染全覆盖 ✅**（`crates/kimi-ui/src/render.rs` + app 事件循环）：`render_event` 支持 `kind` 判别（cron 调度器发 `CronFireEvent` 用 `kind` 无 `type`——此前裸 JSON 漏判）；丰富 `session.goal.updated`（status+objective/cleared）、`session.approval.requested`（tool_name+args）、新增 `cron.fired`（job+schedule+prompt）；app 未知事件静默跳过（TS 对齐）。**所有引擎会话事件均有意义渲染**
- **B4 命令面对齐 ✅**（+10 命令 → 46 总）：新增 `/permission`（set_permission）/ `/yolo` / `/auto` / `/new`（fresh session）/ `/init`（agents.md）/ `/title`（重命名）/ `/mcp`（MCP 列表）/ `/tasks`（后台任务）/ `/theme` / `/version`；同步 SLASH_COMMANDS + COMMAND_HELP + needs_session。TS 42 命令剩余多为架构明确不支持（workflow/dispatch/web）或纯前端（editor/theme 选择器）
- **B5 交互流 ✅（可达部分）**：`/permission` 无参弹模式选择器（manual/plan/auto/yolo）；`/theme` 真正切换 dark/light（App 增 `dark_mode` 字段，Theme 加 PartialEq）；审批流已有（y/n、v 详情、/approve /deny /approvals）
- **⚠️ AskUserQuestion 提问流 = 引擎级缺口**：`AskUserQuestion` 工具**未注册进引擎 NativeToolset**（`packages/kimi-agent/src/tools/mod.rs` 工具集无它），模型无法调用 → TUI 提问弹窗无从触发。需引擎侧先注册工具 + host 回调路径，再补 TUI 提问对话框（列入后续）

**G-4 分片细则（参照 codex tui 结构）**：`kimi-tui` 现为 chat REPL(5 文件/3.4k，ratatui)。按 codex `tui/`（app/ chatwidget/ bottom_pane/ render/ streaming/ status/）分片：先 `components/messages` 渲染树（tool 卡片/审批/媒体，**tool 卡片已起步 ✅**），再 `controllers` 事件路由，最后 `theme`/`markdown` 收口。**每片以 TestBackend 冒烟 + 与 TS 版行为对拍为完成标准。**

**G-2 缺口盘点（2026-08-06，kap-server 20 路由 vs kimi-server 13 processor）**：
> **✅ G-2 HTTP 投影层已补全（2026-08-06 完成并提交）**：`kimi-server-transport/src/http.rs` 现覆盖
> sessions 全套 / fs(list/read/search/browse/home) / config / skills / tools / snapshot / transcript /
> usage / plan / mcp-servers / export / workspaces / auth / models / providers / ws / **meta** /
> **shutdown** / **oauth/login(start/poll/cancel)** / **connections**——kap-server 除
> guiStore/webAssets（宿主专属，随分发薄壳）外全部路由有 Rust 投影。web 前端零改动可连 Rust server。

| kap-server 路由 | 规模 | kimi-server 现状 |
|---|---|---|
| `rustSessions.ts` / `fs.ts` / `config.ts` / `files.ts` / `sessionExport.ts` / `skills.ts` / `tools.ts` / `shutdown.ts` | ~2.3k | RPC 面已由 session/fs/config/skill 等 processor 覆盖 ✅；缺 **HTTP 投影层** |
| `snapshot.ts` / `transcript.ts` / `workspaces.ts` / `connections.ts` / `meta.ts` | ~780 | vis/kimi-inspect 的 replay/workspace 面——**Rust 无对应** |
| `modelCatalog.ts` | 651 | kimi-sdk::catalog 已有模型目录逻辑；**HTTP 投影缺失** |
| `oauth.ts` / `auth.ts` | 301 | kimi-oauth + kimi-sdk::auth 已具备逻辑；**HTTP 投影缺失** |
| `guiStore.ts` / `webAssets.ts` / `action-suffix.ts` / `registerApiV1Routes.ts` | 555 | 宿主专属（GUI 状态/静态资源/路由注册），随分发薄壳处置 |

**关键结论**：kimi-server 的 **RPC processor 面已基本齐全**；G-2 的真正缺口是 **HTTP/REST 投影层**（web 前端要连的东西）。kimi-server-transport 目前只有 stdio + WS JSON-RPC。这引出一个设计决策：
- **A：在 Rust 复刻 kap-server 的 REST `/api/v1` 投影**（axum 路由），web 前端不改协议；
- **B：web 前端改走 JSON-RPC-over-WS**（kimi-server-transport 已有），免建 REST 层，但 kimi-web/vscode/vis 要改连接层。
倾向 A（前端零改动、投影薄、复用现有 processor）；B 可作长期收敛方向。**待用户定案。**

## R-5. 与旧目标的差异点（冲突时以 R 节为准）

1. **取消 TS SDK**：不建 `sdk/typescript`（codex 保留，我们不保留）。
2. **rust-loop.ts 退役**：旧计划把它"保留为桥接层"；现在 Rust transport 已全链路可用，直接退役。
3. **npm 薄壳缩到纯 bin 包装**：`kimi-code-rust-bin` 的 JS 只做 spawn 转发（几 KB），不承载任何逻辑。
4. **i18n 数据化**：4.2k 文案 → JSON，非 TS 源码。
5. **`transcript`/`telemetry` 不再"保持薄 TS"**：收编进 Rust 或退役。
6. **阶段 F 的"TS 前端保留"范围**从"全部前端"缩到"仅 web/壳"。

---

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

> **✅ 2026-08-05 宿主面补全批次（缩小 node-sdk Rust 桥接 nativeUnavailable 缺口，commit a7d390c4f/ea1349f30/048516139）**：
> - **plugin 写面**：kimi-server 新增 `plugin/install`（github/url/local 三源路由）、`plugin/set_enabled`、`plugin/set_mcp_enabled`（server 校验 + 整体开关近似）、`plugin/remove`、`plugin/reload`；kimi-sdk Harness 暴露 7 个 plugin 方法；node-sdk 桥接 5 个 `nativeUnavailable` → 真实引擎调用（6 单测 + 2 集成）
> - **cron 面**：kimi-sdk Session 暴露 `list/create/delete_cron_tasks`（cron/list 协议层已存在）
> - **removeKimiProvider**：宿主 config 语义（读 config.toml 删 `providers.kimi` 写回），替代 nativeUnavailable
> - **set_swarm_mode trigger + undo_history count**：kimi-sdk 签名对齐 node-sdk（engine 已支持 trigger/count），更新 kimi-tui/测试调用点
> - **session/cancel_compact**：引擎 compact 同步（无在途异步可取消）→ no-op 成功（`{cancelled:true}`），替代 nativeUnavailable；node-sdk 桥接接线
> - **✅ 2026-08-05 archiveSession 补全（commit 232a829c4）**：`session/archive` 协议方法——manager `archive_session`（metadata.archived 标记 + 保留记录 + 丢弃 live agent），kimi-sdk `Session::archive`，node-sdk 桥接接线
> - **✅ 2026-08-05 plugin commands 补全（commit 232a829c4）**：引擎 manifest 支持 `commands` 字段（Markdown 文件/目录；文件名=命令名，首行=描述）；`plugin/list_commands` + `plugin/activate_command`（展开 `$ARGUMENTS` 后作为 prompt turn 发送）；kimi-sdk Harness `list_plugin_commands`/`activate_plugin_command`；node-sdk 桥接（listPluginCommands 聚合所有插件，activatePluginCommand 转发）
> - **✅ node-sdk Rust 桥接 nativeUnavailable 全部消除**：`archiveSession`/`cancelCompaction`/`activatePluginCommand`/`listPluginCommands` 及此前的 plugin 写面全部接线为真实引擎调用——**零 nativeUnavailable 调用残留**
> - **基线**：kimi-agent 2045（+1 manifest commands 测试）、kimi-server/sdk/protocol 全绿、node-sdk 34 文件 429 测试全绿；clippy 0 新 warning
>
> **✅ 2026-08-05 宿主面收尾（TS 宿主接入 Rust 能力）**：
> - kimi-sdk Harness 补 `close_session`/`fork_session`/`rename_session`（commit 8c1dd3650）
> - TUI 宿主 `native-session` plugin 写面接线（install/enable/mcp/remove/reload/list_commands/activate 全部替代 naError stub，commit f56c75ae6）+ `cancelCompaction` 接线（commit baf37445e）
> - TUI `/archive` + REPL `/archive`、`/steer` 命令（commit 600cb1ae6/dbb23e9e4/3eb3448e5），SLASH_COMMANDS 29
> - 测试策略：**重写而非平移**（用户定案）——TS 用例平移跳过
>
> **✅ 2026-08-05 CLI 收尾（2 个真实补全）**：
> - `kimi login` 自动打开浏览器（commit 33fbdc654）：std-only 跨平台 opener（start/open/xdg-open），优先 verification_uri_complete 深链；打印 URL+code 保留为手动兜底（TS login-flow parity）
> - `kimi provider remove <id>`（commit 64a93b383）：null-patch 删除 `providers.<id>`（strip_null_deletes，同 logout 杠杆），对齐 node-sdk removeProvider；集成测试覆盖往返
> - **退役评估复核**：apps/kimi-code 仍真实 import `oauth` 13 处（auth/provider/telemetry/TUI）+ `kaos` 1 处（rust-engine LocalKaos）——退役仍被宿主 OAuth/provider 编排阻塞，非引擎能力可替代
> - **阶段 F 入口可行性验证**：release 版 kimi-cli 构建成功，`--version`/`health`/`doctor`/`sessions`/`acp` 全链路可用——Rust 入口切换核心功能已验证

### 阶段 F — 退役
0. ✅ **npm 分发薄壳**（kimi-code-rust-bin：bin 包装 + pack.mjs CI 打包 + KIMI_RUST_BIN 覆盖）
1. ✅ **入口切换 wrapper（已落代码）**：apps/kimi-code `bin: {kimi: bin/kimi.mjs}`——wrapper 优先平台 Rust 二进制（候选命名对齐 rust-bin pack.mjs：`kimi-<platform>-<arch>[.exe]` + 通用名，Windows 需 .exe；`KIMI_RUST_BIN` 显式覆盖），找不到回退 TS `dist/main.mjs`；spawn + SIGINT/SIGTERM/SIGHUP 转发 + 退出码/信号镜像（参考 codex-cli bin 模式）；`KIMI_ENTRY_DEBUG=1` 打印命中路径。迁移期双轨并存，Rust 全绿后删除 TS 入口（`smoke:entry` 冒烟覆盖两条路径）
2. ✅ **klient 退役（2026-08-05）**：`packages/klient` → `retired/klient`（99 文件 rename + Dockerfile 删），flake.nix workspacePaths/workspaceNames 移除；`.oxlintrc` 增 `retired/` + `scripts/` ignorePatterns（退役代码冻结 + 脚本有专项 CI 检查）；locale 脚本适配跳过 retired
3. 🔶 **包退役评估（2026-08-05，阻塞确认）**：kap-server/node-sdk/acp-adapter/oauth/protocol/kaos 移 `retired/` —— **暂不可执行**。实测消费图：`apps/kimi-code` src 仍真实 import `oauth`（auth/provider/telemetry/tui 15+ 文件）、`kaos`（rust-engine.ts）、`node-sdk`（harness/rpc/session）；`apps/vscode` 依赖 `node-sdk`。这些 TS 宿主按阶段 5 保持 TS 至 Rust 前端就绪，故包退役的**前置条件未满足**。退役顺序应为：先完成 kimi-sdk（Rust）对 node-sdk auth/harness/oauth 面的替代 → 再切 apps 消费 → 最后移 retired/。`kimi-cli` 36 集成测试全绿（`server_mode_verbose_emits_events` 预存失败已修复，见 commit 7cf9ee6cd）
>
> **✅ 2026-08-05 退役消费图全量复核（commit 5edb85fdc 后续）**：逐包源码 import + 包级依赖双维交叉验证——**全部候选包均不可退役**（闭环依赖：apps/kimi-code 本身是 TS 分发，依赖这些包，而这些包服务 apps/kimi-code）：
> | 包 | 源码 refs | 依赖方 | 结论 |
> |---|---|---|---|
> | node-sdk | 221 | kimi-code/vscode/acp-adapter | 🔴 活跃 |
> | kosong | 21 | vis-server/acp-adapter/kimi-agent/node-sdk/oauth | 🔴 活跃 |
> | oauth | 30 | kimi-code/node-sdk | 🔴 活跃 |
> | kaos | 17 | kimi-code/acp-adapter/migration-legacy/node-sdk | 🔴 活跃 |
> | transcript | 11 | kimi-inspect/kap-server | 🔴 活跃 |
> | migration-legacy | 9 | kimi-code/vscode | 🔴 活跃 |
> | protocol | 8 | vis-server/node-sdk | 🔴 活跃 |
> | kap-server | 7 | kimi-code(web 子命令)/kimi-inspect | 🔴 活跃 |
> | i18n | 7 | 多宿主 | 🔴 活跃 |
> | i18n-shared | 0 refs | i18n 内部依赖 | 🔴 保留（i18n 用） |
> | telemetry | 6（kimi-telemetry） | kimi-code | 🔴 活跃 |
> | acp-adapter | 2 | kimi-code | 🔴 活跃 |
> | minidb | 0 | 无 | ✅ 已在 retired/ |
> **结论**：退役的真正前置是 **apps/kimi-code 切 Rust 入口**，但它是 TS 分发且依赖这些包——鸡生蛋闭环。当前唯一可执行的是**增量替代**（kimi-sdk 已对齐 harness/session 面，native-session 已接入 Rust plugin/cancelCompaction/archive），逐步减少对 node-sdk 宿主面的依赖。
>
> **✅ 2026-08-05 宿主面缺口复核（三域全量对比，结论：协议/工具/CLI 均无实质缺口）**：
> - **协议方法**：TS 调用的 83 个 RPC 方法（`packages/kimi-agent/rust-loop.ts` 唯一桥接层）在 `crates/kimi-protocol/src/methods.rs`（91 常量）全部存在——**TS 有 Rust 缺 = 0**。Rust 独有 8 个（`agent/health`、`agent/shutdown`、`session/destroy`、`session/rename`、`git/status`、`git/diff`、`cron/fired`、`bg/event`）为新增能力，非缺口；`session/rename` 已被 kimi-sdk `rename_session` 覆盖。
> - **工具**：TS 旧引擎（retired/agent-core）工具 vs Rust `NativeToolset`（read/write/edit/grep/glob/bash/todolist/fs_search/web_search/fetch_url/read_media）+ 引擎级（goal/task/swarm/swarm_discussion/knowledge/memory/ask_user/skill/plan/mcp）。**真正缺口仅 2 个**：GitHub 工具族（30 个，含 GitHubSearchCode，`kimi-native-tools/src/github.rs` 已有 HTTP 基础层，中期建议聚合 1-2 个工具而非 30 个）+ `Workflow`（agent-core-v2 编排，Rust background+Swarm 已覆盖，不建议补）。其余为改名/合并（Agent→Task、GetGoal/SetGoalBudget→GoalStatus）或宿主注册类（Plan/Task/Cron 引擎侧已有基础设施）。用户关注领域全覆盖：网页搜索（WebSearch/FetchUrl）、本地代码搜索（Grep/Glob/FsSearch）、图像处理（ReadMediaFile）均 Rust 原生。
> - **CLI 子命令**：Rust 12+ 子命令（print/sessions/resume/config/doctor/export/acp/completions/provider/login/logout/upgrade/web/vis）vs TS 10 个（acp/doctor/export/login/login-flow/plugin-run-node/provider/upgrade/vis/web）——login-flow 由 `acp --login` 覆盖；`plugin-run-node` 是 Node 插件宿主（Rust 迁移版不需要）；upgrade/web/vis 为分发说明 stub（符合 Rust-first 方向）。
> - **TUI 命令**：kimi-tui 36 + REPL 31 命令，TS 26+ 全命令面覆盖（本批次补 /reload）。
>
> **✅ 2026-08-05 GitHub 工具族移植（commit c6f82e52c）**：对比结论中的唯一实质工具缺口（GitHub 29 工具）已补全——`packages/kimi-agent/src/tools/github.rs`：表驱动 specs + reqwest 执行（GITHUB_TOKEN/GH_TOKEN auth、GITHUB_API_URL 企业 base、Link 分页 MAX_PAGES 上限）+ `GitHubToolInterceptor`（HostCallbacks 装饰器，同 MemoryToolInterceptor 模式）+ `GITHUB_READONLY_TOOL_NAMES` 白名单（mutating 工具 manual 模式仍提示审批）；agent.rs 接线（tool_defs + 装饰链）。17 测试（spec 完备性 vs TS 29 工具/读写分类/schema/path/query/body/分页/approval subject + 4 个 loopback server 集成：GET auth+path、POST JSON body、分页聚合、404 传播）。kimi-agent lib 2047→**2064**；TS 侧 `Workflow` 工具评估后不补（Rust background+Swarm 已覆盖）。
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

> **2026-08-06：方向收紧为"只有 web 是 TS"（见顶部 R 节）。后续推进以 R-4 的 G-0..G-7 收口路线为准；A–F 阶段为历史进度。**

- [x] 阶段 A 框架落地（kimi-protocol + workspace + wire 类型下沉）✅
- [x] 阶段 B 宿主协议层（kimi-server 52 测试 + transport/serve 二进制 + client InProcess/Remote 全链路）✅
- [x] 阶段 C CLI + exec（31 集成测试 + typed client + 配置读写闭环 + chat REPL + acp 命令 + print/resume 目标模式 + 全旗标对称）✅
- [ ] 阶段 D TUI（kimi-ui 前置 ✅ + chat REPL ✅ + **kimi-tui ✅**（ratatui 事件实时渲染/角色化转录/23 全命令面 Tab 补全/审批 y-n 交互+详情/approvals 命令/Esc-Ctrl-C turn 取消/目标生命周期/**llm.delta 文本+thinking 流式**/TestBackend 冒烟，13 测试））
- [ ] 阶段 E SDK/ACP/OAuth/Config（**kimi-sdk ✅**（Session 45/45 + Harness set_config + catalog）+ **kimi-acp ✅**（set_mode/set_model + session/update 通知回放）+ **kimi-oauth ✅**（device flow）+ **catalog ✅**（models.dev）+ provider/login/logout/acp--login 命令 ✅ + **WS 传输+客户端 ✅**（serve --ws + RemoteWs + e2e））
- [ ] 阶段 F 退役（**npm 分发薄壳 ✅ 已验证**：kimi-code-rust-bin 包装 + pack.mjs CI 打包；**入口切换 wrapper ✅ 已落代码**：apps/kimi-code `bin` → `bin/kimi.mjs` 优先 Rust 回退 TS，`smoke:entry` 冒烟两条路径通过；web/vis/upgrade 已识别；TS 删除待续）

## 9. 迁移推进会话快照（2026-08，分支 feat/rust-agent-engine-migration）

**2026-08-06 G-2 进展（kimi-server-transport HTTP/REST 投影）**：
- **web 前端切 Rust 三件套 ✅（2026-08-06）**：
  1. **静态资源托管**：`router_with_assets` + `serve_web`（axum `ServeDir`，SPA 兜底 index.html），`--http ... --assets <dir>` 一条命令同时服务 API + SPA + WS（冒烟：`/`→200、`/app.js`→200、`/api/v1/health`→ok）
  2. **Bearer 认证**：`AuthConfig` + `require_auth` 中间件（REST `Authorization: Bearer`，拒绝返回 envelope `code:40101`，kap-server 契约）+ WS `kimi-code.bearer.*` 子协议校验；serve 二进制读 `KIMI_CODE_PASSWORD` / `<KIMI_CODE_HOME>/server.token`（**修 BOM 坑**：PowerShell UTF8 BOM 不被 Rust trim 移除，需 `trim_start_matches('\uFEFF')`）；`--no-auth` 门控。实测三态：无 token→40101 / 正确→0 ok / 错误→40101
  3. **`kimi web` 切换**：`startRustServerForeground`（spawn `kimi-server-serve --http --assets` + 健康探测 + SIGINT 清理），`KIMI_WEB_RUST_SERVER=1` 门控启用（默认仍 kap-server）；kimi-code typecheck 通过
- **待浏览器验证**：`KIMI_WEB_RUST_SERVER=1 kimi web` 跑一遍，确认 SPA 加载 + WS 事件流 + auth token 流全链路
- **`http.rs` HTTP 投影层 ✅**（`crates/kimi-server-transport/src/http.rs`，axum 0.8）：`/api/v1` 路由 → 同一 `MessageProcessor` 的 JSON-RPC 投影，响应复用 kap-server `{ code, msg, data, request_id }` envelope。已实现 **40+ 路由**：health / config get+set / sessions list+create / session status+update+delete+fork+archive+prompt+cancel+skills+tools+context+usage+plan+mcp-servers+export（zip 二进制下载）+approval resolve+snapshot+transcript / fs:action 三件套 + fs:browse+fs:home / auth readiness + models + providers（list/create/replace/delete）+ workspaces / **`/api/v1/ws`：JSON-RPC + 引擎事件广播**（`ServerState::event_sender` → 每 WS 连接 fan-out）。serve 二进制新增 `--http <addr>` 模式（`serve_with_events` 挂事件源）。
- **测试**：lib 8（health envelope + 404）+ `http_e2e.rs`（内嵌 Server + reqwest 全流程）→ transport 全绿 **15/15**；`kimi-server-serve --http` 二进制实跑冒烟（health/create/list 全通）
- **验证**：`cargo check --workspace` 通过
- **剩余**：① web 前端连接层切 `--http`（kimi-web/vscode/vis 从 kap-server 改连 Rust server，逐路由对拍——这是把"Rust server 存在"变成"前端真在用"的关键，涉及保留 TS 前端）② G-3 CLI 消费面 ③ G-4 TUI 长杆 ④ G-5 收编 ⑤ G-6 退役 ⑥ G-7 验证

**2026-08-06 G-3 批次 1：CLI 行为对齐（kimi-cli ↔ TS CLI 硬缺口，用户范围：P0+P1 不含遥测/自更新）**：
- **`kimi print`/`resume` 补全（TS run-prompt/prompt-render/goal-prompt parity）**：
  - `--output-format text|stream-json`（JSONL：`JsonlWriter` 累积 assistant 文本/tool_calls，`session.tool.started`→`{role:assistant,tool_calls}`、`tool.settled`→`{role:tool,...}`、`turn.ended`→flush；TS `PromptJsonWriter` 对齐）
  - 文本块渲染：kimi-ui `render_prompt_block`（`• ` bullet + `  ` 缩进 + 终端宽度 wrap，TS `PromptBlockWriter` 对齐；修 UTF-8 字节/字符宽度坑——`"• ".len()` 是 4 字节，须 `chars().count()`）
  - `/goal <objective>` 前缀解析（`parse_headless_goal`，TS `parseHeadlessGoalCreate` 对齐）+ goal summary（`{"type":"goal.summary",goalId,status,reason,turnsUsed,tokensUsed,wallClockMs}`，引擎 GoalSnapshot 为 camelCase 与 TS 一致）+ **终态退出码 complete→0 / blocked→3 / paused→6**
  - `--yolo`/`--auto` 权限模式（kimi-exec `PromptSetup.permission_auto` → `permission/set_mode {mode:"auto"}`；`--yolo` 与 `--auto` clap 互斥）
  - `--json` 与 `--output-format stream-json` 运行时互斥检查
- **`provider` 命令面重构（消除同名不同义）**：`provider list` 改为列**已配置** provider（config 读，apiKey 脱敏 `***`，空态提示）；新增 `provider catalog list [id] [--filter] [--json]` / `catalog search <q>` / `catalog add <id>`（原 list/search/add 迁入）；`provider add <url>` 对齐 TS registry 语义（api.json 批量导入，`--api-key` 或 `KIMI_REGISTRY_API_KEY`，无 key 报错）；`provider remove` 未知 id 报错（TS parity）
- **`doctor` 输出对齐 TS**：`Kimi doctor` 标题 + `STATUS label(12) path` 行 + 缩进错误消息 + `All checked config files are valid.` / `Kimi doctor found N issue(s).` + exit 1（保留 health/config 摘要为附加块）；`doctor config|tui [path]` 单文件模式显式缺失 → ERROR（SKIP 带 "defaults will apply" 消息）
- **`export` 对齐 TS**：无 id 时 TTY 交互确认 `[Y/n]`（非 TTY 仍要求 `-y`）；`--include-global-log`（默认 on，`--no-include-global-log` 关闭）→ 读 `<KIMI_CODE_HOME>/logs/global/kimi-code.log` 作为 `session/export` 的 `web_log` 打进 zip
- **`kimi web` 实现（替换 stub）**：内嵌 `kimi-server-serve --http` 等价（`run_web`：in-process Server + event_sender + AuthConfig + `router_with_assets`），参数对齐 TS `--port/--host/--dangerous-bypass-auth/--no-open/--assets`；auth 解析同 serve 二进制（KIMI_CODE_PASSWORD → server.token 读/生成写盘）；Ctrl-C/SIGTERM 优雅关闭；SPA 由 `--assets` 提供（Rust 分发不打包前端）
- **`-S/--session` + TUI picker（P2-8）**：`-S`/`-r` 可选值旗标（`Option<Option<String>>` + `default_missing_value` 哨兵）；无子命令时 `-S <id>` 绑定会话 / 裸 `-S` 开 picker（`App::new(None)`）/ 无 `-S` 新建 `kimi-<pid>`
- **`login` 收敛**：去掉 refresh token 回显（TS parity，防敏感信息泄漏）
- **测试**：headless_tests 单测 5（/goal 解析/goal summary/JSONL writer 累积+tool/web auth）+ kimi-ui prompt_block 2 + cli.rs 更新（doctor 格式/provider catalog list/provider list 已配置）+ 新增（provider remove 未知报错 / print json 互斥）——kimi-cli bin 单测 6 + kimi-ui 10 + kimi-exec 4 全绿
- **待办**：① P1-6 遥测、P1-7 自更新（用户定案本批不做）② ACP slash-commands 广告核实 ③ `kimi print` 真实 LLM 端到端（stream-json 事件流验证）④ G-3 批次 2：选项冲突校验全量（-p/--yolo/--auto/--plan/--session 12 条规则 clap 化）

**2026-08-06 G-4 分片 A+C：TUI 会话恢复历史渲染 + 补全参数集**：
- **差距分析**（kimi-tui 8 文件 2471 行 vs TS TUI 203 文件 40.8k）：分片排序 A（历史渲染）> B（审批面板）> C（补全升级）；确认 question 侧引擎设计"工具内容+下条消息"（TS native `setQuestionHandler` 同为 no-op）→ 无需反向 RPC；审批走"事件→approvals()→队列→RPC 决策"与引擎授权回调自洽
- **分片 A：会话恢复历史渲染 ✅**（resume 一片空白是最大体验缺口）：
  - 新增 `crates/kimi-tui/src/history.rs`：纯函数 `render_history`（TS `session-replay hydrateFromReplay` 对齐）——`session/get_context` 的 `history` → `TranscriptLine`（user→`▶`、assistant→`⚙` 工具行 + 文本、tool→`⚙`、system/空内容跳过）；4 单测（顺序/工具行/tool 消息/空过滤）
  - `app.rs` `run()`：`session.load()` 后 `get_context()` → `render_history` 追加到 transcript（"session ready" 之前）
- **分片 C：补全参数集扩展 ✅**：`bottom_pane.rs` `complete_line` 加 `/permission`（manual|plan|auto|yolo）与 `/session`（set）参数集（TS registry 参数补全规格对齐）；测试扩展
- **验证**：kimi-tui 33 全绿（29 基线 + history 4 + bottom_pane 补全扩展）；`cargo check --workspace` 0 errors
- **分片 B：审批面板化（详情 + approve-for-session）✅**（2026-08-06）：
  - `PendingApproval` 增加完整 `arguments` JSON 字段（列表保留 80 字符预览）
  - **`v` 键详情**：回合中按 `v` 显示当前审批的完整参数（多行 status：id/tool/rule/args）
  - **`s` 键 approve-for-session**：当前审批的 rule 记入 `auto_allow_rules`（App 字段，会话内记忆）→ 后续同 rule 审批在 `request_approval` 拉取时**自动 resolve allow**（`queue_new_approvals` 返回 auto_resolve 列表，不入队不打断）；提示行更新 "y/n, v=details, s=for-session"
  - 测试：`auto_allow_rules_skip_queuing`（命中规则不入队、返回 auto-resolve id）+ `queues_approvals_with_dedup` 适配新签名 → kimi-tui **34** 全绿
- **待办**：工具调用卡片（结构化 tool 条目/结果折叠 Ctrl-O）；补全弹窗；媒体渲染；审批面板视觉化（DisplayBlock diff/shell/file 全屏预览，当前为 transcript 行详情）

**2026-08-06 G-4 分片 D：工具调用卡片（结果折叠 Ctrl-O）✅**：
- `TranscriptLine` 增加 `collapsed` 字段 + `tool_collapsed` 构造（长工具结果行起始折叠）
- `tool_result_collapsed` 判定（>120 字符）；`pump_one_event` 对 `session.tool.settled` 长结果行用折叠态
- **Ctrl-O 双向 toggle**（`toggle_last_tool_collapse`：最后一个 Tool 结果行——折叠/多行/长文本参与，started 短行不动）
- chatwidget `styled_lines`：折叠行单行预览 + `[+]` 标记；展开行逐行渲染（首行 `⚙` 前缀）
- 测试：`tool_result_collapse_and_toggle`（短不折叠/长折叠/双向 toggle/无操作）+ chatwidget 2（折叠 `[+]` 单行 / 展开多行）→ kimi-tui **37** 全绿；workspace 0 errors

**2026-08-06 G-4 分片 E：补全弹窗（slash 命令列表）✅**：
- `CompletionState`（pub：matches + selected）；`completion_for_input` 自由函数——输入为裸 `/前缀`（无空格）时列出匹配 `SLASH_COMMANDS`
- `refresh_completion` 在每次输入编辑（字符/退格/删除/光标移动）后刷新；输入含空格或普通文本时关闭
- 键盘分支：弹窗激活时 **↑/↓ 移动选中、Enter 填入选中命令并关闭、Esc 先关弹窗**（二次 Esc 退出）
- chatwidget `render_frame` 加 completion 参数：弹窗覆盖 chat 面板底部（`commands` 边框 + 选中 `▶` 高亮）
- 测试：`completion_popup_matches_bare_slash_prefix`（/s 匹配、普通文本/空格/无匹配关闭）→ kimi-tui **38** 全绿；workspace 0 errors

**2026-08-06 G-4 分片 F：审批面板视觉化（全屏 modal）✅**：
- `v` 键从"transcript 行详情"升级为**全屏审批 modal**（`approval_detail` 字段 + `render_approval_modal` 覆盖层：工具名/rule/完整参数/决策提示行）
- modal 激活时键盘独占：**y/n/s 决策并关闭、Esc 关闭**（其余忽略）；回合中 `poll_prompt_keys` 先分派 modal 再处理取消/普通审批键
- `approval_modal_lines` 自由函数（标题/参数/动作提示，纯函数可测）+ 测试
- kimi-tui **39** 全绿；workspace 0 errors——G-4 分片 A-F 全部落地（历史/补全/审批/工具卡片/弹窗/审批面板）

**2026-08-06 G-4 对拍修正：补全对齐 TS（goal 子命令 + 描述列）✅**：
- **对拍审计**（亲自读 TS 源码）：`approval/controller.ts` autoResolveFor（并发队列短路——我的 rule 记忆为超集，记录差异）、`tool-call.ts` 966 行组件树（我的线性折叠为架构简化，留待 chatwidget 组件树）、`session-replay.ts` getResumeState 富数据（富结构留待组件树）、`complete-args.ts` + registry 参数集、pi-tui AutocompleteItem description
- **修正**：
  - `/goal` 加子命令支持（status/pause/resume/cancel/replace/next + 裸 objective 创建，TS `GOAL_ARG_COMPLETIONS` parity）——app.rs dispatch 分派 + bottom_pane `GOAL_ARGS` 参数集补全
  - 弹窗描述列：`COMMAND_DESCRIPTIONS` 表（45 命令描述）+ `CompletionState.matches` 改 `(name, desc)` + chatwidget 渲染第二列暗色描述（TS AutocompleteItem parity）
- **测试**：bottom_pane goal 参数集补全（pause/cancel/status）+ completion 描述非空断言 → kimi-tui 39 全绿；workspace 0 errors

**2026-08-06 CLI 续补（G-3 批次 2 + ACP 增补）**：
- **选项冲突校验补全 ✅**（TS `validateOptions` parity）：`print` 空 prompt / 空 `--model` 报错（"Prompt/Model cannot be empty."）；`print --continue` 与全局 `-S <id>` clap `conflicts_with` 互斥；新增 2 集成测试 → cli.rs 44 全绿
- **ACP skills 命令广告 + `/skill:` 拦截 ✅**（kimi-acp，TS `acp-adapter` parity）：
  - `available_commands_update` 通知（`session/update` 结构）在 `session/new`/`load`/`resume` 后推送：builtin 6 命令（compact/status/usage/mcp/tasks/help，对齐 TS `builtin-commands.ts`）+ 会话 skills（`skill:<name>` 命名，builtin source 保留裸名，对齐 `buildSkillSlashCommands`）
  - `session/prompt` 拦截 `/skill:<name> [args]` → `session/activate_skill`（不再把斜杠文本喂给模型），返回技能轮最终助手文本
  - 测试基建：`round_trip` 跳过无 `id` 的 preamble 通知行、返回响应行；`session_load_replays_updates` 适配 4 行（2 replay + palette + 响应）并断言 palette 含 builtin——kimi-acp 8 全绿
- **验证**：cli 集成 44 + kimi-acp 8 + workspace 0 errors

**2026-08-06 G-2 收尾批次：剩余 v1 路由补齐（前端功能面完整）**：
- **新增 18 个 v1 路由**（kimi-web daemon 客户端剩余端点，映射现有 processor RPC）：
  - `POST /sessions/{id}/profile`（title/metadata/agent_config：model/thinking/plan/swarm/permission → 返回 WireSession）
  - `GET /sessions/{id}/goal`（SESSION_GOAL_GET，null 保持）、`/warnings`（{warnings}）、`/messages`（WireMessage 分页，复用 wire_message_from_context）
  - `:compact`（SESSION_COMPACT）、`:undo`（UNDO_HISTORY）、`:restore`（UPDATE_METADATA archived=false）、`/prompts:steer`、`/prompts/{pid}:abort` + `:abort`（CANCEL）
  - `/tasks`（BG_LIST 按 session 过滤）、`/tasks/{tid}`（BG_GET）、`/tasks/{tid}:cancel`（BG_STOP）
  - `/skills/{name}:activate`（ACTIVATE_SKILL）、`/approvals/{aid}`（无 resolve 后缀 + approved/rejected→allow/deny 决策转换）、`/oauth/logout`（config 删 providers.kimi）
  - `/fs:grep`（引擎 fs.rs 加 `grep`→Grep 工具动作，query→pattern）、`/fs:git_status`、`/fs:diff`（git/status、git/diff，cwd 从 session workdir 解析）
- **冒号路由 axum 适配**：axum 0.8 不支持 `{id}:compact`（参数+字面量同段）且 `Router::layer` 在路由匹配后执行（`{id}` 贪婪捕获 `sess-1:compact`）→ 新增 `ColonRewrite`/`ColonMake` tower Service（`rewrite_path` 白名单动作表 compact/undo/restore/abort/steer/activate/cancel/download，字面量 `fs:grep` 等不动）包装 router 在**匹配前**重写 `{x}:{action}`→`{x}/{action}`；serve/serve_web/kimi-cli run_web/kimi-server-serve 统一接入
- **测试**：`colon_actions_rewrite_to_slash` 单测（5 重写 + 2 不动）+ `http_v1_extended_routes` e2e（profile 应用/goal null/warnings/messages 页/冒号 compact+undo 路由命中/tasks 空/logout）→ transport 24 全绿（14 lib + 6 e2e + 4 remote + 2 ws）
- **待办**：① `KIMI_WEB_RUST_SERVER=1 kimi web` 浏览器人工验证（SPA+WS+token 全链路）② kimi-inspect `/api/v1/debug` 面（另立任务）③ `:children`/`:btw`/terminals/files 上传（次要，随用随补）

**2026-08-06 G-2 批次 1：v1 契约投影 + WS v1 门面（kimi-web 前端零改动连 Rust server 的最小可验证链路）**：
- **背景**：浏览器 daemon 客户端（`apps/kimi-web/src/api/daemon/`）按 kap-server v1 wire 契约编写（`WireSession` 形状、`{items,has_more}` 分页、`/prompts` 复数路由、`event.*` WS 协议 + `server_hello/client_hello/subscribe` 握手），而原 `http.rs` 是"RPC 直通投影"（codex 风格路径/形状 + JSON-RPC WS）——两边路径、响应形状、WS 协议全不一致，mapper 直接 TypeError / WS 帧互认垃圾。
- **新增 `crates/kimi-server-transport/src/v1.rs`（v1 契约投影模块）**：
  - **形状映射**：`wire_session`（`WireSession` 全字段，`metadata.cwd` 必填防 mappers.ts:102 崩溃）、`wire_session_runtime_status`（`WireSessionRuntimeStatus`）、`wire_page`、`wire_message_from_context`（引擎 context history → `WireMessage`）；`iso_now`（无 chrono 的 ISO-8601 civil-from-days）+ `gen_id`（ULID 风格 id）
  - **WS v1 门面**（`serve_v1_ws`）：连接即发 `server_hello`（含 `heartbeat_ms`）；入站 `client_hello`/`subscribe`/`unsubscribe` → `ack {id,code,msg,payload}`；`ping` → `pong`；未知帧静默丢弃（对齐 wsConnectionV1）
  - **事件投影**（`project_event`）：引擎事件 → v1 `event.*` 信封（`{type,seq,session_id,timestamp,payload}`，连接内 seq 自增，订阅过滤）：`session.turn.started` → `event.session.work_changed{busy:true}` + `event.message.created`(user, id=user_message_id)；`llm.delta`(text/thinking) → `event.assistant.delta{delta:{text|thinking}}`（对象 delta 走前端 protocol 路径，classifyFrame 判别）；`session.turn.ended` → `event.message.updated` + `event.assistant.completed` + `event.session.work_changed{busy:false}`（busy 复位无条件发，不依赖 turn context）
  - **异步 turn 状态**（`V1Shared`/`TurnContext`）：REST 提交注册 prompt_id/user_message_id/assistant_msg_id + prompt 文本 + 累积 buffer，WS 投影读写；busy 由「有活跃 turn context」推断（引擎 status 无 busy 字段）
- **`http.rs` 契约升级**：`GET /sessions` → `{items,has_more}` WireSession 分页；`POST /sessions` 收 `{metadata:{cwd},title,agent_config:{model}}`（cwd 存在性校验）→ WireSession；`GET /sessions/{id}` → WireSession；新增 `GET /sessions/{id}/status`（runtime status）、`GET /healthz`（别名）、`POST /sessions/{id}/prompts`（**异步提交**：立即返回 `{prompt_id,user_message_id,status:"accepted"}`，`tokio::spawn` 后台跑 `session/prompt`，turn 结束延迟清理 turn 状态防 busy 卡死）；`GET /sessions/{id}/snapshot` 补 `pending_approvals/pending_questions/subagents` 空数组（缺则 client.ts:559 崩溃）；`/api/v1/ws` 从 JSON-RPC 门面切到 v1 门面
- **引擎缺陷修复（迁移测试驱动）**：`set_work_dir` 只改内存 cache 不落盘（`create_session` 新建时 store 副本 work_dir 为空），`session/list` 从 store 读 → cwd 永不落地 → 改为更新后 `save_to_store`（kimi-agent session/manager.rs）
- **认证补全**：serve 启动时既无 `KIMI_CODE_PASSWORD` 也无 `server.token` → **生成并写盘**（kap-server persistentToken parity），否则 `kimi web` 拼进 URL 的 token 与 Rust server 不匹配（lenient 免鉴权）
- **测试**：v1.rs 单测 4（iso_now/id/wire_session 形状/turn 生命周期投影）；http_e2e.rs 重写 + 新增：`ws_upgrade_serves_v1_handshake`（server_hello→client_hello→ack）、`http_v1_session_contract`（创建/缺 cwd 报错/坏 cwd 报错/列表分页/详情/status/snapshot 形状）、`http_v1_prompt_async_returns_immediately_and_resets_busy`（立即返回 + busy 复位 + 消息落地 snapshot）、`ws_v1_streams_turn_events_after_subscribe`（订阅后 prompt → work_changed/message.created/message.updated/assistant.completed/busy 复位全序列）——transport 全绿 **24**（13 lib + 5 e2e + 4 remote + 2 ws）；kimi-agent session 55 + kimi-server/sdk 109 回归全绿；`cargo check --workspace` 0 errors（kimi-tui app.rs ratatui unused-imports warnings 为预存，非本批次引入）
- **待办**：① `KIMI_WEB_RUST_SERVER=1 kimi web` 浏览器人工验证（SPA + WS 流 + token 流全链路）② 批次 2 其余 v1 路由对拍（profile/goal/warnings/messages/tasks/terminals/fs:grep+git_status+diff+download/open/workspaces CRUD/providers refresh/oauth logout/files/children/btw/compact/undo/questions/approvals 等）③ kimi-inspect 的 `/api/v1/debug` 面另立任务

**2026-08-06 G-1 进展（kimi-sdk 补齐，node-sdk → kimi-sdk）**：
- **`Session::reload_session` ✅**（node-sdk `reloadSession` parity：load + get_status + transcript 组合，`session.rs`）+ 2 集成测试（保存后重载恢复上下文 / 新鲜会话重载报状态）。测试驱动确认：引擎 `session/load` 对「已创建未保存」会话也返回 `found:true`（判断内存 agent 存在性），not-found 分支仅为防御
- **`KimiAuth` 门面 ✅**（`crates/kimi-sdk/src/auth.rs`，node-sdk `KimiAuthFacade` parity）：`login`（kimi-oauth `run_device_flow` → `config/set` 持久化 `providers.kimi.apiKey`）/ `logout`（null-patch 删除）/ `status`（读 config 判断）——复用 Harness 现有 config 面，零引擎改动；1 集成测试（mock OAuth 服务器 + 内嵌 Harness，login→status→logout 闭环）
- **`Session::swarm` ✅**（node-sdk `swarm` parity：set_swarm_mode(trigger=task) + prompt）+ 1 集成测试（swarm turn 无 wire error + 上下文落地）
- **基线**：kimi-sdk lib 2 + auth 1 + harness 11 + runtime 22 + probe_cancel 2 **全绿 38/38**
- **probe_cancel 修复 ✅（2026-08-06）**：并行引擎改动把 cancel 语义改为「swap 读取——turn 开始前已置位的取消中止本次 turn」（`agent.rs::run_turn_with_origin` + 单测 `cancel_landed_before_turn_aborts_it`），但未同步集成测试。已按新语义重写 `probe_cancel.rs` 为两个测试：`pre_cancel_aborts_the_next_turn`（pre-cancel 后 prompt 立即 Aborted，不进入挂起 LLM）+ `mid_turn_cancel_aborts_the_hung_prompt_turn`（原中段 cancel 断言），2/2 通过
- **kimi-sdk 剩余缺口**（相对 node-sdk Session 60 方法）：`onEvent`/`setApprovalHandler`/`setQuestionHandler`（事件/审批面——Rust 走拉取模型，属设计差异非缺口）、`getResumeState`（Session 无状态缓存）、`emitMetaUpdated`/`waitForBackgroundTasksOnPrint`/`handlePrintMainTurnCompleted`（TS 宿主合成/print 模式专用）——**可移植 Session 方法面已补齐**

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

## 10. 当前缺失项 TODO 清单（2026-08-05 复核）

> 依据：本节对照 §3 逐 crate 规格 / §6 阶段任务清单 / §8 状态，与工作区实际代码逐项核对（`crates/` 文件清单 + 测试基线 + git 状态）。`[ ]` = 缺失待补，`🔶` = 部分完成，`[x]` = 已定案关闭。

### 阶段 D — TUI 功能面（当前最大缺失，kimi-tui 仅 4 文件 1784 行 vs 计划 ~200 文件）

| 项 | 状态 | 说明 |
|---|---|---|
| D-1 `kimi-tui` 主循环 + 事件流 | ✅ | `app.rs`/`lib.rs`/`markdown.rs`/`theme.rs`，13 测试（ratatui 实时渲染/角色化转录/23+ 命令面 Tab 补全/审批 y-n/流式） |
| D-2 chatwidget（transcript/streaming/tool_requests/slash） | 🔶 | 已推进（2026-08-06）：44 斜杠命令 dispatch ✅ + 流式文本/thinking ✅ + 会话恢复**历史渲染** ✅（`history.rs`）+ 参数补全集扩展 ✅（`/permission`/`/session`）；**剩余**：工具调用卡片（结构化 tool 条目/结果折叠/流式参数预览）、命令补全弹窗、@mention |
| D-3 bottom_pane（composer/textarea/footer/popup/mentions） | 🔶 | 已推进（2026-08-06）：单行编辑原语 + Tab 补全 ✅；**剩余**：补全弹窗（picker 模式）、`!` bash 模式、Ctrl-G 外部编辑器、@mention |
| D-4 reverse_rpc（approval/question 反向 RPC 接线） | 🔶 | 已确认设计（2026-08-06）：审批走"事件通知→`approvals()` 拉取→队列→y/n 或 `/approve`/`/deny` RPC 决策"与引擎授权回调自洽（无需 host 回调）；question 侧引擎为"工具内容+下条消息"设计（TS native `setQuestionHandler` 同为 no-op）；**剩余**：审批面板化（DisplayBlock diff/shell/file 预览 + approve-for-session 记忆） |
| D-5 验证（TUI 冒烟 + 交互路径与 TS 版行为一致） | 🔶 | TestBackend 冒烟 ✅；全交互路径对拍未做 |

### 阶段 E — SDK/ACP/OAuth/Config 收尾

| 项 | 状态 | 说明 |
|---|---|---|
| E-2 ACP 兼容测试 | 🔶 | stdio 适配器 + 命令面 ✅（initialize/生命周期/set_mode/set_model/notification 回放）；**兼容矩阵持续测试**未做（依赖真实客户端） |
| E-3 kimi-oauth 状态机细化 | 🔶 | device flow ✅（authorize/poll/refresh + 3 测试 + `kimi login`）；授权码流/状态机细节待续 |
| E-4 config 面（TOML/env/diagnostics） | 🔶 | `kimi-sdk::catalog` ✅（models.dev）；**kimi-config 面**：`config get/set/replace` 协议层 ✅（kimi-server）+ `kimi config --set` ✅（kimi-cli），`doctor config` 文件级检查 ✅；env overlay / diagnostics 细化未做 |
| E-5 SDK 测试平移（TS 425 用例） | [x] | **已定案关闭**（2026-08-05 测试策略：重写而非平移，TS 用例平移跳过） |

### 阶段 F — 退役（前置依赖阶段 D/E 收尾）

| 项 | 状态 | 说明 |
|---|---|---|
| F-3 TS 宿主退役（node-sdk/kap-server/acp-adapter/oauth/protocol/kaos → `retired/`） | 🔶 阻塞 | **前置未满足**：`apps/kimi-code` 是 TS 分发，依赖上述包（鸡生蛋闭环）。可行路径：① 先让 `apps/kimi-code` 消费面切 Rust（native-session 已接 plugin/cancelCompaction/archive，剩 auth/provider/telemetry 面）→ ② 逐步减少 node-sdk 宿主依赖 → ③ 最后移 `retired/`。klient 已退役 ✅ |
| F-5 全链路 Rust 端到端验证 + 旧 TS 测试退役 | ❌ | CLI/TUI/web/API 全 Rust 端到端未跑；TS 旧测试删除/转 Rust 未做（依赖 D/E 完成） |

### 验证类（横切）

- [ ] 真实 LLM 端点恢复后 `kimi print`/TUI 流式端到端（含 ACP 逐 token 通知）——当前用 stub/fake LLM 验证，无真实端点回路

### 文档/流程收尾

- [x] 阶段 B-5 kap-server 测试平移（377 基线）→ 同 E-5，定案"重写而非平移"，关闭
- [ ] §3 中未建 crate 标注：`kimi-core`/`kimi-state`（保留 `packages/kimi-agent` 未拆分）、`crates/utils/*`（并入 native-tools/kimi-shared）——计划与现状偏差已在 §10 记录，如需执行拆分再更新 §3
- ✅ **2026-08-05 已提交**：`/session`（显示/重命名）与 `/plugins`（list/enable/disable/remove/reload/install）命令 TUI+REPL 落地；间歇性 DNS 依赖测试修复（kimi-native-tools fetch_url `example.com`→IP 字面量 + kimi-agent `is_private_host` 同修）——workspace 全绿稳定（连续 3 次无失败）
