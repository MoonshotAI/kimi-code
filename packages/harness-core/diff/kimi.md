# kimi：harness-core vs agent-core-v2 差异对比

## 对应关系

- harness-core：`packages/harness-core/src/features/kimi/`（约 2654 行）——`feature.ts` 复合工厂 `createKimi` + provider 族（`provider.ts`/`trait.ts`/`schema.ts`/`errors.ts`/`media.ts`/`files.ts`）+ 五个子 Feature：`oauth/`、`web/`、`fetch/`、`sessionTitle/`、`trace/`
- agent-core-v2：
  - provider 族：`src/human/llm-kimi/`（839 行，provider/trait/schema/errors/media/files 六件）
  - trace：`src/human/kimi/trace.ts`（34 行，human 旧版 Plugin）
  - oauth：`src/app/auth/`（1692 行，authService/auth/configSection/oauthProtocol/errors + webSearch 子目录）+ `src/app/kosongConfig/discoveryService.ts`（295 行，模型目录刷新）+ `src/app/kosongConfig/oauthTokenAdapter.ts`（54 行）
  - WebSearch：`src/agent/tools/web-search/`（156 行）+ `src/app/auth/webSearch/`（356 行）
  - FetchURL：`src/agent/tools/fetch-url/`（97 行）+ `src/app/web/`（593 行）
  - sessionTitle：`src/session/sessionTitle/`（413 行）
- 蓝本关系：provider 族与 trace 是 **refact-237 第一批 human 蓝本**——`human/llm-kimi` 与 `human/kimi/trace.ts` 基本逐字迁移（`schema.ts` 两侧 diff 仅剩导出可见性一处）；oauth/web/fetch/sessionTitle 是本任务第 12/13/14/17 轮按 v2 DI 版（`app/auth`、`app/web`、`session/sessionTitle`、`agent/tools/*`）迁移，DI 版为行为规格蓝本。

## 行为差异

### 人为设计

| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 复合 Feature 形态 | 无复合概念：kimi provider 经 `provider-definition.ts:224-252` 静态注册（kimi × openai/anthropic/openai_responses 三协议），auth/web/sessionTitle 各自为 DI Service + `registerAgentToolService` | `createKimi(props)` 一个 FeatureSpec 组合全部（app：`kimiAppSlot`+oauth+web+fetch；session：sessionTitle；agent：web+fetch+sessionTitle+trace，`feature.ts:22-31`），`composeSlots` 收 cleanup 逆序执行 | 第 13 轮用户定稿「spec 级组合而非节点嵌套 / installFeature」——`useExpose` 语义是「恰好上一层父节点」，节点嵌套会断 `WebSearchRef`/`SessionTitleRef`/`SessionTitlePromptSourceRef` 三处解析（Handoff 执行事实第 13 轮偏差①②） |
| roster 名单语义 | 无 roster | roster 记录的 agent features 只剩 `'kimi'`，按老名单（含 oauth/web/sessionTitle/kimi-trace）重开的分支触发 `session.feature_missing` 跳过 | 第 13 轮偏差③ / 第 14 轮偏差②，「开发期可接受」的在案决定 |
| oauth 域范围 | `app/auth` 全量：login/logout 设备流状态机（`OAuthService.startLogin/getFlow/cancelLogin/logout`，authService.ts:122-247）、flow GC（5min 终态保留）、`AuthSummaryService.summarize/ensureReady`、`getManagedUsage/getManagedUserInfo/getRegion`、provision/deprovision 写回 config | 仅四件：token facade（`OAuthTokensRef.resolve/refresh`）、oauth-catalog 物化 watcher（`oauth/feature.ts:129-162`）、aliasScope 补写（`oauth/feature.ts:107-128`）、refresh 定时调度 + `useCredentialResolver` 贡献（`oauth/feature.ts:92-106`） | 约束问答（Handoff L168）：「oauth 域**不含** login/logout 设备流状态机、HTTP 端点、usage/userinfo——划为 kap-server 宿主层」；`@moonshot-ai/kimi-code-oauth` 的 OAuthManager 已具备能力，宿主随时可接 |
| refresh 编排载体 | `OAuthService.doRefreshOAuthProviderModels`（authService.ts:306-421）直接改写 config 四节（providers/models/defaultModel/thinking）：`applyManagedKimiCodeConfig` + 用户 alias 保留 + `clampDanglingDefault` + `restoreDefaultSelection`（含 thinking.enabled 恢复），`refreshChain` 串行化，完成后发 `ModelCatalogChanged` 事件 | oauth watcher 调 `catalog.refresh(createProvider({ models: () => fetchCatalog(info) }))`（`oauth/feature.ts:143-158`）物化 live provider，模型写回由 provider-catalog 的 writeback watcher 按 `` `${aliasScope}/` `` 前缀重建 models 节生成区（agent-core `provider-catalog/feature.ts:190-215`）；oauth 包 `refreshProviderModels`（779 行）**不直接复用** | oauth 设计要点（Handoff L189）：oauth 包刷新器「读写 v2 snake_case 配置节，与本架构 camelCase 节不兼容，不直接复用——编排在 feature 内实现，复用其 fetch/存储/锁原语」 |
| modelCatalog 节消费方 | core 内只注册 schema（`kosongConfig/configSection.ts:338-347`），**无任何 core 消费方**；调度器在 kap-server（`modelCatalogRefreshScheduler.ts`，含 `KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS/ON_START` env 覆盖） | 收进 oauth 子 Feature：setTimeout 链 + 启动闸门走根节点 `ready()` + `pushCleanup`（`oauth/feature.ts:163-206`），默认 6h（`DEFAULT_OAUTH_REFRESH_INTERVAL_MS`，oauth/feature.ts:41） | oauth 设计要点（Handoff L189）「定时调度——消费 modelCatalog 节 refreshIntervalMs/refreshOnStart」；env 覆盖未迁为第 12 轮记录在案遗留 |
| aliasScope 机制 | providers 节无 `aliasScope` 字段；`applyManagedKimiCodeConfig` 直接生成 `kimi-code/` 前缀的 alias 键 | oauth 侦测 providers 节中 `managed:kimi-code` 条目缺 `aliasScope` 时自动补写 `{ aliasScope: KIMI_CODE_PLATFORM_ID }`（config `'user'` target，`oauth/feature.ts:107-128`）；provider-catalog 读写均以 `aliasScope ?? providerId` 为前缀 | 第 12 轮偏差④：走 config 'user' target 而非 snapshot 注入，「避免与 reconcile『config 全权拥有』语义回环」 |
| oauth-catalog 判定 | `isOAuthCatalogVendor(provider.type)`——type `'kimi'` 的静态 definition 自带 `modelSource: 'oauth-catalog'`，config 条目不必写 modelSource（v2 provision 只写 `{type:'kimi',baseUrl,apiKey:'',oauth}`，authService.ts:558-563） | web/fetch/sessionTitle 的 managed 通道与物化 watcher 一律读 **config 条目的 `info.modelSource`**（provider-catalog 无 type→definition fallback），宿主 provision 合约变为必须显式写 `modelSource: 'oauth-catalog'` | provider-catalog 第 4 轮「单通道物化」决策的下游形态；Handoff kimi 域无专门条目，按代码事实记录 |
| WebSearch 工具门控 | `when: hasWebSearchProvider()`（webSearchTool.ts:114-118）由 `AgentToolActivationService` 评估，`AgentStatusUpdated`/贡献变化时**重评估**——会话中途登录可激活工具 | agent slot 挂载时 `web.getProvider() === undefined` 即不注册（`web/feature.ts:92-96`）；spec freeze 语义：新 agent 感知登录态，会话中途重激活不迁 | web 设计要点（Handoff L191）+ spec freeze 横切约定。已挂载后 provider 被移除的降级文案两侧逐字一致（`WEB_SEARCH_PROVIDER_REMOVED_MESSAGE`，web/tool.ts:8-9 vs webSearchTool.ts:50） |
| WebSearch 无凭证错误文案 | `'Moonshot search service is not configured: missing API key or token provider.'`（moonshot-web-search.ts:127-131，Error2 `AUTH_TOKEN_MISSING`），classify 落入通用 `Search failed:` | `'Moonshot search request failed: authentication is not configured (missing API key or OAuth token).'`（`web/provider.ts:60-62`），classify 落入 `Search failed (authentication):` | 第 12 轮偏差⑥：「补 authentication 字样（保证 classify 归类正确）」，刻意文案偏差 |
| sessionTitle 触发与 live 要求 | core 同样纯被动（`ISessionTitleService.generateTitle`），但 kap-server 路由 `resumeSessionById` 会**临时 resume 非 live 会话**再取 facade（kap-server `routes/sessions.ts:558-566`） | facade 要求 session live + main agent live（`promptSourceOfMain` 解析不到即返回 undefined，`sessionTitle/feature.ts:74-82`），不自造；feature-http 路由 `useApp().get(sessionId)` 只认 live（route-features/sessionTitle.ts） | 约束问答（Handoff L180）「纯被动，对齐 v2 core」+ 第 12 轮偏差⑦「新架构 resume 不自动建 main agent，facade 不自造」 |
| 手写 custom 标题约定 | `isCustomTitle` 由 session metadata 域维护 | 约定宿主经 `app.updateSession` metadata 自行写 `titleKind: 'custom'`；feature-http PATCH 不写 titleKind；无 metadata 且有 title 时 `titleKindOf` 推断为 `'replaceable'`（`sessionTitle/feature.ts:158-162`） | 第 12 轮偏差⑧ |
| sessionTitle 摘录源 | `IAgentContextMemoryService + IAgentLoopService.snapshot()`：context + **active prompt** + 队列中 tracked prompt 合并（agentTitlePromptSourceService.ts:85-103）；origin 过滤为 `origin.kind === 'user'`，skill 捆绑块按 `origin.skillActivations.length` 切片剔除 | `useAgentStore().getState().history`（`sessionTitle/feature.ts:148-153`）；origin 过滤映射为 `meta.source === 'compaction'` 跳过 + `origin === undefined || kind === 'user'`（excerpt.ts:128-134），skill 块经 `stripBundledSkillBlocks`，按 `meta.userMessageId` 去重 | 设计要点（Handoff L197）+ 第 12 轮偏差⑫「语义等价、粒度更准」 |
| trace 收编与改名 | `createTracePlugin()`（human/kimi/trace.ts）——human 层 Plugin，`traceId()` 命令式读取；v2 另有 `llm-adapter/contract/request-trace.ts` 体系供 fullCompaction 的 `trace_id` 遥测消费 | `traceSlots` 作为 kimi 子 Feature（spec 名 `'trace'`，token key `'trace'`）；`x-trace-id` 捕获逻辑（`llm.streaming.headers` + `llm.failed.remote` 两事件）逐字；facade 为响应式 `Ref<string \| undefined>` | 第 14 轮用户指示「kimi-trace 收编为 kimi 子 Feature 并改名 trace」；refact-237 第一批 human 蓝本 |
| 错误体系 | Error2 + 注册错误域（`AuthErrors`/`WebErrors`，codes/details/retryable/info） | 普通 `Error` / `HttpFetchError`，用户可见文案逐字对齐 | models-dev 设计要点同款先例：「v2 Error2 错误域（feature 内 coded error 范式）」 |

