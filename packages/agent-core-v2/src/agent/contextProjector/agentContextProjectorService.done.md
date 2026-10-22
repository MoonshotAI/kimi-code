# IAgentContextProjectorService（agentContextProjectorService）

- v2: `packages/agent-core-v2/src/agent/contextProjector/contextProjector.ts`（约 30 行，读 interface 与 projection.ts/mediaProjection.ts 得出）
- 新架构: `packages/agent-core/src/history/message.ts`（toRequestMessages）+ `packages/agent-core/src/llm/builtin/policy/structure.ts`、`media-degrade.ts`

## 能力对照

- [x] 上下文消息 → 线协议消息的投影（tool 结果配对/渲染）→ `packages/agent-core/src/history/message.ts` 的 `toRequestMessages` 与 `renderToolResultForModel`
- [x] 结构修复与异常上报（重排/合成/孤儿丢弃/重复丢弃/合并连续 assistant/丢空白与空消息，anomaly 汇总）→ `packages/agent-core/src/llm/builtin/policy/structure.ts`（LlmRecovery，经 LlmNoticeSink 上报；新栈另有前提：调用方保证历史语义不变量，核心不修复，见 agent-core 包原则）
- [x] 媒体降级（仅保留最近 N 个活体媒体，旧媒体以占位文本替代）→ `packages/agent-core/src/llm/builtin/policy/media-degrade.ts` 的 `degradeOlderMediaParts`（同为 keepRecent=2），占位文案在 `packages/agent-core/src/llm/message.ts`
- [x] 媒体剥离（协议不兼容时整体 strip）与剥离快照（captureMediaStripSnapshot）→ `media-degrade.ts` 的 `'stripped'` 标记与 `captureMediaKeys`
- [x] 媒体可经路径重读（v2 的 mediaPaths 路径标注）→ 新栈由媒体投递工具按路径读取承载：`packages/harness-core/src/features/media/deliver/tool.ts`

## 结论

全部对齐——投影、结构修复、媒体降级/剥离三族能力均落在 agent-core history 与 llm policy 层，结构从服务变为请求管线 recovery。
