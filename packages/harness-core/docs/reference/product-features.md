# 产品 Feature 一览

`src/preset.ts` 的 `features` 是默认名单；工厂形态的 Feature 由宿主组装后推进名单（参照 [01](how-to-guides/01-run-a-turn.md) 与 [07](how-to-guides/07-use-provider-catalog.md) 的装配方式）。本页按 Feature 给出：规格名、所在层、props、facade、事件、是否在默认名单。

## profiles（工厂，不在默认名单）

`createProfiles({ workDir, host?, home?, finders?, extraAgentDirs?, explicitAgentFiles?, onWarn? })`：profile 目录聚合与渲染（v2 `agent/profile` + 各级 catalog 迁移）。app 层。`host` 未传入时 user/workspace/extra/explicit finder 不注册（builtin 仍可用）；`home` 缺省读 `KIMI_CODE_HOME` env，解析不出则不注册 user finder（workspace basePrompt 回落 builtin 默认）。

- finder 管线：`ProfileFinder`（`load()` + 可选 `watch`）+ `ProfileFinders` collection + `useProfileFinder` 贡献钩子（晚注册响应式并入）。默认 finder 初始化注入：builtin（agent/coder/explore/plan 四静态 profile，priority 0）、user（`~/.kimi-code/agents` + `~/.agents/agents`，10）、workspace（`<workDir>/.kimi-code/agents` + `<workDir>/.agents/agents`，30）；extra（20）/ explicit（40）走 props；plugin（5）由 plugin Feature 经贡献钩子接入。catalog 聚合：同名高优先级覆盖；覆盖 builtin 需 profile 声明 `override: true`，否则 suppressed 并记诊断。
- profile 文件为 v2 markdown + frontmatter 格式逐字（`name`/`description` 必填、`model`/`tools`/`disallowedTools`/`whenToUse`/`override` 等键；扫描深度 8、跳过隐藏目录与 node_modules、同名先见者赢、skip 诊断汇总）。
- facade：`ProfileCatalogRef`（app 层）：`ready` / `list` / `get` / `getDefault` / `inspect`（含 skipped/scannedRoots 诊断）/ `reload` / `renderSystemPrompt` / `promptPrefix`。fs 目录监视不迁（v2 为 fswatch），`reload()` 代替。
- 消费方：spawn 的 `Agent` 工具 catalog（props override 缺省经 `useInject(ProfileCatalogRef)` 解析）、sessionInit 子代理 systemPrompt、swarm。
- `host` 缺省 `createNodeOsHost()`（profile 文件扫描与 explore 的 `<git-context>` 收集走 OsHost 端口）。

## spawn（工厂，不在默认名单）

`createSpawn(props?)`：把 `Agent` 工具装到每个 agent 上，模型调用它派生子代理。

- props：`catalog?`（profile 目录 override；缺省经 `ProfileCatalogRef` 解析 profiles Feature 的目录，两者皆无则 `Agent` 工具不注册）、`models?`（工具描述里列出的可选模型）、`forkEnabled?`（默认读 `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK`）。
- 工具参数：`prompt` / `description` / `subagent_type`（默认 `coder`）/ `resume` / `run_in_background` / `fork`（flag 门控）/ `model`（`'primary'` 继承调用方）。
- 行为：校验（静态互斥 + planSpawn 白名单/profile/模型）→ `session.create` / `session.fork` 建子代理（roster 写 `source: 'spawn:<parent>:<profile>'`，模型总是 `setConfig(调用方 config)`、显式 `model` 再覆盖）→ `submit` 等终态（按 `turnId` 关联）→ 取子代理最后一条 assistant 文本作交接摘要。后台走 `detach`，完成经 async-tool 通知回父代理。fork 复制调用方完整历史并注入 `FORK_CONTEXT_NOTICE`。resume 从 roster 的 source 派生成员身份；子代理非 live 时 `session.create({ agentId })` 按已注册分支/features/spec 重开，跨进程重启同样可 resume（重开后 config 由 agent 层 Feature 实时绑定，不保留显式模型覆盖）。
- 事件：无镜像事件通道——子代理的一切由统一事件面描述：身份与创建者（roster source + `agent.opened`/`agent.closed` 节点事件）、调用关联（Agent 工具调用的 `turn.spawn_tools`/`tool.done`，启动后经 `onUpdate` 发 `tool.update {key:'subagent', text: agentId}` 关联 toolCall↔子代理）、过程与产出（子代理自身 `turn.started`/`turn.done` 及 llm/tool 事件，冒泡携带 sessionId/agentId）。
- facade：`SpawnRegistryRef`（session 层 registry，`handle.resolve(SpawnRegistryRef)`）。
- 注意：工具描述是静态的（agent spec 首包冻结，见 [store-model](../explanation/store-model.md)），可选模型列表只来自 props `models`，不读调用方 config。

## btw（默认名单）

`createBtw(props?)`：旁路问题。从 main（默认）fork 一个只读子代理，等宿主把用户的旁路问题直接提交给它。

- props：`sourceAgentId?`（默认 `MAIN_AGENT_ID`）、`readonlyTools?`（只读工具白名单，默认 `['Read', 'Grep', 'Glob', 'WaitFor']`）。
- facade：`BtwRef`（`session.resolve(BtwRef)`）：`ask(): Promise<{ agentId }>` 做 fork（把 `source: 'btw'` 登记进 roster）+ 注入旁路 reminder；`list()` / `isBtw(agentId)` 从 roster 的 `source` 字段派生，remount 与 undo/compaction 换分支（`agent.switched` 保留 source）后仍然成立。
- 约束：btw agent 上白名单外的工具调用一律 denied（`useBeforeTool` 查 roster `source`），main 与其它 agent 不受影响。
- 事件：`btw.created`（`agentId` / `sourceId`）。

## dateChange（默认名单）

`createDateChange(props?)`：跨天注入新日期。每个 LLM step 前（`useBeforeStep`）比较本地日期，变了就 `agent.remind(…, { key: 'date-change' })`（首次与跨天文案不同）；remount 后从历史扫描已注入记录，同天不重复。

- props：`now?`（时钟注入，测试用）、`timeZone?`（默认宿主时区）。
- 无 facade、无事件。


## kimi（复合 Feature，工厂，默认名单）

`createKimi(props?)`：kimi 平台全家桶——核心 provider 注册（`useProvider(kimiProvider)` + `useProviderProtocol({ type: 'kimi' })`）与五个子 Feature（oauth / web / fetch / sessionTitle / trace）的 spec 级组合。

- props：`oauth?`（`CreateOauthProps`）、`web?`（`CreateWebProps`）、`fetch?`（`CreateFetchProps`），透传给子 Feature 的 slots 工厂。
- 组合方式：子 Feature 的 slot setup 在 `kimi:<tier>` 同一节点上顺序执行（app：核心注册 → oauth → web → fetch；session：sessionTitle；agent：web → fetch → sessionTitle → trace）。不是节点嵌套——`useExpose` / `useInject` 的落点与三者扁平挂载时逐点等价，facade 解析（`app.resolve(OAuthTokensRef)` / `session.resolve(SessionTitleRef)` 等）不受影响。子 setup 返回的 cleanup 由组合器收集、逆序执行。
- 名单语义：preset 里只占一个 `kimi` 名（roster 记录的 agent features  likewise），`uninstallFeature('kimi')` 级联卸载全部。不要再把 `createKimi()` 与 `createOauth()` / `createWeb()` / `createFetch()` / `sessionTitle` / `trace` 并列进同一名单——dedup 按 featureName，名字不同不会拦截，子 Feature 会跑两份。
- 子 Feature 保持独立目录与导出（`src/features/kimi/{oauth,web,fetch,sessionTitle,trace}/`，各自含 `index.ts` 与 slots 工厂），测试与定制宿主可单独挂载。

## trace（kimi 子 Feature）

`trace`（原 kimi-trace，改名收编）：agent 层捕获最近一次 LLM 请求的 trace id。

- facade：`TraceRef`（agent 层）：`traceId: Ref<string | undefined>`——从 `llm.streaming.headers` 与 `llm.failed.remote` 的 `x-trace-id` 响应头捕获。

## oauth（kimi 子 Feature，工厂）

`createOauth(props?)`：managed OAuth 凭证地基——token facade + oauth-catalog 物化 + 模型目录刷新调度。web / sessionTitle 等域经它的 facade 取 token。默认经 `createKimi()` 进名单，单独挂载亦可。

- props：`home?`（token 存储根目录，默认 `KIMI_CODE_HOME ?? ~/.kimi-code`）、`fetchImpl?`。
- 职责：① `CatalogOAuthRef` → `BearerTokenProvider`（FileTokenStorage + OAuthManager `ensureFresh` 惰性刷新，同 key 缓存复用；无后台定时刷新）；② watch catalog snapshot，对 `modelSource: 'oauth-catalog'` 且非 live 的 provider 按 `info.type` 查 `ProviderProtocols` 注册表物化（models 源 = managed 目录拉取，Bearer 经 token facade），`store.refresh` 绑定——discovered 模型走 provider-catalog 既有 writeback 回写 models 节；③ `managed:kimi-code` 缺 `aliasScope` 时补写为 `kimi-code`（config `'user'` target，模型键按 `kimi-code/` 平台前缀分区）；④ refresh 调度：model_catalog 节 `refresh_interval_ms`（默认 6h）/ `refresh_on_start`（默认 true），setTimeout 链 + `pushCleanup`；⑤ 向 provider-catalog 的 `CredentialResolvers` 贡献 oauth resolver（`createOAuthCredentialProvider`，401 canRecover + invalidate 强刷为 agent-core 内建）。
- facade：`OAuthTokensRef`（`useOauth()`）：`resolve(ref): BearerTokenProvider | undefined` / `refresh(): Promise<{ changed, unchanged, failed }>`——kap `refreshOAuthProviderModels` 同语义编排：遍历 oauth-catalog provider 逐个拉 managed 目录（单链串行），按 `${aliasScope ?? providerId}/` 前缀在 config models 节取旧集合与拉取结果 diff 出 added/removed（记录内容漂移记 changed 0/0），失败聚合进 `failed` 不抛出；成功结果经一次性注入走 store.pull → writeback 落盘（单次拉取）。config 未加载时整体惰性不报错（空 report）。
- 无事件。login/logout 设备流不在本域（宿主层职责，`@moonshot-ai/kimi-code-oauth` 的 OAuthManager 已具备能力）。

配套机制（agent-core provider-catalog）：`default_model` config 节持久化模型选择（别名 `${aliasScope ?? providerId}/${modelId}`）；`CredentialResolvers` collection + `useCredentialResolver`（注册序取第一个非 undefined，静态 apiKey/env 兜底排最后）；provider-catalog 的 agent slot 在挂载时读 defaultModel → `CatalogModels` 解析 binding → `setConfig` + `setRequester` + `setCredentialProvider`，显式 `setConfig` 先到则不再覆盖（resume 自动恢复绑定，凭证永不落盘）。

## web（kimi 子 Feature，工厂）

`createWeb(props?)`：`WebSearch` 工具 + 搜索 provider 解析。FetchURL 已落地为平级子 Feature fetch（见下节），与其共享 services 节与 OAuth 通道。默认经 `createKimi()` 进名单，单独挂载亦可。

