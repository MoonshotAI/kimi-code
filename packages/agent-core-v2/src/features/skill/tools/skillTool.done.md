# ISkillTool（skillTool）

- v2: `packages/agent-core-v2/src/features/skill/tools/skill.ts`（约 45 行，读 interface 与实现得出；实现为同目录 skillTool.ts）
- 新架构: `packages/harness-core/src/features/skill/tool.ts`

## 能力对照

- [x] Skill 工具（名称 Skill、描述模板、skill/args 入参 schema） → `packages/harness-core/src/features/skill/tool.ts`（createSkillTool）与 `packages/harness-core/src/features/skill/skill.md`
- [x] 嵌套调用深度限制（MAX_SKILL_QUERY_DEPTH=3）与 NestedSkillTooDeepError → 同文件（常量与错误类同名保留）
- [x] 未找到 / disableModelInvocation / 非 inline 类型三类错误返回 → 同文件（executeModelSkill，错误文案保留）
- [x] 技能内容渲染并以 user 消息注入会话（renderModelToolSkillPrompt；model-tool/nested-skill 触发标记） → 同文件 + `packages/harness-core/src/features/skill/prompt.ts`
- [x] 激活来源记录（SkillActivationOrigin + 激活事件） → 同文件（SkillActivationOrigin 接口 + fire skill.activated）
- [x] 审批规则按 skill 名 glob 匹配（v2 approvalRule/matchesRule） → `packages/harness-core/src/features/permission/language/tool-matchers.ts`（Skill 条目）

## 结论

全部对齐；DI 工具契约由 ToolDefinition 工厂取代，权限规则匹配迁入 permission feature。
