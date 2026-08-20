# monitor

> Agent 的一次性事件监听器——通过 `MonitorCreate` / `MonitorList` / `MonitorCancel` 三个工具注册，事件触发时以中断通知推回 agent 主循环，替代轮询。实验特性，由 `monitor` flag 控制（`KIMI_CODE_EXPERIMENTAL_MONITOR`，默认关闭）。双引擎实现：v1（`packages/agent-core`）的 `MonitorManager` 与 v2（`packages/agent-core-v2`，本包）的 `AgentMonitorService`。

设计对标 Claude Code 的 Monitor 工具：agent 注册对异步事件的监听，引擎在事件发生时把通知**推回**主循环，取代轮询（反复调 TaskOutput、sleep 检查）——轮询烧 token、撑上下文、引入延迟。

## 监听器类型

| 类型 | 监听对象 | 触发条件 |
| --- | --- | --- |
| `task_output` | 本 agent 后台任务的 stdout/stderr | 首个匹配 `pattern` 的输出行（**不等**任务结束）；任务无匹配而终则静默结束 |
| `command` | 以后台任务运行的任意 shell 命令（如 `tail -f app.log`） | 首个匹配行（随后杀掉命令进程）或命令退出，先到先触发；可省略 `pattern` 只等退出 |
| `file` | 文件、目录（递归）或 glob | 首个匹配的 `created` / `modified` 事件；可选 `pattern`（对变化文件路径做 regex 过滤）与 path/glob 组合生效 |

三类共享的语义：

- **一次性（one-shot）**：`match` / `exit` / `timeout` 三者先到先触发，只发一次通知即关闭。要继续监听需重新创建。
- **超时**：每个监听器带 `timeout` 输入（秒，默认 3600，上限 86400）。超时是一种通知，不是错误。
- **历史输出匹配**（`task_output`）：订阅时会把任务**已产生**的输出回放一遍匹配器，模型从"启动任务"到"注册监听器"之间的延迟不会错过关键行。
- **上限**：每 agent 最多 20 个活跃监听器。
- **不跨重启存活**：持久化的监听器在会话恢复后一律标记 `lost`（MonitorList 可见，不重挂）。command 监听器重跑等于隐式重执行任意 shell（有副作用，不可接受）；停机期间的文件事件本就观测不到；`task_output` 的目标任务自身也是 lost。

## 工具契约

`MonitorCreate` 是以 `type` 判别的 zod discriminated union：

- 公共字段：`timeout`（秒，可选，默认 3600，上限 86400）、`description`（可选）
- `{ type: 'task_output', task_id, pattern }`
- `{ type: 'command', command, pattern? }`
- `{ type: 'file', path, events?, pattern? }`

两个输入命名决策由模型人体工学驱动（见"真机验证发现的 bug"）：

- 超时字段命名为 `timeout`（秒），与 `Bash` 工具的惯例对齐——模型被 Bash 引导，之前用 `timeout_s` 时反复被 schema 拒绝；
- `file` 分支接受 `pattern`，因为模型会自然地从另外两个分支泛化出这个参数。

`MonitorList` 无参，列出所有监听器及状态（`active` / `fired` / `ended` / `cancelled` / `lost`）。`MonitorCancel` 收 `id`（`MonitorCreate` 返回的 `monitor-*` id）。

## v2 架构

- `src/agent/monitor/monitor.ts` —— 契约：`IAgentMonitorService` decorator、spec/info/notification 类型、`MonitorNotified` 事件、state keys。`monitorNotificationDeliveryKey` 为 `defineState(...).replayable().undoable()`（镜像 `taskNotificationDeliveryKey`）；另有两个普通 key 跟踪 scheduled/delivered 通知集合。
- `src/agent/monitor/monitorService.ts` —— `AgentMonitorService`，Agent scope，`ScopeActivation.OnScopeCreated`。**必须 eager**：replayable state key 必须在 dispatcher `restore()` 完成之前贡献，而 `OnDemand` 服务首次被拉取时窗口早已关闭（这是真机验证抓到的真实 bug，见下文）。
- 通知走 `MonitorNotificationStepRequest extends MessageStepRequest`（kind `monitor_notification`、`mergeable`、`admission: 'activeOrNewTurn'`），经 `IAgentLoopService.enqueue` 注入，镜像 task notification 路径。origin 为 prompt-origin 联合的 `MonitorOrigin` 分支：`{ kind: 'monitor', monitorId, monitorType, trigger, notificationId }`。
- `task_output` watcher 订阅 `IAgentTaskService.onDidAppendOutput`（在 `appendOutput` 顶部、ring buffer 截断与 16MiB 强杀判断之前 fire），随后用 `readOutput(taskId)` 回放历史输出。跨 chunk 行重组（`\n` 切分、残段 4KiB 上限），逐行匹配。
- `command` watcher 复用 `ProcessTask` 并以 `terminalNotificationSuppressed: true` 注册，继承任务生命周期（16MiB 上限、SIGTERM → SIGKILL、close 自动收尾、`TaskList` 可见）。
- `file` watcher 走 `IHostFsWatchService`（chokidar）。watch 路径经最近现存祖先的 realpath 规范化（`canonicalizeForWatch`）——chokidar 监视穿过符号链接的路径时（macOS `/tmp` → `/private/tmp`）会把变更报在符号链接节点上，导致精确路径比较和 glob 过滤双双失效。glob 支持 = 静态前缀目录递归 watch + picomatch 过滤（chokidar v4 无 glob）。
- 送达记账镜像 taskService：scheduled/delivered key 集合、`onDidRestore` 重放、`ContextSpliced` 标记、undo participant、resume 时重投"已 fire 未送达"的通知。
- 持久化用 `IAtomicDocumentStore`（遵守本包 persistence 规则，不碰 `node:fs`）。
- 遥测：`monitor_created` / `monitor_fired` / `monitor_cancelled` 注册于 `src/app/telemetry/events.ts`（`track2`，属性不含路径与用户内容）。
- 工具在 `src/agent/tools/monitor/monitor-{create,list,cancel}/`，以 `registerAgentToolService(..., { domain: 'agentMonitor', when: flag })` 自注册；flag 声明于 `src/agent/monitor/flag.ts`。