### 简化 / 保真度损失

| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| ToolResult isError 通道 | WebSearch/FetchURL 失败返回 `isError: true`，contextProjector 渲染时前置 `<system>ERROR: Tool execution failed.</system>` 状态块，模型可区分业务失败与信息性输出 | 已切回：两工具错误返回标 `isError: true`（web/tool.ts、fetch/tool.ts），框架装配层统一渲染 | A 步已落地（第 76 轮） |
| 遥测未接线 | `web_fetch_fallback`（moonshot-fetch-url.ts:57-60）、`oauth_models_refresh_finished`、`oauth_login_finished`、`auth_ensure_ready_failed` | 全部不迁 | 「遥测不迁」已知批次，待 telemetry 域全面接线后补 |
| 工具审批/展示面 | `resolveExecution` 提供 `accesses`/`description`（`Searching: <q>`/`Fetching: <u>` 截断预览）/`display`（`{kind:'search',query}`/`{kind:'url_fetch',url}`）/`approvalRule` + `matchesRule`（`WebSearch(<query literal>)`、`FetchURL(<url glob>)`） | `ToolDefinition` 无此面，仅 name/description/parameters/execute | permission 域（#19）落地后接回，第 17 轮记录在案「fetch 审批规则待 permission 域」 |
| sessionTitle 请求头缺 identity | 请求头 = `parseKimiCodeCustomHeaders()` + `hostHeaders.headers`（User-Agent/X-Msh-* 设备头）+ `provider.customHeaders`（sessionTitleService.ts:121-128） | 仅 `parseKimiCodeCustomHeaders()` + `customHeaders`（`sessionTitle/feature.ts:96-99`）；sessionTitle 子 Feature 无 `identity` props 注入点 | `/tools` `chat_title` 请求不带 UA/设备头；如需对齐要给 sessionTitle 增 props（未立项） |
| keyring 存储不支持 | `OAuthRefSchema.storage` 接受 `'file' \| 'keyring'` | `OAuthTokens.resolve` 对 `storage !== 'file'` 或非法 key 返回 undefined（`oauth/tokens.ts:27-33`）——oauth 包只有 FileTokenStorage | 第 12 轮偏差③与遗留「keyring 后端不支持（oauth 包未实现）」 |
| refresh 编排的自愈逻辑 | 显式编排：用户手写 alias 保留、defaultModel dangling clamp、defaultModel/thinking.enabled 恢复、变更才写回（`providerModelsEqual` 比较）、`ModelCatalogChanged` 事件 | 依赖 provider-catalog 写回通道：生成区（aliasScope 前缀）增删自动重建、用户区天然不动；无 defaultModel clamp/thinking 恢复编排，无变更事件 | 第 12 轮遗留「login 后 provision 写 defaultModel 由宿主 `config.set`」「手写 API key managed 分支走通用 discover 无专门编排」；自愈归属宿主层 |
| 物化后 info 变更不重建 | `IProviderService.set` 触发 `onDidChangeProviders`，消费方重建 | 物化 watcher 对 `catalog.isLive(providerId)` 的条目跳过（`oauth/feature.ts:135`） | 第 12 轮偏差②「对齐既有 materialize 语义」，记录在案 |
| services 节 env overlay | `servicesCredentialEnvOverlay`（configSection.ts:82-126）：env 设 baseUrl 时整项替换为 `{baseUrl, apiKey}`（丢弃 config oauth）；env 只设 apiKey 时剥掉 oauth 字段 | 只有 envBindings 同名字段覆盖 + `stripEnv`，无字段间隔离 | 混用 env 与 config oauth 时解析结果不同（harness-core 保留 oauth 引用，token 优先于 apiKey 回落）；config 框架层差异，未立项 |
| TOML 字段级键兼容 | `servicesFromToml/toToml` 双向转换：文件 snake_case（`moonshot_search`、`base_url`、`api_key`、`custom_headers`、`oauth_host`）↔ 内存 camelCase | 节键直接用 snake_case（`moonshot_search`/`moonshot_fetch`，与 v2 文件形态一致），但 entry 内字段是 camelCase（`baseUrl`/`apiKey`/`customHeaders`）；v2 文件里的 `base_url` 等字段键经 `z.looseObject` 保留但**不读** | 第 12 轮偏差⑤「v2 snake_case 文件键保留但不识别（第 2 轮文件兼容差异延续）」；v2 配置文件迁移需改写字段键 |
| WebSearch 参数 schema 闭合性 | zod `toInputJsonSchema` 对所有 object 节点补 `additionalProperties: false` | 手写 JSON schema：FetchURL 有 `additionalProperties: false`，**WebSearch 没有**（web/tool.ts:15-21 vs fetch/tool.ts:15-22） | 与 Handoff 记录不符（第 12 轮称「参数 schema 逐字」级别的对齐未覆盖此细节）；小疏漏，建议补上 |
| 工具参数校验时机 | zod 校验在框架层（`resolveExecution(args: WebSearchInput)`），非法参数不进入 execute | execute 内容错解析：`JSON.parse(toolCall.arguments ?? '{}')`，`query`/`url` 非 string 时静默取 `''` | 新架构 ToolDefinition 模型差异（schema 只在 LLM 请求侧生效）；极端输入下行为为空串请求而非参数错误 |
| fetchChatTitle 无注入点 | v2 同样直调 oauth 包函数 | 同（`sessionTitle/feature.ts:96-99`），无 `fetchImpl` 传入 | 第 12 轮偏差⑩与遗留「`fetchChatTitle` 注入点待 oauth 包加参」，测试用 `vi.stubGlobal` |
| modelCatalog env 覆盖 | kap-server 支持 `KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS/ON_START` 覆盖 config | 未迁，只读 config 节 | 第 12 轮记录在案遗留 |
| v2 `kimiFilesBaseUrl` | files.ts 导出（anthropic provider 时补 `/v1` 后缀），生产代码无消费方（仅测试引用） | 未迁 | 死代码省略，无行为影响 |
| fullCompaction 的 trace_id | `llm-adapter` request-trace 体系把 `x-trace-id` 带进 compaction 遥测/日志（fullCompactionService.ts:252/672/780） | TraceRef 仅作 facade 出口，core 内无消费方 | 遥测批次待补 |

