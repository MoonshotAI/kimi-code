# 自定义 Provider 功能方案

> 设计文档，自包含。调研结论见 §1（含文件:行号，实施时不必重查）。
> 涉及两个仓：本仓（code-app，desktop/web 客户端）与 `kimi-code` 核心仓（kap-server / agent-core，以 submodule 引入）。kimi-code 侧改动按双仓工作流在工作克隆里做，本仓只 bump submodule 指针。

## 1. 现状（调研结论）

### 1.1 Core 已具备的能力（kimi-code 仓，无需新建）

- **配置层**：`~/.kimi-code/config.toml`。provider 支持 6 种 wire 协议 `kimi / openai / openai_responses / anthropic / google-genai / vertexai`（`packages/agent-core/src/config/schema.ts:6-13`）；每 provider 可配 `api_key / base_url / default_model / custom_headers / env`（schema.ts:27-36）；模型 alias 形如 `<providerId>/<modelId>`（schema.ts:40-94）。凭据不读 shell 环境变量。
- **models.dev 目录**：`fetchCatalog()` 拉 `https://models.dev/api.json`（`packages/node-sdk/src/catalog.ts:41`）；`resolveCatalogImport()` 决策 wire 协议/baseURL，未知协议兜底 OpenAI 兼容（`packages/kosong/src/catalog.ts:188`）；`applyCatalogProvider()` 写配置（node-sdk/catalog.ts:130）。CLI 有构建期内置快照（`__KIMI_CODE_BUILT_IN_CATALOG__`）。
- **api.json custom registry**：models.dev 同构私有目录，`Bearer` 鉴权拉取，URL 为稳定身份（`packages/oauth/src/custom-registry.ts:15`）；`applyCustomRegistryEntries()` 重导入语义（同 URL 缺失条目删除，:416）；`refreshProviderModels()` 统一编排三类来源（`packages/oauth/src/refreshProviderModels.ts`），server 有定时刷新调度。
- **运行时**：provider 解析/实例化/401 刷新重试全自动（`agent-core/src/session/provider-manager.ts`、`kosong/src/providers/index.ts`）。

### 1.2 Server（kap-server）API 面：读全、写缺

已有（REAL）：`GET /v1/auth`、`GET /v1/models`、`GET /v1/providers[{id}]`、三个 `:refresh`、`POST /v1/models/{id}:set_default`、OAuth device-flow 系列、`POST /v1/config`（通用写配置，**deep-merge 持久化到 config.toml，不能删 key**，GET 时 api_key 脱敏为 `has_api_key`）。

缺口：

- `POST /v1/providers`、`DELETE /v1/providers/{id}` **不存在**；web-core client 里对应方法是标注 "PRESUMED" 的桩（`packages/web-core/src/api/daemon/client.ts:1232,1247`），调了 404。
- server 不透出 models.dev 目录，无 catalog 浏览/导入端点，无 custom registry 导入端点。
- WS 无 model/provider 控制消息。

### 1.3 客户端：地基完好，入口被摘

- `ProviderManager.vue`（desktop/web 同步副本，内容一致）是**完整成品**：列表（status dot/type/baseUrl/hasApiKey badge/modelCount）、刷新、删除、添加表单、OAuth 快捷按钮；`App.vue` 接线齐全（`openProviders` :520、`handleAddProvider/handleRefreshProvider/confirmDeleteProvider` :562-601、模板 :1197-1208）；i18n 全套（`packages/web-i18n/src/locales/{en,zh}/providers.ts`）。**但全仓无一处触发 `openProviders` emit**（`SettingsDialog.vue:59` 只有声明），是 dead path。
- 表单 type 枚举写死 `['moonshot','anthropic','openai','custom']`，与 daemon 的 6 种不对应——add 路径是半成品。
- 登录只有 Kimi 账号 OAuth；onboarding 登录步只有一张卡片，三方入口位置已留（`OnboardingLoginStep.vue:93` TODO 注释）。
- 模型选择：Composer pill 快选 + `ModelPicker.vue` 全量弹窗（`GET /v1/models`，切换走 `POST /v1/sessions/{id}/profile`）。

## 2. 目标 / 非目标

**目标**

