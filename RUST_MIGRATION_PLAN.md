# Rust Agent 引擎 — 完整修复补全计划

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
| Grep: `include_ignored` | 0.25 天 | 🟡 P1 |
| 工具生命周期钩子 Rust 内实现 | 2 天 | 🟡 P1 |

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

## Phase 4: 默认引擎切换 — v1 已真实接通 ✅（2026-07-27），v2 待做

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

### 4.2 v2 路径：待完成（剩余的唯一大项）

**现状**: v2 (`runV2Print` / `kimi web`) 使用纯 JS DI 服务，`agent-core-v2` 对
`kimi-agent` 引用为 0。v2 的 turn 由 `IAgentPromptService.enqueue()` →
`AgentLoopService.run()` 驱动，与 llmRequester / toolExecutor / stepRequestQueue /
loopContinuation 等服务深度耦合——桥接需要给 `run()` 增加 override 接缝，并写
v2 服务 → RunTurnOverride 输入的适配层（对应 v1 的 rust-loop 适配器）。
预估 1-2 周，是迁移收尾的最后一块。

---

## Phase 5: 测试 + 性能 + 安全 — 测试覆盖与安全已完成，基准已建立

### 5.1 测试覆盖

| 类型 | 内容 | 当前状态 |
|------|------|---------|
| Rust 单元测试 | 补齐各模块 inline `#[cfg(test)]` | ✅ 完成 — 130 个测试函数覆盖所有模块 |
| Rust 集成测试 | cron/bg 二进制测试、turn loop mock 测试 | ✅ 10 个集成测试全部通过 |
| 安全审计测试 | 敏感文件过滤、路径遍历、权限绕过 | ✅ 完成 — path_access 新增 15 个测试，permission_rules 新增 5 个 |

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
| Rust Agent 核心（`Agent`/`TurnFlow`/`SessionSubagentHost`）未稳定 → 阻塞 discussion | 🔴 高 | 优先稳定 Agent 核心；若不可行则标记 discussion 为"不迁移" |
| v2 DI 服务架构复杂 → KapServer 桥接方案可能不够 | 🟡 中 | 方案 A 兜底；若不行则转向方案 B |
| Grep 参数太多 → 12 个缺失参数中有 6 个已通过 host 回退处理 | 🟢 低 | 只移植高频参数（-i, output_mode, -A/-B/-C） |
| Node.js 版本不匹配（需要 >=24.15.0，当前 22.16.0）| 🟡 中 | 升级 Node.js 版本 |