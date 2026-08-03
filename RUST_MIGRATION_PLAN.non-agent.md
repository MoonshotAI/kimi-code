# 非 Agent 模块 Rust 迁移方案(Non-Agent Rust Migration)

> **状态**:方案定稿(2026-08-03),待用户确认后实施。进度权威仍为 `RUST_MIGRATION_PLAN.md`;本文档覆盖 agent 引擎之外的模块。

## 1. 结论先行

**引擎域(engine domain)的"非 agent 模块"已 100% Rust 化,无剩余迁移项。** 所有被 Rust 引擎运行时依赖的能力(LLM 调用、持久化、shell 执行、文件下载、PKCE、协议真源)均已有 Rust 实现并接线。剩余 TS 包全部属于**宿主域**(host domain),按仓库边界(AGENTS.md「Engine Ownership」)刻意保持 TS。

盘点后仅存 **2 个收尾项** 与 **1 个待决策项**,详见 §4。

## 2. 引擎域能力 Rust 化对照(全部已完成 ✅)

| 能力 | TS 来源 | Rust 实现 | 接线证据 |
|---|---|---|---|
| LLM provider(anthropic/openai/google chat+streaming) | `kosong/src/providers/` | `kosong/native/`(19 `.rs`, 6,705 行)+ `kimi-agent/src/llm/`(anthropic 23k / google_genai 19k / openai 18k / http 20k / multi) | `main.rs:234-249` — host 未供 `native_llm` 时 `load_native_llm_from_config()` 自读 config 构造 `NativeHttpLlm`;`config/native_llm.rs`(511 行,含 `resolve_secondary_native_llm`) |
| 零-host LLM 端到端 | — | `tests/stdio_rpc_integration.rs:1239` `native_llm_text_turn_needs_no_host` | 集成测试全绿(51 个) |
| 持久化 / 记忆 / 任务存储 | `minidb/`(agent-core-v2 后端) | rusqlite:`persistence/store.rs`、`SqliteTaskStore` | `main.rs:2042-2044` `set_persistence` 接线 |
| shell / 进程执行 | `kaos/src/local.ts` | `kimi-native-tools/src/bash.rs` + `kimi-agent/src/shell_command/` | native toolset 默认开启 |
| 文件下载 | `kaos` 下载面 | `media/http_downloader.rs`(reqwest-backed) | `media/mod.rs:20` 接线 |
| PKCE | `oauth/` | `kimi-shared/src/pkce.rs`(16.5k 行)+ `kimi-agent/src/oauth/pkce.rs` | kimi-shared 单一真源 |
| 协议/契约真源 | `protocol/`(Zod schema) | `rpc/types.rs` → `pnpm gen:wire` 生成 `wire.gen.ts` | AGENTS.md:75;event-contract 专项阶段 1-6 完成 |
| 事件契约 | `protocol/events.ts`(camelCase) | 引擎 snake_case `host/event` | event-contract 阶段 1-6 + 收尾(2026-08-03) |

> 工作日志(RUST_WORK_LOG Part C)曾列「计划内未动」的 1a(native_llm config 自读)、1c(HttpFileDownloader 接线)、task_store 接线、零-host 端到端——**2026-08-03 复核全部已落地**。

## 3. 非 agent TS 包归类表(16 项)

