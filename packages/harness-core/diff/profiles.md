# profiles：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/profiles/`（ts 约 1847 行；含 system.md 82 行 + explore-overlay.md 23 行共约 1952 行）
- agent-core-v2：`src/agent/profile/`（1748 行）+ `src/app/agentProfileCatalog/`（608 行 + system.md）+ `src/workspace/workspaceAgentProfileLoader/`（1102 行，finder 的实际对应位置）+ `src/session/sessionAgentProfileCatalog/`（247 行）+ `src/session/agentLifecycle/profile/`（内置 profile 与 gitContext，约 380 行），合计约 4100 行
- 蓝本关系：v2 现行 DI 实现为逐字蓝本（非 refact-237 第一批 human 蓝本）。类型/render/catalog 合并/文件加载/discovery/roots/SYSTEM.md/git-context/delegation 基本逐字；v2 的 App registry → Session catalog 投影 → Agent profileService 三层收敛为 app 单 slot 的 `createProfiles` 工厂 + spawn 消费（Handoff 第 19 轮）。agent-core-v2 侧无 registerFeature 式 Feature，profile 能力是散布在 scope service 与全局注册表里的。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 形态与分层 | App 级 `AgentProfileRegistryService`（按 `[sourceId, workspaceKey]` 键收贡献，支持多 workspace）→ Session 级 `SessionAgentProfileCatalogService` 按 workspaceKey 过滤投影 → Agent 级 `AgentProfileService`（bind/模型/thinking/工具集） | app 单 slot：`ProfileFinders` collection 聚合 → `buildCatalogView` 一次性建视图，`ProfileCatalogRef` facade（`feature.ts:50-196`）；单 workDir props，无多 workspace 维度 | 约束问答（Handoff :176-177，用户 2026-09-29 定：Profile 拆独立 Feature、默认 finder 初始化注入）；第 19 轮 |
| 与 spawn 的关系 | Agent 工具经 DI 注入 `ISessionAgentProfileCatalog`，恒注册；catalog 未 ready 时描述用未冻结列表 | `createSpawn` agent slot 挂载时 `providerRef(ProfileCatalogRef)` 可选探测，props.catalog 与 profiles feature 皆无则 **Agent 工具不注册**（`spawn/feature.ts:36-38`） | 约束问答后续补充②（用户定：响应式门控、spec freeze 语义）；第 19 轮 |
| profile 来源接口 | 五个固定 DI loader（user/workspace/extra/explicit/plugin）+ App 级全局 `registerAgentProfile` 注册表（`contribution.ts`） | `ProfileFinder { sourceId, priority?, fatal?, load() }` 接口 + `useProfileFinder` 贡献钩子，晚注册响应式触发整体重建（`discovery/finder.ts`、`feature.ts:173-175`）；内置四 profile 收敛为静态 `BUILTIN_PROFILES` + `createBuiltinFinder`（`builtin.ts:112-163`） | 约束问答（useProfileFinder，useConfigSection 模式）；plugin 第 46 轮、tower 第 42 轮（`feature:tower` sourceId）经此接通 |
| agent 层 bind 机制 | `AgentProfileService.bind/applyBindingSnapshot/update` 派 `ProfileBind`/`ConfigUpdate`/`ToolsSetActiveTools` 三个 durable 事件驱动 profile state（`profileService.ts:273-339`、`profileOps.ts:38-116`） | 不迁：spawn 创建子代理时一次性 `renderSystemPrompt({cwd}).text` 绑定（`spawn/run.ts:156`）；main agent 的 profile 绑定属宿主层 | 第 19 轮决定⑤ |
| workspace 目录监视 | workspace loader 监视 projectRoot（`subtreeWatchFilter` 候选目录，200ms 防抖自动 reload，`workspaceAgentProfileLoaderService.ts:61-80`） | 不监视；`ProfileCatalogFace.reload()` 显式触发（`feature.ts:192`） | 第 19 轮决定⑥（用户批准先例，skill 第 45 轮同决策） |
| `extraAgentDirs` 配置 | config 节 `extraAgentDirs`（zod `string[].optional()` 默认 `[]`），节变更订阅触发 extra loader reload（`configSection.ts`、`extraAgentProfileLoaderService.ts:42-51`） | 无 config 节；`props.extraAgentDirs` 初始化时注册 extra finder，无响应式 | 第 19 轮决定⑥（config 节订阅不迁的连带结果） |
| explicit agent files 来源 | `bootstrap.args.agentFiles`（CLI 参数），loader `fatal: true` 上抛（`explicitAgentProfileLoaderService.ts:27,45-59`） | `props.explicitAgentFiles`，finder `fatal: true` 逐字（`discovery/finders.ts:111-130`） | 对齐（宿主概念走 props） |
| 未知名称报错文案 | 两处并存：profileService `Unknown agent profile: "<name>". Available profiles: …` 与 subagentService `Unknown agent type: "<name>"` | 取前者原文（`spawn/plan.ts:153`） | 第 19 轮决定⑦ |
| Agent 工具描述的 Tools 行 | `buildProfileDescriptions` 经 toolPolicy `isToolActiveForProfile` 过滤，并在 NotifyUser 不可用时从列表剔除（`agentTool.ts:156-165,642-684`） | 按 profile.tools/disallowedTools 原文打印，无 policy 过滤（`spawn/tool.ts:177-193`） | 第 19 轮决定③（无 policy 层，归属 #19 permission） |
| SYSTEM.md 品牌目录 | `loadSystemMdProfile(fs, bootstrap.homeDir, …)`，`override: true` 继承 builtin 默认字段（`internal/systemFile.ts`） | 逐字对齐（`discovery/system-file.ts`）；homeDir 取 `props.home ?? KIMI_CODE_HOME ?? ~/.kimi-code`（`feature.ts:57`） | 已对齐 |
| user basePrompt 链 | user loader：`systemMd ?? builtin.getDefault()` 惰性闭包，workspace/extra/explicit/plugin 均基于此 | 同构（`feature.ts:67-68`、`discovery/finders.ts:39-43`） | 第 19 轮决定①（编排者按 v2 代码修正） |
| brand/generic 目录关系 | brand 组与 generic 组各自 pushFirstExisting、两组并列收录（单元素组实际等效并列） | 逐字（`discovery/roots.ts:13-35`） | 第 19 轮决定②（按代码对齐，非任务规格书的互斥） |
| 警告通道 | `ILogService.warn`（结构化 payload） | `props.onWarn` 回调；git-context 日志格式从结构化改为内联文案（`render/git-context.ts:143-160`） | 第 46 轮决定⑤同款（profiles 先例） |
| host 处理 | DI 注入 `IHostFileSystem`/`IHostProcessService`，恒可用 | `props.host ?? createNodeOsHost()`（`feature.ts:51`，spawn 先例）——**注意与 skill/plugin 的「host 未传不挂载」门控相反**，文件加载恒可用 | 第 19 轮（早于第 22 轮 host 门控决策，代码事实如此） |
| 加载就绪语义 | session catalog `ready` 立即 resolve（`sessionAgentProfileCatalogService.ts:57-59`），loader 各自 enqueue 后台填充，bind 前无全量屏障 | 首载 `useReady(ready)` 门控 app ready（`feature.ts:177`），「会话打开前 catalog 就绪」 | 第 19 轮（createProfiles + useReady 门控首载） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| 子代理 systemPrompt 上下文 | `buildSystemPromptContext` 组装全量上下文：osKind/shellName/shellPath/cwdListing/agentsMd(+32KB oversized 警告)/additionalDirsInfo/skills/pluginSections/productName/replyStyleGuide/notifyUserActive（`profileService.ts:805-851`、`context.ts` 430 行） | spawn/sessionInit 只传 `{cwd}`（`spawn/run.ts:156`、`sessionInit/feature.ts:84`）；skills 已由 skill feature `useSystemPrompt` 统一注入消解（第 45 轮①）；其余变量均无填充方 | 第 19 轮决定④在案；**pluginSections 注入为第 46 轮记录在案缺口③**（`PluginRef.enabledSystemPrompts()` 数据面已备，需改 profiles/spawn 目录）；cwdListing/agentsMd/os/shell/productName/replyStyleGuide 填充未立项 |
| Plugin Instructions 预算与警告 | 聚合 64KB 预算（`PLUGIN_SECTIONS_MAX_BYTES`），超预算跳过并派发 `plugin-sections-oversized` WarningIssued（`profileService.ts:891-925`） | 随上项一并缺失 | 第 46 轮缺口③的一部分 |
| ProfileBind/ConfigUpdate durable 事件与恢复 | durable journal 事件 + replayable state（`profileOps.ts:38-88,130-227`），重启/恢复后可还原绑定 | 无 durable state；重开时由创建方重新渲染绑定 | 第 19 轮决定⑤在案（config 永不持久化原则，第 8 轮同款） |
| tool pattern warnings | bind 时校验 profile tools/disallowedTools 与全局 [tools] 配置的模式有效性（unknown-tool/wildcard-not-mcp/incomplete-mcp-name 三类 WarningIssued，`profileService.ts:756-803`） | 不迁 | 第 19 轮决定⑤在案 |
| 多 workspace 隔离 | registry 按 workspaceKey 区分贡献，session catalog 只投影本 workspace 条目（`sessionAgentProfileCatalogService.ts:93-98`） | 单 catalog 单 workDir；多 workspace 宿主需各自挂 createProfiles | 未单独在案（随形态收敛的连带简化） |
| catalog 变更对外事件 | `onDidChange<string>`（按 sourceId  firing），Agent 工具描述在 ready 前用未冻结列表、ready 后冻结 | 无对外事件；`watch(finders)` 内部 queueRebuild 重建（`feature.ts:167-175`）；消费方（spawn）在挂载时取快照 | 影响小（plugin reload 走显式 `reload()`，第 46 轮③ fire-and-forget 最终一致） |
| AgentStatusUpdated / model_switch / thinking_toggle 遥测 | profileService 内埋点（`profileService.ts:345-368,614-635`） | 不迁 | 遥测批次待补（横切已知） |