1. 用户能在 desktop/web 设置页管理 provider：查看、手动添加（api key + base url + 模型）、删除、刷新。
2. 用户能从 models.dev 目录浏览并一键导入 known provider（TUI `/provider` known 路径的 GUI 等价物）。
3. 用户能导入 custom registry（api.json URL + token）（TUI custom 路径的 GUI 等价物）。
4. onboarding 登录步开放「三方 API」入口（**最后一期才做**，前期不动 onboarding）。
5. 添加后立即可在 ModelPicker / Composer 选到新模型。

**非目标**

- 不改 core 的 provider 解析/运行时行为；不动 OAuth managed 登录流程。
- 不做独立凭据存储（与 TUI 一致，api key 明文写 config.toml；server 不新增凭据端点）。
- 不做 provider 级编辑 UI 的全字段覆盖（custom_headers、env 等高级字段本期不暴露，手改 config.toml 的用户不受影响）。
- web 端不回填 desktop 原生功能；本功能两端共有，但 **web 同步放最后一期**——desktop 体验验收满意前，web 保持现状（仅 Kimi 登录）。

## 3. 关键架构决策

### 决策 1：写面放 server 新端点，不用 `POST /config` 裸写

- `POST /config` 是 deep-merge，**无法删除** provider；凭据明文、模型 alias 批量写入、重导入语义都需要编排逻辑，放每个客户端各写一遍必然分叉。
- web-core client 已有 `addProvider/deleteProvider` 桩等着接（§1.2），端点补上客户端即通。
- 所有写逻辑在 server 侧直接复用 core 的 `applyCatalogProvider` / `applyCustomRegistryEntries` / `resolveCatalogImport`，与 TUI 行为同源。

### 决策 2：models.dev / api.json 获取放 server 代理，不放客户端

- web 端是纯浏览器，直连 models.dev 有 CORS 风险；desktop 外部 server 模式下主进程与 server 可能不同机。
- core 的目录归一化逻辑（`resolveCatalogImport` 等）在 kosong 包，server 在 kimi-code 仓内可直接依赖；客户端（本仓）只能经 `@moonshot-ai/*` 包名 import，而 node-sdk 是 v1 进程内 SDK，不适合 renderer/主进程引用。
- server 代理后，desktop、web、外部 server 模式、未来的其他客户端全部受益。

### 决策 3：UI 复用 ProviderManager，加「添加向导」而非新页面

- ProviderManager 列表/刷新/删除是成品，复活入口即可；只把半成品 add 表单替换为三步向导（选来源 → 填信息 → 选默认模型）。
- onboarding 三方卡片复用同一向导组件，避免两套实现。

## 4. 接口设计（kimi-code 仓 kap-server）

路由挂在 `packages/kap-server/src/routes/modelCatalog.ts`（现有 provider/model 路由同文件），schema 放 `packages/kap-server/src/protocol/rest-modelCatalog.ts`。错误码沿用数字风格（已有 `40101` 未授权、`40412` provider-not-found）。

### 4.1 创建 provider（手动）

```
POST /api/v1/providers
```

请求：

```jsonc
{
  "id": "my-openai",              // 必填；字母/数字（含中文等 Unicode）+ - _ 空格，冲突报 409xx
  "type": "openai",               // 必填，6 种 wire 协议之一
  "api_key": "sk-...",            // 可选（vertexai 等走 env 的可缺省）
  "base_url": "https://...",      // 可选；openai/openai_responses/anthropic 缺省时用协议默认端点
  "default_model": "gpt-4.1",     // 可选
  "models": [                     // 必填，至少 1 个；写为模型 alias <id>/<model>
    { "model": "gpt-4.1", "max_context_size": 1047576,
      "display_name": "GPT-4.1",  // 可选
      "capabilities": ["vision"], // 可选
      "max_output_size": 32768,   // 可选
      "support_efforts": ["low", "high"],  // 可选
      "adaptive_thinking": true }          // 可选（Anthropic 协议画像覆盖）
  ]
}
```

响应 `201`：`ProviderCatalogItem`（同 `GET /providers` 单项，api_key 脱敏为 `has_api_key: true`）。

