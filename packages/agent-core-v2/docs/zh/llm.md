# llm 模块指南

llm 是 human 层内独立的 LLM 请求库（`src/human/llm/`），提供「单次 LLM 请求」的完整能力：多协议（openai / openai-responses / anthropic / google-genai）的请求编码/解码、流式事件、thinking、媒体、错误分类、重试与恢复、供应商/模型目录管理。它不依赖、也不感知任何外部 agent 框架；所有职责边界与扩展机制遵循以下设计原则。

## 设计原则

1. **最小边界：llm = 「单次请求」**。llm 只处理请求编解码与事件发射。auth、usage 记账、HistoryMessage/meta、compaction、switch、媒体文件系统、Tool Message 组装都在边界之外——要么上移到 turn/agent 层，要么作为贡献点接入。
2. **流式优先；事件即契约**。对外唯一表面是一条纯可序列化的事件流（requester 级：`llm.sent / streaming.headers / streaming.part / streaming.usage / streaming.finish / streaming.message_id / failed.syntax / failed.remote / done`，外加调用方在 turn 之下重试单个 attempt、需要丢弃已流式状态时发出的 `llm.request.retrying`；turn 级再加 `llm.retrying / llm.recovering`，且 `llm.sent` 携带最近一次恢复记录）。流式与非流式同构（非流式同样在流上累积，只是没有增量——`stream: false` 把完整响应经同一解码器 replay）。事件到达即发——不缓存、不回退。
3. **pipeline 屏蔽协议间差异；协议补丁表达供应商定制**。每个协议核心都是 `defineProtocol` 对象（`src/human/llm/protocol/protocol.ts`）：由 `runPipeline` 按 `PipelineSpec` 组合 `encode`（阶段：cacheKey → thinking → responseFormat → maxOutputTokens → sampling → tool → message → mergeTurns → annotate → finalize → flatten，前置 `legalize` 各 pass：media → relocate → tool-call-ids → patterns → thinking-history → model）；流式 `decoder` 把原始 chunk 转成中立 sink 回调；`replay` 服务非流式；`decodeError`；以及 `client`/`send`/`sendStream` 传输。定制是穿越 spec 的数据流：供应商经 `protocol.with(patch)` 派生自己的协议（`src/human/llm-kimi/protocol.ts` 的 kimi 是范例），覆盖阶段（`thinking`、`tool`、`message`、`legality`、`flatten`、`decoder`……）而不是包装 requester。endpoint/env 解析与默认头构成 provider `connection`；错误分类是 requester 选项（`classifyError`，hook 优先）；模型 capability 是 base 字段——它们都不是 pipeline 的事。协议差异不得泄漏到 turn 或 requester 装饰器。
4. **两层错误模型**。内部抛 SDK 原生错误；本地请求校验抛共享的 `SyntaxRequestFormatError`（`llm/syntax-errors.ts`），经 `toLlmSyntaxErrorMessage` 统一转换，无中间层。对外只有 `llm.failed.syntax`（本地消息语法错误，永不重试）与 `llm.failed.remote`（远端流式错误，细分 connection / timeout / rate_limit / quota_exhausted / context_overflow / request_structure 等），在边界由协议的 `decodeError` 转换。
5. **无状态核心 + turn 驱动编排**。`generate(config, content, control)` 是无状态函数；错误经 onEvent 投递，从不抛出。A 词汇 requester 接缝（`llm/requester/run.ts`）以 `maxAttemptsPerStep: 1`、无 recoveries 的政策驱动运行循环（`llm/policy/policy.ts` → `settleLlmRequest`），每次调用恰好一次 attempt，政策机制保持惰性；turn 机器经 retry.ts / recovery.ts 的纯政策函数驱动重试与恢复：恢复是调用方组合的策略链（引擎先试 `credentialsRecovery`，再试配置的替换消息策略如媒体降级）；每个策略的纯 `propose` 返回自描述记录（`strategy`/`action`、可选替换 `attemptMessageOverride`、可选不透明 `beforeNextAttempt` 效果）——turn 执行 `beforeNextAttempt` 和/或替换消息并以 attempt 重置为 1 重新进入 `thinking`；override 在同一步的后续重试中持续生效，直到被替换或在下一步前清除；重试在 `retrying` 状态退避（尊重 Retry-After），turn 分别发出 `llm.recovering / llm.retrying`。settle 阶段累积流式 parts 并自行判定空响应，接缝将这类请求以 `llm.failed.remote` 结束且前置没有 `llm.done`；turn 自己的 done 路径空判因此不再触发，而 `emptyResponseError` 仍导出供直接消费者使用。abort 由 turn 持有的 AbortController 承载：控制器经 `LlmInput.signal` 传入请求 actor，turn 在 `turn.abort` 时直接中止它，请求以 kind 为 `abort` 的 `llm.failed.remote` 结束；请求 actor 既不自建控制器、也不在拆除时触碰任何信号，已完成的请求永远不会中止共享信号。累积器由 turn 持有、由事件流喂入；在 `llm.retrying / llm.recovering / llm.request.retrying` 时 turn 回滚并重建它，因此每个 attempt 从零累积，同时尽量保留被中断的状态（turn 在 `llm.done` 时由累积器完成完整消息）。被中断 attempt 已转发给父机或 UI 的 parts 不回收；只有累积器与工具调用 id 归一器重置。
6. **不做静默回退**。配置严格按给定使用。beta 特性、thinking、空响应等场景，先定义明确的错误条件，在请求时失败，并引导用户修正配置——永不静默回退。
7. **一切可变能力都是贡献点**。供应商（经 `protocol.with`）、媒体上传/降级、usage、traceId、错误恢复（compaction / 媒体降级）都经扩展点接入；llm 核心不含这些概念。
8. **数据即数据**。model 是纯的、无函数的数据（endpoint url + model 唯一标识一个模型），可序列化、可直接作为 generate 输入。catalog 是派生的 `provider -> models` 缓存；依赖方向只允许从 models-dev 进入 llm 内部，绝不反向。
9. **消息转换用编译器范式**。把通用 Message[] 转成协议载荷是 N:M 映射，用 MLIR 式 Pattern Rewriter 完成：有序、独立的 Pattern 各自把一个 MessageRange 重写为另一个 MessageRange，最后做终态 lowering。toolMessageConversion 与媒体映射也是 Pattern。

