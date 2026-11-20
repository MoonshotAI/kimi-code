# llm 模块指南

llm 是 `@moonshot-ai/core` 内独立的 LLM 请求库（`packages/core/src/llm/`），负责一次完整请求：类型化请求契约、协议编解码、流式事实、thinking、媒体、错误分类以及政策驱动的 attempt。provider catalog 状态、媒体存储、OAuth 和 turn 编排留在 agent-core-v2，但调用方直接传递 core 请求与结果类型，不再经过 adapter。

## 设计原则

1. **最小边界：llm = 「单次请求」**。核心通过 `createRequester().with(...)` 组合请求，并由 `generate` 返回 `LlmOutcome`。请求内容直接使用带可选 `MessageAttributes` 的 `Message`，随行属性在 resolver 与 legalize 阶段全程保留，仅在最终转换为 `NativeModule` 时一次收敛（同时完成工具错误与空输出状态渲染）；返回结果包含带真实 model、usage、finish 等 `attributes` 的 `AssistantMessage`。catalog 刷新状态、session 用量台账、compaction、switch、媒体文件系统和 turn 编排都不在核心内，也不存在外层 `HistoryEntry` 包装、第二套 requester 或兼容事件协议。
2. **流式优先；outcome 与事件各司其职**。核心执行返回 `done / failed / aborted` 的 `LlmOutcome`，同时按到达顺序发出 `LlmRunEvent`。完成、失败、中断和重试 partial 输出共用 `AssistantMessage` 构造；retry 事件中的 partial 仅用于诊断和流式重置，不写入历史，Loop 只把最终 outcome message 追加到历史，无需重建模型元数据。`streamLlmRequest` 把同一事件联合以 `AsyncIterable` 暴露给 transport，最终以携带 outcome 的 `llm.ended` 收尾。流式与非流式共用解码器：`stream: false` 使用 `send`，再把完整响应经同一解码器 replay。事件词汇统一为 `llm.started / requested / queued / notice / delta.* / retry / ended`；生成失败直接返回，tool-call 边界使用 decoder 回调，不再使用 `attempt.*` 事件。
3. **pipeline 屏蔽协议差异；协议补丁表达供应商定制**。每个协议都是 `defineProtocol` 对象（`packages/core/src/llm/protocol/protocol.ts`）：`runPipeline` 组合编码阶段（cacheKey → thinking → responseFormat → maxOutputTokens → sampling → tool → message → mergeTurns → annotate → finalize → flatten），前置 legalize 处理媒体、工具调用 id、供应商 pattern、thinking 历史和模型规则。协议同时提供流式 decoder、非流式 replay、错误 decoder 以及 client/send/sendStream 传输。供应商经 `protocol.with(patch)` 派生协议；Kimi 位于 `packages/core/src/llm/builtin/provider/kimi/protocol.ts`。endpoint 声明和环境变量回退统一由 `packages/core/src/llm/endpoint.ts` 解析。
4. **两层错误模型**。本地校验抛出 `llm/protocol/errors.ts` 的 `SyntaxRequestFormatError`，由 `toLlmSyntaxErrorMessage` 转换。协议与传输失败形成 failed `LlmOutcome` 中的 `LlmErrorMessage`，保留 status 字段、原始错误、request id 和协议诊断。协议可通过可选 `diagnoseError` 从当前 attempt 提取供应商专属信息，不再对外暴露通用 `traceId`。调用方直接消费 core 错误值，不再经过第二套错误联合。
5. **不可变配置 + 作用域内执行记忆**。核心 requester 是 protocol、endpoint、model、profile、content 和 policy 各维度的不可变组合；派生 requester 共享含可复用 recovery 条目的 execution，每次 generate 恢复独立 ledger，保证并发调用相互隔离。普通 Turn 与旁路 operation 复用这些条目，Loop reset 成功后清理它们，避免 Undo 或历史替换继承旧重写。`AgentRequesterBinder` 创建或刷新不可变快照时由 `ProviderCatalogService.createRequester` 初始化配置，`AgentLoopService` 持有 Loop 及其 execution。`requester` getter 直接暴露原始 `loop.requester`，其他 Agent Service 通过 `operationRequester(loopService.requester, ...)` 发起 side request，不再注入另一套 requester Service。结构投影、媒体解析及其 recovery 都通过已注册 policy 在每个 attempt 内运行，外层重试仍由 turn 机器与 Loop 驱动，凭据恢复使用 core 共享 policy。settle 持有 attempt 级消息累积器、发出规范化流式 parts、使用解析后的工具描述（包括 deferred 项）校验完整 tool-call 参数、判定空响应、记录计时，在每个 attempt 入口发出带旧版请求摘要的 `llm.requested`，并合成 outcome。参数非法时以 `invalid_tool_arguments` 重试且不执行调用；下一次 attempt 只携带临时 system 校验提醒，不携带被拒绝的调用，该提醒不会写入会话 journal。每次重试/恢复都会创建新的累积器；Loop 使用最终 outcome message 写入完成或中断历史，不再维护另一份累积器。
6. **不做静默回退**。配置严格按给定使用；不支持的 beta 特性、thinking 配置、媒体和空响应会明确失败，不会暗中切换行为。参数校验只覆盖新完成的 tool-call，既有会话历史保持原来的编码与回放行为。只有解析后的 schema 接受 `{}` 时，空参数才按无参数调用处理。
7. **一切可变能力都是贡献点**。协议补丁、媒体上传/降级、usage、协议错误诊断和恢复策略围绕核心接入。核心不引用 v2 DI、models-dev 或 catalog 状态。
8. **数据即数据**。`LlmModelSpec` 和 `LlmRequest` 都是可序列化的核心契约。核心消息沿用既有 `imageUrl/audioUrl/videoUrl` 媒体 part；data URL、`kimi-file://` 会话引用和上传后的 `ms://` 文件 id 都保留在这些 part 中。`ProviderCatalogService` 负责模型与供应商配置记录、catalog 元数据和默认模型选择；它统一初始化 requester，但不缓存 requester，也不提供 generate/ping。上传能力由 `LlmEndpoint.files` 声明，媒体 resolver 从 Loop 接收模型与已初始化的 requester。`SessionMediaStore.put` 保存 bytes 与元数据并返回 `kimi-file://` 引用，`get` 负责读回。ReadMediaFile 只生成引用；Media Resolver 在下一次请求中根据本次模型、协议媒体能力、endpoint files 与 endpoint 凭据恢复完成物化。v2 历史与外部 wire 的消息形状保留在 `src/human/message.ts`；codec 只处理 role 与 envelope，不再引入第二套媒体表示。
9. **消息转换用编译器范式**。通用消息经有序、独立的 pattern 和最终 lowering 转成协议载荷；工具消息转换与媒体映射也是 pattern。main 的工具结果占位、reasoning details 和各供应商特有 wire 行为继续由既有测试约束。

