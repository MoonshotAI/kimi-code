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
| `kosong/native` + `native-bridge.ts` | 6,705 `.rs` + TS 桥 | **已退役 `retired/kosong-native/`** | `createNative*Provider` / `nativeAvailable` 全仓零调用方(`native-bridge.ts` 仅自引用);为已退役 agent-core-v2 预留 |
| `minidb` | 7,391 | **已退役 `retired/minidb/`** | 唯一消费者 `agent-core-v2`(`memoryStore.ts:14`、`miniDbQueryStore.ts:49`)已冻结;引擎用 rusqlite |
| `kosong` TS 剩余(catalog/capability/generate) | ~3.5k | 宿主域,留 TS | node-sdk / klient / acp-adapter / vis 消费;引擎自有 `src/llm` + `src/kosong/` |
| `oauth` | 5,141 | 宿主域,留 TS | PKCE 已 Rust 化;托管登录 GAP_ANALYSIS mcp 行定案「OAuth/SDK 客户端留 host」;引擎只收 `oauth_available: bool`(`mcp/connection_manager.rs:147`) |
| `kaos` | 3,028 | 宿主域,留 TS | SSH(ssh2)无 Rust 对应且无引擎需求;local 执行能力引擎已自带 |
| `telemetry` | 1,217 | 宿主域,留 TS | 仅 CLI 消费;引擎只有回调接口(`cron/manager.rs:49-50`) |
| `transcript` | 3,674 | 宿主域,留 TS | 引擎只发 `host/event`,宿主构建转录(`callbacks.rs:43`) |
| `migration-legacy` | 4,099 | 宿主域,留 TS(一次性) | kimi-cli→kimi-code 迁移工具,老用户迁移完毕自然死亡 |
| `protocol` | 10,633 | 宿主契约层,留 TS | Rust `rpc/types.rs` 为真源;§3.3 残留接口定义已清理(P2-1,2026-08-03) |
| `i18n` / `i18n-shared` | 1,929 | 宿主域,留 TS(**已决策**) | RUST_MIGRATION_PLAN.md:14 白名单;引擎侧 i18n 硬约束注释(`cron/expr.rs:411`、`task/notification.rs:19`) |
| `acp-adapter` | 5,286 | 宿主域,留 TS | 纯 ACP stdio 宿主适配器,经 node-sdk/rust-loop 驱动引擎 |
| `kap-server` | 16,004 | 宿主域,留 TS | 已 Rust-backed 路由(`rustSession` 零 v2 import,阶段 4 完成) |
| `node-sdk` | 14,211 | 宿主/公共 API,留 TS | 425 测试全绿;wire 类型由 Rust 生成 |
| `klient` | 10,785 | 宿主,传输层已 Rust 化 | ⑤ 已完成并提交(`1b78771f1`):transports/rust/ 替代 v2 dispatcher;agent-core-v2 移入 `retired/` |
| `pi-tui` | 12,477 | 上游依赖,不迁移 | 上游 pi-tui 框架 |
| `agent-core-v2` | 96,735 | **已退役 `retired/agent-core-v2/`** | klient Rust 传输落地(`1b78771f1`)后移入 `retired/`,packages/* 零 TS 引擎包 |

## 4. 建议行动项(待用户确认)

### P1-1:minidb 退役 —— ✅ 已实施(2026-08-03)
- 事实:唯一消费者是 agent-core-v2(已退役);全仓无其他 import;引擎持久化用 rusqlite。
- 动作:随 agent-core-v2 退役同步处理——`packages/minidb`(100 个跟踪文件)移入 `retired/minidb/`(Windows 目录句柄锁,文件级 `git mv` 绕过);`flake.nix` workspacePaths/workspaceNames 移除 `minidb`;`pnpm install` 更新锁文件。
- 验证:`@moonshot-ai/minidb` 全仓零引用(仅 klient `flagsCatalog.ts` 的 flag id 字符串 `persistence_minidb_readmodel` 与测试断言,非 import)。

### P1-2:kosong/native 处置决策(接线 or 退役)—— ✅ 已实施(2026-08-03)

**决策:退役(选项 A)。** 用户确认(2026-08-03)。首轮实施与并行会话的 klient 提交(`1b78771f1`)重叠完成(删除);随后 `bfc88c7d0` 按「keep until deliberately retired」恢复;本批(2026-08-03 晚)完成最终处置:
- `packages/kosong/native/`(25 个跟踪文件,含 19 个 `.rs` + napi 产物)移入 `retired/kosong-native/`;`packages/kosong/src/native-bridge.ts`(509 行)一并移入;根 `Cargo.toml` members 已移除(恢复后仍不在 workspace);`Cargo.lock` 无残留。
- 验证:`@moonshot-ai/kosong-native` / `createNative*Provider` / `native-bridge` 全仓零引用;kosong TS 包(native-bridge 唯一宿主)不受影响。
- 引擎 LLM 面不受影响(`kimi-agent/src/llm/` 原生 HTTP 是唯一 Rust LLM 实现)。

### P2-1:protocol 残留接口清理 —— ✅ 已实施(2026-08-03)
- `protocol/src/events.ts` 删除已从 `AgentEvent` 联合移除的 §3.3 残留接口定义(**22 个接口/type**:TurnStepStarted/Completed/Retrying/Interrupted、ToolProgress、ToolCallDelta、ToolListUpdated(+Reason)、ShellStarted/Completed、SkillActivated、PluginCommandActivated、Subagent×5、CompactionBlocked/Cancelled/Completed、BackgroundTaskStarted/Terminated、CronFired)与配套 **23 个 zod schema**;保留活跃消费方接口(`AgentStatusUpdatedEvent`/`McpServerStatusEvent`/`McpServerStatusPayload`——CLI 作 payload 类型使用;`TurnStartedEvent`/`TurnEndedEvent` 等 5+ 消费方)。
- 测试适配(protocol 包,4 个预存失败清零 + 1 个 dead 用例删除):删除 `shell.completed` schema 用例;删除 `turn.started` dead 断言(旧 v1 wire,新契约 `session.turn.ended` 已覆盖);`mcp.server.status` 断言改走 `mcpServerStatusEventSchema`(不再假设在 agentEventSchema 联合);`VOLATILE_EVENT_TYPES` 断言更新为引擎形状(`llm.delta`/`llm.step.begin`/`llm.step.end`/`session.shell.output`,长度 8→4);ws-control 事件流断言改用 `session.turn.ended` 引擎事件。
- 验证:`pnpm --filter @moonshot-ai/protocol test` = **28 文件 524 通过(基线 5 失败)**,typecheck 0 错误;`@moonshot-ai/kimi-code-sdk` typecheck 0 错误。

### P2-2:零-host 冒烟扩展 —— ✅ 已实施(2026-08-03)

- `tests/stdio_rpc_integration.rs` 新增 `native_full_chain_self_served_persists_and_resumes`:两个引擎进程全链路——进程 1 `session/create`(native_llm + native_tools + homedir 工作区)→ `session/prompt`(native LLM 两轮:Read 工具调用 + 文本完成)→ `session/save`;进程 2 同 id 重建 + `session/load` + `session/get_context` 验证跨进程恢复(用户消息与工具结果均在)。
- 验收:两进程均零 `host/llm_chat` / `host/execute_tool`;provider 恰好调用 2 次;`cargo test -p kimi-agent --test stdio_rpc_integration` = **52 passed**(51 + 1 新增)。
- 配套:`spawn_engine`/`rpc_call` 两个可复用辅助函数(host 方法记录并应答 `null`)。

## 5. 明确不迁移清单(边界)

| 模块 | 理由 |
|---|---|
| i18n | 引擎硬约束留 TS(渲染/文案属宿主);RUST_MIGRATION_PLAN.md:14 |
| oauth 托管登录 | GAP_ANALYSIS:69 已定案留 host |
| telemetry | 仅宿主采集/上报,引擎只有回调 |
| transcript | 引擎只投影事件 |
| acp-adapter / kap-server / node-sdk / klient(壳) | 宿主适配层,白名单内 |
| pi-tui | 上游依赖 |
