# plugin：harness-core vs agent-core-v2 差异对比

## 对应关系

- harness-core：`packages/harness-core/src/features/plugin/`（约 3457 行，21 个 ts；acquire/ manifest/ state/ inspect/ contribute/ agent/ 分层 + 根 types/face/feature/errors/index）
- agent-core-v2：`src/app/plugin/`（2876 行，DI App 层 Service）+ `src/agent/plugin/`（312 行，agent 层 sessionStart/mutation reminder）+ `src/agent/pluginCommand/`（139 行，slash 执行）≈ 3327 行
- 蓝本关系：顺序表 #24，以 v2 DI 版为实现蓝本（任务契约：迁移规格以 DI 版为准；plugin 不属于 refact-237 第一批 human 蓝本域）。Handoff 第 46 轮为唯一实现轮次（含同日追加：marketplace 移植 + managed env 接线 + mcp 贡献点）。

## 行为差异

### 人为设计

| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 形态与 facade | `IPluginService` DI Service（App scope，`registerScopedService` OnScopeCreated），方法吃 input 对象（`{source}`/`{id,enabled}`…），`app/plugin/plugin.ts:44-69` | `createPlugin({homeDir, host?, onWarn?})` app+agent 双层工厂，不进 preset；`PluginRef` token + `PluginFace`（`useExpose`，app 层），参数平铺（`face.ts:33-62`、`feature.ts:105-127`） | Handoff 第 46 轮（工厂形态）；facade 参数平铺为 plan/skill 先例（第 46 轮偏差⑥）；不进 preset 对齐 createSpawn/createOs「宿主概念走 props」先例 |
| host 门控 | 无此概念：DI 服务永远在场，fs 直接用 `node:fs/promises` | `props.host === undefined` 时 app/agent 两 slot 直接返回（`feature.ts:41-42`、`feature.ts:131-132`），fs 全走 `host.fs`（OsFsPort 端口），能力由宿主注入决定 | 第 22 轮追加用户决策③（「os-host 没传入就不加载对应服务」）先例，第 46 轮沿用 |
| 事件模型 | `onDidReload: Event<PluginReloadEvent>`（`ReloadSummary & IWaitUntil`，AsyncEmitter）+ `onDidMutate: Event<PluginMutationSummary>`（`pluginService.ts:65-69`） | Feature 事件 `plugin.changed`/`plugin.mutated`（`useFire`，`face.ts:21-31`、`feature.ts:65/72`）+ `lastMutation`/`lastReload: ShallowRef`（`service.ts:73-74`，供 agent 层 `watch`） | 第 46 轮：app→agent 方向 node 事件不冒泡，故用响应式 ref 承载 |
| mutation 交付屏障 | mutation 方法 resolve 前 `await` 全部 onDidReload 监听者的异步交付（`awaitReloadDelivery`，`pluginService.ts:169-177`；监听者含 skill catalog、mcp config、externalHooks、profile loader 的 reload） | 无 waitUntil 机制；service 内保留缩小版屏障：mutation resolve 前仅 `await` 插件 skill 索引刷新（`refreshSkillIndex`，queue-free 直读防队列重入死锁，`feature.ts:64-74/82-84`），profiles catalog 刷新 fire-and-forget | 第 46 轮偏差③（记录在案） |
| reminder 机制 | reminder 总线：`reminder.register('plugin_session_start', reconcile)` + `reminder.notify(text, {variant:'plugin_change'})`（`agentPluginService.ts:81-103`） | `useBeforeStep` + `agent.remind(text, {key})` 同 key 覆盖（`agent/session-start.ts:80-82/154-179`、`agent/change.ts:3`） | 约束问答「reminder 域怎么迁」（用户 2026-09-27：不实现 reminder 域，各 Feature 直调 agent.remind） |
| 贡献通道接线 | skill：`PluginSkillSource`（DI，workspace scope，`features/skill/workspace/pluginSkillSource.ts`）；profiles：`PluginAgentProfileLoaderService`（DI，`pluginAgentProfileLoaderService.ts`）；mcp：`WorkspaceMcpConfigService` 直接拉 `plugins.enabledMcpServers()` 并在 `onDidReload` 上 `event.waitUntil(reload)`（`workspaceMcpConfigService.ts:55-62/103-119`） | 三通道全部经 collection 贡献点：app slot `useSkillSource`（`PLUGIN_SKILL_SOURCE_ID='plugin'`、priority 5，`feature.ts:76-85`）、`useProfileFinder`（sourceId 'plugin'、PRIORITY.plugin=5，`feature.ts:97-104`）、`useMcpServerSource`（id 'plugin'，`feature.ts:86-91` + `contribute/mcp.ts`）；source ID/优先级数值与 v2 逐字一致 | 第 45 轮（`useSkillSource` 为 #24 预留）、第 19 轮（plugin finder 待 #24 闭合）、第 46 轮同日追加（`useMcpServerSource` 新增于 mcp 域） |
| mcp 合并语义 | 每 workspace 合并 `{...plugin, ...file}`，file 胜出（`workspaceMcpConfigService.ts:117-119`） | mcp 域 app 全局 manager：`{...ephemeral, ...sources 铺底, ...file/props}`，file 同样胜出（`features/mcp/feature.ts:83-94`）；workspace 级隔离语义属 mcp 域架构决策 | 第 46 轮同日追加（「对齐 v2 `{...plugin, ...file}` 语义」）；app 全局形态见第 49/51 轮 mcp 决策 |
| profile finder 的 basePrompt | `user.getDefaultProfile().renderSystemPrompt(context)`（`pluginAgentProfileLoaderService.ts:55`） | 惰性解析 `ProfileCatalogRef.getDefault()`，缺席回落 `getBuiltinDefaultProfile()`（`feature.ts:92-96`） | 第 46 轮（profiles 域 `ProfileCatalogRef` 为唯一 catalog 入口） |
| 快照持久化 | durable `PluginSessionStartEvent`（type `'plugin.session_start'`，zod schema）→ replayable state key `pluginSessionStartSnapshot`（`agentPluginOps.ts:17-36`）；载荷含 agentId | feature 自有 journal 事件 `plugin.session_start.snapshot` + fold 投影 `pluginSessionStartProjection`（`agent/session-start.ts:27-52`）；载荷去 agentId | 第 46 轮偏差④（`decodeAgent` 对含 agentId 字段抛错，plan/cron 先例） |
| sessionStart 刷新触发 | `skillCatalog.onDidChange` 过滤 `PLUGIN_SKILL_SOURCE_ID` → `refreshPending`（mutation 计数器吞掉一次）；显式入口 `refreshSessionStart()` 置位 + `reconcileWhenIdle`（`agentPluginService.ts:86-95/114-119`） | `watch([face.lastMutation, face.lastReload])` 同款 `pendingMutationCatalogChanges` 计数器（`agent/session-start.ts:84-98`）；显式入口不迁（等价路径 = `reloadPlugins()`） | 机制映射（ref 取代事件）；显式入口为第 46 轮记录在案缺口⑧ |
| 错误模型 | `Error2` + 全局/域注册错误码（`PluginErrors`、`ErrorCodes.VALIDATION_FAILED`/`FS_PATH_NOT_FOUND`/`MCP_SERVER_NOT_FOUND`） | `PluginError` coded class（`errors.ts`）；码字符串逐字对齐 `'plugin.load_failed'/'plugin.not_found'/'validation.failed'/'fs.path_not_found'/'mcp.server_not_found'` | 第 20 轮 sessionExport 偏差⑤先例（「Error2 域注册机制不迁，coded error 统一范式」） |
| zip 暂存目录 | `mkdtemp(os.tmpdir()/kimi-plugin-zip-)`（`manager.ts:113`） | `<homeDir>/plugins/.zip-staging-<uuid>`（`manager.ts:118`） | 第 46 轮偏差①（OsFsPort 无 tmpdir 端口） |
| warn 通道 | `ILogService.warn(message, payload)`（结构化载荷） | `onWarn?: (message: string) => void` props（平铺字符串，如 `plugin sessionStart skill not found: <id>:<name>`） | 第 46 轮偏差⑤（profiles 先例） |
| getPluginSkill 数据源 | session skill catalog（`ISessionSkillCatalog.catalog.getPluginSkill`，session 级目录） | face 方法 `getPluginSkill(pluginId, name)`，由 feature 自有 skill 贡献的最近 load 结果构建索引（`pluginId\0name` 小写归一，`contribute/skills.ts:30-62`）；skill 目录为 app 全局 | 第 46 轮偏差⑦；app 全局目录语义见第 47 轮④ |
| managed env 的 provider 查询 | 构造时捕获 env（`bootstrap.getEnv`），调用时 `await providers.ready` 屏障后读 `providers.get(KIMI_CODE_PROVIDER_NAME)`（`pluginService.ts:78-80/308-320`） | `node.resolveEntry(ProviderCatalogRef)` 可选探测、快照同步惰性读，无 ready 屏障；env 于调用时读 `process.env`（`state/managed-env.ts:11-25`、`feature.ts:58-63`） | 第 46 轮同日追加（「v2 的 `await providers.ready` 屏障消失…缺席 → 仅 env，与 v2 无 provider 行为一致」） |
| marketplace 签名 | `readPluginMarketplace(options)`（内部 `readFile`） | `readPluginMarketplace(fs, options)` 加 `fs: OsFsPort` 首参；`homedir()`/`fileURLToPath` 保留 node API（无端口等价物） | 第 46 轮同日追加 |

