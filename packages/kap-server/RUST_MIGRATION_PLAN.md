# kap-server Rust 化迁移计划 — 脱离 agent-core-v2

> **目标**：让 `packages/kap-server`（`kimi web` 服务器）彻底脱离 `@moonshot-ai/agent-core-v2` 的 DI × Scope 容器，之后物理隔离 `agent-core` / `agent-core-v2` 两个 JS 引擎包。
> **现状**：kap-server 是 Fastify HTTP+WS 服务器，自身不拥有业务引擎——会话循环、上下文、工具、审批、消息、工作区、模型目录全部来自 agent-core-v2 的 DI 容器（41 个文件运行时 import，38 个运行时符号）。`RustSessionService`（`services/rustSession/rustSessionService.ts`）是唯一零 v2 依赖的样板。
> **权威进度**：本文件 + `RUST_MIGRATION_PLAN.md`（根目录）；逐会话日志 → `RUST_WORK_LOG.md`。

---

## 依赖总览（2026-08-01 三份并行分析）

### 41 文件依赖强度

| 档 | 数量 | 代表 |
|---|---|---|
| 核心（移除即无法启动） | 10 | `start.ts`(bootstrap 组合根)、`sessionEventBroadcaster`、`transcriptService`+`coreBinding`、`legacyStatus`、`snapshotReader`、`fsWatchBridge`、`dispatcher`+`channelRegistry`(DI 元编程)、`mainAgent`+`errors` |
| 中等（对应端点失效） | 22 | 会话面路由 6 个(Rust 模式已跳过)、`tools`/`skills`(无条件注册、最重)、web 基础设施路由(auth/oauth/config/modelCatalog/files/workspaces/workspaceFs)、`fs`/`terminals`/`sessionExport`、guiStore/authTokenService、modelCatalogRefreshScheduler |
| 弱（类型/单常量） | 9 | `registerWsV1`、`registerApiV1Routes`(仅 type Scope)、`coreEventMap`(仅 type DomainEvent)、`rest-modelCatalog`(正则常量)、`instanceRegistry`、`transcript.ts`(常量) |

另有深路径导入面：`protocol/events-zod.ts`(~20 条)、各 `rest-*.ts`、`transport/ws/v1/events.ts`、`openapi/transforms.ts`。

### 能力分类

- **AI 引擎会话面**（→ RustSessionService / Rust RPC）：sessions/prompts/approvals/questions/tasks/messages/status/goal/context/mcp/skills/permission/git
- **Web 服务器基础设施**（→ kap-server 自持）：workspaces 目录、config 读写、auth/OAuth、model-catalog、files blob、terminals(PTY)、GUI 存储、实例注册表
- **Rust 引擎已有、补 RPC 成本最低**：config(`src/config/` 已有)、files blob(`src/blob/`)、session export(`session/export.rs` 未接)、session fs(`NativeToolset` 沙箱完备)、questions(`question_tools/` 已有校验)

### Rust 引擎 RPC 面（已就绪但宿主未投影）

`session/*` 全套：create/prompt/cancel/destroy/save/load/list/set_model/init/steer/set_thinking/run_shell/goal_*/get_status/get_usage/get_warnings/approval_list/resolve/compact/get_context/undo_history/list_mcp_servers/reconnect_mcp_server/list_skills/activate_skill/get_plan/clear_plan + `permission/*` + `git/*` + `cron/*` + `bg/*` + `plugin/*` + `task/list`。

---

## 阶段计划

> **当前进度(2026-08-01,阶段 4 收官)**:
> - ✅ **阶段 1-3 全部完成——kap-server 路由面 100% Rust 化**:会话面全、config(GET+SET)、fs 读类全(read/list/stat/search)、workspaces、files、tools、auth、skills、model-catalog 全端点(含 POST/PUT/DELETE/refresh)、export、transcript、snapshot、oauth 全端点(login/logout/usage)
> - ✅ **阶段 4 完成——kap-server 完全脱离 @moonshot-ai/agent-core-v2**(src+test 零 v2 import、typecheck 0 错误、package.json 移除依赖):debug RPC 面删除、snapshotReader/_legacyWire/transcriptService/coreBinding/coreEventMap/scheduler/workspaceFs/terminals 死代码删除、12 路由去 core、start.ts 去 bootstrap、broadcaster 1663→599、protocol 19/19 本地化、测试适配(全项目 tsc 0 错误、85 用例实测绿)
> - ⚠️ terminals 受阻:node-pty 环境不可加载(Rust 模式无 terminal RPC,终端路由已删)
> - ⬜ **后续(包隔离)**:agent-core/agent-core-v2 物理移入 retired/ 需剩余宿主(apps/kimi-code 3、kimi-inspect 8、其他包 9 文件)解绑——kap-server 依赖已解除,列为后续

### 阶段 1：消除"静默空洞"——RustSessionService 投影补全（低风险，优先）