- props：`fetchImpl?`、`identity?`（`KimiIdentityOptions` 生成 `X-Msh-*` 默认头；`KIMI_CODE_CUSTOM_HEADERS` env 层始终生效、优先级最低）。
- provider 解析（app 层，每次调用惰性重算）：`services.moonshot_search` 配置节（entry 自带 oauth ref 或 apiKey；`KIMI_WEB_SEARCH_BASE_URL` / `KIMI_WEB_SEARCH_API_KEY` env 绑定）> managed OAuth 兜底（catalog 的 `managed:kimi-code` 须 oauth-catalog + oauth ref，baseUrl `{baseUrl ?? kimiCodeBaseUrl()}/search`，token 经 oauth facade）。
- 工具（agent 层，挂载时门控，无 provider 不注册；spec freeze 下不做会话中途重激活）：`WebSearch({ query })` → POST `{text_query}`，Bearer + `X-Msh-Tool-Call-Id`；输出 `Title:/Site:/Date:/URL:/Snippet:` 块 + `---` 分隔 + markdown 引用提醒，空结果 `'No search results found.'`；错误五类分类（cancelled/timed out/authentication/network/通用）；abort 原样重抛；执行期 provider 消失返回固定降级文案。
- facade：`WebSearchRef`（`useWebSearch()`）：`getProvider(): WebSearchProvider | undefined`。无事件。

## fetch（kimi 子 Feature，工厂）

`createFetch(props?)`：`FetchURL` 工具 + 抓取器三级解析（v2 `app/web` 的 fetch 半）。默认经 `createKimi()` 进名单，单独挂载亦可。

- props：`fetchImpl?`、`identity?`（同 web 子 Feature）。
- 抓取器解析（app 层 facade，每次调用惰性重算）：`services.moonshot_fetch` 配置节（复用 web 子 Feature 注册的 services 节，不重复注册；`KIMI_WEB_FETCH_BASE_URL` / `KIMI_WEB_FETCH_API_KEY` env 绑定；token 经 `OAuthTokensRef` 解析 oauth ref、回落 apiKey）> managed OAuth 兜底（catalog 的 `managed:kimi-code` 须 oauth-catalog + oauth ref，baseUrl `{baseUrl ?? kimiCodeBaseUrl()}/fetch`）> 本地抓取器（恒在）。
- 托管抓取：POST `{url}` + `Accept: text/markdown` + Bearer + `X-Msh-Tool-Call-Id`；非 200 或网络失败（abort 除外）静默回落本地抓取器；成功结果恒 `extracted`（服务端已抽正文）。
- 本地抓取：仅 http/https；SSRF 私网 BlockList + `localhost` 拒绝 + DNS 逐地址校验 fail-closed；手动重定向 ≤10 跳每跳重校；undici `connect.lookup` DNS 钉扎（代理且不匹配 NO_PROXY 时跳过）；>10MB 拒绝；`text/plain`/`text/markdown` → `passthrough` 原文；其余 `@mozilla/readability` + `linkedom` 抽正文（兜底 article/main/body，全空报「may require JavaScript」）；有标题前缀 `# title`。
- 工具（agent 层，挂载时注册，本地兜底恒在故无条件）：`FetchURL({ url })`；空 body → `'The response body is empty.'`；成功 → 头部 note（passthrough/extracted 两版）+ 引用提醒 + 正文（整体 10M 字符截断）；错误两版文案；abort 原样重抛。文案与 v2 逐字一致。
- facade：`WebFetchRef`（app 层，`useWebFetch()`）：`getUrlFetcher(): UrlFetcher`。无事件。v2 的审批规则 / display / accesses 元数据与 telemetry 不迁（permission 域与遥测总线未落地）。

## sessionTitle（kimi 子 Feature）

纯被动会话标题生成（对齐 v2 core：不订阅事件，由宿主/客户端触发）。默认经 `createKimi()` 进名单，单独挂载亦可。

- facade：`SessionTitleRef`（session 层，`useSessionTitle()`）：`generateTitle({ force?, source? }): Promise<string | undefined>`。`source`：`user_prompts`（默认，前 3 条自然语言 prompt 各 400 字符、总长 1000）/ `first_turn`（首条 user 400 + 该轮末条 assistant 300，缺 assistant 返回 undefined）/ `digest`（每轮 user/assistant 各 200、总长 3000、中间 `...` 省略）。摘录从 main agent 的 history 实时组装（origin 过滤、skill 捆绑块剥离、按 userMessageId 去重、跳过 compaction elision/summary、密钥脱敏）。
- 生成通道：managed `/tools` `chat_title`——catalog 的 `managed:kimi-code` 须 oauth-catalog + oauth ref（env 覆盖经 `resolveKimiCodeRuntimeAuth`）；Bearer 经 oauth facade；8s 超时；401 强刷重试一次仍败返回 undefined；`title.slice(0, 200)`；非 OAuthError 异常上抛。
- titleKind：`SessionRecord.metadata['titleKind']`（`replaceable` / `generated` / `custom`）——非 force 遇 `custom|generated` 早退、写入前再查 `custom`（生成中竞态不覆盖用户标题）、`force` 可覆盖；非 force 调用共享一个 in-flight Promise。写入走 `app.updateSession`（自动派 `session.meta_updated`）。
- HTTP：`POST {prefix}/sessions/:session_id/title/generate`（body `{force?, source?}`；session 非 live 40401；无可用标题 40923）。

## ptc（工厂，flag 门控，不在默认名单）

`createPtc(props)`：把 `Code` 工具装到每个 agent 上，模型写一段 JavaScript 编排当前 agent 上已注册的工具（Programmatic Tool Calling）。代码作为 async 函数体执行（临时文件 + dynamic import，进程内、与 Bash 同级风险），`await tools.<name>(args)` 调工具、`console.log` 出结果、`return` 给最终值；中间工具结果只是 JS 值、不进 history，只有 `Code` 的 ToolResult（stdout 截断 + return 序列化截断，或 error 摘要）回模型。

- props：`dir`（宿主注入的产物目录，shim/program 临时文件落点，按 agent + 执行次数分层）、`exclude?`（工具黑名单，目录与调用两侧都生效；`Code` 自身永远排除）、`limits?`（`maxToolCalls` 默认 50 / `maxOutputBytes` 默认 32KB / `timeoutMs` 默认 120s）、`context?`（上下文访问分级：`'none'` 默认 / `'readonly'` / `'full'`）、`enabled?`（默认读 `KIMI_CODE_EXPERIMENTAL_PTC` 或 `KIMI_CODE_EXPERIMENTAL_FLAG`）。
- 可调面：默认全部已注册 executors——含 deferred 工具（注册不上线）与 `useToolExecutor` 的 executor-only 工具（不在目录里，知道名字即可调）；沙箱内调用走 `beforeTools`/`afterTools` 链（veto/改写不被绕过，denied 结果作为返回值交给代码）。
- 上下文（`context` 开启时）：沙箱内多出 `useAgent()` / `useAgentStore()` / `useBlobs()` / `useSession()` 四个访问器，返回当前 agent 的 live facade（命名对齐 Feature 开发，但语义是 execute 期「取回 handle」而非 setup 期「注册贡献」；`fold` 不可用，状态读用 `getState()` 快照）。`'readonly'` 给 `getState` / `blobs.get/has` / `agent.on/wait` / session 只读面；`'full'` 追加 `store.dispatch` / `blobs.put` / `agent.remind/notify/submit` 等写命令与完整 session。`agent.on` 订阅在执行结束统一退订（drain）。注意：裸 facade 调用不走 `beforeTools` 策略链，只在信任该 agent 自带上下文时开 `'full'`。
- 目录：工具描述内嵌按预算截断（8K 字符）的签名目录，在 ptc slot 挂载时渲染——spec 冻结语义下是静态的，宿主应把 ptc 排在名单末尾，否则后注册的工具不在目录中（仍可凭名字调用）。
- 沙箱内 API：`tools.<name>(args): Promise<string>`（文本化结果，非文本 part 占位符）、`console.log/info/warn/error`、`detach(text)`（整段执行转后台，完成走 async-tool 通知）。
- 无 facade、无事件；flag 关闭时不注册任何工具。
## plan（工厂，默认名单）

`createPlan(props?)`：plan 模式——只读调查 → 写 plan 文件 → 审批后退出执行。

- props：`storage?`（`PlanStorage` 端口：`readText/writeText/pathFor`，对齐 `createConfig({persist})` 范式；无 storage 时纯内存默认）。plan 文件路径由端口决定，提醒与守卫展示用。
- 状态：`plan` 投影（`active/id/revisionCount/wasActive`），journal 事件 `plan_mode.enter/cancel/exit` + `plan.revision`（快照进 blobs，sha256 即 blob ref）；remount 从投影恢复，undo 分支切换随 agent.switched 自然成立。
- 工具：`EnterPlanMode`（重复进入报错；workflow 文案分有/无 plan 路径两版）/ `ExitPlanMode`（非 active 或空 plan 报错；`options` ≥2 时进审批展示，校验 1–3 个/label 1–80/唯一/非保留标签）。
- 守卫（plan 自有特性，非 permission）：`useBeforeTool`——plan 激活时 Write/Edit 仅 plan 文件放行（双键 `file_path`/`path` 读取，os 工具组落地后收敛）；TaskStop / CronCreate / CronDelete deny；文案对齐 v2。
- 审批（走 interaction，不走 permission）：ExitPlanMode 且 plan 非空时 `interactions.request({ kind: 'approval', payload: { plan, path, options? } })`——五分支对齐 v2：approved（exit + `## Approved Plan:` + 选中 option 前缀 `Selected approach:`）/ cancelled（留 mode）/ `Reject and Exit`（exit + 拒绝文案）/ `Revise` 或带 feedback（留 mode + 反馈）/ 默认 reject（留 mode）。`mode==='auto'` 免审旁路已随 permission 域落地（guard 读 `PermissionRef`，permission 未挂载时照常审批）；v2 的 isError 与 stopTurn 通道已具备（第 66/76 轮）；review 仍降级为 denied 文案，恢复 v2 形态的接线待用户定夺。
- facade：`PlanRef`（`useExpose`）：`state`（响应式 PlanState）+ `enter/cancel/clear/exit/status/recordRevision`。app slot 注册 `default_plan_mode` config 节（boolean 默认 false；自动进入的消费方在宿主层）。
- 提醒：`useBeforeStep` 注入 full/sparse/reentry/exit 四变体（同 key 覆盖；user 消息或 ≥5 assistant 步刷 full、≥2 步 sparse；exit 变体一次性），文案与 v2 逐字节一致。
- 硬依赖 interaction（`useInteractions()`），preset 中排在 interaction 之后。遥测不迁。v2 `profile/plan.ts`（plan 子代理）属 profiles 域。

## shellCommand（工厂，不在默认名单）

`createShellCommand(props)`：`!` bash 能力——宿主把用户输入的 shell 命令交给 agent 执行，输入与输出以 remind 形式进入上下文，下一个 turn 自动带上。