### 简化 / 保真度损失

| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| zip 解压不恢复可执行位 | `restoreFilePermissions`：`externalFileAttributes>>>16 & 0o777` → `chmod`（`archive.ts:134-140`） | 缓冲读取后 `writeBytes`，无 chmod（OsFsPort 无该 API，`archive.ts:92-99`） | zip-url/github 安装的插件内 `./` 相对命令（如 stdio MCP server 脚本）失去可执行位，可能无法直接 spawn。第 46 轮偏差①记录在案；归属：OsFsPort 端口扩展（chmod）后补回 |
| externalHooks 插件 hooks 未接线 | runner 合并 `config hooks + await plugins.enabledHooks()` 并在 `plugins.onDidReload` 上 reload（`externalHooksRunnerService.ts:36-39/113-119`） | `enabledHooks()` 数据面已实现并在 face 暴露（`manager.ts:282-298`，含 `cwd=pluginRoot` + `KIMI_CODE_HOME`/`KIMI_PLUGIN_ROOT` env 注入，逐字），但 externalHooks 域无任何消费（grep 实证 `features/externalHooks/` 零 `PluginRef` 引用） | 插件 manifest 声明的 hooks 永不执行。第 46 轮记录在案缺口②（「需 externalHooks 目录加插件 hooks 来源接入点」，第 44 轮 externalHooks 批次也列为待办） |
| pluginSections 注入未接 | `AgentProfileService.resolvePluginSections`：聚合预算 `PLUGIN_SECTIONS_MAX_BYTES = 64KB`、超限插件逐条 skip、`WarningIssued`（code `'plugin-sections-oversized'`）告警、按依赖序拼接 `<!-- From: plugin <id> -->` 块、`hasLoadedSnapshot()` 后冻结（`profileService.ts:102/140/891-925`） | `enabledSystemPrompts()` 数据面在 face 上（`manager.ts:355-364`），`profiles/render/vars.ts:31` 也保留了 `pluginSections` 渲染变量，但全仓无生产方调用 `enabledSystemPrompts()`——插件 systemPrompt 永不进入任何 agent 的 system prompt；连带 `hasLoadedSnapshot()` 在 harness-core 无消费方 | 插件的 `systemPrompt`/`systemPromptPath` 字段被解析但无效果。第 46 轮记录在案缺口③（「注入渲染需改 profiles/spawn 目录」）；v2 的 64KB 预算与告警事件随接线一并归属 |
| plugin commands slash 执行缺失 | `AgentPluginCommandService.activate`：`listPluginCommands` 查找 → `expandCommandArguments` → dispatch `PluginCommandActivated`（`'plugin_command.activated'`，observable）→ `loop.submit` user message（origin `{kind:'plugin_command', activationId, …, trigger:'user-slash'}`）→ main agent 更新 promptMetadata（`pluginCommandService.ts:38-84`）；TUI/kap-server 侧有完整 slash 消费链 | `listPluginCommands()` 与 `expandCommandArguments()` 已实现（`inspect/commands.ts:8-60`，与 v2 逐字），但无 activate 服务、无 `plugin_command.activated` 事件、无 promptMetadata 更新 | 插件 commands 只能列出不能执行。第 46 轮记录在案缺口⑤（归 skill/ACP 域后续接线，第 47 轮遗留条目同记） |
| /plugins CLI 与 kap-server REST 不迁 | kap-server `routes/plugins.ts`（list/install/remove/enable/marketplace REST）+ CLI `/plugins` 命令族消费 marketplace helpers；`PluginChanged`（`'event.plugin.changed'`）由 kap-server 在 `onDidReload` 上发布（`start.ts:366-369`） | 无 REST/CLI（任务契约不改 kap-server/apps）；marketplace helpers 已逐字移植但暂无进程内消费方；`PluginChanged` wire 事件无对应物 | 管理面入口暂缺（face 方法齐备，宿主可随时接）。第 46 轮记录在案缺口⑥⑦（⑥ 为宿主层职责，⑦「无消费方」） |
| `refreshSessionStart()` 显式入口 | `IAgentPluginService.refreshSessionStart()`：置 refreshPending + `await skillCatalog.ready` + `reconcileWhenIdle`；node-sdk 在插件 install/enable/disable/reload 后显式调用（`sdk-rpc-client-v2.ts:1530/1554`） | face 上无此方法；等价路径 = 显式 `reloadPlugins()` → `lastReload` ref → watch 置 refreshPending → 下一 beforeStep 重渲染 | 第 46 轮记录在案缺口⑧（「等价路径…已测试覆盖」） |
| mcp 管理面（registry） | `McpRegistryService.list` 把 `plugins.mcpServerEntries()` 列为 `source:'plugin'`、`mutable:false`、带 `plugin:{id,name}` 的 registry 条目（`mcpRegistryService.ts:79-88`） | `mcpServerEntries()` 数据面在 face 上（含 managed env 装饰），无 registry 消费方 | 宿主管理面（/mcp 管理 REST）未迁的一部分；第 46 轮缺口⑥同族 |
| 交付屏障弱化 | mutation resolve = 全部 onDidReload 监听者（skill catalog、mcp config、externalHooks、profile loader）reload 交付完毕 | 仅 skill 索引刷新被 await；skill catalog reload（onDidChange 驱动）、mcp `reloadServers()`、profiles `reload()` 均 fire-and-forget 最终一致 | `installPlugin` 等 facade 返回后，mcp/profiles 可能短暂未见新插件内容。第 46 轮偏差③记录在案 |
| capability 安装器 | `app/capability`（Kimi CU/WebBridge 检测安装，`CapabilityEntryContext.plugins` 消费 IPluginService） | 不迁 | 第 2 轮完整性核查③：维持 kap-server 宿主职责 |
| 显式 reload 的 refresh 时序小窗 | refreshPending 由「skill catalog 实际变更」（onDidChange）触发，重渲染必然读到的已是刷新后目录 | refreshPending 由 `lastReload.value` 赋值触发（watch 同步调度），而 skill 索引刷新在其后的 `onReload` await 链中才完成（`service.ts:118-126` → `feature.ts:64-84`）；显式 `reloadPlugins()` 路径下，若 beforeStep 恰在索引刷新完成前运行，会以旧索引重渲染 sessionStart | 代码核查发现（Handoff 未记）；窗口极窄（仅显式 reload 且与 turn 并发时），mutation 路径因计数器吞掉 reload 信号不受影响 |
| 栈级收口未完成 | — | `src/index.ts` 未导出 plugin、example 未挂载 `createPlugin`、`product-features.md` 无 plugin 专节（grep 实证；第 46 轮「收口待办」原样保留） | 第 46 轮记录在案（「本轮按用户指示未动共享文件」），待统一收口 |

