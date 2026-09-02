# Okta SSO 登录 + 自有网关模型供给 · 设计文档（最终形态）

> 定位：**原始设计文档，已随实施演进更新为最终设计**——记录"为什么这么设计"与全部契约；文件清单、验证结果、人工待办见同目录 `structured-okta-end.md`（实施总结）。文末附【设计演变记录】：初版设计 → 中途推翻 → 最终形态的每一次转折与原因。
> 时效基线：2026-09-02，fork 定制（未合入上游），apps/vscode。
> 硬约束（贯穿全文）：本仓库是 MoonshotAI/kimi-code 的 fork，定期拉上游——**新代码全部放新文件，上游文件只做极小的追加式编辑**（最终 5 个上游文件约 33 行）。

## 一、Context

把 Continue 项目验证过的登录链路移植到本插件：webview 点"Sign in with Okta" → RPC 到扩展宿主 → `vscode.authentication.getSession`（自定义 AuthenticationProvider）→ 浏览器授权 → 回调换 token → 调**我们自己的**模型目录 API → 组装进 config.toml → 复用本插件全部聊天 UI。

### 最终确定的需求形态（与初版不同的部分加粗）

| 决策点 | 最终选择 |
|---|---|
| 登录协议 | OAuth2 授权码 + PKCE（Okta OIDC 应用 = OAuth2 应用，同一东西）；回调**双通路**：默认回环 HTTP server（127.0.0.1，零托管依赖），或 okta.json 配 `redirectUri` 走 **vscode:// 深链**（Continue 官方同款，浏览器授权后 Okta 直接重定向到 `vscode://<publisher>.<扩展名>/...`，VS Code 路由给本插件的 UriHandler）——按 Okta 应用里实际注册的 redirect URI 形态二选一 |
| 配置来源 | **两个外部文件**：`okta.json`（纯 IdP）+ `gateway.json`（模型目录） |
| 登录入口 | 独立 Okta 登录页；**Okta 是默认登录方式**，唯一退回口是 okta.json 的 `authMode: "kimi"` |
| Token 存储 | **SecretStorage 唯一存储 + 引擎内存层注入**（`setMemoryConfig`），全链路零落盘 |
| 模型目录格式 | **每条自带协议与端点**：`{data:[{model, name, provider, apiBase, contextLength}]}` |
| 推理协议 | 每模型由目录 `provider` 标签声明，经 `protocolAliases` 映射为 config.toml 的 `type`（**代码零猜测**）；本部署全量走 OpenAI **Responses API**（标签 openai/openrouter 均映射 `openai_responses`） |
| 推理端点 | **每模型自己的 `apiBase`**（网关只做目录，不做推理代理） |

### 承重的架构事实（已逐一核验，设计依赖它们）

- **引擎凭据消费路径**：provider 段的 `apiKey` 从"有效配置视图"解析——磁盘 config.toml 与**内存配置层**（`KimiHarness.setMemoryConfig`，深合并、不落盘、`reload()` 后仍存活；klient 契约 `z.enum(['user','memory'])`）合并而成。`apiKey: ""` 在解析器里视为"未设置"。这是零落盘 token 的引擎侧支柱。
- **`apiKey` 与 `oauth` 同段是硬错误**（v2 auth resolver）——所以我们的 provider 段只写 `apiKey: ""`，绝无 oauth ref，真实 token 全靠内存层覆盖。
- **引擎进程内没有 SecretStorage 通道**：引擎是纯 Node SDK，不认识 `vscode` 模块；token 只能由扩展宿主"推"进内存层，且**随进程死亡**——重启后必须有人重注入（→ 激活期恢复，见 §四）。
- **配置写入走 SDK**：`replaceConfigSections`（原子多段替换；v1 引擎 `supportsAtomicSectionReplace()=false`）+ `removeProvider`（级联清理别名与默认指针）。不直接 import agent-core。
- **webview 初始化天然兼容**：`requiresManagedProviderLogin` 只认 `managed:kimi-code`；我们生成的段名都不匹配 → 有模型即 `ready`。`useAppInit`/`resolveAppView` 零改动。
- **协议校验**：`shared/bridge.ts` 的 `validateParams` 是 switch，漏加 case 的方法永久被拒——加 RPC 方法必须 Methods + case + handler 三处同加。
- **provider `type` 枚举**（config.toml 侧）：`anthropic / openai / openai_responses / kimi / google-genai / vertexai`。目录标签超出此集合必须显式映射。

## 二、配置契约（两个文件，各管一摊）

