# IAgentShellCommandService（agentShellCommandService）

- v2: `packages/agent-core-v2/src/agent/shellCommand/shellCommand.ts`（约 23 行，读 interface 与 shellCommandService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/shellCommand/runner.ts`

## 能力对照

- [x] run：执行 `!` shell 命令，前台超时（v2 120s）后转后台并回报 backgrounded → `packages/harness-core/src/features/shellCommand/runner.ts`（openShellCommands，timeoutMs 超时后经 renderBashBackgroundAck 转后台）
- [x] 命令输入/输出以 bash-input / bash-stdout / bash-stderr XML 注入会话历史 → `packages/harness-core/src/features/shellCommand/runner.ts`（createHistoryMessageBuilder().xml + loop.remind）
- [x] cancel(commandId) 中止运行中命令 → `packages/harness-core/src/features/shellCommand/runner.ts`（cancel + cancelledBeforeStart）
- [x] shell.started / shell.output / shell.completed 事件外发 → `packages/harness-core/src/features/shellCommand/feature.ts` + `packages/harness-core/src/features/shellCommand/runner.ts`（fire 事件）
- [ ] 转后台命令纳入任务体系：v2 经 Bash 工具 onForegroundTaskStart 注册任务，TaskOutput/TaskStop 可作用于其 taskId — 新栈转后台不走 detach 通路（直接 spawn host.process），TaskOutput/TaskStop 对 shell-command-* id 回 Task not found，待用户定夺

## 结论

未对齐 1 项——执行、注入、取消与事件均已迁移；转后台命令不进 TaskRef records，任务工具不可见，属已知出入。
