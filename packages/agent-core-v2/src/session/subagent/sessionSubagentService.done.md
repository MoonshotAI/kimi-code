# ISessionSubagentService（sessionSubagentService）

- v2: `packages/agent-core-v2/src/session/subagent/subagent.ts`（约 68 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/spawn/`

## 能力对照

- [x] planSpawn（profile 委派白名单 + 模型池解析 + fork 约束）→ `packages/harness-core/src/features/spawn/plan.ts`（`planSpawn/validateSpawnArgs/forkIncompatibility`）
- [x] spawn（建子 agent、渲染 profile prompt、裁剪工具、登记 registry）→ `packages/harness-core/src/features/spawn/run.ts`（`createSubagentLauncher.launchPlanned`）+ `packages/harness-core/src/features/spawn/tool.ts`（spawn 工具）
- [x] run（对已存在 agent 跑一轮/续跑，返回完成摘要与用量）→ `packages/harness-core/src/features/spawn/run.ts`（`resume` 经 `ensureAgent` 重开续跑；`latestAssistantText/sumUsage/classifyOutcome` 组成完成结果）
- [x] 子 agent 身份与并发守护（父归属、运行中不可并发）→ `packages/harness-core/src/features/spawn/run.ts`（`spawnSource/parseSpawnSource` + `SpawnRegistry.running` 标记）
- [x] onWillStartAgentTask / onDidStopAgentTask / notifyAgentTaskStopped（任务起止钩子，v2 由 externalHooks 消费）→ `packages/harness-core/src/features/externalHooks/feature.ts`（`watchSubagentActivity` 派生 SubagentStart/SubagentStop 钩子事件）

## 结论

全部对齐；同步 run/钩子事件分别由 launcher 管线与 externalHooks 的活动观察结构性承载。