行为：写入 config.toml（`providers[id]` + `models["<id>/<model>"]`），经 `IConfigService.set` 持久化；`default_model` 若提供则校验 ∈ models；成功后物化 `IModelCatalog` 失效缓存（config.changed 已有机制）。**全新配置下播种全局默认模型**（2026-07-24 补）：当全局 `default_model` 未设置时，播种为本 provider 的默认模型（未指定则第一个模型）——否则新 HOME 添加首个 provider 后 `GET /auth` 恒 `ready: false`、新会话无默认模型；已有指针（哪怕悬空）绝不动。`:import_catalog` / `:import_registry` 同规则（播种各自导入的第一个模型）。

错误：`400xx` 校验失败（zod 明细）；`409xx` id 已存在。

### 4.2 删除 provider

```
DELETE /api/v1/providers/{provider_id}
```

响应恒 `204`（无 body）。行为：删除 `providers[id]` 及全部 `models["<id>/*"]` alias（config 删除在 server 内部用整段 replace 实现，绕过 deep-merge 限制）。**永远不动 `default_provider` / `default_model`**——指针是用户的设置，即使悬空也保留（产品决策，2026-07-23 评审）。

错误：`40412` provider-not-found；`40003` 删除 managed OAuth provider（kimi 托管登录的 provider 禁止经此删除，走 `/oauth/logout`）。

### 4.3 models.dev 目录浏览（代理）

```
GET /api/v1/catalog/providers
GET /api/v1/catalog/providers/{catalog_id}
```

响应（精简目录，不原样透传；条目保持上游目录顺序）：

```jsonc
{ "items": [
  { "id": "openai", "name": "OpenAI",
    "wire_type": "openai",        // resolveCatalogImport 的决策结果；rejected 时为 null
    "guessed": false,             // true = 协议来自 OpenAI 兼容兜底推断，非目录声明
    "needs_base_url": false,      // true 时导入必须填 base_url
    "rejected": false,            // true（如 Bedrock）时前端置灰，带 reason
    "reject_reason": null,        // unknown-explicit-type / proprietary-sdk / empty-base-url / placeholder-base-url
    "env_key": "OPENAI_API_KEY",  // 提示用户该 provider 约定的凭据环境键
    "models": [ { "id": "gpt-4.1", "name": "GPT-4.1", "max_context_size": 1047576,
                  "capabilities": ["image_in", "tool_use"], "reasoning": false } ] } ] }
```

行为（`kap-server/src/catalogUpstream.ts`）：server 内存缓存（TTL 10 min）+ 网络失败回落过期缓存，再失败回落内置快照（kap-server 构建期经 tsdown define 注入 `__KIMI_CODE_BUILT_IN_CATALOG__`，复用 CLI 的 `apps/kimi-code/scripts/built-in-catalog.mjs` 机制）；全部失败 → `50004 CATALOG_UNAVAILABLE`。归一化决策（`resolveCatalogImport` / `catalogProviderModels`）直接依赖 `@moonshot-ai/kosong`，与 TUI 同源；node-sdk 是 v1 进程内 SDK 不引入，fetch/快照解析/alias 构造的胶水在 kap-server 内重实现。

### 4.4 从目录导入

```
POST /api/v1/providers:import_catalog      // 实现上并入 /providers:action 路由
{ "catalog_id": "openai", "api_key": "sk-..." }   // base_url / id 可选，省略而非 null
```

> 落地修正：find-my-way 不允许在段内参数路由 `/providers:action` 旁注册同位静态路由 `/providers:import_catalog`，故 `:import_catalog` 作为 collection action 并入该路由（body 为该 action 专用，`:refresh` 系无 body/空 body `{}` 也放行；缺 `catalog_id` → `40001`）。wire 路径不变。

行为：`resolveCatalogImport` → 整段 replace 写 config（providers + models 两段；alias record 字段与 TUI 的 `catalogModelToAlias` 完全一致：context/output/capabilities/displayName/reasoningKey/supportEfforts/offEffort/protocol/baseUrl）；`id` 可覆盖目录 id；**重导入同 id = 刷新语义**（整段重写，旧字段/旧 alias 真删，与 TUI 一致）——同 id 不报 409，前端用列表预检提示「将覆盖」；同 id 为 managed OAuth → `40003`。响应 `201`：`{ provider: ProviderCatalogItem, models_imported: number }`。**绝不动 `default_provider` / `default_model`**（与 §4.2/§4.7 同原则；core 的 `applyCatalogProvider` 会设默认，故不使用，写逻辑在路由内自行编排）。

