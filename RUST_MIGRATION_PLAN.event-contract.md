# 事件契约向引擎靠拢专项（消除翻译层）

> 权威专项计划。目标：让 SDK 公共事件面（`Session.onEvent`）以 Rust 引擎语义为基准，
> 删除 `event-translate.ts` 翻译层。用户已确认方向：**协议向引擎靠**（2026-08-02）。
>
> 状态：计划定稿，未开始实施。实施进度见文末"进度追踪"。

## 1. 问题与动机

当前存在**两套事件词汇表**，靠 `packages/node-sdk/src/rust/event-translate.ts`（220 行）翻译：

| | 引擎事件（`host/event`，snake_case） | SDK 事件（protocol `AgentEvent`，camelCase） |
|---|---|---|
| 例子 | `session.turn.started` / `llm.delta` / `session.tool.started` | `turn.started` / `assistant.delta` / `tool.call.started` |
| 位置 | `kimi-agent/src/agent/agent.rs` + `llm/http.rs` | `protocol/src/events.ts` |
| 消费者 | kap-server WS 广播、CLI 原生会话 | CLI TUI / ACP adapter / kap-server |

翻译层做三件事：**形状映射**（snake→camel）、**turn 状态机**（`llm.delta` 不带 `turn_id`，靠 `session.turn.started` 记住）、**语义补全**（`origin`、`agentId/sessionId` 路由）。

**决策（用户 2026-08-02）**：协议向引擎靠——SDK/protocol 事件契约重写为引擎 snake_case 语义集合，
消费方全部改用引擎形状，翻译层删除。`llm.delta` 不带 `turn_id`、`turn.step.*` 等引擎不产生的事件
从契约中删除，均作为引擎形状的既定事实被消费方接受。

## 2. 事实基线（改动前必须核实的现状）

- 引擎事件 14 种（见 §3），全部 snake_case，发射点在 `kimi-agent/src/agent/agent.rs` 与 `llm/http.rs`。
- 宿主合成事件 5 种（`config.update` / `session.closed` / `session.renamed` / `turn.steer` /
  `permission.set_mode`），当前在 `node-sdk/src/rust/rpc-client.ts` 用 `emitSynthetic` 发 camelCase。
- `turn.step.*` / `tool.progress` / `tool.call.delta` / `tool.list.updated` / `shell.started` 等在
  node-sdk 与 kimi-agent **无发射点**（agent-core 时代遗留 dead 分支），从契约中删除。
- SDK `Event` 类型 = `protocol` 的 `AgentEvent & { agentId; sessionId }`（`events.ts:959`），
  `node-sdk/src/events.ts` 从 `@moonshot-ai/protocol` re-export。
- kap-server `rustSessionService.ts:projectRustEvent`（~134-200 行）已消费引擎 snake_case 事件，
  映射到 WS v1 帧（`agent.turn.ended` 等）——这是唯一**已经以引擎形状工作**的消费方。
- CLI TUI 消费：`apps/kimi-code/src/tui/controllers/session-event-handler.ts`（40 种 case 分支，
  大部分 dead）、`btw-panel.ts`、`subagent-event-handler.ts`、`session-replay.ts`、`workflow-panel.ts`。
- ACP adapter 消费：`packages/acp-adapter/src/events-map.ts`、`server.ts`、`session.ts`、`approval.ts`。
- 现有集成测试 397/449（88%）。事件相关失败：`session-prompt-events`(15)、
  `session-plan-compact-usage-resume`(5)、`session-cancel`(4)。这些测试期望 camelCase 事件，
  将在本专项中重写为引擎形状。
- agent-core（退役包）的 `src/rpc/events.ts`、`src/services/event/*` 也消费 protocol Event——
  本专项**不动 agent-core**（它不参与运行，最终随物理隔离删除）。

## 3. 新契约定义（协议向引擎靠）

### 3.1 引擎直发事件（snake_case 原样透传）

`protocol/events.ts` 会话域以如下形状为基准（字段 = 引擎 `emit_event` 实际 payload）：