IdP 与网关由不同的人管、变更时机不同，拆开互不牵连。都在 `~/.kimi-code/` 下，各自按 mtime 记忆化、**只在被需要时才读**。

### okta.json（纯身份：怎么登录）

必填 `issuer`（授权服务器 URL，端点由它拼：`{issuer}/v1/authorize`、`{issuer}/v1/token`）、`clientId`；可选 `redirectUri`（**vscode:// 深链回调**：设置后 authorize/token 交换都用它，code 经 `vscode.window.registerUriHandler` 回到插件；必须同时满足两点——与 Okta 应用注册的 redirect URI 一致、与本插件构建的 `publisher.name` 路由一致（当前为 `vscode://life-restver-rd.restver-code`），state 不匹配的迟到深链被忽略）、`scopes`（默认含 `offline_access`，否则拿不到 refresh token）、`authorizePath`/`tokenPath`/`callbackPorts`（默认 35173-35175，回环模式下每个端口都要在 Okta 应用注册为 redirect URI）、`redirectPath`、`loginTimeoutMs`（10min，< webview RPC 的 16min）、`authMode`（`"okta"` 默认 / `"kimi"` 退回内置登录页，其他值报错）。

### gateway.json（模型目录：登录后调谁拿清单）

```json
{
  "modelsBaseUrl": "https://api.example.internal",
  "modelsPath": "/models",
  "providerName": "okta",
  "defaultContextLength": 128000,
  "protocolAliases": { "openai": "openai_responses", "openrouter": "openai_responses" }
}
```

| 字段 | 语义 |
|---|---|
| `modelsBaseUrl` + `modelsPath` | **只**用于 GET 模型目录；推理地址不在此文件 |
| `providerName` | 生成段名前缀 = **所有权标记**（凡此前缀的段/别名归本模块管理，随目录增删自愈） |
| `defaultContextLength` | 兜底窗口大小（目录条目缺 `contextLength` 时用） |
| `protocolAliases` | 目录标签 → 实际推理协议的**唯一映射来源，代码零猜测**：未映射且非受支持协议的标签报错点名（绝不静默猜），映射值也必须是受支持协议 |

### 目录响应契约（`GET {modelsBaseUrl}{modelsPath}`，Bearer Okta token）

| 字段 | 用途 |
|---|---|
| `model` | 推理请求载荷的模型 id（兼容 `id`） |
| `name` | 显示名（下拉标签，缺省用 model） |
| `provider` | 协议**标签**：受支持协议名直接用；厂商标记必须经 `protocolAliases` 映射 |
| `apiBase` | **该模型自己的推理端点**（所在组的 baseUrl） |
| `contextLength` | 窗口大小（字符串/数字均可），逐模型写 `maxContextSize` |

### 供给结果（按 `(协议, apiBase)` 分组）

每组一个 provider 段，段名 `<前缀>-<协议>-<主机名>`（同主机同协议的第二组加 `-2`；分组按排序遍历，**同目录重登录段名稳定**）：

```toml
[providers.okta-openai_responses-one.example.internal]
type = "openai_responses"
baseUrl = "https://one.example.internal/v1"
apiKey = ""                      # 永远空：真实 token 在引擎内存层

[models."okta-openai_responses-one.example.internal/gpt-5.4"]
provider = "okta-openai_responses-one.example.internal"
model = "gpt-5.4"
displayName = "gpt-5.4"
maxContextSize = 200000
```

**所有权与自愈**：带前缀但不在新目录里的段与别名整体删除（模型下线、apiBase 变更都覆盖），用户在同别名上的 `overrides` 保留，他人配置一律不动；`defaultModel` 仅在未设/被删/属于本模块时改指第一个别名。

## 三、Token 安全模型（零落盘）

token 全链路只存在两处：

1. **VS Code SecretStorage**（事实源）：固定 key `kimi-code.okta`，存**自包含会话** `{token, accountLabel, providerNames}`。refresh token 永不离开这层；`providerNames`（供给后的段名名单）是"重启恢复零配置依赖"的关键——恢复所需的一切都在这一个 secret 里。
2. **引擎内存配置层**：同一 access token 注入到**每一个**生成段（`setMemoryConfig({providers: {段A: {apiKey}, 段B: {apiKey}, …}})`）；TTL/2 + 5 分钟 tick 主动刷新，刷新即自动重注入。

config.toml 与 `~/.kimi-code/credentials/` **零 token 写入**（已 grep 核实）。

## 四、模块生命周期（与 Continue 官方同款）

