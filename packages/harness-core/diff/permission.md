# permission：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/permission/`（1725 行 ts + 2 个 reminder md：state/ 126（projection 52 + configSection 74）→ language/ 376（pattern 77 + subject-match 160 + tool-matchers 139）→ policies/ 368（chain 73 + mode 28 + user-rules 114 + dangerous 25 + files 36 + defaults 75 + file-access 17）→ analyzers/ 411（bash-danger 325 + git 86）；根 feature.ts 166 / ask.ts 127 / remind.ts 68 / types.ts 64 / index.ts 19）+ **agent-core 框架层内置裁决阶段**（`packages/agent-core/src/feature/contribution-hooks.ts` 的 `useToolPermission`/`toolPermissions` 注册表/两阶段组合，及 turn 机 `preparingTools` 屏障）
- agent-core-v2：`src/agent/permissionMode`（201）+ `src/agent/permissionPolicy`（981）+ `src/agent/permissionRules`（398）+ `src/agent/permissionGate`（115）+ `src/agent/toolApproval`（305），合计 2000 行
- 蓝本关系：v2 DI 版五件套为规格蓝本（feat-271 第 29 轮迁移）；不属 refact-237 第一批。13 条 policy 链顺序、危险命令分析器、规则语言（parsePattern/picomatch/subject-match）、worker guidance 后缀、两条 auto reminder md 均逐字/逐字节对齐。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| **内置裁决阶段（v2 没有的结构）** | 扁平模型：permissionGate 与 plan 守卫等平级同订 `toolExecutor.onBeforeExecuteTool`，生效顺序 = DI 激活顺序；`event.allow()` 可短路后续全部监听器（含 permissionGate 本身，beforeToolExecuteEvent.ts:106-109） | agent-core 工具机生命周期内置三阶段：`beforeTools（领域守卫）→ toolPermissions（裁决）→ execute`（contribution-hooks.ts:358-368）；第 40 轮 preflight 屏障后组合在 turn 机 `preparingTools`：批钩子链 → 每 call beforeTools → 每 call toolPermissions，per-call 并行、链内顺序、首个 denied 短路、proceed 改写链式传递——裁决者看到的是领域守卫改写后的最终 toolCall | feat-271 约束问答 permission 条（用户 2026-09-29 定稿）：领域守卫先、Permission 殿后是安全/体验不变量；plugin（#24）动态注册时代扁平模型有裁决被绕过的实洞；「此方案修掉 v2 也有的缺陷」。agent-core 零产品语义（不知 mode/rules/interaction/dangerous command） |
| ask 的实现位置 | policy 返回 `kind:'ask'`，permissionGate 统一调 `toolApproval.requestToolApproval`（ask 是链的返回值之一） | 「ask 不是返回值」——`features/permission` 的裁决 hook 在 `useToolPermission` 回调里自己 `interactions.request` 异步问完宿主，再返回最终 `denied`/放行（feature.ts:108-147 → ask.ts:28-92） | 同上定稿：签名复用 `ToolBeforeInput`/`ToolBeforeDecision`，ask 由裁决者异步自理 |
| PermissionMode（状态）≠ Permission（判决） | mode 服务 + policy 链 + plan review 同读 mode（exitPlanMode auto 免审在 plan 侧） | mode 是 agent 级 durable 共享状态（permissionProjection），policy 链读它；plan 守卫自读 `PermissionRef` 调制自己的审批（与 policy 链无关） | 约束问答概念边界（用户梳理确认）①②③ |
| policy 链组装 | DI 实例数组，`bootstrap.args.nonInteractive` 时去掉 dangerous-command-ask（permissionPolicyService.ts:39-55） | 纯函数数组，`createPermission({interactive?})`（默认 true）承载 nonInteractive 语义（chain.ts:53-67）——13 条顺序逐字一致 | 第 29 轮执行事实 |
| 规则匹配器的归属 | 每个工具的 `ToolExecution` 自带 `approvalRule`/`matchesRule(argPattern)`（如 bashTool.ts:150-151、readTool.ts:218-219） | permission 域内按工具名维护 `TOOL_RULE_MATCHERS` 注册表（tool-matchers.ts，29 个条目），不动 `ToolDefinition`；`subject-match.ts` 与 v2 `tool/rule-match.ts` 逐字一致 | 设计要点：「v2 工具自带 matchesRule(argPattern) 映射为 permission 域内按工具名维护的参数匹配器」 |
| mode 广播 | main 的 `setModeAndBroadcast` → `agentLifecycle.broadcastPermissionMode` 同步 session 内全部 live agents；**跳过 pinned profile**（`hasPinnedPermissionMode`，tower-worker pin auto，agentLifecycleService.ts:485-494） | main 广播遍历 roster 对 live agents `resolve(PermissionRef).setMode`（feature.ts:87-101）；**不跳过 tower-worker**——worker 在 spawn 时显式 `setMode('auto')`（tower/tools/spawn.ts:339），此后的广播会覆盖该 pin | 「mode 广播按 v2 对齐」（设计要点）；pinned 跳过未迁，属与 Handoff 记录不符的代码事实 |
| durable 状态 | `permissionModeKey` + `permissionModeConfiguredKey` 两个 defineState；PermissionSetMode 与 PermissionRecordApprovalResult 为 durable 事件，**PermissionRulesAdd 不 durable**（permissionRulesOps.ts:19-22 无 durable 标记——运行期 addRules 重启即失） | `permissionProjection`（`{mode:'manual', configured, rules, sessionApprovalRulePatterns}`）+ 同名 journal 事件三件套全部落账（state/projection.ts）——**rules.add 重启可恢复，强于 v2**；setMode 去重语义（同值且已 configured 则跳过）一致（feature.ts:77-81 vs permissionModeService.ts:54-62） | 设计要点；undo/分支语义随 agent.switched 自然成立（todo/plan 范本） |
| session 规则缓存 | 审批 `approved + scope:'session'` 时取 `execution.approvalRule` 写入 `sessionApprovalRulePatterns`（toolApprovalService.ts:186-203 → permissionRulesOps.ts:59-70） | 同语义：取 `permissionRuleMatcher(name)?.approvalRule?.(args)` 写入同名投影字段（ask.ts:77-88 → state/projection.ts:37-49） | 设计要点「session-runtime 规则缓存（审批『本会话不再询问』时经工具侧 approvalRule 写入）」 |
| `permission` config 节 | zod：rules（decision/scope 默认 'user'/pattern 校验/reason）+ dangerousCommandGuard 默认 true + env `KIMI_CODE_DANGEROUS_COMMAND_GUARD` + stripEnv；另有 `permissionFromToml/permissionToToml` 支持 deny/allow/ask 分组与 `tool`+`match` 键的 toml 写法双向转换（permissionRules/configSection.ts:80-143） | 同 zod 节 + 同 env 绑定 + stripEnv（state/configSection.ts）；**分组 toml 写法与 fromToml/toToml 转换不迁**（config 框架无该钩子，TOML 键按字段名原样读写） | 第 2 轮文件兼容差异先例（设计要点明示不迁） |
| display 派生 | 工具 `execution.display` 富展示（`plan_review`/`file_io`/`agent_call`/`generic` 多形态 ToolInputDisplay） | 首版通用派生：恒 `{kind:'generic', summary:'Approve <tool>', detail: args}`（ask.ts:36-41）；feature-acp 经 `display.detail` 取 args 重建 diff 卡片 | 第 29 轮偏差③：「v2 的 execution.display 不迁」；第 43 轮 feature-acp 部分补回 |
| worker guidance | 非 main agent 的拒绝文案追加 ` Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`（toolApprovalService.ts:232-259） | 逐字一致（ask.ts:94-122，含 cancelled/rejected 两前缀与 ` Reason: <feedback>` 后缀规则） | 设计要点；permission.test 锁定 |
| auto 进出 reminder | PermissionModeInjection 注册 variant 回调 + durable `permissionModeLastModeKey` 去重（permissionModeInjection.ts）；env `KIMI_CODE_PERMISSION_MODE_REMINDER` 门控 | `useBeforeStep` + `agent.remind` 同 key（`permission-mode`）+ 历史扫描去重（remind.ts）；两 md 逐字节一致；env 门控同语义 | 设计要点（dateChange 范本）；去重实现差异见下表 |
| 危险命令分析 | `IBashParserService`（tree-sitter-bash 包的 DI 封装）+ 376 行分析器 | `@moonshot-ai/tree-sitter-bash` 直接 import + 同算法 325 行（analyzers/bash-danger.ts，仅 rootNode 字段名与 parse 注入方式不同） | 设计要点；v2 ask 的 reason（`dangerous_command`/`unanalyzable_command`）随遥测不迁（harness 该 policy 无 reason 字段，无消费方） |
| git 控制路径/工作树 | `IGitService.findWorkTree`（IHostFileSystem 端口）+ runtime 的 pathClass | `analyzers/git.ts` 语义逐字一致，但直接用 `node:fs/promises`（非 OsHost 端口）；pathClass 取 `process.platform` | 未走「host 端口注入」横切约定——浏览器/远程宿主不适用；记录在案（本文件） |
| Feature 事件 | `permission.approval.requested/resolved` 为 observable（非 durable）AgentEvent2——经 IEventDispatcher 总线供 kap-server wire 投影，带 turnId 与完整 display（toolApprovalService.ts:37-67） | 同名 Feature 节点事件（types.ts:35-62），**无 turnId 字段**，display 恒 generic；`useFire` 从 agent 节点冒泡，消费方为 feature-acp/宿主 `on(permission, ...)` 订阅 | 第 29 轮；observable 总线投影通道不迁（kap-server 职责外），durable 两侧均无 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| `defaultPermissionMode` 节 | agent 创建时 `bindBootstrap` 读节并 seed 初始 mode（restore 后跳过，agentLifecycleService.ts:404-417） | 节未注册、无 seed——初始恒 'manual' | 配置面缺口；无待办记录 |
| workDir 未注入时的政策失效 | git-control-path-access-ask 与 git-cwd-write-approve 恒有 session workspace（workDir + additionalDirs + runtime pathClass） | preset 为 `createPermission()` 无参：`workDir` undefined → 两条 git policy 恒返回 undefined；path 规则匹配（`matchesPathRuleSubject`）失去 cwd canonicalize，相对路径规则匹配变弱 | 默认 preset 下：git 仓库内 Write/Edit 不再免审（落 fallback-ask 逐次询问）；`.git` 控制路径访问不再触发 ask；需宿主注入 workDir 才恢复 v2 行为。host 端口注入是既定范式，但 preset 默认值使能力实际缺席，值得宿主编排注意 |
| 审批的 turnId tag 与 signal 中止 | requestToolApproval 附 turnId tag（TurnEnded 时 `cancelInteractionsForTurn` 兜底）+ `abortable(request, signal)` 中止即error 落定（toolApprovalService.ts:138-184） | tags 仅 sessionId/agentId/toolCallId；无 signal 接线——preflight 期间 turn abort 时裁决 promise 被机器丢弃，交互记录滞留 pending 至 agent 卸载 | 与 interaction 域「中止悬挂」同一缺口；v2 的 error 落定路径（`resolveError`）随之不迁 |
| `resolveApproval`/`resolveError` 策略回调 | ask 结果可携带域定制回调（plan review 的 v2 实现即基于此） | 不迁——permission 的 ask 只服务自身；plan 审批在 plan 域 guard 内自给自足 | 结构性不迁，当前无消费方缺失 |
| 工具匹配器覆盖 | v2 侧 CronCreate 有 `CronCreate(<json>)` approvalRule；mcp 工具有 qualifiedName approvalRule；tower 十一工具有 name approvalRule；Agent resume 场景 `resumeProfileName` 解析实际 profile | `TOOL_RULE_MATCHERS` 无 CronCreate/mcp__/Tower* 条目；Agent 恒取 `subagent_type ?? 'coder'` | approve-for-session 对这些工具不落规则（每次都问）；Agent resume 调用的规则匹配可能与 v2 不同 |
| session 规则的路径形态 | Write/Edit/Read 的 approvalRule 用工具 resolveExecution 解析后的**绝对路径** | 用原始 arguments 的 `path` 字符串 | 经 `pathGlobMatch` canonicalize 后大体等价，但 workDir 缺失时相对路径规则匹配弱（与上一条同源） |
| 遥测 | `permission_policy_decision`（policy_name/mode/decision/reason）、`permission_approval_result`（result/duration_ms/session_cache_written/has_feedback/approval_surface）、`yolo_toggle`/`afk_toggle` | 无 | 遥测不迁批次，待云端 appender 落地后统一补回（policy 结果类型收窄删掉 reason 字段，补回时需恢复） |
| `authorize()` 程序化裁决路径 | `IAgentPermissionGate.authorize(context)`（不经事件、直接评估+解决） | 不迁 | 第 29 轮：「无消费方」；v2 侧同样未见生产调用方 |
| spawn 创建时复制调用方 mode | `subagentService.ts:186`、`agentTool.ts:410`（resume）、`sessionSwarmService.ts:297` 在创建/resume 时把调用方 mode 复制给子代理 | 未接——broadcast 仅覆盖已 live agents；新 spawn 的子代理从 manual 起步（直到下次广播） | 第 29 轮遗留记录在案 |
| deny 的 isError 通道 | `denyToolExecution` 产出 `{isError:true, output}`，模型经 ERROR 状态块感知 | 已消除——框架集中标记全部 denied 结果 `isError: true` | A 步已落地（第 76 轮） |
| sessionToolPolicy | v2 有会话级 disabledTools 持久化 + 执行门禁（~148 行，完整性核查②） | 未迁 | 归属挂起（可能是内置阶段内第二裁决者，第 29 轮遗留） |
| 广播的 pinned 跳过 | 见上「mode 广播」行 | 广播覆盖 tower-worker 的 auto pin | 与 Handoff「mode 广播按 v2 对齐」记录不符；main 切 manual/yolo 后 worker 失去 pin，行为偏离 tower 设计（worker overlay 声明「pinned to the auto permission mode … whatever the session's mode」） |
| remount 时 auto reminder 重复注入 | durable `permissionModeLastModeKey`：auto 持续时按 injectedPositions 去重，不重复注入 | `lastMode` 为挂载内闭包初值 undefined：remount 且 mode=auto 时首轮 beforeStep 走「变化」分支必然重注入 enter reminder（steady 分支才有历史扫描去重，remind.ts:38-63） | 同一 auto 存续期内重复 enter reminder；偏差级别低，dateChange 范本未完整套用 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| 内置裁决阶段本身 | `useToolPermission` 贡献点 + `AgentPorts.toolPermissions` 注册表是 v2 没有的结构：守卫/裁决顺序由框架保证而非注册顺序约定；plugin 等动态注册方无法绕过裁决；`ToolPermissionHook` 与 `ToolBeforeHook` 同构但独立命名（「类型名即文档」，第 29 轮②） |
| 批级 preflight 屏障 | 全批 before（批钩子 → per-call beforeTools → toolPermissions）跑完后 `turn.spawn_tools` 才统一 spawn 进入执行；v2 逐 call 各自 before/execute 交错（第 40 轮用户定稿，同日开源对比 codex/opencode/pi/claude-code） |
| 广播确定性 | `setModeAndBroadcast` await 全部 live agents 的 setMode 落账；v2 fire-and-forget（与 plan 域 cancel/exit await 同取向——facade 确定性） |
| 目录组织 | 数据流向四层（state → language → policies → analyzers），barrel 收紧为仅宿主契约（用户选定维度 A，profiles/permission/media 同心智） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `permission.rules` 节字段 | zod 同构（decision 三态/scope 四态默认 'user'/pattern 非空 + parse 校验/reason 可选） | 同 | 已对齐（v2 的 deny/allow/ask 分组 toml 写法与 `tool`+`match` 键转换不迁——人为设计） |
| `permission.dangerousCommandGuard` | 默认 true + env `KIMI_CODE_DANGEROUS_COMMAND_GUARD`（'true'/'false' parse）+ stripEnv | 同 | 已对齐 |
| `defaultPermissionMode` 节 | `z.enum(['manual','auto','yolo'])`，agent 创建时 seed | 无 | 简化（未迁） |
| `KIMI_CODE_PERMISSION_MODE_REMINDER` env | `parseBooleanEnv !== false` 门控 injection | 同语义（remind.ts:27-31；v2 走 bootstrap.getEnv，harness 直读 process.env） | 已对齐 |
| 工厂 props | 无（DI OnScopeCreated） | `createPermission({ interactive?, workDir?, additionalDirs?, homeDir? })`，进 preset（无参） | 人为设计（interactive 承载 nonInteractive；workDir 等承载 workspace 上下文端口化） |
| experimental flag | 无 | 无 | 已对齐 |
| facade 方法面 | mode/setMode/setModeAndBroadcast + `onDidChangeMode` 事件 + rules/sessionApprovalRulePatterns/addRules/recordApprovalResult + gate.data()/authorize() | PermissionRef：`state` Ref + mode/setMode/setModeAndBroadcast/addRules | onDidChangeMode 由 `state` 响应式 Ref 取代（人为设计）；authorize/data 不迁（简化）；recordApprovalResult 内部化 |

