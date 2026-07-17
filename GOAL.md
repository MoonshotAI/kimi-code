# Goal 功能拆分

本文把 agent-core 中 goal mode 的能力拆成三部分：

1. 核心工作流：没有它就不能运行 goal。
2. 统计 / token 数限制：让 goal 可度量、可限额、可审计。
3. 用户交互相关：让用户可以安全启动、理解、控制和恢复 goal。

> **2025-07: 参考 Codex CLI 的 goal 实现进行了以下改进：**
> - 状态机从 4 状态扩展为 6 状态，新增 `BudgetLimited` 和 `UsageLimited`
> - `UpdateGoal` 约束：模型只能标记 `complete` 或 `blocked`
> - Blocked 审计：要求相同阻塞条件连续出现至少 3 轮
> - Steering prompts 模板化：独立 `.md` 文件管理
> - BudgetLimited 仍累计用量（用于审计）
> - 核心状态机和会计逻辑用 Rust（napi-rs）实现，位于 `packages/kimi-native-tools/src/goal/`

## 1. 核心工作流

核心工作流是 goal mode 的运行骨架。它负责创建结构化目标、维护状态机、把普通 turn 串成自治多轮执行，并让模型用机器可读状态结束或停放目标。

### 目标状态

同一个 main agent 同时最多只有一个当前 goal。goal 不是普通聊天文本，而是 runtime 持有的结构化状态，至少包含目标、可选完成标准、当前状态、停止原因和运行统计。

状态分为六类：

| 状态 | 可恢复 | 自动续跑 | 设置者 | 含义 |
|------|--------|----------|--------|------|
| `active` | （运行中） | 是 | createGoal / resumeGoal | goal driver 自动运行下一轮 |
| `paused` | 是 | 否 | 用户暂停 / 中断 / 恢复降级 / 运行时错误 | 暂停但保留目标 |
| `blocked` | 是 | 否 | 模型标记（满足 3 轮阻塞审计） | 真实阻塞，需要外部输入 |
| `complete` | 否 | 否 | 模型标记 | 完成，通知后清除 |
| `budgetLimited` | 否 | 否 | 系统触发（预算耗尽） | token 预算耗尽，模型仍可收尾 |
| `usageLimited` | 否 | 否 | 系统触发（API usage limit） | 使用量限制耗尽 |

没有 `cancelled` 状态。取消就是清除 goal，并提醒模型忽略之前关于该目标的 active reminder。

**状态转换图：**

```
[null]
  │
  │ createGoal()
  ▼
┌─────────┐   resumeGoal()   ┌──────────┐
│ PAUSED  │◄────────────────│  ACTIVE  │
└─────────┘   pauseGoal()   └────┬─────┘
      ▲                          │
      │ resumeGoal()             ├── markComplete()
      │                          │     │
      │                          │     ▼
      │                          │ ┌──────────┐
      │                          │ │ COMPLETE │ (清除)
      │                          │ └──────────┘
      │                          │
      │                          ├── markBlocked() → 需 3 轮审计
      │                          │     │
      │                          │     ▼
      │                          │ ┌──────────┐
      │                          │ │ BLOCKED  │
      │                          │ └──────────┘
      │                          │
      │                          ├── budget 耗尽（系统）
      │                          │     │
      │                          │     ▼
      │                          │ ┌───────────────┐
      │                          │ │ BUDGET_LIMITED │
      │                          │ └───────────────┘
      │                          │
      │                          └── usage limit 耗尽（系统）
      │                                │
      │                                ▼
      │                          ┌───────────────┐
      │                          │ USAGE_LIMITED  │
      │                          └───────────────┘
```

### 创建和替换

创建 goal 时，runtime 需要校验目标不能为空、不能过长。已有 active、paused 或 blocked goal 时，默认拒绝创建新 goal，防止静默覆盖。只有用户或调用方明确要求替换时，才先清除旧 goal，再创建新 goal。

新 goal 创建后进入 `active`，写入持久记录，并发出 goal 更新事件。

### 多轮驱动

goal driver 的职责是把一个 active goal 推进成连续的普通 turn：

