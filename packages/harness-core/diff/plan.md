# plan：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/plan/`（772 行 ts + 9 个 md：feature.ts 150 / guard.ts 99 / review.ts 83 / injection.ts 139 / projection.ts 53 / storage.ts 27 / configSection.ts 11 / tools 两文件 201 / index.ts 9）
- agent-core-v2：`src/features/plan/`（1219 行含 md：planService.ts 279 / exitPlanModeReview.ts 175 / planModeInjection.ts 106 / planOps.ts 110 / 两工具目录 383 / plan.ts 23 / planFeature.ts 29 / configSection.ts 13 / profile/plan.ts 40 / 7 个 reminder md 61）
- 蓝本关系：v2 DI 版 `features/plan` 为规格蓝本（feat-271 第 15 轮迁移，不属 refact-237 第一批）；9 个 md（7 reminder + 2 工具描述）经 cmp 验证逐字节一致。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 审批通道：permission 管线 → interaction | `planService.guardToolExecution` 挂 `toolExecutor.onBeforeExecuteTool`，ExitPlanMode 时 `event.waitUntil` 触发 `ExitPlanModeReview.requestApproval` → `toolApproval.requestToolApproval`（kind:'ask'，与 permission 同一审批管线，exitPlanModeReview.ts:26-46） | 守卫（`useBeforeTool`，plan 自有特性）直接 `interactions.request({kind:'approval', payload:{plan, path, options?}})`，五分支在 `review.ts` 内自给自足（guard.ts:29-53） | feat-271 约束问答 plan 条（用户 2026-09-29）：「审批走已有 interaction；工具拦截走 useBeforeTool——工具拦截是 plan 自身的特性，不是一种 Permission」 |
| auto 免审旁路 | planService 守卫在 `mode==='auto'` 时不挂 waitUntil，工具 execute 内走 `formatAutoApprovedPlanForOutput` 分支（exitPlanModeTool.ts:88-96） | 第 15 轮按用户决定不做（总走 interaction 审批）；第 29 轮随 permission 域落地接线：guard 读 `PermissionRef`（可选探测，缺席照常审批），`mode()==='auto'` 时 `exit()` + 以 denied 通道返回 auto-approved 文案（guard.ts:35-41），`formatAutoApprovedPlanForOutput` 与 v2 逐字一致（review.ts:68-71） | 约束问答 plan 条「permission 域落地时再接旁路」+ 设计要点「plan 旁路本轮接……recordRevision 与否以 v2 蓝本为准」（两侧均在审批前 recordRevision） |
| plan 文件存储 | 写死 `<sessionDir>/agents/<agentId>/plans/<planId>.md`（IHostFileSystem，planService.ts:238-240） | props 端口注入 `createPlan({ storage })`（`readText/writeText/pathFor`，pathFor 决定提示与守卫的展示路径）；缺省 `createMemoryPlanStorage()`（Map 内存） | 设计要点②：sessionDir 不对 Feature 暴露，对齐 `createConfig({persist})`/`createMedia(deps)` 范式 |
| 状态与 undo | `planKey` defineState（replayable + `.undoable()`），事件 PlanModeEnter/Cancel/Exit/PlanRevision（durable；revision 另 observable）；undo 经 v2 undoable state 机制切割 | agent journal 自有事件 `plan_mode.enter/cancel/exit/plan.revision` + fold 投影（projection.ts）；undo 语义随 agent.switched 分支切换自然成立 | 设计要点①（todo 范本）；v2 的 `AgentStatusUpdated{planMode}` 镜像不迁（kap-server 状态面，undo 第 34 轮先例） |
| reminder 机制 | reminder 总线：注册 variant `'plan_mode'` 回调，步头主动注入，`lastInjectedAt` 历史索引驱动去重窗口（planModeInjection.ts:60-80） | `useBeforeStep` + `agent.remind` 同 key（`plan-mode`）被动注入、drain 落账；增量计数器（跳过自家 reminder、user→full / ≥5→full / ≥2→sparse）+ `inFlightFrom/queued` 防写链滞后（injection.ts:29-104） | 约束问答 reminder 条（不实现 reminder 域）+ 第 15 轮偏差⑤（语义等价 v2 lastInjectedAt 窗口且对写链滞后免疫） |
| wasActive 持久化 | 独立 durable state `planWasActiveKey`（planModeInjection.ts:21） | 投影从 `message.appended`（meta.source='reminder' 且 key='plan-mode'，比对是否 exit 文案）推断 + 挂载内闭包镜像（projection.ts:45-50、injection.ts:29） | 第 15 轮偏差④（防 journal 写链滞后，dateChange 范本） |
| plan id | `generateHeroSlug(randomUUID(), new Set())`（英雄 slug） | `randomUUID()`（feature.ts:78） | 第 15 轮偏差⑧（v2 generateHeroSlug 不可用） |
| cancel/exit 落账 | fire-and-forget（`void dispatcher.dispatch`，planService.ts:183-197） | `await store.dispatch`（facade 确定性；投影消费方观察一致） | 第 15 轮偏差⑥（行为不变） |
| revision blob 存储 | `blobs.put(scope, key, bytes)` scope+key 命名存储，sha256 另算进事件 | `blobs.put(bytes)` 内容寻址（sha256 即 blob ref），事件载荷仍写 `key: plan/<id>/v<N>.md` + sha256/bytes（feature.ts:100-115） | 第 15 轮偏差③ |
| config 节注册位置 | 全局 `registerConfigSection`（import 副作用） | app slot `useConfigSection`（agent slot 之前；config 缺席时 contribute 无害） | 第 15 轮偏差⑨（宿主可能在首个 agent 前读 defaultPlanMode） |
| 参数校验位置 | zod schema（strict、min/max、refine、逐字段 describe）框架层校验 | 手写 JSON schema（describe 文案逐字保留）；`parseExitPlanModeArgs` 在 execute/guard 内容错解析，错误文案如 `Invalid options: provide 1 to 3 options.`（exit-plan-mode.ts:23-57） | 新架构无框架级 zod 校验，各工具自理解析（wait-for/edit 先例） |
| Service 层 | AgentPlanService（DI Service） | 无 service.ts——全部逻辑内联 feature.ts setup 作用域，消费方改结构参数分片 | 第 29 轮（用户裁定「plan 和 cron 都要摊平」，task 先例） |
| `profile/plan.ts` | plan 子代理 profile 随域注册 | 不随本域；profiles 域（第 19 轮）`builtin.ts` 已含 agent/coder/explore/plan 四静态 profile（文案逐字） | 设计要点⑩（归属 profiles 域 #26） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| Reject and Exit / 默认 reject 的 isError + stopTurn | `{isError:true, stopTurn:true, output:'Plan rejected by user. Plan mode deactivated.'}`（exit）与 `'...remains active.'`（留 mode），turn 以用户拒绝收场（exitPlanModeReview.ts:96-129） | 两通道现已具备（stopTurn 第 66 轮已落地、isError 第 76 轮已落地）；plan review 仍降级为 denied 文案，接线（恢复 v2 五分支的 isError+stopTurn 形态）待用户定夺 | 第 15 轮偏差①记录在案；第 31 轮 `useAfterStep`+stopTurn 通道已落地 agent-core；第 66 轮 stopTurn、第 76 轮 isError 相继落地，plan 接线未做 |
| 守卫路径判定精度 | 读 `execution.accesses`（工具 resolveExecution 解析后的绝对路径 file accesses），与 plan.path（绝对）精确比较（planService.ts:259-270） | 读原始 arguments 的 `file_path`（优先）/`path`（兜底）双键，与 `storage.pathFor` 输出做精确字符串相等（guard.ts:86-99） | 第 15 轮偏差②：相对路径/`./` 变体/符号链接不等价——以不同路径形式写 plan 文件会被误拒；遗留「待 os 工具组落地收敛」，os 已落地但 guard 仍未改（沿用双键，第 18 轮④保留不收敛） |
| plan 文件写入的审批 | plan guard `event.allow()` 短路全部后续监听器（含 permissionGate）——写 plan 文件永不触发审批（beforeToolExecuteEvent.ts:106-109） | guard 返回 undefined 仅过本守卫，permission 阶段照常裁决：manual 模式下 Write/Edit 写 plan 文件落入 fallback-ask 会询问（有 workDir + posix + git repo 时 git-cwd-write-approve 放行；approve-for-session 一次后按规则放行） | 两阶段内置是刻意安全不变量（约束问答 permission 条），此项为其对 plan 体验的回退副作用；无专门待办 |
| 遥测 | `plan_submitted`（has_options）/ `plan_resolved`（approved/auto_approved/dismissed/rejected_and_exited/revise/rejected + chosen_option）/ `plan_enter_resolved` | 无 | 遥测不迁批次，待云端 appender 落地后统一补回（设计要点⑨） |
| wasActive 对历史存续的依赖 | durable state 与历史消息无关 | wasActive 由 journal 中 reminder 消息推断——compaction/分支切割若移除 reminder 条目，remount 后 wasActive 回落 false 会重注入 full/reentry reminder | 投影推断方案的固有边界（偏差④方案的代价）；未实证，记录在案 |
| 防御性错误分支 | execute 含 `Failed to read plan file:`（读盘非 ENOENT 失败）与 `Failed to exit plan mode:` 两分支 | status() 非 ENOENT 错误直接上抛走 tool failed；exit 是本地 dispatch 不会失败 | 防御分支简化，无实际影响 |
| 无 fs 版 PlanStorage 实现 | 存储由框架经 IHostFileSystem 落到 sessionDir，任何宿主开箱即用 | 包内只有 `createMemoryPlanStorage`——preset/example 默认内存存储下，模型按提示用 Write 写展示路径不会进内存存储，ExitPlanMode 将报「No plan file found」 | 默认挂载下 Write→ExitPlanMode 闭环不可用；宿主需自实现 fs 端口（v2 enter 的 `ensurePlanDirectory` 目录创建职责也随之移交端口实现者） |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| 审批 interaction 契约 | payload `{plan, path, options?}`（≥2 才带 options）+ tags（sessionId/agentId/toolCallId），feature-acp 据此展开 plan_review 选项（plan_opt_N/Revise/Reject and Exit，attachSelectedLabel 回传 selectedLabel）——v2 需经 kap-server/klient 投影层才有同等展示，harness 传输层直接消费（第 36 轮⑥、第 43 轮） |
| facade 带状态 Ref | `PlanFace.state: Ref<PlanState>`（含 active/id/revisionCount/wasActive）响应式可读；v2 需另经 IAgentStateService 取 planKey |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| `defaultPlanMode` 节 | `z.boolean().optional()`，默认 false；自动进入的消费方在宿主层 | `z.boolean()`，默认 false，app slot 注册；消费方同样在宿主层 | 已对齐 |
| env | 无 | 无 | 已对齐 |
| 工厂 props | 无（registerFeature 默认启用集） | `createPlan({ storage? })`，进 preset（`createPlan()` 无参，即内存存储） | 人为设计（存储端口化） |
| experimental flag | 无 | 无 | 已对齐 |
| facade 方法面 | IAgentPlanService：enter/cancel/clear/exit/recordRevision/status | PlanRef：同六方法 + `state` Ref；enter 默认 id 为 randomUUID（v2 为 hero slug） | 已对齐（id 生成为人为设计差异） |