- props：`workDir`（必填，进程 cwd）、`shell?`（默认 `/bin/bash`）、`timeoutMs?`（默认 120_000，对齐 v2 前台 2 分钟）、`host?`（`OsHost` 端口，缺省 `createNodeOsHost()`）。
- facade：`ShellCommandRef`（agent 层，`agentHandle.resolve(ShellCommandRef)`）：`run({ command, commandId? })` → `{ stdout, stderr, isError, backgrounded? }`；`cancel(commandId)` SIGTERM 在跑进程（前台/后台均可）。`!` 前缀解析是宿主/TUI 职责。
- 消息路径（用户定）：`agent.remind` 唯一 key（`shell-command:<id>:input|output|backgrounded`）被动注入，不触发 turn，reminders 随机器 drain 进历史；v2 的 `origin: shell_command` 用 part 级 meta 承载（`{ kind: 'shell_command', phase: 'input' | 'output' | 'backgrounded', isError? }`）。内容契约：`<bash-input>` / `<bash-stdout>` + `<bash-stderr>` 标签 + XML 转义，与 v2 逐字一致。
- 事件（`createFeature<ShellCommandEvent>`）：`shell.started` / `shell.output`（`stream` + `text` 分块）/ `shell.completed`，payload 带 `agentId` / `commandId`。
- 执行：与 os 工具组 Bash 共享进程执行器（features/os process-exec），stdin 立即关闭；spawn 失败不抛、走 isError 结果。120s 超时按 v2 语义**转后台**：`run()` 提前返回 `backgrounded: true`，经 `shell-command:<id>:backgrounded` remind 注入后台通知（文本与 Bash 后台 ack 同构，task_id = commandId），进程继续跑，完成后照发 `<bash-stdout>/<bash-stderr>` output remind 作完成通知。

## edit（工厂，不在默认名单）

`createEdit(props)`：把 `Edit` 工具装到每个 agent 上，模型调用它做精确字符串替换。

- props：`workDir`（必填）、`host?`（`OsHost` 端口，缺省 `createNodeOsHost()`；相对路径经 path-access 解析，工作区外必须绝对路径）。
- 行为与 v2 逐字对齐：`old_string === new_string` 拒绝、not found（文案带尾随换行）/ not unique 报错、`replace_all` 全量替换、纯 CRLF 文件 LF 编辑写回仍 CRLF（line-endings 移植）、EISDIR 判「is not a file.」、成功输出 `Replaced N occurrence(s) in <path>`。工具描述 `edit.md` 与参数四项描述逐字取 v2。
- 结果形态：错误结果标 `isError: true`（第 76 轮框架通道），装配层统一渲染 ERROR 状态块。
- 无 facade、无事件。path-access 工作区校验已随 os 工具组落地（敏感文件拒绝 + 工作区外必须绝对路径，`PathSecurityError` 转文本结果）；approval 规则、`file_io` display 属 permission 域（#19），落地后接回。

## os 工具组（工厂，不在默认名单）

`createOs(props)`：把 `Bash` / `Glob` / `Grep` / `Read` / `Write` 五个工具装到每个 agent 上，行为以 v2 `agent/tools/os` 为蓝本逐字对齐。

- props：`workDir`（必填）；`host?`（`OsHost` 端口 `{ process, fs, environment }`，缺省 `createNodeOsHost()`——端口传输无关，浏览器宿主可按 HTTP/WS 注入实现侧）；`additionalDirs?`；`spillDir?`（默认 `<KIMI_CODE_HOME 或 ~/.kimi-code>/tool-results`）。
- host 端口：process（spawn、POSIX 负 pid 杀进程组 / Windows taskkill、`AsyncIterable<Uint8Array>` 流、`{write,end}` stdin）；fs（13 方法 + `HostFsError` 8 码错误域）；environment（os/shell/pathClass/homeDir 探测 + login shell PATH 修正）。environment ready 经 app slot `useReady` 门控（app ready 先于 agent 挂载，Bash 描述里的 `${SHELL_NAME}` 在 spec freeze 时即可读）。v2 的 runtime lease/generation 校验与 requiredRuntimeCapabilities 门控不迁。
- Bash：前台 `min(timeout ?? 60, 300)s`、后台 `min(timeout ?? 600, 86400)s`（`disable_timeout` 可关）；`run_in_background` 即 detach（ack 元信息块 `task_id/pid/description/status/automatic_notification/next_step/human_shell_hint` 逐字对齐，task_id = toolCall.id）；前台超时自动转后台（`bash_auto_background_on_timeout` 默认 true，改用 `bash_task_timeout_s` 重新武装）；完成经 async-tool 通知回上下文；输出 >50K 字符 spill 落盘 `spillDir/bash-<toolCallId>.txt`（10M 保留；next_step 用 Read 指针——v2 的 TaskOutput 指针属 #23 未迁）。facade `BashRef`（agent 层）：`running()` / `detach(toolCallId)` 宿主手动挪后台（ack 带 `detached_by_user: true`）。config 节 `task`（v2 全量 8 字段 `max_running_tasks`/`keep_alive_on_exit`/`bash_auto_background_on_timeout`/`bash_task_timeout_s`/`kill_grace_period_ms`/`print_wait_ceiling_s`/`print_background_mode`/`print_max_turns` + 6 个 `KIMI_CODE_BACKGROUND_*` env 绑定 + stripEnv；legacy `background` 节同 schema 注册，读取时 background 并入 task 且 task 优先；Bash 仅消费 bash 两字段，print 三字段由宿主 run-print 读取）。
- Glob/Grep：rg 执行（`ensureRgPath`：PATH → `$KIMI_CODE_HOME/bin/rg` 缓存 → CDN 下载 bootstrap，SHA-256 钉死；20s 超时/10MB 单流上限/EAGAIN `-j 1` 重试）；VCS 目录与敏感文件 rg 排除 + `isSensitiveFile` 二次过滤；分页（offset/head_limit）、截断/超时/警告文案逐字对齐。
- Read：分页预算（默认 100000、上限 500000 字符，config 节 `read` 的 `default_max_chars`/`max_chars` 可调）、UTF-16 转码（10MB 上限、strict→lossy）、image/video/二进制嗅探拒绝、`<system>` 状态块全部句子逐字对齐；`kimi-file://` 附件分支与 wire.jsonl event-log 提示未迁（media 域 #25 落地时补）。
- 路径安全：path-access（工作区外必须绝对路径 + 敏感文件拒绝 + win32 shell 路径桥接）随本域落地，Read/Write 默认策略、Glob/Grep 免敏感检查改结果过滤，Edit 已同步接回；approval 规则/rule-match 属 permission 域（#19）。
- config 缺席时（config feature 未挂载）全部走默认值，行为不变。

## notify（工厂，flag 门控，不在默认名单）

`createNotify(props?)`：`NotifyUser` 工具——模型经它给最终用户发进度更新；core 只产回执与事件，展示（Updates panel）全在宿主。

- props：`available?`（可用性判定，默认读 `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER` 或 `KIMI_CODE_EXPERIMENTAL_FLAG`；v2 的 `update_panel` 宿主能力折入此端口）。挂载时 `available()` 为假则不贡献工具/不叠 system prompt/不注册 nudge（spec.frozen 使恢复一致，v2 的会话级持久化扫描不迁）。
- 工具：`NotifyUser({ message })`（非空）；execute 纯回执——空/全空白拒绝、available → fire 后 `'Update shown to the user.'`、否则 `'Notifications are disabled; the update was not displayed.'`；available 时经 `useSystemPrompt` 叠加 `NOTIFY_USER_GUIDANCE`（文案与 v2 逐字一致）。
- 事件（`createFeature<NotifyEvent>`）：`notify.shown`（payload 带 `message`，lineage 自动附 sessionId/agentId）——宿主订阅它渲染 Updates panel；v2 里宿主观察 `tool.call.started` 的路径新架构不存在，必须经此事件。
- nudge：`useBeforeStep` 评估，距上次 NotifyUser 调用 ≥8 次工具调用（每 8 重复）催促注入，或本轮 turn 内有 mid-turn 可见文本则提示转贴为 NotifyUser；注入走 `agent.remind(…, { key: 'notify_user_nudge' })`（下一步生效，drain 语义同 dateChange）；remount 经 history 扫描同 key 去重。v2 按 `origin.kind` 细分 turn 起点的规则无新架构对应物，统一按 `meta.source` 判定（已知保真度损失）。文案与 v2 逐字一致。
- 无 facade。

## cron（工厂，默认名单）

`createCron()`：会话级定时调度——模型把一段 prompt 按 5 字段 cron 表达式（本地时区）安排到未来触发，支持周期任务与一次性提醒（`recurring: false`）。

- 工具（仅 main agent 可用，subagent 调用拒绝）：`CronCreate({ cron, prompt, recurring? })`（每会话 50 个上限、prompt ≤ 8KiB、5 年内无触发拒建、一次性首触发 >350 天拒建并给引导文案；id 为 UUID）/ `CronList`（`cron_jobs: N` + `---` 分隔，prompt 截断 200 字节，含 nextFireAt/ageDays/stale）/ `CronDelete({ id })`（不存在报错）。
- fire 投递（不走 reminder）：仅在 agent 机器空闲时把 prompt 包进 `<cron-fire jobId cron recurring coalescedCount stale>` XML 信封，作为 user message 经 `agent.submit` 提交（`meta.origin.kind === 'cron_job'`），排队为下一 turn——v2 的 steer 竞态路径不迁，行为更符合「绝不注入 turn 中途」的文档契约。
- 持久化：`cron.add` / `cron.delete` / `cron.cursor` durable 事件落 agent journal + fold 投影重建任务表；重启恢复、离线漏发合并为一次投递（`coalescedCount`）；一次性任务触发后自删；周期任务存活 ≥7 天标记 `stale`，最后一投后自删。已知行为差异：fork 的 agent 继承 cron 事件（v2 fork 时删除 cron 目录）。
- 调度：`setInterval`（默认 1000ms，unref）+ `pushCleanup`，watch 配置响应式 re-arm；`KIMI_CRON_MANUAL_TICK=1` 关轮询、非 win32 用 SIGUSR1 手动触发；clock 支持 `system` 与 `file:<path>`；jitter 按任务 id 确定性哈希防羊群。
- config 节：`cron`（`debug/no_jitter/no_stale/disabled/manual_tick/clock/poll_interval_ms` + 7 个 `KIMI_CRON_*` / `KIMI_DISABLE_CRON` env 绑定），app slot 注册；config 未挂载时用默认值不报错。
- facade：`CronRef`（agent 层）：任务查询 / `isStale` / `now` / `getNextFireForTask` / `computeDisplayNextFire` 等。事件：`cron.fired`（payload 带 origin 与 prompt；telemetry 不迁）。

## sessionExport（工厂，不在默认名单）

`createSessionExport(props)`：把某个 session 的磁盘目录打包成带 manifest 的 zip（调试导出），行为以 v2 `app/sessionExport` 为蓝本。