### 新增 / 更强

| 差异点 | 说明 |
| --- | --- |
| 工厂 props 注入 | `CreateKimiProps{oauth,web,fetch}`：`home`/`fetchImpl`/`identity` 三端口（v2 靠 DI bootstrap args + identity 节，无工厂形态）；`resolveOauthHome` 支持 `KIMI_CODE_HOME` env 回落（`oauth/tokens.ts:18-20`） |
| facade 面 | `OAuthTokensRef`（resolve/refresh——refresh 主动刷新全部 live oauth-catalog provider）、`WebSearchRef`、`WebFetchRef`、`SessionTitleRef`、`SessionTitlePromptSourceRef`、`TraceRef` 六个 `useExpose` facade + `useOauth`/`useWebSearch`/`useWebFetch`/`useSessionTitle` inject helper（v2 为 DI service accessor） |
| `OAuthTokensRef.refresh()` 主动刷新 | v2 的刷新入口是 REST 编排（`refreshOAuthProviderModels`，回 `{changed,unchanged,failed}` report）；harness-core facade 同名编排：遍历 catalog 全部 oauth-catalog provider 逐个拉取，按 config models 节 managed 分区 diff 出 kap 同形 report（feature-http `:refresh_oauth` 直接回它），成功结果一次性注入 store.pull 落盘 |
| TraceFace 响应式 | `traceId` 为 `Ref`，消费方可 watch（v2 为命令式 `traceId()` 读取） |
| 凭证解析链 | `useCredentialResolver` 贡献 oauth resolver + provider-catalog agent slot 挂载时按 defaultModel 自动 `setConfig + setRequester + setCredentialProvider`，401 恢复走 credentialsRecovery 内建链（v2 为 `ModelOAuthTokenAdapter` + model-auth 解析，无统一 resolver 注册表） |
| excerpt 纯函数出口 | `excerpt.ts` 把 `firstUserPromptTexts`/`firstTurnExcerpt`/`digestExcerpt`/`composeTitleInput` 作为纯函数导出（v2 封装在 Service 内），可独立测试复用 |
| 定时调度健壮性 | refresh 链串行 + `materializing` 集合防重入 + 启动 refresh 等 aliasScope 写回与物化排空（`runStartRefresh` 闸门，`oauth/feature.ts:86-90/156`）；timer `unref` + `pushCleanup` 随 feature 卸载清理 |

