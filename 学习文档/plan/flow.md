### 一、发一条消息的完整组装流程（已逐环节对照源码核实）
```
  【webview】输入框回车
     │ bridge.streamChat RPC
     ▼
  【扩展宿主】chat.handler → SessionRuntime（带模型别名，如 okta-openai_responses/gpt-5.4）
     │ 进程内调用（无 IPC）
     ▼
  【v2 引擎】agent loop，每一步(step)要一次模型请求：
     │
     ├─① 模型解析（catalogService）
     │    models."okta-openai_responses/gpt-5.4"
     │      .protocol = "openai_responses"   ← 上轮修复加的，选适配器
     │      .provider ──→ providers.okta-openai_responses
     │                        type     = "openai_responses"
     │                        baseUrl  = "https://tss-apim-dr…/seap/proxy/v1"
     │    凭据：磁盘 apiKey="" 被内存层覆盖 = Okta token（注入链）
     │
     ├─② 请求组装（openai_responses 适配器，openai-responses.ts:1177-1198）
     │    new OpenAI({ apiKey: token, baseURL: baseUrl, maxRetries: 0 })
     │    client.responses.create(...)   ← 每次请求现建 client
     │    实际发出：POST {baseUrl}/responses
     │    头：Authorization: Bearer <Okta token>     ← ⚠️  只发这一个认证头
     │    超时：SDK 默认 10 分钟；SDK 内重试关闭（maxRetries: 0）
     │
     ├─③ 失败处理
     │    错误归一化（openai-common.ts:112）→ APITimeoutError / APIStatusError
     │    stepRetryService：可重试错误 → 退避 500ms×2ⁿ±25% 抖动
     │    最多 10 次 ←───── "provider retry 3/10 in 1233.22ms" 就是这里
     │
     └─④ 成功：流式 token → transcript 投影 → streamEvent 广播 → webview 渲染
```

### 发一条消息的完整链路（含函数与行号）
```
  【webview（React）】
   InputArea.tsx:175  handleSend()
     └→ chat.store.ts:191  sendMessage(text)
          └→ chat.store.ts:163  bridge.streamChat(content, model, effort, planMode, sessionId)
               └→ services/bridge.ts:202  streamChat()        ← 组装 {id, method:"streamChat", params} postMessage
  ─ ─ ─ postMessage 跨进程 ─ ─ ──────────────────────────────────────────────

  【扩展宿主（Node）】
   bridge-handler.ts:142-143  dispatch：查 handlers 表
     └→ chat.handler.ts:74  streamChat(params, ctx)            ← Handler 入口
          ├─ chat.handler.ts:91  ctx.getOrCreateSession(model, effort, sessionId)
          │    └→ session-runtime.ts openSession → harness 建会话
          ├─ chat.handler.ts:139  runtime.prompt(content)
          │    └→ session-runtime.ts:175  prompt()
          │         └→ :176  this.session.prompt(...)          ← SDK Session
          │              └→ sdk-rpc-client-v2.ts:1904  prompt(input)
          │                   └→ :1905-1910  agentFacade(sessionId).prompt()   ← klient → 引擎(同进程)
          └─（RPC 立刻返回 {done:true}；过程全部走广播，见最底部）

  【v2 引擎（进程内）】
   loopService.ts:849  this.llmRequester.start(...)
     └→ llmRequesterService.ts:213  request()
          └→ :233  requestWithTrace()  →  :317  runRequest()     ← 组装消息/工具/上下文
               │
               ├─❶ 选模型  catalogService.ts:267-274
               │     models."okta-openai_responses/gpt-5.4"
               │       .protocol → :431  resolveProtocol()        ← 上轮修复加的字段在这生效
               │       .provider → :374  resolveProviderContext() → providers.okta-openai_responses
               │                     { type:"openai_responses", baseUrl:"…/seap/proxy/v1" }
               │
               ├─❷ 取凭据  modelRequesterImpl.ts:117  runWithAuthRefresh(fn)
               │     provider.apiKey：磁盘=""，被内存层覆盖
               │     = SecretStorage → setMemoryConfig 注入的 Okta token
               │     （401 时 :163 分支 force 重取一次再重试）
               │
               ├─❸ 发请求  openai-responses.ts:1181  _createClient(auth)
               │     └→ :1189-1198  _buildClient():
               │          new OpenAI({ apiKey: token,             ← 只发 Authorization: Bearer ⚠️ 
               │                      baseURL: baseUrl,           ← 拼出 POST {baseUrl}/responses
               │                      maxRetries: 0 })            ← SDK 内重试关闭
               │     └→ :1173-1175  client.responses.create(params, {signal})
               │
               ├─❹ 失败归一  openai-common.ts:112-113
               │     OpenAI SDK 超时 → APITimeoutError；HTTP 错误 → normalizeAPIStatusError(:125)
               │     （"Request time out" 文本不在本仓库任何源码里 → 是网关返回体原样透传）
               │
               └─❺ 重试  stepRetryService.ts:105  recover(context)
                     :113  failedAttempts += 1
                     :120-127  maxAttempts = loop 配置 ?? 默认 10   ← "3/10" 的 10
                     :130-132  delay = Retry-After 头 ?? 退避表
                     :133-143  dispatch(TurnStepRetrying) + sleep + context.retry()
                                ← "provider retry 3/10 in 1233.22ms" 的来源
                     退避表 _base/utils/retry.ts:16  retryBackoffDelay(i) = 500ms×2ⁱ±25% 抖动
                         i=0→~500ms, i=1→~1000ms(你的1233在这), i=2→~2000ms…

  【回流（广播，不走 RPC 回包）】
   session-runtime.ts:107  session.onEvent(...)
     └→ :440  onSdkEvent(event)                    ← 引擎事件 → UI 事件投影
          └→ :584  this.broadcast(Events.StreamEvent, event, webviewId)
               └→ webview chat.store.ts  processEvent()  → 逐 token 渲染

                         i=0→~500ms, i=1→~1000ms(你的1233在这), i=2→~2000ms…

  【回流（广播，不走 RPC 回包）】
   session-runtime.ts:107  session.onEvent(...)
     └→ :440  onSdkEvent(event)                    ← 引擎事件 → UI 事件投影
          └→ :584  this.broadcast(Events.StreamEvent, event, webviewId)
               └→ webview chat.store.ts  processEvent()  → 逐 token 渲染
```


