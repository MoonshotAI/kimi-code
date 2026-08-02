# Rust Agent 引擎 — 完整修复补全计划

> **📌 本文档是 Rust 迁移进度的唯一权威（single source of truth）。**
> - 模块映射明细 → `packages/kimi-agent/GAP_ANALYSIS.md`（滚动更新）
> - 逐会话工作日志 → `RUST_WORK_LOG.md`（已入库）
> - 根目录外的 `D:\kimi\plan.md` 是旧阶段快照，已废弃，仅作历史参考

## 当前状态（2026-08-01 核对）

> **⚠️ 2026-08-02 方向确认：TS → Rust 全量迁移是最终目标，TS 引擎代码将被废弃删除。**
> 编码约束：引擎功能一律写 Rust（kimi-agent / kimi-native-tools / kimi-shared），
> **禁止**在 agent-core / agent-core-v2 中新增或修改引擎行为（已冻结，待宿主解绑后物理删除）。
> TS 侧仅允许宿主适配层：rust-loop / rust-engine 桥接、kap-server 路由与服务、
> CLI/TUI/Web/VSCode 壳、i18n、生成文件 `wire.gen.ts`（`pnpm gen:wire` 生成）、测试适配。
> 完整规则见根目录 `AGENTS.md`「Engine Ownership」章节。