## 可配置项差异

| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| `KIMI_API_KEY` / `KIMI_BASE_URL` env | trait endpoint（llm-kimi/trait.ts:15-17） | 逐字（trait.ts:17-19） | 已对齐 |
| `KIMI_DEFAULT_BASE_URL` | `https://api.moonshot.ai/v1` | 同 | 已对齐 |
| providers 节 schema | `ProviderConfigSchema`（modelSource/baseUrl/customHeaders/defaultModel/type/apiKey/oauth/env/source，zod object + snake TOML 转换） | `CatalogProviderInfoSchema`（同字段集 + **`aliasScope` 新增**，camelCase，merge: deepMerge） | 已对齐 + 新增（aliasScope） |
| oauth ref schema | `{storage: 'file'\|'keyring', key, oauthHost?}` | `CatalogOAuthRefSchema` 逐字一致 | 已对齐 |
| models 节 managed 写入形态 | `capabilities` 字符串数组（`applyManagedKimiCodeConfig` 生成） | `capability` 对象（`managedKimiCodeModelSeed`：`image_in/video_in/audio_in/thinking/tool_use/dynamically_loaded_tools`，oauth/models.ts:4-20）+ `maxContextSize` | 人为设计（provider-catalog 域 camelCase 节决策；thinking 判定 `only/both/(undefined&&supportsReasoning)` 语义对齐） |
| thinking 节 | enabled/effort/forcedEffort/keep + `KIMI_MODEL_THINKING_EFFORT` env + stripEnv | 同（agent-core provider-catalog 提供） | 已对齐 |
| modelCatalog 节 | schema 同（refreshIntervalMs/refreshOnStart），消费在 kap-server 调度器 + env 覆盖 | schema 同；消费在 oauth feature；env 覆盖未迁 | 人为设计 + 简化（env 覆盖，第 12 轮遗留） |
| defaultModel 节 | `DEFAULT_MODEL_SECTION` 常量 + v2 各编排直写 | 第 12 轮新增标量节 `z.string().min(1)`，agent slot 挂载时消费自动绑定 | 新增 / 更强 |
| services 节 | 内存 camelCase（`moonshotSearch`/`moonshotFetch`）+ snake TOML 双向转换 + env overlay + stripEnv | snake 节键 `moonshot_search`/`moonshot_fetch` + camelCase 字段 + envBindings + stripEnv，无 overlay | 人为设计（第 2 轮文件兼容差异延续）+ 简化（overlay 未迁） |
| `KIMI_WEB_SEARCH_BASE_URL` / `KIMI_WEB_SEARCH_API_KEY` / `KIMI_WEB_FETCH_BASE_URL` / `KIMI_WEB_FETCH_API_KEY` | 四个 env 绑定（nonBlank parse） | 逐字（web/configSection.ts:10-16, 45-54） | 已对齐 |
| `KIMI_CODE_HOME` | bootstrap.homeDir 注入 | `resolveOauthHome(props.home ?? KIMI_CODE_HOME ?? ~/.kimi-code)` | 已对齐（注入点不同） |
| `KIMI_CODE_CUSTOM_HEADERS` | oauth 包 `parseKimiCodeCustomHeaders` | 同一函数（web/fetch/sessionTitle 均消费） | 已对齐 |
| identity | config `identity` 节（name/slug）+ bootstrap.args.requestHeaders → `createKimiDefaultHeaders` 等价物 | `CreateWebProps.identity`/`CreateFetchProps.identity`（`KimiIdentityOptions`）→ `createKimiDefaultHeaders`；sessionTitle 无注入点 | 人为设计（工厂 props）+ 保真度损失（sessionTitle） |
| 区域（region） | `OAuthService.getRegion()` + `KIMI_CODE_REGION_MARKER` + `kimiRegionLoginHosts` | 不迁 | 人为设计（kap-server 宿主层职责，Handoff L168） |
| experimental flag | 本族无 flag 门控 | 同 | 已对齐 |

