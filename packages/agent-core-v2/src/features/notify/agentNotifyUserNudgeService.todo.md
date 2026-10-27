# IAgentNotifyUserNudgeService（agentNotifyUserNudgeService）

- v2: `packages/agent-core-v2/src/features/notify/notifyUserNudgeService.ts`（约 116 行；interface 为 brand-only，能力读实现与 `notifyUserNudge.ts` 得出）
- 新架构: `packages/harness-core/src/features/notify/feature.ts` + `nudge.ts`

## 能力对照

- [x] nudge 阈值逻辑：距上次 NotifyUser ≥8 轮工具调用且距上次 nudge ≥8 轮时注入提醒 → `packages/harness-core/src/features/notify/nudge.ts`（`NOTIFY_USER_NUDGE_THRESHOLD = 8`、`shouldNudgeNotifyUser`）
- [x] nudge 提醒文案与注入时机（每步开始前）→ `packages/harness-core/src/features/notify/feature.ts`（`useStepStarting` + `agent.loop.remind`，key `notify_user_nudge`）
- [x] 工具未注册/不可用时不 nudge 的门控 → 同文件 `available()` 判定（env flag）
- [x] 中途文本回复后的补充提示（mid-response hint）→ `packages/harness-core/src/features/notify/nudge.ts`（`shouldNudgeMidResponse`/`renderMidResponseHint`，新栈新增能力）
- [ ] turn 起点判定保真度损失 — v2 `startsNewTurn` 按 `origin.kind` 细分（user/cron_job/cron_missed/task/retry/system_trigger 除 stop_hook/skill_activation 仅 user-slash/plugin_command），新栈只认 `meta.source` 为 `input`/`notify` 两类，cron/skill/触发器起点不再重置 streak（降级）
- [ ] `notify_user_nudge_shown` 埋点（turn_id/rounds/nudge_index）未迁 — 归属 telemetry 域，记录在案未迁
- [ ] 宿主 UI 能力（`update_panel`）协商门控未迁 — 新栈仅查 env flag，不确认宿主是否有展示面（降级，与 `sessionNotify.md` 同源）

## 结论

未对齐 3 项——turn 起点判定从 origin.kind 细分退化为 meta.source 两类、nudge 埋点未接、宿主能力协商缺失；阈值、文案与注入机制已对齐并新增 mid-response 提示。
