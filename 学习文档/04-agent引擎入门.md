# 04 · Agent 引擎入门（深度版）

> 时效基线：基于 commit `d4e0ad4b2`（2026-08）。行号会漂移，以路径为准。
> 引擎 = `packages/agent-core-v2`（v2，默认）。本文前半给"熟 TS、不熟 agent"的读者补概念，后半带真实代码走完**一次 prompt 的完整生命周期**——这是全仓最核心的一条链路，每个环节都有 file:line，可直接下断点（方法见 `03` 第 3 节）。

## 一、概念速成（对着本仓代码讲）

### 1. coding agent = LLM + 工具循环

```
用户输入 ──► turn（一轮）─────────────────────────────┐
  step 1: 组装上下文 → 请求 LLM → 返回文本和/或工具调用   │
          执行工具批 → 结果写回上下文                    │ loopContinuation
  step 2: 带着工具结果再请求 LLM → ……                   │ (finishReason='tool_calls' 就续)
  ……直到 LLM 不再调工具 / 达到 max steps / 用户取消      │
  ◄── turn.ended(completed|cancelled|failed|blocked) ◄─┘
```

- **turn**：一次用户输入到回答完成；**step**：turn 内一次 LLM 请求 + 工具批执行。模型连续调工具时一个 turn 有很多 step。
- 本仓落点：`packages/agent-core-v2/src/agent/loop/loopService.ts`（状态机）、`stepRequest.ts`（请求抽象）、`loopContinuationService.ts`（收敛）。
- 你在插件里看到的"正在执行 Edit…"就是这条链的事件被层层转发到 UI（`02` 第七节）。

### 2. 上下文窗口与 compaction

历史消息 + 工具结果会撑爆上下文窗口。引擎的解法分三层：**投影**（把内存历史裁成当次请求的消息列表）、**截断**（工具结果超长先截）、**压缩**（快满时用一次 LLM 调用把早期历史摘要化）。落点：`src/agent/contextProjector/`、`src/agent/toolResultTruncation/`、`src/agent/fullCompaction/`。

### 3. 工具

工具 = 暴露给模型的能力：名字 + JSON Schema 参数 + 描述文本（模型据此决定何时用）+ 执行函数。内置：`Read`/`Edit`/`Write`/`Bash`/`Glob`/`Grep`/`FetchURL`/`WebSearch`/`TodoList`/`Agent`(subagent)/`Skill`/`SelectTools`…。落点：`src/agent/tools/`（实现）+ `src/tool/`（契约）+ 周边域（registry/select/executor/approval/policy/dedupe）。

### 4. 权限与审批

危险工具执行前过"权限门"：按有序策略表判 allow/ask/deny；ask 时经 interaction 机制请宿主 UI 弹窗，用户选择后继续。模式三档：`manual`/`yolo`/`auto`（`src/agent/permissionPolicy/types.ts:6`）。

### 5. 会话持久化与 resume

引擎的一切状态变化 = **事件**。标了 `durable` 的事件追加进每个 agent 的 `wire.jsonl`；标了 `replayable` 的状态不直接落盘，**靠重放 durable 事件重建**（事件溯源）。resume = 读日志 → 静默重放 → 恢复状态。落点：`src/wire/`、`src/state/`。

### 6. 其他高频词

| 词 | 含义 | 落点 |
|---|---|---|
| system prompt / profile | agent 人设与系统提示词 | `src/agent/profile/`、`src/agent/prompt/` |
| skill | 打包的"某类任务怎么做"说明书 | `src/agent/skill/` + workspace catalog |
| MCP | 外接工具/数据源协议 | `src/mcpCore/`、workspace 域 `workspaceMcp` |
| subagent | 派生子 agent（并行子任务），独立 agent 作用域 | `src/session/subagent/` |
| steer | 生成途中补充指令，并入下一 step | `SteerStepRequest` |
| plan 模式 | 先出方案批准后动手 | feature `src/features/plan/` |

## 二、接缝层：prompt 怎么进入引擎

宿主调 `session.prompt()` 之后（v2 路径）：

