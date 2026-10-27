# llm 层替换 v2 human/llm + llm-adapter 迁移清单（migrate）

- v2: `packages/agent-core-v2/src/human/llm/`（`LlmRequester` 事件流契约 + 四家协议核心）与 `packages/agent-core-v2/src/llm-adapter/`（legacy 契约桥：错误类、`IModelCatalog` DI 面、config→catalog 同步）
- 新架构: `packages/agent-core/src/llm/`（平台无关契约 + 协议/政策/catalog）
- 已定方向：adapter 只做事件/错误翻译，v2 对外契约（A 事件词汇、B 抛出类、DI 服务）不变；retry 保留政策机制但 `maxAttemptsPerStep: 1`，由上层 turn 机器驱动；`StreamedMessagePart` 两侧逐字相同，流式事件可直接透传。

## adapter（v2 事件/错误翻译器）

- [ ] 5 个流式事件透传：`llm.streaming.headers` / `llm.streaming.part` / `llm.streaming.usage` / `llm.streaming.finish` / `llm.streaming.message_id`（同名同形；part 上的 `contentType`/`meta` 是 237 新增可选字段，v2 消费者忽略）

看怎么消除 attempt 这一层
- [ ] `attempt.sending` → `llm.sent`
- [ ] `attempt.failed` 按 `error.kind === 'syntax'` 分流 → `llm.failed.syntax` / `llm.failed.remote`，`rawError` 透传

这个发出来也没有问题吧
- [ ] 丢弃 `attempt.tool_call_end` / `llm.streaming.tool_call_end`（A 的 `createMessageAccumulator` 按 `_streamIndex` 自行缓冲工具调用，且 A 事件联合是封闭类型）


这个要改什么？
- [ ] settle/run 返回 `done` outcome 时合成 `llm.done`；`failed` 不再补发；`aborted` outcome 静默（对齐 v2 actor 吞 abort 的语义，`human/llm/requester/actor.ts:90`）


- [ ] 丢弃 `llm.notice`（A 无对应面；如接 telemetry 另议）
- [ ] 丢弃 `llm.started` / `llm.ended`（A 无消费者；`llm.ended` 的 outcome 仅用于驱动 adapter 终态合成）
- [ ] 错误映射：`auth` → `status`（保留 statusCode 401/403）。映射后 B 层零改动：`codeForStatusError` 推 `provider.auth_error`、`classifyApiError` 推 `auth`（`llm-adapter/contract/errors.ts:43,397`）
- [ ] status 类错误字段保真：`statusCode` / `message` / `requestId` / `retryAfterMs` / `headers` 原样传递，不改写 message——B 的 `isImageFormatError` / `isRecoverableRequestStructureError` / `isToolExchangeAdjacencyError` 是用 statusCode+message 重跑正则推导的；`headers` 必须留 `x-trace-id`（`traceIdFromHeadersRecord`）
- [ ] `LlmRequestConfig + LlmRequestContent` → `LlmRequest` 逐字段转换：`model` / `credentialProvider` / `systemPrompt` / `tools` / `cacheKey` / `thinking` / `responseFormat` / `maxCompletionTokens` / `maxContextTokens` / `extraParams` / `toolMessageConversion` 的落点
- [ ] retry 接线：`maxAttemptsPerStep: 1`。决策点：`recoveries` 放空（严格单次尝试）还是只放 `credentialsRecovery`——若放，必须同时摘掉 v2 `streamWithCredentialRecovery` / `runWithCredentialRecovery`，否则 401 双重刷新

## 行为对齐

- [ ] `UNKNOWN_CAPABILITY` 补回 `Symbol.for('moonshot-ai.kosong.UNKNOWN_CAPABILITY')` 标记：node-sdk 按该 symbol 比较，v2 两侧（`human/llm/capability.ts:10`、`llm-adapter/contract/capability.ts:14`）都带；当前 `src/llm/catalog/merge.ts:9` 是纯对象
- [ ] headers timeout / 代理胶水随替换带入：`KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` + proxy envs（http_proxy/HTTPS_PROXY/all_proxy/no_proxy、SOCKS 警告），237 在 `src/node/fetch.ts`，A 在 `human/llm/requester/timeout.ts`
- [ ] env 端点胶水带入：`OPENAI_API_KEY/OPENAI_BASE_URL`、`ANTHROPIC_*`、`GOOGLE_API_KEY/GOOGLE_GEMINI_BASE_URL`、`VERTEXAI_API_KEY/GOOGLE_VERTEX_BASE_URL`、`KIMI_API_KEY/KIMI_BASE_URL`，237 在 `src/node/env.ts`，A 在 `human/llm/provider/providers/standard.ts`
- [ ] catalog 语义决策：A 的 provider-catalog 是 discovered/override 双源合并（xstate 机器 + ping 队列），237 `llm/catalog` 是单向投影。替换 A catalog 前需对齐 refresh 行为（空结果处理、别名/额外字段保留），或本轮只换协议核心、保留 A catalog 不动
- [ ] models-dev 导入不在 237 llm 层（harness feature）：替换时保留 v2 `human/models-dev/` 与 `app/kosongConfig/modelsDevImportService`，或另安排迁移
- [ ] Kimi OAuth 流程 / managed discovery 不在 237 llm 层（harness `todo-features/kimi/oauth`）：保留 v2 `human/credentials/kimi-oauth.ts` + `app/kosongConfig` discovery，仅 credential-provider 接缝与 237 `createOAuthCredentialProvider` 对接

## 已核对无差异（记录在案，防重复核查）

- 错误 kind 除 `auth` 外 15 个一一对应；`LlmSyntaxErrorCode` 三值（`request_format`/`thinking_config`/`internal`）两侧相同；`LlmStatusErrorInfo` 四字段相同
- thinking-effort config hint 文案与 URL 去重守卫两侧一致（237 `protocol/rules/status.ts:120`，A `human/llm/errors.ts:198`）；HTML-title 清洗一致
- `empty_response` 判定位置从 turn 机器移到 237 settle：对 A 兼容，turn 的 done-判空路径自然不再触发，`isRetryableError` 对 `empty_response` 的分类不变
- `llm.streaming.message_id`：237 去重重复 id，A 逐 chunk 发；下游都取最后一次，无行为差
- `llm.request.retrying` 由 v2 `agent/loop/machine/requester.ts:86` 在 service 层重试时自发；turn 级 `llm.retrying` / `llm.recovering` 由 v2 turn 机器自发——两者都不经 adapter
- 若未来启用 237 政策循环发 `llm.retrying`：payload 与 A turn 级不同（237 带完整 `error` 对象，A 是扁平 `errorName`/`errorMessage`/`statusCode?`），届时需另行映射，不能按名字对换

## 验收

- [ ] v2 turn 机器 / `ModelRequesterImpl` / trace 插件（`x-trace-id`）/ klient / kap-server 行为不变
- [ ] v2 侧既有 llm 测试（`src/human/test/llm/`、`test/llm-adapter/`）全绿；测试总数不增加；comment-free
- [ ] B 层（`llm-adapter/contract/errors.ts` 等）零改动
