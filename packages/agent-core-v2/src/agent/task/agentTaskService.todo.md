# IAgentTaskService（agentTaskService）

- v2: `packages/agent-core-v2/src/agent/task/task.ts`（约 106 行，读 interface 与 taskService.ts 实现得出；实现约 1700 行）
- 新架构: `packages/harness-core/src/features/task/feature.ts`

## 能力对照

- [x] 后台任务登记与查询（records 投影、list）→ `packages/harness-core/src/features/task/feature.ts`（TaskRef.records，taskProjection 落 agent log）+ `packages/harness-core/src/features/task/projection.ts`
- [x] TaskList / TaskOutput / TaskStop 三个模型工具 → `packages/harness-core/src/features/task/tools/task-list.ts` + `packages/harness-core/src/features/task/tools/task-output.ts` + `packages/harness-core/src/features/task/tools/task-stop.ts`
- [x] stop/detach（对 live detached 工具调用 abortTool/detachTool，lost/killed 状态）→ `packages/harness-core/src/features/task/feature.ts`（TaskRef.stop/detach）
- [x] WaitFor 等待工具 → `packages/harness-core/src/features/wait-for/feature.ts` + `packages/harness-core/src/features/wait-for/tool.ts`
- [ ] 任务配置面生效：maxRunningTasks / keepAliveOnExit / killGracePeriodMs / printWaitCeilingS / printBackgroundMode / printMaxTurns — 配置节与 env 绑定已迁 `packages/harness-core/src/features/os/configSections.ts`，但仅 bashAutoBackgroundOnTimeout/bashTaskTimeoutS 被 Bash 工具消费（`packages/harness-core/src/features/os/feature.ts`），其余注册未生效
- [ ] waitFor 门控（subagent 后台任务未结时的收 turn 提醒/阻止）— 不迁
- [ ] 终端通知抑制面（suppressTerminalNotification/suppressAllTerminalNotifications/markTasksDeliveredViaWait）与输出落盘读取面（persistOutput/getOutputSnapshot/readOutput 基于 outputPath 全量输出文件）— 记录在案未迁，新栈 TaskRecord 直接持有输出文本

## 结论

未对齐 3 项——任务记录、三个工具与 stop/detach 已迁移；配置面大部分未生效、waitFor 门控与通知抑制/输出文件面未迁。
