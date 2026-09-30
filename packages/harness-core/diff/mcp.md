# mcp：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/mcp/`（约 3976 行：core/ 2022、oauth/ 1141、config/ 221、tools/ 323、deferred.ts 54、feature.ts 394、types.ts 41、index.ts 15）
- agent-core-v2：`src/mcpCore/`（2722 行）+ `src/agent/mcp/`（1212 行）为迁移蓝本；另有宿主侧 `src/session/mcp/`（109 行）、`src/workspace/workspaceMcp/`（306 行）、`src/workspace/workspaceMcpConfig/`、`src/app/mcpConfig + mcpManagement + mcpRegistry`（1497 行）属宿主管理面，Handoff 明确不迁
- 蓝本关系：顺序表 #29（最后一域），2026-09-29 第 49 轮迁移（提交 `pvzsqnoz 1953c381` + 接线 `zputqnzw 8d3a94b7`），非 refact-237 第一批 human 蓝本；蓝本是 v2 的 DI Service 体系代码（mcpCore 传输/OAuth 层 + agent/mcp 镜像层），connection-manager、oauth 全栈、config-schema、tool-naming 多处与 v2 逐字对齐（Handoff 第 49 轮 diff 核实）

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 工具表时序：动态注册 → spec freeze + deferred 通道 | 工具列表每步动态重建：baseline server 中途连上后 inline 注册，下一请求即出现在 wire tools；`deferred` 配置的工具以 `disclosure:'deferred'` 注册（`agent/mcp/mcpService.ts:303`），经 toolSelect 子系统公告（`<tools_added>` 名单）+ `select_tools` 两跳加载 schema（`agent/toolSelect/toolSelectService.ts:240`、`agent/loop/machine/tools.ts:79`） | 挂载时冻结 spec（agent-core `contribution-hooks.ts:264` freeze 快照）；`initialPhase` 期间连上的 server inline 进冻结 spec，之后（迟到连接、重连）一律 `deferred: true` 注册 executor，schema 经 `mcp-dynamic-tools` 同 key remind 消息整体下发（`feature.ts:236`、`deferred.ts:33-54`），模型按名直调、无 select_tools 一跳 | 三项定稿②③（Handoff 约束问答末条，line 89-90）：「spec freeze 是预期行为」「实现 deferred 功能…schema 经 mcp-dynamic-tools system 消息的 tools 字段上线」；第 49 轮 |
| 初始加载门控点 | `loop.hooks.onWillBeginStep` + `toolExecutor.onWillExecuteTool` 逐步/逐调用 `waitForInitialLoad(signal)`（`agent/mcp/mcpService.ts:70-78`），agent 可先存在，等待可随 signal 中止 | `useReady(initialLoad)` 挂载门控（`feature.ts:183`）：agent ready 前 session.create 不返回；remount 时 initialLoad 已解决、零等待 | 第 49 轮（「agent 层 useReady(initialLoad) 门控」）；贡献点体系无 onWillBeginStep 钩子的自然落点 |
| 迟到 server 对既有会话的可见性 | `isBaselineServer` 过滤：会话初始加载后才加入全局 manager 的 server 不镜像给既有会话（`workspace/workspaceMcp/workspaceMcpService.ts:217-251` 快照 + frozen 后拒绝） | 无 baseline 概念：任何时刻连上的 server 都镜像给全部 agent，迟到者走 deferred 通道可见 | 定稿②「迟到工具不进 spec（executor 照注册 + deferred 通道递送 schema）」——刻意让迟到工具可见 |
| 会话作用域 server 机制 | 每会话独立 overlay `McpConnectionManager`（seed `ISessionEphemeralMcpServers`）+ `MergedMcpConnectionView` 合并视图，session dispose 时整体 shutdown（`session/mcp/mergedConnectionView.ts`、`workspaceMcpService.ts:91-158`）；overlay 要求 stdio 显式 `runtime_id` | app 全局单一 manager + `McpRef.connect/disconnect` ephemeral 层 + cwd 可见性过滤（`feature.ts:194-198`：`visibleToSession` 比较 ephemeral cwd 与 `sessionCwd()`）；同 cwd 多会话共享同一连接；回收靠调用方 disconnect（feature-acp 已做跨会话引用计数） | 三项定稿不迁清单「session overlay/ephemeral servers（feature-acp 域）」；后续以另一形态落地（见「与 Handoff 记录不符」行） |
| 配置文件 hot-watch | `workspaceMcpConfigService.watchConfigFiles` 监听 user mcp.json + projectRoot 目录 + trust 变更，debounce 后 `onDidChange` → `apply` 增量 connect/markRemoved（`workspace/workspaceMcpConfig/workspaceMcpConfigService.ts:121-153`） | 不监听文件；`McpRef.reload()` 手动重载 + `McpServerSources` 贡献源 `onDidChange` 触发（`feature.ts:122-149`，plugin 域经此注入 server） | 三项定稿不迁清单「配置文件 hot-watch（McpRef.reload() 取代）」；plugin 贡献点见 Handoff 第 46 轮追加（line 331） |
| 宿主管理面 | `app/mcpRegistry`（global/plugin/caller 聚合）、`app/mcpManagement`（651 行：list/get/add/update/remove/test/login/logout、authStatus 巡检）、`app/mcpConfig/configStore`、`mcpCore/configView.ts` 脱敏视图、kap-server REST、`/mcp-config login` 命令 | 均不迁；needs-auth 错误文案由「run /mcp-config login <name>」（v2 `mcpCore/connection-manager.ts:347`）改为「call the server's authenticate tool to sign in」（`core/connection-manager.ts:276`） | 三项定稿不迁清单；第 49 轮偏差⑧ |
| OAuth 授权 URL 投递通道 | 工具 `onUpdate` 自定义 kind `MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE`（customData 带 serverName/url/expiresAt，UI 富卡片；`agent/mcp/tools/auth.ts:83-92`） | Feature 事件 `mcp.oauth.authorization_url {server, authorizationUrl, expiresAt}`（`feature.ts:286-293`、`types.ts:34-39`）+ 原有 status 文本 update 保留 | 第 49 轮（「授权 URL 经 Feature 事件」）；新架构 Feature 事件取代 v2 工具自定义 update 通道 |
| 输出治理管线 | 415 行全量治理：attachmentStore materialize 保存全部媒体/resource blob 原件 + daemon-file-url 指针通知（「Pass the attachment reference to Read」）、`compressImageContentParts`（caption + telemetry + persistOriginal）、`gateImageFormatParts` 内联格式门控、附件通知 >4096 字符落盘、`truncated` 标记、`spill.suffix`（`agent/mcp/output.ts:124-230`） | 258 行重写：mediaStore 在场时 inline base64 图片 `compressImageForModel` → `store.put` → `media://` ref（失败回退 data-URL），缺席 data-URL 直出（`core/output.ts:160-182`）；`gateImageFormatParts` 不迁（请求侧由 media 域 lower + degrade-recovery 负责）；内容块转换 / `<mcp-result-extras>` / reserved meta 剥离 / `wrapMediaOnly` / 10MB 单 part 上限与文案与 v2 逐字一致 | 三项定稿①「MCP 输出治理直接消费 media 能力」；第 49 轮偏差②（「originals 落盘 + daemon-file-url 通知不迁（media 无该 facade）」） |
| stdio 运行时 | `IRuntimeResolver.acquire({workspaceId, runtimeId}, ['process'])` 租约 + kaos runtime 绑定；`runtime_id` 缺省回落 options（'local'）；overlay 强制显式 `runtime_id`（`mcpCore/client-stdio.ts:176-215`、`connection-manager.ts:393-408`） | 仅本地 OsHost 端口 spawn（`core/client-stdio.ts:156-261` HostStdioTransport）；`runtime_id` 设非 'local' 值连接期明确报错；host 未注入时 stdio 报「createMcp was mounted without an OS host…」，http/sse 不受影响（`core/connection-manager.ts:322-330`） | 第 49 轮偏差④；横切约定（host 端口注入，未注入即无对应能力） |
| 错误与日志体系 | `Error2` + 错误域（`mcpCore/errors.ts`：MCP_SERVER_NOT_FOUND/DISABLED/STARTUP_FAILED/TOOL_NAME_COLLISION/OAUTH_FAILED）+ ILogger 日志点（failed/needs-auth `log.error`、OAuth sweep warn、shutdown drain 超时 warn） | 裸 `Error`，错误域不迁，日志点全部丢弃（message 文本保留） | 第 49 轮偏差①（「新架构无对应物，日志点丢弃」） |
| client 标识 | `getCoreVersion()` 构建期版本 + `resolveClientName`（agent 身份 slug）进 OAuth `client_name`（`<slug> (<server>)`）与 MCP Client name | 静态 `MCP_CLIENT_NAME='kimi-code'` / `MCP_CLIENT_VERSION='0.1.0'`（`core/client-shared.ts:5-6`），OAuth client_name 恒为 `kimi-code (<server>)`（`oauth/provider.ts:73-75`） | 第 49 轮偏差⑦（「无构建期版本注入」） |
| server 配置合并优先级 | registry 层合并：`{...plugin, ...file}`（文件胜出）；文件三层 user → projectRoot(.mcp.json) → project(.kimi-code/mcp.json) 后层赢（`app/mcpConfig/configLoader.ts:52-79`） | ephemeral 垫底 → `McpServerSources` 贡献源 → props.servers → user → projectRoot → project（`feature.ts:73-95` + `config/loader.ts:30-51`），与 v2 文件/插件相对顺序一致 | Handoff 第 46 轮追加（line 331：「sources 铺底、config 文件与 props.servers 覆盖胜出，对齐 v2 `{...plugin, ...file}` 语义」） |
| ACP 会话 mcpServers 注入（**与 Handoff 记录不符**） | v2：`session/new` 的 mcpServers 经 seed 进 overlay，agent ready 屏障内含 overlay connect，首请求即 inline 可见 | 代码已闭合：facade `connect(name, config, {cwd})` + feature-acp `server.ts:99-134` 引用计数回收、`:227` 恢复 `mcpCapabilities {http,sse}` 宣告、`convert.ts:223` `acpMcpServersToConfigRecord` 已移植；但因 connect 晚于 agent 挂载与 initialLoad，注入 server 的工具只经 deferred 通道可见（不进冻结 spec），与 v2 的 inline 语义不同 | Handoff 第 51 轮（line 337）与 ACP 缺口②（line 75）均记「未实现、待 seam 讨论」，代码已在其后落地且 Handoff 未回填——以代码为准 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 工具名碰撞信号 | 碰撞时丢弃后来者并 dispatch observable `AgentErrorEvent`（MCP_TOOL_NAME_COLLISION，含完整碰撞明细文案；`agent/mcp/mcpService.ts:364-388`） | `planMcpToolRegistrations` 同样丢弃后来者并返回 collisions，但 `feature.ts:237` 只取 `planned`，collisions 直接丢弃——无事件、无日志、无文案 | 用户/宿主完全无感知；在案（第 49 轮偏差⑤「遥测无通道」），遥测批次待补 |
| 工具发现审计 | durable `mcp.tools_discovered` 事件（zod schema + replayable `mcp.discovery` seen-hash 投影，restore 后去重补记；`agent/mcp/mcpDiscoveryOps.ts:38-58`） | 不迁；mcp feature 零 durable journal 事件、零 fold 投影 | 发现历史不可审计/重放；在案（第 49 轮偏差⑤），遥测/可观测批次待补 |
| `tool.list.updated` 事件 | connected/disconnected 时 dispatch observable 事件（UI 与 loop 消费；`agent/mcp/mcpEvents.ts:32-36`） | 不迁（spec freeze 下 loop 不再需要；UI 侧只有 `mcp.server.state` 可间接推导） | 宿主若要精确跟踪工具表变化需自行 diff `mcp.server.state`；未见在案，属事件面收窄 |
| 状态事件载荷 | `mcp.server.status`：observable、带 `agentId`、仅 baseline server、agent 级 dispatcher（`mcpEvents.ts:18-21`、`mcpService.ts:168-181`） | `mcp.server.state`：app 级 Feature 事件、无 agentId、覆盖全部 server（含 ephemeral）（`feature.ts:99-106`、`types.ts:27-32`） | 多 agent 会话无法从事件区分归属（工具镜像本是全 agent 一致的，信息损失有限）；未见专项记录 |
| isError 通道 | `MCPToolResult.isError === true` → `ExecutableToolResult.isError: true`（`agent/mcp/output.ts:229`）；isRemoved 与 OAuth 失败分支同样置 isError | 已切回：`mcpResultToToolResult` 透传 `result.isError`（v2 `output.ts:229` 同构），isRemoved/OAuth 失败标 `isError: true`，框架统一渲染 | A 步已落地（第 76 轮） |
| 附件原件保存 | 全部 image/audio/video/resource blob 原件落 session media store + 指针通知文本 + 通知超 4096 字符单独落盘 + `truncated` 标记 + `spill.suffix` | 仅 inline base64 图片 offload（无通知文本）；audio/video/blob 不保存原件；无 truncated/spill | 大媒体结果丢失「原件可用 Read 回读」能力，被 10MB cap 丢弃时无 truncated 标记；在案（第 49 轮偏差②），media facade 补齐后可回收 |
| 压缩 caption 与遥测 | 压缩生成 caption 文本（描述原始尺寸/压缩率）+ `mcp_tool_result` 遥测 source | `compressImageForModel` 直出，无 caption、无遥测 | 模型看不到压缩说明；遥测批次待补 |
| 初始加载遥测 | `mcp_connected`/`mcp_failed` track2 + `initialLoadDurationMs()`（`workspaceMcpService.ts:285-305`、`mcpCore/connection-manager.ts:241-245`） | 均不迁 | 在案（遥测不迁批次） |
| 动态 trust | workspace trust 服务动态判定 + `trust.onDidChange` 触发项目层配置装卸（`workspaceMcpConfigService.ts:64`） | `CreateMcpProps.trusted` 静态布尔，缺省 false，运行期不可翻转 | 信任翻转需重建 feature；宿主管理面能力，未见专项记录 |
| 重连后双重广告（边缘情形） | 不存在（动态表，重连即 inline 重注册） | initialPhase 已 inline 进冻结 spec 的 server 重连后，`mirrorConnected` 按 `!initialPhase` 将其工具标 deferred（`feature.ts:236`）：冻结 spec 仍含旧描述，deferred 通道又重复公告，且通道文案「not in your static tool list」对这类工具不准确 | 模型上下文重复（冻结 spec + 通道 schema 各一份），语义无害但有噪声；未见在案 |
| OAuth 日志点 | sweep 跳过损坏凭证 warn、shutdown drain 超时 warn、meta 文件畸形 warn（`mcpCore/oauth/service.ts:211-214,272,642-651`） | 全部静默 | 在案（偏差①） |
| authenticate 工具 timeoutMs | `CreateMcpAuthToolOptions.timeoutMs` 可覆盖 15min 默认（`agent/mcp/tools/auth.ts:47,82`） | 不暴露，恒 15min（`tools/authenticate.ts:6,69`） | 仅测试/特殊宿主需要覆盖时才痛；未见在案 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| `McpRef` facade 含 connect/disconnect | v2 agent 面 `IAgentMcpService` 无 add/remove（管理面在宿主 DI 服务）；harness-core app 级 facade 直接提供 `connect(name, config, {cwd})` / `disconnect(name)`，ephemeral 层与文件配置合并、cwd 可见性过滤（`feature.ts:150-162`、`types.ts:19-25`）。**与 Handoff 第 51 轮记录不符**（该轮记「McpRef 无 add/connect 面」，代码已在其后补齐并被 feature-acp 消费） |
| `McpServerSources` 贡献点 | `useMcpServerSource(source)` 让任意 feature（plugin 已用）响应式注入 server 集合，晚注册与 `onDidChange` 自动触发 reload（`config/sources.ts`、`feature.ts:72,134-149`）；v2 由 mcpRegistry 服务硬编码三类来源聚合 |
| deferred 通道直发完整 schema | v2 deferred 工具需模型先调 `select_tools` 再调目标工具（两跳）；harness-core remind 消息的 `tools` 字段直接携带完整 schema，按名直调（`deferred.ts:43-50`），签名去重 + `turn.started` 补发（`feature.ts:336-338`） |
| `mcp.oauth.authorization_url` Feature 事件 | v2 只有工具自定义 update kind（必须挂在该次工具调用的 UI 流上）；Feature 事件让宿主在工具流之外也能接管授权 URL 展示 |
| 同 cwd 多会话共享连接 | app 全局 manager + cwd 可见性：两个同 cwd 会话共享一条 MCP 连接；v2 每会话 overlay 各自建立连接（资源占用 ×N） |
| facade `reload()` | 取代 hot-watch 的全量重载入口（增量 diff：消失的 markRemoved、新增/变更 connect；`feature.ts:122-133`）；v2 无等价手动入口（只有文件监听被动触发） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `[mcp]` 节 `startupTimeoutMs` / `toolTimeoutMs` | zod int 1..2^31-1 optional，默认空（`app/mcpConfig/configSection.ts:9-12`） | 同字段同 schema（`config/section.ts:9-12`） | 已对齐 |
| env `KIMI_MCP_STARTUP_TIMEOUT_MS` / `KIMI_MCP_TOOL_TIMEOUT_MS` | env 绑定 + parse（int 1..MAX）+ stripEnv | 同名同 parse 同 stripEnv（`config/section.ts:16-39`） | 已对齐 |
| server JSON schema（mcp.json 三层 + 各注入面） | `mcpCore/config-schema.ts`（transport 判别联合 + preprocess 由 command/url 推断；公共字段 enabled/deferred/startupTimeoutMs/toolTimeoutMs/enabledTools/disabledTools） | `core/config-schema.ts` 与 v2 逐字一致 | 已对齐（第 49 轮 diff 核实） |
| `deferred` 字段消费语义 | → `disclosure:'deferred'`，select_tools 可加载 | → spec freeze 下 `deferred:true` + `mcp-dynamic-tools` 通道 | 人为设计（定稿③） |
| stdio `runtime_id` | kaos runtime 绑定；overlay 强制显式设置 | 仅接受缺席/'local'，其他值连接期报错（`core/connection-manager.ts:328-330`） | 简化（在案④） |
| stdio `executor` | 仅 'local'，其他值报 `not yet implemented` | 仅 'local'，其他值报 `is not supported`（`core/client-stdio.ts:50-52`） | 已对齐（语义），文案略异 |
| trusted（项目层配置门控） | workspace trust 服务动态判定 + 翻转触发重载 | `CreateMcpProps.trusted` 静态 prop，缺省 false（`config/loader.ts:40`、`feature.ts:91`） | 简化（动态 trust 不迁） |
| 默认超时 | startup 30s；tool 无默认（SDK 行为） | 同（`core/connection-manager.ts:51`、`:319-320`） | 已对齐 |
| home 目录 | `resolveKimiHome`：`homeDir ?? KIMI_CODE_HOME ?? ~/.kimi-code` | `props.home ?? KIMI_CODE_HOME ?? ~/.kimi-code`（`feature.ts:61`） | 已对齐 |
| 工厂 props | 无工厂（DI 服务 + scope seed）：workspace.cwd、IRuntimeResolver、ISessionEphemeralMcpServers seed、ISessionMediaStore、IAgentIdentity | `CreateMcpProps{workDir, home, host, trusted, servers, mediaStore, sessionCwd}`（`types.ts:9-17`）：host 为 OsHost 端口（未注入 stdio 不可用）；servers 为垫底层（v2 无等价 props，近似 caller 源）；sessionCwd 缺省读 session metadata `cwd` | 人为设计（host 端口注入横切约定）+ 新增（sessionCwd/servers） |
| client 标识 | `getCoreVersion()` + 身份 slug（`resolveClientName`） | 静态 `kimi-code` / `0.1.0` | 简化（在案⑦） |
| OAuth 凭证存储 | `IAtomicDocumentStore` scope `credentials/mcp`（`app/mcpConfig/oauthStore.ts`） | 文件 `{home}/credentials/mcp/<storeKey>-{tokens,client,discovery,meta}.json`（`oauth/store.ts:41-65`、`feature.ts:62-64`）；storeKey 规则（sanitize + sha256-24 digest）与 v2 逐字一致 | 已对齐（key/文件命名规则），存储后端不同（v2 经持久化抽象，落盘位置由宿主解析） |
| OAuth 常量 | 授权等待 15min、auth 请求 30s、drain 30s、提前刷新 120s、PASSIVE_REDIRECT_URI `http://127.0.0.1:3118/callback` | 全部一致（`tools/authenticate.ts:6`、`oauth/service.ts:78-81`、`oauth/provider.ts:24`） | 已对齐 |
| OAuth 主动刷新 | 挂载后 sweep + 到期前排程 + `stopProactiveRefresh` + drain shutdown | 逐字对齐（`oauth/service.ts` 616 行 vs v2 667 行，差值全为 Error2/日志/resolveClientName） | 已对齐 |
| 实验 flag | 无 flag 门控 | 无 flag 门控 | 已对齐 |