1. klient facade（`packages/klient/src/core/facade/agent.ts:107`）：`prompt → call(scope, 'agentPromptService', 'submit', [input])`——RPC 语义调用引擎的**作用域内服务**（`steer → submitSteer`，`cancel → agentLoopService.cancelFromUser`）；
2. `PromptService.submit()`（`packages/agent-core-v2/src/agent/prompt/promptService.ts:243-269`）：预留 admission、应用 `disabledTools`、更新会话元数据、入队用户消息，返回 `{turn_id}`；
3. `startNext()`（`src/agent/prompt/promptService.ts:399-425`）：compaction 门控（`:404`）→ `onBeforeSubmitPrompt` 钩子可拦截（`:407-411`）→ **`this.loop.enqueue(new PromptStepRequest(...)).assigned`**（`:412`）——从此交给 loop。

v1 回退路径（`createKimiHarness`）与 node-sdk 的映射层（`src/v2/`）见 `00` 第二节；本文只走 v2。

## 三、引擎地图

```
packages/agent-core-v2/src/
├── _base/     DI 内核（scope 容器、级联、@ref、生命周期账本）——无业务
├── app/       App 层：配置、模型目录、flag、workspace 域、会话管理（启动链见 00 第一节）
├── session/   会话域：生命周期、interaction（审批的会话侧）、subagent、todo…
├── agent/     Agent 域（本文主战场）：
│   ├── loop/            turn/step 状态机
│   ├── llmRequester/    一次 LLM 请求的组装与流式回流
│   ├── tools/           内置工具实现
│   ├── toolRegistry/toolSelect/toolExecutor/toolApproval/toolPolicy/toolDedupe
│   ├── permissionGate/permissionMode/permissionPolicy/permissionRules
│   ├── contextMemory/contextProjector/fullCompaction/tokenCounting
│   ├── profile/prompt/stepRetry/state/task/…
├── features/  plan、goal、swarm、tower、externalHooks（自组装特性）
├── tool/      工具契约（toolContract、args-validator、result-builder、path-access）
├── kosong/    内嵌 LLM 抽象（contract/model/protocol/provider）
├── wire/      wire.jsonl 读写与迁移      └── state/  事件/状态内核（Event2、dispatcher）
```

Scope：`LifecycleScope` 枚举三层 App/Session/Agent（`src/app/scopes.ts:3`）；Workspace 是域层概念（App 级 `workspaceLifecycle` 注册表，见 `00` 第一节阶段 F）。DI 要点（读代码前最小知识）：服务是五状态 unit；`@ref(IX)` 活引用；扩展走贡献点（config section / agent tool / agent profile / 事件词汇 / 命令）。

## 四、一次 prompt 的完整生命周期（核心章节）

### 4.1 入队与 admission：请求不是"直接跑"，而是排队分类

loop 的输入是 `StepRequest`（`src/agent/loop/stepRequest.ts:26-71`），核心属性：

- **`admission`**（`src/agent/loop/stepRequest.ts:8`）四种：`newTurn`（必须新开 turn，prompt 用）/ `activeOrNewTurn` / `activeOrNextTurn` / `activeTurnOnly`（必须有活 turn，steer 用）——**这个设计统一了 prompt/steer/continuation/retry 四种驱动力**；
- `mergeable`（可否并入同批）、`turnSeed`、`onWillMaterialize()`、`resolveContextMessages()`。

`AgentLoopService.enqueue()`（`src/agent/loop/loopService.ts:163-178`）→ `admit()`（`:180-203`）按 admission 决定"并入活 turn 的队列"还是"排新 turn"→ `pumpTurns()`（`:452`）→ `startTurn()`（`:462-479`，先派发 durable `TurnPrompt` 再 observable `TurnStarted`）→ `runTurn()`（`:481-567`）。

**turn 是一个 job**（`TurnJob`，`src/agent/loop/loopService.ts:347-367`）：自带 AbortController、专属 `StepRequestQueue`、steps 表；turn id 从 replayable 状态 `turnKey` 的单调计数器取（`reserveTurnId`，`:369`；`src/agent/loop/turnOps.ts:112-138`——所以 turn 编号能跨 resume 连续）。

**step 是一批请求**：`takeNextBatch()`（`src/agent/loop/stepRequestQueue.ts:23-40`）取第一个不可合并请求当 driver、把后续可合并的并进去。收敛靠 `loopContinuationService`（`src/agent/loop/loopContinuationService.ts:18-22`）：每步结束后若 `finishReason === 'tool_calls'` 且未 stopTurn，就 `enqueue(new ContinuationStepRequest())`（`src/agent/loop/stepRequest.ts:97`，空上下文的"带着工具结果再跑一次模型"）；**队列空 = turn 完成**（`beginLoopStep`，`src/agent/loop/loopService.ts:676-684` 返回 `{type:'completed', steps, truncated}`）。