- props：`version`（必填，空白在工厂创建时抛 `session.export_missing_version`，文案逐字对齐 v2）；`sessionDir(sessionId)`（宿主端口，返回该 session 的磁盘目录、memory-backed 返回 `undefined`）；`globalLogPath?` / `desktopLogPath?` / `wireProtocolVersion?`。
- facade：`SessionExportRef`（app 层）`export(input)` → `{ zipPath, entries, sessionDir, manifest }`。session 不存在抛 `SessionSpaceError('not-found')`（feature-http 映射 404）；`sessionDir` 返回 `undefined` 或目录无可导出内容抛 `SessionExportError` code `session.export_not_found`。
- zip 管道逐字移植 v2：yazl `addReadStreamLazy` 懒开源（防 fd 耗尽）、mkdtemp + rename 原子落盘、输出与所选源冲突检测（路径相同 + 硬链接 dev/ino）、abort 接线、source 所有权转移。默认输出名 `kimi-debug-<id前8>-<yyyyMMdd-HHmmss>.zip` 落 cwd。`file-history` 路径段排除保留（#15 落地后生效）。
- journal 扫描（替代 v2 wire.jsonl 扫描）：扫 `<sessionDir>/trees/**/*.jsonl` 的 EntryLine（`kind==='entry'`，tolerant 坏行），`ts` 的 min/max 进 manifest 的 `sessionFirstActivity`/`sessionLastActivity`；`firstUserInput`/`lastUserMessageMs` 取 `message.appended` 且 `payload.data.message.message.role==='user'` 的条目（scan 结果字段，v2 manifest 本就无此键）。
- manifest 字段与 v2 同名；`wireProtocolVersion` 来自 props（未给则 undefined），`workspaceDir`/`sessionLogPath` 恒 undefined（新架构无对应物）。v2 的 live flush（log/wire 落盘）与 session log 防轮转特殊捆绑不迁——NodeBackend 逐条 await 落盘、无缓冲写入器，新架构无 session log 生产者。
- feature-http：`POST /sessions/:session_id/export`（body `{ desktop?, web_log? }`）——facade 缺席 40936、导出失败 50001、成功流式回 `application/zip`（`content-disposition: attachment; filename="kimi-session-<id>.zip"` + `no-store`），临时目录随流关闭清理。
- 错误域：`SessionExportError`，4 码与 v2 逐字一致（`session.export_not_found` / `session.export_missing_version` / `session.export_output_conflict` / `session.export_too_large`），通用非文件错误为 `session.export_not_a_file`（替代 v2 的 FS_IS_DIRECTORY）。

## task（工厂，默认名单）

`createTask()`：detached tools（后台任务）的历史记录与查询/管理工具集——用户重定义后的 #23，不迁 v2 任务服务；`task_id = toolCall.id`（#28 决策④）。waitFor 已由 agent-core builtin 提供，不重实现。

- 工具（对齐 v2 `tools/task` 契约）：`TaskList({ active_only?, limit? })`（头行 + `---` 分隔、`No background tasks found.` 逐字；`tool` 字段取代 v2 的 kind 专有字段）/ `TaskOutput({ task_id })`（结构化元信息 + `[output]` 段；`retrieval_status`/`terminal_reason` 映射对齐 v2；`Task not found: <id>`）/ `TaskStop({ task_id, reason? })`（默认 reason `Stopped by TaskStop`、终态返回 `Task already in terminal state`，逐字）。
- 记录：`task.detached` / `task.terminated` / `task.lost` durable 事件落 agent journal + fold 投影（重启恢复；remount 时仍 `running` 的记录 reconciliation 为 `lost`，因新机器 background 必为空）。状态集 `running/completed/failed/killed/lost`——无 `timed_out`（任务域观测不到工具内部超时，超时以 failed/completed 落在 output）。
- 观测面：`tool.detached`（载荷自带最终 `toolCall`）→ 记 started；`tool.done` 按 `outcome` 三态映射（succeeded→completed / failed→failed / aborted→killed；用内存 live 集合与前台完成区分），output 取 result 文本内联存 journal（无 output_path——新架构无独立持久日志，工具自治输出：Bash >50K 自 spill 且文本内含 Read 指针）。
- TaskStop 通路：经 `agent.abortTool(taskId, reason)` 正式命令（无回执；机器内查 background → abort scope → `tool.done{aborted, reason}` → 删条目 + 产生 `[async tool aborted]` 通知进 history——模型明确得知任务被停），并自写 killed 记录（投影 running guard 幂等优先；非 TaskStop 来源的 aborted 记为 killed 时 stopReason 取 `outcome.reason`）。
- 覆盖范围：真 detached 工具（os Bash 三种 detach、spawn 后台）。shellCommand 转后台走 `agent.remind`（无 toolCall、task_id 为 `shell-command-*`），不在本域记录内（其 ack 文案提到的 TaskOutput/TaskStop 对这些 id 回 `Task not found`）。
- facade：`TaskRef`（agent 层）：`records`（ShallowRef，background-task panel 可直接 watch）/ `stop`。Feature 事件 `task.started` / `task.settled`（刻意与 journal 事件不同名——agent journal 每次 commit 都会在 agent 节点 `node.fire`，同名会让 facade 订阅者收到裸 journal 事件）。

## permission（工厂，默认名单）

`createPermission({ interactive?, workDir?, additionalDirs?, homeDir? })`：工具调用的风险裁决（v2 `agent/permission{Mode,Rules,Policy,Gate}` + `toolApproval` 迁移）。裁决不走 `useBeforeTool`——agent-core 工具机内置 permission 阶段（`useToolPermission`），在所有领域守卫（plan/btw 的 `useBeforeTool`）之后、执行之前运行，看到守卫改写后的最终 toolCall；被领域拒绝的调用不进入风险审批。

- mode：`'manual' | 'auto' | 'yolo'` durable state（`permission.set_mode` journal 事件 + fold 投影，默认 manual）。`PermissionRef` facade（agent 层）：`state`（ShallowRef）/ `mode()` / `setMode` / `setModeAndBroadcast`（main 改 mode 同步 session 内全部 live agents，对齐 v2 `broadcastPermissionMode`）/ `addRules`。
- policy 链（13 条，顺序对齐 v2）：auto-mode-ask-user-question-deny → user-configured-deny → dangerous-command-ask（`interactive: false` 时摘除；tree-sitter-bash 解析 + 嵌套 shell/sudo/eval 展开；受 `dangerousCommandGuard` 门控；auto 模式跳过）→ auto-mode-approve → session-approval-history → user-configured-ask → user-configured-allow → sensitive-file-access-ask → git-control-path-access-ask → yolo-mode-approve → default-tool-approve → git-cwd-write-approve → fallback-ask。
- 规则：`permission` config 节（app slot 注册）：`rules`（`Tool(arg glob)` 模式，picomatch；legacy `deny`/`allow`/`ask` 数组与 `{tool, match}` 形态读取时归一进 `rules`，下次写盘删除 legacy 键）+ `dangerous_command_guard`（默认 true，env `KIMI_CODE_DANGEROUS_COMMAND_GUARD`）；另有 `default_permission_mode` 标量枚举节（manual/auto/yolo）随本域注册。v2 工具侧 `matchesRule`/`approvalRule` 映射为域内按工具名的匹配器注册表（不动 `ToolDefinition`）；审批选「本会话不再询问」时经工具 approvalRule 写 session-runtime 规则（durable，重启恢复）。
- ask：经 interaction（`kind:'approval'`，payload `{id, sessionId, agentId, toolCallId, toolName, action, display, toolInput}`，display 通用派生——v2 `execution.display` 不迁）；Feature 事件 `permission.approval.requested/resolved`；非 main agent 拒绝/取消文案带 worker guidance 后缀（逐字）；telemetry 不迁。
- reminder：进出 auto 注入 `permission-mode-auto-{enter,exit}-reminder.md`（逐字节复制 v2；`useBeforeStep` + 同 key remind + 历史扫描去重），env `KIMI_CODE_PERMISSION_MODE_REMINDER` 关闭。
- plan 免审旁路：plan guard 的 ExitPlanMode 审批前可选探测 `PermissionRef`，`mode==='auto'` 跳过 interaction 直接 approved 分支（对齐 v2 `exitPlanModeTool.ts:88`）；permission 未挂载时照常审批。

## undo（agent-core builtin，默认名单）

`undo`：会话撤销（v2 `agent/undo` 迁移），agent-core `src/builtin/undo`，agent 层 spec。存储层分支切换原语由 `SessionStores.undo` 提供（按机器 turn 切割 + `agent.switched`），本 Feature 是其上的产品编排层。

- facade：`UndoRef`（agent 层）：`availability()` → `{ maxTurns, stoppedAtCompaction }`（按 undo 锚点统计：role user 且 `meta.origin` 为 undefined 或 `kind:'user'` 的消息；compaction summary（`meta.source:'compaction'` + `key:'summary'`）为硬边界）/ `undo(turns): Promise<number>`。
- 切割语义：锚点计数对齐 v2 `computeUndoCut`，落点收敛到「含第 N 个锚点的 turn 起点」（journal 倒扫经 `planUndoCut` 跨 parent 链定位，steer 中途锚点不切 turn 中段——turn 粒度，与 v2 消息粒度差异已记录）；cron/goal 等非锚点 turn 随切割一并移除（v2 同语义）。
- 守卫（文案逐字对齐 v2）：turn 活跃或排队拒绝（`Cannot undo while a turn is active or queued…`）、agent paused 拒绝（`…while conversation compaction is running…`，paused 即 compaction 窗口）；undo 前 `pause()` 关提交竞态，出错 `continue()` 恢复；invalid count / empty / compaction_boundary / insufficient 错误文案逐字，经 `UndoFeatureError`（`code` + `requested`/`undoable`）。
- 善后：`stores.flush()` → `stores.undo` → 发 Feature 事件 `context.undone`（`{agentId, turns, fromTurnId?}`）→ telemetry `conversation_undo {count}`（可选探测 TelemetryRef，缺席静默跳过）→ `session.close` + `session.create({agentId})` 重挂（对齐 compaction「换分支后宿主重挂」范式；roster 保留，冻结 spec 与 host prompt 随分支继承不丢，durable feature 状态随投影重建，task running 记录 remount reconciliation 为 lost）。v2 的 undo participants 注册表（唯一消费方是未迁的 v2 任务服务）与 `lastPrompt` 元数据 reconcile（新架构无此字段）不迁；v2 的 tokenCounting.recordTruncation 不需要——tokenCounting 锚点随 message meta，切割后自维护（见 tokenCounting 节）。
- 无 feature-http 路由（facade only；v2 的 `POST {id}:undo` 响应形是 kap-server 投影，宿主需要时再加）。

## session.status()（agent-core 命令面，非 Feature）

`SessionCommands.status()`：会话状态面（v2 `session/sessionActivity` 的引擎原生部分），**同步读**——返回 `{ busy, mainTurnActive, source, lastTurnReason? }`。运行时切片（`busy` / `mainTurnActive`）从活机器 snapshot 现读（`running` 状态 + `context.background`；非 live 的 agent 恒报 clean——liveness 的所有者是 Unit 树，不是 journal）；`lastTurnReason` 取 session journal 折叠的 `sessionMeta.lastTurn`（main agent `turn.ended` 时 SessionUnit 经 `session.meta_updated` patch 落账，重开 main 时与分支末条 `turn.ended` 比对校正）——打开即可用，含 main 未挂载时；`source` 是静态打开来源（`SessionUnitProps.source` 输入：startup/resume/fork，feature 经 `session.status().source` 读取，externalHooks 的 SessionOpened 即此消费方）。原则：引擎可派生的状态由 session 命令面原生提供；依赖其他 Feature 领域状态的部分（pendingInteraction 的 approval/question、compaction 相位）不做中间聚合，消费方各自经对应 Feature 的 facade 获取（feature-http status 路由即此模式：`busy` 取 `session.status().busy` 引擎态，TaskRef/CompactionRef 补 feature 态）。