- **Phase 0-5 全部完成**：v1 与 v2 引擎均已接通，`engine = "rust"` 为默认值
- **测试**：`cargo test -p kimi-agent` = 2011 lib 全绿、0 warnings（2026-08-01 实测）；包内 vitest 38/38（含 stdio e2e）；含全部 crate 的全工作区口径约 **2,800+**（kimi-agent 2011 + 集成 51 + native-tools 617 + kimi-shared 47 + kosong/native 89，GAP_ANALYSIS 2026-08-01 快照）
- **wire 契约生成（2026-08-01 落地，commit `5eda2c584`）**：`scripts/gen-wire-contract.mjs` 从 `src/rpc/types.rs`（含引用类型递归解析：GoalContext/McpServerSpecInput/SkillMetadataInput/HookDef 等 81 个类型）生成 `src/rpc/wire.gen.ts`；serde 语义 1:1（`#[serde(default)]`→optional、`Option<T>`→`T|undefined`、顶层 Option 别名→`|null`、tagged enum→判别联合、`rename_all`/variant rename 全处理）；rust-loop.ts 手写 wire 接口全部替换为生成类型（仅路由 envelope 与 napi 特有 camelCase 类型保留本地）；`pnpm gen:wire` 幂等。**新增 wire 类型时：改 Rust → `pnpm gen:wire` → 提交生成文件**
- **unsafe 审计（2026-08-01 完成）**：`plan.md` 早前声称"0 unsafe"已过时——实测全工作区真实 unsafe 8 处：`user_tool/mod.rs` 6 处（`*mut ToolManager` raw pointer + `unsafe impl Send/Sync`）已重构为 `Arc<Mutex<ToolManager>>` 消除（与 `Agent::tool_manager` 所有权模式对齐，commit `10afd6750`）；`llm/http.rs` 2 处为测试内 `env::set_var/remove_var`（Edition 2024 标记，单测试独占该 env，已注释，风险可接受）。**当前 unsafe 数：2（仅测试，均在 `llm/http.rs`）**
- **web session 后端（2026-08-01，commit `87833b1be` + 路由接线 `f861495e3`，已全部提交）**：`RustSessionService`（kap-server）——web 会话直接绑定引擎会话（rust-loop `createSessionClient`），引擎全权负责 loop/context/goal/tools/approval/持久化，服务只做 v1 wire 翻译（`projectRustEvent` 事件投影：turn/tool/approval/task/usage/compaction）；approval 面走 `session/approval_list`+`resolve`。路由接线（`registerApiV1Routes.ts`/`start.ts`/`rustSessions.ts`）在 rustSession 存在时替换 v2-backed 的 sessions/prompts/approvals/questions/tasks/messages 路由；`maybeCreateRustSessionService` 强制 stdio + probe 探测，失败静默回退 v2（缺失二进制不破坏 `kimi web` 启动）。**WS frame fan-out 已接（commit `eb8d0f783`）**
- **Bug 修复（2026-08-01，已提交 `ab532de95`）**：`main.rs::open_session_store()` 缺 `create_dir_all`（subagent.rs 有、main.rs 漏），新机器上 `~/.kimi-code/agent` 不存在时 stdio e2e 直接 exit 1——已按 subagent.rs 语义补齐，两个 e2e 测试恢复绿
- **构建产物**：2026-07-31 清理 28.7GB（root target 18GB debug + per-crate 旧布局 target 10.8GB），per-crate target 布局已废除；rust-loop `findBinary` 已移除旧布局候选（commit `5eda2c584`）
- **上游同步 A 批次（2026-08-01 完成，见 `上游更新/迁移计划.md`）**：A6（goal step-limit 续跑——`TurnResult.hit_step_cap` + `render_step_capped_continuation`，2 测试）、A12（次模型配置面——config `secondaryModel` + `KIMI_SECONDARY_MODEL/EFFORT` + 实验门控，Task/AgentSwarm 子代理绑定，4 测试）、A15（TaskOutput 非阻塞——Rust 拦截器本就非阻塞 + 提示文本清理）；A1/A9/A25 核对为已实现/天然满足。测试基线升至 **2009 lib + 51 集成全绿、0 warnings**
- **C6 workspace trust 引擎侧（2026-08-01，已提交 `3e42d1403`，随 A 批次）**：`McpConnectionState.workspace_trusted` 驱动 `.mcp.json` stdio 审批门 + `session/create` `workspace_trusted` RPC + rust-loop 传参，2 测试；TUI 询问留宿主。测试基线 **2011 lib + 51 集成全绿、0 warnings**
- **JS 引擎回退移除（2026-08-01，已提交 `ff29411af`）**：v1/v2 迁移已收官,JS 引擎(agent-core/agent-core-v2 loop)全面退役——`schema.ts` engine 枚举移除 `js`(仅 `rust`);`maybeLoadRustEngine`/`buildRustTurnOverride`/`RustSessionService` 失败一律 throw,不再静默回退 JS loop/v2-backed 路由;v2 `loopService.ts` 工厂失败从吞错改重新抛出。**行为变更：无 Rust 二进制时 CLI/web 启动即报错(暴露而非掩盖 bug)**
- **WS frame fan-out（2026-08-01，已提交 `eb8d0f783`）**：`SessionEventBroadcaster.broadcastRustFrame` + start.ts `onFrame` 接线——Rust 引擎投影帧经 WS 实时推给会话订阅者(volatile,骑 watermark 不推进 seq);web session 的 HTTP + WS 事件面全部打通。4 测试,kar-server 351 全绿
- **kimi-shared 第二批（2026-08-01，已提交 `5efb14104` + `50bc82db2`）**：line_endings + tokens 核心迁入 kimi-shared 单一真源(native-tools/kimi-agent 均 re-export);file_type / tool_naming 判定为语义分化非重复,不合并;`gen:wire` CI 漂移检查上线(`wire-contract` job)——实测检出并同步 C6 的 `workspace_trusted`。kimi-shared 47 / native-tools 617 / kimi-agent 2011+51 全绿、0 warnings
- **JS 引擎退役完成（2026-08-01，commit `ff29411af`）**：引擎选择唯一 rust + 无回退 + 全生产代码零 `'js'` engine 残留(`getEngine()` 恒 rust,`Engine` 类型收窄)。**agent-core/agent-core-v2 包保留**——宿主(node-sdk/acp-adapter/kap-server)仍引用其类型/工具/宿主服务,引擎 loop 域不可达但物理删除需逐项梳理依赖,风险大于收益,待宿主依赖解除后另行清理
- **待办**：上游 0.31.1+ 同步——A 表 25 项已全部定案（A16/A17/A19 已迁移，A20/A24 已核对为 ⚪，见 `上游更新/迁移计划.md`）；剩余 **C3 插件通知（引擎侧 ? 待核对）**；A8/A23 ⚪ 宿主面；kap-server Rust 化 **阶段 4 已完成**（2026-08-02 复核：src+test 零 v2 import、protocol 19/19 本地化、12 路由去 core）；**v2 harness 已删除**（2026-08-02：apps/kimi-code 的 `cli/v2/`、`cli/experimental-v2.ts`、`--agent/--agent-file` 选项及测试全部移除）；**rust-backed 引擎接入层已收进 SDK**（2026-08-02：`@moonshot-ai/kimi-code-sdk/rust` 新入口——SessionEventTranslator/SessionEngineController 从 apps 提升，+ wire 翻译层 + **RustRpcClient**（rust-loop 驱动的 CoreAPI 实现，核心方法 ~50 个已映射、缺口 nativeUnavailable，6 单测绿，SDK 38 测试全绿））；**剩余**：① node-sdk 的 `createKimiHarness` 切换到 RustRpcClient 并删除 KimiCore/SDKRpcClient 路径（agent-core 运行时依赖归零）；② SDK 49 个 v1 wire 公开类型切 Rust wire 形状 + CLI/TUI 消费方联动（用户已确认彻底路线）；③ klient 新增 Rust 传输（替换 v2 dispatcher）；④ agent-core/agent-core-v2 物理移入 retired/