## 架构

```
packages/core/src/llm/
├── message.ts                 核心 Message 与既有媒体 part 模型
├── request.ts                 model、endpoint、protocol、profile、content、policy 维度
├── response.ts                运行/流式事件、LlmOutcome、计时与 notice
├── usage.ts                   TokenUsage、流式 patch 合并与计数算术
├── endpoint.ts                endpoint 声明、环境变量回退与凭据解析
├── requester.ts               createRequester + 不可变 .with() 组合 + generate
├── stream.ts                  面向 transport 的 LlmRunEvent AsyncIterable
├── thinking.ts                共享 thinking 校验与 effort 解析
├── generate.ts                attempt 驱动：encode → client → send/sendStream（+replay）→ decode
├── policy/                    attempt 循环、settle、retry、recovery、resolver 与凭据恢复
├── protocol/                  defineProtocol、pipeline、pattern、共享规则与协议工具
├── transport/                 headers 超时与代理感知 fetch
└── builtin/
    ├── protocol/              openai / openai-responses / anthropic / google-genai 实现
    ├── provider/              核心 requester 预设，包括 builtin/provider/kimi
    └── policy/                内置恢复政策，包括媒体降级

packages/agent-core-v2/src/human/
├── message.ts                 v2 历史/外部 wire Message 模型与累积器
├── provider-catalog/          refresh/upsert/remove 状态机与双源模型合并
└── media/                     媒体缓存、ref、resolver、store、上传与 Kimi 上传

packages/agent-core-v2/src/provider-catalog/
├── providerCatalogService.ts  App 作用域的配置、catalog、协议与 requester Service
├── configuration-store.ts     模型与供应商共享的记录存储及变更事件
├── model/                     记录类型、runtime 投影 helper、OAuth/model auth 与预算
├── provider/                  provider 记录类型与 core requester 预设
├── protocol/                  capability/identity 元数据与 provider 错误域
├── requester.ts               requester 路由 helper
├── errors.ts                  provider 错误与 core 错误转换
└── capability.ts              legacy capability 转换

packages/agent-core-v2/src/agent/loop/
├── requesterBinder.ts         不可变 Profile/config/requester 快照
├── loopService.ts             raw requester 与 Turn/Operation 透明装饰器
└── requestObservation.ts      request trace、usage、事件与 telemetry
```

宿主组合位于 `agent/loop/` 与 `provider-catalog/`：`loopService.ts`、`projector.ts` 和 `projection.ts` 是随 Loop 构造的普通对象，不是 scoped Service。唯一的 App 作用域 `ProviderCatalogService` 负责模型与供应商配置 CRUD 及变更事件、catalog 查询与 runtime 投影、协议 capability/identity/base-id/supported-protocol 元数据，并通过 `createRequester` 统一初始化 core requester。`AgentRequesterBinder` 把同一个 Service 与 Profile、model、completion budget 和 execution 快照组合起来。profile、Loop 和 klient 直接传递 `LlmRequestPart`、完整 `LlmRequest`、`LlmRunEvent` 和 `LlmOutcome`，不经过翻译层。

