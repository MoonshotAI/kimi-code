# ISessionNotify（sessionNotify）

- v2: `packages/agent-core-v2/src/features/notify/sessionNotify.ts`（约 66 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/notify/feature.ts`（`createNotify` 的 `available()` 门控）

## 能力对照

- [x] NotifyUser 可用性门控决定工具注册与 system prompt guidance 注入 → `packages/harness-core/src/features/notify/feature.ts`（available 时 `useAgentTools(createNotifyUserTool(...))` + `useSystemPrompt(NOTIFY_USER_GUIDANCE)`）
- [x] 实验 flag 门控（v2 `NOTIFY_USER_FLAG_ID`，新栈 `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER`/总开关 env）→ 同文件 `defaultNotifyAvailable`
- [ ] per-session enabled 状态持久化 — v2 首次计算后写 `state.json` 使会话粘性保持，新栈按进程级 env 即时判定，无持久化（降级：同一会话跨进程可用性可能翻转）
- [ ] 老会话兼容回扫 — v2 无 state.json 时回扫 journal wire 记录、按 systemPrompt 是否含 guidance 文案推断 enabled；新栈无该迁移路径（历史会话能力缺失）
- [ ] 宿主 UI 能力协商 — v2 要求 bootstrap `uiCapabilities` 含 `update_panel` 才可用；新栈只发 `notify.shown` 事件、不校验宿主展示面（归属宿主层未接，宿主不监听时更新静默丢失）
- [ ] feature 不进默认装配 — `packages/harness-core/src/preset.ts` 未收录 `createNotify`，需宿主显式挂载（记录在案的交付范围决策）

## 结论

未对齐 4 项——会话级粘性 enabled 与回扫兼容、宿主 update_panel 能力协商均未迁，且默认 preset 不含 notify；门控注册工具与 guidance 注入的主链路已对齐。