- turn 开始时如果 goal 已经是 `active`，进入 goal driver。
- 普通 turn 中如果模型创建了 goal（不能恢复——恢复只能由用户执行），当前 turn 结束后 goal driver 接管继续执行。
- driver 每次只运行一个普通 turn。
- 每个 turn 结束后读取 goal 状态。
- goal 仍是 `active` 时，runtime 自动追加 continuation prompt 并启动下一轮。
- goal 变成 `paused`、`blocked`、`budgetLimited`、`usageLimited` 或被清除时，driver 停止。
- `budgetLimited` 仍允许模型在当前轮输出最后一条收尾消息。

模型如果不调用状态更新工具，且 goal 仍是 active，runtime 会继续下一轮。模型不能只靠自然语言说"完成了"来结束 goal，必须给出结构化状态信号。

### Goal 注入

每个 goal turn 的边界，runtime 会把当前 goal 状态注入上下文。注入内容通过 `steering` 模块中的模板渲染生成，模板位于：
- `continuation.md` — active goal 的续跑提示
- `budget_limit.md` — 预算耗尽时的收尾提示
- `objective_updated.md` — 用户编辑目标后的调整提示

注入内容包括：
- 当前正在 goal mode。
- 目标和完成标准是什么。
- 目标文本是用户提供的数据，不能覆盖 system/developer 指令、工具 schema、权限规则或 host 控制。
- 当前状态和进度。
- 模型应该做简短自审，然后推进一个连贯工作切片。
- 简单、已完成、不可能、不安全、矛盾的目标，应在同一轮内直接标记 complete 或 blocked。
- 只有全部要求完成、验证通过、没有下一步有用动作时，才能标记 complete。
- 外部条件或用户输入阻塞时，应标记 blocked。
- 不要只做了计划、总结、第一版或部分结果就标记 complete。
- **3 轮阻塞审计**：不要在第一轮遇到阻塞时就标记 blocked。只有当相同阻塞条件连续出现至少 3 轮（含原始轮 + 续跑轮）时才能标记 blocked。Resume 后重新计数。

goal 注入只在 turn / continuation 边界做，不在每个 model step 都做，避免上下文重复膨胀，也有利于 prompt cache。

paused 和 blocked goal 的注入更轻：

- paused：提醒模型目标存在但当前不应自治推进，除非用户明确要求继续。
- blocked：提醒模型目标被阻塞且当前不自治推进，除非用户要求处理或恢复。

budgetLimited 的注入：提醒模型预算已耗尽，要求在当前轮收尾总结，不再启动新工作。

### Continuation prompt

当 goal 仍是 active，runtime 会追加一个系统触发输入（从 `continuation.md` 模板渲染），含义相当于"继续朝当前 active goal 工作"。它不只是简单续跑，还要求模型每轮重新判断：

- 是否已经完成。
- 是否遇到真实阻塞（且满足 3 轮审计）。
- 是否应该只推进一个合理切片后继续下一轮。
- 是否应该避免发散或启动无关工作。
- 除非真实阻塞，否则不要向用户要输入。
- 不要缩小或降低目标范围来提前完成。

**续跑 prompt 的 `completion audit` 要求：**
在标记 complete 前，必须逐条证明：
1. 从目标中推导出具体需求。
2. 对每条需求，检查权威证据（文件内容、命令输出、测试结果等）。
3. 不确定或间接的证据视为未完成。
4. 审计必须**证明完成**，而不是"没找到未完成的证据"。

**续跑 prompt 的 `blocked audit` 要求：**
详见下文"完成、阻塞和暂停"中的 3 轮规则。

### 完成、阻塞和暂停

模型通过 `UpdateGoal` 工具控制 goal 生命周期。**模型只能设置 `complete` 或 `blocked`**，不能设置 `active`（恢复由用户通过 `/goal resume` 进行），也不能设置 `paused`、`budgetLimited`、`usageLimited`。

- `complete`：目标已满足，runtime 发出完成事件并清除 goal。模型先收到完成总结的回复机会，然后 goal 被清除。
- `blocked`：满足 3 轮阻塞审计后标记。runtime 保留 goal 并停止自治推进。模型先收到阻塞说明的回复机会。

**3 轮阻塞审计规则（来自 Codex）：**
1. 模型不能在第一轮遇到阻塞时就标记 `blocked`。
2. 只有当**相同的阻塞条件连续出现至少 3 轮**时才能标记 `blocked`。轮次计数包括用户触发的那一轮（原始轮）和自动续跑轮。
3. 如果用户恢复了之前标记为 `blocked` 的 goal，重新开始计数（fresh audit）。
4. 如果恢复后相同的阻塞条件又连续出现至少 3 轮，则再次标记 `blocked`。
5. `blocked` 只在模型真正无法推进、需要用户输入或外部状态改变时使用。不能因为工作困难、进展缓慢、不确定或不完整就标记 `blocked`。