### 新增 / 更强

| 差异点 | 说明 |
|---|---|
| `lastMutation`/`lastReload: ShallowRef` | v2 仅一次性事件（错过即无）；响应式 ref 使任意层随时可读最近一次 mutation/reload 摘要，也是 agent 层 watch 的数据源（`face.ts:34-35`） |
| `getPluginSkill(pluginId, name)` 进入 face | v2 需经 session skill catalog 查询；harness-core 作为 face 一等方法（`face.ts:53`），agent 层与宿主均可直用 |
| host 门控整体禁用 | 无 fs 能力的宿主（浏览器/远程）不注入 host 即整个 feature 缺席（含 facade），v2 无此能力决策点 |
| install 清理健壮性 | zip 暂存目录清理 `.catch(() => undefined)` 吞错（`manager.ts:181-183`）；v2 `finally` 中 `rm` 无 catch，清理失败会覆盖原始错误 |
| managed env 惰性读 env | v2 构造时捕获 env 后不变；harness-core 调用时读 `process.env`，进程中途变更的 `KIMI_CODE_BASE_URL`/`KIMI_CODE_OAUTH_HOST` 也能生效（语义略强的副产品） |

## 可配置项差异

| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `homeDir` | `IBootstrapService.homeDir` DI 注入 | `CreatePluginProps.homeDir` 必传 props | 已对齐（注入形态差异为架构惯例） |
| fs 能力 | 直接 `node:fs/promises` | `CreatePluginProps.host?: OsHost`（未传则整个 feature 缺席） | 人为设计（host 门控，第 22 轮先例） |
| warn 通道 | `ILogService` | `CreatePluginProps.onWarn?` | 人为设计（第 46 轮偏差⑤） |
| discoverSkills 覆盖点 | `PluginManagerOptions.discoverSkills?` | 同名同义（`state/manager.ts:40`） | 已对齐 |
| plugin 自有 config 节 | 无 | 无 | 已对齐（两侧都不注册） |
| `KIMI_CODE_PLUGIN_MARKETPLACE_URL` | 导出常量 + 默认 URL（读取方在 kap-server/CLI） | 同（`acquire/marketplace.ts:9-11`；读取方同属宿主层） | 已对齐 |
| managed env env 绑定 | `KIMI_CODE_BASE_URL` / `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`（构造时捕获） | 同三个（调用时读 `process.env`，`state/managed-env.ts:7-9`） | 已对齐（读取时机差异见「新增/更强」） |
| experimental flag | 无（v2 即默认启用集） | 无 flag；工厂形态不进 preset，宿主自行挂载 | 人为设计（工厂先例） |
| manifest 字段面 | name/version/description/keywords/author/homepage/license/skills(+rootSkillFallback)/agents/sessionStart/mcpServers/hooks/commands/interface/skillInstructions/systemPrompt(+systemPromptPath) + 不支持字段 info 诊断（tools/apps/inject/configFile/config_file/bootstrap）+ `PLUGIN_SYSTEM_PROMPT_MAX_BYTES = 32KB` | 逐字一致（`manifest/manifest.ts:20-29` 与 v2 `manifest.ts:19-28` 同源） | 已对齐 |