## 工具 / 事件 / facade 面差异

**工具**：

- `WebSearch`：工具名、`web-search.md` 描述（两侧逐字节一致）、参数 `query` 及 describe 文案、输出契约（`Title:/Site:/Date:/URL:/Snippet:` 块 + `---\n\n` 分隔 + markdown 引用提醒 + 空结果 `No search results found.` + `classifySearchError` 五分类）全部逐字对齐。差异：参数 schema 缺 `additionalProperties: false`（见上表）、display/approvalRule 审批面、请求头错误对象（Error2 → 普通 Error，文案一致）、门控时机（spec freeze vs 动态重评估）。
- `FetchURL`：工具名、`fetch-url.md` 描述（逐字节）、参数 `url` + `additionalProperties: false`、输出契约（passthrough/extracted 两态 note + 引用提醒 + 空 body 文案 + `HttpFetchError`/`network error` 两族错误文案）逐字对齐；`WebFetchRef.getUrlFetcher()` 三级解析（services.moonshot_fetch > managed oauth `/fetch` > 本地抓取器）与 v2 `WebFetchService` 一致；Moonshot provider 失败静默回落本地、`X-Msh-Tool-Call-Id`、`Accept: text/markdown`、本地抓取器全细节（SSRF BlockList/localhost 拒绝/DNS fail-closed/手动 10 跳重定向每跳重校/pinned lookup/10MB/Readability+linkedom/Chrome 91 UA）一致。差异：10M 截断为工具内 `slice`（v2 经 `ToolOutputAccumulator` 10M retained，另有 50K spill 落盘属执行器层）、审批面、`web_fetch_fallback` 遥测。