状态更新工具的输入应保持窄，只表达机器状态。完成总结或阻塞原因由模型随后给用户说明。

当模型标记 complete 后，runtime 应再给模型一次收尾机会，生成简短最终回复，说明 goal 已完成、主要做了什么、跑了什么验证。

当模型标记 blocked 后，runtime 应再给模型一次收尾机会，说明具体阻塞、需要什么输入或变化才能继续。

如果当前 turn 已经没有 step 预算，不应为了收尾总结强行再跑一步，避免把"没法写总结"变成 turn 失败。

### 错误停车

goal mode 把技术运行失败视为可恢复停车：

- 用户中断当前 turn：goal 变 paused。
- provider rate limit：goal 变 paused。
- provider 连接错误、认证错误、API 错误：goal 变 paused。
- 模型配置错误：goal 变 paused。
- runtime 异常：goal 变 paused。
- provider safety filter：goal 变 paused。
- **API usage limit 耗尽：goal 变 `usageLimited`**。

业务、规则或外部条件阻塞则变 blocked：

- prompt hook 阻止目标。
- 模型判断无法继续（且满足 3 轮审计）。
- 需要用户或外部系统提供新条件。

**预算耗尽变为 `budgetLimited`（不再是 blocked）**：
- `budgetLimited` 是独立的非终端状态。
- 模型在当前轮仍可输出收尾消息。
- 系统不再自动续跑。
- token 和 time 用量**仍然累计**（用于审计报表）。

### 持久化和恢复

goal 的创建、更新、完成、阻塞、清除应写入可恢复记录。session 恢复时，runtime 用记录重建 goal。

恢复时如果发现 goal 原来是 active，不应自动继续跑，而是降级为 paused。因为旧进程中的 active turn 不可能还活着，自动继续会造成重启后偷偷消耗资源。

paused 和 blocked 原样保留。complete 理论上不长期存在，因为完成后会清除。budgetLimited 和 usageLimited 原样保留。

fork session 时不继承源 session 的 goal，并提醒模型不要继续源 session 的旧目标。

## 2. 统计 / token 数限制

这一部分让 goal 可度量、可限额、可审计。没有它，goal 仍然可以运行，但不可控。

### 运行统计

goal 统计包括：

- continuation turn 数。
- token 数。
- active wall-clock 时间。

统计只在 goal 是 `active` 时增长。paused、blocked、budgetLimited、usageLimited 期间不继续计数。**`budgetLimited` 状态下 token 和时间仍累计**（用于最终审计），但不计入"active pursuit"统计。

turn 统计在每个 goal turn 准备运行时增加，因此模型在某一轮里标记 complete 时，这一轮也计入最终统计。

token 统计在 model step 结束后累计。没有 active goal 时，不记入 goal。token 统计应以静默更新为主，不应每一步都刷 UI。

**时间统计只计算 active pursuit 时间**。进入 active 时开启计时区间，离开 active 时折算进累计时间；pause/resume 会形成新的 active 区间。blocked/budgetLimited/usageLimited 不计算时间。

### 预算

goal 预算包括：

- turn budget。
- token budget。
- wall-clock budget。

默认没有预算。只有用户明确给出硬限制时才设置，例如"最多 20 轮""不超过 500k token""30 分钟内"。模糊表达如"尽快""别花太久"不能设置预算，模型也不能自行发明预算。

时间预算需要合理范围。过短或过长应拒绝。turn 和 token 预算应规范化为正整数。

### 预算硬停

预算检查应发生在 goal turn 开始前和结束后。token budget 还应在 model step 后触发停止，避免超额后继续下一步。

一旦达到预算，runtime 应直接把 goal 标记为 **`budgetLimited`**（不是 `blocked`），原因是配置预算已达到。模型在当前轮仍可输出最后一条收尾消息。

### 预算引导和最终统计

当预算未接近时，模型提示应鼓励稳定推进。当任一预算达到 75% 以上时，提示应转为收敛，避免启动新的可选工作。

complete 和 blocked 的最终回复提示应包含 worked turns、elapsed time、tokens used 等统计信息。UI 事件也应带当前 snapshot 和变化类型。