## 工具 / 事件 / facade 面差异
- 工具清单一致：`EnterPlanMode`（空参数；重复进入与 workflow 两版文案逐字）+ `ExitPlanMode`（options 1-3 个、label 1-80 字符、唯一/保留标签校验规则一致；非 active / 空 plan 报错文案逐字——harness 的「No plan file found」恒带 path，v2 另有无 path 变体但同样实际不可达）。差异仅在错误通道（v2 isError vs harness 纯文本）与校验位置（框架 zod vs execute 内容错）。
- journal 事件同名对齐：`plan_mode.enter/cancel/exit/plan.revision`（v2 为 durable AgentEvent2 且 revision observable；harness 为 fold 投影数据源，无 observable 镜像、无 `AgentStatusUpdated{planMode}`）。
- 无 Feature 事件面（v2 同，均无 plan.* 节点事件）。
- facade 见上节；守卫（`useBeforeTool`）与注入（`useBeforeStep`）为 agent slot 内部接线，不进 facade。

## 摘要
plan 域对齐程度高：9 个 md 逐字节、五分支审批文案逐字、守卫文案逐字、reminder 四变体与 2/5 去重窗口语义等价、状态事件同名。结构上的两个人为设计是「审批走 interaction 而非 permission 管线」（用户 2026-09-29 定）与「存储端口注入」（sessionDir 不暴露）；auto 免审旁路已按既定计划在 permission 域落地时接线（guard 读 PermissionRef，缺席照常审批）。最重要的三个差异：① Reject and Exit / 默认 reject 丢失 isError+stopTurn（turn 不再以拒绝收场，stopTurn 通道第 31 轮已备但 plan 未接线）；② 守卫路径判定从 resolved 绝对路径降级为原始参数双键精确匹配（遗留未收敛）；③ 两阶段裁决下写 plan 文件会进入 permission 审批（v2 被 `event.allow()` 短路），默认 preset（无 workDir）下 manual 模式逐次询问。最需关注的缺口：包内无 fs 版 PlanStorage，默认内存存储下 Write→ExitPlanMode 闭环不可用，需宿主注入。