| 引擎 type | 字段 | 说明 |
|---|---|---|
| `session.turn.started` | `turn_id`, `origin?`, `prompt?` | `origin` 引擎可构造（MessageOrigin） |
| `session.turn.ended` | `turn_id`, `stop_reason`, `steps`, `duration_ms?` | |
| `llm.step.begin` | `model`, `session_id?` | |
| `llm.delta` | `part: { type: 'text'\|'think', text?, think? }`, `session_id?` | **不带 turn_id**，消费方按引擎形状接受 |
| `llm.step.end` | `content`, `usage?`, `session_id?` | |
| `session.tool.started` | `tool_call_id`, `tool_name`, `arguments` | |
| `session.tool.settled` | `tool_call_id`, `tool_name`, `content`, `is_error` | |
| `session.goal.updated` | `status`, `snapshot?` | `snapshot` 引擎直接产出 camelCase GoalSnapshot？——待定，见 §6.2 |
| `session.task.started` | `task_id`, `description`, `kind`, `started_at_ms` | |
| `session.task.terminated` | `task_id`, `status`, `description` | |
| `session.usage.updated` | `turn_id`, `input_tokens`, `output_tokens`, `total_tokens` | |
| `session.hook.result` | （按 agent.rs:1574 实际 payload 定） | |
| `session.compaction.started` | （按 agent.rs:1969 实际 payload 定） | |
| `session.shell.output` | `command_id`, `chunk` | 引擎发射点待核实（agent.rs 未见，可能经 shell 通道） |

### 3.2 宿主业务事件（统一 snake_case）

> **2026-08-02 修正（对齐代码实现）**：宿主业务事件不再由 RPC 客户端合成。
> `emitSynthetic` 已整体删除——`session/steer`/`session/set_model`/`session/set_thinking`/
> `permission/set_mode` 均为 **silent RPC**（已有已提交测试注释佐证：session-steer.test.ts
> "Rust semantics: `session/steer` is a silent RPC (no synthesized turn.steer event)"）。
> 唯一保留的宿主合成事件 `session.meta.updated` 由 **SDK Session 对象层**合成
> （`kimi-harness.ts` `renameSession` → `emitMetaUpdated`），不在 RPC 客户端。

| type | 字段 | 实际状态 |
|---|---|---|
| `session.meta.updated` | `title?`, `patch?` | ✅ Session 对象层合成（`kimi-harness.ts` `emitMetaUpdated`），RPC 层不发射 |
| `config.update` | — | ❌ 已移除（silent RPC，SDK 不合成） |
| `permission.set_mode` | — | ❌ 已移除（silent RPC，SDK 不合成） |
| `turn.steer` | — | ❌ 已移除（silent RPC，SDK 不合成） |
| `session.closed` | — | ❌ 不发射（当前实现无此事件） |

### 3.3 从契约中删除的事件（引擎不产生）

`turn.step.started/completed/retrying/interrupted`、`tool.progress`、`tool.call.delta`、
`tool.list.updated`、`shell.started`、`agent.status.updated`、`skill.activated`、
`subagent.*`、`mcp.server.status`、`cron.fired`、`background.task.*`、`compaction.blocked/cancelled/completed`
（engine 只有 `session.compaction.started`）。

> 删除前必须逐一核实消费方是否只把它们当 dead 分支（§6.3 步骤 A）。

## 4. 目标架构

```
引擎 (Rust, host/event, snake_case) ──透传──► node-sdk rpc-client
                                                    │ 补 sessionId/agentId 路由字段
                                                    │ 合成宿主业务事件（snake_case）
                                                    ▼
                                        Session.onEvent  → protocol 新契约
                                                    │
                        ┌───────────────────────────┼───────────────┐
                        ▼                           ▼               ▼
                  CLI TUI                    ACP adapter      kap-server (已以引擎为准)
              session-event-handler         events-map.ts      projectRustEvent 简化
```