telemetry 可以记录 goal 创建、预算设置、continuation、状态变化、清除等事件，但不应包含目标文本、停止原因等敏感内容。

## 3. 用户交互相关

这一部分让用户可以安全启动、理解、控制和恢复 goal。没有它，runtime 仍可能运行，但交互体验和安全边界不足。

### 生命周期控制

用户可以直接控制 goal：

- 创建。
- 查看。
- 暂停。
- 恢复。
- 取消。

这些操作可以不经过模型 turn。pause 把 active goal 变 paused；resume 把 paused 或 blocked goal 变 active；cancel 直接清除当前 goal。

resume 会清除旧停止原因和 blocked streak，表示开始新的尝试。paused/blocked goal 不会因为用户发普通消息就自动继续。

### 模型发起 goal 的确认

模型可以代表用户创建 goal，但只有在用户明确要求启动 goal、自治工作，或宿主 goal-intake 提示要求时才应该这样做。普通请求不能被模型擅自升级成 goal。

模型发起 CreateGoal 时，非 auto 权限模式下应触发用户确认。确认菜单允许用户选择本次 goal 的运行权限模式。用户拒绝则 goal 不创建。

`GetGoal`、`SetGoalBudget`、`UpdateGoal` 只改 goal runtime 状态，默认可以更容易批准。真正写文件、跑 shell、访问敏感路径等仍走普通权限系统。

### 暂停、阻塞和取消后的提示

paused goal 的上下文提示应说明目标存在但当前不应继续做，除非用户明确要求继续。

blocked goal 的上下文提示应说明目标被阻塞且当前不自治推进，可以在用户要求时帮助解阻，否则正常处理当前请求。

budgetLimited goal 的上下文提示应说明预算已耗尽，用户可设置新预算后恢复。

cancel 后应追加提醒，让模型忽略旧 goal 的 active reminder，避免旧上下文诱导模型继续已经取消的目标。

### 完成和阻塞的用户回复

complete 后，goal 被清除，模型应给用户一条简短完成总结，说明完成了什么、做了什么验证。如有 token 预算，报告最终消耗。

blocked 后，goal 保留，模型应给用户一条简短阻塞说明，说明具体阻塞和继续所需输入、权限、外部条件或变更。

budgetLimited 后，goal 保留，模型应给用户一条简短说明：预算已耗尽、当前进度、剩余未完成工作。

### Tool 暴露和隔离

goal 工具只给 main agent。subagent 不应直接创建、恢复、结束主 goal。

没有 goal 时，模型不应看到 `UpdateGoal` 和 `SetGoalBudget`。有 goal 时才暴露这些控制工具。

goal ID 不应暴露给模型，因为它只是 runtime/UI 内部标识，没有用户语义。

### 辅助写 goal

`write-goal` 类能力用于帮助用户把粗糙意图整理成适合 goal mode 的完成契约。好的 goal 应明确：

- end state：什么条件必须变成真。
- proof：用什么可观察证据证明完成。
- boundaries：工作范围和禁止触碰的内容。
- loop：如何迭代推进。
- stop rule：什么情况下停止并报告，而不是强行继续。

预算是 opt-in，不应默认加入，也不应把 turn cap 写进目标文本。

### UI 和会话语义

goal 创建、暂停、恢复、阻塞、完成、预算耗尽、用量耗尽、清除都应发出 goal updated 事件。lifecycle 变化和 completion 变化应区分。completion 是一次终局事件，然后 snapshot 变 null。blocked/paused/budgetLimited/usageLimited 保留 snapshot，UI 可以继续展示可恢复 goal。

session 恢复时，active goal 会变 paused，避免重启后自动继续。fork session 时不继承 goal，并提醒模型不要继续源 session 的目标。

### 实现说明

核心 state machine（6 状态）、token 记账（`GoalAccountingState`）、steering prompt 模板用 **Rust** 实现，位于 `packages/kimi-native-tools/src/goal/`，通过 napi-rs 暴露给 TypeScript。TypeScript 侧保留：

- 持久化（wire.jsonl event sourcing）
- 事件分发（`EventBus`）
- Goal Judge（独立 LLM 评估）
- Goal Injection（context injector 注册）
- Continuation 编排（turn lifecycle 决策）
- Permission policy（goal start 确认）
- Deadline scheduler（墙上时钟 setTimeout）