---

## 总览

| 阶段 | 内容 | 预估工期 | 依赖 |
|------|------|---------|------|
| **Phase 0** | 环境修复 + 集成测试通过 | 0.5 天 | Rust 工具链 |
| **Phase 1** | Rust 引擎功能补全（6 大模块） | 15-22 天 | Phase 0 |
| **Phase 2** | v1 模块迁移补齐（1 模块） | 3.5 周 | Phase 1 |
| **Phase 3** | v2 模块迁移补齐（7 模块） | 2-3 周 | Phase 1 |
| **Phase 4** | 默认引擎切换 + v2 集成 | 1-2 周 | Phase 0-3 |
| **Phase 5** | 完整测试 + 性能基准 + 安全审计 | 2-3 周 | Phase 1-4 |
| **预估总计** | | **10-14 周** | |

---

## Phase 0: 环境修复与集成测试 — 已完成 ✅

4 个 Rust 集成测试现已全部通过：
- `cron_create_list_delete` ✅
- `cron_get_next_fire` ✅  
- `bg_register_list_stop` ✅
- `bg_append_output_settle` ✅

**集成测试结果**: 10 passed, 0 failed (含 health_check/round_trip/notification 等)

---

## Phase 1: Rust 引擎功能补全 — 已完成 ✅

### 1.1 简化的 5 个模块补齐 — 全部完成

| 模块 | 当前完整度 (2026-07-26) | 完成内容 | 测试数 |
|------|------------------------|---------|--------|
| **Goal** | **~95%** | GoalCompletionVerifier（独立 LLM 验证器）、`build_verifier_prompt()`、`parse_verdict()`、`mark_complete` 自动验签、`GoalDelegate.on_goal_telemetry()` 事件、6 状态状态机、预算跟踪、replay 恢复 | 46 |
| **Plan** | **~90%** | `PlanConfig` 可配置计划目录、`on_plan_data_updated()` 事件、Kaos trait 文件系统抽象 | 14 |
| **Injection** | **~90%** | `build_goal_reminder()`/`build_goal_note()`/`build_plan_mode_reminder()`/`build_plan_mode_sparse_reminder()`/`build_plan_exit_reminder()` 7 个渲染函数、`inject_at_turn_boundary()` 边界注入、`reset_boundary_flag()` | 25 |
| **Compaction** | **~85%** | `compaction_round()` 完整编排算法（触发判断→delegate 执行→overflow 重试→结果报告）、`CompactionHandoffInfo`、strategy 集成 | 23 |
| **Knowledge** | **~85%** | `categorize()` 关键词自动分类（4 类）、`calculate_confidence()` 置信度评分（source/status/length/tags）、`parse_markdown_knowledge()` MD 导入、SQLite 存储（在 kimi-native-tools） | 15 |