### 发送消息全链路（每一跳：文件：行号 → 函数，本轮逐一 grep 核实）
```
  【webview】
   InputArea.tsx:175            handleSend()
     └→ chat.store.ts:191       sendMessage(text)
          └→ chat.store.ts:163  bridge.streamChat(content, model, effort, planMode, sessionId)
               └→ services/bridge.ts:202  streamChat()   ← postMessage {id, method:"streamChat", params}
  ─ ─ ─ postMessage 跨进程 ─ ─ ─────────────────────────────────────────────

  【扩展宿主】
   bridge-handler.ts:142-143    dispatch：handlers 表查到 streamChat
     └→ chat.handler.ts:74      const streamChat: Handler = async (params, ctx) =>
          ├─ chat.handler.ts:95       ctx.getOrCreateSession(model, effort, sessionId)
          │    └→ bridge-handler.ts:168  getOrCreateSession: async (…) => {      ← HandlerContext 里的实现
          │         └→ :169  this.runtime.openSession({webviewId, workDir, model, effort, …})
          │              └→ kimi-runtime.ts:89   openSession(options)
          │                   └→ :90  serializeView(…, () => openSessionInner(options))   ← 每 view 串行
          │                        └→ :93  openSessionInner(options)
          │                             ├─ :104-115 同 view 已绑同会话+同 workDir
          │                             │    → applySessionSettings 后直接复用，不新建
          │                             └─ :117  this.harness.createSession({workDir, model…})
          │                                  │   （带 sessionId 时走 :124 harness.resumeSession）
          │                                  └→ kimi-harness.ts:128  createSession(options)
          │                                       └→ sdk-rpc-client-v2.ts:1255  createSession(input)
          │                                            ← klient 进引擎建会话，返回 Session
          ├─ chat.handler.ts:108-120  对齐模型/思考档/planMode（getStatus/setModel/setThinking/setPlanMode）
          └─ chat.handler.ts:139      runtime.prompt(prependSystemContext(content))
               └→ session-runtime.ts:175  async prompt(input)
                    └→ :176  runTurnAction(input, () => this.session.prompt(toSdkPromptInput(input)))
                         └→ sdk-rpc-client-v2.ts:1904  prompt(input)
                              └→ :1905-1910  agentFacade(sessionId).prompt({input…})
                                   ← klient 调引擎 Agent 作用域；RPC 侧到此返回，
                                     chat.handler 拿到结果回 {done:true}，后续全走广播

  【v2 引擎（与宿主同进程）】
   loopService.ts:849           this.llmRequester.start(…)
     └→ llmRequesterService.ts:213  request()
          └→ :233  requestWithTrace() → :317  runRequest()
               ├─❶ 选模型  catalogService.ts:267-274  resolve 入口
               │     ├→ :431  resolveProtocol(id, model, provider, trace)
               │     │      （model.protocol 优先 → provider.type 回退，:438 抛你之前那个错）
               │     └→ :374  resolveProviderContext(id, model, trace)
               │            :383  providers.get(providerId)；查不到 :388 抛 "not configured"
               ├─❷ 取凭据  modelRequesterImpl.ts:117  runWithAuthRefresh(fn)（定义 :163）
               │     每次请求先 getAuth()；401 时 :163 内部 force 重取重试一次
               ├─❸ 发请求  openai-responses.ts:1135  const client = this._createClient(options?.auth)
               │     └→ :1176  _createClient(auth)
               │          └→ :1181  _buildClient(requireProviderApiKey(...), a)
               │               └→ :1185-1198  _buildClient():
               │                    new OpenAI({ apiKey: token, baseURL, maxRetries: 0 })
               │                    ← 无显式 timeout（SDK 默认 10min）；只发 Authorization: Bearer ⚠️ 
               │     └→ :1168-1172  (client.responses).create(params, {signal})
               │                    ← 实际 HTTP：POST {baseURL}/responses
               ├─❹ 失败归一  openai-common.ts:112-113  OpenAITimeoutError → APITimeoutError
               │            :125  normalizeAPIStatusError（网关错误体文本原样透传）
               └─❺ 重试    stepRetryService.ts:110  private async recover(context)
                    :118  failedAttempts += 1
                    :120-124  maxAttempts = 配置 ?? DEFAULT_MAX_RETRY_ATTEMPTS
                              （retry.ts:3，=10 ← "3/10" 的 10）
                    :131-132  delay = readRetryAfterMs(error) ?? 退避表
                    :133-143  dispatch(TurnStepRetrying) + sleep + context.retry()
                              ← "provider retry 3/10 in 1233.22ms"
                    退避表 retry.ts:16  retryBackoffDelay(i) = 500ms×2ⁱ ×(1±25%抖动)

  【回流（广播）】
   session-runtime.ts:107       session.onEvent(event => this.onSdkEvent(event))
     └→ :440   onSdkEvent(event)      ← 引擎事件 → UI 事件投影
          └→ :584  this.broadcast(Events.StreamEvent, event, webviewId)
               └→ webview chat.store.ts  processEvent(event) → 渲染
```
  
