# ISessionTokenCountingService（sessionTokenCountingService）

- v2: `packages/agent-core-v2/src/session/tokenCounting/sessionTokenCounting.ts`（约 43 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/tokenCounting/tokenCounting.ts`

## 能力对照

- [x] get（区间上下文大小，measured+estimated 分解）→ `packages/harness-core/src/features/tokenCounting/tokenCounting.ts`（`get(history, start?, end?)`，锚点取自带 usage 的 assistant 消息 meta）
- [x] latestMeasured / statusSize / strategy 三态 → 同文件 `latestMeasured/statusSize`；facade 见 `packages/harness-core/src/features/tokenCounting/feature.ts`（`TokenCountingRef`，含 `status` 响应式切片与 config section）
- [x] requestSize（system prompt + tools + messages 估算）→ 同文件 `requestSize`
- [x] estimateText/estimateMessage(s)/estimateTools → `packages/agent-core/src/history/usage.ts`（`estimateTextTokens/estimateMessageTokens`；tools 经 `requestSize` 的 JSON 序列化估算）
- [x] measured 上报（实测 token 锚点）→ 结构承载：usage 由 loop 请求执行器写入 assistant 消息 meta（`packages/agent-core/src/loop/machine/request-actor.ts`），随日志持久化，重放即恢复，无需独立上报 API
- [x] recordTruncation/rebase（截断/变基后锚点校正）→ 结构承载：锚点从活历史投影派生，截断/压缩后自然重算

说明：v2 的独立 anchor 存储（四事件驱动）与 turn_recorded durable 快照不迁（记录在案）；对应能力由「锚点随 message meta + 投影派生」等价承载。

## 结论

全部对齐；独立 anchor 存储与快照机制被 message-meta 锚点结构性替代（机制不迁记录在案）。
