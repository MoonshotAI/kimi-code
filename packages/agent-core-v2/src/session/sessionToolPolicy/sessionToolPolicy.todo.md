# ISessionToolPolicy（sessionToolPolicy）

- v2: `packages/agent-core-v2/src/session/sessionToolPolicy/sessionToolPolicy.ts`（约 16 行，读 interface 与实现 sessionToolPolicyService.ts 得出）
- 新架构: 无对应

## 能力对照

- [ ] 会话级 disabledTools 读写（disabledTools/setDisabledTools）— 未迁：新栈两个包内无会话级禁用工具列表；`packages/harness-core/src/features/tool-select/` 是按需加载工具的 select_tools 机制，非同一能力
- [ ] 禁用列表持久化（v2 存会话目录 state.json 并经 state-registry 贡献）— 未迁：归属挂起（permission 或 profiles 域未定），无对应存储
- [ ] 变更事件（onDidChange，IWaitUntil 供级联刷新）— 未迁：随上两项一并缺失
- [ ] 串行化更新队列（v2 updateQueue 保证并发 setDisabledTools 不交错）— 未迁：随整体能力缺失

## 结论

未对齐 4 项——会话级工具禁用策略整体未迁（归属挂起 permission 或 profiles）。
