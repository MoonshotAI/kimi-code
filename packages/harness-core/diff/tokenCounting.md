# tokenCounting：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/tokenCounting/`（207 行：tokenCounting.ts 94 / feature.ts 72 / configSection.ts 38 / index.ts 3）
- agent-core-v2：`src/features/tokenCounting/`（15 行 Feature 壳）+ `src/agent/tokenCounting/`（448 行：agentTokenCountingService.ts 236 / tokenCountingOps.ts 146 / configSection.ts 50 / tokenCounting.ts 16）+ `src/session/tokenCounting/`（43 行接口）
- 蓝本关系：以 v2 DI 版为蓝本（第 41 轮迁移）；锚点载体按用户 2026-09-29 定稿改为 message meta（约束问答 tokenCounting 条目）。非 refact-237 第一批域。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 锚点载体 | 独立 durable anchor state：`tokenCountingKey { anchors, tokens }` + 四事件流（`token_counting.measured/truncated/rebased/turn_recorded`），fold 时更新并 emit `AgentStatusUpdated{contextTokens}`（tokenCountingOps.ts:95-146） | 无 durable state：实测锚 = 最后一条带 `meta.usage` 且 `grandTotal > 0` 的 assistant entry（锚 length = i+1；tokenCounting.ts:30-41）；锚随 journal durable，undo/compaction 切割自维护 | 用户 2026-09-29 定稿（约束问答 tokenCounting 条目：锚点与 usage 同载体，不建 v2 式独立 anchor state；两个一致性前提经代码核查成立） |
| compaction rebase | compaction 显式 `rebase({ measured: false })` 重置锚 | 零改动：compaction seed 只保留 user entries，带 usage 的 assistant entries 不进新分支——等价 `rebase(measured:false)` 的自动版 | 同上前提前提①（compaction/shape.ts `isKeptUserEntry`） |
| 锚身份校验 | `measured()` 前 `matchesContext(input, context)` 逐元素引用相等校验（agentTokenCountingService.ts:221-227） | 无校验（不需要） | 同上前提前提②：assistant entries 只由本 agent turn 机的全上下文请求写入，旁路 LLM 调用不落 history |
| 空锚门 | 无（durable 事件只在真实上报时写） | 锚判定加 `grandTotal > 0` 门（tokenCounting.ts:37） | 第 41 轮偏差①（机器曾恒写全零 meta.usage 会遮蔽真锚）；第 43 轮机器恒写已去除（abort/无上报轮次不再写），门保留防 provider 上报全零，与 `usedContextTokens` 既有口径一致 |
| status 出口 | 每次锚 fold 变化 emit `AgentStatusUpdated { contextTokens }`（observable wire 事件，kap-server/vis 消费） | `TokenCountingRef.status: ShallowRef<number>`——挂载初始化 + `AgentStoreRef.onCommit` 过滤 `turn.ended` 重算；undo/compaction 经宿主 remount 由挂载初始化覆盖 | 第 41 轮偏差②：`turn.ended` 是 journal 事件非 AgentEmitted，node.fire 只沿 lineage 上溯，feature 子节点收不到，改 onCommit 过滤（tower 先例），语义等价 |
| mirror contextTokens | v2 `mirrorAgentRun` 按子代理自身 strategy 的 statusSize | spawn/swarm mirror 用 `usedContextTokens`（默认 strategy 值） | 第 41 轮偏差③：避免 feature→feature import；需策略感知读时走 `TokenCountingRef` |
| facade 形态 | `ISessionTokenCountingService`（Agent 域 DI，get/measured/latestMeasured/statusSize/recordTruncation/rebase/requestSize + estimate 四件 + assertIssued 身份校验） | `TokenCountingRef`（`status` ref + get/statusSize/latestMeasured/requestSize）；写方法（measured/recordTruncation/rebase）无对应必要 | 第 41 轮；undo 第 34 轮 recordTruncation 接线遗留随锚自维护作废 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 每轮 durable 快照 | `token_counting.turn_recorded` 每轮结束钉一条非 measured 锚（length/tokens/turnId），kap-server/vis 投影逐轮 contextTokens 曲线 | 不迁 | 设计要点在案的保真度损失（消费方是 kap-server/vis 投影，不在范围）；逐轮曲线在新架构无从恢复 |
| AgentStatusUpdated 推送 | observable wire 事件逐次推送 contextTokens | 无 wire/Feature 事件（响应式 ref；feature-http `/status` 路由经 `TokenCountingRef.statusSize()` 已接线，route-features/status.ts:62） | 拉模型对齐 HTTP 消费方；kap-server 状态 API 的推送语义不在范围 |
| estimate 助手面 | service 暴露 `estimateText/estimateMessage/estimateMessages/estimateTools` | facade 只有 `requestSize`（estimate 家族在 agent-core `llm/usage.ts` 可用但未挂 facade） | 宿主可直接从 agent-core 导入；无归属 |
| requestSize 工具估算口径 | `estimateTokensForTools` 逐工具 `name + description + JSON(parameters)` 求和 | `estimateTextTokens(JSON.stringify(tools 整体))`（tokenCounting.ts:89） | 数值略差（JSON 结构开销归属不同）；两者均为启发式估算，无行为契约影响 |
| 消息估算缓存 | `estimateTokensForMessage` 经 WeakMap 缓存 | 无缓存逐次重算 | 纯性能差异 |
| **preset 接线** | v2 `registerFeature` 默认启用集（tokenCountingFeature.ts） | **已修复（2026-09-30）**：`src/preset.ts` features 数组已补回 `tokenCounting`（usage 后）。修复前代码事实是「有 import 无数组项」——与 Handoff 第 41 轮「preset 加 tokenCounting（usage 后）」及第 43 轮收口提交「preset 的 import + 数组项」记录不符，疑似共享工作区事故丢失（多例在案） | 修复前 preset 挂载形态下 `TokenCountingRef` 缺席，`/status` 的 tokens 回落 0 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `tokenCounting` 节 | zod `{ strategy: enum ['measured+estimated','measured','estimated'] }`，默认 `measured+estimated` | 逐字段一致（configSection.ts:13-21） | 已对齐 |
| env 绑定 | `KIMI_TOKEN_COUNTING_STRATEGY`（parse：trim + lowercase + 白名单） | 同名同 parse（configSection.ts:23-28） | 已对齐 |
| stripEnv | `stripEnvBoundFields` 派生 | `stripEnv: () => undefined`（cron 先例，效果相同：env 值不落盘） | 已对齐 |
| 注册位置 | 模块 import 时全局 `registerConfigSection` | agent slot `useConfigSection`（全仓首例；根节点贡献 + 按名去重，多 agent 安全，第 41 轮实证）+ `providerRef(ConfigRef)` 可选探测，config 缺席走默认 | 人为设计（config builtin 体系差异） |
| 三态 strategy 语义 | measured / estimated / measured+estimated（max(get.size, 末锚)） | 逐字一致（tokenCounting.ts:78-85；与 agent-core `usedContextTokens` 同语义） | 已对齐 |
| 历史切片 | `get(start?, end?)` 负下标归一 + measured/estimated 切分 | 逐字移植（tokenCounting.ts:51-72，与 v2 `getFrom` 同构） | 已对齐 |

## 工具 / 事件 / facade 面差异
- 工具：两侧均无工具。
- 事件：v2 四个 durable journal 事件 + `AgentStatusUpdated{contextTokens}` observable；harness-core 无任何事件（锚自维护、status 为 ref）。
- facade：读取面已对齐（get/statusSize/latestMeasured/requestSize + status ref）；写入面（measured/recordTruncation/rebase）按设计不迁；estimate 四件未挂 facade（见上表）。

## 摘要
tokenCounting 的读取语义（三态 strategy、历史切片、requestSize、config 节逐字段含 env 绑定）与 v2 完全对齐；锚点载体按用户定稿从「独立 durable 四事件流」改为「assistant entry meta.usage 扫锚」，使 undo 切割与 compaction rebase 全部自维护，是架构上更简的等价物。最重要的差异是 `turn_recorded` 每轮 durable 快照与 `AgentStatusUpdated` 推送通道不迁（记录在案的保真度损失，消费方在 kap-server/vis）。~~preset.ts 的 tokenCounting 数组项缺失~~ 已于 2026-09-30 补回（features 数组 usage 后），修复前 preset 形态下 facade 缺席、`/status` tokens 恒 0。