- `busy`：任一 agent `turnActive` 或 `background` 非空（折叠自 session journal，刚打开 session 即可用，不需要 live agent）；`mainTurnActive`：main 的 `turnActive`。
- `lastTurnReason`：main 折叠态 `lastTurn` 的 outcome（done/aborted/failed → completed/cancelled/failed）；turn 进行中保持上一结局（v2 是清除，此为有意的语义差：折叠恒反映「最后一个已结束 turn」）。aborted → cancelled 的映射比 v2 宽（v2 仅 user_cancelled）。
- wire：`last_turn_reason` 经 feature-http `sessionView` 透出——live 会话读 `session.status()`，冷会话（未 open）暂不可得（如需恢复，正解是开容器只读 replay session journal，不是写镜像）。

## agentsMdReminder（工厂，不在默认名单）

`createAgentsMdReminder({ workDir, host?, brandHome? })`：AGENTS.md 发现/注入/变更提醒（v2 `agent/agentsMdReminder` 迁移）。agent 层；`host` 未传入时不挂载（能力归宿主注入端口，不自建 node host）。

- 种子：挂载时从 system prompt 提取 `<!-- From: -->` 注解路径 + 首个工具调用惰性链式加载（brand home → `~/.agents` → git 根→叶链）。
- 探测走 `useAfterTool`：Read/Edit/Write 文件参数目录、Glob/Grep 的 path 目录、Bash 经 `@moonshot-ai/tree-sitter-bash` 提取列目录命令目标；发现即在 afterHook 内 `agent.remind` 注入文件内容（随本次 drain 进下一步请求，时序等价 v2 step 头注入）；disclosed 每次 gating 从历史同 key 消息重建（compaction/remount 重注入自然成立）。denied 的工具调用同样触发探测（机器层 denied 与成功在 afterTool 不可区分，只读无害）。
- 变更检测为轮询版（无 fs watch 原语）：种子时快照候选 mtime 基线，每次 gating 重 stat 对比 created/modified/deleted，announce 文案逐字对齐 v2；轮询 announce 仅在 turn 经过 gating 时发生（v2 watcher 随时触发，机器语义差异在案）。
- facade：`AgentsMdReminderRef.seed(paths)`（agent 层；sessionInit 完成后消费）。
- 注意：经 `useSystemPrompt` 贡献 AGENTS.md 内容的 Feature 必须排在它之前挂载（种子读挂载时的 `getSystemPrompt()`，不含后挂载者的贡献）。

## sessionInit（工厂，不在默认名单）

`createSessionInit({ workDir, host?, brandHome? })`：`/init` 的 core 侧（v2 `features/sessionInit` 迁移）——派生 coder 子代理探索项目并写 AGENTS.md，完成后把最新内容注入 main agent。session 层；`host` 未传入时不挂载（能力归宿主注入端口，不自建 node host）。

- facade：`SessionInitRef`（session 层）：`generateAgentsMd()` / `cancelInit(reason?)`。错误域 `SessionInitError`（`agent.not_found` / `session.init_failed`，码值与 v2 逐字）；`cancelInit` 中止的拒绝原样透出（`AbortError` 形态，不包装）。
- 流程（对齐 v2 sessionInitService）：校验 main 在且已绑模型（`'Main agent was not found'` / `'Main agent has no model bound'` 逐字）→ `session.create` 子代理（`subagent-<id>`，roster source `session-init`——不可经 Agent 工具 resume）→ 复制 permission mode（可选探测 `PermissionRef`，缺席跳过）→ `setConfig(main.config)` 模型继承 → 跑 `init.md` 提示词（与 v2 逐字节一致）；完成/失败/取消即 facade 的 resolve/reject（v2 的 `subagent.*` 镜像事件不迁——子代理由 roster source 与自身 turn 事件描述）。
- 完成后：`loadAgentsMdDetailed` 重载（brand home → `~/.agents` → git 根→叶链，`<!-- From: -->` 注解渲染逐字对齐 v2）→ 可选探测 `AgentsMdReminderRef.seed(paths)` 标记已注入 → `main.remind`（key `session-init`）携带 `initCompletionReminder(content)`（空内容回落文案逐字；reminder 随下一轮 drain 落账）。
- profile 经 `useInject(ProfileCatalogRef)` 可选探测：有则子代理 systemPrompt 取 coder 的 `renderSystemPrompt`，无则裸提示词运行（v2 必有 profiles 绑定）。
- 子代理跑完保留在 roster（v2 同）；无 feature-http 路由（v2 的消费方是 node-sdk 进程内 RPC，kap-server 无 REST 路由）。

## swarm（工厂，默认名单）

`createSwarm({ catalog?, models?, forkEnabled?, workDir?, host? })`：批量子代理编排（v2 `features/swarm` 迁移）——AgentSwarm 工具 + AgentRunBatch 调度 + 批级独占守卫。catalog 缺席（props 与 profiles Feature 皆无）时 AgentSwarm 工具不注册（spawn 响应式门控先例），守卫照常。

- 工具：prompt_template（`{{item}}` 占位）+ items + resume_agent_ids + fork + subagent_type + model（strict、128 上限，schema/校验文案逐字）。spec freeze：models 非空才带 model 参、flag 开才带 fork 参；description = `agent-swarm.md`（逐字节）+ models 段。execute：校验（全文案逐字）→ planSpawn 一次共享 → batch → `renderSwarmResults`（`<agent_swarm_result>` XML 逐字）。子代启动复用 spawn 提取管线（`spawn/run.ts` 的 createSubagentLauncher），执行走 agent-core 复合命令——`target.run(..., { meta:{origin:{kind:'subagent'}}, abortAsOutcome:true })`，resume 重跑走 `target.retry`（空 content user 消息、框架写 `origin:{kind:'retry'}`，重驱同一 agent，已实证）。
- batch（`batch.ts`，v2 agentRunBatch 全语义）：首发 5 个、700ms 间隔；限流模式（`failure.error.kind==='rate_limit'` 判定）requeue + 退避（内联 `3000*2^n`，不引 `retry` 包）+ 容量收缩/恢复；per-attempt timeout（`swarm` 节 `timeout_ms` 默认 2h，env `KIMI_CODE_SWARM_TIMEOUT_MS`）；`KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` 并发上限；工具 signal 中止逐任务 aborted（v2 用户取消两态文案逐字）。
- 守卫（`useBeforeToolBatch` 批级贡献点）：批内 AgentSwarm >1 deny、混批 deny（文案逐字，整批逐 call 否决）；非 main 追加 worker guidance。批裁决先于一切 per-call 钩子；per-call 钩子只见本 call。
- 事件：无镜像事件通道（v2 复用 subagent.* 名的 `swarm.*` 不迁）——子代理由 roster source + `agent.opened` + AgentSwarm 工具调用事件（每个子代理启动经 `onUpdate` 发 `tool.update {key:'subagent', text: agentId}`）+ 子代理自身 turn 事件统一描述；suspended 语义即「子 turn failed(rate_limit) + AgentSwarm 调用仍在途」。swarmItem 为 session 内存 Map（v2 持久化于 session metadata labels；重启丢失仅影响 resume 的 `item=` 渲染）。不迁：SessionSwarmService.cancel、stopReason（TurnOutcome 无 max_tokens 面，渲染保留支持）、feature-http 路由。v2 的 swarm mode（`swarm_mode.enter/exit` + 进出 reminder + 状态面）已于 2026-09-30 评审后整体删除——它不符合 mode 定义（无模型面/工具面效果，唯一 trigger 为 'tool' 时 reminder 永不注入），残余语义仅为运行状态标记。

## media（工厂，不在默认名单）

`createMedia({ workDir, store, cache, host?, originalsDir? })`：媒体域（v2 `agent/media` + `tools/read-media-file` 迁移，media:// 形态），app + agent 双层。**接管 media lowering**：挂载本 Feature 后不得再挂 agent-core builtin `createMedia`（`registerMedia` 单槽，同挂在挂载期 throw `duplicate media lower`）；kimi-file:// 体系不在本 Feature（kap-server 侧另案）。

- lowering：agent slot `useMediaLower({ source: store, cache, providers })`（providers 经 `Providers` collection 折叠）+ `useLlmRecovery(createMediaDegradeRecovery())`，与 builtin 同形端口的纯超集；图/音频 inline，视频在协议 lower 时经 `provider.media.uploadVideo` 上传（kimi provider 已携带，零新增）。
- ReadMediaFile 工具：`path`（相对 workDir 解析）/ `region{x,y,width,height}`（仅图片，原图像素坐标）/ `full_resolution`（仅图片）；100MB 上限、512B 魔数嗅探（text 推给 Read）、`image_in`/`video_in` 能力门控（execute 内读 `agent.config?.model.capability`）、provider 不接受的 mime 给按 OS 转换命令文案；交付 `store.put` 后 `<image path="…">` 包裹 media:// ref + `<system>` note（mime/字节/原始尺寸/交付方式 untouched/downsampled/crop/full、相对坐标指引），note 文案逐字对齐 v2；`host` 未传入时本地路径读取返回不可用文案（不自建 node host）；`read-media.md` 与 v2 逐字节（kimi-file:// 段删除）。
- 压缩/裁剪：jimp 动态 import、quality ladder、2000px 边长 / 256KB 读取预算 / 64MB 解码上限；原图持久化经 `originalsDir`（sha256 命名 + 1GB LRU sweep，缺省跳过）；webp 经内嵌 wasm 解码（`@jsquash/webp`）。
- prompt 摄入（`usePromptGate`）：user message 中超过 readByteBudget 的 `data:` 内联图片压缩后 `store.put`、part 改写为 media:// ref 并附压缩 caption（形态幂等）。
- 每请求预算（`useMessageResolver`）：inline 媒体去重总量 >20MB 时从最旧起替换为占位文本直至 ≤10MB（v2 `media-budget-exceeded` 同款语义，warning 即占位文本）。
- config：`image` 节（`max_edge_px` 默认 2000 / `read_byte_budget` 默认 256KB + `KIMI_IMAGE_MAX_EDGE_PX` / `KIMI_IMAGE_READ_BYTE_BUDGET` env 绑定 + stripEnv），config 缺席走默认值。
- 不迁：kimi-file:// 全家、sessionMediaStore DI 同形物、动态重注册（spec freeze，execute 内门控替代）、telemetry（image_compress/image_crop/video_upload）、MCP 媒体输出（#29 下游）、kap-server 下载路由与 prompt 上传入口（宿主层）、displayPaths 降级路径回写。

## tokenCounting（spec，默认名单）

`tokenCounting`：上下文 token 计数读取面（v2 `features/tokenCounting` + `agent/session tokenCounting` 迁移），agent 层。**无 durable state**——实测锚 = 最后一条带 `meta.usage`（`grandTotal > 0`）的 assistant entry，锚随 history 走（undo 切割/compaction 重置后自维护；v2 的独立 anchor state 与 measured/truncated/rebased/turn_recorded 四事件流不迁）。