### 新增 / 更强
| 差异点 | 说明 |
| --- | --- |
| `ProfileFinder` 开放贡献点 | 任意 feature/宿主可注册新来源（plugin 第 46 轮、tower 第 42 轮已接通）；`fatal` 标志控制失败上抛；晚注册响应式整体重建——v2 需新增 DI loader 类 |
| `createStaticProfileCatalog` | 宿主注入静态 profile 集（测试/嵌入场景），实现 `ProfileCatalog` 四方法最小接口（`catalog/catalog.ts:146-172`）；v2 无等价物（只能走全局注册表） |
| 首载强保证 | `useReady` 门控使「首个会话打开前 catalog 已合并完毕」成为硬保证；v2 的 bind 只等立即 resolve 的 ready，loader 填充是后台竞态 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| `extraAgentDirs` 节 | config 节（zod `string[].optional()` 默认 `[]`）+ 变更订阅触发 extra reload | `props.extraAgentDirs`（初始化注册，无节无订阅） | 人为设计（第 19 轮⑥） |
| explicit agent files | `bootstrap.args.agentFiles`（CLI） | `props.explicitAgentFiles` | 已对齐（宿主概念） |
| brand home | `bootstrap.homeDir`（读 `KIMI_CODE_HOME`） | `props.home ?? process.env.KIMI_CODE_HOME ?? ~/.kimi-code`（`feature.ts:57`） | 已对齐 |
| workDir | `IWorkspaceContext.cwd` | `props.workDir` | 已对齐（宿主概念） |
| 自定义 finder/贡献 | 全局 `registerAgentProfile`（仅 builtin 语义）或新写 DI loader | `props.finders` + `useProfileFinder` | 新增 / 更强 |
| 警告回调 | DI `ILogService` | `props.onWarn` | 人为设计（profiles 先例） |
| host 端口 | DI `IHostFileSystem`/`IHostProcessService` | `props.host?: OsHost`（缺省自建 node host） | 人为设计（spawn 先例；与 skill host 门控不一致，见上表） |
| experimental flag | —（本域无 flag 门控） | —（同） | 已对齐 |

