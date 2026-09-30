# models-dev：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/models-dev/`（1194 行：feature/service/models-dev/upstream/errors/index）+ 对外 REST 在 `packages/harness-core/src/feature-http/route-features/models-dev.ts`（211 行）
- agent-core-v2：`packages/agent-core-v2/src/app/kosongConfig/modelsDev.ts`（323）+ `modelsDevUpstream.ts`（205）+ `modelsDevImportService.ts`（313）+ `modelsDevImport.ts`（62，共约 903 行）；周期调度在 kap-server `services/modelCatalog/modelCatalogRefreshScheduler.ts`，REST 在 kap-server `routes/modelCatalog.ts`；`human/models-dev` 是已删除的死代码（refact-265），不迁
- 蓝本关系：v2 kosongConfig 簇是直接行为蓝本（非 refact-237 第一批 human 蓝本）；`models-dev.ts`/`upstream.ts` 纯转换层逐语义移植，service/feature 按新架构 config/facade 体系重写

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 装配形态 | App scope DI 服务 `IModelsDevImportService`（modelsDevImportService.ts:307-313 注册），IConfigService/IKosongConfigService/IModelCatalog/IAgentIdentity 四依赖注入 | app tier 工厂 `createModelsDev({ builtinCatalog?, userAgent? })` 不进 preset；config 经 `providerRef(ConfigRef)` 可选探测，缺席时 import 抛 `config.unavailable`；facade `ModelsDevRef` 经 useExpose 暴露（feature.ts:44-54） | 四项定稿①（Handoff L96）；设计要点（L207） |
| 写入 config 的记录形态 | v2 ModelRecord 开放记录（snake 倾向 + index signature，model.ts:20-49）：`capabilities` 字符串数组、`maxInputSize` 等 | camelCase `CatalogProviderInfo`/`CatalogModelConfig`（agent-core zod 严格 schema）：`capability` 布尔结构、`maxInputSize`、`displayName` 等（service.ts:433-449；models-dev.ts:320-339） | 四项定稿④「v2 的 apply/remove 读写 snake_case 配置不可复用，转换/写回在 feature 内新写 camelCase」（L96）；设计要点①「v2 ModelRecord snake 形态不迁」（L207） |
| alwaysThinking 表达 | 编码进 `capabilities` 数组：`'thinking'` 替换为 `'always_thinking'`（modelsDevUpstream.ts:185-187） | `alwaysThinking` 顶层布尔字段（models-dev.ts:335；CatalogModelConfigSchema 有该字段） | 第 56 轮偏差④在案（L344） |
| 通用协议工厂 | v2 ProviderType 是内建枚举 + 全局 adapter registry，导入即可用，无需注册 | feature app slot 用 `useProviderProtocol` 注册 openai（openAIBase+openAIResponsesBase 双协议）/anthropic/google-genai/vertexai（`createGoogleGenAIBase({vertexai:true})`）四个 type，connection 从 info 取 baseUrl/customHeaders（feature.ts:55-79）；`type:'kimi'` 由 kimi feature 注册（features/kimi/feature.ts:35） | 四项定稿②（L96）；第 56 轮（L344，vertexai 依据 v2 protocolAdapterRegistry.ts:35） |
| custom registry 转换 | v2 复用 oauth 包 `applyCustomRegistryProvider`/`removeCustomRegistryProvider`（读写 snake 形态 config，apiKey 存进 provider.source） | fetch 复用 oauth 包 `fetchCustomRegistry`，转换/写回自写 camelCase 宽容轨（默认 maxContext 131072 / 缺省 `['tool_use']`→capability 布尔；service.ts:433-476） | 四项定稿④（L96）；设计要点⑤（L207） |
| provider.source 内容 | source 含 apiKey 明文：`applyCustomRegistryProvider` 把 `{kind,url,apiKey}` 整体塞进 `provider.source`（oauth custom-registry.ts:318-323），刷新器从 source 读回 apiKey（refreshProviderModels.ts:118-128） | source 只写 `{kind:'apiJson', url}`（service.ts:408-413），apiKey 只存 provider 顶层 `apiKey` 字段；刷新 key 从顶层读（registryKeyFromExisting，service.ts:424-431） | 设计要点⑤「providers 节条目带 source:{kind:'apiJson', url} 标记」（L207）。注：oauth 包刷新器要求 source.apiKey 为 string，故 harness-core 写的条目不被 v2 系刷新器认领（反向兼容成立）；同一 config 文件跨架构共享时单向可见 |
| 内置快照兜底 | 构建期内嵌 `BUILT_IN_MODELS_DEV_JSON` + 模块级 memo（modelsDevUpstream.ts:21-28,102-105） | props 端口 `builtinCatalog?: () => unknown`，宿主构建期注入 JSON；缺省无兜底，fetch 失败抛 `modelsDev.catalog_unavailable`（upstream.ts:66-78） | 设计要点②「不恢复 v2 tsdown define 全局耦合」（L207） |
| 周期刷新归属 | kap-server `ModelCatalogRefreshScheduler`：启动时读一次 modelCatalog 节（env `KIMI_CODE_MODEL_CATALOG_REFRESH_*` 优先），调 `IProviderDiscoveryService.refreshProviderModels({scope:'all'})`——覆盖 custom registry + OAuth catalog 等全部非 static provider | feature 自排定时器：`watch` modelCatalog 节，变更即清旧 timer 重排；`refreshOnStart`（默认 true）经根 `ready()` 门控启动刷新一次，`refreshIntervalMs`（默认 6h，≤0 停）setTimeout 链 + pushCleanup（feature.ts:80-122）；只刷 custom registry（`refreshRegistries`，service.ts:338-359），OAuth 部分由 oauth feature 各自独立消费同节 | 设计要点⑤（L207）；第 56 轮（L344） |
| 错误域 | v2 `Error2` + `ModelsDevImportErrors.codes` 五码 | feature 内 coded error `ModelsDevError`（errors.ts:1-23）：五码对应 + 新增 `config.unavailable`；路由层映射为 v2 同数值码（catalog.ts:159-185） | 设计要点不迁项「v2 Error2 错误域（feature 内 coded error 范式）」（L207） |
| REST 面 | kap-server：`GET /catalog/providers`、`GET /catalog/providers/{catalog_id}`、`POST /providers:{refresh|refresh_oauth|import_catalog|import_registry}` 四 action | feature-http catalog.ts：`GET {prefix}/catalog/providers`、`GET {prefix}/catalog/providers/:catalog_id`、`POST {prefix}/providers:{import_catalog|import_registry}` 仅两 import action；list 响应 `{items}`、import 201 `{provider(s), models_imported}`、body/字段 snake（catalog_id/id/api_key/base_url/url）与 v2 一致 | 四项定稿③+设计要点⑥（L96/L207，「JSON 形状保持 v2 snake 字段」；:refresh 系不在定稿范围） |
| User-Agent | 恒取 `IAgentIdentity.outboundUserAgent`（modelsDevImportService.ts:54-56） | 可选 props `userAgent`，缺省请求不带 UA 头（upstream.ts:55-56） | 设计要点工厂 props（L207） |
| 写通道 | `config.inspect().userValue` 读 user 层快照 + `config.replace` 多次落盘（importProvider 三次、importRegistry 四次） | `config.get` 读 delivered 值 + `config.set(providers 节 deepMerge)` / `config.replace` 一次落盘；两侧都有串行 write chain（service.ts:97-106 vs modelsDevImportService.ts:87-94） | 新架构 ConfigStore 语义（providers 节带 `merge: deepMerge`，configSections.ts:116；models 节整节替换）——第 56 轮编排者核实「deepMerge undefined patch 覆盖生效」与「replace 按名整节替换」（L344） |
| models.dev 导入重写 provider 条目 | 整对象替换 `{type, baseUrl, apiKey}`，旧字段随替换消失 | `rewrittenProviderInfo` 显式把 customHeaders/defaultModel/oauth/env/modelSource/aliasScope 置 undefined，经 deepMerge patch 清除 | 第 56 轮偏差①在案（防 stale `source` 致该 provider 被 registry 刷新误管，L344） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| import 响应 provider 字段 | 经 `modelCatalog.getProvider` 读回 live `ProviderCatalogItem`：`{id,type,base_url?,default_model?,has_api_key,status:'connected'\|'error'\|'unconfigured',models?}`（modelsDevImportService.ts:176-177；catalog.ts:72-81） | 自建 `ModelsDevImportedProvider`：`{id,type,base_url?,has_api_key,models}`，无 `status`/`default_model`（service.ts:47-53,196-203） | 调用方拿不到连接状态与默认模型；第 56 轮偏差③在案（「status/default_model 需 live store 状态未含」，L344） |
| 显式 `type:'openai_responses'` 条目 | v2 内建 wire type，导入即可物化 | 不作为独立 type 注册（仅作为 openai type 下 protocol），导入后写进 config 但不物化 | 该 type 的 models.dev 条目导入后不可绑定使用；第 56 轮偏差⑤在案（「需宿主另注册…记录在案未擅自加挂」，L344） |
| 跨协议 override 模型 | 模型级 provider override 产生的 `protocol:'anthropic'` 记录由 v2 全局 adapter registry 解析 | `resolve` 返回 undefined（不物化） | 同偏差⑤在案 |
| oauth_managed 错误文案 | `provider X is managed by OAuth login; use POST /oauth/logout instead`（modelsDevImportService.ts:151,216） | `provider X is managed by OAuth login`（service.ts:167,232），丢后缀指引 | 文案级损失；Handoff 未记录（声称「错误映射对齐 v2」指码与数值，非文案逐字） |
| capability 表达面 | v2 capabilities 字符串数组可表达 `image_out`/`audio_out`（capabilitiesFromCustomEntry，oauth custom-registry.ts:268-271） | `CatalogModelConfig.capability` 布尔结构仅 image_in/video_in/audio_in/thinking/tool_use/dynamically_loaded_tools；registry 转换丢 image_out/audio_out（service.ts:468-476） | 声明输出模态的 registry 模型丢失该元数据；未在案 |
| memory 覆盖层烘入 user 文件 | v2 `inspect().userValue` 只读写 user 层，memory 层不参与 | 新 ConfigStore 无 `inspect.userValue`，`config.get` 返回 delivered（memory 覆盖优先），整节 `config.replace` 会把 memory 覆盖层烘进 user 文件 | 宿主若用 memory target 调过 providers/models/defaultModel，import/refresh 后其值被固化到用户配置；第 56 轮偏差⑦在案（架构限制，非语义改变，L344） |
| `KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS` / `_ON_START` env | kap-server 调度器支持 env > config 优先（modelCatalogRefreshScheduler.ts:73-88） | 不迁，只看 modelCatalog 节 | env 覆盖场景失效；设计要点不迁项 + 第 56 轮遗留（L207/L344，「第 12 轮已记遗留」） |
| 刷新可见性 | v2 刷新发布 `ModelCatalogChanged` 事件，`:refresh` 路由返回 `{changed,unchanged,failed}` DTO | `refreshRegistries` 返回 void，单 url 失败静默 `.catch(() => {})`（service.ts:352-358），无事件无 DTO；`:refresh`/`:refresh_oauth` 无路由 | 刷新结果不可观测（只能靠 config.changed 泛化信号）；refresh 路由缺省属四项定稿范围外，事件/DTO 未在案 |
| 周期刷新覆盖面 | 一次调度刷全部非 static provider（registry + OAuth catalog + discover） | models-dev 定时器只刷 custom registry；OAuth catalog 由 oauth feature 自理（第 12 轮已迁）；generic `/models` discover 第 57 轮核查确认 v2 亦仅 schema 声明、无运行时消费方（L345） | 划分在案（设计要点⑤「与 oauth feature 各自独立消费同节」）；registry 之外的刷新时序由两个 feature 各自的定时器决定，不再统一 |