- facade：`TokenCountingRef`（agent 层）：`status: ShallowRef<number>`（挂载初始化 + `turn.ended` journal commit 后重算）/ `get(start?, end?)` → `{size, measured, estimated}`（含负下标切片，measured/estimated 切分对齐 v2 `getFrom`）/ `statusSize()` / `latestMeasured()` / `requestSize({systemPrompt, tools, messages})`（纯估算，对齐 agent-core `usedContextTokens` 的 prefix 口径）。
- strategy 三态（config `token_counting` 节 `strategy` + env `KIMI_TOKEN_COUNTING_STRATEGY`，非法值回落默认；config 缺席走 `measured+estimated`）：`measured` 取末锚原值、`estimated` 纯估算全量、`measured+estimated` = max(get.size, 末锚)（与 agent-core `usedContextTokens` 同语义）。
- 消费方：子代理卡片头部 chip 的 contextTokens 由消费方自子代理全量 history 读 `usedContextTokens`（v2 `mirrorAgentRun` 的 statusSize 同位；spawn/swarm 已无镜像事件通道，策略感知读取走子代理的 `TokenCountingRef`）。
- 状态出口：`status` ref（v2 `AgentStatusUpdated{contextTokens}` 同位；事件式消费方 ACP usage_update 落地时读 ref 或 facade）。

## tower（工厂，flag 门控，不在默认名单）

`createTower({ workDir, host?, available?, catalog?, models? })`：tower 多代理工作区协调（v2 `features/tower` 迁移），app + session + agent 三层。`available` 缺省读 env `KIMI_CODE_EXPERIMENTAL_TOWER` / `KIMI_CODE_EXPERIMENTAL_FLAG`；不可用或 `host` 缺席时不注册工具/守卫/注入（facade 仍暴露以返回四态 enter 失败）。`/tower` 开关是宿主职责，驱动 `TowerRef.enter/exit`。

- 协议层（`protocol/`）：`.tower/` 文件协议（state.json / missions / inbox / findings / reviews / activity log）整体移植，文件与 git 操作全部走 OsHost 端口（git 经 `host.process` 60s 超时 + 16MB 上限；state 写 tmp + `rename` 原子落盘——`OsFsPort.rename` 为本 Feature 扩展的端口方法）；MISSIONS.md / 各 frontmatter 格式与错误文案逐字。
- mode：`tower_mode.enter/exit` durable 事件 + fold 投影 `{active, owner, base}`；`TowerRef` facade（state/isActive/requestedBase/enter/exit）；enter 四失败态文案逐字（`owned-by-live-session` 不同进程强抢——owner live 即拒，owner 非 live 则 adopt roster）；base 准备（建分支 + 脏快照提交 / open mission 拒换 base）文案逐字。
- 工具 11 个（TowerInit/Plan/Spawn/Merge/Teardown/Send/Inbox/Finding/Review/Mission/Status，md 逐字节）：挂载即注册（v2 模式外隐藏工具，spec freeze 下恒可见、执行期门控等价）；编排工具 main 限定、模式未激活拒用（文案逐字）。
- 守卫（`useBeforeTool`）：tower 激活时 TodoList 拒绝、前台 resume tower agent 拒绝（后台可用性经 TaskRef 探测）、tower-worker 仅可写自己 worktree（参数 `file_path`/`path` 双键 + `isWithinDirectory`，v2 走 execution.accesses）。
- TowerSpawn：复用 spawn 提取管线（`createSubagentLauncher`）派生 worker/reviewer 进各自 worktree，roster source 沿用 `spawn:<parent>:tower-worker`（保持 `Agent(resume=...)` 协议不断）；限流 governor 在 app 层（pause 60s / 容量收缩 2s / 恢复 180s / 预算 16）；permission mode 固定 auto（worker overlay 声明 pin）；模型池非空时 worker 绑 `models[0]`、reviewer 继承调用方。
- 注入：mode full/sparse/exit 三变体 md 逐字节（`useBeforeStep` + 同 key remind + 历史扫描去重，窗口 2/5）。
- modeMutex：tower enter 退出 plan mode（facade 可选探测），`plan_mode.enter` journal commit（经 `AgentStoreRef.onCommit` 订阅）触发 tower exit。swarm 侧互斥已随 swarm mode 删除（2026-09-30）一并移除。
- inbox wake：session 层 hub 承载 worker→tower 信号，main 空闲时 `agent.submit` 唤醒（origin `{kind:'injection', variant:'tower_inbox'}`，microtask 合并计数 + 120 字符截断文案逐字）。
- 事件：`tower.spawned/completed/failed/cancelled`（v2 复用 subagent.* 名，本架构按命名空间）；死亡追踪在 spawn 管线内（非 done → `markAgentDied`）；复活追踪在 session 层订阅 `turn.started`（journal commit 在 agent 节点 fire 后沿祖先链传播，worker resume 开跑即清 died 标记，`clearAgentDied` 幂等；被动 remount 不开 turn 故不误清）。
- 不迁：`[experimental]` config 面、AgentStatusUpdated 镜像（kap-server 状态面）、v2 动态 active tools、restoreTowerTools/reconcileTowerProjection 投影面。

## externalHooks（工厂，不在默认名单）

`createExternalHooks({ host?, workDir?, clientType?, shell? })`：外部钩子子进程（v2 `features/externalHooks` 迁移，第一批），app + session + agent 三层。`host` 未传入时三个 slot 全部不挂载（能力归宿主注入端口，不自建 node host；config 节仍注册）。

- runner（app 层，`ExternalHooksRunnerRef` facade）：`hooks` config 节（zod strict——event 接受 v2 全部 20 个事件名 / matcher 正则 / command / timeout 1..600s，`[[hooks]]` array-of-tables）响应式索引（config 缺席恒空）；`trigger / triggerBlock / fireAndForgetTrigger / hasHooksFor / summary` 签名逐字对齐 v2 `IExternalHooksRunnerService`。正则 matcher、cwd+command 去重、默认 30s 超时（SIGTERM→100ms→SIGKILL）、exit 2 或 stdout JSON `hookSpecificOutput.permissionDecision:'deny'` 判 block、stdin snake_case JSON（`hook_event_name`/`session_id`/`cwd`/`client_type`）全部逐字对齐 v2 `internal/{runHook,matchHooks}.ts`。进程执行走 `OsHost.process` 端口；v2 `shell:true` 语义用显式 shell 承载（POSIX `/bin/sh -c`，win32 `cmd.exe /s /c`，`shell` prop 覆盖）。
- 已接线 10 事件：**PreToolUse**（`useBeforeTool`，block → denied 文案）；**TurnStarted**（`turn.started`，origin 取自 `entry.meta.origin`，可展示 origin 判定等价 v2 `isDisplayablePromptOrigin`）；**StopFailure**（`turn.done` failed，LLM 载荷 `kind` 作 error_type，Error 实例取 `name` 逐字）；**Interrupt**（`turn.done` aborted，`reason:'cancelled'`）；**UserPromptQueued**（`prompt.submitted`，保留 v2 的 origin `'user'` 门控）；**SessionHeartbeat**（session 层 60s interval + `hasHooksFor` 门控，`session_title`/`uptime_ms`）；**TaskStarted**（task Feature 事件，kind=toolName，detached 恒 true）；**SubagentStop**（session 层派生——订阅 `agent.opened` 按 roster source 判定子代理身份（`spawn:` 前缀取 profile、`session-init` 恒 coder）并挂 `turn.started`/`turn.done` 监听，origin ∈ {subagent, retry} 且 outcome done 时触发，response 取 `turn.done.messages` 末条 assistant 文本——v2 仅成功路径触发的语义对齐，agentName 随 roster durable 不再依赖内存 Map）；**SessionOpened**（session 层 setup 经 `useReady` 触发，`app.open`/`app.create` 等待钩子完成——等价 v2 `waitUntil`；matcher=source，fork 不触发；载荷 `source`/`session_title`/`model`/`profile`，model 读 config `defaultModel` 节、profile 读 `ProfileCatalogRef.getDefault()`，均可选探测；事件名自 v2 `SessionStart` 改名，对齐 `agent.opened`/`agent.closed` 族）；**SessionClosed**（session 层 `pushCleanup` 异步清理触发，kernel unmount 等待钩子完成，close/delete/app unmount 三路径全覆盖；reason 恒 `'exit'`——v2 的 `'archive'` 因新架构 archive 不关闭 session 而不产生；v2 名 `SessionEnd`）。跨 Feature 事件经 `node.parent.on` 订阅（task 未挂载时自然静默）。
- 已知保真度损失：UserPromptQueued 无 queued-only 门控与 `queueLength` 字段（`prompt.submitted` 每次 submit 都触发）；PreToolUse 无 abort 杀钩子进程能力（`ToolBeforeInput` 无 signal）。
- 未接线（后续批次）：PostToolUse / PostToolUseFailure（isError 通道已就绪，随第二批逐项对齐）、PermissionRequest / PermissionResult、UserPromptSubmit、Stop、SubagentStart、PreCompact / PostCompact、Notification、插件来源 hooks（待 plugin 域）。

## skill（工厂，不在默认名单）

`createSkill({ workDir, fs?, home?, explicitDirs?, sources? })`：技能目录与激活（v2 `features/skill` 迁移），app + agent 双层。`fs` 未传入时文件类 source（user/project/extra/explicit）不激活，builtin source 仍可用（能力归宿主注入端口）。`home` 缺省读 `KIMI_CODE_HOME` env，解析不出则不注册 user source；`~/.agents` 等通用根解析到 `home ?? homeDir` 下；外部目录来源经 `sources` props 或 `useSkillSource` 贡献。

