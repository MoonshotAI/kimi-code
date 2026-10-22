# IAgentSwarmTool（agentSwarmTool）

- v2: `packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.ts`（约 63 行 interface；实现为同目录 agentSwarmTool.ts 约 351 行）
- 新架构: `packages/harness-core/src/features/swarm/tool.ts`

## 能力对照

- [x] AgentSwarm 工具入参（description/subagent_type/prompt_template/items/fork/resume_agent_ids/model，上限 128、{{item}} 占位符） → `packages/harness-core/src/features/swarm/tool.ts`（buildAgentSwarmParameters）与 `packages/harness-core/src/features/swarm/specs.ts`（MAX_AGENT_SWARM_SUBAGENTS、PROMPT_TEMPLATE_PLACEHOLDER）
- [x] 入参校验（最少 2 个 item、prompt_template 必含占位符、重复 prompt 拒绝、fork 与 resume 互斥、fork 兼容性检查） → `packages/harness-core/src/features/swarm/specs.ts`（createAgentSwarmSpecs）与 `tool.ts`（forkIncompatibility/FORK_* 复用 `features/spawn/index`）
- [x] 批执行与 XML 结果渲染（汇总行、resume_hint、属性转义） → `packages/harness-core/src/features/swarm/tool.ts`（runSwarm）与 `specs.ts`（renderSwarmResults）
- [x] 模型可见描述按配置裁剪（Available models 段、fork 描述按实验 flag 开关） → `packages/harness-core/src/features/swarm/tool.ts`（buildAgentSwarmDescription/buildAgentSwarmParameters 按 models 与 forkEnabled 裁剪）
- [x] 审批规则（AgentSwarm 名称匹配） → `packages/harness-core/src/features/permission/language/tool-matchers.ts`（AgentSwarm 条目）

## 结论

全部对齐。两项保真差异记录在案：结果属性 stop_reason 恒不出现（v2 由 mirrorAgentRun 回填 stopReason，新栈 tool.ts 的 observe 不回填）；v2 执行前的 swarmMode.enter('tool') 随 swarm mode 删除（决策不做）。
