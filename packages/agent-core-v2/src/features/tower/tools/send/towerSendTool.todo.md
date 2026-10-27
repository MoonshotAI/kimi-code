# ITowerSendTool（towerSendTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/send/send.ts`（27 行，实现见同目录 sendTool.ts，75 行 + 同目录上一级 delivery.ts，94 行）
- 新架构: `packages/harness-core/src/features/tower/tools/send.ts`（createTowerSendTool）+ `packages/harness-core/src/features/tower/feature.ts`

## 能力对照

- [x] 输入 schema（to/subject/body/scope/action/consent_ref，strict）与发信落盘（唯一文件名、activity log）→ `packages/harness-core/src/features/tower/tools/send.ts` + `packages/harness-core/src/features/tower/protocol/store.ts`（send）
- [x] 发往 tower/广播时唤醒主 agent（v2 经 TowerInboxSent 事件；新栈经 hub.publish → feature.ts wake）→ `packages/harness-core/src/features/tower/feature.ts`（hub 与 flushInboxWake）
- [x] tower 发给无运行任务的 roster agent 时输出 undelivered 提示（指引 Agent resume 后台投递）→ `packages/harness-core/src/features/tower/tools/send.ts`（running 集合判定）
- [ ] mid-turn steer：收件方正运行时将消息注入其当前回合（tower_inbox_steer，下一步边界可见，输出报告 steered）— v2 delivery.ts steerIntoRunningAgent 未迁
- [ ] state-lost 恢复：loadOrRecover 自动重建最小状态（recoveredAt 戳）、丢失 roster 项以 placeholder 重注册并在输出注明 — 新栈无该体系
- [ ] activityLogError 上报与唤醒元数据（TowerInboxSent 携带 messageId/file/sentAt/missionId，供 wake 去重与 gate digest）— 新栈 hub signal 仅 from/to/subject

## 结论

未对齐 3 项——发信、唤醒、未送达提示主干对齐；运行中 steer、状态丢失恢复与唤醒元数据降级。