Rust RPC 已就绪，宿主只做 v1 wire 投影。修复 Rust 模式下返回空/404/无数据的正确性缺口：

| 子项 | Rust RPC | 宿主投影 | 现状 |
|---|---|---|---|
| 1a. sessions 详情/status/goal/warnings | `session/get_status`/`get_usage`/`goal_get`/`get_warnings` | `rustSessions.ts` 扩展 | ✅ 2026-08-01 完成：SessionClient 暴露 7 方法 + 服务 6 代理 + 3 路由(status/goal/warnings) |
| 1b. tools/MCP 管理 | `session/list_mcp_servers`/`reconnect_mcp_server` | v1 `McpServer` 形状 | ✅ 2026-08-01：`GET /mcp/servers` Rust 分支(最新引擎会话 → toEngineMcpServer,status 映射) |
| 1c. skills 路由 | `session/list_skills`/`activate_skill` | v1 `SkillDescriptor` | ✅ 2026-08-01：`GET /sessions/:id/skills` Rust 分支(toEngineSkill,source 映射) |
| 1d. messages/transcript 持久化 | 引擎 `AgentRecord` + onFrame 帧 | 宿主落盘 wire records | ✅ 2026-08-01：transcriptService `rustOnly` 降级（跳过 v2 lifecycle 订阅）；rest-message.ts 本地化（message.ts schema）；消息历史经引擎 AgentRecord + WS 帧投影 |
| 1e. sessions 列表/详情 GET | `session/list` + 1a | v1 wire | ✅ 2026-08-01：`GET /sessions` 列表(RustWebSession 加 title/createdAt/updatedAt + toSessionSummary) |

**验收**：Rust 模式下 web UI 的会话详情、工具/MCP、skills、消息历史、transcript 全部有数据。

### 阶段 2：Rust 引擎补 RPC（中风险，每项独立）

| 子项 | Rust 侧 | 宿主侧 | 依赖 |
|---|---|---|---|
| 2a. config get/set | `config/get`+`config/set` RPC（`src/config/` 已有 loader/merge/原子刷新） | `/config` 脱敏投影 | 无 |
| 2b. files blob | `files/upload|download|delete` RPC（`src/blob/`） | multipart 解析 + 流式 | 无 |
| 2c. session export | 接通 `session/export.rs` RPC | HTTP 流式 | 无 |
| 2d. session fs | `session/fs:*` RPC（`NativeToolset` 沙箱） | v1 fs wire 投影 | 无 |
| 2e. questions | `question.requested` 事件 + `session/question_resolve` RPC | v1 `/questions` | 无 |

**验收**：每个子项 Rust RPC + `pnpm gen:wire` + 宿主投影 + 测试。

### 阶段 3：kap-server 自持宿主域（脱离 v2 服务）

| 子项 | 自持方式 | 难度 |
|---|---|---|
| 3a. workspaces | JSON/SQLite 注册表 + `session/list` 计数 | 中 |
| 3b. auth/OAuth | 重写 device flow/userinfo/凭据（Rust 仅 PKCE 原语） | 高 |
| 3c. model-catalog | config 能力 + HTTP 刷新 + models.dev 导入 | 高 |
| 3d. terminals | node-pty 自持（Rust `session/run_shell` 只做非交互） | 中 |

**验收**：这些路由不再 `core.accessor.get(v2 服务)`。

### 阶段 4：脱离 DI 容器 + 物理隔离

1. `start.ts` 不再 `bootstrap()` v2 core；自持服务改为参数注入
2. 移除 41 文件的 agent-core-v2 import（含深路径）；`protocol/events-zod.ts` 等改为本地 schema
3. `registerApiV1Routes` 删除 v2 分支（Rust 唯一）
4. `agent-core` / `agent-core-v2` 移入 `retired/`，退出 pnpm workspace，宿主依赖解除
5. 全量验证：kap-server typecheck + 测试、`kimi web` e2e

---

## 验证基线

- `cargo test -p kimi-agent` = 2011 lib + 51 集成全绿、0 warnings
- kap-server：typecheck 0 错误 + 347 测试（2026-08-01 阶段 4 推进后实测）
- `pnpm gen:wire` 幂等（CI wire-contract job）
- 每阶段结束：`kimi web` 冒烟（HTTP 面 + WS 事件面）

## 关键文件索引

- 组合根：`packages/kap-server/src/start.ts`
- 样板（零 v2 依赖）：`services/rustSession/rustSessionService.ts`、`routes/rustSessions.ts`
- 路由切换：`routes/registerApiV1Routes.ts:120-160`
- WS 事件：`transport/ws/v1/sessionEventBroadcaster.ts`（`broadcastRustFrame` 旁路）
- Rust RPC：`packages/kimi-agent/src/main.rs`（方法注册 L137-2242）、`src/rpc/types.rs`（方法常量 L83-271）
- wire 契约：`packages/kimi-agent/src/rpc/wire.gen.ts`（与 RPC 方法面对齐）