- **激活期**（`initOktaModule`，extension.ts 两行）：注册 `vscode.authentication.registerAuthenticationProvider`（**不需要任何配置文件**——provider 的 config 全部在方法被调用时懒解析）+ `restoreOnActivation()`。永不抛错。
- **重启恢复零配置依赖**：reload 后引擎内存层为空、已登录用户直接进主界面（登录页不出现、无任何 okta RPC）——所以恢复必须在激活期做：读 SecretStorage → 未过期直接按名单注入；过半衰期先 refresh（此路径才需要 okta.json）；okta.json 缺失降级为"注入现有 token、不启动刷新"。
- **配置全懒加载**：okta.json 管登录/刷新/判模式，gateway.json 管目录与供给，各自由 loader 按需读取。
- **`GetAuthMode` 纯读**：返回 `{mode, error}`；错误不静默——okta.json 缺失/非法或 RPC 失败时 mode 仍为 `"okta"`，error 显示在 Okta 页面横幅；gateway.json 缺失在点击登录时报错上浮。

## 五、端到端链路

```
OktaLoginScreen 点击 → oktaLogin RPC（16min 超时）
  → 宿主读 okta.json（scopes 等）+ gateway.json（目录参数），缺失者报错上浮
  → authentication.getSession("kimi-code-okta", …, {createIfNone})
  → createSession（单飞）：PKCE + 回调通路二选一
      （redirectUri 配置 → vscode:// 深链，URI handler 收 code；否则 loopback + asExternalUri）
      → 广播 OktaLoginUrl（兜底链接）→ 开浏览器 → Okta 授权 → 回调 code+state
      → POST {issuer}/v1/token 换 token
      → SecretStorage 存会话（providerNames 暂空）+ 注入引擎
  → GET {modelsBaseUrl}{modelsPath}（Bearer）→ 解析目录（标签经 protocolAliases 映射）
  → 按 (协议, apiBase) 分组 → replaceConfigSections 原子写 config.toml
  → updateProviderNames：段名名单回填 SecretStorage 并按名单重注入
  → {success:true} → webview refresh() → 聊天 UI + 模型下拉直接可用
```

模块清单（12 个新文件，职责一句话）：`okta/gateway-config.ts` 目录配置 loader、`okta/okta-config.ts` IdP 配置 loader、`okta/pkce.ts`、`okta/loopback.ts` 回环回调服务器、`okta/token-store.ts` SecretStorage + 多段注入器 + 刷新调度、`okta/auth-provider.ts` AuthenticationProvider（懒 config + restoreOnActivation）、`okta/models.ts` 目录解析/分组合并/原子供给、`okta/runtime.ts` 单例装配与模式读取、`handlers/okta.handler.ts` 四个 RPC、webview 的 `OktaLoginScreen`/`LoginScreenGate`/`useAuthMode`；详见实施总结。