## 工具 / 事件 / facade 面差异

两侧均不注册任何 agent 工具。

**事件对照**

| v2 | harness-core | 状态 |
|---|---|---|
| `onDidReload: Event<PluginReloadEvent{added,removed,errors} & IWaitUntil>` | Feature 事件 `plugin.changed {summary}` + `lastReload: ShallowRef` | 语义对齐；waitUntil 交付屏障不迁（人为设计，第 46 轮③） |
| `onDidMutate: Event<PluginMutationSummary>` | Feature 事件 `plugin.mutated {summary含mutation}` + `lastMutation: ShallowRef` | 已对齐 |
| `PluginSessionStartEvent`（`'plugin.session_start'`，durable，zod）→ replayable snapshot | journal 事件 `plugin.session_start.snapshot` + fold 投影 | 已对齐（事件名与载荷 agentId 剔除为机制差异，第 46 轮④） |
| `PluginCommandActivated`（`'plugin_command.activated'`，observable） | 无 | 简化（记录在案缺口⑤） |
| `PluginChanged`（`'event.plugin.changed'`，wire，kap-server 发布） | 无 | 简化（记录在案缺口⑦） |
| `WarningIssued`（code `'plugin-sections-oversized'`） | 无（随 pluginSections 注入一并缺失） | 简化（随缺口③归属） |

