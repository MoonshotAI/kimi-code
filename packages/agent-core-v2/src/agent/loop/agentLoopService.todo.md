# IAgentLoopService（agentLoopService）

- v2: `packages/agent-core-v2/src/agent/loop/loop.ts`（约 242 行，读 interface 与 loop 目录实现得出）
- 新架构: `packages/agent-core/src/loop/create-loop.ts`

## 能力对照

- [x] submit（提交用户输入，steerIfActive/onMaterialize 选项）→ `packages/agent-core/src/loop/create-loop.ts` 的 `submit`（同步返回 ack）；steerIfActive 由 `steer(promptIds)` 独立承载
- [x] steer / cancel → `steer(promptIds)`、`cancel(promptId)`；按 turnId 取消改由 `abort(reason)` 承载
- [x] snapshot（运行态/队列/paused/活动 turn）→ `loop.state`（LoopState：status/held/messages/inbox/turn/tools）；paused 语义由 held + interrupted 承载
- [x] settled（等静默）→ `waitForIdle()`；单事件等待另有 `wait(type, { match })`
- [x] notify（注入通知消息）→ `notify(entry)`；其中 bypassMaxSteps 决策不迁（无生产方），turnScoped 与 onConsume/onDrop 回调、可丢弃 handle（LoopNotifyHandle.drop）无对应通道，记录在案
- [x] 步进钩子（hooks.onWillBeginStep/onDidFinishStep，后者可 stopTurn）→ `packages/agent-core/src/loop/contract/hook.ts` 的 `step.starting`（可改写历史/阻断）与 `step.stopping`（verdict continue 反向承载 stopTurn），步完成事实经 `step.ended` 事件
- [x] 提交前钩子（onBeforeSubmitPrompt：追加 hookParts/阻断）→ `packages/harness-core/src/features/externalHooks/feature.ts` 的 UserPromptSubmit（可追加文本或阻断提交）
- [x] 循环错误恢复（registerLoopErrorHandler，match/handle/retry）→ 通用恢复点移到 llm policy：`packages/harness-core/src/runtime/hooks.ts` 的 useLlmRecovery/useLlmRetryable；v2 唯一生产方 fullCompaction 的上下文溢出恢复已内置于 `packages/harness-core/src/features/compaction/feature.ts`
- [ ] tryAcquireQuiescence（获取静默租约以串行化压缩等操作）— 新栈无对应机制（compaction 以 quiescing phase 内置排队）
- [ ] promptHandle(id)（按 prompt 查询 launched/completion 句柄）— 新栈只有事件流与 `wait(type,{match})`，无按 id 查询句柄
- [ ] buildAttachBundle/attachEngine/resetMachineEngine（测试向引擎重挂/重置钩子）— 新栈机器内置于 createLoop，不暴露重挂面

## 结论

未对齐 3 项——提交/打断/快照/钩子/错误恢复主面已对齐到 agent-core loop；静默租约、prompt 句柄查询、引擎重挂三族机制无承载（前两者记录在案，后者属测试设施）。
