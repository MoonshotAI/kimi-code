# AgentLoopRequester 职责清单

用于逐项决定职责归属。当前只记录代码现状，不预设新的归属。

主要实现：`packages/agent-core-v2/src/agent/loop/requester.ts`
对外合约：`packages/agent-core-v2/src/agent/loop/requesterContract.ts`

## 一、实例与公开入口

1. **依赖组装与状态注册**（`requester.ts:162-191`）
   - 注入 context、profile、model、catalog、protocol registry、media、usage、telemetry 等 17 个依赖。
   - 创建 `AgentLoopProjector`。
   - 注册 5 个 state key：请求 trace、配置日志签名、turn 配置、媒体恢复、thinking 警告。

2. **Turn 请求配置冻结**（`requester.ts:209-213`、`786-805`）
   - `prepareTurnConfig()` 为 turn 固化模型上下文、请求参数和 system prompt。
   - 后续 step 使用同一份快照，并清理旧 turn 配置。
   - 返回 thinking effort 给 LoopService 做 telemetry；无 provider 时返回 `undefined`。

3. **凭证提供器查询**（`requester.ts:215-224`）
   - `currentCredentialProvider()` 按当前模型取凭证。
   - `credentialProviderForTurn()` 优先按 turn 冻结的模型取凭证。
   - 当前消费方是 machine 的 credential recovery 和 full compaction。

4. **视频上传**（`requester.ts:230-241`）
   - 根据当前模型初始化 core requester。
   - 调用上传能力，在外层执行 credential recovery，返回视频 URL part。

   **讨论结论：迁移到 MediaService + Resolver，Loop 不再持有上传或媒体解析职责**
   - 本方案同时覆盖第 13 项“媒体解析与物化”；ownership 方向已确认，上传缓存、媒体预算、display path/placeholder 等具体功能去留后续逐项讨论。
   - MediaService 对外提供 OSS-like 接口：`put(file)` 保存 bytes、MIME、filename 等并返回 `kimi-file://...`；`get(kimi-file)` 返回文件内容和元数据，大文件可另外提供 stream/open。
   - ReadMediaFile、MCP、用户附件等媒体生产者只调用 `put()` 并生成包含 `kimi-file` 的 message part，不在生产时上传，也不再注入 `videoUploader`。
   - MediaService 初始化时注册 Resolver。Resolver 识别消息中的 `kimi-file` part，通过 `get()` 读取文件，根据本次 `request.model` 和 protocol media support 决定上传、inline 或 placeholder，并在上传成功后替换原 part。
   - 上传直接调用 `request.endpoint.files.upload()`，先通过 `resolveEndpoint(request.endpoint)` 获取本次 endpoint 和凭证；不给 Loop 或 core requester 新增 `uploadVideo()` 方法。
   - Credential recovery 留在 Resolver：上传鉴权失败时通过 `endpoint.credentials.canRecover/invalidate` 使凭证失效，重新解析 endpoint 后重试。参考 237 `agent-core/src/llm/builtin/policy/store-ref/resolve.ts` 与 `materialize.ts`。
   - 目标删除：LoopRequester 的 `uploadVideo()` 及 contract、AgentLoopRequester 的 `mediaResolver.resolve()` 调用、`AgentMediaResolution { model, requester }`、mediaToolsRegistrar 对 Loop requester 上传方法的绑定，以及 ReadMediaFileTool 的 `videoUploader` 参数。
   - 明确的行为变化：ReadMediaFile 从“工具执行时立即上传”改为“下一次 LLM 请求时按需上传”；上传错误和 `video_upload` telemetry 随之上移到 Resolve 阶段。Resolver 需要保留或逐项重新决定 auth、unsupported、inline fallback、上传缓存、媒体预算和 placeholder 的语义。

5. **请求任务创建与便捷入口**（`requester.ts:243-296`、`919-925`）
   - `start()` 创建可变 trace handle，立即启动请求并返回 `{ trace, result }`。
   - `request()` 只是等待 `start().result`。
   - 当前生产代码没有直接调用 `request()`，实际请求入口都是 `start()`。

## 二、请求解析与组装

6. **模型与 Profile 配置解析**（`requester.ts:738-746`、`786-789`）
   - turn 请求读取冻结配置，side request 读取当前 profile。
   - 根据 model alias 从 catalog 取得模型。

7. **输出 Token 预算计算**（`requester.ts:746-767`）
   - 综合 `maxOutputSize`、全局 `maxCompletionTokens` cap、模型能力和已用 context tokens。
   - 计算 completion budget，处理 cap `<= 0` 的禁用语义，并合并进请求参数。

