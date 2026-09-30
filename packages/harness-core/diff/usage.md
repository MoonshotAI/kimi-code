# usage：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/usage/`（84 行：feature.ts 35 / usage.ts 45 / index.ts 4）
- agent-core-v2：`src/features/usage/`（15 行 Feature 壳）+ `src/agent/usage/`（286 行：agentUsageService.ts 97 / usageOps.ts 43 / usageEvents.ts 37 / cacheProbeService.ts 59 / usage.ts 33 / errors.ts 9 / cacheProbe.ts 8）+ `src/human/usage/`（136 行，refact-237 第一批蓝本：machine.ts 43 / plugin.ts 44 / usage.ts 49）
- 蓝本关系：refact-237 第一批域，`accumulateUsage`/`UsageRecord`/`UsageSummary` 以 human/usage 为蓝本逐字移植；v2 DI 版（durable + 状态推送 + cache 探测）为行为规格，差异多为蓝本因素。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 记录触发 | llmRequester 统一调 `record(agent, model, usage, source?)`（turn 源 `usageScope:'turn'`、非 turn 源 'session'） | `agent.on('llm.streaming.usage')` 直订 + `agent.on('turn.started')` 记 currentTurnId（feature.ts:19-32） | 蓝本因素（human plugin 同形态）；第 25 轮用户「监听直接写在 feature 里」风格先例 |
| model 来源 | record 调用方传入的 model 字符串（请求实际模型 id） | 每次事件读 `agent.config?.model` 活值（LlmModel 对象） | 蓝本修正：human 蓝本 plugin 输入固定 model；活读跟随运行期模型切换 |
| 状态形态 | durable `usage.record` 事件 + `usageKey { byModel }` replayable 状态（usageOps.ts:37-43） | 全内存 `records`/`summary` 两 shallowRef | 蓝本因素（human 蓝本即内存 xstate actor） |
| facade 形态 | `ISessionUsageService`（record/status + `onDidRecord` 事件） | `UsageRef { summary, records }` 响应式 Ref | 新架构 useExpose 范式；消费方已接线：feature-acp `usage_update`（session.ts:316/344）、goal 预算（providerRef 可选探测，第 28 轮） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 持久化 | byModel durable，重启/remount 后累计用量保留 | 全内存，remount/重启清零 | 蓝本因素的保真度损失；usage 账单类消费方（/status、ACP usage_update 的 used 仅当轮可见历史总量）重启后归零，未单列归属 |
| 非 turn 来源记录 | session 域旁路 LLM 调用（sessionTitle、compaction summarize 等）经 `source?.type !== 'turn'` 也入 byModel 总量 | 只订 agent 的 `llm.streaming.usage`——旁路调用不经 agent 事件流，不计入 | 与 tokenCounting 问答前提②同源（旁路不落 agent 面）；总用量偏小，未单列归属 |
| 状态推送 | 每次 record 后 dispatch `AgentStatusUpdated { usage: UsageStatus }`（observable wire 事件，kap-server /status 消费）+ `onDidRecord`（带 firstRecord 标记） | 无 Feature 事件（响应式 ref 替代） | 推送语义不在范围；feature-acp 经 UsageRef 拉取已覆盖 ACP 场景 |
| UsageStatus 形状 | `{ byModel?, total?, currentTurn? }`（currentTurn 为当前轮累计） | `UsageSummary { total, byModel, byTurn }` | currentTurn 可由 `byTurn[currentTurnId]` 等价得出；形状差异见「新增」行 |
| prompt_cache_probe | `AgentCacheProbeService`：fork 子代理首个 turn 源 record 触发遥测 `prompt_cache_probe { source:'fork', … }`（cacheProbeService.ts） | 不迁 | 遥测批次待补（已知批次） |
| UsageError 域 | `UsageErrors.TURN_ID_CONFLICT` 注册（errors.ts） | 未迁 | v2 侧全仓无消费方（死代码），不迁无影响 |
| model 键粒度 | `byModel` 键为模型 id 字符串 | `byModel` 键为 `modelKey(LlmModel)`（含 provider 维度） | 粒度更细；消费方按 key 聚合时口径不同 |
| assertIssued | AgentContext 身份校验（防伪造上下文调用） | 无（无 AgentContext 概念） | 体系差异，无归属 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| `byTurn` 维度 | `UsageSummary.byTurn: Record<number, TokenUsage>` 逐轮累计——v2 只有 currentTurn 单轮视图，历史轮次用量不可查 |
| `records` 全量流水 | 每次上报的原始记录（usage/model/turnId/at）全量暴露，宿主可自建任意聚合（v2 只有折叠后的 byModel） |
| model 活读 | 跟随运行期 `setConfig` 模型切换（human 蓝本固定 model、v2 由调用方传入但 byModel 键仅是 id 字符串） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| config 节 / env / flag | 无 | 无 | 已对齐 |
| TokenUsage 字段 | `inputOther/output/inputCacheRead/inputCacheCreation` 四字段累加（partial 容错） | 逐字一致（usage.ts:20-28） | 已对齐 |
| UsageRecord 形状 | `{ usage, model?, turnId?, at }` | 逐字一致（蓝本移植） | 已对齐 |

## 工具 / 事件 / facade 面差异
- 工具：两侧均无工具。
- 事件：v2 durable `usage.record` + observable `AgentStatusUpdated{usage}`；harness-core 无事件（ref 替代）。
- facade：v2 `record`（写，由 requester 调）+ `status`（读）+ `onDidRecord`；harness-core `summary`/`records` 两 Ref（写由事件订阅内部完成）。`emptyUsageSummary`/`accumulateUsage` 经包出口可复用。

## 摘要
usage 的累加算法与记录形状与蓝本逐字一致，facade 已被 feature-acp（usage_update）与 goal（预算）两路真实消费。最大差异是持久化与推送：v2 的 byModel durable + AgentStatusUpdated 推送在 harness-core 全部落在内存 ref 上，重启即清零且无 wire 事件——蓝本因素导致的保真度损失。第二差异是非 turn 旁路调用不计入（与 tokenCounting 同源的架构前提）。byTurn 逐轮维度与 records 全量流水是超出 v2 的能力；prompt_cache_probe 与遥测属已知批次待补。
