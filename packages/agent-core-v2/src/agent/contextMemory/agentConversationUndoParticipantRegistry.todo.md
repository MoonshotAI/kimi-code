# IAgentConversationUndoParticipantRegistry（agentConversationUndoParticipantRegistry）

- v2: `packages/agent-core-v2/src/agent/contextMemory/conversationUndoParticipants.ts`（约 59 行，interface 与实现同文件）
- 新架构: 无对应（决策不迁）

## 能力对照

- [ ] 会话撤销参与者注册表（register 注册/注销、list 枚举，重复 id 抛错）— 用户决策不做：新架构 durable 状态随分支切换，撤销即 agent 日志 rewind 后重挂投影重建（`packages/agent-core/src/session/session.ts` 的 undo 把 rewind 后消息交给 `loop.setContext`，并重挂 rewind 丢掉的 profile），投影天然重建，无需 participants 注册表这一协调层
- [ ] undo 后的 reconcileAfterUndo 回调（参与者自行对齐注册表之外的副作用状态，phase 仅 'after-flush' 一档）— 同上：feature 状态即日志投影（`packages/harness-core/src/runtime/stores.ts` 的 useFeatureStore），rewind 后随投影一致回滚，无额外对齐回调的需求
- 备注：v2 侧注册表的实际参与方是 taskService（任务列表对齐），消费方是 undoService；新栈 todo/task 等 feature 的状态均为 agent 日志投影，撤销后无需手工 reconcile
- 备注：该注册表在 v2 注册于 Agent 作用域 OnScopeCreated（每个 agent 一份），新栈同粒度的载体是 `packages/harness-core/src/composition-api/` 的 agent 级 Unit，但无任何 feature 需要此类撤销协调

## 结论

未对齐 1 项——决策性不迁：新栈以「日志 rewind + 投影重建」替代参与者协调，注册表机制本身被架构吸收。
