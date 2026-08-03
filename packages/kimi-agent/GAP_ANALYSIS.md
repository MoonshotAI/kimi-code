# Rust Agent 引擎 — v1/v2 迁移 Gap Analysis

生成日期: 2026-07-26（末次更新: 2026-08-01 — 对齐 Phase 0-5 完成后实测）
数据来源: `packages/kimi-agent/src/` (88,634 行 Rust, 233 文件, 1,836 `#[test]` 属性，2026-08-01 实测) vs `packages/agent-core/src/` (72,546 行 TS) vs `packages/agent-core-v2/src/` (96,735 行 TS)

> **📌 本文件为模块映射明细；进度权威见仓库根 `RUST_MIGRATION_PLAN.md`（当前状态 2026-08-01：`cargo test -p kimi-agent` = 2011 lib 全绿、0 warnings）。**

---

## 1. 代码量总览

| Codebase | 文件数 | 代码行数 | 相对 kimi-agent |
|----------|--------|---------|-----------|
| kimi-agent（主引擎） | 233 `.rs` | **88,634** | 基线 |
| kimi-native-tools | 54 `.rs` | 25,357 | 29% |
| kimi-shared | 3 `.rs` | 797 | 1% |
| **Rust 全工作区（5 crate）** | **319 `.rs`** | **121,917** | — |
| v1 agent-core | 372 `.ts` | 72,546 | 82% |
| v2 agent feature 层 | 234 `.ts` | 33,150 | 37% |
| v2 app 框架层 | — | 22,937 | 26% |
| v2 _base 基础层 | — | 7,433 | 8% |
| **全部 TS（v1+v2）** | **~700+** | **136,066** | **154%** |

> 主引擎 kimi-agent 代码量约为全部 TS 的 **65%**。但这不是"迁移了 65%"——Rust 引擎是选择性重写，不是逐行翻译。许多 TS 代码是框架/DI 基础设施，Rust 无需对应。

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
| injection | 8 | 345 | `src/injection/` | ✅ 完整（7 个渲染函数 + 边界注入 + 复位标志，25 测试） |
| skill | 3 | 331 | `src/skill/` | ✅ 完整 |
| tool | 2 | 1,001 | `src/tools/` | ✅ 超越（新增 NativeToolset） |
| compaction | 7 | 376 | `src/compaction/` | ✅ 完整（handoff + overflow 重试收缩 + strategy 集成，23 测试） |
| records | 8 | 447 | `src/records/` | ✅ 完整 |
| replay | 3 | 251 | `src/replay/` | ✅ 完整 |
| turn/context | 12 | 3,500+ | `src/turn_loop/` + `src/context/` | ✅ 超越（新增 prediction 机制） |
| config | 3 | 787 | `src/config/` | ✅ 完整 |
| **discussion** | **4** | **~900** | **`src/discussion/`** | **✅ 完整（2026-07-31 原生化：async 化 + `NativeDiscussionHost` + 集成测试）** |
| permission | 16+ | 1,502 | `src/permission/` | ✅ 超越（合并为统一 policy 引擎） |

**v1 统计: 15/15 模块已覆盖（100%）**

> 注：表中「Rust 行数」为 2026-07-26 快照口径；其后经重写/接线，各模块行数普遍增长（全引擎现为 88,634 行，2026-08-01 实测）。

---

## 3. v2 迁移对照

