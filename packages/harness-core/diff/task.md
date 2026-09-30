# task：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/task/`（约 520 行：feature.ts 141 / projection.ts 66 / format.ts 26 / tools/{task-list 103, task-output 89, task-stop 89} + 3 份 md）
- agent-core-v2：`src/agent/task/`（taskService 1517 / persist 236 / types 111 / configSection 90 / taskOps 88 / task 87 / printDefaults 58 / notificationXml 42 / errors 11 / tools/format 14，约 2254 行）+ `src/agent/tools/task/`（task-list/task-output/task-stop/task-wait 四工具约 688 行）+ `src/app/task/`（taskService 179 / task 42，221 行）
- 蓝本关系：v2 DI 版实现为行为规格蓝本，但**本域被用户有意重定义**——不迁 v2 任务服务（3163 行），只做「历史上所有 detached tools 的 durable 记录与查询/管理工具集（TaskList/TaskOutput/TaskStop + 已有 waitFor）」（约束问答「spawn 后台模式依赖 task 域吗」A，用户 2026-09-27；顺序表 #23 备注；第 23 轮落地）。v2 三工具的工具契约（文案/输出格式）仍逐字对齐 v2。另注：v2 `src/app/task/` 是 App 层通用 run/defer 异步 handle 基础设施，与 agent 后台任务无涉，两侧均无对应迁移必要。

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 域定位（最大差异） | 通用任务注册中心：Bash/Agent/AskUserQuestion 等工具经 `registerTask(task, options)` 注册 `AgentTask`（start/settle/onDetach/forceStop/toInfo 协议），服务管生命周期、输出、通知、持久化（taskService.ts 1517 行） | 无任务注册中心。agent-core 机器自带 detach 机制（`tool.detached` → 后台 actor → 完成回 `source:'async-tool'` 通知）承载执行；task 域只**观测**机器事件做 durable 记录：`tool.detached` → `task.detached` journal 事件；`tool.done` → `task.terminated`（feature.ts:68-105） | 用户重定义（约束问答 2026-09-27：「task 就是历史上所有 detached 的 tools」；第 23 轮） |
| 状态存储 | 内存 `Map<ManagedTask>` + `AgentTaskPersistence` 文件持久化（sessionDir/agents/\<id\>，writeTask/appendTaskOutput）+ `taskKey` replayable durable state 投影（taskOps.ts:77-88） | agent journal 自有 durable 事件 `task.detached`/`task.terminated`/`task.lost` + fold 投影 `ReadonlyMap<string, TaskRecord>`（projection.ts:23-66） | 新架构标准范式（todo/plan 范本；第 23 轮） |
| 状态集 | 六态：running/completed/failed/**timed_out**/killed/lost（types.ts:1-7） | 五态：无 `timed_out`（projection.ts:7） | 第 23 轮偏差③：任务域观测不到工具内部超时，超时以 failed/completed 落 output |
| 完成通知 | 任务服务自建通知总线：`loop.notify` 注入 `<notification>` XML user 消息（origin kind:'task'）+ scheduled/delivered key durable 去重 + 重启恢复投递 + suppress 机制 + undo reconcile（taskService.ts:1004-1235） | 不参与通知——机器自带 completionNotification（`[async tool completed/failed/aborted]`，第 26 轮统一 `tool.done{outcome}` 后台 handler） | 机器能力取代（第 26 轮用户定稿 tool 终局事件合一）；v2 通知总线属被重定义删去的任务服务范畴 |
| stop 通路 | `terminateWithGrace`：abortController.abort → 等 `killGracePeriodMs`（默认 5s）→ `task.forceStop?.()` → settle killed/timed_out（taskService.ts:620-682） | `agent.abortTool(taskId, reason)`（机器命令，fire-and-forget 无回执）+ 自写 `task.terminated{killed}` 记录（投影 running guard 幂等优先）；后续时序：scope abort → 工具 signal → `tool.done{aborted}` → 机器发 `[async tool aborted]` 通知 | 第 27 轮用户指示实现 `AgentCommands.abortTool`（feature 层对机器内部形状的依赖就此消除） |
| Feature 事件与 journal 事件不同名 | v2 只有一类事件（durable TaskStarted/TaskTerminated + observable TaskStarted/TaskTerminatedNotice/TaskNotified） | journal=`task.detached/terminated/lost`、facade Feature 事件=`task.started/settled`，刻意不同名 | 第 23 轮偏差①：agent journal 每次 commit 都会在 agent 节点 `node.fire(entry.event)`，同名会让 facade 订阅者收到裸 journal 事件 |
| task_id 语义 | 工具调用 id（registerTask 以 toolCall id 为 taskId） | `toolCall.id`（projection） | 已对齐（os 工具组第 18 轮决策④确立映射） |
| config 节 | `'task'` 节 8 字段 + legacy `'background'` 节 + 6 个 `KIMI_CODE_BACKGROUND_*` env 绑定（configSection.ts:19-90） | **不注册任何 config 节**、无 app slot | 第 23 轮收口核查：bash 两字段（autoBackgroundOnTimeout/backgroundTaskTimeoutS + env）已随 #28 os 域迁为 `'bash'` 节；其余（maxRunningTasks/keepAliveOnExit/killGracePeriodMs/printWaitCeilingS/printBackgroundMode/printMaxTurns）属 v2 任务服务/宿主运行时，不迁 |
| TaskOutput 元信息字段 | v2 `AgentTaskInfo` 含 kind 专有字段（process: command/pid/exitCode；agent: agentId/subagentType/model/thinkingEffort；question: questionCount）+ outputPath/outputPreviewBytes/outputTruncated/fullOutputAvailable/fullOutputTool/fullOutputHint | `tool: <toolName>` 字段取代全部 kind 专有字段；无 output_path 系列字段（tools/task-output.ts:40-58） | 第 23 轮设计（`tool` 字段取代 v2 kind 专有字段）；输出持久化缺失见「简化」表 |
| output 承载 | 增量 appendOutput：内存保留 1MB tail + >1MB 起持久化磁盘 + `getOutputSnapshot` 32KB preview + output_path 全文（Read 分页）+ process 任务 >16MB 自动 stop | 终态 output 文本**内联存 journal 事件**（succeeded 时 `extractText(result)`、failed/aborted 时错误消息）；无预览上限、无分页 | 第 23 轮记录在案取舍：新架构无独立持久日志，Bash >50K 自 spill 且文本内含 Read 指针；「不设预览上限，截断=不可恢复数据丢失」 |
| 工具注册范围 | 三工具 + TaskWait 经 `registerAgentToolService` 注册（domain 'agentTask'）；WaitFor 有 experimental flag `wait_for`（default true） | `createTask()` 进 preset 注册三工具；WaitFor 为 agent-core builtin（无 flag） | 对齐 v2 默认启用集（cron 先例；第 23 轮收口） |
| description 来源 | 任务注册时由工具侧给出（Bash 命令描述、Agent 任务描述、question 文案） | 仅从工具 `arguments.description` JSON 提取（format.ts:16-26），无该参数的工具 description 为 undefined | 第 23 轮：`tool.detached` 载荷只有 toolCall，描述只能取参数面 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 输出持久化与增量读取 | 输出增量持久化到磁盘，TaskOutput 给 32KB preview + `output_path` + Read 分页提示（fullOutputHint/fullOutputTool），running 任务也有当前缓冲 preview | TaskOutput 只有终态快照；running 任务 `retrieval_status: not_ready` 且无输出；无 output_path/分页/增量输出 | 第 23 轮偏差④「运行中任务增量输出不可得」（Bash 仅 attached 时发 onUpdate）；如需恢复需机器/工具层输出面，未立项 |
| 前台/后台双模与 waitForForegroundRelease | `detached:false` 前台任务持 `foregroundRelease`，支持手动 detach、超时自动转后台（autoBackgroundOnTimeout）、`waitForForegroundRelease(taskId)` 三态（detached/timeout_detached/terminal） | 无此概念——机器 detach 是唯一后台入口；Bash 前台超时转后台是工具内部行为，同样经 detach 落记录 | 前台/后台语义由机器与 Bash 工具承载（第 18 轮④），v2 任务服务层的三态等待面无对应；无消费方投诉记录 |
| maxRunningTasks 限额 | `assertCanRegister` 超限额抛 TASK_LIMIT_EXCEEDED | 无 | 随 'task' 节不迁整体缺席（第 23 轮收口核查） |
| 退出行为 | `keepAliveOnExit` 门控：dispose 时 abort 全部 running + forceStop；`stopAllOnExit` + exit suppression | 无——agent 关闭即机器 actor 停止，无任务级善后编排 | 同上 |
| 跨进程恢复提醒 | ghosts 恢复后注入「The user exited the application after your last turn…」reminder（`task_resume_termination` variant）+ 恢复未投递的完成通知（taskService.ts:1044-1142） | remount 仅把 running 记录 reconciliation 为 `lost`（feature.ts:106-111），无任何提醒注入 | 记录在案的缺失（第 23 轮 remount lost reconciliation 只做了状态修正）；模型只能靠 TaskList md 指引自行发觉 |
| compaction 后活跃任务提醒 | compaction splice 后 `background_task_status` variant reminder（guidance 文案 + formatTaskList） | 无（TaskList md 保留了「After a context compaction…call this tool」指引，但无主动注入） | 随通知总线整体未迁 |
| 完成通知的 suppress/去重/undo reconcile | TaskStop 前 `suppressTerminalNotification`、delivered keys durable state、undo 后 `reconcileNotificationDeliveryAfterUndo` | 机器通知无 suppress 面（TaskStop 路径会正常收到 `[async tool aborted]`——第 26 轮测试锁定的预期行为） | 语义差异在案（第 26 轮）；v2 的 TaskNotified observable 事件（externalHooks Notification hook 的唯一生产方）无对应，致 externalHooks Notification 事件无源 |
| TaskWait 工具 | 366 行独立工具（含 printWaitCeilingS/printBackgroundMode/printMaxTurns 消费、markTasksDeliveredViaWait 通知去重联动） | 不迁；等待能力由 agent-core builtin `WaitFor` 承载 | 第 23 轮重定义（「+ 已有 waitFor」）；v2 的 wait 通知去重联动无对应 |
| timed_out 终态与 manager 超时 | `timeoutMs` manager 超时 → terminateWithGrace 'Timed out' / status timed_out；detachTimeoutMs | 无任务级超时概念 | 第 23 轮偏差③（工具自身超时自控，Bash 有 backgroundTaskTimeoutS） |
| 遥测 | `background_task_created`/`background_task_completed` 两事件 | 不迁 | 遥测批次待补（telemetry builtin 第 24 轮落地后逐域补回） |
| shellCommand 后台任务不可查 | v2 `!` 前台无后台概念（v2 shellCommand 超时转后台走任务服务，有 task_id 可查） | shellCommand 转后台不走 detach 通路（facade 驱动无 toolCall，经 `agent.remind`，task_id 为 `shell-command-<rand>`）——TaskList/Output/Stop 对 `shell-command-*` id 回 `Task not found`，而其 ack 文案（renderBashBackgroundAck）提到 TaskOutput/TaskStop | **与 ack 文案自相矛盾，记录在案待用户定夺**（第 23 轮「与既有描述的出入」、第 26/27 轮遗留）：要么 shellCommand 经 `TaskRef` 自注册接入 task 记录，要么改 ack 文案 |
| forceStop 两阶段停止 | grace 期后 `task.forceStop?.()` 强杀 | `abortTool` 只有 scope.abort 一次信号，强杀力度取决于工具自身 signal 处理（Bash 经 SIGTERM→5s→SIGKILL 自保障，第 18 轮 process-exec） | 对 Bash 等价；对未来不自保障的工具是行为缺口，未立项 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| durable 投影天然跨 undo/分支 | 记录走 agent journal 事件 + fold 投影，undo/分支切换后投影自动重建到正确状态；v2 需 undo participant 专门 reconcile 通知投递状态 |
| `TaskRef` facade + Feature 事件 | `records: ShallowRef`（响应式可读）+ `stop()` 经 `useExpose` 暴露；`task.started`/`task.settled` Feature 事件供兄弟 Feature 消费（externalHooks 的 TaskStarted hook 即消费方，经 `node.parent.on` 订阅）——v2 的 observable AgentEvent2 仅 kap-server 投影消费，无 Feature 间订阅面 |
| `abortTool` 机器命令 | 第 27 轮落地的 `AgentCommands.abortTool(toolCallId, reason?)`：feature 层停止后台工具不再依赖 snapshot context 内部形状；v2 必须经任务服务持有 abortController |
| remount lost reconciliation 自动化 | 挂载时扫描投影把 running → lost 一次写完（feature.ts:106-111）；v2 需 loadFromDisk + reconcile + persist 回写多步 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `'task'` 节（maxRunningTasks/keepAliveOnExit/killGracePeriodMs/printWaitCeilingS/printBackgroundMode/printMaxTurns） | zod + legacy `'background'` 节合并 | 不注册 | 人为设计（第 23 轮收口核查：属 v2 任务服务/宿主运行时） |
| `'task'` 节 bash 字段（bashAutoBackgroundOnTimeout/bashTaskTimeoutS + env `KIMI_CODE_BACKGROUND_BASH_TASK_TIMEOUT_S`） | 同节 | 已随 os 域迁为 `'bash'` 节（第 18 轮决策⑨） | 人为设计（归属 os 域） |
| env 绑定（6 个 `KIMI_CODE_BACKGROUND_*`） | envBindings + stripEnv | 不迁（仅 bash timeout env 随 'bash' 节迁移） | 人为设计 |
| experimental flag | `wait_for` flag（default true）门控 TaskWait | 无（WaitFor 为 agent-core builtin 无 flag） | 人为设计（builtin 直挂） |
| 工厂 props | 无（DI 服务） | `createTask()` 零 props | 已对齐（无宿主概念参数） |
| preset | 默认启用集（v2 工具经 registerAgentToolService 常驻） | `createTask()` 进 preset（preset.ts:33） | 已对齐 |

