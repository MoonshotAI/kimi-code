# IAgentDateChangeService（agentDateChangeService）

- v2: `packages/agent-core-v2/src/features/dateChange/dateChangeService.ts`（约 178 行；interface 为 brand-only，能力读实现得出）
- 新架构: `packages/harness-core/src/features/dateChange/feature.ts`

## 能力对照

- [x] 首次日期披露：注入「Today's date is …」初始提醒 → `packages/harness-core/src/features/dateChange/feature.ts`（`initialDateReminder`，文案逐字一致）
- [x] 跨天检测：本地日期变化时注入「The date has changed…」提醒并要求模型以最新提醒为准 → 同文件 `dateChangeReminder`（文案逐字一致），按 `Intl.DateTimeFormat` 本地时区比较
- [x] 披露基线判定：依据历史中最近一次日期提醒（新栈以 `meta.source='reminder'` + `key='date-change'` 提取已披露日期）决定是否再注入 → 同文件 `lastDisclosedDate`
- [x] 注入时机挂在每步开始前 → 同文件 `useStepStarting`（v2 经 reminder 总线的 `onWillBeginStep` 钩子，机制不同、时机等价）
- [x] 进入产品默认装配 → `packages/harness-core/src/preset.ts`（`createDateChange()`）

备注：v2 对「环境披露 cwd 与 session cwd 不同的 agent」跳过日期注入（`belongsToCurrentCwd`，依赖 `IAgentProfileService` 的 environmentDisclosure）；新栈无该守卫，对所有 agent 统一注入。影响为多注入一条提醒而非日期能力缺失，不计未对齐项。

## 结论

全部对齐：初始披露与跨天提醒的核心能力、文案与注入时机均已迁移，披露基线由 reminder 总线的 disclosure 追踪改为历史消息标记提取。