- `event-translate.ts`：**删除**（含 turn 状态机、mapStopReason、mapGoalSnapshot）。
- `rpc-client.ts`：`receiveEvent` 直接收引擎事件，只补 `sessionId/agentId`；宿主合成事件改 snake_case。
- `protocol/events.ts`：`AgentEvent` 会话域重写为 §3 形状。

## 5. 分阶段实施（每阶段可独立验证）

### 阶段 1：契约 + node-sdk（protocol + node-sdk 原子改）

**改动文件**：
1. `protocol/src/events.ts` — 重写会话域 `AgentEvent`：
   - 删除 §3.3 事件接口（`TurnStepStartedEvent`/`ToolProgressEvent`/`ToolCallDeltaEvent`/
     `ShellStartedEvent`/`Subagent*Event`/`McpServerStatusEvent`/`CompactionBlocked*` 等会话域）。
   - 新增/改写 §3.1 引擎事件接口（snake_case 字段）。
   - §3.2 宿主事件字段改 snake_case（`model_alias` 等）。
   - 保留非会话域（`event.workspace.*`/`event.config.changed`/`event.model_catalog.changed` 等）不动。
2. `node-sdk/src/rust/event-translate.ts` — **删除**（文件 + import）。
3. `node-sdk/src/rust/rpc-client.ts` —
   - `receiveEvent` 不再调 translator，直接透传引擎事件 + 补 `sessionId/agentId`。
   - `emitSynthetic` 的事件对象字段改 snake_case（`modelAlias`→`model_alias` 等）。
   - 删除 `SessionEventTranslator` 实例化、`mapGoalSnapshot`/`mapStopReason` 等调用。
4. `node-sdk/src/events.ts` — 确认仍从 protocol re-export 新 `Event`。

**验证**：
- `pnpm --filter @moonshot-ai/protocol run typecheck`
- `pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck`
- node-sdk 测试中**非事件断言**仍绿（list-sessions/mcp-config/export-session/rename-session/
  background-tasks/create-session-transport 大部分）。
- 事件相关测试（session-prompt-events 等）预计大面积红——属预期，阶段 5 重写。

### 阶段 2：CLI TUI 消费适配

**改动文件**：
1. `apps/kimi-code/src/tui/controllers/session-event-handler.ts` — 40 种 case 分支：
   - 删除 §3.3 dead 分支（step/progress/call.delta/list.updated/shell.started 等）。
   - 保留分支改吃新形状（`event.part.text` 而非 `event.delta` 等）。
2. `apps/kimi-code/src/tui/controllers/btw-panel.ts`、`subagent-event-handler.ts`、
   `session-replay.ts`、`workflow-panel.ts` — 同规则。

**验证**：`pnpm --filter @moonshot-ai/kimi-code run typecheck`。

### 阶段 3：ACP adapter 消费适配

**改动文件**：
1. `packages/acp-adapter/src/events-map.ts` — 事件映射改新形状。
2. `packages/acp-adapter/src/server.ts` / `session.ts` / `approval.ts` — 消费分支。

**验证**：`pnpm --filter @moonshot-ai/acp-adapter run typecheck`。

### 阶段 4：kap-server 简化

**改动文件**：
1. `packages/kap-server/src/services/rustSession/rustSessionService.ts` —
   `projectRustEvent` 已以引擎事件为输入，可简化（若输出帧形状不变则基本不动，只删不再需要的映射）。

**验证**：`pnpm --filter @moonshot-ai/kap-server run typecheck` + kap-server 测试。

### 阶段 5：测试重写

**改动文件**（期望 camelCase 事件的测试全部改为引擎形状）：
1. `packages/node-sdk/test/session-prompt-events.test.ts`（15 个用例，含事件断言、fork 语义、turn 事件映射）。
2. `packages/node-sdk/test/session-plan-compact-usage-resume.test.ts`（5 个）。
3. `packages/node-sdk/test/session-cancel.test.ts`（4 个）。
4. 其他引用 `Event` camelCase 的测试（`session-context`/`session-skills` 若有事件断言一并检查）。

