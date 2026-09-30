# btw：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/btw/`（116 行：feature.ts 115 / index.ts 1）
- agent-core-v2：`src/features/btw/`（94 行：btwService.ts 46 / btw.ts 31 / btwFeature.ts 17）
- 蓝本关系：v2 DI 版 `features/btw` 为行为规格蓝本（feat-271 第一批迁移 `tmvzzovs`，第 7 轮身份持久化返工，不属 refact-237 第一批 human 蓝本）；两侧都不走 spawn 管线，只用 fork（约束问答 spawn 条：「btw 在 v2 里只用 `agentLifecycle.fork`（只读子代理）……btw 的真正前置是 fork 路径」）。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 成员身份与守卫存活期 | 无成员身份概念：`start()` 时在 child scope 上当场注册内存 veto（btwService.ts:37-43）——child 关闭/重建后守卫即失效，也无从判定某 agent 是否 btw | roster source 派生：fork 时写 `source: 'btw'` 随 `agent.opened` 单条记录原子落账（durable）；agent slot 的 `useBeforeTool` 守卫读 `useSessionStore().getState().roster` 判定（feature.ts:86-93）——remount/重开后守卫仍生效，`list()`/`isBtw()` 同源 | 第 7 轮（用户定稿）：agent 创建链路加 source 创建者标记字段，btw 从 roster 派生成员身份，取代内存 `BtwRegistryRef`；单次写入原子化优于 feature 自有注册记录（崩溃窗口归零，无需对账） |
| reminder 注入机制 | reminder 总线：`IAgentReminderService.notify(SIDE_QUESTION_SYSTEM_REMINDER, {variant:'btw'})`，步头主动注入（btwService.ts:30-32） | `child.remind(systemReminder(...).userMessage(), {key:'btw.side_question'})` 被动注入，drain 时随下一轮落账（feature.ts:72-75） | 约束问答 reminder 条（用户 2026-09-27：不实现 reminder 域，各 Feature 直调 agent.remind） |
| facade 形态 | `ISessionBtwService.start(): Promise<string>`（返回裸 agentId） | `BtwRef`（useExpose 落 session 层）：`ask(): Promise<{agentId}>`、`list(): readonly string[]`、`isBtw(agentId)`（feature.ts:63-81） | 第 7 轮偏差③：`BtwRegistryRef` 整体删除，facade 直接读 roster；list/isBtw 为 roster 派生的自然产物 |
| 可配对端 | 写死 fork `MAIN_AGENT_ID` | props `sourceAgentId?`（缺省 main）；源 agent 非 live 时抛 `Cannot start a side question: source agent '<id>' does not exist or is not running in this session.` | 工厂化先例（CreateBtwProps，feature.ts:46-53） |
| 只读工具集 | 写死 `Read/Grep/Glob` 三件套（btw.ts:3） | props `readonlyTools?`，缺省 `['Read','Grep','Glob','WaitFor']` 四件套（feature.ts:22）；reminder 与 denied 文案均由该列表生成 | 未在 Handoff 记录——默认集合多出 `WaitFor`（agent-core builtin 等待原语，只读性质相符）；文案随之变化（见「简化」表），os 工具组设计要点仍按「btw 白名单 Read/Grep/Glob」描述 |
| 子代理 id | `agentLifecycle.fork` 自动分配 | `btw-<randomUUID().slice(0,8)>`（feature.ts:70） | spawn 的 `subagent-<8>` 先例 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| denied 文案的 worker guidance | veto 文案经 `formatDenyMessage`：child 非 main → 恒追加 ` Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`（btwService.ts:33-36 + toolApprovalService.ts:250-259） | 固定文案无后缀：`Only the read-only tools <list> are available for side questions. Other tool calls are disabled.` | 未在 Handoff 记录；btw 子代理恰是非 main agent，v2 实际总是带后缀——新文案丢掉了这条重试引导 |
| reminder 文案 | 固定文案（btw.ts:8-22）：`You are a separate, lightweight instance.`（无 fork 来历说明），固定排版权 | 生成文案（feature.ts:98-110）：新增一句 `forked from the main agent. The conversation above is a snapshot inherited from it, not your own history; do not continue the original task.`，单段排版 | 未在 Handoff 记录——措辞改写（信息量是 v2 超集，融合了 FORK_CONTEXT_NOTICE 语义），但非逐字对齐 |
| 错误形态 | `Error2(AGENT_NOT_FOUND, 'Main agent was not found')` | 裸 `Error`，文案含 sourceAgentId（见上表） | Error2 域不迁大类（ coded error → plain error 的既定批次） |
| 工具可见性说明 | veto 只挡执行，工具定义对模型可见（reminder 里说明「exist only for technical reasons — prompt cache」） | 同——fork 继承冻结 spec 全量工具可见，守卫 per-call deny | 已对齐（非差异，列出防误读） |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| durable 成员身份 | roster source 落账后跨 remount/跨进程重开仍可判定 btw 身份，守卫不死；v2 重启后 btw child 即失去只读约束（v2 无此保障） |
| `btw.created` Feature 事件 | `createFeature<BtwEvent>`，`ask()` 成功后 fire `{type:'btw.created', agentId, sourceId}`（feature.ts:28-34/76）；v2 无任何事件——宿主可据此接线 UI（swarm 设计要点⑧「btw.created 先例」即指此） |
| `list()`/`isBtw()` facade | v2 无查询面 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| config 节 / env | 无 | 无 | 已对齐 |
| 工厂 props | 无（registerFeature 默认启用集） | `createBtw({ sourceAgentId?, readonlyTools? })`，进 preset | 人为设计（工厂化；默认行为与 v2 等价，除默认只读集多 WaitFor） |
| experimental flag | 无 | 无 | 已对齐 |
| facade 方法面 | ISessionBtwService：`start()` | BtwRef：`ask()`/`list()`/`isBtw()` | 新增更强（ask 对齐 start） |

## 工具 / 事件 / facade 面差异
- 工具：两侧均不注册任何工具；行为核心是 fork 只读子代理 + per-call 执行守卫（v2 `onBeforeExecuteTool` 读 `event.toolCall`，新 `useBeforeTool` per-call，语义等价）。
- Feature 事件：v2 无；新增 `btw.created`。
- facade：见上表。

## 摘要
btw 是小而完整的一域：fork 只读子代理 + 工具 veto + reminder 三段主行为与 v2 对齐，且成员身份从 v2 的「当场注册、重启即失效」升级为 roster source durable 派生（第 7 轮用户定稿，严格更强），另新增 `btw.created` 事件与 `list/isBtw` 查询面。最大的偏差在文案层：denied 文案丢了 v2 实际恒有的 worker guidance 后缀、reminder 文案经改写非逐字、默认只读集多出 WaitFor——三处均未在 Handoff 记录。无遗留待办级缺口；如需严格对齐 v2 文案，把 denied 文案补回 guidance 后缀、reminder 恢复 v2 原文即可（各一行改动）。