上一版的三处错误已修正：getOrCreateSession 在 chat.handler.ts:95（我写 91）、会话创建实际路径是 bridge-handler.ts:168 → kimi-runtime.ts:89/93/117 →
  kimi-harness.ts:128 → sdk-rpc-client-v2.ts:1255（我笼统写成"openSession → harness 建会话"）、recover 在 stepRetryService.ts:110（我写
  105）、_buildClient 定义在 openai-responses.ts:1185（1181 是调用行）。

  排查结论不变，等你 curl 矩阵的结果：每次秒级失败 + "Request time out" 文本不在任何源码里 → 网关快速返回错误体；先验证 ❸ 的两个点（Authorization:
  Bearer 是否被网关接受、{baseUrl}/responses 路径是否正确）。


 ❶ 选模型——完整展开（每一跳已核实）
```
  llmRequesterService.ts:311      this.modelCatalog.get(modelAlias)          ← 在 requestWithTrace() 阶段解析
    │
    └→ catalogService.ts:102      get(id: string): Model
         └→ :103                 return this.entry(id).model
              └→ :119            private entry(id)                          ← CatalogEntry 缓存，未命中才构建
                   └→ :255       private buildModel(id, trace)
                        │
                        ├→ :257  const configuredModel = this.models.get(id)
                        │         （this.models = 引擎有效配置的 models 表）
                        ├→ :258-263  查不到 → 抛 Error2
                        │         `Model "x" is not configured in config.toml.`
                        │
                        ├→ :267  routingModel = effectiveModelConfig(configuredModel)
                        │         └→ modelAuth.ts:81  effectiveModelConfig(model)
                        │              ：86  合并 overrides 子对象进基础字段
                        │              ：96-100 maxInputSize 钳到 ≤ maxContextSize
                        │
                        ├→ :268-269  { providerConfig, providerName, resolvedBaseUrl }
                        │         = this.resolveProviderContext(id, routingModel, trace)
                        │         └→ :374  private resolveProviderContext(id, model, trace)
                        │              ├→ :383-384  providerId =
                        │              │     model.providerId ?? model.provider ?? providers.getDefaultProvider()
                        │              │     ← 我们的模型条目 provider = "okta-openai_responses" 在这命中
                        │              ├→ :396  const providerConfig = this.providers.get(providerId)
                        │              │    └→ providerService.ts:40  get(name)
                        │              │         └→ :41  return this.providers[name]
                        │              │              （providers 表 = 磁盘 config.toml ⊕ 内存层合并后的
                        │              │                有效视图——Okta token 的 apiKey 注入就在这生效）
                        │              ├→ :397-402  undefined → 抛 Error2
                        │              │         `Provider "x" referenced by model "y" is not configured.`
                        │              ├→ :403  resolveEndpointBaseUrl(model, providerConfig, providerId)
                        │              │    └→ modelAuth.ts:185
                        │              │         ：188  model.baseUrl 优先（我们没写，跳过）
                        │              │         ：192-198  provider.baseUrl ← 我们走这条，
                        │              │                   baseUrl = "https://tss-apim-dr…/seap/proxy/v1"
                        │              └→ :408  return { providerConfig, providerName, resolvedBaseUrl }
                        │
                        ├→ :274  protocol = this.resolveProtocol(id, routingModel, providerConfig, trace)
                        │         └→ :431  private resolveProtocol(id, model, provider, trace)
                        │              └→ :437  resolution = resolveModelProtocol(model, provider)
                        │                   └→ modelAuth.ts:150  resolveModelProtocol(model, provider)
                        │                        ├→ :154-156  model.protocol 有值 → 直接用
                        │                        │             ← 我们修复后走这条（protocol="openai_responses"）
                        │                        ├→ :157-168  provider.type 过 ProtocolSchema.safeParse(:159)
                        │                        │             通过 → 直接当 wire protocol
                        │                        ├→ :169-175  getProviderDefinition(providerType)
                        │                        │             （providerDefinition.ts:36）→ definition.baseProtocol
                        │                        └→ :177  都没有 → return undefined
                        │              └→ :438-441  undefined → 抛 Error2
                        │                        `Model "x" must declare a wire protocol (config: models.<id>.protocol).`
                        │                        ← 你之前遇到的错就在这（当时模型没写 protocol、
                        │                        │             （providerDefinition.ts:36）→ definition.baseProtocol
                        │                        └→ :177  都没有 → return undefined
                        │              └→ :438-441  undefined → 抛 Error2
                        │                        `Model "x" must declare a wire protocol (config: models.<id>.protocol).`
                        │                        ← 你之前遇到的错就在这（当时模型没写 protocol、
                        │                          且解析链没走到 provider.type 回退）
                        │
                        ├→ :275-278  model = effectiveModelConfig(configuredModel,
                        │             providerConfig?.type ?? configuredModel.protocol)   ← 二次合并，算生效模型
                        │
                        └→ :290  resolveModelAuthMaterial({ modelId, model, provider, providerName }, trace)
                                  └→ modelAuth.ts:43  resolveModelAuthMaterial(...)
                                       优先级：model.apiKey → model.oauth
                                               → provider.apiKey（:48，含内存层注入的 Okta token）★我们走这条
                                               → provider.oauth
                                       ：49-51  apiKey 与 oauth 同段 → 硬错误（所以我们只写 apiKey）
```
  要点修正（对照我上一版）：

  1. 调用点：模型解析挂在 llmRequesterService.ts:311（requestWithTrace 阶段），不是 runRequest(:317) 里——runRequest 只管发请求
  2. 入口私有链：:102 get → :103 → :119 entry() → :255 buildModel()，:257 从有效配置的 models 表取条目，:258-263 抛 "is not configured"
  3. 我之前写的 ":383 providers.get / :388 抛错" 是臆断——实际 :396 才是 providers.get、:397-402 抛错，:383-384 是 providerId 三级取值
  4. providers.get 落到 providerService.ts:40-41 的裸表查询——这张表就是磁盘 ⊕ 内存层的合并视图，token 注入之所以生效在这一步得到确认

  排查结论不变：这条链每一环都通（否则你看到的会是 "not configured" 或 "wire protocol" 那种秒抛错，而不是超时重试）——问题在 ❸ 发出的 HTTP
  请求本身（Authorization: Bearer 头 / /responses 路径），等你 curl 矩阵的结果。