## 工具 / 事件 / facade 面差异
- **TaskList**：参数 schema（active_only 默认 true / limit 1-100 默认 20）、头行 `active_background_tasks: N` / `background_tasks: N`、`No background tasks found.`、`---` 分隔、formatPlainObject 字段渲染均逐字对齐；差异 = 记录字段集（`tool` 取代 v2 kind 专有字段，无 detached/timeoutMs/terminalNotificationSuppressed）；md 描述改写了「command/PID/exit code for shell tasks」与「Bash/Agent/AskUserQuestion call」两处为通用 tool 表述（其余逐字）。
- **TaskOutput**：`Task not found: <id>`、`retrieval_status`（running→not_ready、终态→success）、`terminal_reason`（killed→stopped、failed→failed；**无 timed_out**）、`[output]` 段与 `[no output available]` 逐字；差异 = 无 output_path/outputPreviewBytes/outputTruncated/fullOutput\*/fullOutputHint 字段与 `[Truncated. Full output: …]` 行；md 的 preview/output_path 两段改写为「output captured when the task settled」版本。
- **TaskStop**：`Stopped by TaskStop` 默认 reason、终态 `Task already in terminal state` 回落、成功三行 `task_id/status/reason` 逐字；差异 = 无 `Failed to stop task: <id>` 失败路径（abortTool 无回执，running 任务恒成功返回 killed）与 suppress 前置；md 与 v2 逐字节一致（cmp SAME）。
- **事件**：journal 事件 `task.detached/terminated/lost`（durable）↔ v2 durable TaskStarted/TaskTerminated（语义对应、载荷不同）；Feature 事件 `task.started/settled` ↔ v2 observable TaskStarted/TaskTerminatedNotice（面相近）；v2 TaskNotified/TaskWaitDelivered 无对应。
- **facade**：`TaskRef { records, stop }` 为新增（v2 `IAgentTaskService` 14 方法面不迁）；三工具均经结构参数消费投影（todo 惯例）。

## 摘要
task 是四个对比域中人为重定义幅度最大的：v2 的 3163 行通用任务服务（注册中心 + 前后台双模 + 输出持久化 + 通知总线 + 跨进程恢复）被整体替换为约 520 行的「detach 观测 + durable 记录 + 三工具」——执行语义由机器 detach/abortTool/completionNotification 承载，task 域只剩记录与查询。三个最关键差异：① 完成通知从「任务服务自建去重通知总线」变为「机器自带 async-tool 通知」，v2 的 suppress/恢复/undo reconcile/Notification hook 源全部消失；② 输出从「磁盘持久化 + preview + Read 分页」降级为「终态文本内联 journal」，running 任务无任何输出面；③ shellCommand 后台通路不接入 task 记录，与其 ack 文案自相矛盾（在案待裁决）。三工具契约与文案保持逐字对齐（task-stop.md 与 v2 完全一致），对模型可见面保真度良好；最需关注的缺口是跨进程/压缩后的任务可见性提醒全缺（lost 只改状态不告知模型）。
