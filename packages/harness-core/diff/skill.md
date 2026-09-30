# skill：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/skill/`（ts 约 2009 行；含 10 份 md 共约 2914 行）
- agent-core-v2：`packages/agent-core-v2/src/features/skill/`（ts 约 2925 行；含 9 份 builtin md 共约 3830 行）
- 蓝本关系：v2 现行实现为蓝本（非 refact-237 第一批 human 蓝本）——catalog 六件（types/parser/registry/roots/discovery(IHostFileSystem 版，node:fs 版不迁)）+ prompt + 工具契约逐字；分层从 v2 的 App/Workspace/Session 三级 DI Service 收敛为新架构 app+agent 双 slot 的 `createSkill` 工厂（Handoff 第 45 轮）。plugin 来源经 `useSkillSource` 贡献点由 `features/plugin/contribute/skills.ts` 接入（第 46 轮）。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 目录监视（fs watch） | user 源监视 `~/.kimi-code/skills` 与 `~/.agents/skills`、workspace 源监视 projectRoot 子树，200ms 防抖触发自动 reload（`userFileSkillSource.ts:71-97`、`rootFileSkillSource.ts:80-112`） | 不监视；改动需经 `SkillCatalogRef.reload()` 显式触发（`feature.ts:315-319`） | Handoff 第 45 轮决定②（profiles 第 19 轮用户批准先例） |
| Skills 块注入点 | `profileService.resolveSkillListing()` 取 listing，作为 `skills_section` 变量渲染进 profile 系统 prompt 模板，且按 `isToolActiveForProfile(profile,'Skill')` 门控（`profileService.ts:879-889`、`profile-shared.ts:162-164`） | feature agent slot 用 `useSystemPrompt({id:'skill-listing'})` 统一注入完整 `# Skills` 块（prose + DISREGARD listing），挂载即冻结；不做工具激活门控（`feature.ts:328-331`） | Handoff 第 45 轮决定①（编排者定稿统一注入点，回退 spawn/swarm 双注入）；冻结语义两侧一致（v2 `frozenSkillListing`） |
| 分层与 Service 形态 | App 级 `WorkspaceSkillCatalogService`（聚合 6 个 DI source）→ Session 级 `SessionSkillCatalogService`（base catalog + session 贡献 remerge）→ Agent 级 `AgentSkillService` | app slot 单点聚合 `SkillSources` collection（`feature.ts:159-321`），agent slot 直接 inject `SkillCatalogRef`；无 session 级 catalog | Handoff 第 45 轮（createSkill app+agent 双层工厂） |
| 会话级 skill 贡献口 | `ISkillCatalogSink.set/remove` 支持运行时向 session catalog 增删贡献（`session/skillCatalog.ts:18-23`） | 不迁；会话级贡献由 `useSkillSource` 晚注册响应式并入承担（唯一消费方 plugin session-start 已改走该通道） | Handoff 第 45 轮决定③ |
| builtin 注册方式 | 模块级全局可变注册表 `registerBuiltinSkill/getBuiltinSkillContributions`（`catalog/builtin/registry.ts`），`visibleBuiltinSkills` 合并 `BUILTIN_SKILLS` 与贡献表 | 收敛为静态 `BUILTIN_SKILLS` 数组（`builtin/definitions.ts:81-87`），无注册表 | Handoff 第 45 轮决定④（grep 证实注册表唯一消费方） |
| activate 忙碌语义 | 忙碌时先把内容以 `steerIfActive` steer 进运行中 turn，随后仍抛 `Cannot activate skill while another turn is active`（`skillService.ts:258-267`、57-107） | 忙碌时先抛同名错误，内容不投递（`feature.ts:435-437`） | Handoff 第 45 轮决定⑥（按编排者契约抛错，v2 steer 行为差异在案） |
| discovery 实现 | 两份并存：`fileSkillDiscovery.ts`（node:fs）与 `runtimeSkillDiscovery.ts`（IHostFileSystem 端口），另有 `InMemorySkillDiscovery` DI 默认实现 | 仅一份 `catalog/discovery.ts`，走 `OsFsPort`（host.fs 端口）；host 未注入则四个文件源不注册（`feature.ts:186-203`） | Handoff 第 45 轮（双份收敛为一份，rg 第 18 轮先例）；host 门控为横切约定 |
| `withInitialQueryDepth` | `SkillTool.withInitialQueryDepth` 克隆 API（`tools/skillTool.ts:50-54`） | 不迁（全仓 grep 无生产消费方） | Handoff 第 45 轮决定⑤ |
| Skill 工具参数解析 | zod schema + 框架校验（`SkillToolInputSchema`，非法参数走框架错误通道） | 手写容错解析，非法输入回文本 `invalid Skill arguments: <raw>`（`tool.ts:93-107`） | Handoff 第 45 轮（wait-for/edit 先例） |
| `skill.activated` 事件载荷 | `SkillActivatedPayload` 含 agentId，经 `AgentEvent2` dispatcher（`skillOps.ts:15-18`） | Feature 事件 `skill.activated` 含 agentId（`feature.ts:77-86`）；另新增 `skill.changed` 事件 | Handoff 第 45 轮（编排者复验补 agentId）；`skill.changed` 替代 v2 的 `onDidChange` emitter |
| explicit 目录来源 | `bootstrap.args.skillDirs`（CLI 参数），priority=user(20)、扫描 source 记 'user'、存在时置换 user+workspace 两源 | `props.explicitDirs`，priority/置换语义逐字（`feature.ts:195-202`、`sources/files.ts:48-109`） | Handoff 第 45 轮决定⑪（v2 逐字，宿主概念走 props） |
| 启动竞态处理 | source 内 `await config.ready` 后读配置（如 `userFileSkillSource.ts:63`） | `loadAll` 先 `configEntries.at(-1).reload()` 再按序加载，`enqueue` 串行 + `trackReady`（`feature.ts:239-244、273-279`） | Handoff 第 45 轮决定⑩（v2 `await config.ready` 的新架构等价） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| 工具结果 isError 通道 | 守卫失败回 `errorResult`（`isError: true, output`，`tools/skillTool.ts:134-136`）；`NestedSkillTooDeepError` 为带 `SKILL_NESTED_TOO_DEEP` 错误码的 Error2 | 守卫失败回 `isError: true` 结果（`errorResult`），框架统一渲染；`NestedSkillTooDeepError` 为普通 Error（`tool.ts:21-34`，无错误码差异保留） | A 步已落地（第 76 轮） |
| 遥测 | `skill_invoked`（含 trigger）与 `flow_invoked`（skillType==='flow'）两条 track2（`skillService.ts:276-286`） | 不迁 | 已知批次待补（Handoff 第 45 轮决定⑧，telemetry 域统一收口） |
| promptMetadata 更新 | main agent activate/promptWithSkills 后写会话 prompt metadata（`/<name> <args>` 文本，`skillService.ts:112-121、138-147`） | 不迁（sessionTitle 直读 history） | Handoff 第 45 轮决定⑫；如有 kap-server 等价消费方需另行立项 |
| Skill 工具审批/展示元数据 | `resolveExecution` 提供 `description`/`display:{kind:'skill_call',skill_name,args}`/`approvalRule`/`matchesRule`（glob 匹配 skill 名，`tools/skillTool.ts:40-48`） | ToolDefinition 仅 name/description/parameters/execute；permission 域按工具名维护参数匹配器 | v2 `execution.display` 横切不迁（permission 设计要点）；skill 名 glob 匹配规则需 permission 域补登 |
| experimental flag 判定 | `IFlagService.enabled(flag)`（per-flag env > `[experimental]` config > master env > default） | 仅 env：`KIMI_CODE_EXPERIMENTAL_<FLAG>` 或 `KIMI_CODE_EXPERIMENTAL_FLAG`（`sources/builtin.ts:45-55`） | 当前两侧均无带 `experimentalFlag` 的 builtin skill，无可观察影响；flag 体系未迁的连带损失 |
| os 工具读 skill 根目录授权 | Read（强制）/Glob/Edit/Write/ReadMediaFile 把 `catalog.getSkillRoots()` 并入 additionalDirs（如 `readTool.ts:205`） | os 工具仅读 `props.additionalDirs`，无 SkillCatalogRef 消费（`features/os` 全目录 grep 无引用） | `SkillCatalogFace.roots()` 已暴露但仓内无消费方；归属 os 域接线，Handoff 未在案 |
| session 级贡献的 remerge 基座 | session catalog 以 workspace catalog 快照为 base 再叠加会话贡献（`session/skillCatalogService.ts:95-108`） | 单层合并，无 base/overlay 两级 | 随决定③一并放弃；无已知消费方受损 |

