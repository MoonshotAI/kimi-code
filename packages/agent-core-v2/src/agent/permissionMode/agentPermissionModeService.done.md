# IAgentPermissionModeService（agentPermissionModeService）

- v2: `packages/agent-core-v2/src/agent/permissionMode/permissionMode.ts`（约 21 行，读 interface 与 permissionModeService.ts 实现得出）
- 新架构: `packages/harness-core/src/todo-features/permission-mode/feature.ts`（permission mode feature，只负责 expose 与切换 mode；策略执行归 `packages/harness-core/src/todo-features/permission/` 的 permission policy feature）

## 能力对照

- [x] mode 读取与 setMode（durable 状态，未变化不重发）→ `packages/harness-core/src/todo-features/permission-mode/state/projection.ts`（PERMISSION_SET_MODE）+ `packages/harness-core/src/todo-features/permission-mode/feature.ts`（PermissionModeRef.mode/setMode）
- [x] setModeAndBroadcast：main agent 切模式后广播到会话内其他 live agents → 结构变化：mode 是 session 级共享 store（`permission.set_mode` 落 session journal，会话内全部 agent 的投影各自折叠），`PermissionModeRef.setMode` 一次写入即全会话可见，无需逐 agent 广播
- [x] onDidChangeMode 变更通知 → `packages/harness-core/src/todo-features/permission-mode/feature.ts`（PermissionModeRef.state 为 ComputedRef，响应式 watch 等价承载）
- [x] 权限模式提醒注入（KIMI_CODE_PERMISSION_MODE_REMINDER 开关）→ `packages/harness-core/src/todo-features/interaction/permission-mode.ts`（useAskUserQuestionAutoMode：step 前 diff reconcile 注入 enter/exit + auto 下拦截 AskUserQuestion；只依赖 permission mode feature）

## 结论

全部对齐（模式 durable 状态、会话共享、变更订阅与提醒注入均承载；yolo_toggle/afk_toggle 遥测按既定决策不迁，不计入）。2026-10-22 起 mode 与策略执行拆分为 permission-mode / permission-policy 两个 feature：interaction 只依赖 permission-mode，permission-policy 依赖 interaction 与 permission-mode。
