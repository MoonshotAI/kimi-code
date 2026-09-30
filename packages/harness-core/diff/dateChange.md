# dateChange：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/dateChange/`（69 行：feature.ts 68 / index.ts 1）
- agent-core-v2：`src/features/dateChange/`（200 行：dateChangeService.ts 166 / dateChangeFeature.ts 14 / disclosureBaseline.ts 14 / dateChange.ts 6）
- 蓝本关系：以 v2 DI 版为蓝本（第一批迁移域之一，第 1 轮 `lsprmvsr`；顺序表 #3）。非 refact-237 第一批 human 蓝本域。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 注入机制 | reminder 总线 `register('date_change')`：每次 reconcile（gate）直接产出内容进下一请求；disclosure `{ kind:'date', renderGeneration, localDate, timeZone }` 由总线持久化追踪（lastDisclosure） | `useBeforeStep` 跨天检测 + `agent.remind` 同 key（`date-change`）覆盖；挂载时 `lastDisclosedDate` 扫历史同 key 消息、正则提取日期做 remount 去重（feature.ts:34/61-67） | 第 1 轮（`lsprmvsr`：useBeforeStep + remind 同 key + remount 历史扫描去重）；横切约定（remind 取代 reminder 总线，用户 2026-09-27 决策） |
| 时钟端口 | `IHostClock`（DI：`now()` + `timeZone()`） | 工厂 props `{ now?: () => Date, timeZone?: string }`，默认 `new Date()` + `Intl.DateTimeFormat().resolvedOptions().timeZone` | 第 1 轮（props 化；测试 seam 保留） |
| 日期格式化 | `Intl.DateTimeFormat('en-US', …)` formatToParts 拼 `yyyy-MM-dd` | 逐字一致（feature.ts:49-59，与 v2 currentDateDisclosure 同构） | 第 1 轮（逐字对齐） |
| Feature 形态 | `DateChangeFeature` contributeAgentService（registerFeature 默认启用集）；xstate actor（beforeRestore 门 + fromCallback 注册） | `createDateChange(props?)` agent tier 工厂，进 preset | 第 1 轮 `wknwlxtq` 接线（preset 进 btw/dateChange）；v2 默认启用集对齐 |
| 首次/变更文案 | 首次："Today's date is <d>. The current date is restated in a reminder whenever it changes; rely on the latest such reminder for the current date. DO NOT mention this to the user explicitly."；变更："The date has changed. Today's date is now <d>. Rely on this reminder over any earlier date statement …" | 逐字一致（feature.ts:19-25） | 第 1 轮（逐字对齐，已核对） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| cwd 归属门 | `belongsToCurrentCwd`：agent profile 的 `environmentDisclosure.cwd` 非空且 ≠ session cwd 时跳过注入（dateChangeService.ts:70-77）——cwd 不匹配的子代理不注日期 | 无此门：凡挂载 feature 的 agent（含 spawn 子代理）都注入 | cwd 不一致的子代理会收到按宿主时区渲染的日期提醒；第 1 轮未记录，属未在案的细节丢失；如需恢复可在 props 注入 cwd 判定 |
| renderGeneration 基线 | disclosure 带 profile `renderGeneration`，`pickDisclosureBaseline` 取 lastDisclosure 与 actor seed 的高代者做基线（disclosureBaseline.ts）——profile 重渲染后按新代重基线 | 无代际概念（只比对日期字符串） | profile 重渲染场景在新架构对应 remount（历史扫描重建），语义大体覆盖；影响极小 |
| 注入时机 | 总线在 gate 产出，下一请求即见 | remind 首次 drain 落账（晚一步；纯文本单步 turn 不带） | 横切机器语义（第 16 轮①同类：remind 只在 turn 经过 draining 时带入历史）；跨天恰好发生在纯文本 turn 时该轮不带日期 |
| actor seed 机制 | 首次注入前 actor 内存 seed 参与基线（disclosure 未持久化窗口） | 无（挂载时历史扫描 + 闭包 `disclosed` 变量等价覆盖） | 行为等价，无归属 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| （无） | 本域为对齐迁移，无超出 v2 的能力 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| config 节 / env / flag | 无 | 无 | 已对齐 |
| 时钟 | `IHostClock`（DI 端口） | props `now?` / `timeZone?` | 已对齐（端口形态不同，能力等价） |

## 工具 / 事件 / facade 面差异
- 工具：两侧均无工具。
- 事件：两侧均无 Feature 事件（v2 的 disclosure 是 reminder 总线内部状态，非事件面）。
- facade：两侧均无 facade（纯注入域）。

## 摘要
dateChange 的核心行为（跨天检测、首次/变更两文案、日期格式化、remount 去重、默认启用）与 v2 逐字对齐，69 行实现了 v2 200 行的等价语义（actor/总线样板被 useBeforeStep + remind 取代）。唯一实质保真度损失是 v2 的 cwd 归属门（profile environmentDisclosure.cwd ≠ session cwd 不注入）未迁且第 1 轮未记录——cwd 不一致的子代理会多收日期提醒；renderGeneration 代际基线随 profile 体系差异自然消解。注入时机晚一步为 remind 机器语义的固有特性（横切约定）。