### 新增 / 更强
| 差异点 | 说明 |
| --- | --- |
| 悬空 defaultModel 清理 | `writeRegistrySections`：当前 defaultModel 指向的 alias 在刷新/导入后的 models 节里消失即清（service.ts:490-510）。v2 仅在 provider 被删除时经 `removeCustomRegistryProvider` 清（oauth custom-registry.ts:371-393），上游模型消失而 provider 存活时 v2 留悬空 defaultModel。第 56 轮在案（L344「悬空 defaultModel 清理」） |
| `config.unavailable` 错误 + MODELS_DEV_UNAVAILABLE 40938 | config feature 未挂载 / facade 未安装时返回显式 409（catalog.ts:140-157,177-180）；v2 DI 恒在无此场景 |
| 定时器响应节变更 | `watch` modelCatalog 节：改 refreshIntervalMs/refreshOnStart 即清旧 timer 按新值重排（feature.ts:89-121）；v2 调度器只在启动时读一次，改配置需重启进程 |
| 同 url 多 apiKey 尝试 | refresh 按 url 分组收集全部顶层 apiKey（去重）逐个 fetch，成功即停（service.ts:342-357,274-291）；对齐 v2 oauth 包 credentialKey 分组逐个尝试（refreshProviderModels.ts:138-159），不弱 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| `modelCatalog.refreshIntervalMs`（默认 6h，int≥0） | schema 同（configSection.ts:341）；kap-server 调度器消费 | schema 同（agent-core configSections.ts:106）；feature watch 消费 | 已对齐（消费方不同属人为设计） |
| `modelCatalog.refreshOnStart`（默认 true） | 同（configSection.ts:342） | 同，经根 `ready()` 门控（feature.ts:97-107） | 已对齐 |
| env `KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS` / `_ON_START` | 支持，env > config | 不迁 | 简化（在案遗留） |
| `providers` / `models` / `defaultModel` 三节 | 同名三节（configSection.ts），snake/开放记录形态 | 同名三节（agent-core configSections.ts:5-13），camelCase 严格 schema | 节名已对齐；记录形态为人为设计 |
| `MODELS_DEV_URL` / 10min TTL / 10s 超时 / 6h 默认间隔 | 同（modelsDevUpstream.ts:17-19；调度器 :10） | 同（upstream.ts:6-9；feature.ts:27） | 已对齐 |
| `PROVIDER_ID_PATTERN` | `/^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u`（modelsDevImport.ts:24） | 逐字同（service.ts:38） | 已对齐 |
| 工厂 props | 无（DI 注入：IAgentIdentity 的 UA、内嵌 JSON） | `createModelsDev({ builtinCatalog?, userAgent? })` | 人为设计（端口化） |
| browse DTO（list/get） | `{id,name,wire_type,guessed,needs_base_url,rejected,reject_reason,env_key,models[{id,name?,max_context_size,capabilities?,reasoning}]}` | 逐字段同（models-dev.ts:341-424）；`toModelItem` 恒带 `name` 键（可能 undefined，JSON 序列化后消失，wire 等价） | 已对齐 |
| import 请求体 | snake：`catalog_id/id/api_key/base_url`、registry `url/api_key` | 同（catalog.ts:124-138） | 已对齐 |
| import 响应体 | 201 `{provider: ProviderCatalogItem, models_imported}` / `{providers, models_imported}` | 201 同形，provider 为可重建子集（缺 status/default_model） | 简化（偏差③在案） |
| registry 存储标记 | `provider.source = {kind:'apiJson', url, apiKey}`（apiKey 明文入 source） | `provider.source = {kind:'apiJson', url}`，apiKey 仅在顶层 | 人为设计（设计要点⑤）；跨架构读取单向兼容 |
| 错误码数值 | CATALOG_UNAVAILABLE 50004 / CATALOG_ENTRY_NOT_FOUND 40417 / CATALOG_IMPORT_INVALID 40004 / REGISTRY_IMPORT_INVALID 40005 / PROVIDER_OAUTH_MANAGED 40003 | 同数值 + MODELS_DEV_UNAVAILABLE 40938（L344；40926→40938 改号见 feature-http.md「错误码号段约定」行） | 已对齐 + 新增 |

