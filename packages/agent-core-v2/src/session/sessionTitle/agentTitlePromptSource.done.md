# IAgentTitlePromptSource（agentTitlePromptSource）

- v2: `packages/agent-core-v2/src/session/sessionTitle/agentTitlePromptSource.ts`（约 28 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/kimi/sessionTitle/excerpt.ts`

## 能力对照

- [x] firstUserPrompts（取前 N 条自然语言用户输入）→ `packages/harness-core/src/features/kimi/sessionTitle/excerpt.ts`（`firstUserPromptTexts`，剥离 bundled skill 块并按 userMessageId 去重）
- [x] firstTurnExcerpt（首轮 user+assistant 摘录）→ 同文件 `firstTurnExcerpt`
- [x] digestExcerpt（多轮 digest 摘录）→ 同文件 `digestExcerpt` + `elideTitleDigestTurns`（预算内省略中段）
- [x] agent 级 prompt source 门面 → `packages/harness-core/src/features/kimi/sessionTitle/feature.ts`（`SessionTitlePromptSourceRef.compose` 按 source 组合摘录）
- [x] 敏感信息清洗（密钥/token 打码）→ 同文件 `sanitizeExcerptText`（v2 实现同款规则）

## 结论

全部对齐。
