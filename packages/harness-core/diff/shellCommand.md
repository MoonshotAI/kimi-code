# shellCommand：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/shellCommand/`（269 行：feature.ts 82 / runner.ts 178 / xml-escape.ts 7 / index.ts 2）
- agent-core-v2：`src/agent/shellCommand/`（300 行：shellCommand.ts 23 / shellCommandService.ts 277）
- 蓝本关系：以 v2 DI 版为蓝本。第 16 轮最小 spawn 实现；第 18 轮按 os 决策⑧重写为共享 process-exec + 120s 超时转后台（修订第 16 轮的 kill 语义）。非 refact-237 第一批域。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 输入/输出消息通道 | `context.append` 即时写入上下文记忆，`origin: { kind: 'shell_command', phase }` 挂在消息级（shellCommandService.ts:239-258） | `agent.remind` 唯一 key（`shell-command:<id>:input|output|backgrounded`）被动注入；origin 语义以 part 级 meta `{ kind: 'shell_command', phase, isError? }` 承载（runner.ts:40-48/146-155） | 用户 2026-09-29 决策（约束问答 shellCommand 条目：remind 队列、下一轮 drain 带上；part meta 对齐 skill 先例，不动 agent-core） |
| 执行路径 | 复用 Bash 工具：`toolRegistry.resolve('Bash')` → `resolveExecution({ command, timeout: 120s })` → `execute`，输出治理/后台提升全部由 Bash 工具与任务服务承担 | 自 `host.process.spawn(shell, ['-c', cmd], { cwd })` + 共享 `startProcessExecution`（os 域进程执行器）；stdin 即关 | 第 16 轮最小实现（spawn 失败 ENOENT 不抛走 isError 结果）；第 18 轮④共享执行器（os 决策⑧） |
| 超时语义 | Bash 工具 120s 前台超时后按任务服务自动转后台（`task_id: …` 输出触发 `notifyBackgrounded`） | 自有 `timeoutMs`（默认 120_000）计时器到点转后台：不杀进程，`renderBashBackgroundAck`（taskId=commandId、scenario `foreground_detached`、title `Command timed out and moved to background`、foregroundOutput=已累计输出）remind 注入并返回 `{ stdout: ack, backgrounded: true }` | os 决策⑧（2026-09-29：`!` 命令 120s 超时转后台 + 注入通知，不是杀掉；修订第 16 轮 kill 语义） |
| 事件触发条件 | 仅 `input.commandId` 显式给出时才发 `shell.started/output/completed`（dispatcher.dispatch 全部以 commandId 存在为门） | commandId 缺省自动生成（`shell-command-<rand>`，同 v2 synthetic toolCallId 形态），事件恒发 | 第 16 轮（facade 恒有 id；v2 的条件派发是配合 TUI 按需订阅，新架构 Feature 事件无此必要） |
| 后台完成补发 | 后台路径不发 `shell.completed`（完成通知由任务服务 async-tool 通知承担） | 后台进程最终退出时照发 `shell.completed` + output remind（runner.ts:128-157） | 第 18 轮偏差③：为 UI 生命周期闭合的有意补充 |
| facade 形态 | `IAgentShellCommandService`（Agent 域 DI，run/cancel） | `createShellCommand({ workDir, shell?, timeoutMs?, host? })` 工厂 + `ShellCommandRef`（run/cancel）+ `createFeature<ShellCommandEvent>`；不进 preset、无 HTTP 路由 | 第 16 轮偏差④⑤（workDir 宿主概念；`!` 前缀解析是宿主/TUI 职责，facade only） |
| XML 文案 | `<bash-input>\n<cmd>\n</bash-input>`、`<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>` + XML 转义 | 逐字对齐（runner.ts:42/64/149；xml-escape.ts 与 v2 `_base/utils/xml-escape` 同四转义） | 第 16 轮（逐字对齐声明） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 输出治理 | 经 Bash 工具获得 output-accumulator：>50K spill 落盘 / 10M 截断保留 | runner.ts 无界累加 stdout/stderr（runner.ts:86-97），无 spill 无截断 | 超大输出有内存风险且无 Read 指针引导；os 决策⑤「执行器级 truncateForModel 单列议题另行归属」，shellCommand 通路未单列 |
| task_id 真实性 | 转后台后 commandId→真实 taskId（durable `shellCommandTasksKey` 映射），TaskOutput/TaskStop 可管理 | task_id 即 commandId（`shell-command-*`），转后台不走 detach 通路，task 域查不到该 id——ack 文案里的 TaskOutput/TaskStop 指引对它不成立 | 第 23 轮「与既有描述的出入」记录在案待用户定夺（shellCommand 接 task 记录或改 ack 文案）；第 26/27 轮遗留同项 |
| `shell.started` 语义 | 在 `onForegroundTaskStart`（前台命令关联到后台 task）时发，payload 带 taskId | 进程 spawn 成功即发，payload 无 taskId（agentId/commandId） | 语义不同名：v2 = 后台任务已关联，harness-core = 进程已启动；订阅方需按新语义理解，第 16 轮偏差②记录在案（事件 payload 无 taskId） |
| 转后台通知时机 | `notifyBackgrounded` 经 `loop.submit(..., { steerIfActive: true })`，可中途 steer 活动 turn（origin `{kind:'injection', variant:'shell_command_backgrounded'}`） | `agent.remind`（key `shell-command:<id>:backgrounded`）被动注入，下一 drain 落账；纯文本单步 turn 不带 | 机器语义差异（第 16 轮偏差①：remind 只在 turn 经过 draining 时带入历史）；如需改变属 agent-core 议题 |
| durable 状态 | `shellCommandTasksKey`（defineState Map<commandId, taskId>） | 无（running/cancelledBeforeStart 两内存 Map） | 跨重启无 command 轨迹；v2 该状态的消费方是 TUI 面板关联，新架构由 task 域重组，随上面 task_id 项一并定夺 |
| 遥测 | `shell_command_finished { duration_ms, is_error, backgrounded }` | 不迁 | 已知遥测批次待补（第 16/18 轮遗留） |
| shell 解析 | 跟随 Bash 工具的 execEnv 体系（shellPathBridge/loginShellPath 探测修正） | props `shell` 直接 exec（默认 `/bin/bash`） | 无 login shell PATH 修正与 win32 桥接；host 注入不同 shell 即可覆盖，未单列归属 |
| 结果类型细节 | `isError?: boolean` 可选 | `isError: boolean` 必填 | 类型面差异，无行为影响 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| cancel 竞态防护 | `cancelledBeforeStart` 集合：cancel 先于 spawn 完成到达时登记，启动后即中止（runner.ts:80-83）；v2 cancel 对未注册 id 静默 no-op | 
| 后台完成事件闭合 | `shell.completed` 在后台路径也补发（v2 不发），宿主可统一以前台/后台同一事件收尾 |
| Bash 依赖解耦 | 不依赖 Bash 工具注册（v2 无 Bash 抛 `Error2(INTERNAL, 'Bash tool is not registered.')`），shellCommand 自包含 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| config 节 | 无专属节（前台超时硬编 `SHELL_FOREGROUND_TIMEOUT_S = 120`；后台行为由 `'task'` 节 bashAutoBackgroundOnTimeout/bashTaskTimeoutS 控制） | 无节；props `timeoutMs`（默认 120_000） | 人为设计（props 化；`'task'` 节 bash 字段已随 os 域注册为 `'bash'` 节，shellCommand 不消费） |
| shell | Bash 工具 execEnv 解析 | props `shell?: string`，默认 `/bin/bash` | 简化（见上表） |
| host | `IHostProcessService`（DI，经 Bash 工具间接使用） | props `host?: OsHost`，缺省 `createNodeOsHost()` | 人为设计（第 18 轮⑥；第 22 轮用户否决同类缺省但未要求改这里，记录在案） |
| env 绑定 | 无 | 无 | 已对齐 |