8. **请求输入的默认值与覆盖**（`requester.ts:769-783`）
   - 决定 messages、system prompt、tools、source 等输入。
   - 优先使用 overrides，否则读取 live context、turn 快照或 profile。
   - 复制 messages/tools，记录 context revision 和日志字段。

9. **Core Requester 初始化**（`requester.ts:771`）
   - 调用 `protocolRegistry.request(model, params)`。
   - 把协议、模型、endpoint、采样参数等组装成真正的 core `LlmRequester`。

10. **默认工具列表构造**（`requester.ts:907-916`、`952-959`）
    - 从 tool registry 取工具，经 `toolSelect.shapeTools()` 变形。
    - 补默认空 JSON Schema，保留 deferred 标记。
    - 提供日志和持久化使用的 provider-visible 工具过滤及工具签名。

    **讨论方案：通过 Resolver 处理（方向可行，具体功能去留待后续逐项讨论）**
    - 由 `toolSelect` 领域提供 Agent 侧 Resolver，LoopService 初始化 requester 时负责注册；Resolver 本体不放进 core 通用协议层。
    - 初始化时只注册 Resolver，不提前计算或缓存工具列表；每次 `resolve()` 时重新读取 tool registry、本次请求模型、tool-select flag、loaded/pending tools 和历史消息。
    - 保留默认工具与显式 override 的区别：`request.profile.tools` 缺省时才从 registry 构造默认工具；调用方显式提供 tools 时不能用 registry 重建或覆盖。当前 `generateModel` 的必填 `input.tools` 需要相应保留缺省语义。
    - dynamic tool load 的判断必须基于本次 `request.model`，同时检查 `dynamically_loaded_tools`、`tool_use` 和 tool-select flag，不能继续只读当前 profile 的 `toolSelect.enabled()`，避免 turn 冻结模型与当前 profile 不一致。
    - Resolver 还需要合并 protocol 推断能力；复用或抽取与 `withProtocolCapabilities()` 相同的有效能力解析逻辑。
    - 工具列表和 `shapeHistory()` 应在同一个 Resolver 中处理，共享同一次 disclosure 决策：
      - 不支持 dynamic load：工具按普通 inline 工具发送，移除 `select_tools`，清理历史中的动态工具 Schema 和公告。
      - 支持 dynamic load：未加载工具不发送，静态工具和 `select_tools` 保留，已加载工具保留 deferred 语义，并清理历史中已失效的工具 Schema。
    - `providerVisibleTools()` 和 `toolSignature()` 可继续作为观测用纯函数，但必须消费 Resolver 处理后的 tools。需要同步处理当前 `llm.started` 在 Resolver 前发出、adapter `onAttempt` 只回填 resolved messages 而未回填 resolved tools 的顺序问题，保证实际发送与日志、持久化 hash 一致。
    - deferred 的最终 wire 过滤仍留在 core pipeline，不在 Resolver 中重复实现。

11. **历史消息变形**（`requester.ts:366`）
    - 在投影之前调用 `toolSelect.shapeHistory()`，根据工具选择策略处理请求历史。

## 三、Projection 与媒体

12. **请求投影执行**（`requester.ts:383-402`）
    - 根据当前 policy 选择普通或 strict projection。
    - 需要媒体降级或剥离时解析 display paths。
    - 调用 `AgentLoopProjector.project()` 生成最终待发送消息。

    **讨论结论：普通投影走 Resolver，strict/media fallback 走 Recovery，全部隐藏在 LLM policy 内**
    - 本方案同时覆盖第 28 项“Projection Fallback 决策”；具体修复和观测功能的去留后续继续讨论。
    - 首次普通 `project()` 由结构 Resolver 执行。Recovery 只在远端请求失败后触发，不能用 Recovery 代替首次投影。
    - `projectStrict()` 改为 structure Recovery：遇到 `request_structure` 时返回 request rewrite，并通过 `appliedRecoveries` 保证 strict 只应用一次。参考 237 `agent-core/src/llm/builtin/policy/structure.ts`。
    - 媒体降级和剥离继续使用现有 `createMediaDegradeRecovery()`，不再由 Loop 手工选择媒体恢复策略。
    - Loop 只在初始化时注册策略，不再直接调用 `this.projector.project()`，不再保存或切换 `strict` 状态，也不在 catch 中手工执行 strict fallback。
    - 观测通过现有 `llm.retrying` 的 `strategy/action` 和 `onAttempt` 的 resolved request 完成；projection 日志、修复统计和 telemetry 不依赖对外暴露 Projector。
    - 当前 projection 依赖 `ContextMessage` 和 Agent tool-result rendering，不能原样搬进平台无关的 `human/llm`。实施时应改成只消费 core `Message` 后进入 `human/llm/builtin/policy`，或由 `llm-adapter` 提供 Agent 专属 Resolver/Recovery，core 只负责调用。

