# externalHooks：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/externalHooks/`（约 958 行：feature.ts 404 / runner.ts 94 / config-section.ts 25 / internal/{types 53, match 131, run 233} / index.ts 13）
- agent-core-v2：`packages/agent-core-v2/src/features/externalHooks/`（1381 行：agent/agentExternalHooksService 473 / session/sessionExternalHooksService 183 / app/externalHooksRunnerService 120 / internal/{matchHooks 134, runHook 241, types 53, userPrompt 66} / configSection 36 / feature 注册 40）
- 蓝本关系：v2 DI 版实现即行为规格蓝本（externalHooks 不在 refact-237 第一批 human 蓝本范围内）。harness-core 侧分批落地：runner 基础设施 + 20 事件中的 8 个语义对齐事件（feat-271 Handoff 第 44 轮），SessionOpened/SessionClosed 随后接线（refact-237 本轮，agent-core 加 session open source 通道；事件名按用户指示自 v2 的 `SessionStart`/`SessionEnd` 改名，见人为设计表），其余 10 事件逐项待对齐（Handoff 第 44 轮遗留，在案）。

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 挂载形态 | `registerFeature` 默认启用，App/Session/Agent 三层 DI 服务常驻（externalHooksFeature.ts:13-30） | `createExternalHooks({host?, workDir?, clientType?, shell?})` 工厂不进 preset；`host` 未传时三 slot 全 no-op（仅 app slot 仍注册 config 节，feature.ts:45-58） | host 端口注入横切约定（能力决策归宿主注入端口，第 22 轮追加用户决策③先例；第 44 轮设计要点①） |
| hooks 索引机制 | `config.ready` 一次性 load + `plugins.onDidReload` 触发 reload，持 `ready: Promise` 屏障与 `onDidReload` 事件（externalHooksRunnerService.ts:34,101-119） | `computed` 响应式索引 `indexHooks(hooks())`，读时即最新；无 ready/reload 概念（runner.ts:45） | 第 44 轮偏差③（computed 取代 watch/ready，读时即最新、无清理）；config 贡献模式的响应式语义 |
| hooks 来源 | config 节 + `plugins.enabledHooks()` 插件来源合并（externalHooksRunnerService.ts:113-118） | 仅 config 节（runner.ts:52-53 只读 `HOOKS_SECTION`） | 插件来源待 #24 plugin 域接线（plugin 域缺口②在案，见「简化」表） |
| config 节文件键 | `hooksFromToml`/`hooksToToml` 做 snake_case↔camelCase 双向转换（configSection.ts:23-31） | 无转换器，TOML 键按字段名（camelCase）原样读写 | 第 2 轮偏差①「键名不做 snake↔camel 转换」决定的延续（第 12 轮⑤同类先例） |
| SubagentStop 派生 | 订阅 `subagentService.onDidStopAgentTask`（spawn 管线成功路径回调），agentName 来自任务上下文（sessionExternalHooksService.ts:89,171-182） | session 层 `watchSubagentStops`：订 `agent.opened`（reopened 也挂）按 durable roster source 判定身份（`spawn:` 前缀经 `parseSpawnSource` 取 profile、`session-init` 恒 `'coder'`），给子代理挂 `turn.started`/`turn.done` 监听，origin ∈ {subagent, retry} 且 outcome done 才触发；response 取 `turn.done.messages` 末条 assistant 文本（feature.ts:227-278） | 第 50 轮用户定稿删除 `subagent.*` 镜像事件（信息架构收敛为 roster source + 双方 journal + 统一事件流）+ 第 50 轮⑤；身份源是 durable roster，第 44 轮「重挂回落 agentId」的保真度损失就此修复 |
| TaskStarted 载荷 | `kind = info.kind`（任务类型，如 bash/subagent）、`detached = info.detached`（实际值）（agentExternalHooksService.ts:289-302） | `kind = record.toolName`、`detached` 恒 `true`（feature.ts:191-206） | task 域用户重定义（task = detached tools 的记录，第 23 轮）；消费 task Feature 的 `task.started` 事件（第 44 轮） |
| env 合并位置 | hook 定义层 `buildHookSpawnOptions` 合并 `{...process.env, ...options.env}`（runHook.ts:16-28） | OsHost node 实现层 `buildEnv` 合并（os/host/node.ts:45-50），run.ts 透传 | 第 44 轮偏差④；host 端口化的自然归属 |
| SessionOpened/SessionClosed 接缝 | sessionLifecycle 的 `onDidCreateSession`（source 排除 fork）/`onWillCloseSession` 生命周期事件 + `waitUntil` 等待钩子完成（sessionExternalHooksService.ts:63-82,109-139）；v2 生命周期即等待，但钩子返回值被丢弃——纯观测 | SessionOpened 在 feature session slot setup 经 `useReady` 触发（`session.ready()` 等待，等价 waitUntil）；SessionClosed 经 session slot `pushCleanup` 异步清理触发（kernel `performUnmount` await 清理，close/delete/app unmount 三条路径全覆盖）；SessionOpened 的 source 经 agent-core `SessionUnitProps.source` 输入通道下发（openSession 按 from/existed 计算 fork/resume/startup）、经 `SessionCommands.status().source` 读取（`SessionStatus` 的静态元数据字段，feature.ts:66-101） | refact-237 本轮（用户指示「这个加一下」）；kernel 清理本就 await（runtime.ts `performUnmount` 逐条 `await entry.cleanup()`），无需新框架机制；观测语义与 v2 一致（两侧均 `trigger` 而非 `triggerBlock`，结果均不消费） |
| 两事件改名 | 事件名 `SessionStart` / `SessionEnd`（HOOK_EVENT_TYPES 枚举与 stdin `hook_event_name`） | 改名 `SessionOpened` / `SessionClosed`（internal/types.ts:15-16） | 用户指示（2026-09-30）：「Start/End」易与 prompt/turn 的开始混淆，改名对齐 `agent.opened`/`agent.closed`/`session.deleted` 节点事件族；config schema 枚举同步改名，v2 配置文件里的这两个事件名在 harness-core 不再被接受（「不考虑兼容性」先例） |
| 钩子进程 cwd | session 层显式传 `context.cwd`（SessionStart/End/SubagentStart/Stop/heartbeat），agent 层缺省 fallback 到 `bootstrap.cwd` | session/agent 层统一不传 cwd，回落 runner 默认 `props.workDir`（runner.ts:55） | 第 44 轮偏差⑤（新架构无 session cwd 概念，workDir 归宿主注入） |
| shell 形态 | `spawn(command, [], {shell: true})` 平台隐式默认 shell（runHook.ts:66-70） | 显式 shell：POSIX `/bin/sh -c`、win32 `cmd.exe /s /c`，并新增 `shell` prop 覆盖（run.ts:49-51） | OsProcessPort 传输无关约束（无 `shell:true` 概念，第 44 轮「v2 shell:true 用显式 shell」）；行为等价 + 新增可覆盖面 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 第二批 12 事件中 10 事件未接线 | PostToolUse/PostToolUseFailure（onDidExecuteTool，isError 分流、toolOutput 截 2000、error payload）、PermissionRequest/PermissionResult（approval 事件总线）、UserPromptSubmit（block prompt + 注入 `<hook_result>` 消息 + HookResult 事件）、Stop（onDidFinishStep 强制续行：注入 stop_hook user 消息 + loop.notify）、SubagentStart（onWillStartAgentTask 带 prompt）、PreCompact/PostCompact（compaction 钩子，带 trigger/tokenCount）、Notification（TaskNotified，sink:'context'） | 均未接线；config schema 已接受全部 20 事件枚举（internal/types.ts:3-24），配置不报错但无触发源 | 逐项待对齐（Handoff 第 44 轮遗留）：isError 通道已落地（第 76 轮），PostToolUse/PostToolUseFailure 接线条件就绪，仍随第二批逐项对齐；Stop 需 afterStep 决策面加「强制续行」（第 31 轮已落地 stopTurn 反向决策）；UserPromptSubmit 需 gate 内写 history 通道 + steer 过 gate；SubagentStart/PreCompact/PostCompact/Notification/PermissionRequest/PermissionResult 依赖各自域接缝；~~SessionStart/SessionEnd~~ 已接线并改名 SessionOpened/SessionClosed（见人为设计表与下方两行） |
| SessionClosed（v2 `SessionEnd`）的 `'archive'` reason | `archive()` 先写 archived 元数据、再以 reason `'archive'` 关闭 live session（sessionLifecycleService.ts:429-449），SessionEnd 随之触发 | 无——新架构 `:archive` 只写 `archived:true` metadata、不关闭 live session（第 58 轮），当前所有关闭路径（close/delete/app unmount）reason 恒为 `'exit'` | v2 `delete` 经 close 同样产生 `'exit'`（已对齐）；archive 不关闭属第 58 轮记录在案的语义差异，若日后 archive 改为关闭 live session，reason 通道需同步补 `'archive'` |
| SessionOpened（v2 `SessionStart`）的 model/profile 载荷 | `model = models.getDefaultModel()`、`profile = profiles.getDefault().name`（就绪后读取）（sessionExternalHooksService.ts:114-119,123-130） | `model` = config `defaultModel` 节可选探测（config 缺席 → undefined）、`profile` = `ProfileCatalogRef.getDefault().name` 可选探测（profiles 缺席或为空 → undefined）（feature.ts 的 `defaultModelOf`/`defaultProfileNameOf`） | 数据源不同、词汇一致；两字段均为 best-effort 元信息，缺失时键仍出现在 stdin（undefined 被序列化丢弃——v2 同行为） |
| UserPromptQueued 触发语义 | 订阅 `PromptQueued`（仅真实入队时触发），载荷带 `queueLength`（agentExternalHooksService.ts:204-211） | 订阅 `prompt.submitted`：每次 submit 都触发（无 queued-only 门控），无 `queueLength` 字段（feature.ts:176-185） | 第 44 轮记录在案保真度损失；高频 prompt 场景 hook 触发次数多于 v2 |
| 钩子进程不随操作中止 | PreToolUse/PostToolUse/Stop/SubagentStart/PreCompact 均传底层操作 signal，abort 时 SIGTERM→100ms→SIGKILL 杀钩子进程 | `run.ts` 支持 `signal` 参数但 feature 层全部不传（`useBeforeTool` 的 `ToolBeforeInput` 无 signal），钩子进程只受 timeout 约束 | 第 44 轮记录在案（PreToolUse 项）；turn abort 期间钩子进程可能跑满 30s 超时；待贡献点补 signal 面 |
| PreToolUse block 的 isError 标记 | veto 产物 `{output: reason, isError: true}`（beforeToolExecuteEvent.ts:19-21），模型经 ERROR 状态块感知失败 | 已消除——框架对全部 preflight denied 结果集中标 `isError: true`（含 hooks block），模型经 ERROR 状态块感知 | A 步已落地（第 76 轮） |
| TurnStarted 的 prompt 文本提取 | `turnPromptText(input, origin)` 对 `origin.kind==='user'` 跳过前 N 个 skill 捆绑 part（turnEvents.ts:58-69） |  join 全部 text part，不剥离 skill 捆绑块（feature.ts:315-321） | 未在 Handoff 记录（Handoff 仅称「可展示判定等价 v2」——`isDisplayablePromptOrigin` 判定本身逐字等价，但 prompt 提取不等价）；skill 激活后的首个 user prompt 的 hook 载荷会混入 skill 块文本 |
| `hook.result` observable 事件 | UserPromptSubmit block/append 时经 `IEventDispatcher` 派发 `HookResult` AgentEvent2（observable，kap-server/TUI 可投影）（agentExternalHooksService.ts:54-62,362-369,381-388） | 无对应物 | 随 UserPromptSubmit 未接线整体缺席；新架构无 AgentEvent2 总线，届时需 Feature 事件形态另行决策 |
| sessionTitle 获取机制 | 异步 `metadata.read()` + `onDidChangeMetadata` 跟踪 | `trackSessionTitle`：初始读 `sessionMeta` + `onCommit` 投影 `session.meta_updated`（feature.ts:280-290） | 机制不同、可观察行为等价（均有初始 undefined 窗口），不算缺口 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| hooks 配置热生效 | config 文件变更经 persist.watch → section ref 更新 → computed 重索引，即时生效；v2 仅启动时 load 一次 + 插件 reload 时重载，config 热改不触发 hooks 重载 |
| `shell` prop 覆盖 | v2 固定平台隐式 shell；harness-core 可由宿主指定任意 shell 解释器（runner.ts:39, run.ts:50） |
| facade 对宿主暴露 | `ExternalHooksRunnerRef` 经 `useExpose` 落 app 层（trigger/triggerBlock/fireAndForgetTrigger/hasHooksFor/summary），宿主/其他 Feature 可编程触发 hook；v2 `IExternalHooksRunnerService` 为 DI 内部服务（面同形，额外多 `ready`/`onDidReload`） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `hooks` 节 schema | zod strict：`event`（20 枚举）/`matcher?`/`command`（min 1）/`timeout?`（int 1-600），数组（configSection.ts:10-21） | 逐字相同（config-section.ts:9-20） | 已对齐 |
| `hooks` 节 TOML 键 | snake_case 文件键经 fromToml/toToml 转换 | camelCase 原样读写 | 人为设计（第 2 轮文件兼容差异） |
| 插件 hooks 来源 | `plugins.enabledHooks()` 合并进索引 | 无 | 简化（plugin 域缺口②在案） |
| 工厂 props | 无（DI；cwd/clientType 取自 IBootstrapService） | `{host?, workDir?, clientType?, shell?}` | 人为设计（host 端口注入约定） |
| env 绑定 | 无 | 无 | 已对齐 |
| flag 门控 | 无 | 无 | 已对齐 |
| hook 进程环境变量 | `HookDef.env` 定义时合并 process.env（spawn options 层） | 同语义，合并在 host 层 | 已对齐（归属层级不同，见人为设计表） |