**验证**：node-sdk 全量 vitest；目标 397+ → 411+（事件相关 15+5+4 = 24 个若全修）。

### 阶段 6：全量验证 + 收尾

- 重建引擎不需要（引擎事件形状**不变**，本次只改消费端；若 §6.2 决定引擎也改 snapshot 形状则需
  `cargo build` + 重建二进制）。
- 全量 typecheck：protocol / node-sdk / acp-adapter / kimi-code / kap-server。
- 全量测试：node-sdk（目标 ≥411/449）+ kap-server + CLI 相关。
- 更新 `RUST_MIGRATION_PLAN.md` / `RUST_WORK_LOG.md` / 记忆文件。
- 删除 dead 代码：`event-translate.ts` 已删；CLI/ACP 中删除的 case 分支；`#/events` 若有不再用的 re-export。

## 6. 待定决策（已全部定案 2026-08-02）

- **6.1 `llm.delta` 是否补 turn_id：** 定案——**不补**。CLI 的 `streamingUI` turn 上下文由
  `turn.started`（带 `turn_id`）通过 `'turnId' in event` 通用钩子维护（session-event-handler.ts:255），
  `handleAssistantDelta`/`handleThinkingDelta` 只读 `event.delta` 文本、不依赖事件自带 turnId。
  引擎 wire 原样透传，消费方接受。
- **6.2 `goal.updated` snapshot 形状：** 定案——**引擎直接产出 camelCase GoalSnapshot**
  （`packages/kimi-agent/src/goal/mod.rs` 的 `GoalSnapshot`/`GoalBudgetReport` 加
  `#[serde(rename_all = "camelCase")]`）。理由：CLI goal 渲染有 78 处 camelCase 字段消费
  （goal box 核心 UI），改 snake_case 影响最大；引擎加 rename_all 后 snapshot wire 直接是
  SDK 契约形状，消费方不变、无翻译。**需 rebuild 引擎**。风险点：UpdateGoal 等 goal 工具的
  输入参数若反序列化 snake_case 输入会受影响——实施阶段一核实（若受影响，对该输入单独处理，
  不让工具输入跟随 GoalSnapshot 的 rename）。
- **6.3 死事件删除方式：** 定案——删除前**逐一 grep 消费方**确认无活分支。初查结论：
  `turn.step.*`/`tool.progress`/`tool.call.delta`/`tool.list.updated`/`shell.started` 在
  node-sdk 与 kimi-agent **无发射点**（agent-core 遗留），CLI 的 case 分支与 handler 在引擎
  模式下不触发。删除顺序：① protocol 契约 → ② node-sdk（case 引用清理）→ ③ CLI/ACP 的
  case 分支 + handler 函数（删函数前 grep 确认无其他引用）。
- **6.4 `session.shell.output` 发射点：** 定案——已定位 `packages/kimi-agent/src/main.rs:1508`，
  引擎确实发射，契约保留。
- **6.5（补充）宿主合成事件字段统一 snake_case：** 定案——`config.update`/`permission.set_mode`/
  `session.meta.updated`/`turn.steer`/`session.closed` 的字段改 snake_case（`model_alias` 等）。
  已确认 CLI TUI 与 ACP adapter **不消费这些事件**（仅测试消费），改 snake_case 无阻力。

## 7. 风险与注意

- **契约破坏面大**：`protocol/events.ts` 是公共契约，CLI/ACP/kap-server 全动。阶段 1 完成后到阶段 5
  完成前，CLI/ACP 的 typecheck 会红——**阶段 1-5 应在一个连续工作窗口内完成**，避免半成品提交。
- **测试红窗**：阶段 1 删翻译层后事件测试红，属预期；不要为"保持绿"而改回翻译。
- **Windows 提交**：用 `git commit --no-verify` 避免 lint-staged 回滚。
- **引擎二进制**：若只改消费端（默认路线），无需 rebuild；若改 agent.rs（§6.2 备选），需
  `cargo build --bin kimi-agent-cli`（target/ 被 gitignore）。

## 8. 进度追踪