## v1 对应实现

`packages/agent-core/src/agent/monitor/manager.ts` —— `MonitorManager`，仅挂主 agent（子 agent 为 `null`，与 cron 同模式）。通知复用 `renderNotificationXml`（category `monitor`），经 `agent.turn.steer` 推送，origin 形状与 v2 一致；同时发 `Notification` hook。持久化用 `PerIdJsonStore` 写 `<sessionDir>/monitors/<id>.json`。工具在 `packages/agent-core/src/tools/monitor/`，按 `experimentalFlags.enabled('monitor')` 条件实例化。

## 跨包触点

- `packages/protocol/src/events.ts`、`packages/kap-server/src/protocol/events-zod.ts` —— origin zod 联合的 `monitor` 分支（wire 校验会拒收未知 origin，必须最先落地）。
- `packages/transcript` —— `TurnOrigin` 联合、wire 契约 schema、`groupTurns` 映射。
- `packages/kap-server/src/services/transcript/coreEventMap.ts` —— origin 映射。
- `apps/kimi-code` TUI —— replay/导出渲染 monitor 通知（**live** 渲染路径尚缺，见"已知限制"）。
- plan mode：双引擎均在 plan mode 下封禁 `MonitorCreate` / `MonitorCancel`（v1 `plan-mode-guard-deny.ts` + injection 文案；v2 `planService.ts` + `plan-mode-full-reminder.md`）——注册监听器是会越过 plan 退出的副作用。

## 验证

- v1：`packages/agent-core/test/agent/monitor/monitor.test.ts`（单元 + 工具面 + 真实 Agent + scripted model 的端到端：`MonitorCreate → 进程启动 → 命中 → steer → 进程收尾`）。
- v2：`packages/agent-core-v2/test/agent/monitor/monitorService.test.ts`（DI harness 挂真实 `AgentTaskService`，含驱动真实 dispatcher restore 时序的回归用例）。
- schema 转换：`test/tools/input-schema-io.test.ts`（v1）与 `test/tool/input-schema.test.ts`（v2）锁定 union 根必须暴露 `type: "object"`。
- parity：`packages/node-sdk/test/v1-v2-parity.test.ts` 未改动即通过（flag 默认关，两引擎工具清单都不含新工具）。
- 真机：构建产物带 flag 跑三监听器完整演示（后台任务 + task_output 监听、`tail -f` 命令监听、文件创建监听），三个通知全部在 turn 中送达。

## 真机验证发现的 bug

以下每一个都通过了全部单测，只有跑构建产物才暴露：

1. **replayable state 时序违例** —— v2 服务原为 `ScopeActivation.OnDemand`，`contributeState` 在 dispatcher 进入 `ready` 后才执行，agent 创建即抛 `BugIndicatingError`。修复：改 eager（`OnScopeCreated`），对齐 `AgentTaskService`。
2. **union 工具 schema 被 provider 拒绝** —— zod discriminated union 序列化后根级只有 `anyOf` 分支列表、没有 `type`，provider 要求 `tools.function.parameters.type === "object"`（400）。修复：双引擎 `toInputJsonSchema` 统一给 `anyOf`/`oneOf` 根补 `type: 'object'`。
3. **`task_output` 历史输出竞态** —— watcher 原来只看订阅之后的 chunk，模型"思考"几秒才注册时，关键行早已输出，监听器永远错过并静默结束。修复：订阅时回放任务持久化输出。
4. **符号链接 watch 路径** —— macOS 上监听 `/tmp/monitor-demo.done` 不触发，chokidar 把变更报在 `/tmp` 符号链接节点上。修复：双引擎统一做 watch 路径 realpath 规范化。
5. **schema 人体工学** —— 模型被 Bash 工具引导传 `timeout`（字段却叫 `timeout_s`）；调 file 类型时自然带上 `pattern`（分支却没有）。修复：输入改名 `timeout`；file 分支接受 `pattern`。教训：closed-object union schema 会惩罚每一个合理猜测，面向模型的字段名应遵循工具集已有的惯例。

## 已知限制

- **无 live TUI 渲染**：monitor 通知在 replay/导出中可见，但没有 cron `cron.fired` 那样的专属 live 渲染事件；交互会话里用户看到的是 agent "自发"开始新回合。
- 监听器恢复后为 `lost`（设计如此，见上文），模型需在重启后重建。
- `task_output` 逐行匹配、残段上限 4KiB；不支持跨行 pattern（设计如此）。
- `file` 监听器通知里报告的是规范化（realpath 后）的变化路径。

## 提交（分支 `feat/monitor-watchers`）

- `35e2fdf8f` feat: add experimental Monitor tools for event-driven watchers
- `a20d6c5d7` fix: close two monitor watcher gaps found in real CLI runs（backlog 回放、符号链接规范化）
- `84080e9f0` fix: rename MonitorCreate's `timeout_s` input to `timeout`
- `4f81ee215` feat: accept an optional `pattern` on file monitors
