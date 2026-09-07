# llm 模块指南

llm 是 human 层内一个独立的 LLM 请求库（`src/human/llm/`），提供「一次 LLM 请求」的完整能力：多协议（openai / openai-responses / anthropic / google-genai）请求编解码、流式事件、thinking、媒体、错误分类、重试与恢复、provider 与模型目录管理。它不依赖也不感知任何外部 agent 框架，所有职责划分与扩展方式都遵循下述设计原则。

## 设计原则

1. **边界极简：llm = 「一次请求」**。llm 只负责请求编解码与事件回传。auth、usage 统计、HistoryMessage/meta、compaction、switch、媒体文件系统、Tool Message 拼装全部不属于 llm——要么上移到 turn/agent 层，要么以贡献点接入。
2. **流式原生、事件即契约**。对外只暴露一条纯可序列化的事件流（requester 层：`llm.sent / headers / delta / usage / finish / message-id / failed.syntax / failed.remote / done`；machine 层补充 `llm.retrying / llm.recovering`，`llm.sent` 携带最近一次 recovery 记录），流式与非流式同构（非流式也走流式累积，只是不发 delta）；事件收到即发，不缓存、不兜底。
3. **format 屏蔽协议间差异，trait 表达 provider 方言**。format 位于 protocol 层，负责请求、响应、错误、usage 和 finish 的编解码；trait 是 provider 附加的一包 hooks（endpoint、headers、convertMessage、buildParams、withThinking 等）。协议差异不允许泄漏到 machine 或 requester 的装饰层。
4. **错误两层模型**。内部 throw SDK 原生错误；本地请求校验抛共享的 `SyntaxRequestFormatError`（`llm/syntax-errors.ts`），由 requester 经 `toLlmSyntaxErrorMessage` 统一转换，不加中间层。对外只有 `llm.failed.syntax`（本地消息语法错误，不重试）与 `llm.failed.remote`（远程流式错误，细分为 connection/timeout/rate_limit/quota_exhausted/context_overflow/request_structure 等），由 format 在边界完成转换。
5. **无状态内核 + 状态机外壳**。`generate(config, content, control)` 是无状态函数，错误走 onEvent 不 throw；llm machine 包装单次请求（messageResolvers、abort 作用域、事件转发），并借助 retry.ts / recovery.ts 的纯策略函数驱动重试与 recovery：recovery 由纯函数 `propose` 产出替换消息直接重发（attempt 重置为 1），重试走 `retrying` 状态的 backoff（尊重 Retry-After），两者分别对外补发 `llm.recovering / llm.retrying` 事件；empty response 由 `withEmptyResponseGuard` 在 requester 边界判定并转为 `llm.failed.remote`，进入同一重试路径；abort 由 turn 持有的 AbortController 承载：controller 经 `LlmInput.signal` 传入 machine 与 request actor，turn 在 `turn.abort` 时直接 abort 它，请求随即以 `llm.failed.remote` 收尾；request actor 不自建 controller、回收时不触碰任何 signal，正常完成的请求绝不可能误 abort 共享 signal。累积器由 turn 持有并随事件流喂入，在 `llm.retrying / llm.recovering` 时 rollback 并重建，每次 attempt 从零累积，从而尽可能保留中断现场（turn 在 `llm.done` 时从累加器 finish 出完整消息）。
6. **不兜底**。配置是什么就是什么；beta 特性、thinking、empty response 等场景先定义明确报错条件，在请求阶段报错并引导用户修正，而不是静默兜底。
7. **一切可变能力都是贡献点**。provider、媒体上传/降级、usage、traceId、错误恢复（compaction/媒体降级）都通过扩展点接入，llm 内核不含这些概念。
8. **数据即数据**。model 是无函数的纯数据（endpoint url + model 唯一标识一个模型），可序列化、可直接作为 generate 输入；catalog 是 `provider -> models` 的派生缓存，依赖方向只能从 models-dev 指向 llm 内部，不能反向依赖。
9. **Message 转换用编译器范式**。通用 Message[] 到协议报文是 N:M 转换，用 MLIR 式 Pattern Rewriter：有序、独立的 Pattern 将 MessageRange 替换为 MessageRange，最后 lowering；toolMessageConversion、media 映射也是 Pattern。

## 架构

