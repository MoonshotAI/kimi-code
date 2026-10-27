# ITowerInboxTool（towerInboxTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/inbox/inbox.ts`（26 行，实现见同目录 inboxTool.ts，70 行）
- 新架构: `packages/harness-core/src/features/tower/tools/inbox.ts`（createTowerInboxTool）

## 能力对照

- [x] 读取收件箱：定向消息 + 广播、最新在前、limit（默认 20）、全文输出（file/from/to/subject/sent_at/scope/action/body）→ `packages/harness-core/src/features/tower/tools/inbox.ts` + `packages/harness-core/src/features/tower/protocol/store.ts`（readInbox）
- [ ] 未读页语义：默认只返回未读页且仅确认（ack）实际返回的消息，输出报告剩余未读数 → v2 store.readUnreadInbox/ackInbox 在新栈 protocol/store.ts 无对应
- [ ] include_read=true 历史回看（含已确认消息，历史页同样只 ack 返回项）— schema 与 store 均未迁
- [ ] 与完成流的联动（"TowerComplete 有未读则拒绝，故须读净"在描述中承诺）— 随 TowerComplete 决策不做而消失

## 结论

未对齐 1 项——读信主干对齐；未读/ack 语义与 include_read 参数未迁，inbox 退化为纯只读列表。