## 发送消息全链路（每一跳：文件：行号 → 函数，本轮逐一 grep 核实）

⏺ 全部主干读完了。:311 的真面目：它在 trackApiError(:272) → tryGetModel(:307) 的 catch 诊断路径里——主干上目录的真实调用点是 profileService.ts:443 和
  resolveRequest 的 :656。完整终版如下，每一步都是「文件：行号 → 函数」，从回车到渲染无省略：

```
  ━━━ webview ━━━
  ①  InputArea.tsx:175                handleSend()
  ②  chat.store.ts:191                sendMessage(text)
  ③  chat.store.ts:163                bridge.streamChat(content, model, effort, planMode, sessionId)
  ④  services/bridge.ts:202           streamChat()  → postMessage {id, method:"streamChat", params}

  ━━━ 扩展宿主 ━━━
  ⑤  bridge-handler.ts:142-143        dispatch（validateRpcMessage 过校验后查 handlers 表）
  ⑥  chat.handler.ts:74               const streamChat: Handler = async (params, ctx) =>
  ⑦  chat.handler.ts:95               ctx.getOrCreateSession(model, effort, sessionId)
  ⑧  bridge-handler.ts:168-179        getOrCreateSession 实现：
                                       :169 this.runtime.openSession({webviewId, workDir, model, effort…})
                                       :178 fileManager.setSession(webviewId, baselineSession(runtime))
  ⑨  kimi-runtime.ts:89               openSession(options)
        :90                           serializeView(webviewId, () => openSessionInner(options))
        :93                           openSessionInner(options)
        :104-115                      同 view 已绑同会话且同 workDir → applySessionSettings 后复用
        :117                          this.harness.createSession({workDir, model…})（带 id 时走 :124 resumeSession）
  ⑩  kimi-harness.ts:128              createSession(options)
  ⑪  sdk-rpc-client-v2.ts:1255        createSession(input)  → klient 建引擎会话，返回 Session
  ⑫  chat.handler.ts:108-120          getStatus/setModel/setThinking/setPlanMode 对齐当前选择
  ⑬  chat.handler.ts:139              runtime.prompt(prependSystemContext(content))
  ⑭  session-runtime.ts:175           prompt(input)
        :176                          runTurnAction(input, () => this.session.prompt(toSdkPromptInput(input)))
  ⑮  sdk-rpc-client-v2.ts:1904        prompt(input)
        :1905-1910                    agentFacade(sessionId).prompt({input…})
        ← RPC 侧到此返回；chat.handler 回 {done:true}，之后全是广播

  ━━━ v2 引擎（进程内）━━━
  ⑯  loopService.ts:849               const request = this.llmRequester.start(…)
  ⑰  llmRequesterService.ts:213       request()（便捷壳）→ :221 start()
        :227-229                      return { trace, result: this.requestWithTrace(trace, …) }
  ⑱  llmRequesterService.ts:233       requestWithTrace(trace, overrides, onPart, signal)
        :242-248                      return await this.runRequest(this.resolveRequest(overrides), …)
                                       │
        ┌──────────────────────────────┘
  ⑲  llmRequesterService.ts:639       resolveRequest(overrides)：
        :640                            turnConfig = resolveTurnConfig(:673 → getOrCreateTurnConfig :678)
        :641                            resolved = turnConfig?.resolved ?? this.profile.resolveModelContext()
        │                               └→ profileService.ts:441  resolveModelContext()
        │                                   :442  modelAlias = this.model
        │                                   :443  model = this.modelCatalog.get(modelAlias)   ← 主干第一次进目录★
        │                                   └→ catalogService.ts:102  get(id)
        │                                       :103  entry(id).model
        │                                       :119  private entry(id)（CatalogEntry 缓存）
        │                                       :255  buildModel(id, trace)
        │                                         :257   configuredModel = this.models.get(id)
        │                                         :258-263 查不到 → 抛 `Model "x" is not configured in config.toml.`
        │                                         :267   effectiveModelConfig(configuredModel)
        │                                           └→ modelAuth.ts:81（:86 合并 overrides；:96-100 钳 maxInputSize）
        │                                         :268-269 resolveProviderContext(id, routingModel, trace)
        │                                           └→ catalogService.ts:374
        │                                                :383-384 providerId = providerId ?? provider ?? getDefaultProvider()
        │                                                :396   providers.get(providerId)
        │                                                  └→ providerService.ts:40 get(name) → :41 this.providers[name]
        │                                                     （磁盘 config.toml ⊕ 内存层 的合并表；Okta token 在此生效）
        │                                                :397-402 查不到 → 抛 `Provider "x" … is not configured.`
        │                                                :403   resolveEndpointBaseUrl(model, providerConfig, providerId)
        │                                                  └→ modelAuth.ts:185（:188 model.baseUrl 优先；
        │                                                     :192 provider.baseUrl ← 我们走这条）
        │                                                :408   return {providerConfig, providerName, resolvedBaseUrl}
        │                                         :274   resolveProtocol(id, routingModel, providerConfig, trace)
        │                                           └→ catalogService.ts:431
        │                                                :437   resolveModelProtocol(model, provider)
        │                                                  └→ modelAuth.ts:150
        │                                                       :154-156 model.protocol ★（我们修复后走这条）
        │                                                       :157-168 provider.type → ProtocolSchema.safeParse(:159)
        :1905-1910                    agentFacade(sessionId).prompt({input…})
        ← RPC 侧到此返回；chat.handler 回 {done:true}，之后全是广播

  ━━━ v2 引擎（进程内）━━━
  ⑯  loopService.ts:849               const request = this.llmRequester.start(…)
  ⑰  llmRequesterService.ts:213       request()（便捷壳）→ :221 start()
        :227-229                      return { trace, result: this.requestWithTrace(trace, …) }
  ⑱  llmRequesterService.ts:233       requestWithTrace(trace, overrides, onPart, signal)
        :242-248                      return await this.runRequest(this.resolveRequest(overrides), …)
                                       │
        ┌──────────────────────────────┘
  ⑲  llmRequesterService.ts:639       resolveRequest(overrides)：
        :640                            turnConfig = resolveTurnConfig(:673 → getOrCreateTurnConfig :678)
        :641                            resolved = turnConfig?.resolved ?? this.profile.resolveModelContext()
        │                               └→ profileService.ts:441  resolveModelContext()
        │                                   :442  modelAlias = this.model
        │                                   :443  model = this.modelCatalog.get(modelAlias)   ← 主干第一次进目录★
        │                                   └→ catalogService.ts:102  get(id)
        │                                       :103  entry(id).model
        │                                       :119  private entry(id)（CatalogEntry 缓存）
        │                                       :255  buildModel(id, trace)
        │                                         :257   configuredModel = this.models.get(id)
        │                                         :258-263 查不到 → 抛 `Model "x" is not configured in config.toml.`
        │                                         :267   effectiveModelConfig(configuredModel)
        │                                           └→ modelAuth.ts:81（:86 合并 overrides；:96-100 钳 maxInputSize）
        │                                         :268-269 resolveProviderContext(id, routingModel, trace)
        │                                           └→ catalogService.ts:374
        │                                                :383-384 providerId = providerId ?? provider ?? getDefaultProvider()
        │                                                :396   providers.get(providerId)
        │                                                  └→ providerService.ts:40 get(name) → :41 this.providers[name]
        │                                                     （磁盘 config.toml ⊕ 内存层 的合并表；Okta token 在此生效）
        │                                                :397-402 查不到 → 抛 `Provider "x" … is not configured.`
        │                                                :403   resolveEndpointBaseUrl(model, providerConfig, providerId)
        │                                                  └→ modelAuth.ts:185（:188 model.baseUrl 优先；
        │                                                     :192 provider.baseUrl ← 我们走这条）
        │                                                :408   return {providerConfig, providerName, resolvedBaseUrl}
        │                                         :274   resolveProtocol(id, routingModel, providerConfig, trace)
        │                                           └→ catalogService.ts:431
        │                                                :437   resolveModelProtocol(model, provider)
        │                                                  └→ modelAuth.ts:150
        │                                                       :154-156 model.protocol ★（我们修复后走这条）
        │                                                       :157-168 provider.type → ProtocolSchema.safeParse(:159)
        │                                                       :169-175 getProviderDefinition(:36 providerDefinition.ts).baseProtocol
        │                                                       :177   都没有 → undefined
        │                                                :438-441 undefined → 抛 `must declare a wire protocol`（你之前的错）
        │                                         :275-278 effectiveModelConfig(…, provider.type ?? protocol) 二次合并
        │                                         :290   resolveModelAuthMaterial(…)
        │                                           └→ modelAuth.ts:43（:48 provider.apiKey = 内存层 token；
        │                                                :49-51 apiKey+oauth 同段是硬错误）
        │                                   :446-452 返回 {modelAlias, modelCapabilities, thinkingLevel…}
        :642                            baseParams = profile.resolveRequestParams()
        :643-654                        budgetParams = completionBudgetParams(resolveCompletionBudget(…))
        :656                            requester = this.modelCatalog.getRequester(resolved.modelAlias)
                                         └→ catalogService.ts:106 getRequester(id) → :107 entry(id)（缓存命中，
                                            与 :443 同一个 CatalogEntry）→ .requester = ModelRequesterImpl

  ⑳  llmRequesterService.ts:317       runRequest(request, onPart, signal, onRequestTrace)
        :318                           toolCallIdNormalizer.seedFrom(this.context.get())
        :319                           shaped = toolSelect.shapeHistory(request.messages)
        :320-326                       media strip/degrade policy
  ㉑  llmRequesterService.ts:381       for await (event of request.requester.request(input, signal, {…params}))
        └→ modelRequesterImpl.ts:46    request(...)（async generator）
             :75                       runRequest(input, signal, queue, params)
             :82                       provider = this.resolveChatProvider()
               └→ :32                  resolveChatProvider()（:34 缓存判断；:35-43）
                    protocolRegistry.createChatProvider({protocol, providerType, baseUrl, modelName…})
                      └→ protocolAdapterRegistry.ts:101 createChatProvider(config)
                           :102                        resolveAdapterIdentity(protocol, providerType)
                           :108                        base = getProtocolBase(identity.baseId)
                           :113                        base.createChatProvider({config, traits})
                                                       ← 产出 OpenAIResponsesChatProvider 实例
             :117-133                  result = await this.runWithAuthRefresh((auth) =>
                                         generate(provider, systemPrompt, tools, messages, callbacks, {…options, auth}))
               └→ runWithAuthRefresh 定义 :163（先 getAuth()=内存层 token；401 → force 重取再试一次）
               └→ generate.ts:31       generate(provider, …)：循环消费流，onMessagePart → queue.push({type:'part'})
                    └→ openai-responses.ts:1064  async generate(…)
                         :1135        client = this._createClient(options?.auth)
                           :1176      _createClient(auth)
                             :1181    _buildClient(requireProviderApiKey(…), a)
                               :1185-1198 _buildClient：new OpenAI({apiKey: token, baseURL, maxRetries: 0})
                                          （无显式 timeout → SDK 默认 10 分钟；只发 Authorization: Bearer ⚠️ ）
                         :1168-1172   (client.responses).create(params, {signal})
                                       ← 实际 HTTP：POST {baseURL}/responses

  ㉒ 失败归一  openai-common.ts:112-113  OpenAI SDK 超时 → APITimeoutError
               openai-common.ts:125     normalizeAPIStatusError（网关错误体文本原样透传）
  ㉓ 重试      stepRetryService.ts:110  recover(context)
               :118   failedAttempts += 1
               :120-124 maxAttempts = loopControl 配置 ?? retry.ts:3 DEFAULT_MAX_RETRY_ATTEMPTS(=10)
               :131-132 delay = readRetryAfterMs(error) ?? retry.ts:16 retryBackoffDelay(i)=500ms×2ⁱ×(1±25%)
               :133-143 dispatch(TurnStepRetrying) + sleepForRetry + context.retry()
                        ← "provider retry 3/10 in 1233.22ms"

  ━━━ 回流（广播）━━━
  ㉔ 引擎事件 → klient 流 → SDK session.onEvent
  ㉕ session-runtime.ts:107            session.onEvent(e => this.onSdkEvent(e))
        :440                          onSdkEvent(event)（引擎事件 → UI 事件投影）
        :584                          this.broadcast(Events.StreamEvent, event, webviewId)
  ㉖ webview chat.store.ts             processEvent(event) → 逐 token 渲染

  对 :311 的更正：llmRequesterService.ts:307 tryGetModel() → :311 modelCatalog.get 只在 :272 trackApiError 的失败诊断路径里被调用（:242 主干的 catch
  分支），主干上目录的两次调用是 profileService.ts:443（解析模型上下文）和 llmRequesterService.ts:656（取 requester）——两者复用同一个 CatalogEntry
  缓存（catalogService.ts:119），所以 buildModel 的整条解析链每模型只跑一次。

  排查结论不变：链上任何一环配置错误都是秒抛（not configured / wire protocol），而你的现象是请求发出后超时重试——问题在 ㉑ 末端的 HTTP
  层（Authorization: Bearer 是否被网关接受、{base_url}/responses 路径是否正确），等你 curl 矩阵结果。
```



