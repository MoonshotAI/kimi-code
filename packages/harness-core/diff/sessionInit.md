# sessionInit：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/sessionInit/`（约 224 行：feature.ts 169 / agents-md.ts 35 / init.ts 17 / init.md 21 / index.ts 3）
- agent-core-v2：`packages/agent-core-v2/src/features/sessionInit/`（168 行：sessionInitService 118 / sessionInitFeature 21 / sessionInit 12 + profile/{init.ts 17, init.md 21}）
- 蓝本关系：v2 DI 版实现即行为规格蓝本（sessionInit 不在 refact-237 第一批 human 蓝本范围内）。init.md 与 init.ts（DEFAULT_INIT_PROMPT + initCompletionReminder 含空内容回落文案）与 v2 `profile/init.*` **逐字节一致**（diff 实证 SAME）。feat-271 第 35 轮落地，第 36 轮两段式等待收编为 `child.run`，第 50 轮删除镜像事件。

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 挂载形态 | `registerFeature` 默认启用，session 层 DI 服务常驻（sessionInitFeature.ts:8-19） | `createSessionInit({ workDir, host?, brandHome? })` session 层工厂不进 preset；`host` 未传不挂载（facade 缺席，roster 仍记 feature 名保持 remount 一致） | host 端口注入横切约定（能力归宿主注入端口，第 22 轮追加用户决策③先例；第 35 轮设计） |
| 子代理创建 | `agentLifecycle.create({ binding: { profile:'coder', model: own.modelAlias, thinking: own.thinkingLevel } })`——profile 绑定制，id 由 lifecycle 分配 | `session.create({ agentId: \`subagent-${randomUUID().slice(0,8)}\`, systemPrompt, source: 'session-init' })`——roster 创建者标记（btw 先例），systemPrompt 经 `ProfileCatalogRef` 可选探测渲染（catalog/coder 缺席时子代理裸提示词运行，降级不报错） | roster source 单次写入原子化（第 7 轮用户定稿）；不走 `spawn:` 前缀——init 子代理不可经 Agent 工具 resume（第 35 轮设计）；profile 降级为可选探测（第 35 轮偏差⑤：v2 必有 profiles 绑定，新架构 profiles 未挂载时降级） |
| 模型/思考继承 | binding 携带 `model: own.modelAlias` + `thinking: own.thinkingLevel` | `child.setConfig(main.config)` 整个 config 复制（含 thinking） | 语义等价、机制不同（config 复制 vs profile binding；spawn 第 8 轮模型继承同款） |
| 模型绑定制约前置 | `own.modelAlias === undefined` → Error2 `SESSION_INIT_FAILED 'Main agent has no model bound'` | `main.config === undefined` → `SessionInitError('session.init_failed', 'Main agent has no model bound')`（文案逐字） | 第 35 轮；新架构无 profile data 概念，config 即绑定 |
| permission mode 复制 | `child.accessor.get(IAgentPermissionModeService).setMode(mode)`（fire-and-forget 浮空） | main/child 各 `resolve(PermissionRef)` try/catch，缺席静默；命中时 `await setMode(mode)` | 第 35 轮偏差②（改 await 使 facade 确定性；permission 域在新架构是可选 Feature 而非恒在 DI 服务） |
| init turn 执行 | `subagents.run(agentContextOf(child), {kind:'prompt', prompt})` + `mirrorAgentRun(main, run, …)` 两段（spawned/completed 镜像事件经 mirror 发出） | `child.run(createUserMessage(DEFAULT_INIT_PROMPT), { meta: { origin: { kind:'subagent' } }, signal })` 一条 await 复合命令 | 第 36 轮用户指示的 `AgentCommands.run`（两段式等待收编，sessionInit 为薄包装）；origin subagent 与 v2 一致 |
| 镜像事件 | `emitAgentRunSpawned`（parentToolCallId `'generate-agents-md'`、description `'Initialize AGENTS.md'`、model）+ mirror 的 `subagent.completed/failed/cancelled`（`durable:false`，kap-server/TUI 消费） | **全部删除**——完成/失败/取消即 facade 的 resolve/reject；无 `subagent.*` 事件、无 parentToolCallId/description 展示元数据 | 第 50 轮用户定稿：镜像事件是冗余投影，信息架构收敛为 roster source（durable 身份）+ 双方 journal + 统一 tool/agent 事件流；externalHooks SubagentStop 对 `session-init` source 经 roster 恒派生 `'coder'`（第 50 轮⑤） |
| 完成注入 | `IAgentReminderService.notify(text, { variant:'init' })` + `IEventDispatcher.flush()` | `main.remind(systemReminder(initCompletionReminder(content)).userMessage(), { key: 'session-init' })`——被动注入、drain 时落账；v2 末尾 `flush()` 无对应物（remind 同步入队、drain 落账） | remind 取代 v2 reminder 总线的横切约定（用户 2026-09-27 决策）；第 35 轮偏差③ |
| AGENTS.md 装载 | `loadAgentsMdDetailed({fs, homeDir}, cwd, bootstrap.homeDir)`（profile/context.ts，deps 形态；返回含 `warning` 字段） | `loadAgentsMdDetailed(host, workDir, brandHome?)`——host 端口形态（await environment.ready + 复用 agentsMdReminder 的 `loadAgentsMdPaths` 链 + `<!-- From: -->` 注解渲染逐字）；无 `warning` 字段 | 第 35 轮偏差④（签名改 host 端口）；brandHome 缺省 `<homeDir>/.kimi-code`（v2 传 bootstrap.homeDir——同为 brand home 语义，来源层级不同） |
| 种子注入 | `IAgentAgentsMdReminderService.seedInjected(paths, cwd)`（DI 恒在） | `main.resolve(AgentsMdReminderRef).seed(paths)` try/catch 可选探测（agentsMdReminder 未挂载静默跳过） | 第 22 轮 `AgentsMdReminderRef.seed` facade 预留的接线点；可选探测先例 |
| 错误域 | Error2 + ErrorCodes（`AGENT_NOT_FOUND`/`SESSION_INIT_FAILED`） | `SessionInitError extends Error { code }`，码值 `'agent.not_found'`/`'session.init_failed'` 与文案逐字；其余错误包 `session.init_failed` 带 cause；`AbortError` 名原样不包装（v2 isUserCancellation/isAbortError 语义） | Error2 域注册机制不迁（sessionExport 第 20 轮⑤同类先例）；`cancelInit` 默认 reason `Object.assign(new Error('Aborted by the user'), {name:'AbortError'})` 对齐 v2 UserCancellationError 形态 |
| 失败映射 | mirror/subagents.run 的失败经 Error2 包装上抛 | `outcome.type==='failed'` 显式映射：cause 取 `failure.error`，消息取 error.message / max_steps message / `'Agent turn failed'` 三态回落（feature.ts:119-129） | 新架构 TurnOutcome 结构的自然映射（第 35 轮） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| init 子代理工具白名单 | 子代理经 profile 绑定获得 coder profile 的工具白名单（CODER_TOOLS 22 项，profileService 强制） | 子代理拿到的是 session 内全量 feature 工具（spec freeze 于挂载），白名单仅 systemPrompt 文案约束 | 与 spawn 第 1 轮偏差④同款（无 toolPolicy 层）；sessionToolPolicy 归属挂起（permission 或 profiles），待其落地恢复强制 |
| 无 catalog 时裸提示词 | 不可能发生（profiles 是 DI 恒在服务，coder 必有） | profiles 未挂载时 `systemPrompt` 为 undefined 裸跑（仍能完成 init，但无 coder 角色文案与 prompt prefix） | 第 35 轮偏差⑤记录在案（降级不报错）；example 已挂 createProfiles |
| TUI 展示元数据 | spawned 事件携 parentToolCallId/description/model，TUI 子代理卡片有标题与归属 | 无（mirror 删除的连带结果；roster source 'session-init' 只承载身份） | 第 50 轮定稿的信息架构收敛；TUI 侧展示降级属该决策的接受范围 |
| reminder 落账时机 | notify + flush 后立即落 history | remind 排队的被动 reminder 只在 turn 经过 draining（工具步骤之间）时带入历史；纯文本单步 turn 不带 | 机器语义（第 35 轮偏差①实证，与 shellCommand 第 16 轮/dateChange 同源）；用户选定路径的固有特性 |
| `warning` 字段 | `LoadedAgentsMd.warning`（装载异常警示） | 无 | 细粒度降级，未在 Handoff 单列；读取失败/空文件按 skip 处理（agents-md.ts:28-31） |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| `SessionInitRef` facade 经 `useExpose` 落 session 层 | `generateAgentsMd()` / `cancelInit(reason?)`——v2 为 DI 服务同两方法（面已对齐），新架构额外使兄弟 Feature/宿主经 `session.resolve(SessionInitRef)` 可选探测消费 |
| roster durable 身份 | `source: 'session-init'` 随 `agent.opened` 单次写入原子落账（v2 无 roster source 概念），跨进程可判定 init 子代理身份；externalHooks 的 SubagentStop 派生直接受益（第 50 轮⑤） |
| `cancelInit(reason?)` 可携自定义原因 | v2 `cancelInit()` 无参（恒 userCancellationReason）；新架构允许调用方给取消原因，缺省回落 AbortError 形态 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| 工厂 props | 无（DI；cwd/homeDir 取自 ISessionContext/IBootstrapService） | `createSessionInit({ workDir, host?, brandHome? })` | 人为设计（host 端口注入约定） |
| config 节 / env 绑定 / flag | 无 | 无 | 已对齐 |
| preset | 默认启用（registerFeature） | 不进 preset（workDir/host 宿主概念；example 挂载于 createOs 之后） | 人为设计（工厂先例） |
| HTTP 路由 | kap-server 无 REST 路由（消费方为 node-sdk 进程内 RPC：sdk-rpc-client-v2 `session.generateAgentsMd`/`cancelInit`） | 无 feature-http 路由（facade only） | 已对齐（第 35 轮） |