### 4.2 step 循环与三个安全点

主循环（`run()`，`src/agent/loop/loopService.ts:631-658`）：`while(true) { beginLoopStep → executeLoopStep → completeLoopStep }`。

- `executeLoopStep`（`:824-886`）：`beginStep`（`:888`，派发 `TurnStepStarted` + 记 `step.begin` loop 事件）→ `llmRequester.start(...)`（`:839`）→ `executeStepTools`（`:956-1002`）→ `finishStep`（`:1004`）。
- **max steps**：`beginLoopStep`（`:685-688`）`runtime.steps >= maxSteps` 时抛 `createMaxStepsExceededError`（`src/agent/loop/loop.ts:19-26`，错误信息直接指向 config.toml 的 `loop_control.max_steps_per_turn`；domain code `loop.max_steps_exceeded`，`src/agent/loop/errors.ts:10-17`）→ `failLoopStep`（`:799-805`）把 reason 记为 `'max_steps'`，派发 `TurnStepInterrupted`，turn 以 failed 收场。
- **取消安全点**：step 开始处 `turnSignal.throwIfAborted()`；step 级信号是 `AbortSignal.any(turn, step)`。中途取消时**已流出的部分内容不丢**（`appendInterruptedStreamContent`，`:936`）。`handleLoopCancellation`（`:740-758`）区分"只取消了在飞 step"（继续）与"取消整个 turn"。
- **steer 不打断**：`SteerStepRequest`（`src/agent/prompt/promptStepRequests.ts:65-91`）是 `mergeable` + `activeTurnOnly`，并入下一 step 批，只派发 `TurnSteer` 事件——**steer 永远发生在 step 边界**。
- **compaction 安全点**：`fullCompactionService` 钩在 `onWillBeginStep`（`src/agent/fullCompaction/fullCompactionService.ts:181-186`），`beforeStep`（`:493-499`）在**下一次 LLM 调用前**检查 `shouldBlock` 并可 `await block()` 让 turn 暂停等压缩完成——不会压缩到一半夹进消息。

`turn.ended`（宿主看到的终止事件）在 `runTurn` 的 finally（`:524-532`）：reason = result 类型（`completed|cancelled|failed|blocked`），附 error 与 `interruptReason`（`src/agent/loop/turnEvents.ts:11-17`：`user_cancelled|aborted|max_steps|error|filtered|blocked`）。插件侧的终止去重见 `02` 的 3.2 小节。

### 4.3 一次 LLM 请求是怎么组装的（llmRequester）

`runRequest()`（`src/agent/llmRequester/llmRequesterService.ts:303-452`）按序：

1. `toolCallIdNormalizer.seedFrom(context.get())`（`:309`）——工具调用 id 与历史保持一致；
2. `toolSelect.shapeHistory(messages)`（`:310`）——从历史里剥掉已卸载工具的声明（配合动态工具加载，见 4.5）；
3. 投影策略恢复（`:311-322`，媒体降级/剥离的 per-turn 状态）；
4. `mediaResolver.resolve(projector.project(shaped, policy), ...)`（`:333-337`）——**contextMemory 的历史 → projector 投影成合法消息序列 → 媒体解析**；
5. 派发 durable 的 `LlmToolsSnapshot`（按工具集哈希去重，`:670-674`）与 `LlmRequest`（`:339+`，记 provider/model/thinking/工具哈希/消息数/turn step/attempt）——**每次请求都可审计**；
6. 调 kosong 层（`:367`），流式 `part|usage|finish|timing` 事件逐个回调（`:371-389`）；
7. 收尾：`remapFinalizedCalls`（`:398`）、usage 记账（`:414`）、`tokenCounting.measured`（`:421`）。

输入来自 `resolveRequest()`（`:583-615`）：**turn 内配置冻结**（`getOrCreateTurnConfig`，`:622-636`——模型/参数/system prompt 在 turn 中途不可变）；completion 预算 = `maxOutputSize - reservedContextSize`（`:587-599`）；`tools = toolSelect.shapeTools(tools.list())`（`:734-743`）。

**流式回流**：loop 传入的 `createStreamPartHandler`（`src/agent/loop/loopService.ts:1115-1190`）把 part 映射成事件：text → `AssistantDelta`（`src/agent/loop/turnEvents.ts:137`）、think → `ThinkingDelta`（`:149`）、tool_call_part → `ToolCallDelta`（`:163`）——这就是插件 `event-adapter` 收到的那批事件的原生形态。