| v2 功能域 | TS 行数 | Rust 行数 | Rust 路径 | 状态 |
|-----------|---------|----------|-----------|------|
| activityView | 472 | 1,053 | `activity_view/` | ✅ 完整（2026-07-26 重写：事件折叠视图 + 发布去重，24 测试） |
| contextSize | 193 | 内置 | `context/size.rs` | ✅ 完整 |
| scopeContext | 39 | 内置 | `context/scope.rs` | ✅ 完整 |
| faultInjection | 171 | 182 | `fault_injection/` | ✅ 完整（2026-07-26 重写：一次性闩锁 arm/take/status/clear，8 测试） |
| contextMemory | 1,984 | 3,312 | `context/` | ✅ 完整（2026-07-26 重写：fold + ops + compaction handoff，167 测试） |
| contextProjector | 651 | 882 | `context/projector.rs` | ✅ 超越 |
| goal | 3,029 | 2,196 | `goal/` | ✅ 完整（2026-07-26 补齐：judge 提示词 + JSON 裁决解析 + 分状态 reminder，29 新测试） |
| knowledge | 722 | 1,285 | `knowledge/` | ✅ 完整（2026-07-26 补齐：注入信号提取 CJK bigram + 自动学习器，38 新测试） |
| llmRequester | 959 | 2,578 | `llm/` | ✅ 超越（含原生 HTTP/多 provider） |
| mcp | 3,815 | 2,453 | `mcp/` | ✅ 核心完整（2026-07-26 补齐：output 管线 + 连接状态机 + SSRF URL 门，54 新测试；OAuth/SDK 客户端留 host） |
| media | 2,649 | 58 | `media/` | 🟡 委托 JS host |
| permission (4 个) | 1,334 | 1,502 | `permission/` | ✅ 超越（统一引擎） |
| plan | 1,167 | 846 | `plan/` | ✅ 完整（2026-07-26 补齐：wire ops + revision 计数 + 提醒注入状态机，22 新测试） |
| profile | 1,532 | 2,568 | `profile/` | ✅ 完整（2026-07-26 重写：ops + thinking 决议 + 服务状态机，62 测试） |
| prompt | 440 | 589 | `prompt/` | ✅ 完整（完整队列/异步，39 测试） |
| questionTools | 399 | 625 | `question_tools/` | ✅ 完整（2026-07-26 重写：校验/归一化/后台任务流，23 测试） |
| rpc | 776 | 1,727 | `rpc/` | ✅ 超越（含 JSON-RPC server） |
| skill | 465 | 330 | `skill/` | ✅ 完整 |
| swarm | 587 | 526 | `swarm/` | ✅ 完整（2026-07-26 补齐：进出提醒副作用 + 批次互斥 veto，16 新测试） |
| task | 2,440 | 3,277 | `task/` | ✅ 完整（2026-07-26 重写：ghosts + 通知去重 + 输出环，137 测试） |
| usage | 277 | 321 | `usage/` | ✅ 完整 |
| fullCompaction | 1,386 | 2,162 | `compaction/` | ✅ 完整（2026-07-26 重写：strategy/utils/ops + 溢出重试收缩，68 测试） |
| loop | 1,890 | 6,081 | `turn_loop/` + `t_flow` | ✅ 超越 |
| stepRetry | 148 | 322+ | `turn_loop/retry.rs` | ✅ 完整 |
| toolDedupe | 436 | 内置 | `turn_loop/tool_dedup.rs` | ✅ 完整 |
| toolExecutor | 1,402 | 内置 | `turn_loop/tool_call.rs` + `tool_scheduler.rs` | ✅ 核心完整 |
| toolPolicy | 292 | 内置 | `permission/policies/` | ✅ 完整 |
| toolRegistry | 251 | 633 | `tools/manager.rs` | ✅ 超越 |
| toolResultTruncation | 152 | 内置 | `turn_loop/tool_result_budget.rs` | ✅ 完整 |
| toolSelect | 676 | 1,112 | `tool_select/` | ✅ 完整（2026-07-26 新增：渐进披露服务状态机，41 测试） |
| toolApproval | 313 | 内置 | `permission/` | ✅ 完整 |
| shellCommand | 273 | 231 | `shell_command/` | ✅ 完整（事件/取消/context 记录，5 测试） |
| userTool | 248 | 270 | `user_tool/` | ✅ 完整（ToolManager 集成 + 继承 + 恢复，7 测试） |
| contextInjector | 212 | 443 | `context_injector/` | ✅ 完整（位置跟踪 + splice + resync，9 测试） |
| systemReminder | 52 | 内置 | `context/context_memory.rs` | ✅ 完整（`append_system_reminder`） |
| blob | 263 | 632 | `blob/` | ✅ 超越（ByteLruCache + data URI，16 测试） |
| git | — | — | `git/` | ✅ 完整（2026-07-31：parsers + service + status/diff RPC + `<git-context>` 注入，14 测试） |
| memory | — | — | `memory/` | ✅ 完整（2026-07-31：paths + store + tool，14 测试 + 零 host 集成测试） |
| externalHooks | 828 | — | — | ⚪ 设计上留 JS（child_process + JS 服务编排） |
| plugin | 179 | — | — | ⚪ 设计上留 JS（IPluginService 仅 JS） |

**v2 统计: 42/45 功能域达到语义对等（2026-07-31 补齐 git / memory；media / externalHooks / plugin 设计上留在 JS host，经 HostCallbacks 桥接）**

