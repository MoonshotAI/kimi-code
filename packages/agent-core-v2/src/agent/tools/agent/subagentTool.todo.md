# ISubagentTool（subagentTool）

- v2: `packages/agent-core-v2/src/agent/tools/agent/agent.ts`（约 93 行；实现 agentTool.ts 约 800 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/spawn/`（plan.ts / run.ts / tool.ts / format.ts）

## 能力对照

- [x] 按 subagent_type 从 profile 目录 spawn 子代理（allowlist 过滤、默认 coder、未知 profile 报错）→ `packages/harness-core/src/features/spawn/plan.ts`（planSpawn）、`profile.ts`
- [x] resume 已有子代理（归属校验、running 并发拒绝、跨重启经 roster source 重建）→ `packages/harness-core/src/features/spawn/run.ts`（resume + spawnSource 解析）
- [x] run_in_background 后台运行、完成自动通知 → `packages/harness-core/src/features/spawn/tool.ts`（detach 回调）+ `packages/agent-core/src/tool/executor.ts`（detach 机制）+ `packages/harness-core/src/features/task/feature.ts`（任务记录）
- [x] fork 当前上下文（实验开关、与 resume/type/model 的互斥校验）→ `packages/harness-core/src/features/spawn/plan.ts`（forkIncompatibility）、`feature.ts`（forkEnabled）
- [x] profile 工具白名单实际裁剪子代理工具集 → `packages/harness-core/src/features/spawn/run.ts`（trimSubagentTools / profileToolAllowed）；注：先前线索称"仅 prompt 约束无 enforcement"，已过时，现有代码确有裁剪
- [x] 审批规则按 subagent_type 做 glob 匹配 → `packages/harness-core/src/features/permission/language/tool-matchers.ts`（Agent 条目）
- [ ] model 参数与模型池（[secondary_model] 配置、force、"Available models" 描述）— 机制在（`spawn/plan.ts` 的 SpawnModelEntry / resolveSpawnModel），但 harness-core 内无人读取 secondary_model 配置，唯一挂载点 `packages/harness-core/example/app.ts` 调 createSpawn 时未传 catalog/models —— 未接线，模型选择实际不可用
- [ ] [subagent] timeout_ms 子代理超时（v2 经 resolveSubagentTimeoutMs 注册进任务并产出 timed_out）— 未迁，新栈 spawn 无超时概念
- [ ] stop_reason 细分（repeat_breaker / max_tokens / filtered / provider_error 等及各自 next_step 文案）— 降级：`spawn/format.ts` 仅剩 completed/max_steps/no_final_message/cancelled/stopped/error 六种
- [ ] 前台运行的子代理由用户转后台（v2 waitForForegroundRelease → detached）— 未迁：spawn 工具无 pending-detach 通道，TaskRef.detach / HTTP :detach 只认已后台的任务记录

## 结论

未对齐 4 项——模型池未接线、子代理超时未迁、stop_reason 细分降级、前台子代理用户转后台未迁。
