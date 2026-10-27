# ISessionExternalHooksService（sessionExternalHooksService）

- v2: `packages/agent-core-v2/src/features/externalHooks/session/sessionExternalHooks.ts`（接口约 8 行 brand-only；实现 `sessionExternalHooksService.ts` 约 183 行，能力读实现得出）
- 新架构: `packages/harness-core/src/features/externalHooks/feature.ts`（session slot）

## 能力对照

- [x] 会话开始钩子：非 fork 来源触发，matcherValue=source，携带 sessionTitle/model/profile → `packages/harness-core/src/features/externalHooks/feature.ts`（session slot，`runner.trigger('SessionOpened')`）
- [x] 会话关闭钩子（matcherValue=reason，携带 sessionTitle）→ 同文件 `useCleanup` 中的 `SessionClosed` 触发
- [x] SessionHeartbeat：60s 间隔、仅在存在该事件 hook 时投递、携带 sessionTitle/uptimeMs → 同文件 `setInterval(HEARTBEAT_INTERVAL_MS)` 分支
- [x] SubagentStart/SubagentStop（matcherValue=agentName，携带 prompt/response 与 sessionTitle）→ 同文件 `watchSubagentActivity`
- [ ] 事件更名无兼容层 — v2 事件名 `SessionStart`/`SessionEnd` 在新栈改为 `SessionOpened`/`SessionClosed`（`internal/types.ts` 的 `HOOK_EVENT_TYPES`），config schema 按新枚举校验，用户既有配置中的旧事件名直接校验失败，无别名或迁移层（降级：配置兼容性断裂）
- [ ] SessionClosed 的 reason 保真 — v2 传真实关闭原因（`SessionCloseReason`），新栈固定写死 `'exit'`（降级）

## 结论

未对齐 2 项——SessionStart/SessionEnd 更名后旧 hook 配置不兼容、SessionClosed 原因固定为 exit；会话开始/关闭/心跳与子代理起止四类触发本身均已迁移。