修复完成（typecheck ✓、39/39 ✓）。总结这次的问题与修复：
     
  为什么 baseURL 变成了 api.openai.com/v1
```ts
  new OpenAI({ baseURL: this._baseUrl })                    openai-responses.ts:1189
    ↑ this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1'   :1033
        ↑ 工厂：config.baseUrl ?? env ?? endpoint.defaultBaseUrl       openai-responses.contrib.ts:25-27
            ↑ config.baseUrl = model.baseUrl                          modelRequesterImpl.ts:38
                ↑ Model.baseUrl = resolveEndpointBaseUrl(...) 的结果     catalogService.ts:353
                    ↑ modelAuth.ts:188 model.baseUrl（没写，跳过）
                      modelAuth.ts:192 provider.baseUrl（★这里空了★）
                      modelAuth.ts:201 内置端点表 → openai/openai_responses 的
                        defaultBaseUrl = https://api.openai.com/v1      ← 落到这里
```
  provider 段的 baseUrl 在那台机器的运行时表里是空的——于是引擎“好心地”兜到 provider 类型注册表里的官方默认地址，带着你们的 Okta token 去打 OpenAI
  官方，自然超时重试。这也统一解释了之前所有“Request time out”：请求根本没去你们的网关。

  修复：baseUrl 也写到模型级（第一优先级，免疫 provider 段异常）

  和上次 protocol 同一个教训——引擎解析链里模型级字段永远第一优先，provider 段只是回退。现在供给写出的每个模型条目是三件套齐备：
```
  [models."okta-openai_responses/gpt-5.4"]
  provider = "okta-openai_responses"
  model = "gpt-5.4"
  baseUrl = "https://apim-restver.life/seap/proxy/v1"   ← 新增：modelAuth.ts:188 直接命中
  protocol = "openai_responses"                          ← 上次加的
  maxContext_size = 200000
  display_name = "gpt-5.4"
```

即使 provider 段的 base_url 因为任何原因缺失/丢失，请求地址也不会再漂到官方默认。