**两层重试**：① 请求内投影重试（`src/agent/llmRequester/llmRequesterService.ts:437-451`）：`APIRequestTooLargeError` → 媒体降级 → 再太大就剥离媒体（`nextProjectionPolicyForError`，`:454-506`）；② step 级重试（`src/agent/stepRetry/stepRetryService.ts`）：loop 错误处理器 `id:'step-retry'`，可重试错误按 `maxAttemptsPerStep` 退避重跑同一 step（`recover()`，`:110-151`；`Retry-After` 优先、否则退避表），期间派发 `turn.step.retrying`（插件的 `02` 的 3.2 小节 管线会记日志）。**投影重试救"请求太大"，step 重试救"瞬时故障"**，各管一层。

### 4.4 工具批执行（toolExecutor）

`execute()`（`src/agent/toolExecutor/toolExecutorService.ts:177-283`）三段：

1. **preflight**（`preflightToolCall`，`:728-788`）：逐调用解析 JSON 参数 → `toolRegistry.resolve` → 参数校验（编译缓存 validator，`:790-802`）；
2. **prepare**（`:336-443`）：逐调用 `resolveExecution`（工具自报 accesses/display/approvalRule）→ **`fireBeforeExecute`（`:414`）——权限决策点**，veto 则合成拒绝结果 → 派发 `ToolCallStarted`；`stopBatchAfterThis` 可截断后续；
3. **executeBatch**（`:456-501`）+ `ToolScheduler`（`src/agent/toolExecutor/toolScheduler.ts:21-88`）：**默认并行，仅当 accesses 冲突才串行**（冲突语义：写 vs 读写、路径重叠含递归目录，`src/tool/toolContract.ts:166-217`）——这就是"Edit 两个不同文件可以并行、同文件必须排队"的实现；结果谁先完成谁先 yield（`Promise.race`）。收尾 `finalizeToolResult`（`:624-679`）：跑 `onDidExecuteTool` 钩子、合并 `stopTurn`（工具可以请求终止 turn！）、超长结果截断（`toolResultTruncation`，50k 字符/2000 行上限在 `src/tool/result-builder.ts:24-149`）。

### 4.5 权限链：从"模型返回 tool call"到"执行或弹窗"（七步）

这是新手问得最多的一条链，逐步（全部已核实）：

1. executor `fireBeforeExecute`（`src/agent/toolExecutor/beforeToolExecuteEvent.ts:97-121`；事件带 `veto/allow/pass/waitUntil`）；
2. **permissionGate** 订阅了它（`src/agent/permissionGate/permissionGateService.ts:30`），`adjudicate`（`:40-65`）：`policy.evaluate` → ask 就 `event.waitUntil(() => toolApproval.requestToolApproval(...))`，approve 就 `pass`，deny 就 `veto`；
3. **permissionPolicy**（`src/agent/permissionPolicy/permissionPolicyService.ts:52-60`）是有序策略表，**首个有结论的生效**，顺序：AutoModeAskUserQuestionDeny → UserConfiguredDeny → AutoModeApprove → SessionApprovalHistory（本会话点过"始终允许"）→ UserConfiguredAsk → UserConfiguredAllow → SensitiveFileAccessAsk → GitControlPathAccessAsk → YoloModeApprove → DefaultToolApprove → GitCwdWriteApprove → **FallbackAsk**（兜底必问，`policies/fallback-ask.ts`）。`DefaultToolApprove`（`policies/default-tool-approve.ts`）自动放行只读类：Read/Grep/Glob/WebSearch/FetchURL/Todo/Agent/Skill 等；
4. **toolApproval**（`src/agent/toolApproval/toolApprovalService.ts:103-221`）构造审批请求（`approval_<uuid>`），派发 `permission.approval.requested`（`:138`）；没有宿主审批服务时自动放行（`:135-136`）；用户选"本次会话始终允许"（scope=session）→ 记一条会话级规则 + durable 事件（`:175-194`）——**"不再问"是事件溯源的，resume 后仍然生效**；
5. 会话侧 `approvalService`（`src/session/approval/approvalService.ts:19-26`）转给 `interaction.request(...)`；
6. **interactionService**（`src/session/interaction/interactionService.ts:96`）挂起 Promise 并派发 `interaction.request` 事件——**发在发起方 agent 的事件分发器上**（`originDispatcher`，`:177-189`），pending 表本身也是 replayable 状态（`:35`）；
7. 宿主（插件的 `reverse-rpc` / TUI / klient 客户端）观察事件 → 弹窗 → 调 `decide/respond` → 挂起的 Promise resolve → gate 放行或否决。