| 包 | 代码量 | 归类 | 依据 |
|---|---|---|---|
| `kosong/native` + `native-bridge.ts` | 6,705 `.rs` + TS 桥 | **已 Rust 化但未接线(死代码)** | `createNative*Provider` / `nativeAvailable` 全仓零调用方(`native-bridge.ts` 仅自引用);为已退役 agent-core-v2 预留 |
| `minidb` | 7,391 | **已死代码** | 唯一消费者 `agent-core-v2`(`memoryStore.ts:14`、`miniDbQueryStore.ts:49`)已冻结;引擎用 rusqlite |
| `kosong` TS 剩余(catalog/capability/generate) | ~3.5k | 宿主域,留 TS | node-sdk / klient / acp-adapter / vis 消费;引擎自有 `src/llm` + `src/kosong/` |
| `oauth` | 5,141 | 宿主域,留 TS | PKCE 已 Rust 化;托管登录 GAP_ANALYSIS mcp 行定案「OAuth/SDK 客户端留 host」;引擎只收 `oauth_available: bool`(`mcp/connection_manager.rs:147`) |
| `kaos` | 3,028 | 宿主域,留 TS | SSH(ssh2)无 Rust 对应且无引擎需求;local 执行能力引擎已自带 |
| `telemetry` | 1,217 | 宿主域,留 TS | 仅 CLI 消费;引擎只有回调接口(`cron/manager.rs:49-50`) |
| `transcript` | 3,674 | 宿主域,留 TS | 引擎只发 `host/event`,宿主构建转录(`callbacks.rs:43`) |
| `migration-legacy` | 4,099 | 宿主域,留 TS(一次性) | kimi-cli→kimi-code 迁移工具,老用户迁移完毕自然死亡 |
| `protocol` | 10,633 | 宿主契约层,留 TS | Rust `rpc/types.rs` 为真源;接口定义保留至 agent-core-v2 退役时清理 |
| `i18n` / `i18n-shared` | 1,929 | 宿主域,留 TS(**已决策**) | RUST_MIGRATION_PLAN.md:14 白名单;引擎侧 i18n 硬约束注释(`cron/expr.rs:411`、`task/notification.rs:19`) |
| `acp-adapter` | 5,286 | 宿主域,留 TS | 纯 ACP stdio 宿主适配器,经 node-sdk/rust-loop 驱动引擎 |
| `kap-server` | 16,004 | 宿主域,留 TS | 已 Rust-backed 路由(`rustSession` 零 v2 import,阶段 4 完成) |
| `node-sdk` | 14,211 | 宿主/公共 API,留 TS | 425 测试全绿;wire 类型由 Rust 生成 |
| `klient` | 10,785 | 宿主,传输层 Rust 化中 | ⑤ 并行会话实施中(transports/rust/ 3,907 行未提交) |
| `pi-tui` | 12,477 | 上游依赖,不迁移 | 上游 pi-tui 框架 |
| `agent-core-v2` | 96,735 | 冻结,待退役 | klient Rust 传输落地后移入 `retired/` |

## 4. 建议行动项(待用户确认)

### P1-1:minidb 退役(随 agent-core-v2)
- 事实:唯一消费者是 agent-core-v2(冻结);全仓无其他 import;引擎持久化用 rusqlite。
- 动作:agent-core-v2 移入 `retired/` 时连同 `minidb` 一起处理(移入 retired 或删除)。**现在不动**(agent-core-v2 仍被 klient 消费)。

### P1-2:kosong/native 处置决策(接线 or 退役)
- 事实:19 个 `.rs`、6,705 行已实现 anthropic/openai/google chat+streaming,但 `native-bridge.ts` 零调用方;而引擎侧 `kimi-agent/src/llm/` 是**另一套**更完整的原生实现(引擎已默认使用)。
- 选项 A(推荐):**退役** `kosong/native`——引擎 LLM 已是原生 HTTP,宿主侧 LLM 调用面(node-sdk/klient)不需要 napi 加速;避免两套 Rust LLM 并存维护。
- 选项 B:**接线**——若宿主侧(node-sdk provider 面)需要不经引擎直连 LLM 的加速路径,可把 `createNative*Provider` 接回 `providers/index.ts`。
- 注意:选项 A 需先确认 `@moonshot-ai/kosong-native`(napi 包)无其他消费者(pnpm workspace 依赖图)。

### P2-1:protocol 残留接口清理
- `protocol/events.ts` 中已从 `AgentEvent` 联合删除的接口定义(§3.3 列表),待 agent-core-v2 退役后一并清理(当前冻结包仍 import,不可提前删)。

### P2-2:零-host 冒烟扩展
- `native_llm_text_turn_needs_no_host` 已证明引擎可零 host 跑 turn;可扩展为「KIMI_MODEL_* + native 工具 + 落盘 + 跨会话恢复」全链路集成测试,作为引擎独立运行(SEA 分发)的验收基线。

## 5. 明确不迁移清单(边界)

| 模块 | 理由 |
|---|---|
| i18n | 引擎硬约束留 TS(渲染/文案属宿主);RUST_MIGRATION_PLAN.md:14 |
| oauth 托管登录 | GAP_ANALYSIS:69 已定案留 host |
| telemetry | 仅宿主采集/上报,引擎只有回调 |
| transcript | 引擎只投影事件 |
| acp-adapter / kap-server / node-sdk / klient(壳) | 宿主适配层,白名单内 |
| pi-tui | 上游依赖 |
