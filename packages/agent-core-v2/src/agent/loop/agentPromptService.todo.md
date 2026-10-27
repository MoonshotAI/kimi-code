# IAgentPromptChannel（agentPromptService）

- v2: `packages/agent-core-v2/src/agent/loop/promptChannel.ts`（约 95 行，interface 与实现同文件）
- 新架构: `packages/harness-core/src/feature-http/route-builtin/prompts.ts` + `packages/agent-core/src/loop/create-loop.ts`

## 能力对照

- [x] submit（提交用户 prompt 入 loop，tracked/origin 元数据）→ `packages/harness-core/src/feature-http/route-builtin/prompts.ts` 的 prompts.submit 路由调 `agent.loop.submit`；ACP 面另有 `packages/harness-core/src/feature-acp/session.ts`
- [x] submitSteer（运行中打断注入）→ prompts.ts 的 prompts:steer 路由 + `loop.steer`
- [x] 首 prompt 更新会话标题元数据（仅主 agent）→ `packages/harness-core/src/features/kimi/sessionTitle/feature.ts`（从历史摘录生成/拉取标题，同样只作用主 agent）
- [x] steer 遥测（input_steer）→ `packages/harness-core/src/features/telemetry/derive.ts`（监听 prompt.steered 事件上报）
- [ ] 提交后同步等待 launch 并返回 turn_id（PromptLaunchResult）— 新栈 submit 只同步返回 ack，HTTP 响应不含 turn_id；客户端只能从 `turn.started` 事件（`packages/agent-core/src/loop/contract/emitted.ts`）事后获知，属降级，记录在案

## 结论

未对齐 1 项——提交/打断/标题/遥测已对齐；「提交即返回已启动 turn_id」的同步 launch 语义降级为事件流获知。