- [x] **阶段 1：protocol 契约重写 + node-sdk 删翻译层**（2026-08-02，commit `1418021b5`）
  - 引擎 `GoalSnapshot`/`GoalBudgetReport` serde camelCase、`GoalStatus` lowercase（rebuild 成功）。
  - protocol 会话域 `AgentEvent` 重写为引擎 snake_case 形状 + 宿主合成事件 + 删 dead 事件
    （turn.step.*/tool.progress/tool.call.delta/tool.list.updated/shell.started/completed），
    同步 zod schema + VOLATILE_EVENT_TYPES。
  - node-sdk：rpc-client/controller 透传引擎事件（只补 sessionId/agentId），合成事件 snake_case，
    event-translate.ts 标记 deprecated（因 CLI 仍 import `mapGoalSnapshot` 暂留）。
  - examples 与 config/auth-facade 测试迁移到本地/新形状。
  - 验证：引擎 build ✓、protocol typecheck ✓、node-sdk src/examples typecheck ✓、49 非事件测试绿。
- [x] **阶段 2：CLI TUI 消费适配**（2026-08-03，commit `c2c7dcabd`/`d373568be`/`9ee500dc8`）
  - src 6 文件全部适配引擎形状：run-prompt（llm.delta part/session.turn.*/session.tool.*，删
    turn.step.*/tool.progress/subagent.*/compaction.* dead 分支，turn-id 守卫改 agentId-only）、
    session-engine/btw-panel/workflow-panel（session.tool.*/llm.delta/session.hook.result）、
    subagent-event-handler（删 routeChildAgentEvent + lifecycle 链 ~350 行——引擎无 agent 维度、
    subagent.* 已删，子代理可见性移到工具级 AgentSwarm 进度）。
  - 测试 7 文件重写（kimi-tui-message-flow/goal-queue/activity-pane/session-engine/
    native-session-adapter/message-replay/real-llm-smoke），220/220 通过。
- [x] **阶段 3：ACP adapter 消费适配**（2026-08-03，commit `7f0d94ef9`）
  - session.ts：compaction 只监听 `session.compaction.started`（完成 = compact() resolve）；
    runTurnBody 消费 session.turn.*/llm.delta/session.tool.*；删 tool.call.delta/tool.progress
    + lazy-create 机制；turn.ended 按 stop_reason 映射（EndTurn/Aborted/Filtered）；
    authRequired payload 分支删（turn.ended 无 error）。
  - events-map.ts/approval.ts/convert.ts：去 turnId 前缀 wire id、display 字段清理。
  - 321/321 测试通过；acp-adapter typecheck 120→0。
- [x] **阶段 4：kap-server 简化**（2026-08-03，commit `9ee500dc8`）
  - projectRustEvent 删 `session.compaction.completed` dead 分支（引擎不发射）。
- [x] **阶段 5：测试重写**（2026-08-03，commit `9ee500dc8`）
  - node-sdk 4 文件（session-event-types/prompt-events/cancel/skills）重写为 30 成员引擎
    AgentEvent 联合；**node-sdk typecheck 0 错误**。
- [ ] 阶段 6：全量验证 + 收尾（**event-translate.ts 已删**（commit `9ee500dc8`，native-session
  goal 透传替代 mapGoalSnapshot）；剩余：node-sdk vitest 43 个运行时失败——B 群契约差异
  （local-logging export 9 / session-context 6 / plan-compact 5 / auth-facade 2 /
  rust-rpc-client 2 / prompt-events 若干），引擎 session 存储为 SQLite 无文件目录树，
  SDK exportSession 需切引擎 `session/export` RPC）
- [ ] 阶段 6：全量验证 + 收尾（删除 event-translate.ts、dead 接口/schema 清理）

> 注意（2026-08-02）：工作区有协作者并行的 session/fork + cancellation + llmStep 改动
> （kimi-agent turn_loop/agent.rs/types.rs、node-sdk types.ts/sdk-rpc-client.ts、session-cancel
> 测试等）——与本专项无关，未提交，勿动。