错误：`40004 CATALOG_IMPORT_INVALID`（条目 rejected / needs-base-url 缺 base_url / base_url 为空串或含 `${}` 占位 / 目标 id 不合 providerIdSchema / 无可导入模型；URL 格式本身不校验，与 TUI 同源容忍）；`40416 CATALOG_ENTRY_NOT_FOUND`；`50004 CATALOG_UNAVAILABLE`。

### 4.5 导入 custom registry（api.json）

```
POST /api/v1/providers:import_registry     // 实现上并入 /providers:action（同 §4.4 落地修正）
{ "url": "https://internal.example.com/api.json", "api_key": "tok-..." }
```

行为（已落地）：直接复用 core 的 `fetchCustomRegistry`（拉取 + 校验 + Bearer 鉴权，无效条目跳过）与 `applyCustomRegistryEntries`（重导入语义：同 URL 旧条目缺失即删，URL 为稳定身份；列中的 provider 先删再建整段重建）——在**不带默认指针**的 in-memory shape 上 apply（同 discoveryService 的 exclusion 思路），core 的删除逻辑因此永远碰不到 `default_provider` / `default_model`，与 Phase 1/2 原则一致。provider record 带 `source` blob（`{kind:'apiJson', url, apiKey}`）落盘，v2 定时刷新调度经它重新发现 registry。条目 id 命中 managed OAuth → `40003`。响应 `201`：`{ providers: ProviderCatalogItem[], models_imported: number }`。

错误：`40005 REGISTRY_IMPORT_INVALID`（URL 不可达 / HTTP 错误 / 文档非 JSON / 无有效条目）；缺 `url` → `40001`。kap-server 新增依赖 `@moonshot-ai/kimi-code-oauth`。

### 4.6 客户端层（本仓 web-core）

`packages/web-core/src/api/daemon/client.ts`：

- `addProvider` / `deleteProvider` / `updateProvider`：前两个是对齐 §4.1/4.2 真实端点实现的原 PRESUMED 桩（已改 REAL），`updateProvider` 对齐 §4.7。
- 新增 `listCatalogProviders()` / `getCatalogProvider(id)` / `importCatalogProvider(req)` / `importCustomRegistry(req)`（均已随 Phase 2/3 落地）。
- Wire 类型放 `packages/web-core/src/api/daemon/wire.ts`（snake_case），App 类型放 `api/types.ts`，与 server zod schema 对齐。

### 4.7 编辑 provider（替换式，Phase 1 追加）

```
PUT /api/v1/providers/{provider_id}
{ "type": "openai", "base_url": "...", "api_key": "...", "default_model": "...", "models": [...] }
```

- 整体替换语义：body 省略的字段（`api_key` 除外）即从配置中清除。
- **可选 `new_id` 改名**：providers key、全部模型 alias、`default_provider`、指向旧 alias 的 `default_model`（按旧 record 的裸模型名重指到新 alias；模型被删则指针悬空保留）全部迁移；目标 id 冲突 → `40921`。
- **`api_key` 三态**：缺失 = 保留现有；`""` = 清除（落盘 `api_key = ""`，core 运行时按无凭据处理，与 authService 既有惯例一致）；非空 = 替换。
- 模型 alias 按 `record.provider === id` 归属整段重建：**表单字段覆盖、其余字段随旧 record 保留**（`betaApi` / `reasoningKey` / `protocol` / per-model `baseUrl` / `overrides` / `defaultEffort` / `maxInputSize` 等表单不认识的字段不会因保存丢失）；只有被删行的 record 真删。
- **除改名迁移外，绝不动 `default_provider` / `default_model`**（§4.2 同）。
- managed OAuth → `40003`；不存在 → `40412`；校验失败 → `40001`。响应 `200 { provider }`。

### 4.8 单个查询返回 api_key（编辑预填，Phase 1 追加）

`GET /api/v1/providers/{provider_id}` 的响应在设置时附带 `api_key` 明文，供本地客户端编辑表单预填（loopback + Bearer 传输，TUI 本就直读 config.toml）。**列表接口与 `/config` 仍只返回 `has_api_key`，不脱敏范围不扩大**；`api_key = ""`（已清除）时不返回该字段。

### 4.9 写路径的磁盘一致性（深度评审后加固）

