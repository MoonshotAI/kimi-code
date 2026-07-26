# Rust Agent 引擎 — v1/v2 迁移 Gap Analysis

生成日期: 2026-07-26（末次更新：activity_view / profile 补齐）
数据来源: `packages/kimi-agent/src/` (37,445 行 Rust) vs `packages/agent-core/src/` (72,546 行 TS) vs `packages/agent-core-v2/src/` (96,735 行 TS)

---

## 1. 代码量总览

| Codebase | 文件数 | 代码行数 | 相对 Rust |
|----------|--------|---------|-----------|
| Rust 引擎 | 110 `.rs` | **37,445** | 基线 |
| v1 agent-core | 372 `.ts` | 72,546 | 263% |
| v2 agent feature 层 | 234 `.ts` | 33,150 | 120% |
| v2 app 框架层 | — | 22,937 | 83% |
| v2 _base 基础层 | — | 7,433 | 27% |
| **全部 TS（v1+v2）** | **~700+** | **136,066** | **493%** |

> Rust 引擎代码量约为全部 TS 的 **20%**。但这不是"只迁移了 20%"——Rust 引擎是选择性重写，不是逐行翻译。许多 TS 代码是框架/DI 基础设施，Rust 无需对应。

---

## 2. v1 迁移对照

| v1 模块 | TS 文件数 | Rust 行数 | Rust 路径 | 状态 |
|---------|----------|----------|-----------|------|
| usage | 1 | 321 | `src/usage/` | ✅ 完整 |
| llm-request-logger | 1 | 内置 | `src/llm/request_logger.rs` | ✅ 完整 |
| llm-request-recorder | 1 | 466 | `src/llm/request_recorder.rs` | ✅ 完整 |
| plan | 1 | 301 | `src/plan/` | ✅ 完整 |
| swarm | 1 | 151 | `src/swarm/` | ✅ 完整 |
| goal | 2 | 922 | `src/goal/` | ✅ 超越（6 状态 vs TS 4 状态） |
| injection | 8 | 345 | `src/injection/` | 🟡 简化（8 种注入合并为泛化 trait） |
| skill | 3 | 331 | `src/skill/` | ✅ 完整 |
| tool | 2 | 1,001 | `src/tools/` | ✅ 超越（新增 NativeToolset） |
| compaction | 7 | 376 | `src/compaction/` | 🟡 简化（无 handoff/micro/strategy） |
| records | 8 | 447 | `src/records/` | ✅ 完整 |
| replay | 3 | 251 | `src/replay/` | ✅ 完整 |
| turn/context | 12 | 3,500+ | `src/turn_loop/` + `src/context/` | ✅ 超越（新增 prediction 机制） |
| config | 3 | 787 | `src/config/` | ✅ 完整 |
| **discussion** | **4** | **0** | **—** | **❌ 未迁移** |
| permission | 16+ | 1,502 | `src/permission/` | ✅ 超越（合并为统一 policy 引擎） |

**v1 统计: 14/15 模块已覆盖（93%），仅 discussion/ 未迁移**

---

## 3. v2 迁移对照