**Feature 事件**：两侧本族均无自有 Feature 事件。标题写回的副作用 v2 为 `SessionMetaUpdated`（metadata 域事件），harness-core 为 `app.updateSession` 派生 `session.meta_updated`——语义对齐。

**facade 面**：

| harness-core | v2 | 对齐情况 |
| --- | --- | --- |
| `OAuthTokensRef.resolve/refresh` | `IOAuthService`（11 方法）+ `IOAuthToolkit` + `IAuthSummaryService` | 大幅收窄：login/logout/status/usage/userinfo/region/ensureReady 全部划归宿主层（人为设计） |
| `WebSearchRef.getProvider()` | `IWebSearchProviderService.getWebSearchProvider/hasWebSearchProvider` | 对齐（has 语义由 getProvider() !== undefined 承担） |
| `WebFetchRef.getUrlFetcher()` | `IWebFetchService.getUrlFetcher()` | 对齐 |
| `SessionTitleRef.generateTitle({force, source})` | `ISessionTitleService.generateTitle({force, source})` | 签名逐字对齐；in-flight 共享 Promise 去重、401 强刷重试一次、cap 200、非 force 遇 custom/generated 早退、写前再查 custom 全对齐 |
| `SessionTitlePromptSourceRef.compose(source)` | `IAgentTitlePromptSource`（firstUserPrompts/firstTurnExcerpt/digestExcerpt 三方法） | 收敛为单 compose；三态截断常量（3×400/1000、400+300、200+200/3000）与脱敏规则逐字对齐 |
| `TraceRef.traceId`（Ref） | `TracePlugin.traceId()` | 语义对齐，响应式更强 |

## 摘要

provider 族（provider/trait/schema/errors/media）与 trace 是 refact-237 第一批 human 蓝本的逐字迁移，工具契约、输出文案、脱敏规则、三级 fetcher 解析、SSRF 防护、title 生成流程等高保真对齐；oauth/web/fetch/sessionTitle 四域按第 12/13/14/17 轮的既定决策完成了形态转换。最重要的三个差异：① oauth 域大幅收窄——login/logout 设备流、usage/userinfo、ensureReady 等 kap-server 宿主职责全部不迁，core 只留 token facade + 物化 watcher + 定时调度（人为设计）；② refresh 编排载体从「直写 config 四节 + alias 保留/clamp/thinking 恢复」变为「物化 + provider-catalog 写回通道」，自愈逻辑让渡给宿主（部分记录在案遗留）；③ WebSearch 门控从 v2 的动态重评估变为 spec freeze 挂载门控，会话中途登录不再激活工具（人为设计）。最需关注的缺口：sessionTitle 请求缺 identity/UA 头且无 props 注入点（未立项）；services 节 env overlay 与 v2 TOML 字段级 snake 键不识别两处配置兼容损失（前者未立项，后者第 2 轮差异延续）；WebSearch 参数 schema 缺 `additionalProperties: false`，与 v2 及本族 FetchURL 均不一致（疑疏漏，与 Handoff「逐字」记录不符）。
