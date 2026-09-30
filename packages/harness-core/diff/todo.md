# todo：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/todo/`（198 行 ts + 31 行 md：feature.ts 48 / projection.ts 29 / tool.ts 61 / todoItem.ts 49 / index.ts 11）
- agent-core-v2：`src/features/todo/`（453 行 ts + 31 行 md：todoService.ts 163 / todoListReminder.ts 104 / todoOps.ts 25 / todoItem.ts 52 / todoFeature.ts 17 / tools/todo-list 92）；refact-237 第一批蓝本 `src/human/todo/`（182 行 ts + 31 行 md：plugin.ts 38 / slice.ts 34 / tool.ts 61 / todoItem.ts 49）
- 蓝本关系：refact-237 第一批域，以 human/todo 为蓝本近乎逐字移植（tool/todoItem/md；projection 对应 human slice）。与 v2 DI 版在提醒机制与文案上有蓝本因素差异。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 持久化形态 | durable 事件 `tools.update_store { key: 'todo', value }` + xstate actor durable 定义（undoable: true，todoService.ts:127-136） | 自有 journal 事件 `todo.updated { todos, lastWriteTurn }` + fold 投影（projection.ts）；undo 语义随 agent.switched 分支切换自然成立 | 蓝本因素 + 新架构投影范式（plan/todo 范本） |
| stale 提醒通道 | reminder 总线 `register('todo_list_reminder')`，gate 注入下一请求 | `agent.on('turn.started')` + `agent.remind(key 'todo-stale')` 被动注入，首次 drain 落账 | 横切约定（remind 取代 reminder 总线）；271 第 1 轮 `svztssun` 基线修复（237 工作副本遗留的 remind 缺 key 补齐） |
| turn 计数 | human 蓝本 slice 经 `turnStarted` 事件 `currentTurn += 1`；v2 DI 无 turn 计数（历史扫描，见下） | 投影 reduce 对 journal `turn.started` `currentTurn += 1`（projection.ts:24-26） | 蓝本因素（human slice 同构移植） |
| facade 形态 | `IAgentTodoService`（get/replace/clear + `onDidChange` 事件；get/replace 内部 `todo.used` 标记） | `TodoRef`（`items` / `state` 响应式 Ref，computed 派生） | 新架构 useExpose 范式（第 1 批先例） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 提醒节奏与触发 | 历史扫描双阈值：距上次写入 ≥10 个 assistant 消息 且 距上次提醒 ≥10（todoListReminder.ts:7-8/21-33）；`toolPolicy.isToolActive` 门；仅 main agent；`used` 状态机（首次使用/恢复后才启用提醒） | 投影 turn 计数：`currentTurn - lastWriteTurn === 2` 时提（feature.ts:29-42）；凡挂载即提（含子代理）；无 used 门（空列表/全 done 提前返回） | 蓝本因素（human 蓝本即此语义）；提醒更频繁且子代理也收，与 v2 产品口径不同，未单列归属 |
| 提醒文案 | 长文案："The TodoList tool has not been updated recently. … Also consider clearing or rewriting … NEVER mention this reminder to the user." + `1. [status] title` 编号列表（todoListReminder.ts:90-103） | 短文案："The todo list has not been updated recently. If the work is still in progress, update the list to reflect the current progress." + `  [status] title` 两空格缩进列表（renderTodoList） | 蓝本因素（human 文案）；模型收到的引导强度不同 |
| 工具执行元信息 | `description` 三态（Reading/Clearing/Updating todo list）+ `display: { kind: 'todo_list', items }` + `approvalRule`（todoListTool.ts:32-44） | 未迁 | display 面归属：ACP plan 卡片已由 feature-acp 经 TodoRef 投影重建（第 43 轮，比 v2 瞬时 display 更强）；approvalRule 待 #19 |
| 参数校验 | zod：`title` min 1、status 枚举，框架层拒绝非法输入 | JSON schema 无 minLength；`readTodoItems` 容错过滤非法项（title 非 string/status 非枚举即丢弃） | 蓝本因素；非法项静默丢弃 vs v2 显式报错，可观察差异小 |
| 输出细节 | 写后回读 `this.todo.get()` 渲染（replace 后状态）；读路径 `get()` 顺带标记 used | 渲染解析后的 `next`（与 dispatch 后状态等价，dispatch 已 await） | 行为等价，无归属 |
| isError 通道 | 输出恒 `{ isError: false, output }` 显式 | A 步已落地；本域输出恒成功不标记（v2 显式 `isError: false` 与无标记等价），无行为差异 | A 步已落地（第 76 轮） |
| 提醒时机 | 总线在 gate 注入，下一请求即见 | turn.started remind 首次 drain 落账（晚一步；纯文本 turn 不带） | 横切机器语义（第 16 轮①同类），无归属 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| 响应式 facade | `TodoRef.items/state` 为响应式 Ref，任何途径的 todo 变化可订阅（feature-acp plan 卡片即消费：`watch(face.items)` 持续推 plan 通知，比 v2 靠 TodoWrite 瞬时 display 更强——第 43 轮偏差②） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| config 节 / env / flag | 无 | 无 | 已对齐 |
|  stale 阈值 | 10 + 10（历史扫描常量） | `STALE_TURNS = 2`（turn 计数常量） | 蓝本因素（见行为差异表） |
| 工具可见性 | profile 工具名单（AGENT_TOOLS/CODER_TOOLS 均含 TodoList）+ toolPolicy | preset 全 agent 挂载即得 | 蓝本/体系差异（spec freeze 先例） |

## 工具 / 事件 / facade 面差异
- 工具：`TodoList` 名称、`todo-list.md`（cmp 与 v2 逐字节一致）、`todo-list-write-reminder.md`（cmp 一致）、参数 schema（`todos` 数组 + title/status 字段 + describe 文案）、输出文案（读路径 `renderTodoList`、`Todo list cleared.`、`Todo list updated.\n<list>\n\n<write-reminder>`）逐字对齐；`renderTodoList`/`readTodoItems`/`statusMarker` 逻辑逐字（空列表 `Todo list is empty.`、标题 `Current todo list:`）。
- 事件：v2 durable `tools.update_store`；harness-core journal `todo.updated`（durable 等价物）+ 无 Feature 事件（v2 的 `onDidChange` 由响应式 ref 替代）。
- facade：见行为差异表（方法面 get/replace/clear → 响应式 Ref；replace/clear 能力由工具与 dispatch 覆盖，facade 不再暴露写方法）。

## 摘要
todo 的工具契约（md、schema、输出文案、渲染逻辑）与 v2 逐字对齐，持久化从 v2 的通用 update_store 事件换成自有 `todo.updated` journal 事件 + fold 投影，undo/分支语义自然成立。最大差异在 stale 提醒：harness-core 继承 human 蓝本的「2 turn 未写即提 + 短文案 + 全 agent」，与 v2 DI 的「10+10 历史扫描 + 长文案 + 仅 main + used 门」是两套产品口径，属记录在案的蓝本因素。最大缺口是 display/approvalRule 元信息未迁（ACP 侧已由 TodoRef 投影重建 plan 卡片，反而更强）；响应式 TodoRef 是超出 v2 的能力。
