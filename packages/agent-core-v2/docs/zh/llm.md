# llm 模块指南

llm 是 human 层内独立的 LLM 请求库（`src/human/llm/`），负责一次完整请求：类型化请求契约、协议编解码、流式事实、thinking、媒体、错误分类以及政策驱动的 attempt。v2 兼容 requester、provider catalog、媒体存储和 turn 编排位于相邻模块，不再混入核心。

## 设计原则

1. **最小边界：llm = 「单次请求」**。核心通过 `createRequester().with(...)` 组合请求，并由 `generate` 返回 `LlmOutcome`。v2 A 事件 requester、catalog 刷新状态、usage 记账、HistoryMessage/meta、compaction、switch、媒体文件系统和 Tool Message 组装都不在核心内。
2. **流式优先；outcome 与事件各司其职**。核心执行返回 `done / failed / aborted` 的 `LlmOutcome`，同时按到达顺序发出运行与流式事件。`src/human/llm-requester/` 的 A 边界继续暴露既有封闭事件联合（`llm.sent`、streaming headers/part/usage/finish/message_id、failed syntax/remote、request retrying 和 done）。核心额外的 notice、started/ended、retry 和 tool-call-end 不加入该联合。流式与非流式共用解码器：`stream: false` 使用 `send`，再把完整响应经同一解码器 replay。
3. **pipeline 屏蔽协议差异；协议补丁表达供应商定制**。每个协议都是 `defineProtocol` 对象（`src/human/llm/protocol/protocol.ts`）：`runPipeline` 组合编码阶段（cacheKey → thinking → responseFormat → maxOutputTokens → sampling → tool → message → mergeTurns → annotate → finalize → flatten），前置 legalize 处理媒体、工具调用 id、供应商 pattern、thinking 历史和模型规则。协议同时提供流式 decoder、非流式 replay、错误 decoder 以及 client/send/sendStream 传输。供应商经 `protocol.with(patch)` 派生协议；Kimi 位于 `src/human/llm/builtin/provider/kimi/protocol.ts`。endpoint/env 解析、默认头和 A 的 `classifyError` 选项属于外层 requester/adapter。
4. **两层错误模型**。本地校验抛出 `llm/protocol/errors.ts` 的 `SyntaxRequestFormatError`，由 `toLlmSyntaxErrorMessage` 转换。A 边界用 `llm.failed.syntax` 表示本地消息错误，用 `llm.failed.remote` 表示远端失败，并保留 status 字段、原始错误、request id 和协议提供的错误诊断。协议可通过可选 `diagnoseError` 从当前 attempt 提取供应商专属信息，不再对外暴露通用 `traceId`。核心错误在边界转换为 A 错误联合；failed 不会同时补发 done。
5. **无状态核心 + Loop 持有编排**。核心 requester 是 protocol、endpoint、model、profile、content 和 policy 各维度的不可变组合。`ProtocolAdapterRegistry` 为每次请求初始化核心实例，`AgentLoopService` 是 Agent 级请求门面的唯一长期持有者。其他 Agent Service 通过 `loopService.requester` 发起 side request、读取凭据、上传能力和请求快照，不再注入另一套 requester Service。`generateModel` 以一次退避 attempt 和已注册的 recovery 执行核心 policy；结构投影、媒体解析及其 recovery 都通过已注册 policy 在每个 attempt 内运行，凭据恢复和外层重试仍由 turn 机器与 Loop 驱动。settle 累积流式 parts、判定空响应、记录计时，在每次实际发送时发出中性的 `llm.sent`，并合成 outcome。abort 仍以 kind 为 `abort` 的 `llm.failed.remote` 发出，原因保真。turn 持有面向用户的累积器，并在重试/恢复时重置。
6. **不做静默回退**。配置严格按给定使用；不支持的 beta 特性、thinking 配置、媒体和空响应会明确失败，不会暗中切换行为。迁移不会顺带启用更严格的工具历史校验、清理或重排，main 的既有历史处理策略保持不变。
7. **一切可变能力都是贡献点**。协议补丁、媒体上传/降级、usage、协议错误诊断和恢复策略围绕核心接入。核心不引用 A requester、v2 DI、models-dev 或 catalog 状态。
8. **数据即数据**。`LlmModelSpec` 和 `LlmRequest` 都是可序列化的核心契约。核心消息沿用既有 `imageUrl/audioUrl/videoUrl` 媒体 part；data URL、`kimi-file://` 会话引用和上传后的 `ms://` 文件 id 都保留在这些 part 中。`ModelCatalog` 只负责模型与供应商元数据和默认模型选择，不缓存 requester，也不提供 generate/ping。上传能力由 `LlmEndpoint.files` 声明，媒体 resolver 从 Loop 接收模型与已初始化的 requester。`SessionMediaStore.put` 保存 bytes 与元数据并返回 `kimi-file://` 引用，`get` 负责读回。ReadMediaFile 只生成引用；Media Resolver 在下一次请求中根据本次模型、协议媒体能力、endpoint files 与 endpoint 凭据恢复完成物化。v2 历史与外部 wire 的消息形状保留在 `src/human/message.ts`；codec 只处理 role 与 envelope，不再引入第二套媒体表示。
9. **消息转换用编译器范式**。通用消息经有序、独立的 pattern 和最终 lowering 转成协议载荷；工具消息转换与媒体映射也是 pattern。main 的工具结果占位、reasoning details 和各供应商特有 wire 行为继续由既有测试约束。

## 架构

