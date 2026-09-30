# timing：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/timing/`（120 行：feature.ts 118 / index.ts 2）
- agent-core-v2：`src/human/timing/`（124 行：plugin.ts，旧蓝本）；**v2 DI 侧无对应物**——`src/agent` / `src/features` 下无 timing 域，DI 体系里唯一的 ttft 痕迹是 `agent/llmRequester/llmRequesterService.ts:828` 的遥测字段 `ttftMs`（取自 requester 内部 `firstTokenLatencyMs`，非本域机制）
- 蓝本关系：refact-237 第一批域，以 human/timing/plugin.ts 为蓝本近乎逐字移植。v2 DI 版不存在，差异以 human 蓝本为对照。

## 行为差异
### 人为设计
| 差异点 | v2（human 蓝本）行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 工具终局事件订阅 | 订 `tool.done` + `tool.failed` + `tool.aborted` 三个 mark（plugin.ts:50-52） | 只订 `tool.done`（feature.ts:50） | 第 26 轮 tool 终局事件合一（failed/aborted 并入 `tool.done{outcome}`），mark 语义等价覆盖 |
| 出口形态 | plugin 实例方法 `timing(): LlmRequestTiming | undefined` | `TimingRef` facade（`timing: Ref<LlmRequestTiming | undefined>` 响应式 Ref） | 新架构 useExpose 范式（usage 同款先例） |
| Feature 形态 | human Plugin（`createTimingPlugin`，connect 接线） | `createFeature('timing', { agent })`，进 preset | refact-237 第 73 轮第一批 |

### 简化 / 保真度损失
| 差异点 | v2（human 蓝本）行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 时钟注入 | `createTimingPlugin({ now? })` 可注入时钟（测试 seam） | 硬编 `const now = Date.now`（feature.ts:21），无 props | 测试只能用真实时钟/fake timers；影响小，未单列归属 |
| 遥测关联 | v2 DI 的 ttft 经 `llmRequesterService` 进遥测事件（prompt 计时字段） | 无遥测接线（TimingRef 仅内存读取面） | 遥测批次待补（已知批次）；v2 human 蓝本本身也无遥测 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| 响应式出口 | Ref 形态可直接 watch（蓝本的 `timing()` 方法只能轮询读取） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| config 节 / env / flag | 无 | 无 | 已对齐 |
| 时钟 props | `now?: () => number` | 无（Date.now 硬编） | 简化（见上表） |

## 工具 / 事件 / facade 面差异
- 工具：两侧均无工具。
- 事件：两侧均无 Feature 事件（纯读取面）。
- facade：蓝本 `timing()` 方法 → harness-core `TimingRef.timing` Ref；数据形状 `LlmRequestTiming` 六字段（`requestBuildMs?` / `ttftMs` / `serverFirstTokenMs` / `streamDurationMs` / `serverDecodeMs` / `clientConsumeMs`）逐字对齐。
- 算法：事件窗口机（turn.started 重置 retryAnchor、llm.sent 开窗、llm.streaming.part 累计 serverDecode/clientConsume、llm.done 结算、llm.retrying 记 retryAnchor 补偿 attempt 起点、llm.recovering/failed.syntax/failed.remote 重置）逐字对齐，含 `Math.max(0, …)` 下限与 retryAnchor `at + delayMs` 补偿式。

## 摘要
timing 是 9 个域里差异最小的一个：计时算法、六字段形状、retry 补偿逻辑与 human 蓝本逐字一致，唯一的行为面变化是 tool 终局事件三合一下订阅从三个 mark 收敛为一个（语义等价）。v2 DI 侧本无此域，属 human 蓝本独有的产品能力迁移。唯一缺口是时钟不可注入（测试 seam 丢失）与遥测未接线；TimingRef 的响应式 Ref 出口相对蓝本的轮询方法略有增强。
