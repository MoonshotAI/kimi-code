# IAgentToolPolicyService（agentToolPolicyService）

- v2: `packages/agent-core-v2/src/agent/toolPolicy/toolPolicy.ts`（约 22 行，读 interface 与 toolPolicyService.ts、evaluate.ts 实现得出）
- 新架构: 无对应（归属挂起：permission 或 profiles）

## 能力对照

- [x] profile 级工具白/黑名单（profile 的 tools/disallowedTools 生效）→ `packages/harness-core/src/features/spawn/run.ts`（profileToolAllowed，创建时过滤工具集）
- [ ] isToolActive/isToolDenied 运行时裁决（组合 workspace 门禁 + profile + 全局 [tools] 配置 + 会话禁用四层）— 未迁：新栈所有 agent 挂载即得全量工具，仅 execute 期由各域守卫门控
- [ ] 全局 [tools] 配置节（enabled/disabled，env 绑定）— 新栈无该配置节，未迁
- [ ] setSessionDisabledTools 会话级禁用 API 与 getPolicyFingerprint 指纹 — 随服务整体未迁
- [ ] select_tools 披露门控（isToolActiveForDisclosure）— 随服务整体未迁

## 结论

未对齐 4 项——profile 级名单在 spawn 创建时承载；运行时工具策略组合裁决、全局配置节、会话禁用 API 与指纹均未迁，归属挂起。
