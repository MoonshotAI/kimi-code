# IAgentInterruptionReminderService（agentInterruptionReminderService）

- v2: `packages/agent-core-v2/src/agent/interruptionReminder/interruptionReminder.ts`（约 8 行，读 interface 与 interruptionReminderService.ts 实现得出）
- 新架构: 无对应

## 能力对照

- [ ] 用户取消（cancelled + interruptReason 为 user_cancelled）的 turn 结束后，向会话注入「上一轮被用户打断、部分输出不完整、下一条消息是继续」的提醒 — 决策不做；新栈无此 feature，需要时可用 agent.on('turn.ended') + agent.remind 三行补回
- [ ] 注入前去重：末尾可比较消息已是同 variant（interruption_reminder）注入则跳过 — 随上项一并未迁
- [ ] vacuous assistant 消息跳过（partial 且无 toolCalls、内容全空的尾巴消息不参与去重比较）与 ownerPromptId 锚定 — 随服务整体未迁
- [ ] 状态键 interruptionReminderKey 的 durable 贡献（contributeState，恢复后可识别已注入）— 随服务整体未迁

## 结论

未对齐 1 项——中断提醒能力整体决策不做（含其去重与锚定细节），属决策性缺失而非遗漏。