```
llm/
├── message.ts            通用 Message 模型（按 role 拆分；tool 声明独立）
├── model.ts              LlmModel：纯数据，provider+model+endpoint 覆盖
├── capability.ts / thinking.ts / usage.ts / finish-reason.ts / response-format.ts / syntax-errors.ts
├── errors.ts             LlmErrorKind 两层（syntax | remote 各细分 kind）
├── toolCallIdNormalizer.ts  流式 tool call id 去重：重复的 raw id 按序重映射为新 id
│
├── protocol/             协议通用层（跨基座共享）
│   ├── base.ts           ProtocolName / ProtocolBase
│   ├── format.ts         ProtocolFormat：formatRequest + createStreamParser(sink 回调)
│   ├── trait.ts          ProtocolTrait：provider 方言 hooks 全集
│   └── patterns.ts / rewrite.ts   MLIR 式 Pattern Rewriter（Message N:M 转换）
│
├── requester/
│   ├── requester.ts      LlmRequester.generate(config, content, control)；
│   │                     ExtraParams 按协议带类型 {openai?, responses?, anthropic?, googleGenai?}
│   ├── machine.ts        llm 状态机（单次请求 + 重试/恢复 + empty response 判定；
│   │                     对外补发 llm.retrying / llm.recovering）
│   ├── retry.ts / recovery.ts   重试/恢复策略纯函数（由 llm machine 驱动；propose 为纯函数）
│   ├── empty-response.ts withEmptyResponseGuard：finish 时判定空响应并转为 llm.failed.remote
│   └── bases/            四个协议基座：openai / openai-responses / anthropic / google-genai
│                         各自含 format / lower / patterns / capability / extra-params / requester
│
├── provider/
│   ├── definition.ts     ProviderDefinition{id, protocols{base+trait}, media, models}
│   │                     createProvider()（无 registry）→ Provider{listModels, resolveModel, createRequester}
│   └── providers/        standard 等内建 provider（经贡献点注册）
│
├── provider-catalog.ts   xstate 状态机：refresh/upsert/remove/ping 输入，changed 输出；
│                         provider -> models 结构；远程 pulled 与本地 models 双真相源
│
└── media/                媒体贡献点：cache / degrade / ref / resolver / store / upload
```

请求生命周期：`generate` 收到 (config, content, control) → format 将通用 Message[] 经 Pattern Rewriter 降低为协议 requestParam → internalGenerate 调用官方 SDK → 流式 chunk 经无状态 parser 回调转换为 `llm.delta/usage/finish/message-id` 事件 → 错误由 format 转换为 `llm.failed.*`；成功时 requester 发出 `llm.done`，失败时以 `llm.failed.syntax / llm.failed.remote` 收尾、不再发 `llm.done`。`withEmptyResponseGuard` 在 finish 时判定空响应并转为 `llm.failed.remote`；llm machine 对 `llm.failed.remote` 先尝试 recovery（纯函数 `propose` 产出替换消息，发 `llm.recovering`），再按策略 backoff 重试（尊重 Retry-After，发 `llm.retrying`），耗尽后才以 failed 终态收尾。上层的 turn 持有 HistoryAccumulator 随事件流累积，在 `llm.retrying / llm.recovering` 时 rollback 并重建累加器，`llm.done` 时 finish 出完整消息；usage 统计、trace、compaction、媒体降级均以插件/贡献点身份挂接在事件流上。

## 已被否决的方案（不要再引入）

- 拆分 llmActor / llmStreamActor 两个 actor —— 单一 machine，非流式也走流式累积。
- DDD 领域方法包装（Generation Domain 等）—— 用 format/trait/provider 分层。
- 函数式 `toWireMessage` / `WireAdapter` 命名 —— adapter interface，命名中不出现 Wire。
- Provider registry / `defineProvider` —— `createProvider` 导出 const。
- 出站时把 system 消息 hoisting 出原位 —— system 消息留在历史原位转换。
- llm 输出 `{message, meta}` 的 Context 对象 —— meta 归 turn 领域，llm 只发事件。
- 在 llm 与 turn 各实现一次 accumulator —— accumulator 只由 turn 持有，随事件流喂入。
- beta 特性无限兜底 —— 协议拆分为 `anthropic` / `anthropic_beta`，不传就不发，传错就报错；需要 beta 特性的 provider 必须显式使用 `anthropic_beta` 协议。