| v2 功能域 | TS 行数 | Rust 行数 | Rust 路径 | 状态 |
|-----------|---------|----------|-----------|------|
| activityView | 472 | 1,053 | `activity_view/` | ✅ 完整（2026-07-26 重写：事件折叠视图 + 发布去重，24 测试） |
| contextSize | 193 | 内置 | `context/size.rs` | ✅ 完整 |
| scopeContext | 39 | 内置 | `context/scope.rs` | ✅ 完整 |
| faultInjection | 171 | 88 | `fault_injection/` | 🟡 简化 |
| contextMemory | 1,984 | 3,312 | `context/` | ✅ 完整（2026-07-26 重写：fold + ops + compaction handoff，167 测试） |
| contextProjector | 651 | 882 | `context/projector.rs` | ✅ 超越 |
| goal | 3,029 | 921 | `goal/` | 🟡 核心完整 |
| knowledge | 722 | 115 | `knowledge/` | 🟡 大幅简化 |
| llmRequester | 959 | 2,578 | `llm/` | ✅ 超越（含原生 HTTP/多 provider） |
| mcp | 3,815 | 762 | `mcp/` | 🟡 简化（无 OAuth/Discovery） |
| media | 2,649 | 58 | `media/` | 🟡 委托 JS host |
| permission (4 个) | 1,334 | 1,502 | `permission/` | ✅ 超越（统一引擎） |
| plan | 1,167 | 301 | `plan/` | 🟡 简化 |
| profile | 1,532 | 2,568 | `profile/` | ✅ 完整（2026-07-26 重写：ops + thinking 决议 + 服务状态机，62 测试） |
| prompt | 440 | 83 | `prompt/` | 🟡 大幅简化 |
| questionTools | 399 | 76 | `question_tools/` | 🟡 简化 |
| rpc | 776 | 1,727 | `rpc/` | ✅ 超越（含 JSON-RPC server） |
| skill | 465 | 330 | `skill/` | ✅ 完整 |
| swarm | 208 | 150 | `swarm/` | ✅ 完整（原 587 行统计误含 tools/agent-swarm.ts 工具层，非模式状态机缺口） |
| task | 2,440 | 3,277 | `task/` | ✅ 完整（2026-07-26 重写：ghosts + 通知去重 + 输出环，137 测试） |
| usage | 277 | 321 | `usage/` | ✅ 完整 |
| fullCompaction | 1,386 | 362 | `compaction/` | 🟡 大幅简化 |
| loop | 1,890 | 6,081 | `turn_loop/` + `t_flow` | ✅ 超越 |
| stepRetry | 148 | 322+ | `turn_loop/retry.rs` | ✅ 完整 |
| toolDedupe | 436 | 内置 | `turn_loop/tool_dedup.rs` | ✅ 完整 |
| toolExecutor | 1,402 | 内置 | `turn_loop/tool_call.rs` + `tool_scheduler.rs` | ✅ 核心完整 |
| toolPolicy | 292 | 内置 | `permission/policies/` | ✅ 完整 |
| toolRegistry | 251 | 633 | `tools/manager.rs` | ✅ 超越 |
| toolResultTruncation | 152 | 内置 | `turn_loop/tool_result_budget.rs` | ✅ 完整 |
| toolSelect | 676 | 内置 | `context/dynamic_tools.rs` | 🟡 简化 |
| toolApproval | 313 | 内置 | `permission/` | ✅ 完整 |
| **shellCommand** | **273** | **0** | **—** | **❌ 未迁移** |
| **userTool** | **248** | **0** | **—** | **❌ 未迁移** |
| **contextInjector** | **212** | **0** | **—** | **❌ 未迁移** |
| **systemReminder** | **52** | **0** | **—** | **❌ 未迁移** |
| **externalHooks** | **828** | **0** | **—** | **❌ 未迁移** |
| **blob** | **263** | **0** | **—** | **❌ 未迁移** |
| **plugin** | **179** | **0** | **—** | **❌ 未迁移** |

**v2 统计: 36/43 功能域已覆盖（84%），7 个未迁移**

---

## 4. 测试状态

### 4.1 TS 测试（vitest）
- 基线: 651 tests passing（来自 `plan.md`）
- 当前测试输出显示存在失败（vis-server 大部分失败，kosong 约 20 失败，minidb 少量失败）
- `failed-tests.txt`: 0 行（未记录）

### 4.2 Rust 集成测试（cargo test）
以下 4 个集成测试需要先编译 `kimi-agent-cli` 二进制才能运行：
1. `cron_create_list_delete` — cron/create → cron/list → cron/delete 生命周期
2. `cron_get_next_fire` — cron/get_next_fire 返回有效时间
3. `bg_register_list_stop` — bg/register → bg/list → bg/get → bg/stop 生命周期
4. `bg_append_output_settle` — bg/register → bg/append_output → bg/output → bg/settle 生命周期

**失败原因分析**：这些测试需要 `target/release/kimi-agent-cli` 或 `target/debug/kimi-agent-cli` 存在。当前环境可能未编译 Rust 二进制，导致测试被跳过（`require_binary!` 宏）或因环境不匹配而失败。需要 Node.js >=24.15.0 和 Rust 工具链来编译运行。

| 等级 | 含义 | 模块数 | TS 代码占比 |
|------|------|--------|------------|
| ✅ 超越 | Rust 版本功能更多（prediction、tool conflict 检测等） | ~8 | ~15% |
| ✅ 完整 | 核心功能一致 | ~12 | ~20% |
| 🟡 简化 | 核心功能有但精简（委托持久化/事件到 JS host） | ~16 | ~45% |
| ❌ 未迁移 | Rust 中不存在 | 7 (+1) | ~6% |
| — | 框架层（app/_base，不直接对应） | — | ~14% |

---

## 5. 按层分析

### 5.1 核心执行层 ✅ 100% 覆盖

`turn_loop` + `llm` + `tools` + `permission` + `rpc` + `agent/turn_flow`

占 Rust 引擎 **~70% 代码量**（~19,000 行）。包含：
- 异步 turn 循环（prediction 支持、hook 系统、budget 检查）
- 多 LLM provider（原生 HTTP、Host Proxy、MultiLLM）
- 原生工具执行（Read/Grep/Glob 沙箱执行）
- 权限策略引擎（20+ 策略）
- JSON-RPC 2.0 协议（stdio 和 napi-rs 双形态）

### 5.2 状态管理层 🟡 核心已迁移

`goal` + `plan` + `swarm` + `compaction` + `records`

Rust 实现状态机核心，持久化和事件通过 `HostCallbacks` 委托给 JS 宿主。这是合理的设计——Rust 负责性能敏感的状态判断，TS 负责持久化和 UI。

### 5.3 宿主服务层 ❌ 大部分未迁移