13. **媒体解析与物化**（`requester.ts:403-411`）
    - 调用 `mediaResolver.resolve()`，把投影后的媒体引用解析成 provider 可接受的输入。
    - 传入当前模型、core requester 和 abort signal。

14. **媒体恢复状态记忆**（`requester.ts:367-381`、`717-735`）
    - 捕获媒体 strip snapshot 或 degrade count。
    - 按“model alias + context revision”保存和复用恢复策略。
    - 只有 turn 请求会写入该状态。

15. **媒体降级后的用户警告**（`requester.ts:396-431`）
    - 比较前后媒体数量。
    - 确认重试确实丢弃媒体后，通过 `WarningIssued` 发出“媒体已降级”或“媒体已剥离”警告。

16. **Anthropic thinking effort 校验与去重警告**（`requester.ts:433`、`682-715`）
    - 检查配置的 effort 是否出现在模型声明的支持列表中。
    - 未列出时同时写日志和发 `WarningIssued`。
    - 按模型、effort、支持列表组合去重。

## 四、请求记录与执行

17. **请求日志与配置变更去重**（`requester.ts:434-447`、`807-834`）
    - 记录 provider、model、alias、thinking、工具数量、system prompt 长度及 hash。
    - 配置签名变化时才写 `llm config`。
    - 每次请求写 `llm request`，并附带 partial message 数量。

18. **持久化 LLM 请求记录**（`requester.ts:447`、`836-883`）
    - 构造并 dispatch `llm.request`。
    - 记录请求种类、模型、thinking keep、采样参数、betaApi、toolSelect、prompt/tools hash、消息数、turn step、attempt、projection 等。
    - 返回 payload 供缓存探测复用。

19. **工具 Schema 快照与去重**（`requester.ts:839-845`）
    - 计算工具 hash，该 hash 尚未出现时 dispatch `llm.tools_snapshot`。
    - 通过 replayable state 维护 `seenToolsHashes`，避免重复记录。

20. **Core 流式请求与事件消费**（`requester.ts:459-481`）
    - 调用 `generateModel()`。
    - 转发 streaming parts，收集 usage、finish、message 和 timing。
    - 等待调用方的 `onPart` 处理完成。

21. **Trace ID 生命周期管理**（`requester.ts:276-294`、`388`、`454-457`、`473`）
    - 每次 attempt 清空旧 trace。
    - 从响应 headers 和 finish 中更新 trace，同步到任务持有的 trace handle。
    - turn 请求还同步到 telemetry context。

22. **流完整性检查与结果组装**（`requester.ts:483-490`、`549-558`）
    - 流结束但没有 finish/message 时抛 provider API error。
    - 成功时组装 assistant message、usage、model alias、finish reasons、provider message id、timing 和 trace ID。

## 五、请求后的状态与观测

23. **Prompt Cache 探测**
    - full compaction 成功后与 fork 首次 turn 响应只根据本次 response usage 发送 `prompt_cache_probe`。
    - 总输入为 `inputOther + inputCacheRead + inputCacheCreation`，命中率为 `inputCacheRead / 总输入`；缺 usage 或总输入为 0 时命中率未知。
    - 不再比较模型、context revision、tools、system prompt 或历史前缀，也不参与 recovery 或 compaction 决策。

24. **最近 Turn 请求快照（已删除）**
    - 不再保存 `lastTurnRequest`，相关 state key、公开方法和快照类型均已移除。

25. **Usage 记账**
    - 将本次可选 usage、model alias 和请求来源写入 `ISessionUsageService`。
    - 无 usage 时仍按 `emptyUsage()` 记账，同时以 `usageReported` 保留响应是否真实提供 usage 的信息。

26. **Token Counting 实测校准**（`requester.ts:544-546`）
    - 有真实 usage 时，把请求消息、响应消息和 usage 交给 `tokenCounting.measured()`。
    - 用于校准 context token 统计。

27. **响应性能日志**（`requester.ts:547`、`885-905`）
    - 记录 TTFT、流持续时间、输出 tokens。
    - 记录 request build、server first token、decode、client consume/blocked 等可选耗时。

## 六、错误恢复与重试