- 目录：app 层按优先级合并全部 `SkillCatalogSource`（`SkillSources` collection + `useSkillSource` 贡献钩子，晚注册响应式并入——plugin 来源 #24 经此接入）——builtin 0 / plugin 5 / extra 10 / user 20 / workspace 30（逐字），高优先级覆盖同名；初始加载经 `useReady` 门控 app ready（「会话打开前技能就绪」）。`SkillCatalogRef` facade（app 层）：ready / list / get / renderSkillPrompt / getModelSkillListing / getKimiSkillsDescription / listInvocableSkills / roots / skipped / reload。事件 `skill.changed`（`{sourceId}`）。
- 发现与解析逐字移植：frontmatter（键别名/必填校验/错误文案）、目录遍历（深度 8、排除 node_modules 与点开头、目录 skill 优先、顶层 md 文件、sub-skill `parent.child` 命名与 isSubSkill 标记、root-skill-only scanMode、skipped 收集）、roots（brand/generic 目录表、`.git` 向上找项目根、realpath 去重、`~` 展开）、参数展开（`$ARGUMENTS[N]` / `$N` / 命名参数 / tokenize 引号 / `${KIMI_SKILL_DIR}` / `${KIMI_SESSION_ID}` / plugin-instructions 包裹）、分组 listing（DISREGARD 头 + 250 grapheme 截断）。fs 全走 `host.fs` 端口（v2 的 node:fs 与 IHostFileSystem 双份收敛为端口版一份）；fs 目录监视不迁（v2 为 200ms 防抖 watcher），`reload()` facade 代替（profiles 先例）。
- config 三节（app slot 注册，config 缺席走默认）：`extra_skill_dirs`（string[]）/ `merge_all_available_skills`（默认 true；当前 v2 目录表下 false 无可观察过滤效果，语义如实逐字保留）/ `builtin_product_skills`（默认 true + env `KIMI_CODE_BUILTIN_PRODUCT_SKILLS` + stripEnv）。节变更触发对应 source reload + `skill.changed`。
- builtin skills：mcp-config / import-from-cc-codex / update-config / custom-theme / write-goal / check-kimi-code-docs / sub-skill（含 consolidate/review 子技能；mcp-config、import-from-cc-codex、custom-theme 与三个 sub-skill 为 `disableModelInvocation`，check-kimi-code-docs 模型可调），md 与 v2 逐字节一致；`builtin_product_skills` 门控 productSpecific（v2 visibleBuiltinSkills 语义——update-config 与上述四份产品技能共 5 份受门控）；v2 全局可变注册表收敛为模块静态定义（唯一消费方即本域）。
- 模型面（agent 层）：① system prompt 统一注入 v2 完整 `# Skills` 块（`# Skills` + prose + `## Available skills` + DISREGARD 分组 listing；`useSystemPrompt` 挂载冻结）——每个 agent（main / spawn / swarm / sessionInit 子代理）挂载即得，等价 v2 profileService 单一注入点，spawn 侧不再单独填 profiles 的 skills 变量（第 19 轮遗留由此消解）；catalog 后续 reload 不重注入已挂载 agent（v2 frozenSkillListing 同款）。② `Skill` 工具（description 逐字节、schema 逐字）：守卫三文案逐字（not found / disableModelInvocation / 非 inline）→ 渲染 → `agent.submit` skill-loaded user message（part 级 meta 为 agent-core `SkillPartMeta`——sessionTitle 的 stripBundledSkillBlocks 与 mergeSteerMessages 已消费；`meta.origin.kind:'skill_activation'`）+ 发 `skill.activated`，返回 `Skill "<name>" loaded inline. Follow its instructions.`（逐字）。MAX_SKILL_QUERY_DEPTH=3 与 NestedSkillTooDeepError 移植（v2 的 withInitialQueryDepth 克隆无生产消费方，不迁）；参数容错解析 `invalid Skill arguments: <raw>`。
- facade：`SkillRef`（agent 层）：`activate({ name, args?, content? })`（user-slash——`<skill-loaded>` 块 + 追加 content，忙碌抛 `Cannot activate skill while another turn is active`（逐字），等 turn.started 返回 `{ turnId }`）/ `promptWithSkills({ input, skills, attachments? })`（多技能 bundled 单条 prompt，校验文案逐字，origin 带 `skillActivations` 明细，忙碌立即返回 `{ turnId: undefined }`）。
- 错误结果标 `isError: true`（第 76 轮框架通道）；telemetry（skill_invoked / flow_invoked）不迁（待遥测批次补回）；v2 的 promptMetadata 更新不迁（sessionTitle 直读 history）；v2 session 级 ISkillCatalogSink.set/remove 不迁（唯一消费方 plugin session-start，#24 经 useSkillSource 晚注册覆盖）。

## mcp（工厂，不在默认名单）

`createMcp({ workDir?, home?, host?, trusted?, servers?, mediaStore? })`：MCP 客户端域（v2 `mcpCore` + 各级 mcp 迁移），app + agent 双层。`host` 未传入时 stdio server 连接失败（明确文案），http/sse 不受影响（能力归宿主注入端口，无缺省 node host）；`home` 缺省 `KIMI_CODE_HOME` 或 `~/.kimi-code`。

- 配置：三层文件合并——user `{home}/mcp.json`、projectRoot `{git根}/.mcp.json`、project `{workDir}/.kimi-code/mcp.json`，同名整体覆盖、后层赢；`trusted` 缺省 false 只读 user 层；`servers` props 垫底（projectRoot 层 stdio 相对 cwd 归一到文件所在目录）。`mcp` config 节（`startup_timeout_ms`/`tool_timeout_ms` 皆 optional 无默认值 + env `KIMI_MCP_STARTUP_TIMEOUT_MS`/`KIMI_MCP_TOOL_TIMEOUT_MS` + stripEnv）。文件 hot-watch 不迁，`McpRef.reload()` facade 取代（新增 connect / 消失 markRemoved / 指纹变更 reconnect，mutation 串行化）。
- 连接管理（app 层）：状态机 pending|connected|failed|disabled|needs-auth|removed、attemptId 防串代、connectAll allSettled（无总超时，单 server startup 超时默认 30s）、无自动重试、liveness 探测；stdio 自实现 NDJSON transport（SDK ReadBuffer/serializeMessage + OsHost spawn，4KB stderr 尾缓冲、mergeStdioEnv）；http/sse 走 SDK transport + OAuth fetch。
- spec freeze 语义（定稿：中途连接不影响 tool[]）：agent slot `useReady(initialLoad)` 门控，首批连接的工具 inline 进冻结 spec（per-agent initialPhase，第二个 agent 的首批仍是它的 inline 首批）；中途连接/重连/OAuth 完成的工具不进 spec，executor 照注册 + deferred 通道递送。
- deferred（server 配置 `deferred: true`）：工具带 `deferred` 标记（请求级过滤不进 wire tools，executor 按名可解析）+ `mcp-dynamic-tools` system 消息（同 key 覆盖，content 名单 + tools schema 经 kimi trait 序列化上线；其它协议忽略该字段，模型不可见但 executor 仍可解析）。
- 工具镜像：限定名 `mcp__server__tool`（sanitize + 超 64 字符 FNV hash 截断，逐字）、same_server/other_server 冲突丢弃、enabledTools/disabledTools 注册前过滤；调用失败 liveness 探测 + 原地重连重试一次（v2 逐字）；server 变 failed/removed 不注销 executor（冻结 spec 无法移除），调用时重连或返回明确文案。
- OAuth：401 → needs-auth + 合成 `mcp__{server}__authenticate` 工具；授权 URL 经 `mcp.oauth.authorization_url` Feature 事件（v2 的 onUpdate custom 通道无对应物）+ 工具阻塞至 flow.complete（signal，15min）；callback server 127.0.0.1 随机端口固定 `/callback`；token 存 `{home}/credentials/mcp/`（key 规则逐字）；主动刷新提前 2 分钟；tokens-saved/invalidated/refresh-failed → 自动重连（v2 workspaceMcpService 规则逐字）。
- 输出治理：text/resource/structuredContent/_meta `<mcp-result-extras>` 规则逐字；图片在 `mediaStore` 在场时 compressImageForModel → store.put → media:// ref（失败回退 data-URL），缺席 data-URL 直出；10MB/part 上限 drop notice。v2 的 originals 落盘 + daemon-file-url 通知不迁（media 无该 facade）；错误结果经 `result.isError` 透传标记（第 76 轮框架通道）。
- facade：`McpRef`（app 层）：list / reconnect / reload；事件 `mcp.server.state`、`mcp.oauth.authorization_url`。
- 不迁：session overlay/ephemeral servers（feature-acp 域）、宿主管理面 mcpRegistry/mcpManagement 与 kap-server REST、elicitation/sampling/roots/notifications（v2 本无）。

## models-dev（工厂，不在默认名单）

`createModelsDev({ builtinCatalog?, userAgent? })`：models.dev 公共模型目录的 browse/导入 + 自定义注册表导入/刷新（v2 `app/kosongConfig/modelsDev*` 迁移），app tier。导入 = 写 `providers`/`models` 两节，provider-catalog reconcile → materialize → store → CatalogModels 自动可用。

- 上游：`https://models.dev/api.json` 拉取——10min 内存 TTL + in-flight 去重 + 10s 超时；失败链 过期 cache → `builtinCatalog` props 端口（宿主构建期注入，缺省无兜底）→ 抛 `modelsDev.catalog_unavailable`。
- 转换（纯函数，v2 逐语义）：`resolveModelsDevImport` 三态（ok / needs-base-url / invalid{proprietary-sdk|empty-base-url|placeholder-base-url}）、wire npm/id 推断（兜底 openai）、anthropic baseUrl 剥 `/v1`、模型过滤（非 text 输出 / deprecated / alpha / embedding）、capability 映射（limit/modalities/reasoning_options→efforts/offEffort/alwaysThinking、interleaved→reasoningKey、模型级 provider override）；输出为 camelCase `CatalogModelConfig`。
- facade `ModelsDevRef`（app 层）：`listProviders()` / `getProvider(catalogId)`（browse DTO 保持 v2 snake 字段）；`importProvider({ catalogId, id?, apiKey?, baseUrl? })`——id 过 `PROVIDER_ID_PATTERN`、oauth 托管拒绝、保留旧 apiKey、删旧 `${id}/` 键再写新键（重复导入=刷新）、defaultModel 未设时 seed；`importRegistry({ url, apiKey? })`——`fetchCustomRegistry`（oauth 包）拉取 + 宽容轨转换（缺 limit 默认 131072、缺省 `['tool_use']`），providers 条目带 `source:{kind:'apiJson',url}`；`refreshRegistries()`——同 url 重拉，新增/更新、消失的自管 provider 连同其 models 删除（用户手写条目不碰）；定时刷新消费 `model_catalog` 节（`refresh_interval_ms` 默认 6h / `refresh_on_start` 默认 true，setTimeout 链）。config 未挂载时 import 抛 `config.unavailable`。
- 通用协议工厂：app slot 注册 `openai` / `anthropic` / `google-genai` / `vertexai` 四个 `ProviderProtocols`（connection 从 info 取 baseUrl/customHeaders；vertexai 用 `createGoogleGenAIBase({ vertexai: true })`）——config 写入的非 kimi provider 由此可物化、可绑定。
- feature-http：`GET /catalog/providers` / `GET /catalog/providers/:catalog_id` / `POST /providers:import_catalog` / `POST /providers:import_registry`（body 与 v2 同形 snake 字段）；错误码对齐 v2 数值（40003/40004/40005/40417/50004），facade 缺席 409（40938）。
- 不迁：human/models-dev 死重复、ping（provider-catalog store 已有）、CLI provider 向导（node-sdk 出界）、`KIMI_CODE_MODEL_CATALOG_REFRESH_*` env 覆盖、v2 Error2 错误域。

## workspaces（工厂，不在默认名单）

`createWorkspaces({ homeDir, host?, now?, defaultRoot? })`：workspace 注册表 + trust + aliases + fs 浏览（v2 `app/workspace` + `workspace/workspaceTrust` + workspaceFs 迁移），app tier。workspace 是管理面注册数据（哪个目录、受不受信任），与 os-host（执行能力端口）正交。