```
human/
├── message.ts                 v2 历史/外部 wire Message 模型与累积器
│
├── llm/                       单次请求核心
│   ├── message.ts             核心 Message 与既有媒体 part 模型
│   ├── request.ts             model、endpoint、protocol、profile、content、policy 维度
│   ├── response.ts            运行/流式事件、LlmOutcome、usage、计时与 notice
│   ├── endpoint.ts            凭据感知的 endpoint 解析
│   ├── requester.ts           createRequester + 不可变 .with() 组合 + generate
│   ├── generate.ts            attempt 驱动：encode → client → send/sendStream（+replay）→ decode
│   ├── policy/                attempt 循环、settle、retry、recovery、resolver 与 registry
│   ├── protocol/              defineProtocol、pipeline、pattern、共享规则与协议工具
│   └── builtin/
│       ├── protocol/          openai / openai-responses / anthropic / google-genai 实现
│       ├── provider/          核心 requester 预设，包括 builtin/provider/kimi
│       └── policy/            内置恢复政策，包括媒体降级
│
├── llm-requester/             v2 A requester 与平台兼容层
│   ├── requester.ts           封闭 A 事件联合、config/content/control 与协议名
│   ├── run.ts                 v2 A 事件/错误 + .with() 请求 + outcome → A 事件
│   ├── factories.ts           基于核心 requester 预设的具名 A 工厂与 env connection
│   ├── actor.ts               供 turn 使用的单请求 actor
│   ├── retry.ts / recovery.ts turn 驱动的重试与恢复政策
│   └── timeout.ts             headers 超时与代理 fetch 胶水
│
├── provider-catalog/
│   ├── catalog.ts             refresh/upsert/remove/ping 状态机与双源模型合并
│   └── provider/providers/    以核心 requester 预设为后端的 catalog handle
│
└── media/                     媒体缓存、ref、resolver、store、上传与 Kimi 上传
```

宿主组合位于 `agent/loop/` 与 `llm-adapter/`：`requester.ts`、`projector.ts` 和 `projection.ts` 是随 Loop 构造的普通对象，不再是 scoped Service。`llm-adapter/model/generate.ts` 把核心 outcome 转成既有 `ModelRequestEvent` 传输词汇，不保留 `ModelRequester` 对象。

请求生命周期：Loop 解析 turn 或 side request 的配置与上下文 → `ProtocolAdapterRegistry` 用 protocol、model、endpoint、凭据头、超时 fetch 和可选 `LlmEndpoint.files` 初始化核心 requester → `generateModel` 叠加 profile/content，并携带 ToolSelect/媒体工具/结构/媒体 resolver 与 recovery ledger 执行 `runLlmRequest` → 每个 attempt 先应用继承和新提出的重写，再依次执行 ToolSelect、媒体工具、结构与媒体 resolver，然后发出 `llm.started` 并记录 resolved request → 协议 legalize/pipeline 编码并过滤 deferred 工具 → client 使用 `sendStream`，非流式则 `send` + replay → settle 产生 outcome 与流式事实 → Loop 或 klient 边界发出既有事件词汇。ReadMediaFile 始终注册且只生成 `kimi-file` 引用；模型同时不支持图片和视频时，媒体工具 resolver 隐藏其 schema、调用与结果，媒体 resolver 再把引用转换为模型能力提示、上传后的 file-id 或内联 base64。full compaction、cache probe 和媒体工具共用同一 Loop 门面；klient direct-generate 只创建调用级核心 requester，公开契约不变。

动态工具披露只决定请求视图，不是执行权限。Agent 在 MCP 初始化后持久化一份不可变的初始注册表快照，并按顺序保存运行期变更；后续请求把实时注册表协调进这份账本，不再重建初始快照。支持动态加载的模型从当前版本投影，通过 deferred 工具、added/removed 公告和 SelectTools 经 `loop.remind` 写入的 schema system message 获取定义。loaded 状态要求精确匹配当前 schema 版本，因此同名修改会作废旧选择并以 remove+add 触发重选。不支持动态加载的模型只使用初始顶层工具，初始 deferred 仅在 Resolver 副本上提升为普通工具，运行期新增版本继续过滤，变更保留为文字 system-reminder，而不是动态 schema 或 select 指令。模型切换不会改写持久化快照、变更账本或 context history；显式 tools override 保持不变。

## 已否决方案（勿重新引入）

- `ModelRequester` 包装、scoped `AgentLLMRequesterService` / `AgentContextProjectorService`，或经 `IModelCatalog` 获取 requester——核心组合负责初始化，Loop 持有 Agent 门面，Catalog 只负责元数据。
- 把请求 actor 拆成 llmActor / llmStreamActor——一次请求一个 actor；非流式同样在流上累积。
- 用专门的 llm 状态机包装请求 actor——turn 直接调用 actor 并持有重试/恢复。
- DDD 领域方法包装（Generation Domain 等）——使用 pipeline/protocol/provider 分层。
- 传给 requester 工厂的按请求 trait 钩子对象——供应商定制属于 `protocol.with(patch)` 组合。
- 把定制以闭包绑进 format——供应商补丁协议 spec，而不是包装 requester。
- 第二套 `ProviderDefinition` / `Provider.createRequester()` 路由——内置供应商是核心 requester 预设，catalog 经 `CatalogProviderHandle` 组合。
- 把 request adapter 留在 `llm/` 内——v2 事件、env connection、catalog 状态和平台胶水都属于相邻模块。
- 出站时把 system 消息从原位提出来——system 消息在历史中原位保留、原位转换。
- llm 发 `{message, meta}` Context 对象——meta 属于 turn 域。
- 在 llm 内实现面向用户的累积器——settle 只为自身 outcome 累积；turn 持有外部消息累积器。
- beta 特性无限回退——协议显式选择，`betaApi` 仍由 options/model 显式启用。