### 新增 / 更强
| 差异点 | 说明 |
| --- | --- |
| `SkillSources` collection + `useSkillSource` 贡献钩子 | 任意 feature/宿主可注册新来源（id+priority+load+可选 onDidChange），晚注册响应式触发全量 reload 并 fire `skill.changed`（`sources/source.ts:29-44`、`feature.ts:285-291`）；v2 的 source 集是 DI 固定六元组 |
| `skill.changed` Feature 事件 | 来源级变更广播（reload/config watch/onDidChange 均触发），feature-acp 的 available_commands_update 重推即消费此事件（第 47 轮）；v2 仅服务内 emitter |
| `SkillCatalogFace` facade | ready/list/get/renderSkillPrompt/getModelSkillListing/getKimiSkillsDescription/listInvocableSkills/roots/skipped/reload 统一 expose（`feature.ts:95-110`），跨 tier inject 可达；v2 需按 scope 分别注入三个服务 |
| `SkillRef.promptWithSkills` 返回 turnId 等待 | 非忙碌时等待 `turn.started`（按 queueItemId 匹配）返回 `{turnId}`（`feature.ts:426-429、444-468`）；v2 返回 prompt_id/created_at/state 三态 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| `extraSkillDirs` 节 | zod `string[].optional()`，default `[]`；变更经 config.onDidSectionChange 触发 extra 源 reload | zod `array(string)`，default `[]`；computed+watch 触发 `reloadSources(['extra'])`（`sources/files.ts:15-21`、`feature.ts:297-299`） | 已对齐 |
| `mergeAllAvailableSkills` 节 | zod `boolean.optional()`，default `true`；变更触发 user+workspace 源 reload | 同语义（`sources/files.ts:23-29`、`feature.ts:292-296`）；brand 组单元素下 false 无可观察效果，语义保留并测试锁定 | 已对齐（Handoff 第 45 轮决定⑨） |
| `builtinProductSkills` 节 + env | default `true`，env `KIMI_CODE_BUILTIN_PRODUCT_SKILLS` + `stripEnv`（`catalog/configSection.ts:28-54`） | 逐字（`sources/builtin.ts:14-43`） | 已对齐 |
| 工厂 props | `bootstrap.args.skillDirs`、DI 注入（homeDir/osHomeDir/workDir 来自 bootstrap/workspace 服务） | `createSkill({ workDir, fs?, home?, explicitDirs?, sources? })`；`home` 缺省 `KIMI_CODE_HOME` env（不经 `host.environment`，解析不出则不注册 user source）；外部来源经 `sources`/`useSkillSource` | 人为设计（宿主概念走 props + 外部 source 贡献，Handoff 第 45 轮；fs/home/sources 形态为后续修订） |
| experimental flag 环境变量 | `KIMI_CODE_EXPERIMENTAL_<FLAG>` / `KIMI_CODE_EXPERIMENTAL_FLAG` + `[experimental]` config 节（IFlagService） | 仅两个 env（`sources/builtin.ts:45-55`） | 简化（当前无可观察影响） |
| 目录监视开关 | 无配置；恒开（200ms 防抖） | 无（不监视） | 简化（决定②） |