## 工具 / 事件 / facade 面差异
- 工具：两侧均不注册 agent 工具（`!` 前缀解析为宿主职责）。
- Feature 事件：事件名三者对齐（`shell.started` / `shell.output` / `shell.completed`）；payload 差异——v2 `shell.output` 携带 `update: ToolUpdate`（kind stdout/stderr + text），harness-core 展平为 `{ stream: 'stdout'|'stderr', text }`；v2 `shell.started`/`shell.completed` 带 taskId，harness-core 无；v2 事件为 AgentEvent2 observable（wire 投影），harness-core 为 `createFeature<E>` 节点事件。
- facade：方法面一致（`run({command, commandId?})` / `cancel(commandId)`）；返回均 `{ stdout, stderr, isError, backgrounded? }`。

## 摘要
shellCommand 的消息文案（bash-input/stdout/stderr XML）、facade 形状、120s 前台超时与「转后台不杀进程」语义已按 v2 对齐，事件名保持兼容。最大架构差异是消息通道与执行路径：v2 即时 context.append + 复用 Bash 工具全治理，harness-core 按用户决策走 remind 被动注入 + 自 spawn 共享执行器。最大缺口是输出治理缺席（无界累加）与 `shell-command-*` task_id 在 task 域不可查询/停止（ack 文案指引落空），两项均记录在案待归属；`shell.started` 语义变化与遥测缺失为次级差异。