## 工具 / 事件 / facade 面差异
- **facade**：`ProfileCatalogFace`（`ready/list/get/getDefault/inspect/reload`，`feature.ts:33-38,178-193`）↔ v2 `ISessionAgentProfileCatalog`（`ready/get/getDefault/list/inspect/load/reload/onDidChange`）+ `IAgentProfileRegistry`（`entries/register/onDidChange`）+ `IBuiltinAgentProfileLoader`（`get/getDefault/list`）。差异：无 `onDidChange` 对外事件；`inspect` 形状（`AgentProfileInspection{ name, profile, sourceId, priority, suppressed }`）两侧逐字一致。
- **事件**：无 Feature 事件（`createFeature('profiles', …)` 不带事件参数）。v2 的 durable `profile.bind`/`config.update`/`tools.set_active_tools`/`tools.reset_active_tools` 与 observable `warning` 均不迁（第 19 轮⑤）。
- **工具**：profiles 自身不注册工具；对 Agent/AgentSwarm 工具的作用是「catalog 在场才注册」的门控与描述数据源（见行为差异表）。
- **render 面**：`renderPrompt`（未知变量保留原文）/ `systemPromptVars` / `renderSystemPromptResult` / `renderPromptTemplateResult`（`${base_prompt}` 惰性求值）/ `renderAgentProfilePrompt`（notify 追加）与 system.md、explore-overlay.md 全部逐字节对齐（cmp 实证）；`normalizeAgentProfile`/`AgentProfileInput` 联合类型逐字；`collectGitContext`（5s SIGKILL、六 host 白名单、Dirty 20 条、commit 200 字符截断）语义逐字、仅端口类型与日志格式偏离。

## 摘要
profiles 域迁移了 v2 的 catalog 半部（finder/discovery/合并/渲染/委派）且保真度很高——文件格式校验文案、六级 source priority（builtin 0/plugin 5/user 10/extra 20/workspace 30/explicit 40）、override 门槛、subagents 继承、SYSTEM.md、git-context 均逐字；finder 贡献点体系比 v2 的固定 DI loader 更开放（plugin/tower 已接通）。最重要的三个差异：① v2 agent 层 profileService（bind/durable 事件/模型与 thinking 管理/tool pattern warnings）整体不迁，main agent 绑定归宿主（第 19 轮⑤）；② 子代理 systemPrompt 上下文只有 `{cwd}`，v2 的全量环境上下文（os/shell/cwdListing/agentsMd/pluginSections 等）无填充方，其中 skills 已由 skill feature 统一注入消解、pluginSections 是第 46 轮记录在案缺口；③ workspace 目录监视与 extraAgentDirs config 节订阅不迁，改显式 `reload()`（第 19 轮⑥）。最需关注的缺口：pluginSections 注入（数据面 `enabledSystemPrompts()` 已备，注入渲染待做）与 v2 多 workspace 隔离维度的丧失（当前单 workDir 形态）。另注意 profiles 的 host 缺省自建（`createNodeOsHost()`）与 skill/plugin 的 host 门控约定不一致，浏览器/远程宿主场景需宿主显式决策。