## 工具 / 事件 / facade 面差异
- **Skill 工具**：名称 `Skill`、description md（两侧 `skill.md` 逐字节一致）、参数 schema（`skill` 必填 + `args` 可选，describe 文案逐字）、三条守卫文案（not found / disableModelInvocation / 非 inline `cannot be invoked by the model in v1`）、输出 `Skill "<name>" loaded inline. Follow its instructions.`、`MAX_SKILL_QUERY_DEPTH=3` 全部对齐。差异：v2 `ExecutableToolResult` 走 `delivery:{kind:'steer',message}` 投递 skill-loaded 消息 + isError 通道；harness-core 直接 `agent.submit(message, {origin})` + 纯文本结果。v2 的审批规则/展示元数据（`display.skill_call`、`matchesRule` glob）未迁。
- **facade**：v2 `IAgentSkillService.activate/promptWithSkills/recordModelToolActivation` ↔ harness-core `SkillRef.activate/promptWithSkills`（model tool 激活记录内化为工具路径直发事件）；v2 返回 `PromptLaunchResult{turn_id}` / `PromptWithSkillsResult{turn_id?,prompt_id,created_at,state}` ↔ harness-core 返回 `{turnId?}`。`SkillActivationInput` 在 harness-core 丢失 `attachments` 字段（promptWithSkills 的 attachments 保留在 `BundledSkillPromptOrigin`）。
- **事件**：`skill.activated`（载荷同 v2 `SkillActivatedPayload`，含 agentId）对齐；`skill.changed` 为新增（替代 onDidChange）。
- **catalog 面**：`getSkill/getPluginSkill/renderSkillPrompt/listSkills/listInvocableSkills/getSkillRoots/getSkippedByPolicy/getModelSkillListing/getKimiSkillsDescription` 全部对齐（registry.ts 两函数体 diff 仅 lint 机械偏离）；`InMemorySkillCatalog.registerBuiltinSkill` 保留但无消费方。

## 摘要
skill 域是高保真迁移：catalog 六件、prompt 渲染、参数展开（$NAME/$1/$ARGUMENTS/${KIMI_SKILL_DIR}/${KIMI_SESSION_ID}）、工具契约与文案、优先级合并（builtin 0/plugin 5/extra 10/user 20/workspace 30）、三节配置与 env 绑定、9 份 builtin 技能（md 逐字节 + 定义逐语义，含 5 份 productSpecific 门控）均逐字对齐，source 体系还经 collection 贡献点变得比 v2 更开放（plugin 来源已就此接通）。最重要的三个差异：① 目录监视不迁、改为显式 `reload()`（在案决定）；② Skills 块注入点从 profileService 模板变量改为 feature `useSystemPrompt` 统一注入、失去「Skill 工具未激活则不注入」的门控（在案决定，冻结语义一致）；③ activate 忙碌时 v2 实为先 steer 进运行中 turn 再抛错、harness-core 直接抛错不投递（在案决定）。最需关注的缺口：os 工具把 skill 根目录并入可访问范围的 v2 授权链路在 harness-core 无消费方；遥测（skill_invoked/flow_invoked）待批次补回。