28. **Projection Fallback 决策**（`requester.ts:561-586`、`617-680`）
    - 请求过大：优先降级旧媒体，再剥离媒体。
    - 图片格式错误：剥离媒体。
    - 可恢复的请求结构错误：切换 strict projection。
    - 同时负责媒体数量判断、恢复快照捕获、日志、`llm_request_projection_fallback` telemetry 和 `onAttemptRetry` 回调。

29. **无限重试策略**（`requester.ts:587-615`）
    - 读取 `KIMI_CODE_INFINITE_RETRY`。
    - 开启后对错误进行无限重试，但排除 abort 和 context overflow。
    - 支持 Retry-After、指数退避、重试日志、abortable sleep 和 retry 回调。

30. **失败日志与 API 错误 Telemetry**（`requester.ts:291-355`）
    - 非 abort 失败写警告日志。
    - 分类错误并上报 `api_error`，包括模型、provider、protocol、状态码、trace、turn/step、请求类型、耗时、是否可重试和当前 input tokens。
    - 安全地尝试从 catalog 补模型信息。

## 七、文件内的支撑职责

31. **元数据、Hash 与错误字段转换**（`requester.ts:927-1049`）
    - turn/operation source 转日志字段和 telemetry request kind。
    - compaction 请求类型映射。
    - projection policy 转日志/wire 名称。
    - 媒体数量统计。
    - SHA-256 fingerprint。
    - API status code、trace ID 提取。
    - 日志字段的 string/number 类型收窄。

32. **对外数据合约定义**（`requesterContract.ts:17-103`）
    - 请求来源及日志元数据。
    - 请求 overrides 和 streaming part handler。
    - 请求完成结果。
    - `{ trace, result }` 任务句柄。
    - turn 预配置。
    - `LoopRequester` 的 5 个公开方法。

## 边界说明

- Projector 的具体投影算法在 `packages/agent-core-v2/src/agent/loop/projector.ts`，以上只记录 `AgentLoopRequester` 对它的编排职责。
- Core `LlmOutcome` 到旧 `ModelRequestEvent` 的转换在 `packages/agent-core-v2/src/llm-adapter/model/generate.ts`，以上只记录 `AgentLoopRequester` 对它的调用与结果消费。

## 八、行为对齐清单（2026-10-29）

状态只表示当前会话中的决定与实施情况，不把“解释过”视为“已经定稿”。

### A. 已定稿并已完成

| 行为 | 当前结果 |
| --- | --- |
| 旧 `ChatProviderError` 图片错误文本恢复 | `provider` / `syntax` 中的 `unsupported media type for base64 image`、`invalid data url for image` 已恢复媒体剥离重发；已在 `387ad1a6` 提交。 |
| ReadMediaFile 默认注册与隐藏 | 工具始终注册；仅在图片和视频均不支持时，MediaTool Resolver 同步隐藏 schema、assistant calls 和对应 results；其他 calls/content 保留。 |
| ReadMediaFile 执行语义 | 不再按 model capability / providerType 拒绝调用；读取和必要处理后默认 `put` 并生成 `kimi-file://`，实际读取、解码、存储错误仍显式返回。 |
| `kimi-file` 请求解析 | Media Resolver 按模型与协议能力、上传接口和上传结果选择能力提示 omit、provider file-id 或 inline base64；认证错误仍显式抛出。 |
| Resolver 组合顺序 | 已固定为 ToolSelect → MediaTool → Structure → Media；中英文文档与聚焦测试已同步。 |
| full compaction 与 fork 缓存诊断简化 | 已改为 response usage 驱动并删除 `lastTurnRequest` 及历史前缀比较；新增 `cache_hit_rate`，只把 cache read 计为命中，缺 usage 或总输入为 0 时未知，诊断不参与 recovery 或 compaction 决策。 |
| 非 `Error` provider 异常 | 已按用户决定恢复 main 行为：`unknown` 且 rawError 为非 `Error` 时映射为 `ChatProviderError(provider.api_error)`，`isRetryableGenerateError` 为 true；本地 14/14、远程 75/75，产品改动未提交。 |
| sticky mediaPaths | 已修复：每次请求继承媒体 Recovery 时先通过 `displayPaths()` 重算当前消息路径，再以新 replacement 重建 ledger rewrite；degrade/strip 的路径提醒不再使用旧 map。 |
| 取消时的媒体 metadata 写入 | 已按用户决定在 `documents.set` 前执行 `input.signal?.throwIfAborted()`；same-size 且已取消的 materialize 不再更新 name/key metadata，本地 41/41、远程 100/100，产品改动未提交。 |
| recovery traceId | 已按用户决定改为 `defineProtocol` 可选 `diagnoseError`：当前 attempt 的 error 和 headers 生成诊断 record；成功响应使用通用 `requestId`，不再对外暴露通用 `traceId`，也不跨 attempt 继承。 |
| turn 配置冻结与 `select_tools` | 已将 dynamic disclosure 收敛为请求视图而非执行权限；`loop.remind` 与 `notify` 共用 `LoopNotify` 签名并进入独立追加队列，SelectTools 执行时直接发 schema reminder，Pending 与执行侧模型门禁已删除。Resolver 对不支持动态加载的模型剥离 select_tools schema、历史 calls/results、动态 schema system messages 和公告，默认 deferred tools 展开为普通前缀 tools，显式 override 不变；turn 中切换 alias 的 E2E 已验证。 |