评审发现 kap-server 的写路由建立在「whole-section replace 能删字段」的错误假设上：`providers`/`models` 的 TOML 变换重建 entry 级结构，但 entry 内字段 overlay 到旧磁盘 raw——entry 级删除有效，**字段级删除只生效于内存，重启后旧值复活**。围绕该机制的最终语义：

- **字段级清除 = 显式 `undefined` 赋值**（变换的 `setDefined` 遇 undefined 真删），PUT 的 provider（apiKey 三态/baseUrl/defaultModel）与 alias（5 个表单字段）按此实现；同时修复了 agent-core-v2 `modelsToToml` 的 `{...raw, ...converted}` 合并顺序（spread 会放回 setDefined 刚删的键——core 侧 bug，一并修掉并全量回归）。
- **PUT 的 provider record 合并语义**：以旧 record 为底（`custom_headers`/`env`/registry `source` blob 等表单不认识的字段保留），表单字段权威覆盖/清除——与 alias 的合并语义对齐；registry 导入的 provider 经 GUI 保存后仍能被定时刷新与「同 URL 缺失即删」追踪。
- **import 刷新 = 两阶段落盘**（先删 provider 的 aliases/entries，再写入新记录），同 key 的旧字段无 raw 可 overlay；与 core 的 remove-then-apply 语义一致（手改不保留，merge 只在定时刷新路径生效）。
- **import 的 `api_key` 与 PUT 同三态**：省略 = 保留已存 key（catalog 取目标 provider 现值；registry 继承同 URL 旧 `source` blob 的 key），`""` = 清除，非空 = 替换——重导入刷新不再静默丢凭据。
- **写路由互斥**：create/replace/delete/import_catalog/import_registry 共享进程内 promise 链（`enqueueProviderWrite`），inspect → build → replace×N 的多步序列不被并发请求插入；refresh 走 discoveryService 自有链。
- **杂项加固**：catalog 查找走 hasOwnProperty（原型链 id 不再幻影命中）；registry 拉取与 catalog 同 10s 超时；registry 同 URL 删除跳过 OAuth 化 provider；目录上游错误文本截断 300 字符（防 Bearer 回显）；import 目标 id 过 `providerIdSchema`；手动写路径 `base_url` trim + 拒 `${}` 占位 + `models[].model` 唯一性校验（40001）。

**已知残留（core 存量，不在本 PR 范围）**：定时刷新路径（discovery/scheduler）的字段级删除同样不落盘（上游删字段后旧值仍在磁盘），需 core 层另立修复；`POST /config` 的 deep-merge 语义不变。

## 5. 页面设计（本仓，仅 desktop；web 最后同步）

设计系统约束：所有样式取 `style.css` token，遵循 `DesignSystemView.vue`；新增/改动的 UI 需亮暗双主题验证 hover/focus；文案双语走 `packages/web-i18n`。

### 5.1 设置页新增 Providers tab（定稿，替代弹窗方案）

> 设计定稿：曾按「agent tab 加入口行 + ProviderManager 弹窗」实施，评审后否决（弹窗套弹窗）。改为设置页独立 tab；面板形态经原型对比（`docs/designs/providers-tab-proposals.html`）从 Master-Detail 迭代为手风琴行内展开（方案 F，见 §5.2）。

`SettingsDialog.vue` tabs 数组在 `account` 后新增 `providers` tab，对应 section 渲染新组件 `ProvidersPanel.vue`（`apps/desktop/src/renderer/components/settings/`）。原 `ProviderManager.vue` 弹窗及 `App.vue` 相关接线全部撤除。

### 5.2 ProvidersPanel：手风琴行内展开（最终定稿 F）

> 定稿过程：B（Master-Detail）在实机验证中右栏过窄（内容区 ~760px，双栏分割后表单仅 ~450px，模型行输入框截断），改为 F。原型对比见 `docs/designs/providers-tab-proposals.html` 方案 F。

单一交互「行 + 原地展开」，查看 = 编辑 = 添加共用：