## 工具 / 事件 / facade 面差异
- 工具：两侧均无工具。
- Feature 事件：两侧均无 models-dev 自有 Feature 事件；v2 的 `ModelCatalogChanged` 属 discovery 服务（refresh 通路），harness-core 无对应（见「简化」表）。
- facade：v2 `IModelsDevImportService` 四方法（listModelsDevProviders/getModelsDevProvider/importModelsDevProvider/importCustomRegistry）；harness-core `ModelsDevRef`/`ModelsDevFace` 五方法（listProviders/getProvider/importProvider/importRegistry + **refreshRegistries**——v2 的 refresh 在另一服务 `IProviderDiscoveryService`，harness-core 收进同一 facade）。REST 面 v2 多 `:refresh`/`:refresh_oauth` 两 action。

## 摘要
纯转换层（三态决议、wire 推断、模型过滤、capability/thinking 映射、upstream 拉取缓存兜底）与 browse DTO 基本逐语义对齐，主要分叉在三处人为设计：记录形态 camelCase 化（v2 snake ModelRecord/开放记录不迁）、通用协议工厂以 useProviderProtocol 取代内建枚举、周期刷新从 kap-server 调度器改为 feature 自排定时器且范围收窄到 custom registry。最需关注的缺口：① import 响应 provider 缺 status/default_model（在案）；② 显式 openai_responses type 与跨协议 override 模型不物化（在案，需宿主另注册）；③ 整节 replace 会把 memory 覆盖层烘进 user 文件（在案架构限制），外加 `KIMI_CODE_MODEL_CATALOG_REFRESH_*` env 与 refresh 可观测性（事件/DTO/路由）未迁。
