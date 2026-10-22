# ISessionBtwService（sessionBtwService）

- v2: `packages/agent-core-v2/src/features/btw/btw.ts`（接口约 33 行；实现 `btwService.ts` 约 56 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/btw/feature.ts`

## 能力对照

- [x] `start()`：fork 主 agent 创建侧问（btw）子代理并返回其 id → `packages/harness-core/src/features/btw/feature.ts`（`BtwFace.ask()`，`session.forkAgent` + `init.source = 'btw'`）
- [x] 侧问系统提醒注入（SIDE_QUESTION_SYSTEM_REMINDER 语义）→ 同文件 `sideQuestionReminder`，经 `child.loop.remind` 投递，提醒文案同义改写
- [x] 只读工具约束：非白名单工具调用一律拒绝（TOOL_CALL_DISABLED_MESSAGE 语义）→ 同文件 agent 级 `useToolStarting` 拦截；白名单由 Read/Grep/Glob 扩为 Read/Grep/Glob/WaitFor（超集，不构成缺失）
- [x] btw 身份识别（v2 用 agent 标签 `btw`，新栈用 roster `source` 派生成员身份）→ 同文件 `isBtw`/`list()`（`session.roster` 的 `source === 'btw'`）
- [x] 进入产品默认装配 → `packages/harness-core/src/preset.ts`（`createBtw()` 在 `harnessPreset` 中）

## 结论

全部对齐：侧问代理的创建、提醒注入与只读工具约束在新栈 feature 中均有等价承载，身份判定由 agent 标签改为 roster source 派生，另新增 `btw.created` 事件与 `list/isBtw` 查询面。