- **列表**：全宽 settings-group；每行 = id + type badge（managed 加「OAuth」badge）+「N 个模型」+ chevron；按 id 字典序。**无状态点、无 key 状态 badge**（评审后移除，状态信息在展开表单内表达）。
- **原地展开**：点击行在下方展开统一纵向表单（字段同下），吃满内容宽度；互斥手风琴（同时只展开一个）；`grid-template-rows 0fr→1fr` 过渡，增删模型行高度自适应；展开行 chevron 旋转 + 淡色背景。
- **统一表单**：名称（即 provider id，**可编辑**——改名走 `PUT new_id`，server 迁移 providers key / 模型 alias / 默认指针，目标冲突返回 40921 于 banner 展示；id 规则与 server 一致：字母/数字（含中文等 Unicode）+ `-` `_` 空格；managed 整体只读除外）、API 协议 select（6 种 daemon type）、API Key 密码输入框（**add 必填**；managed → disabled +「OAuth 托管登录」placeholder；**编辑时经单查接口预填真实 key**（§4.8），右侧眼睛图标切换明文/掩码便于核对；**edit 时 apiKey/baseUrl 均非必填**——空 key = 保留或清除（keyLoaded 决定），空 baseUrl = 清除，env 凭证类 provider 因此可编辑；加载成功后字段所见即所得——清空保存 = 清除 key（`api_key: ""`），未加载到时保持「留空 = 保留」；`apiKeyTouched` 防止慢返回的预填覆盖用户输入；保存后重新拉取并重置该状态）、Base URL（**add 必填**）、模型子表单（模型 ID* / 上下文* / 显示名 + 删行按钮，可增行，至少一行；**capabilities/efforts 等高级字段不提供编辑 UI**——新建模型默认写 `capabilities: ["tool_use","thinking"]` 与 `adaptiveThinking: true`，空能力/档位列表省略不持久化；已有 record 的全部高级字段经 server 合并语义原样保留；**模型行数据源为 `GET /config` 的 models 记录——record 的 `model` 字段是裸远端模型名，绝不显示 `<prefix>/<model>` alias**，prefix 只是 alias key 的命名方案，可能与 provider id 不一致）、错误 banner。**无默认模型字段**——provider 级 default_model 的保留以 **`GET /config` 的 provider 记录**（alias 形态剥首段前缀为裸名回传）为准，绝不用 `GET /providers` 的 materialized `default_model`（它会回落为全局默认，回传即污染为 provider 级默认）；仍在新模型列表则回传保留，否则丢弃由 server 清除；删除确认条的模型数以落盘记录为准；无「留空则…」提示文字。**保存成功弹 success toast（`已保存`）**。
- **footer 三态**：新建 → 取消 +「添加 Provider」(primary)；已有非 managed → 左「删除 Provider」(danger) + 右「保存」(primary)，删除就地变行内确认条（不弹窗）；managed → 全表单 disabled + 底部 faint 小字「托管 Provider 在账户页登录 / 登出」。**按钮不带 loading spinner**（提交中仅 disabled 防重复点击）；添加/保存成功都弹 success toast（已添加 / 已保存）。
- **添加**：sec-head 右侧固定「+ 添加 Provider」按钮，表单展开 pinned 在列表最上方（provider 再多也不用滚到底）；**add 行以折叠态挂载、下一帧才加 open class**（否则挂载即展开会跳过 0fr→1fr 动画、读作"跳一下"）；提交成功该行就地变为新 provider 的展开行，按字典序归位并闪烁。**闪烁只用于添加归位**——保存/改名已由 toast 确认，不再闪烁。
- **未保存守卫**：表单 dirty 后收起/切行，在展开区顶部就地插 banner「有未保存的修改」[继续编辑][丢弃]（不弹窗）。
- **错误可见性**：校验/提交失败在表单顶部 banner 展示并自动滚动到可见位置（banner 在顶、提交按钮在底，不滚动会像没反应）。
- **数据源**：`GET /v1/providers`（has_api_key/status/models）+ `GET /v1/models`（AppModel.maxContextSize 回填模型行上下文）。
- **保存**：`PUT /v1/providers/{id}`（§4.7）；api_key 输入留空 → 不下发（保留）；成功后重拉 providers + models **+ config**（PUT/POST/DELETE 都重写 config 的 providers/models 段，而 `event.config.changed` 未桥接到 WS，渲染器的 config 快照必须显式重拉，否则编辑表单读模型记录会拿到旧数据）；保存/删除后 `checkAuth()` 刷新全局默认；保存成功弹 success toast（**WarningToasts 必须 Teleport 到 body**——`#app` 是 `position: fixed` 自成层叠上下文，否则 toast 会被设置弹窗压住）。
- managed 识别：`id === 'managed:kimi-code'`（core 常量），server 40003 兜底。
- **不提供刷新按钮**：手动 provider 无远端 source 可刷；`:refresh` 对 managed 由 ModelPicker 的 refreshAllProviders 兜底；Phase 3 引入 registry 后再评估加回。