**facade 对照**（v2 `IPluginService` 17 方法 → `PluginFace`）

- 全部对齐：listPlugins / installPlugin / setPluginEnabled / setPluginMcpServerEnabled / removePlugin / reloadPlugins / getPluginInfo / listPluginCommands / checkUpdates / pluginSkillRoots / pluginAgentRoots / enabledSessionStarts / enabledSystemPrompts / enabledMcpServers / mcpServerEntries / enabledHooks / hasLoadedSnapshot。
- 新增：`lastMutation` / `lastReload` / `getPluginSkill`（见「新增/更强」）。
- 缺失：`IAgentPluginService.refreshSessionStart()`（缺口⑧）；`IAgentPluginCommandService.activate()`（缺口⑤）。
- marketplace helpers（`computeUpdateStatus`/`resolveMarketplaceLocation`/`readPluginMarketplace`/`parsePluginMarketplace`/`withBuiltInEntries`/`withLatestVersions` + tiers/常量）两侧均为独立模块导出，逐字对齐（harness-core 368 行 vs v2 365 行，差 3 行为 fs 首参适配）。

**逐字对齐确认**（diff 级核查，无行为差异，不逐条列入上表）：install 三源解析与 GitHub atom/codeload 解析、managed copy 事务（staging→rename 发布 + persist 失败回滚）、installed.json tmp+rename 原子写、序列化语义（mutation 串行队列 / 初始 load 一次失败 latch / consumption read 未加载 fallback / `assertLoaded` 文案含 `/plugins reload` 指引）、双 manifest 形态（`kimi.plugin.json` 优先 + `.kimi-plugin/plugin.json` shadowed 记录）、`./` 路径约束与越界诊断、zip-slip 双层防护（yauzl 拒绝 + 自定义 PluginError）、`plugin-<id>:<server>` 运行时命名、`withPluginMcpRuntime`（Electron `ELECTRON_RUN_AS_NODE` / kimi 原生二进制 `__plugin_run_node` 回退 + env 注入）、enabledHooks 的 cwd/env 注入、sessionStart reminder 全文案（`<plugin_session_start plugin skill>` 块、NO_ACTIVE_SESSION_STARTS、SUPERSEDES_SUFFIX、五动词 mutation 文案）、agent 层仅 main 生效、missing skill warn 去重。

## 摘要

plugin 域是迁移保真度最高的一批：manager/manifest/acquire/marketplace 约 2800 行近乎逐行移植，service 序列化语义、sessionStart/mutation reminder 全文案、skill/profile/mcp 三个贡献通道（经 collection 贡献点接线，优先级数值与 v2 逐字一致）全部对齐，差异集中在「机制换形」（DI→createFeature、reminder 总线→remind、waitUntil→缩小版屏障、Error2→PluginError）这些有人为决策记录的层面。最重要的 3 个差异：① externalHooks 的插件 hooks 数据面已备但消费侧未接线（插件 hooks 不生效，第 46 轮缺口②）；② pluginSections 注入未接（插件 systemPrompt 解析后无处消费，连带 64KB 聚合预算与告警事件缺失，缺口③）；③ plugin commands 只有列举没有 slash 执行链路（缺 `plugin_command.activated` 事件与 promptMetadata 更新，缺口⑤）。最需关注的执行层缺口是 zip 解压不恢复可执行位（偏差①，影响 zip/github 来源插件的 stdio MCP 脚本），以及栈级收口（包出口/example/docs）仍按第 46 轮记录留在待办。