## 工具 / 事件 / facade 面差异

**工具**
- 镜像 MCP 工具（`mcp__<server>__<tool>`，限定名 sanitize + 64 字符 FNV hash 截断与 v2 逐字）：description/parameters 直传、enabledTools/disabledTools 过滤、碰撞丢弃规则、isRemoved 文案（「has been removed … Do not call this tool again.」）、失败后 liveness 探测 → 原地重试一次 → 重连后再试的完整链路与「MCP connection lost — reconnecting…」进度文案均逐字对齐。差异：v2 经 `resolveExecution` 声明 `approvalRule: qualifiedName`（审批规则按限定名匹配，`agent/mcp/tools/mcp.ts:38`），harness-core `ToolDefinition` 无 approvalRule 字段，权限匹配归 permission 域通用工具名规则（该面对齐情况见 permission 域文档）；v2 args 由框架预解析，harness-core 在 execute 内 `JSON.parse(toolCall.arguments)`（`tools/mcp-tool.ts:104`，畸形 JSON 走框架工具失败路径）。
- `mcp__<server>__authenticate` 合成工具：描述 md、参数 schema（空 object + additionalProperties:false）、15min 阻塞、成功/失败/AlreadyAuthorized 三套文案与 v2 逐字/等价对齐。差异：v2 的自定义 update kind 改 Feature 事件（见行为差异表）；v2 展示文案 `Authenticating <server>`（resolveExecution description）与 `timeoutMs` 覆盖未迁。