---

## 4. 测试状态

### 4.1 TS 测试（vitest）
- 基线: 651 tests passing（历史，来自 `plan.md`）
- 当前: kimi-agent 包内 vitest **38/38 全绿**（含 stdio e2e，2026-08-01 复验）；全仓 1,127 个 `*.test.ts` 文件
- `failed-tests.txt`: 0 行（未记录）

### 4.2 Rust 集成测试（cargo test）
`tests/stdio_rpc_integration.rs` 共 **51 个集成测试**（真实 `kimi-agent-cli` 二进制 + SSE stub / 零 host 回调），覆盖：cron 生命周期与跨会话恢复、bg 任务（register/list/output/settle/restart 恢复）、session（destroy/load 重建、startBtw 侧问、init 生成 AGENTS.md）、hooks 事件面、approval 面、AgentSwarm / SwarmDiscussion 子代理编排、git status、memory 持久化等。

**当前状态（2026-08-03 核对）**：`cargo test -p kimi-agent` = **2011 lib 全绿、0 warnings**；工作区各 crate 合计约 **2,700+ 测试**（kimi-agent 2011 + 集成 51 + native-tools 617 + kimi-shared 47；kosong/native 已退役删除，2026-08-03）。需要 Rust 工具链与 Node.js >=24.15.0（本机实测 v24.18.0）。

| 等级 | 含义 | 模块数 | 备注 |
|------|------|--------|------|
| ✅ 超越 | Rust 版本功能更多（prediction、tool conflict 检测、统一权限引擎等） | ~15 | — |
| ✅ 完整 | 核心功能一致 | ~26 | 含 2026-07-31 补入的 git / memory / discussion |
| 🟡 简化 | 核心功能有但精简（委托到 JS host） | ~1 | media |
| ⚪ 设计上留 JS | 依赖 JS 运行时（child_process / IPluginService） | 2 | externalHooks / plugin |
| ❌ 未迁移 | Rust 中不存在 | 0 | — |

---

## 5. 按层分析

### 5.1 核心执行层 ✅ 100% 覆盖

`turn_loop` + `llm` + `tools` + `permission` + `rpc` + `agent/turn_flow`

占 Rust 引擎 **~70% 代码量**（88,634 行口径下约 60,000+ 行）。包含：
- 异步 turn 循环（prediction 支持、hook 系统、budget 检查）
- 多 LLM provider（原生 HTTP、Host Proxy、MultiLLM）
- 原生工具执行（Read/Grep/Glob 沙箱执行）
- 权限策略引擎（20+ 策略）
- JSON-RPC 2.0 协议（stdio 和 napi-rs 双形态）

### 5.2 状态管理层 🟡 核心已迁移

`goal` + `plan` + `swarm` + `compaction` + `records`

Rust 实现状态机核心，持久化和事件通过 `HostCallbacks` 委托给 JS 宿主。这是合理的设计——Rust 负责性能敏感的状态判断，TS 负责持久化和 UI。

### 5.3 宿主服务层 — 设计上留 host

`media` + `externalHooks` + `plugin`

这些是宿主环境服务，**设计上留在 JS host**（media 委托 host；externalHooks 依赖 `child_process` + JS 服务编排；plugin 依赖 `IPluginService`）。通过 `HostCallbacks` trait 桥接是正确架构。（`blob` / `systemReminder` 已原生实现，不再属于本层。）

### 5.4 待迁移模块 — 已清零 ✅

原表所列（shellCommand / userTool / contextInjector / systemReminder / discussion）已于 2026-07-31 前全部完成迁移，现无待迁移模块。当前剩余工作均为**接入与收尾**，见 `RUST_MIGRATION_PLAN.md`「待办」。

---

## 6. 集成状态（引擎实际使用情况）

> 前面的分析回答了"Rust 代码是否写了"，这里回答"Rust 引擎是否真的在用"。

### 6.1 CLI 引擎选择路径

```
kimi -p <prompt>
  │
  ├─ [v1 路径] 默认（config.agent.engine = "rust"，schema.ts 默认值）
  │   └─ createRunTurnOverride() → kimi-agent Rust 引擎执行 turn loop
  │       └─ nativeTools 对 rust 引擎默认开启（`nativeTools = false` 才退出）
  │
  └─ [v2 路径] KIMI_CODE_EXPERIMENTAL_FLAG=1 → runV2Print()
      └─ installRustEngineV2() → 经 v2 executor 管线委托 Rust 引擎
          └─ 加载失败静默回退 JS loop（与 v1 同策略）
```