请求生命周期：`AgentRequesterBinder` 解析不可变 Turn 或 operation 快照，并携带 protocol、model、endpoint、凭据头、超时 fetch、可选 `LlmEndpoint.files` 与 Agent 作用域 execution 调用 `ProviderCatalogService.createRequester` → 普通 Turn 在 Turn 快照点装饰原始 base，旁路 operation 则把原始 `loop.requester` 交给 `operationRequester` 组合 policy 与透明观测 → 每个 Step 提供 `Message` content、profile 和 policy，并只执行一次 `generate`；`runLlmRequest` 根据最终 profile 计算 usedTokens，并从 requester memory 恢复 generate 局部 recovery ledger → 每个 attempt 先应用继承和新提出的重写，再依次执行 ToolSelect、媒体工具、结构与媒体 resolver，在 run 入口发出一次 `llm.started`，随后在每个 attempt 入口发出 `llm.requested` 并记录 resolved request → 协议 legalize/pipeline 编码；非动态模型仅移除 `deferred` 元数据，所有工具声明继续参与转换 → client 使用 `sendStream`，非流式则 `send` + replay → settle 产生 outcome 与流式事实 → Loop 或 klient 消费同一套 `LlmRunEvent`，klient 直接使用 `streamLlmRequest`。ReadMediaFile 始终注册且只生成 `kimi-file` 引用；模型同时不支持图片和视频时，媒体工具 resolver 隐藏其 schema、调用与结果，媒体 resolver 再把引用转换为模型能力提示、上传后的 file-id 或内联 base64。full compaction 与 prompt prediction 共用同一 raw requester 和 Operation 装饰器，request trace、usage 与 telemetry 统一归 Loop 观测。

动态工具披露只决定请求视图，不是执行权限。最终 `legalize-tools` 阶段优先保留顶层声明（同名取最后一项），再从最新到最旧扫描 system message；每个重名工具聚合发出一条 `llm.notice` 和一条 warn 日志。即使工具数组因此变空，这一阶段也不会删除 system message，空消息清理由其他 pipeline 负责。Agent 在 MCP 初始化后持久化初始注册表快照，并按顺序保存运行期变更；后续请求把实时注册表协调进这份账本，不再重建初始快照。支持动态加载的模型会由 ToolSelect Resolver 从解析后的顶层工具列表中移除 deferred 项，并把 Loop baseline 中的 deferred 名称转换为投影消息开头的初始工具变更 snapshot。step reminder provider 只发送后续 added/removed delta，并根据上一次投影的公告折叠变化；history revision 变化后不再使用旧投影。SelectTools 再把选中的 schema 通过 `loop.remind` 写入 system message。loaded 状态要求精确匹配 active schema 版本。同名修改会让 active schema 和执行器在当前运行会话内保持不动，并在每个服务实例内只发送一次 reminder，而不是替换选择或发出 remove+add。普通 compact 和模型切换不会应用更新；新会话使用重新构建的注册表。不支持动态加载的模型保留请求里的顶层工具。Resolver 移除 `select_tools` 和 system tool schema，并去掉 `deferred` 元数据；`legalize` 保留同样的清理，作为绕过 ToolSelect 的请求入口的边界保障。运行期新增的工具不会被抄进 `tool[]`，名字变化仍以文字 reminder 保留。模型切换不会改写持久化快照、变更账本或 context history；显式 tools override 保持不变。

## 已否决方案（勿重新引入）

- `ModelRequester` 包装、scoped `AgentLLMRequesterService` / `AgentContextProjectorService`，或独立的 catalog/requester 门面——`ProviderCatalogService` 负责初始化，Loop 持有 raw requester 与 execution，human catalog 只负责刷新状态与元数据。
- 把请求 actor 拆成 llmActor / llmStreamActor——一次请求一个 actor；非流式同样在流上累积。
- 用专门的 llm 状态机包装请求 actor——turn 直接调用 actor 并持有重试/恢复。
- DDD 领域方法包装（Generation Domain 等）——使用 pipeline/protocol/provider 分层。
- 传给 requester 工厂的按请求 trait 钩子对象——供应商定制属于 `protocol.with(patch)` 组合。
- 把定制以闭包绑进 format——供应商补丁协议 spec，而不是包装 requester。
- 第二套 `ProviderDefinition` / `Provider.createRequester()` 路由——内置供应商仍是 core requester 预设数据，`ProviderCatalogService.createRequester` 在同一处完成组合。
- 与 `llm/` 平行的第二套 requester 或 request adapter——调用方直接使用 core 请求、事件、outcome 和错误类型。
- 出站时把 system 消息从原位提出来——system 消息在历史中原位保留、原位转换。
- llm 发 `{message, meta}` Context 对象——meta 属于 turn 域。
- 在 Loop/turn 内维护第二份消息累积器——settle 持有 attempt 级累积器与规范化流，Loop 只消费其事件和最终 outcome。
- beta 特性无限回退——协议显式选择，`betaApi` 仍由 options/model 显式启用。