**事件**
- v2 dispatcher 事件：`mcp.server.status`（observable、agentId、baseline）→ harness-core `mcp.server.state`（app 级 Feature 事件、全 server）；`tool.list.updated` → 不迁；`error`（MCP_TOOL_NAME_COLLISION）→ 不迁（碰撞静默）；`mcp.tools_discovered`（durable）→ 不迁。
- harness-core 新增：`mcp.oauth.authorization_url`（取代 v2 工具自定义 update kind）。
- OAuth 服务内部事件（tokens-saved/tokens-invalidated/refresh-failed → 重连规则）两侧逐字一致（`feature.ts:346-394` ↔ `workspaceMcpService.ts:168-215`）。

**facade**
- v2：`IAgentMcpService`（agent 级：oauthService / waitForInitialLoad / initialLoadDurationMs / list / resolved / getRemoteServerUrl / reconnect / onStatusChange）+ 宿主面 `IMcpRegistryService` / `IMcpManagementService`（不迁）。
- harness-core：`McpRef`（app 级：list / reconnect / reload / connect / disconnect）+ `McpConnectionManager` 公开 API（get / configOf / resolved / getRemoteServerUrl / waitForInitialLoad / reconnectAndJoin / reconnectAfterCurrent / markRemoved / shutdown / oauthService / onStatusChange）仍可直达；`initialLoadDurationMs` 与 `getHttpServerUrl` 别名未迁。

