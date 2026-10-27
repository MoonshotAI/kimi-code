# ITaskService（taskService）

- v2: `packages/agent-core-v2/src/app/task/task.ts`（约 42 行 interface，实现 taskService.ts 约 179 行，一并读过）
- 新架构: `packages/harness-core/src/features/task/`（概念重定义）

## 能力对照

- [x] 后台任务的可见性（列表/输出/停止，状态投影与事件）→ `packages/harness-core/src/features/task/feature.ts` 的 TaskFace.records/stop/detach + tools/（task-list/task-output/task-stop 工具）
- [ ] run(fn)/defer() 通用异步任务句柄（pending/running/终态事件流、output 流、cancel、IDisposable）— 未迁：新栈 task 域重定义为「后台工具调用跟踪」，无通用任务运行原语
- [ ] v2 消费方 agent/task 后台任务系统的配置旋钮（maxRunningTasks/keepAliveOnExit/killGracePeriodMs，`packages/agent-core-v2/src/agent/task/configSection.ts`）— 未迁：随 agent 层任务服务决策不迁（agent/task 同项记录在案）

## 结论

未对齐——任务概念重定义为 features/task 的后台工具任务跟踪；通用 run/defer 原语与 agent 层任务配置旋钮不迁。
