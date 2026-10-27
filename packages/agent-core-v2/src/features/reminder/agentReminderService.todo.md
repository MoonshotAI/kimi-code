# IAgentReminderService（agentReminderService）

- v2: `packages/agent-core-v2/src/features/reminder/reminderService.ts`（约 321 行，读 interface 与实现得出）
- 新架构: 无对应（决策不做）；替代机制为 `packages/agent-core/src/loop/`（`loop.remind`/`notify` 命令）与各 feature 自挂的 `useStepStarting` 钩子

## 能力对照

- [ ] `register(variant, provider)` 上下文注入总线：各域注册 provider，每步开始前统一求值并按 variant 优先级排序注入（含 injectedPositions/lastInjectedAt/lastDisclosure/isNewTurn 上下文、空内容跳过、raw message 注入）— 决策不做：各 Feature 改为直调 `agent.loop.remind` 或在 step.starting 钩子里自行追加，reminder 总线不迁
- [ ] `notify(content, notification)` 直接追加 system-reminder 消息 — 决策不做；调用方改用 `loop.remind`（如 dateChange/notify/plan/sessionInit 均已各自直调）
- [ ] `reconcileWhenIdle(variant)` 静息补注入（quiescence 获取后对指定 variant 重跑 provider）— 决策不做，无等价物
- [ ] compaction 后 rearm：监听 `ContextSpliced` 在压缩后重注入关键提醒 — 决策不做，新栈由各 feature 自行处理

备注：dateChange、notify nudge、plan、sessionInit 等原消费方均已在 harness-core 内以 feature 私有逻辑完成等价注入（见各对应 md），故总线本身的撤销不造成这些域的用户可见缺失。

## 结论

全部未对齐（决策性）——reminder 总线按决策不迁，注入能力下沉为各 feature 直调 `loop.remind`/step.starting；reconcileWhenIdle 与 compaction rearm 无替代。
