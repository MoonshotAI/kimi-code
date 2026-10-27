# IAgentSkillService（agentSkillService）

- v2: `packages/agent-core-v2/src/features/skill/skillService.ts`（约 295 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/skill/feature.ts`

## 能力对照

- [x] activate（用户斜杠激活：校验存在性与可激活类型、渲染技能提示、提交 turn 并返回 turn id） → `packages/harness-core/src/features/skill/feature.ts`（SkillRef.activate；HTTP 面 `packages/harness-core/src/feature-http/route-features/skill.ts`）
- [x] promptWithSkills（多技能捆绑随用户提示提交，origin 携带 skillActivations） → 同文件（SkillRef.promptWithSkills，origin 结构保留）
- [x] recordModelToolActivation（模型工具调用后的激活记录） → `packages/harness-core/src/features/skill/tool.ts`（executeModelSkill 内部 fire skill.activated）
- [x] SkillActivated 域事件（激活事实广播） → `packages/harness-core/src/features/skill/feature.ts`（skill.activated 运行时事件）
- [ ] 遥测 skill_invoked/flow_invoked — 决策不迁：harness-core 无这两个埋点（保真差异，记录在案）
- [ ] 主 agent 的 prompt metadata 摘要更新（applyPromptMetadataUpdate/promptMetadataTextFromSkill） — 未迁：harness-core 全仓无 promptMetadata 机制
- [ ] promptWithSkills 的 steerIfActive 入参与 queued/blocked/running 状态返回 — 降级：SkillFace.promptWithSkills 仅返回 { turnId? }，忙时直接提交，不再区分排队/阻塞/steer

## 结论

未对齐 3 项——遥测两个埋点决策不迁、prompt metadata 更新未迁、steer/排队状态语义简化；核心激活链路已对齐。