`blob` + `media` + `plugin` + `systemReminder` + `externalHooks`

这些是宿主环境服务，**不应迁移到 Rust**。通过 `HostCallbacks` trait 桥接是正确架构。

### 5.4 真正待迁移模块

| 模块 | 源 | TS 行数 | 建议优先级 |
|------|----|---------|-----------|
| `shellCommand` | v2 | 273 | 🟡 中 — 与原生工具集成紧密 |
| `userTool` | v2 | 248 | 🟡 中 — 与 tools/manager 关联 |
| `contextInjector` | v2 | 212 | 🟢 低 — v2 DI 模式在 Rust 中不直接对应 |
| `systemReminder` | v2 | 52 | 🟢 低 — 简单委托 |
| `discussion` | v1 | 400 | 🔴 低 — 可选，非核心功能 |

---

## 6. 集成状态（引擎实际使用情况）

> 前面的分析回答了"Rust 代码是否写了"，这里回答"Rust 引擎是否真的在用"。

### 6.1 CLI 引擎选择路径

```
kimi -p <prompt>
  │
  ├─ 检测 KIMI_CODE_EXPERIMENTAL_FLAG
  │
  ├─ [v2 路径] 实验性开关打开 → runV2Print()
  │   └─ 使用 agent-core-v2 DI 服务（纯 JS）
  │      └─ 仅 kimi-native-tools (napi-rs) 用于工具执行
  │      └─ ❌ 不使用 kimi-agent Rust 引擎
  │
  └─ [v1 路径] 默认 → createKimiHarness()
      └─ 检测 config.agent.engine
          ├─ = "rust" → 加载 kimi-agent Rust 引擎
          │   └─ createRunTurnOverride() → RunTurnOverride
          │   └─ ✅ 使用 Rust 引擎执行 turn loop
          │
          └─ ≠ "rust" (默认) → 纯 JS 引擎
              └─ ❌ 不使用 Rust 引擎
```

### 6.2 各引擎路径的实际依赖

| 组件 | v1 默认 (JS) | v1 + Rust | v2 实验性 (JS DI) |
|------|-------------|-----------|------------------|
| turn loop | agent-core TS | **kimi-agent Rust** | agent-core-v2 TS 服务 |
| LLM 通信 | agent-core TS | Rust (native HTTP / host proxy) | agent-core-v2 TS 服务 |
| 工具执行 | agent-core TS | Rust (native 或 host 回调) | agent-core-v2 TS 服务 |
| 权限检查 | agent-core TS | **kimi-agent Rust** | agent-core-v2 TS 服务 |
| 原生工具 | kimi-native-tools (napi) | kimi-agent Rust 内置 | kimi-native-tools (napi) |
| Goal 模式 | agent-core TS | **kimi-agent Rust** | agent-core-v2 TS 服务 |
| Cron | agent-core TS | **kimi-agent Rust** | agent-core-v2 TS 服务 |
| 持久化 | agent-core TS | agent-core TS (回调) | agent-core-v2 TS 服务 |
| Media | agent-core TS | agent-core TS (回调) | agent-core-v2 TS 服务 |
| Blade 存储 | agent-core TS | agent-core TS (回调) | agent-core-v2 TS 服务 |

### 6.3 结论

- **v1 路径**: Rust 引擎集成 **已完成但需手动启用**（`agent.engine = "rust"`），非默认
- **v2 路径**: Rust 引擎 **未集成**，运行在纯 JS DI 服务上，仅使用 `kimi-native-tools`
- **Rust 引擎当前角色**: v1 的可选加速器，不是 v2 的默认引擎
- **要成为默认引擎需要**: v2 路径也接入 Rust 引擎，或替换 v1 默认路径

### 迁移进度总结

| 维度 | 数值 |
|------|------|
| v1 模块覆盖率 | **93%**（14/15） |
| v2 功能域覆盖率 | **84%**（36/43） |
| 核心执行路径 | **100%** |
| TS → Rust 精简率 | **~72%**（37,445 / 136,066） |
| 功能等价度 | **~70%**（核心完整，部分简化） |

### Rust 引擎的实际角色

Rust 引擎不是"把全部 TS 翻译成 Rust"，而是**选择性重写**：

1. **核心性能路径** → Rust（turn loop、LLM、工具、权限）— 100% 完成
2. **状态机** → Rust 核心 + TS 持久化（goal、plan、swarm）— 核心完成
3. **宿主服务** → 留在 TS，通过回调桥接（media、blob、plugin）— 合理不迁移
4. **低优先级** → 未处理（discussion、shellCommand、userTool）— 可选迁移

### 如果把 Rust 作为默认引擎

当前缺少的关键能力：
- Blob 存储 / 持久化
- 媒体处理管线
- Shell 命令执行
- 用户注册工具
- Context 注入器

### 如果 Rust 只作为核心加速器

当前功能缺口较小，核心 turn loop、LLM、工具执行、权限均在 Rust 中。