### 6.2 各路径的实际依赖

| 组件 | v1（Rust 默认） | v2（Rust 桥接） | web session（RustSessionService） |
|------|----------------|----------------|----------------------------------|
| turn loop | **kimi-agent Rust** | **kimi-agent Rust**（materializeBatch + setTurnOverride） | **kimi-agent Rust**（rust-loop createSessionClient） |
| LLM 通信 | Rust（native HTTP / host proxy） | Rust（native-LLM transport，`d510b80f0`） | Rust |
| 工具执行 | Rust（native 或 host 回调） | Rust（toolRegistry + toolExecutor，审批/策略/去重保留） | Rust |
| 权限检查 | **kimi-agent Rust** | Rust（经工具管线） | Rust（session/approval_list + resolve） |
| 原生工具 | kimi-agent Rust 内置 | 同左 | 同左 |
| Goal 模式 | **kimi-agent Rust** | Rust | Rust |
| 持久化 | Rust（SQLite，`KIMI_AGENT_HOME`） | 同左 | 同左 |
| 事件面 | Rust → host 回调 | Rust → v2 事件总线 | Rust → v1 wire 投影（projectRustEvent） |

### 6.3 结论

- **v1 路径**: Rust 引擎为**唯一引擎**（`agent.engine = "rust"`，schema.ts 枚举已移除 `js`），加载失败抛错而非回退 JS
- **v2 路径**: Rust 引擎**已接通**（commit `3051a2de1` + `installRustEngineV2`，端到端验证）；v2 loop 工厂失败改重新抛出
- **web session**: `RustSessionService`（`87833b1be` + 路由接线 `f861495e3`）直接绑定引擎会话；缺失二进制启动即报错，不再回退 v2-backed 路由
- **Rust 引擎当前角色**: v1 / v2 / web 三面的统一引擎 —— **JS 引擎(agent-core/agent-core-v2 loop)已全面退役**（2026-08-01，无 JS 回退路径）

### 迁移进度总结（2026-08-01 对齐实测）

| 维度 | 数值 |
|------|------|
| v1 模块覆盖率 | **100%**（15/15，含 discussion） |
| v2 功能域覆盖率 | **100% 可迁移域**（42/45；git / memory 07-31 补齐；media / externalHooks / plugin 设计上留 host） |
| 核心执行路径 | **100%** |
| 单元测试 | **1,836 `#[test]` 属性**（src 实测）；cargo 口径 2011 lib 全绿、0 warnings（2026-08-01 实测） |
| 集成测试 | **51**（`tests/stdio_rpc_integration.rs`，真实二进制） |
| 引擎规模 | 88,634 行 / 233 文件（kimi-agent/src，2026-08-01 实测） |

### Rust 引擎的实际角色

Rust 引擎不是"把全部 TS 翻译成 Rust"，而是**选择性重写**：

1. **核心性能路径** → Rust（turn loop、LLM、工具、权限）— 完成
2. **状态机与决策核心** → Rust（goal、plan、swarm、compaction、task、mcp 连接、toolSelect 披露）— 完成；持久化/定时器/进程 I/O 经 HostCallbacks 委托
3. **宿主服务** → 留在 TS，通过回调桥接（media、externalHooks、plugin、MCP OAuth/SDK 客户端）— 设计决定，非缺口

### 剩余工作（代码之外）

代码覆盖已到位；剩余是**接入与收尾**（详见 `RUST_MIGRATION_PLAN.md`「待办」）：
- 上游 0.31.1+ 同步（见 `上游更新/` 目录的 A/B/C 分区逐项评估；A 表 25 项已全部定案，剩余 C3 插件通知待核对）
- Bash 命令策略审批强化
- goal/compaction/permission 双实现合并进 kimi-shared（当前 pkce + sensitive / line_endings + tokens 两批，第三批待做）
- ~~`pnpm gen:wire` 接入 CI 漂移检查~~ ✅ 已上线（commit `50bc82db2`，wire-contract job）
- ~~web session 的 WS frame fan-out（onFrame）待接~~ ✅ 已接（commit `eb8d0f783`，HTTP + WS 事件面全通）