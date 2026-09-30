# interaction：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/interaction/`（482 行 ts + ask-user.md 22 行：interaction.ts 251 / tool.ts 160 / feature.ts 41 / index.ts 30）
- agent-core-v2：`src/agent/interaction/`（186 行：交互契约 + wiring）+ `src/human/interaction/`（397 行：进程单例 facade + XState machine）+ `src/agent/tools/ask-user-question/`（475 行：AskUserQuestion 工具，任务描述未列出，实为工具契约蓝本，以代码事实为准补充）
- 蓝本关系：refact-237 第一批迁移域，以 `human/interaction` 旧版为蓝本（见 refact-237 handoff 第 73/77/78/83 轮）；v2 DI 版在 agent 层另有 wiring（durable 事件、turn 结束取消）与工具实现，本任务 Handoff 第 11 行明确「第一批迁的 todo 等以 human 旧版为蓝本，与 DI 版在细节上有差异」。核心机制（openInteractions 登记表）两侧代码几乎逐行同构。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 进程单例 → session 级实例 | `human/interaction/facade.ts:249` 模块加载即创建进程级单例 `interactions`（内含 XState machine），按 `attachAgent(sessionId:agentId)` 路由事件、`purgeSession` 清理 | session slot `openInteractions({ fire })` 每 session 一份内存登记表，`useExpose(InteractionRef)` 暴露，agent slot `useInteractions()` inject 同一份；隔离靠实例本身（feature.ts:20-26） | refact-237 handoff 第 77 轮（用户要求 Interaction 以 session 为单位、删除 machine.ts），第 78 轮（类型与登记表同文件） |
| XState machine 移除 | `human/interaction/machine.ts` createInteractionMachine 管 records Map | 纯 Map 实现，无状态机（interaction.ts:110-251） | refact-237 handoff 第 77 轮：「现状态只有 pending/resolved 的 Map，没有阶段、invoke、延迟转移，不值得用 XState」 |
| 事件通道：订阅者回调/总线 → Feature 事件 | facade 的 `onDidChangePending`/`onDidResolve` 监听器 + agent dispatcher 路由 | session slot `useFire`：`interaction.requested`（带完整 interaction）/`interaction.resolved`（id/response/interaction）从 session 节点冒泡至 app；宿主经 `session.on(interaction, ...)` 订阅 | refact-237 handoff 第 83 轮（用户要求用 fire 事件给宿主 UI）；第 109 轮（`createFeature<E>` 泛型事件） |
| 不在 turn 结束取消 | `agent/interaction/interactionWiring.ts:35` `cancelInteractionsForTurn`：TurnEnded 时按 turnId tag 取消前台交互（respond `{cancelled:true, reason:'turn_ended'}`），由 agentLifecycleService.ts:145 接线 | 无 turn 结束取消；`InteractionCancellationReason` 虽保留 `'turn_ended'` 枚举但无生产方。agent 卸载 `cancelAgent(agentId,'agent_closed')`、session 卸载 `stop()`（feature.ts:25,37-39） | refact-237 handoff 第 76 轮：「Interaction 不在 turn 结束取消，后台 question 可跨 turn」（概念边界①：interaction 是纯机制——挂起→问宿主→等回复，见 feat-271 约束问答 permission 条） |
| 后台 question 走 detach 而非任务服务 | background=true → `IAgentTaskService.registerTask(QuestionBackgroundTask)` 注册为 question 类后台任务，ack 用任务服务 task_id | background=true → `detach?.(ack)` 走框架 detach 通路（tool 机转后台，答案作为 async-tool 完成通知回来），ack 的 task_id 即 toolCall.id（tool.ts:146-150） | refact-237 handoff 第 104 轮（background 参数设计）；feat-271 第 47/48 轮问答「task 就是历史上所有 detached tools」的框架级重定义 |
| 后台门控取消 | `allowBackground()` 要求 TaskList/TaskOutput/TaskStop 三工具激活才在 description/parameters 里出现 background（askUserQuestionTool.ts:72-78,111-117），不满足时调用报 BACKGROUND_UNAVAILABLE_MESSAGE | background 恒可用：参数 schema 与 md 静态包含 background 行，无门控、无不可用文案 | detach 是框架内建能力，无需任务工具门控（与 os 域第 18 轮决策④「run_in_background 总是可用」同类） |
| 描述/ack 文案改写 | v2 动态拼接 BACKGROUND_DESCRIPTION（"background question task"、"in a later turn"、"never fabricate or predict the answer"）；ack `Use TaskStop only to cancel the question.` | md 静态多一行（harness ask-user.md:22，"a background question"、"in a later message"、"use WaitFor only if..."）；ack `task_id: <toolCallId>\nstatus: running\nnext_step: ... Use WaitFor only if you cannot proceed without it.`（tool.ts:148-149）；schema 的 background describe 同步改写 | 后台通路从任务工具改为 detach+waitFor 的配套文案（WaitFor 为 agent-core builtin） |
| ask 自问自答模型 | v2 裁决者/审批经 toolApproval 统一封装（permission 域） | interaction 只提供 `request/enqueue/respond/wait` 原语；「ask 不是返回值——裁决者自己异步问完再返回最终裁决」是 permission/plan 各自实现的约定 | feat-271 约束问答 permission 条（2026-09-29 定稿，概念边界①） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| durable 落账 | `agent/interaction/interactionOps.ts`：`interaction.request`/`interaction.resolved` 为 durable AgentEvent2，写 agent journal，可回放/审计；kap-server 据此投影 pendingInteraction | 两事件为纯节点 Feature 事件，不落 journal；登记表纯内存（resolved 记录 60s TTL + 256 上限驱逐，interaction.ts:68-69） | 会话重放/审计丢失交互历史；v2 消费方 sessionActivity（pendingInteraction 聚合）属清单漏项、归属待用户定（feat-271 完整性核查①） |
| 中止悬挂 | v2 工具侧 signal abort → `interactions.respond(id, null)` 立即解决（askUserQuestionTool.ts:240-249）；TurnEnded 再兜底取消 | `interactions.request` 无 signal 接线：turn 中止时 tool 机转 aborted，但交互记录滞留 pending 直到 agent/session 卸载 | 中止后 pending 记录泄漏（影响 findAll({resolved:false}) 与宿主 pending 面板）；无记录在案的待办，属第一批遗留语义缺口 |
| dismissed 归一化 | 工具把 null/空 answers 归一为 `{answers:{}, note:'User dismissed the question without answering.'}`（askUserQuestionTool.ts:267-275），并区分 method 埋点 | 工具原样透传宿主响应 `JSON.stringify(response)`（tool.ts:157）；空 answers 无 note 补充（md 仍描述 note 语义，依赖宿主自行带上）；feature-acp 失败/跳过回退 `{answers:{}}` 同样无 note | 模型端「用户未回答」信号弱于 v2；无待办记录 |
| zod 参数校验 | zod schema（1-4 题、每题 2-4 选项、逐字段 describe、uniqueness refine），框架层校验后进入 execute | 手写 JSON schema（无 min/max、无逐字段 describe，仅结构）；execute 内 `readQuestions` 宽容过滤非法项，全非法回 `Provide at least one question.`，uniqueness 文案逐字（tool.ts:31-50,52-80）；`JSON.parse` 无容错（非法 JSON 直接 throw 走 tool failed，其他域有 `invalid X arguments` 先例未套用） | 模型可见的参数约束提示弱于 v2；非法调用的错误形态不同 |
| 遥测 | `question_answered`（answered 数/method/trace_id）/ `question_dismissed` 两事件 | 无 | 遥测不迁批次，待云端 appender 落地后统一补回（feat-271 第 24 轮 telemetry 设计要点） |
| 宿主响应契约 QuestionResult | `null \| QuestionAnswers \| QuestionResponse` 三态归一（normalizeQuestionResult） | 无归一——宿主需直接响应 `{answers}` 形态（feature-acp 已按此实现，example/cli.ts 先例） | 宿主实现负担略增；已事实收敛 |
| execution 元数据 | resolveExecution 带 `description`（'Asking user questions'/'Starting background question: …'）、`approvalRule: 'AskUserQuestion'` | ToolDefinition 无 display/approvalRule 通道 | 审批展示用通用派生（permission 域记录在案的简化） |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| `cancelAgent` facade | harness `Interactions.cancelAgent(agentId, reason)`（interaction.ts:234-240）把按 agent 取消收编为一等 facade 方法；v2 同等逻辑散在 interactionWiring 的 detach/cancelForTurn 两个自由函数里 |
| 迟到订阅者可见 resolved 记录 | v2 human facade 也有 recentlyResolved 保留窗，但 harness 的 `findAll({resolved:true})` 与 `wait` 对已解决 id 直接返回 response，语义与 v2 一致且实现更简（无 machine 往返） |
| feature-http / feature-acp 消费面 | `route-features/interaction.ts` 提供 pending 列表 + respond REST（v2 由 kap-server 另层实现，不属 v2 src 域，仅作消费面对照）；feature-acp `interaction-bridge.ts` 把 approval/question 桥到 ACP `session/request_permission` 与 `elicitation/create`（选项映射/降级命名空间参照 v2 acp-server 同名文件语义） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| config 节 | 无 | 无 | 已对齐（两侧均无配置节） |
| env | 无 | 无 | 已对齐 |
| 工厂 props | 无（DI 服务，OnScopeCreated 自动激活） | 无 props（`interaction` 为常量 FeatureSpec，进 preset；session+agent 双层 slot） | 已对齐（均零配置） |
| experimental flag | 无 | 无 | 已对齐 |
| facade 方法面 | `request/enqueue/respond/findAll/findOne/wait` + `onDidChangePending/onDidResolve/attachAgent/detachAgent/purgeSession/stop` | `request/enqueue/respond/findAll/findOne/wait/cancelAgent/stop` | 人为设计（监听器两方法由 Feature 事件取代；attach/detach/purgeSession 由 session 级实例取代；cancelAgent 新增） |