## 工具 / 事件 / facade 面差异
- 两侧均无 agent 工具。facade 面已对齐：`generateAgentsMd(): Promise<void>` + `cancelInit`（v2 无参 → 新架构可选 reason）。
- 事件：v2 经 mirror 发 `subagent.spawned/completed/failed/cancelled`（observable，`durable:false`）；新架构无 Feature 事件（第 50 轮删除），生命周期经 facade Promise + roster `agent.opened{source:'session-init'}` + 子代理自身 turn 事件表达。
- 文案面全部逐字：`Main agent was not found` / `Main agent has no model bound` / init.md 全文 / initCompletionReminder（含 `No AGENTS.md content was found after \`/init\` completed.` 空内容回落）。

## 摘要
sessionInit 是四个域中对齐度最高的：核心流程（main 校验 → coder 子代理跑 init prompt → 装载 AGENTS.md → seed + 完成注入）逐段对齐 v2，init prompt 与完成 reminder 文案逐字节一致，错误码/文案逐字。三个最关键差异：① 子代理从「profile 绑定制」变为「roster source 标记 + systemPrompt 可选渲染 + setConfig 复制」，coder 工具白名单的强制执行随之消失（sessionToolPolicy 挂起）；② `subagent.*` 镜像事件按第 50 轮用户定稿删除，TUI 展示元数据（parentToolCallId/description）无对应，身份改由 durable roster 承载；③ 完成注入走 remind 被动通道，纯文本 turn 不落账（机器语义）。最需关注的缺口是工具白名单强制——init 子代理当前持有 session 全量工具，与 v2 的 coder 受限面不等价。
