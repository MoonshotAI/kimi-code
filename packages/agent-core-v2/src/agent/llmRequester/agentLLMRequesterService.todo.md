# IAgentLLMRequesterService（agentLLMRequesterService）

- v2: `packages/agent-core-v2/src/agent/llmRequester/llmRequester.ts`（约 95 行，读 interface 与 llmRequesterService.ts 得出）
- 新架构: `packages/agent-core/src/llm/requester.ts` + `packages/agent-core/src/loop/requester.ts`

## 能力对照

- [x] 发起/流式 LLM 请求（request/start，overrides 覆盖 messages/tools/systemPrompt/maxOutputSize，onPart 流式回调，signal 中止）→ `packages/agent-core/src/llm/requester.ts` 的 `LlmRequester.with/generate`（run 控制见 `packages/agent-core/src/llm/policy/policy.ts` 的 LlmRunControl.onEvent）；副作用请求由 `packages/agent-core/src/loop/requester.ts` 的 facade 自动带活历史与配置。重试回调由 retry/recovery 事件承载（职责转移 refact-168 完成）
- [x] 按 turn 解析思考档位（prepareTurnConfig → thinkingEffort）→ `packages/agent-core/src/llm/request.ts` 的 thinking 维度与 `packages/harness-core/src/features/provider-catalog/thinking.ts`
- [x] 凭据供给（currentCredentialProvider/credentialProviderForTurn）→ `packages/agent-core/src/llm/request.ts` 的 LlmCredentialProvider 与 `packages/agent-core/src/llm/builtin/policy/credentials.ts`（静态/OAuth 刷新），OAuth 由 `packages/harness-core/src/features/kimi/oauth/` 供给；按 turn 快照 pinning 未保留（runtime 体系决策不迁的一部分）
- [x] 请求 trace（AgentLLMRequestTask.trace 关联遥测跨度）→ `packages/harness-core/src/features/kimi/trace/feature.ts`（TraceRef 经 `llm.streaming.headers`/失败头捕获 x-trace-id）；请求级哈希（systemPromptHash/toolsHash/thinkingEffort）由 `packages/agent-core/src/llm/policy/policy.ts` 的 `llmStartedEvent` 携带
- [ ] lastTurnRequest() 上一轮请求快照查询（modelAlias/contextRevision/hashes/inputTokens/起止时间）— v2 供 usage 展示与 cacheProbeService 缓存探测；新栈只有事件流没有可查询快照访问器，contextRevision 随 prefixRevision 一并未迁，记录在案

## 结论

未对齐 1 项——请求发起、流式、思考档位、凭据、trace 已对齐到 agent-core llm 层；lastTurnRequest 快照访问器（含缓存探测）未迁。
