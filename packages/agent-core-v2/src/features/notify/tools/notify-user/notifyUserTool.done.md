# INotifyUserTool（notifyUserTool）

- v2: `packages/agent-core-v2/src/features/notify/tools/notify-user/notify-user.ts`（接口约 32 行；实现 `notifyUserTool.ts` 约 74 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/notify/tool.ts`

## 能力对照

- [x] NotifyUser 工具主能力：把进度更新投递给用户（v2 由宿主从工具调用透传，新栈发 `notify.shown` 事件由宿主渲染到 Updates 面板）→ `packages/harness-core/src/features/notify/tool.ts`（`fire({ type: 'notify.shown', message })`）
- [x] 空 message 校验报错（文案逐字一致）→ 同文件 `NOTIFY_USER_EMPTY_MESSAGE`
- [x] 不可用时抑制投递但不报错（`Notifications are disabled…` 文案逐字一致）→ 同文件 `NOTIFY_USER_SUPPRESSED_OUTPUT`
- [x] 成功回执 `Update shown to the user.`（逐字一致）→ 同文件 `NOTIFY_USER_DELIVERED_OUTPUT`
- [x] 工具描述文档 → `packages/harness-core/src/features/notify/notify-user.md`（按 Updates 面板 UI 改写，写作指引同义保留）

备注：v2 的可选 `title` 参数及其单行校验在新栈移除——新 UI 以面板展示完整 message，无紧凑标题位，属产品面重写而非遗漏；`notify_user_sent` 埋点未随迁，归属 telemetry 域记录在案未迁。

## 结论

全部对齐：投递、校验、抑制与回执语义完整迁移，投递通道由宿主透传改为 `notify.shown` 事件，title 参数随新 UI 设计移除。