## 工具 / 事件 / facade 面差异
- permission 自身不注册工具（v2 同）；它是裁决者。消费侧变化：新架构两阶段下，plan 守卫放行（`event.allow()` 短路）不再存在——plan 文件写入也会进入 permission 裁决（v2 被短路免审），默认 preset（无 workDir）下 manual 模式逐次询问。
- journal 事件：`permission.set_mode` / `permission.rules.add` / `permission.record_approval_result` 三件套同名对齐（载荷去 agentId——decodeAgent 限制，plan/cron 同先例）。durable 差异：v2 仅 set_mode 与 record_approval_result durable、rules.add 不持久；harness 三者均落 journal，运行期 addRules 重启可恢复（强于 v2）。
- Feature 事件：`permission.approval.requested/resolved` 同名；v2 为 observable AgentEvent2 且带 `turnId`、display 为多形态 ToolInputDisplay；harness 为节点事件、无 turnId、display 恒 generic（detail=args）。
- 默认安全白名单 24 项（default-tool-approve）两侧逐字一致；13 条 policy 名称与顺序逐字一致。
- facade 见上节；`PermissionState` 的响应式 `state` Ref 是 v2 没有的读取面。

## 摘要
permission 域是本组中结构偏差最大但行为保真度最高的一域：13 条 policy 链、白名单、危险命令分析器、规则语言、拒绝文案、session 缓存全部逐字对齐，其核心创新是人为设计的 agent-core 内置裁决阶段（`useToolPermission`）——以结构化的「领域守卫先、Permission 殿后」修复 v2 扁平模型的顺序/短路缺陷，属用户 2026-09-29 明确定稿。最重要的三个差异：① 内置阶段本身（含 preflight 屏障与 ask 自理模型）；② 默认 preset 无 workDir 注入导致两条 git policy 与路径 canonicalize 实际失效，manual 模式下写文件审批体验明显弱于 v2；③ mode 广播缺少 v2 的 pinned profile 跳过，会覆盖 tower-worker 的 auto pin（与 Handoff「按 v2 对齐」记录不符）。最需关注的缺口：`defaultPermissionMode` 节与 spawn 创建时 mode 复制未迁（子代理从 manual 起步），加上 preflight 期间 turn abort 的审批悬挂（与 interaction 域同一缺口）。