## 工具 / 事件 / facade 面差异
- 工具：两侧均注册 `AskUserQuestion`。契约差异见上表：harness 参数 schema 为手写精简版（无 1-4 题/2-4 选项约束与逐字段 describe）；background 恒可用；错误 isError 通道已对齐（至少一题/重名校验标 `isError: true`；取消两侧均不标），剩余差异为 dismissed 归一 JSON vs 取消文案透传；harness 工具对每个 agent（含子代理）挂载，v2 经 profile 工具白名单门控（如 explore 无此工具）+ auto 模式 policy 链拒绝（permission 域已补齐 auto-mode-ask-user-question-deny）。
- Feature 事件：harness `interaction.requested`/`interaction.resolved`（节点事件，不落账）；v2 durable `interaction.request`/`interaction.resolved`（落 journal）。payload 形状：harness requested 带完整 interaction；v2 request 事件带 `{agentId,id,kind,toolCallId?,request}`（toolCallId 从 tags/payload 提取）。
- tags：harness 工具仅附 sessionId/agentId/toolCallId 三 tag；v2 前台问题另附 turnId（供 turn 结束取消）。`INTERACTION_TAG_TURN_ID` 常量在 harness 保留但无生产方（feature-http 的 questionView 读它恒 undefined）。
- `user_tool` kind：枚举保留；v2 生产方是 userToolService（宿主自定义工具执行请求），harness 无该域，无生产方。

## 摘要
核心登记表（openInteractions：request/enqueue/respond/wait/幂等 resolve/TTL 驱逐/id 生成）与 v2 human 版几乎逐行同构，对齐度高；框架定位已从「进程单例 + XState + 监听器」按用户决策收敛为「session 级实例 + Feature 事件」（refact-237 第 77/83 轮）。最重要的三个差异：① 无 turn 结束取消与 signal 接线——前台问题在 turn 中止后滞留 pending，是 v2 DI 版有而本架构刻意/遗留都没有的行为；② durable 落账未迁，交互历史不进 journal，重放与会话活动聚合不可还原；③ AskUserQuestion 的后台通路从任务服务改为 detach（人为设计），但 zod 校验、dismissed 归一化、遥测三处保真度损失明显。最需关注的缺口是中止悬挂（无记录在案待办）与 dismissed note 无人生产（md 承诺与实现不一致）。