### 1.2 NativeToolset 补齐 — 全部完成

| 项目 | 状态 | 位置 |
|------|------|------|
| 敏感文件过滤（`.env`/凭据/SSH 键） | ✅ 已完成 | `path_access.rs` — 21 种模式 + `.env.*` 变体 + 路径后缀 |
| 符号链接逃逸检测 | ✅ 已完成 | `path_access.rs` — 检查 symlink 目标是否在工作区外 |
| 词法路径规范化（`pathe` 风格） | ✅ 已完成 | `path_access.rs` — normalize/join/canonicalize + Win32 支持 |
| Read 负偏移量（尾部读取） | ✅ 已完成 | `read.rs` — 负 `line_offset` 支持 tail 模式 |
| 权限集成（PermissionManager 接入 NativeToolset） | ✅ 已完成 | `permission.rs` + `permission_rules.rs` + `tool_policy.rs` — DSL 解析 + 规则匹配 |
| Grep: `-i` 不区分大小写 | ✅ 已完成 | `grep.rs` — `case_insensitive` 参数 |
| Grep: `output_mode` | ✅ 已完成 | `grep.rs` — `Content`/`FilesWithMatches`/`CountMatches` |
| Grep: `-A`/`-B`/`-C` 上下文行 | ✅ 已完成 | `grep.rs` — `context`/`before_context`/`after_context` |
| Grep: `type` 过滤器 | ✅ 已完成 | `grep.rs` — `file_type` 参数 + 扩展名映射表 |
| Grep: `include_ignored` | ✅ 已完成 | `grep.rs` — `.gitignore` 跳过控制 |
| 工具生命周期钩子 Rust 内实现 | ✅ 已完成 | `hooks/mod.rs` — `chain()`/`before_step_fn()`/`after_step_fn()` |

---

## Phase 2: v1 模块迁移补齐（3.5 周）

### 2.1 discussion 模块（v1 唯一未迁移模块）

| 组件 | TS 行数 | Rust 依赖 | 工期 |
|------|---------|-----------|------|
| `DiscussionContext`（纯数据结构） | 231 | 无 | ~2 天 |
| `SwarmDiscussionCoordinator`（圆桌讨论） | 320 | 被 `SessionSubagentHost` 阻塞 | ~1 周 |
| `StructuredDebateCoordinator`（结构化辩论） | 608 | 被 `SessionSubagentHost` 阻塞 | ~1.5 周 |
| `SwarmDiscussionTool`（工具集成） | 237 | 被上面全部阻塞 | ~3 天 |

**阻塞链**: Discussion → SessionSubagentHost → Session/Agent → TurnFlow → turn_loop
**必须先稳定 Rust Agent 核心**，否则 discussion 无法迁移。

---

## Phase 3: v2 模块迁移补齐（2-3 周）