### 4.6 上下文管理：内存形态、投影、压缩

- **contextMemory**（`contextMemoryService.ts`）：历史存于 replayable 状态（key 定义 `src/agent/contextMemory/contextOps.ts:79-107`，带 blob 卸载与 undo）；`append`/`appendLoopEvent` 派发 durable 事件（`ContextAppendMessage`/`ContextAppendLoopEvent`）——**loop 的 step.begin/content.part/tool.call/tool.result 都是这么进历史的**。折叠器 `src/agent/contextMemory/loopEventFold.ts:84`：维护"打开中的 assistant 消息"、pending 工具调用集合，交错到达的用户消息先暂存（`deferred`）等工具结果齐了再落位；resume 时给没等到结果的工具调用合成错误消息（`TOOL_INTERRUPTED_ON_RESUME_OUTPUT`，`:336-341`）——**保证历史永远是合法的 tool_call/tool_result 配对**；
- **contextProjector**（`src/agent/contextProjector/contextProjectorService.ts:52-64` + `projection.ts`）：把内存历史投影成请求消息列表。`pairBlocks`（`src/agent/contextProjector/projection.ts:120-182`）按 id 配对 assistant 工具调用与结果，孤儿结果丢弃、乱序重排、缺失合成（各有遥测标记）；`flattenBlocks`（`:190-257`）合并连续 user 消息、合成被中断的工具结果；`projectStrict` 模式再做去重/清理。**投影修复是有日志和遥测的**（`reportProjectionRepairs`，`:111`）；
- **fullCompaction**（`fullCompactionService.ts`）：默认触发比 0.85、block 比 0.85、预留 50k tokens、摘要保留最近 4 条消息（`src/agent/fullCompaction/strategy.ts:18-28`）。压缩本体 = **一次独立的 LLM 调用**（`compactionRound`，`:618-794`，指令模板 `compaction-instruction.md`，source 为 `operation/full_compaction`——不占普通 turn），失败有收缩阶梯（0.7/0.5/0.35 重试，`:77`）；完成后 `context.applyCompaction`（`src/agent/contextMemory/contextMemoryService.ts:119-150`）替换历史并 rebase token 锚点。上下文溢出的恢复走 loop 错误处理器（`:463-472`：自动压缩 → block → 同一 step 重跑）；
- **tokenCounting**（`tokenCountingOps.ts`）：锚点式记账（`measured/truncated/rebased/turn_recorded` 四类 durable 事件），压缩后 rebase 而不是重算。

### 4.7 事件系统与 wire 持久化

- **事件声明习语 `Event2`**（`src/app/event/event2.ts:22-47`）：一个类 + payload 接口，静态属性声明三性——`durable`（追加进 wire.jsonl）、`observable`（上总线）、`agentDomain`（payload 带 agentId）。durable 必须带 zod schema（`:68-85`）。
- **事件词汇**（类型串即 API）：turn 域 `turn.prompt/steer/cancel/ended`（durable）+ `turn.started/step.started/step.completed/step.interrupted/step.retrying`（observable）；流式 `assistant.delta`、`assistant.thinking.delta`、`tool.call.delta`；工具 `tool.call.started/progress/result`；上下文 `context.append_*`（durable）/`context.spliced`；压缩 `full_compaction.begin/cancel/complete`（durable）+ `compaction.started/blocked/cancelled/completed`（observable）；LLM 审计 `llm.tools_snapshot/llm.request`（durable）；权限 `permission.approval.requested/resolved`；交互 `interaction.request`；prompt 生命周期 `prompt.completed/aborted/steered/queued`；subagent `subagent.spawned/started/completed/failed`（发在父的分发器上）。
- **总线拓扑**：物理上**每个 session 一条总线**（`src/app/event/eventBusService.ts:12-107`，Session scope）；agent 的"自己的总线"是**过滤视图**（`AgentEventBusView`，`:109-180`：agentDomain 事件只放行本 agentId 的，非 agent 事件只放行源于本 agent 的）——引擎服务订阅 agent 视图，天然看不见兄弟 agent 的流量。
- **wire.jsonl**（`src/wire/record.ts`）：首条必须是 `{type:'metadata', protocol_version, created_at}`（`:18-22`）；`wireService` 串行追加并把 ContentPart 卸载进 blob（`src/wire/wireService.ts:55-78`）；读日志时校验头部、跑版本迁移（`:80-134`）。
- **replayable 的准确含义**：状态不落盘，**由折叠 durable 事件重建**。resume 时 `EventDispatcherService.restore()`（`src/state/eventDispatcherService.ts:637-686`）读日志 → `type` 映射回 Event2 类 → `executeEvent(event, silent=true)`——**重放时不重写日志、不上总线**（`:479-487`），然后 `rehydrateStates()` 恢复 blob、`onDidRestore` 钩子收尾（compaction 的重放归一化挂在这，`src/agent/fullCompaction/fullCompactionService.ts:167-172`）。被重放的状态：`turnKey`（turn 计数）、`contextMemoryKey`（历史）、`fullCompactionKey`、权限规则、token 锚点、loop/llmRequester 的 per-turn 配置、interaction pending 等。