### B. 已定稿接受现状，不再作为待修回归

| 行为 | 用户决定 |
| --- | --- |
| 凭证解析异常分类 | 接受当前归为 `provider.api_error` 的行为，不回滚到 main 的 `config.invalid`，本轮不修改。 |
| kimi-inspect 模型 Ping | 用户明确不管：kimi-inspect 不对外开放，因此 Ping 的 debug RPC `method not found` 与 typecheck 失败均不处理，不再作为本任务回归。 |
| provider 文件失效后的上传缓存 | 用户明确先不管：内容寻址引用与 provider file-id 缓存即使过期或被删除也不在本轮处理，不要求清理缓存或自动重传。 |
| 媒体降级与结构投影顺序 | 用户接受 313 当前顺序：媒体恢复可先按未投影历史计算和重写，随后再执行 strict 结构投影；orphan 媒体影响降级数量及组合恢复顺序不再作为待修回归。 |
| `llmRequester.mediaRecovery` inspect state | 接受当前 ledger 的 inspect 展示，不补 main 的 `media.degradeCount/strip` 兼容视图；运行时媒体恢复行为不改。 |
| reasoning-key 缓存 | 接受以 `baseUrl + model` 作为天然共享边界；相同连接的模型 alias 共用 App 级检测结果，不按 alias 或账号额外隔离，不处理该 corner case。 |
| 会话级工具快照与运行期变更 | 用户定稿：每个 Agent 会话只初始化一次并持久化 initial；运行期新增、删除、修改以追加变更表达。支持 tool-select 的模型按版本重选，不支持的模型仅提升 initial deferred，runtime 版本过滤并转为 reminder；模型分支只在 Resolver。 |
| 无凭证 Kimi 上传 | 用户明确不做处理：接受 313 当前无凭证上传与认证错误行为，不恢复 main 的本地失败/inline 回退；标准 Kimi 正常请求与上传共用凭证，本项不再作为待修回归。 |

### C. 已定稿但尚未实施

当前无。

### D. 已讨论或说明，但尚未决定如何对齐

| 行为 | 当前差异与未决点 |
| --- | --- |
| `video_upload.model` telemetry | main 记录模型 alias，313 记录 wire model name；按哪种维度恢复或同时保留，尚未决定。 |

### E. 完全未回应的行为差异

当前无。此前最后一项“媒体降级与结构投影顺序”已于 2026-10-29 接受为当前行为。

### 验证边界

- 缓存诊断简化为当前未提交工作副本改动；typecheck、build、comment-free 通过，聚焦 oxlint 为 0 errors；远程 usage 18/18、compaction 115/115、fork 首请求链路 23/23、compaction 后 fork 诊断 1/1，未据此宣称全量测试通过。
- sticky mediaPaths 修复为当前未提交工作副本改动；本地 requester 61/61、远程相关 3 文件 91/91，typecheck、build、comment-free 通过，聚焦 oxlint 为 0 errors；未运行全量。
- `diagnoseError` 改为当前未提交工作副本改动；本地相关测试 658/658；远程 Loop + kap-server 评分复跑 87/90，剩余 3 个为既有 Loop 事件顺序快照差异；agent-core、klient、product typecheck 和 agent-core build、comment-free 通过；kap-server typecheck 仅剩既有 `getRequester` 错误；未运行全量。
- select_tools 改造为当前未提交工作副本改动；本地 select_tools 94/94、远程聚焦 276/276，typecheck、build、comment-free、完整 lint（0 errors）通过。远程全量 17877 passed / 11 failed / 26 skipped，修正后失败文件复跑剩 8 个既有失败（config 1、Loop 快照 3、plan 快照 2、tool 快照 1、已知子代理中断 1），requester、stateManifest 和 session-import 均恢复通过；未据此宣称全量通过。
- `lint:imports` 仍只有 main 基线已有的 `human/agent/origin.ts` 违规；此前 Handoff 中的全量失败集合需要在该任务要求全量验证时重新确认。