## 架构

```
llm/
├── message.ts            通用 Message 模型（按 role 拆分；工具声明独立）
├── model.ts              LlmModel：纯数据，provider+model+endpoint 覆盖
├── capability.ts / thinking.ts / usage.ts / finish-reason.ts / response-format.ts / syntax-errors.ts
├── errors.ts             两层 LlmErrorKind（syntax | remote，各自细分）
├── toolCallIdNormalizer.ts  流式工具调用 id 去重：重复的原始 id 按序重映射
│
├── request.ts            核心请求契约：LlmModelSpec、LlmRequestModel、LlmSampling、
│                         LlmCredential(Provider)、LlmEndpoint、LlmProtocolBinding（base+options+stream）、
│                         LlmRequestProfile/Content、LlmRequest
├── response.ts           运行级类型：LlmStreamEvent、LlmSentEvent、LlmRetrying、LlmTiming、
│                         LlmOutput、LlmOutcome、LlmNotice
├── endpoint.ts           ResolvedEndpoint + resolveEndpoint（凭据按 attempt 解析）
├── generate.ts           attempt 驱动：encode → client → send/sendStream（+replay）→ decoder；
│                         发出 attempt.sending / streaming.* / attempt.failed
├── policy/
│   ├── policy.ts         runLlmRequest：attempt 循环（resolvers、recoveries 账本、
│   │                     退避重试）——由接缝接线为单 attempt
│   ├── settle.ts         单次 attempt 的结算：累积、空响应判定、计时、outcome 合成
│   │                     （done / failed / aborted）
│   ├── recovery.ts       纯恢复策略 + 账本（propose/record/apply）
│   └── resolver.ts       政策驱动的消息解析端口 MessageResolver
│
├── protocol/             共享协议层（各 base 通用）
│   ├── protocol.ts       Protocol / ProtocolDefinition / DefinedProtocol / defineProtocol（.with）、
│   │                     DecodeSink/Decoder、ProtocolReply
│   ├── pipeline.ts       PipelineSpec 阶段 + runPipeline + NativeModule
│   ├── rules/            legalize 各 pass：media、model（legality/clamp/严格 effort）、
│   │                     tool-call-ids、index（pass 顺序）
│   ├── kit/              http（requestIdFromHeader）/ params（withExtras）
│   ├── base.ts           ProtocolName / ProtocolBase / ProtocolRequesterOptions
│   ├── connection.ts     ProviderConnection：endpoint env 声明 + 默认头
│   └── rewrite.ts / patterns.ts   MLIR 式 Pattern Rewriter（消息 N:M 转换）
│
├── requester/
│   ├── requester.ts      LlmRequester.generate(config, content, control)——A 词汇接缝
│   │                     （LlmRequestEvent 封闭联合；config 增加 stream?: boolean）；
│   │                     ExtraParams 按协议分型 {openai?, responses?, anthropic?, googleGenai?}；
│   │                     LlmRequestConfig.credentialProvider：凭据贡献点
│   │                     （resolve/canRecover/invalidate），由调用方按 attempt 解析；
│   │                     工厂与 credentialsRecovery 策略在 human/credentials
│   │                     （createStaticCredentialProvider / createOAuthCredentialProvider；
│   │                     createKimiOAuthCredentialProvider 适配 Kimi OAuth token）；
│   │                     面向直接调用方的 runWithCredentialRecovery /
│   │                     streamWithCredentialRecovery 执行器在 llm-adapter/model/credential-recovery
│   ├── run.ts            接缝：config+content → LlmRequest，政策 maxAttemptsPerStep:1，
│   │                     运行循环事件 → A 词汇，outcome → llm.done / llm.failed.* /
│   │                     abort 转 remote；每次 attempt 构造 headers 超时 fetch
│   ├── actor.ts          请求 actor：包装单次请求的 fromCallback
│   │                     （messageResolvers、abort 域、事件 sendBack）；由 turn 调用
│   ├── retry.ts / recovery.ts   纯重试/恢复政策函数（由 turn 机器驱动；propose 为纯函数）
│   ├── empty-response.ts emptyResponseError：纯空响应判定（settle 在源头应用；
│   │                     turn 保留用于自身检查）
│   └── bases/            四个协议 base：openai / openai-responses / anthropic / google-genai
│                         各含 decode / legalize / lower / protocol（defineProtocol 对象：
│                         client/send/sendStream/replay/decodeError）、capability、extra-params、
│                         contract（wire 类型），以及基于 createRunRequester 的薄 requester.ts 接缝工厂
│
├── provider/
│   ├── definition.ts     ProviderDefinition{id, protocols{base+connection+classifyError+capability}, media, models}
│   │                     createProvider()（无注册表）→ Provider{listModels, resolveModel, createRequester}
│   └── providers/        内置 provider 如 standard（经贡献点注册）
│
├── provider-catalog.ts   xstate 机器：refresh/upsert/remove/ping 入，changed 出；
│                         provider -> models 结构；远端拉取与本地模型双数据源
│
└── media/                媒体贡献点：cache / degrade / ref / resolver / store / upload
```