**Phase 2/3 演进（均已定稿）**：「+ 添加供应商」展开区落地为 `AddProviderFlow.vue`：顶部 `SegmentedControl` 来源切换（**从目录添加** / **注册表** / **手动添加**）。目录视图 = 搜索框 + 紧凑行列表（限高 320px 滚动；行 = 名称 + wire badge + 模型数；rejected 置灰 + 本地化原因小字），选中条目原地变导入表单（名称默认目录 id 可改 / API Key 密码框+眼睛 / Base URL 仅 `needsBaseUrl` 时显示且必填；「将从目录导入 N 个模型」提示；目标 id 与现有供应商重名时显示覆盖警告 Banner；导入成功 toast `已添加` + 归位闪烁，与手动添加一致）。注册表视图 = 说明小字 + 注册表 URL（必填）+ API Key（可选，密码框+眼睛）；导入成功 toast「已导入 N 个供应商」+ 归位展开第一个 provider。手动视图内嵌现有 `ProviderForm`（v-show 保状态，guard/dirty 事件由 AddProviderFlow 统一转发）。**旧 server 降级**：目录路由 404（非 envelope）→ 隐藏来源分段、退为纯手动表单；其他加载失败 → 错误 Banner + 重试。列表与手风琴机制不变。

### 5.3 Onboarding 三方入口（最后一期实施）

`OnboardingLoginStep.vue:93` TODO 处加第二张卡片「使用自有 API / Bring your own API key」：点击跳过 login phase，直接打开 `AddProviderFlow`（Step 1）。完成添加 → `checkAuth()` + `setOnboarded(true)` 进入主界面；取消可返回卡片列表。i18n 用 `onboarding.ts` 新增 key（`byokTitle/byokHint` 等），结构已为多卡片设计。

**前中期不动 onboarding**：Phase 1-3 期间 onboarding 保持只有 Kimi 一张卡片，三方入口与 web 同步一起放在最后一期。

### 5.4 联动

- 添加/编辑成功后：重拉 providers + models + config → ModelPicker/Composer 模型列表自动更新。
- provider 写操作不动全局默认指针（§4.2/§4.7）；若默认模型因删除而悬空，运行时按无默认处理，用户在 Agent tab 可重新选择（悬空指针在选项列表中自然消失）。
- ModelPicker 底部加「管理 Provider…」链接（打开设置页 Providers tab），与 Composer「更多模型」链路对齐。

### 5.5 双端同步（推迟到最后一期）

**本期只做 `apps/desktop`**，web 保持现状。全部 UI 改动在 desktop 开发、验证、迭代，体验验收满意后再一次性整段拷贝同步 `apps/web`（ProvidersPanel/SettingsDialog/OnboardingLoginStep/App.vue 接线为同步副本；i18n 在共享包 `packages/web-i18n`，改一次两端生效，无额外同步成本）。本功能非 desktop 原生分叉，`native-todos.md` 无需新增条目。

## 6. 实施分期

> 范围说明：Phase 1-3 的「本仓」改动 = `apps/desktop` + 共享包 `packages/*`，`apps/web` 一律不动；onboarding 与 web 同步都在 Phase 4。

**Phase 1（MVP）：手动添加/编辑/删除 + 设置页 Providers tab** ✅ 已完成（待人工验证与提交）

