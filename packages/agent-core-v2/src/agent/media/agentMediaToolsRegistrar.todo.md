# IAgentMediaToolsRegistrar（agentMediaToolsRegistrar）

- v2: `packages/agent-core-v2/src/agent/media/mediaTools.ts`（约 8 行，读 interface 与 mediaToolsRegistrar.ts 实现得出）
- 新架构: `packages/harness-core/src/features/media/feature.ts`（挂载即注册）

## 能力对照

- [x] ReadMediaFile 工具注册（附件 store、工作区、能力、视频上传器、遥测）→ `packages/harness-core/src/features/media/feature.ts`（useAgentTools(createReadMediaFileTool)）+ `packages/harness-core/src/features/media/deliver/tool.ts`
- [x] 按模型能力（image_in / video_in）门控媒体读写 → `packages/harness-core/src/features/media/deliver/tool.ts`（执行期按 model.capability 门控；modelSpec 惰性求值，模型切换后生效）
- [ ] 模型别名/能力/运行时身份变化时动态注销重挂工具（v2 以 AgentStatusUpdated/runtime 变更驱动 refresh 重注册）— spec freeze 前提下决策不迁，新栈挂载时一次性注册、执行期门控
- [ ] 视频上传器的按模型重解析与 credential recovery 包裹（v2 每次 refresh 重新 getRequester 并包 runWithCredentialRecovery）— 随重注册机制一并未迁，新栈上传路径由 store-ref resolver 统一承载

## 结论

未对齐 2 项——工具本身与能力门控已迁移；运行期动态重注册机制（含上传器重解析）按决策不做（挂载时门控替代），属决策性缺失。