- 注册表：durable 事件（`workspace.created/updated/deleted/alias/trust.set`）+ fold 投影；`createOrTouch(root, name?)` 按 root 去重、touch 更新 lastOpenedAt；delete 保留 trust 记录；持久化走 `host.fs` 的 JSONL journal（`<homeDir>/workspaces/journal.jsonl`），host 缺席纯内存。
- session 绑定：`workspaceId` 不是 session catalog 的内置字段，而是本 Feature 拥有的 metadata key（`features/workspaces/session.ts` 的 `SESSION_WORKSPACE_ID` / `sessionWorkspaceId` / `withSessionWorkspace`；HTTP 线 `workspace_id`  ⇄ 该 key）。`face.openSession(root, input?)` = `createOrTouch(root)` + `app.open` 搭配 metadata 写入——按 workspace 目录创建 session 的入口（ACP `session/new` 经此绑定各自 cwd）；session builtin 裸 `app.open` 不带绑定。配了 `defaultRoot` 时，feature 在 app 节点监听 `session.created`（仅 startup/fork 落账），发现记录未绑定则 `createOrTouch(defaultRoot)` 并 `app.updateSession` 赋默认 workspace（异步落账，绑定经随后的 `session.meta_updated` 冒泡可见）；未配 `defaultRoot` 不自动赋。
- facade `WorkspaceRef`（app 层）：list/get/findByRoot/createOrTouch/openSession/update/delete/getTrust/trust/untrust/isTrusted/sessionCount/addDir/additionalDirs；`face.fs`（host 在场才有）：browse/home/probe/read/stat/mkdir/view(roots)——list/read/search/suggest/grep 全走 `OsFsPort`（resolveWithin 逃逸防护、gitignore、10MB 上限、ETag/mime）。
- feature-http：`/workspaces` 八端点（GET/POST、trust GET/POST、untrust、PATCH、DELETE、add-dir）+ `/fs:browse|home|content|mkdir` 四端点 + session 维度 fs 五端点（`POST /sessions/:id/fs:<action>`、`/workspace/fs:search|suggest`、`/fs:suggest`、`GET /sessions/:id/fs/*:download`）；git_status/diff/open/reveal 回不支持（能力缺口在案），facade 缺席 409（40945/40946）。
- 不迁：v2 session-index 合并/rebuild、suggest/grep 的 rg 路径（恒 node 回落）、local.toml watch、fs 遥测。

## capabilities（工厂，不在默认名单）

`createCapabilities({ homeDir, host?, entries?, ... })`：Kimi CU（macOS/Windows）与 WebBridge 的安装检测与安装编排（v2 `app/capability` 迁移），app tier；host 门控（host 未传 facade 缺席）。

- 检测：mac 四层（plugin/legacy-mcp/app/service/permissions）+ Windows 双层（plugin/runtime doctor）+ WebBridge 五步（daemon-binary/daemon/skill/standalone-skill-migration/extension）；进程执行走 `host.process`，检测读取走 `host.fs`，安装期文件变更（下载/解包/移动）保持 node 实现。
- facade `CapabilitiesRef`（app 层）：`list()` / `get(id)` / `install(id)`——安装串行化、进度 Map（`{running,step,percent}` → `{running:false,note|error}`）、`capability.changed` Feature 事件；插件消费面经 `PluginRef` 可选探测（缺席时插件步报 missing、安装抛明确错误）。
- feature-http：`GET /capabilities` / `GET /capabilities/:capability_id` / `POST /capabilities/:tail`（`:install`）；错误映射 404/40418、409/40924/40925（kap 同值），facade 缺席 409（40947）。
- 端口缺口：`host.fs` 无 X_OK/mode 面，可执行性检测为近似（在案）。

## toolDedupe（工厂，默认名单）

`createToolDedupe()`：repeat-breaker 护栏（v2 `agent/toolDedupe` 迁移），agent 层 spec 常驻（v2 为 Agent scope OnScopeCreated）。三机制：同步去重、跨步连击提醒、force-stop 后 handoff 收尾。

- 同步去重（`useBeforeTool` + `useAfterTool`）：同一步内 key（`toolName + canonical(args)`，键排序稳定 stringify，feature 内自实现；raw arguments 自解析，parse 失败以原始字符串入 key——v2 registerSkipped 语义并入唯一 beforeTool 路径）相同的调用只执行一次；重复调用拿 denied 占位结果，afterTool 内 await 原始调用的 deferred，resolve 为原始调用 post-reminder 最终结果（v2 executor 双 hook 对映为贡献点双 hook）。原始调用 execute 抛异常（afterTool 不运行）经 `agent.on('tool.done')` 非成功出口兜底 resolve（v2 因 executor 全 catch 无此路径——新架构防 turn 级死锁的必要补丁）。
- 连击（streak）：`useAfterStep` 步边界结算（本步调用序列折叠进 consecutiveKey/consecutiveCount；原始调用完成时以 stepCalls[0..index] 重算 streak）；阈值 3/5/8 追加 REMINDER_TEXT_1/makeReminderText2(streak)/REMINDER_TEXT_3（三段文案与 systemReminderText 包装逐字照抄 v2），≥12 结果置 `stopTurn: true`。reminder 追加：ContentPart[] 拼到最后一个 text part 或新增 text part（v2 的 string 输出形被新架构 ContentPart[] 统一）；v2 的 spill.suffix 同步追加不迁（新 ToolResult 无 spill 面）、stopTurnReason 不迁（ToolResult 无该字段，TurnOutcome 无 reason 面）。
- handoff：force-stop 步的 afterStep 置 pending 并 `agent.notify` 空 user 消息（v2 `loop.notify({bypassMaxSteps})` 同 turn 收尾步在新架构映射为紧随的新 turn——新架构无 bypassMaxSteps，第 75 轮已定不迁；空消息触发对齐第 72 轮 retry 先例）。下一 turn 首步 `useBeforeStep` 置 active，期间一切 tool call 被 veto 为 HANDOFF_VETO_TEXT + isError + stopTurn（文案逐字），该步 afterStep 置 done 并结算 `tool_call_repeat_handoff {outcome: vetoed|text}`；handoff 通知与真实 prompt 合并 drain 时丢弃本次 handoff（turn.started `entry` 非空判定，对齐 v2 onDrop）。新 turn 经 `turn.started` 重置 consecutive/handoff/turn 级记录（v2 turnId 变更检测对映）。
- 遥测：`tool_call_turn_repeat` / `tool_call_dedup_detected {dup_type: same_step|cross_step}` / `tool_call_repeat {action: none|r1|r2|r3|stop}` / `tool_call_repeat_handoff` 四自定义事件经 `useTelemetryEvents` 注册 + `TelemetryRef` 可选探测上报（undo 先例，telemetry feature 缺席静默跳过——preset 未挂 telemetry）；v2 的 `toolExecutor.recordDupType` 在 `tool_call` 事件上标 dup_type 不迁（框架 tool_call 事件面无 dup_type 字段，recordDupType 通道无对应物）；trace_id 字段不迁（hook 输入无 request trace 句柄）。

## fileHistory（工厂，不在默认名单）

`createFileHistory({ workDir, fs })`：turn 级文件快照历史（v2 `features/fileHistory` 迁移），agent 层。`fs: OsFsPort` 为必传宿主端口（createMedia 必传端口先例；v2 `IHostFileSystem` 的 stat/readBytes 与 `OsFsPort` 同形，grown/shrunk 竞态分支逐字保留）。v2 为 registerFeature 默认启用，但 workDir/fs 是宿主概念，按 os/edit 先例由宿主挂载、不进 preset（example 已挂 `createNodeOsHost().fs`）。

- 状态：`file_history.tracked` / `file_history.checkpoint` durable 事件落 agent journal + fold 投影（checkpoints `{turnId, phase start|end, entries path→{key,version,contentHash,size,oversize,mtimeMs}}` + tracked），remount 重建；turn 窗口驱逐（`FILE_HISTORY_TURN_WINDOW = 5`，`displacedCheckpoints` 逐字）在投影层。
- 捕获：main agent 全量管线——`useBeforeTool`（= v2 onWillExecuteTool 执行前捕获，preparingTools 阶段 await 捕获完成才放行执行）按工具名 Edit/Write + 容错解析 arguments 取路径（`file_path` ?? `path`；v2 读 `execution.display` 的 file_io edit/write，新架构无 display 通道，v2 侧 file_io 生产者实证只有 Edit/Write，语义等价）+ `agent.on('turn.started'/'turn.done')` 跟踪 activeTurnId、turn.done 入队 end checkpoint；非 main agent（构造器分流逐字对齐 v2）经 `useSession().get(MAIN_AGENT_ID)?.resolve(FileHistoryRef)` 转发 `captureForActiveTurn`（resolve 失败按 v2 守卫语义跳过），自身无状态。
- 快照字节走 `useBlobs()`（内容寻址）：`entry.key = 'file-history/<sha256内容>'`（v2 键控 `file-history/<sha(path)>@v<N>` 的前缀语义保留在 durable state；同内容跨路径天然去重）。v2 的孤儿 blob 物理清扫 / retention 物理驱逐 / 30-session LRU（`touchFileHistorySession`，依赖 IAtomicDocumentStore + 物理删目录）无端口可落（`Blobs` 无 list/delete、无 workspace doc store）——物理回收 = 内容寻址去重 + `space.delete` 整目录；`turnRecorded` 的 blob 存在性校验（has）保留。
- 读面：facade `FileHistoryRef`（agent 层）——`history()` / `settled()`（串行 promise 链排干，read-your-writes；v2 `enqueue`/`enqueueValue` 逐字移植）/ `captureForActiveTurn(path)` / `changes(turnId)`（start/end checkpoint 比对，LCS 行 diff 双预算常量逐字）/ `turnRecorded(turnId)` / `contentAt(turnId, path, phase='start')`。turnId 与新架构数值 turn id 1:1（首个 turn 为 0，wire `turn_id: number` 零转换）。v2 卸载时 drain 写链（`fileHistory:drain` effect）无对应机制（slot cleanup 同步），agent 关闭瞬间在途捕获可能不落账，偏差在案。
- feature-http：`GET /sessions/:session_id/file-history/changes?turn_id=` → `{changes, recorded}`、`GET /sessions/:session_id/file-history/content?turn_id&path&phase?` → `{content|null}`（wire 形状对齐 kap-server `protocol/rest-file-history.ts`）；facade 缺席 40949、session 未知 40401、参数非法 400。
- sessionExport 的 `file-history` 路径段排除随本域落地生效（第 20 轮保留的过滤）。

## 已有 Feature 速查

| Feature | 形态 | 层 | 默认名单 |
|---|---|---|---|
| providerCatalog / waitFor / undo（agent-core builtin） | spec | app / agent | 是 |
| todo / timing / usage / interaction | spec | agent（interaction 双层） | 是 |
| tokenCounting | spec | agent | 是 |
| createKimi（复合：核心 + oauth/web/fetch/sessionTitle/trace） | 工厂 | app / session / agent | 是 |
| createPlan / createCron / createPermission | 工厂 | app / agent | 是 |
| createTask | 工厂 | agent | 是 |
| createSwarm | 工厂 | app / session / agent | 是 |
| createToolSelect / createCompaction / createHttp | 工厂 | agent / app | 否 |
| createMedia | 工厂 | app / agent | 否 |
| createPtc / createNotify | 工厂，flag 门控 | agent | 否 |
| createTower | 工厂，flag 门控 | app / session / agent | 否 |
| createShellCommand / createEdit / createOs | 工厂 | agent（os 双层） | 否 |
| createSessionExport | 工厂 | app | 否 |
| createModelsDev | 工厂 | app | 否 |
| createSessionInit | 工厂 | session | 否 |
| createExternalHooks | 工厂 | app / session / agent | 否 |
| createSkill | 工厂 | app / agent | 否 |
| createMcp | 工厂 | app / agent | 否 |
| createProfiles | 工厂 | app | 否 |
| createAgentsMdReminder | 工厂 | agent | 否 |
| createWorkspaces | 工厂 | app | 否 |
| createCapabilities | 工厂 | app | 否 |
| createToolDedupe | 工厂 | agent | 是 |
| createFileHistory | 工厂 | agent | 否 |