## 摘要
总体对齐度高：`mcpCore` 传输层（stdio/http/sse client、连接管理状态机、重连合并、意外关闭侦测）、OAuth 全栈（service/provider/callback-server/store key 规则）、工具命名、config schema 与 `mcp` 节、失败重试链、authenticate 工具契约均与 v2 逐字或等价对齐；agent 镜像层则按三项定稿刻意重写（spec freeze + deferred 通道 + useReady 门控），属设计而非缺口。最重要的三个差异：① spec freeze——v2 动态工具表（baseline 迟到 inline 进 spec、deferred 走 select_tools 两跳）变为冻结 spec + `mcp-dynamic-tools` remind 通道直发 schema，附带「已 inline server 重连后双重广告」的边缘噪声；② 输出治理重写——media:// offload 取代 v2 的附件原件保存/通知/truncated 体系（isError 已随 A 步落地）；③ 会话作用域机制改写——v2 per-session overlay 换成 app 全局 manager + cwd 可见性，facade connect/disconnect 与 ACP mcpServers 注入已在代码中闭合但 Handoff 第 51 轮记录未回填（以代码为准）。最需关注的缺口：碰撞与发现的信号全灭（AgentErrorEvent / mcp.tools_discovered durable / mcp_connected|failed 遥测均无通道，在案待遥测批次），以及动态 trust、配置文件 hot-watch、`tool.list.updated` 事件三处宿主可观测性收窄（前两者在案、后者未见专项记录）。