### 4.8 subagent

`SubagentService.spawn()`（`src/session/subagent/subagentService.ts:149-199`）：非 fork 走 `agentLifecycle.create({binding:{profile:'coder', model, thinking}, labels, runtimeId})`——**子 agent 是新的 agent 作用域**，非 fork 还要拿 `'process'` 运行时租约；fork 走 `agentLifecycle.fork`（继承快照历史，prompt 前插 `FORK_CONTEXT_NOTICE` 说明"这不是你自己的历史"，`src/session/subagent/spawn.ts:13-14`）；继承父的权限模式（`:176-178`）。子 agent 的 turn 经 `src/session/subagent/runAgentTurn.ts:31-55`（enqueue → await turn.result；结果太短会用 profile 的 continuationPrompt 补问一次）。**事件回流**：`mirrorAgentRun.ts` 在**父的分发器**上派发非 agentDomain 的 `subagent.spawned/started/completed/failed`——这就是插件 event-adapter 里 subagent 路由（`02` 的 3.3 小节）的事件源头。

## 五、精读路线（更新版）

1. `packages/agent-core-v2/AGENTS.md` 通读（接受 scope/unit/seed/contribution 词汇）；
2. 4.1–4.2 小节的 loop：`loopService.ts` 的 `run()`/`beginLoopStep`/`executeLoopStep` + `stepRequest.ts`（admission 模型）；
3. 4.3 小节 llmRequester：`runRequest()` + `resolveRequest()`；
4. 两个工具对照读：`tools/os/read/readTool.ts`（简单，含 .md 描述模板渲染、runtime 租约与 generation 复查）+ `tools/edit/editTool.ts`（写路径、display、approvalRule）；
5. 4.5 小节权限链：`permissionGateService` → `permissionPolicyService`（策略表）→ `toolApprovalService` → `session/interaction`；
6. 4.6 小节上下文：`contextOps.ts`（状态定义）→ `loopEventFold.ts`（折叠器，本引擎最精巧的代码之一）→ `projection.ts` → `fullCompactionService.compactionRound`；
7. 4.7 小节：`event2.ts`（习语）→ `eventDispatcherService.restore()`（重放）；
8. 一个 feature：`src/features/plan/`（贡献点组装范例）。

配套内部文档：`packages/agent-core-v2/docs/`（`di.md`、`flag.md`、`Permission.md`、`rw-model-design.md`…）。

## 六、动手练习

- [ ] CLI attach 调试（`03` 第 3 节），断点 `src/agent/llmRequester/llmRequesterService.ts:367`（kosong 调用前），把 `input.messages` 的形状（system + 历史 + 工具 schema 数量）抄下来；
- [ ] 问模型一个需要 Edit 的问题，断点 `permissionGateService.adjudicate` 与 `toolApprovalService.requestToolApproval`，对照 4.5 小节七步在调用栈里认出每一步；
- [ ] 在 `toolScheduler.ts` 观察并行/串行判定：让模型同时编辑两个文件 vs 同一文件两次；
- [ ] 触发一次自动压缩（长对话或调低 `loop_control.compaction_triggerRatio`），断点 `applyCompaction`，看历史如何被替换、token 锚点如何 rebase；
- [ ] resume 一个会话，断点 `eventDispatcherService.restore()`，数一数重放了多少条 durable 事件；
- [ ] 给 `packages/agent-core-v2` 的现有测试文件加断言跑绿（练"单包测试 + JS Debug Terminal"）。

## 下一步

→ `05-CLI与服务器.md`（同一引擎的另外两种宿主形态）