| v2 模块 | TS 行 | 策略 | 工期 | 优先级 |
|---------|-------|------|------|--------|
| **systemReminder** | 52 | ✅ **已迁移**（context_memory 已有 `append_system_reminder()`） | 0 | — |
| **shellCommand** | 273 | JS 回调 — Rust 只需消息来源枚举（已有） | 0.5 天 | 🟡 P1 |
| **userTool** | 248 | 混合 — 数据模型已在 Rust 中（`ToolManager`），服务编排层待决定 | 2 天 | 🟡 P1 |
| **contextInjector** | 212 | 移植到 Rust — 升级 `InjectionManager` 加位置跟踪/拼接处理 | 3-5 天 | 🟡 P1 |
| **blob** | 263 | 混合 — LRU 缓存已在 `kimi-native-tools` 中，内容部分重写待移植 | 2-3 天 | 🟢 P2 |
| **externalHooks** | 828 | **仅 JS** — L6 编排层，依赖多个 JS 服务 + `child_process`，不应移植 | 0 | — |
| **plugin** | 179 | **仅 JS** — 高级集成层，依赖 `IPluginService`（仅 JS） | 0 | — |

---

## Phase 4: 默认引擎切换 — v1 与 v2 均已接通 ✅

### 4.1 v1 路径：Rust 引擎已默认且实际生效

`engine` 默认 `'rust'`（schema.ts），且 2026-07-27 修复了三处让它从未真正生效的断点
（commit `0366d2785`）：

1. **裸 `require` 探测 addon**（rust-loop.ts / i18n index.ts）——只在 vitest 的
   CJS 互操作下存在；tsx dev 与 tsdown ESM bundle 里是 ReferenceError，被
   rust-engine.ts 的 catch 吞掉后静默回退 JS。改用 `createRequire(import.meta.url)`。
2. **KimiCore 丢弃 `runTurnOverride`**——类型上声明、实现里从不下传；create 和
   resume 两条 Session 构造路径已补。
3. **流式文本只写 wire 不发 UI**——override 只发 `content.part`（入档），UI 读的
   是 `text.delta`/`thinking.delta`（映射 `assistant.delta`）；三个 dispatch 点已补发。

同时 `nativeTools` 对 rust 引擎改为默认开启（`nativeTools = false` 退出）。

**端到端验证**：`kimi -p` dev 冒烟经 Rust 引擎驱动（host llm_chat 回调 ×2 步、
真实 Read 工具、答案正确渲染）；napi/rust-loop 桥接测试 33 个全绿。

### 4.2 v2 路径：已接通 ✅（2026-07-27，commit `3051a2de1`）

桥接三件套已落地并端到端验证（`KIMI_CODE_EXPERIMENTAL_FLAG=1` 冒烟：Rust 驱动
2 步、经 v2 executor 管线执行真实 Read、答案正确渲染）：

1. **接缝**：`IAgentLoopService.setTurnOverride`；`run()` 先经 `materializeBatch`
   把队列里的 prompt/injection 投递进 context，再整轮委托给外部引擎。
2. **适配器**：`apps/kimi-code/src/cli/v2/rust-engine-v2.ts` —— 复用 v1 的
   `createRunTurnOverride`，llm→llmRequester（保留系统提示词/画像/用量记录）、
   消息→contextMemory、录制事件→appendLoopEvent、工具→toolRegistry +
   toolExecutor（审批/策略/去重/hooks 全保留）、流式 delta→事件总线；
   v1 `{stopReason}` 结果映射为 v2 `LoopRunResult` 判别联合。
3. **布线**：`runV2Print` 在 enqueue 前 `installRustEngineV2`，任何加载失败
   静默回退 JS loop（与 v1 路径同策略）。

剩余加固项（非缺口）已全部关闭：TUI 原生会话默认开启（`6e03f1577`）、`kimi web` 已路由到 Rust 引擎（`f861495e3`）、override 下 mid-turn steer 请求的投递语义已实现（step 间 steer，`51cf1e5c1`）。

---

## Phase 5: 测试 + 性能 + 安全 — 测试覆盖与安全已完成，基准已建立

### 5.1 测试覆盖

