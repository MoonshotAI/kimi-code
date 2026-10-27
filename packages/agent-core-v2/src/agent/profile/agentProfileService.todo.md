# IAgentProfileService（agentProfileService）

- v2: `packages/agent-core-v2/src/agent/profile/profile.ts`（约 143 行，读 interface 与 profileService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/profiles/feature.ts`（目录面）+ `packages/harness-core/src/features/spawn/run.ts`（创建时绑定）

## 能力对照

- [x] profile 目录：发现（builtin/user/workspace/extra/explicit）、合并、渲染系统提示词、reload → `packages/harness-core/src/features/profiles/feature.ts`（ProfileCatalogRef）+ `packages/harness-core/src/features/profiles/catalog/catalog.ts` + `packages/harness-core/src/features/profiles/render/`
- [x] 模型/思考档位切换（setModel/setThinking）→ `packages/harness-core/src/features/provider-catalog/binding.ts`（SessionModelRef 的 setModel/setThinking）
- [x] profile 的工具白/黑名单（tools/disallowedTools）生效 → `packages/harness-core/src/features/spawn/run.ts`（profileToolAllowed，spawn 创建时绑定）
- [x] 系统提示词与工具集作为 agent 原生状态维护 → `packages/agent-core/src/loop/`（loop profile：setSystemPrompt/setTools，见包 AGENTS.md）
- [ ] 运行期 bind()：把 profile+model+thinking 绑定到已存活的 agent 并落 ProfileBind durable 事件、applyBindingSnapshot 恢复 — 决策不迁，新栈改为 spawn 创建时一次性绑定
- [ ] activeToolNames 运行期增删接口（addActiveTool/removeActiveTool）与 republishStatus 状态面 — 随 agent 层 bind 机制一并未迁

## 结论

未对齐 2 项——目录、模型/档位切换与创建时绑定已迁移；v2 agent 层运行期 bind（含 ProfileBind durable 事件）与工具名运行期增删按决策不做。
