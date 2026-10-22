# IAgentToolSelectAnnouncementsService（agentToolSelectAnnouncementsService）

- v2: `packages/agent-core-v2/src/agent/toolSelect/toolSelectAnnouncements.ts`（约 8 行，读 interface 与 toolSelectAnnouncementsService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/tool-select/feature.ts`

## 能力对照

- [x] 新 turn 开始时可加载工具清单公告（LOADABLE_TOOLS_VARIANT 提醒，仅 isNewTurn）→ `packages/harness-core/src/features/tool-select/feature.ts`（useLoopEvent('turn.started') 触发 state.announcement()，以 LOADABLE_TOOLS_REMINDER_KEY remind 注入；公告落地后经 message.appended 回执 markAnnounced 去重）
- [x] 公告内容渲染（tools_added/tools_removed 分段与 fold 说明）→ `packages/harness-core/src/features/tool-select/state.ts`（renderLoadableToolsAnnouncement，added/removed 差分与 announced 集合维护）
- [x] 公告在飞去重（announcementInFlight 防止同 turn 重复注入）→ `packages/harness-core/src/features/tool-select/feature.ts`（announcementInFlight 标志 + queueMicrotask 注入）
- [x] 清单回撤语义（可加载集合变空时以 tools_removed 取代旧列表）→ `packages/harness-core/src/features/tool-select/state.ts`（removed 差分渲染；v2 另有一次性「空清单」公告分支，新栈在从未有过可加载工具时不发公告，差异在案不影响主流程）

## 结论

全部对齐（公告触发、内容差分、注入键与落地确认机制均由 tool-select feature 承载）。