| 类型 | 内容 | 当前状态 |
|------|------|---------|
| Rust 单元测试 | 补齐各模块 inline `#[cfg(test)]` | ✅ 完成 — **2003 lib 测试全绿、0 warnings**（2026-08-01 实测） |
| Rust 集成测试 | 真实二进制 + SSE stub、零 host 回调 | ✅ **51 个集成测试全部通过**（`stdio_rpc_integration.rs`，2026-08-01 实测） |
| 安全审计测试 | 敏感文件过滤、路径遍历、权限绕过 | ✅ 完成 — path_access + permission_rules 测试（unsafe 仅剩测试内 2 处） |

### 5.2 性能基准

基准测试框架已建立，运行方式：`cargo bench -p kimi-native-tools`

| 基准测试 | 均值 | 说明 |
|---------|------|------|
| `is_sensitive_file_typical` | ~2.9 µs | 10 条路径敏感文件检测 |
| `path_canonicalize` | ~2.2 µs | 5 条路径规范化+containment |
| `path_normalize_win32` | ~0.5 µs | Win32 路径归一化 |
| `glob_matches_any` | ~74 µs | 5 模式对 2 路径匹配 |
| `permission_parse_pattern` | ~1.9 µs | 5 个 DSL 规则解析 |
| `permission_match_rule` | ~1.1 µs | 单条规则匹配 |
| `estimate_tokens` | ~19 µs | 1000 句 token 估算 |

### 5.3 安全审计

| 检查项 | 方法 |
|--------|------|
| 路径遍历 | 符号链接逃逸检测测试 |
| 敏感文件泄露 | .env/凭据/SSH 键过滤测试 |
| 注入攻击 | tool call arguments 校验测试 |
| 权限绕过 | NativeToolset + PermissionManager 集成测试 |
| RPC 输入验证 | JSON-RPC malformed input 测试 |
| 拒绝服务 | 超大文件/深度目录的 Read/Grep 上限测试 |

---

## 里程碑路线图

```
Phase 0 ── 1 周 ── 环境修复 + 集成测试通过
  │
Phase 1 ── 4 周 ── Rust 引擎功能补全
  ├─ P0: Goal + Plan + 原生工具安全（1 周）
  ├─ P1: Injection + Compaction + Native 工具对等（2 周）
  └─ P2: Knowledge（1 周）
  │
Phase 2 ── 4 周 ── v1 缺失模块（discussion）
  └─ 前提: Agent 核心稳定
  │
Phase 3 ── 3 周 ── v2 缺失模块
  ├─ P1: shellCommand + userTool + contextInjector（2 周）
  └─ P2: blob（1 周）
  │
Phase 4 ── 2 周 ── 默认引擎切换 + v2 集成
  ├─ v1 默认 Rust（0.5 天）
  └─ v2 KapServer RPC 桥接（1.5 周）
  │
Phase 5 ── 3 周 ── 测试 + 性能 + 安全
  ├─ 测试覆盖补全（1 周）
  ├─ 性能基准/优化（1 周）
  └─ 安全审计/修复（1 周）
  │
完成为止: ~17 周（4 个月）
```

## 关键风险

| 风险 | 级别 | 缓解 |
|------|------|------|
| Rust Agent 核心（`Agent`/`TurnFlow`/`SessionSubagentHost`）未稳定 → 阻塞 discussion | 🔴 高（已缓解） | ✅ 已解除 — 2026-07-31 SwarmDiscussion / AgentSwarm 原生化，集成测试零 host 回调通过 |
| v2 DI 服务架构复杂 → KapServer 桥接方案可能不够 | 🟡 中（已落地） | ✅ 已解除 — web session 后端（RustSessionService）上线，替换 v2-backed 路由 |
| Grep 参数太多 → 12 个缺失参数中有 6 个已通过 host 回退处理 | 🟢 低（已解除） | ✅ 全部移植 — -i / output_mode / -A/-B/-C / type / include_ignored |
| Node.js 版本不匹配（需要 >=24.15.0，当前 22.16.0）| 🟡 中（已解决） | ✅ 已升级 — 本机实测 v24.18.0（另有 `D:/kimi/node24` 便携包） |