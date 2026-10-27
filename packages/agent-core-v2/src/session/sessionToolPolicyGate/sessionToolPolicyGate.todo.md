# ISessionToolPolicyGate（sessionToolPolicyGate）

- v2: `packages/agent-core-v2/src/session/sessionToolPolicyGate/sessionToolPolicyGate.ts`（约 17 行，读 interface 与消费方 toolActivationService/toolPolicyService 得出）
- 新架构: 无对应

## 能力对照

- [ ] 执行门禁（disabledTools 门控列表供 agent 级工具激活/政策服务在读时生效）— 未迁：新栈 loop 的 `tool.permitting` 钩子链中无会话级禁用工具门禁实现；permission feature 只做批准模式不做禁用清单
- [ ] 门禁变更事件（onDidChange 触发工具集重算）— 未迁：随门禁一并缺失
- [ ] 会话种子桥接（sessionToolPolicyGateSeed 由工作区层将 ISessionToolPolicy 桥接为门禁种子）— 未迁：v2 agent-core-v2 内注册的是 Noop 默认（sessionToolPolicyGateService.ts），真实门禁由上层种子提供；新栈两侧均无
- [ ] 门禁只读快照面（disabledTools 只读数组 + 同步可读，供渲染工具集时逐轮查询）— 未迁：新栈 agent 工具集在 spawn/挂载期裁剪（`packages/harness-core/src/features/spawn/run.ts` 的 `trimSubagentTools`），无运行期按会话策略动态禁用

## 结论

未对齐 4 项——会话级禁用工具的执行门禁未迁（与 sessionToolPolicy 同批挂起）。