1. kimi-code 工作克隆（分支 `feat/kap-provider-write-endpoints`）：`modelCatalog.ts` 加 `POST /providers`、`DELETE /providers/{id}`（replace 整段实现真删）、`PUT /providers/{id}`（替换式编辑，api_key 三态）+ 16 个端点测试；kap-server 全量 729 通过。
2. 本仓（分支 `feat/custom-provider-phase1`）：web-core 实现 `addProvider/deleteProvider/updateProvider`；`SettingsDialog` 新增 Providers tab + `ProvidersPanel.vue`（Master-Detail 统一表单，§5.1/5.2 定稿）；原 ProviderManager 弹窗及接线撤除；i18n en/zh；`pnpm lint` / `typecheck` / `test`（23 个新用例）/ `check:style` 全过。
3. 验证：desktop 手动添加 OpenAI 兼容 provider → ModelPicker 可选 → 发消息跑通；编辑保存（含换 key、增删模型行）；删除后列表/默认模型正确。
4. bump submodule + changeset（patch）。

**Phase 2：models.dev 目录导入** ✅ 已完成（待人工验收与提交）

5. kimi-code（分支 `feat/kap-provider-write-endpoints`）：`GET /catalog/providers[{id}]` + `POST /providers:import_catalog`（并入 `/providers:action`，§4.4 落地修正）+ 10min 缓存/过期回落/快照兜底 + 依赖 `@moonshot-ai/kosong`；16 个目录端点测试；kap-server 全量 751 通过（含 apiSurface 快照更新）；真实 models.dev 实拉验证（170 条目）。
6. 本仓（分支 `feat/custom-provider-phase1`）：web-core `listCatalogProviders/getCatalogProvider/importCatalogProvider` + 4 个单测；`AddProviderFlow.vue`（来源分段 + 目录浏览/搜索/置灰 + 导入表单 + 旧 server 404 降级，§5.2 Phase 2 定稿）；composable 包装（`loadCatalogProviders` 三态 / `importCatalogProvider`）；i18n en/zh；全量 1398 测试、lint、typecheck 全绿；实机验证（搜索/needs_base_url/导入/toast/归位/config 元数据/删除清理/rejected 置灰）通过。

**Phase 3：custom registry** ✅ 已完成（待人工验收与提交）

7. kimi-code：`POST /providers:import_registry`（并入 `/providers:action`）——直接复用 core 的 `fetchCustomRegistry` / `applyCustomRegistryEntries`（不带默认指针的 shape 上 apply），provider 带 `source` blob 供定时刷新；新增依赖 `@moonshot-ai/kimi-code-oauth`、错误码 `40005`；7 个新测试，kap-server 全量 758 通过。
8. 本仓：web-core `importCustomRegistry` + 2 个单测；`AddProviderFlow` 第三来源「注册表」（URL 必填 + Key 可选 + 说明小字）；composable `importCustomRegistry`（成功返回 providers 供归位）；toast「已导入 N 个供应商」+ 归位展开第一个 provider；i18n en/zh；全量 1400 测试、lint、typecheck 全绿；实机验证（本地 api.json fixture 导入 → source blob 落盘 → 同 URL 重导入刷新 key → UI 删除清理）通过。

**Phase 4（最后）：onboarding 三方入口 + web 同步**

9. desktop 端 onboarding 接线：`OnboardingLoginStep` 三方卡片；端到端验证 onboarding 路径。
10. desktop 体验验收满意后，全部 UI 改动一次性同步 `apps/web`。

每个 Phase 独立可交付、独立 PR；Phase 1 完成后「手动添加自有 key」已可用。

## 7. 测试与验证

- **kimi-code 侧**：kap-server 路由单测（沿用 `test/` 现有风格 + `apiSurface.snapshot` 更新）；config 删除语义、managed 删除拒绝、registry 重导入删除的用例。
- **本仓**：web-core client 方法单测（mock http）；providerForm 校验等 renderer 测试放 `apps/desktop/tests/renderer/`；`pnpm lint` / `pnpm typecheck` / `check:style` 无新增 findings。
- **手动验证清单**：亮色+暗色下向导三来源全流程；hover/focus 态；双语切换；desktop 内嵌 server 与外部 server（`KIMI_SERVER_URL`）两种模式；onboarding 跳过/完成路径。

## 8. 风险与开放问题

- **api key 明文存 config.toml**：与 TUI 现状一致，本期接受；后续如做系统 keychain 存储是 core 层改动，单独立项。
- **models.dev 可用性**：server 代理 + 内置快照兜底，离线环境可用快照；快照新鲜度随 core 发版。
- **web 端在外部 daemon 旧版本时**：新端点 404，客户端需按 404 降级隐藏「从目录添加」入口（版本协商暂不做，靠 404 探测即可）。