## 工具 / 事件 / facade 面差异
- 两侧均无 agent 工具。facade 面基本对齐：v2 `IExternalHooksRunnerService`（trigger/triggerBlock/fireAndForgetTrigger/hasHooksFor/summary + ready/onDidReload）↔ harness-core `ExternalHooksRunner`（同五方法，无 ready/onDidReload——响应式索引取代，人为设计）。
- v2 有 `HookResult` observable AgentEvent2（UserPromptSubmit 专用）；harness-core 无 Feature 事件（该事件随 UserPromptSubmit 未接线整体缺席）。
- 已接线 10 事件的载荷对齐情况：PreToolUse（toolName/toolInput/toolCallId 逐字，block→denied 文案 `Blocked by <event> hook` 回落逐字）、TurnStarted（turnId/originKind/originName/prompt + displayable 判定逐字）、StopFailure（errorType/errorMessage；LLM 载荷 kind 作 error_type、Error 实例取 name）、Interrupt（turnId + reason:'cancelled'）、UserPromptQueued（promptId/prompt，缺 queueLength）、SessionHeartbeat（60s + hasHooksFor 门控 + uptimeMs）、TaskStarted（七字段，kind/detached 语义见人为设计表）、SubagentStop（agentName/response）、SessionOpened（source/sessionTitle/model/profile，matcher=source，fork 不触发，打开路径等待）、SessionClosed（reason/sessionTitle，matcher=reason，关闭路径等待）。stdin 输入统一 camel→snake 转换 + `hook_event_name`/`session_id`/`cwd`/`client_type` 注入，两侧逐字一致（match.ts:121-131 ↔ matchHooks.ts:124-134）。
- runner 核心语义全部逐字对齐：matcher 正则（非法 pattern 不匹配）、cwd+command 去重、30s 默认超时（SIGTERM→100ms→SIGKILL）、exit 2 → block（stderr 为 reason）、exit 0 + stdout JSON `hookSpecificOutput.permissionDecision:'deny'` → block、其余 allow、spawn 失败/超时/abort 均 allow 不阻断。

## 摘要
externalHooks 的 runner 基础设施（匹配/去重/超时/退出码与结构化输出判定/stdin 契约/env/shell）与 20 事件中的 10 个已全量接线且语义逐字对齐，是最重要的已对齐面。三个最关键差异：① 第二批 12 事件中 10 事件未接线（各自卡在框架接缝上——afterStep 强制续行、gate 写 history 通道等，属记录在案的待办而非设计否决；isError A 步已落地不再构成阻塞；SessionOpened/SessionClosed 已随 agent-core session open source 通道接线并改名）；② SubagentStop 改由 durable roster + turn origin 派生（第 50 轮用户定稿的镜像事件收敛，身份保真度反而优于 v2 内存表）；③ UserPromptQueued 无 queued-only 门控与 queueLength、全部钩子进程不随操作 abort（signal 面缺失）。最需关注的缺口是 UserPromptSubmit——它是 v2 唯一可阻断/改写用户 prompt 的 hook，其实现依赖 prompt gate 写 history 通道，目前连接缝都不存在。