请求生命周期：`generate` 接收 (config, content, control) → 调用方在每个 attempt 前把 `config.credentialProvider` 解析为带完整凭据的模型（机器路径上的请求 actor），因此请求始终携带新鲜凭据，凭据刷新恢复（可恢复 401 → `credentials.invalidate()`，以 strategy `credentials` 发出 `llm.recovering`）在重发时自然重新解析（状态机之外的直接调用方——ping、generate、full compaction、媒体上传——经 `runWithCredentialRecovery` / `streamWithCredentialRecovery` 共享同一条单次重试恢复）→ 接缝构建 `LlmRequest`（由解析后模型得到 model spec，由 systemPrompt+tools 得到 profile，政策单 attempt，endpoint 携带静态凭据与按 attempt 构造的 headers 超时 fetch）→ `runLlmRequest` → `settleLlmRequest` → attempt 驱动 `generate.ts` 经协议 pipeline 编码（`legalize` 各 pass 归一媒体、工具调用 id、供应商 pattern、thinking 历史与模型 legality；`runPipeline` 再经 spec 的 `message` 阶段 lowering 消息、转换工具、合并 turn、标注缓存、finalize 并 flatten 参数——kimi 的协议补丁在这一层替换或包装个别阶段）→ `client` + `sendStream`（`stream: false` 时 `send` + `replay`）→ 流式 chunk 解码为 `llm.streaming.part / streaming.usage / streaming.finish / streaming.message_id` 事件 → 错误经 `decodeError` 转成 `llm.failed.*`；settle 阶段累积 parts、计时，并合成 outcome：`done`（→ `llm.done`）、`failed`（→ `llm.failed.syntax / llm.failed.remote`，其后绝不跟 `llm.done`）、`aborted`（→ kind 为 `abort` 的 `llm.failed.remote`）。turn 持有 HistoryAccumulator，由事件流喂入，在 `llm.retrying / llm.recovering / llm.request.retrying` 时回滚重建，并在 `llm.done` 完成完整消息；usage 记账、追踪、compaction、媒体降级都以插件/贡献点挂在事件流上。

## 已否决方案（勿重新引入）

- 把请求 actor 拆成 llmActor / llmStreamActor——一次请求一个 actor；非流式同样在流上累积。
- 用专门的 llm 状态机包装请求 actor——turn 机器直接调用 actor 并持有重试/恢复；额外机器层没有任何被消费的状态。
- DDD 领域方法包装（Generation Domain 等）——用 pipeline/protocol/provider 分层。
- 传给 requester 工厂的按请求 trait 钩子对象（旧的 OpenAITrait/AnthropicTrait/… 接缝）——供应商定制属于 `protocol.with(patch)` 组合；trait 袋让被协议忽略的钩子静默失效，也模糊了每个行为归属哪个阶段。
- 把定制以闭包绑进 format（`createOpenAIFormat(trait)`，或把钩子作为 formatRequest 选项传入）——pipeline 显式交替纯阶段；供应商补丁 spec，而非 requester。
- 函数式 `toWireMessage` / `WireAdapter` 命名——用 adapter 接口；名字里不出现 "Wire"。
- provider 注册表 / `defineProvider`——`createProvider` 导出常量。
- 出站时把 system 消息从原位提出来——system 消息在历史中原位保留、原位转换。
- llm 发 `{message, meta}` Context 对象——meta 属于 turn 域；llm 只发事件。
- 在 llm 与 turn 各实现一份累积器——累积器只由 turn 持有、由事件流喂入（settle 内部的累积器只服务 outcome 合成）。
- beta 特性无限回退——协议经 `betaApi` 选项区分 `anthropic` / `anthropic_beta`；未声明即不发送，配错即报错；需要 beta 特性的 provider 必须显式使用 beta API。