上游触碰面（5 文件约 33 行，全追加式）：`shared/bridge.ts`（4 Methods + 1 Event + validateParams 四 case）、`handlers/index.ts`（+2）、`extension.ts`（+2）、webview `services/bridge.ts`（+16）、`App.tsx`（换 LoginScreenGate 2 行）。**不改**：package.json、LoginScreen、useAppInit、resolveAppView、ActionMenu、全部 packages/*（node-sdk 的 `setMemoryConfig` 一族为配套新增，属 fork 侧变更）。

### fork 定制点（上游合并时逐处核对，勿被上游覆盖）

1. **扩展标识符已改为 `life-restver-rd.restver-code`**（package.json 的 `publisher: "life-restver-rd"` + `name: "code"`），使 Okta 管理员注册的深链 `vscode://life-restver-rd.restver-code` 能路由到本插件。随之同步：根 `package.json` typecheck 的 `--filter code`、`flake.nix` workspaceNames 的 `"code"`、`.changeset` 包名键 `"code"`、`.github/workflows/vscode-publish.yml` 的 filter/扩展 ID/open-vsx 查询。VSIX 产物文件名（`kimi-code-<平台>.vsix`）由 `vsix-targets.mjs` 硬编码，与扩展 ID 解耦，保持原名。
2. node-sdk 的 `setMemoryConfig`/`clearMemoryConfig` 一族（packages/node-sdk，含 v2 实现与测试）。

## 六、边界情况

| 情形 | 行为 |
|---|---|
| 引擎 401（休眠/时钟跳变后 token 过期） | 该次请求可见失败；5 分钟 tick 刷新 + 自动重注入自愈。要求 Okta access token TTL ≥ 10 分钟 |
| refresh token 失效（`invalid_grant`） | 清存储并抛类型化错误；config.toml 模型保留（不静默破坏），重点登录即幂等重供给 |
| 目录变化（模型下线/apiBase 变更） | 重登录自愈：带前缀但不在新目录的段与别名删除，他人配置不动 |
| 目录标签未映射 / 映射值非法 | 登录时报错点名标签（显示在页面横幅），不静默猜协议 |
| 端口占用 | 三端口按序重试，全占用报可操作错误 |
| 远程工作区 | asExternalUri 转发端口（需在 Okta 放行转发 URI）；失败回落本机 URI |
| 用户关浏览器/拒绝 | `?error=access_denied` 立即短路；10 分钟超时 → dispose → 回 idle |
| 双击/双面板登录 | createSession 单飞，第二个调用者并入进行中的浏览器流 |
| v1 引擎（useAgentCoreV1） | 供给抛"需默认 v2 引擎"可操作错误；切回重登即完成 |
| VS Code 账号菜单登出 | removeSession → 清 SecretStorage + 内存层 |
| okta.json 登录后被删 | 恢复降级：注入现有 token、不启动刷新；下次登录自愈 |

## 七、验证（手工 E2E 要点；单测/类型/清单见实施总结）

Okta 侧：OIDC 应用（Native/SPA 均可，PKCE 必选 + Refresh Token grant），redirect URIs 注册三个 localhost 回调。本地可起一行 HTTP 服务回模拟目录。F5 逐项验证：Okta 登录页（配置错误显示横幅）→ 浏览器 → 回调 → 模型下拉出现目录模型；`config.toml` 出现分组段且 `apiKey` 全空、`~/.kimi-code/` 无任何 token 文件；发消息网关侧收到 `Authorization: Bearer <Okta token>` 且走 `/responses`（Responses API）；reload 窗口后**不重登**直接发消息仍成功（激活期恢复生效）；过 TTL/2 token 自动轮换；登出后所有带前缀的段消失。

## 设计演变记录（为什么不是初版那个样子）

| # | 初版设计 | 中途发现/用户纠正 | 最终形态 |
|---|---|---|---|
| 1 | token 写**镜像文件**（`credentials/okta-sso.json`，引擎按 oauth ref 读文件） | 引擎自带的刷新打 Kimi 专属端点、对 Okta 必然失败；且 fork 侧 node-sdk 补上了 `setMemoryConfig` 一族 | SecretStorage 唯一存储 + 引擎内存层注入，**零落盘**（用户明确要求 token 不进文件） |
| 2 | 激活期 `initOktaModule` 全量装配 | 用户质疑：注册 provider 应在激活、**config 不该在激活加载** | 激活期只注册 provider + 恢复会话（恢复本身也不读配置——会话自包含）；两个配置文件全程懒读 |
| 3 | 恢复靠 webview 挂载组件（OktaSessionPrime）发 RPC 触发 | 用户要求删掉；且已登录用户 reload 后根本不经过登录页 | 恢复进激活期 `restoreOnActivation`；把 `providerName(s)` 快照进 SecretStorage 使恢复零配置依赖 |
| 4 | okta.json 三合一（IdP + 网关地址 + 模型参数） | 用户指出 apiBaseUrl 是自己网关的，不是 Okta 的，混在 okta.json 名不符实 | 拆两个文件：okta.json 纯 IdP、gateway.json 纯目录 |
| 5 | 文件存在 = 模式开关（缺文件回 Kimi 登录）；曾用 `kimiLogin: true` 布尔退回 | 用户：默认就该是 okta；退回用正规配置字段 | 三处默认 `"okta"`；唯一退回口 `authMode: "kimi"` |
| 6 | 目录假设 OpenAI 风格 `{data:[{id}]}`、单一 provider（type 固定 openai_responses、baseUrl 全局一个） | 用户给出真实格式：每条自带 `provider`（协议）与 `apiBase`（各自端点） | 按 `(协议, apiBase)` 分组建多段；`name`→displayName、`contextLength`→逐模型窗口 |
| 7 | 内置别名 `openrouter → openai`（代码里猜） | 用户：他们 openrouter 标签实际也是 Responses API——内置猜测与部署现实相撞 | 删除全部内置映射；`protocolAliases` 是唯一映射来源，未映射报错点名 |
| 8 | `GetAuthMode` 失败静默回落默认 | 用户：错误应该显示在 Okta 页面告诉用户 | RPC 返回 `{mode, error}`，错误渲染为页面横幅 |
| 9 | 回调只有回环 server 一种 | 用户：管理员在 Okta 注册的 redirect_uri 是 `vscode://…` 深链，不是 localhost | 双通路：okta.json 配 `redirectUri` 即走 vscode:// 深链（UriHandler 收 code）；不配保持回环默认 |
