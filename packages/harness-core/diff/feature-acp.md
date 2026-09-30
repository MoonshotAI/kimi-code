# feature-acp：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/feature-acp/`（约 3200 行，19 个 ts；测试 `test/feature-acp.test.ts` 35 案）
- agent-core-v2：`packages/acp-server/src/`（约 5585 行，独立包，绑 agent-core-v2 + klient facade；含 `acp-fs/`、`acp-terminal/` 两个子目录与 `start.ts` 组合根）
- 蓝本关系：v2 侧不是 refact-237 第一批 human 蓝本域，而是绑定 v2 引擎的传输层宿主包；harness-core 侧按用户 2026-09-29 决策（Handoff 约束问答「ACP 协议怎么落地」）实现为与 feature-http 平级的**独立传输层 Feature**（`createAcp({streams})`，app tier，不进 preset），语义蓝本为 v2 同名文件，事件接线全新（Handoff「feature-acp 设计要点」）。

缺口清单①–⑦当前状态逐项核对（以代码为准）：

| 缺口 | Handoff 记录 | 代码现状 |
| --- | --- | --- |
| ① skill slash 命令 | 已解决（第 47 轮） | 属实：`slash.ts` 逐字移植 + `session.ts:423-434` 合并面板 + `feature.ts:82-84` `useOnApp('skill.changed')` 广播 |
| ② mcpServers 与 /mcp | /mcp 已解决（第 51 轮）；mcpServers 注入「不实现、记录在案」 | **与 Handoff 记录不符（Handoff 滞后）**：注入已实现——`server.ts:99-135` `connectSessionMcpServers`/`disconnectSessionMcpServers`（会话归属追踪 + close 回收 + 同 cwd 引用计数），测试 1383/1432 两行锁定；`initialize` 按 mcp 挂载条件宣告 `mcpCapabilities`（`server.ts:227`） |
| ③ 图片 prompt part | 已解决（第 39 轮） | 属实：`convert.ts:11-48` 块转换逐字语义，压缩由 media 域 `usePromptGate` 承接 |
| ④ display 富卡片 | 部分解决（第 43 轮 diff/plan 重建，terminal 卡片在案） | diff（Edit 参数派生 + Write 客户端 fs 预读）与 todo plan 已重建；**terminal 卡片已实现**：`OsProcess.external` 由 `AcpTerminalProcess` 填充 terminalId，Bash 工具经既有 `tool.update` 通道转发 `{key:'terminal'}`，feature-acp 进行中卡即嵌 `{type:'terminal'}`、终局卡以嵌入块替代文本输出（精确构造，无 v2 命令串匹配与 `HideOutputMarker`） |
| ⑤ auth_required 细分 | 已解决（第 37 轮） | 属实：`events-map.ts:238-242` `authRequiredMessageOf`（`kind:'auth'`）+ `session.ts:170-174` reject `auth_required`；filtered → `refusal` 已映射 |
| ⑥ max_context_size | 部分解决（第 52 轮③：kimi managed 已映射，generic discover 源残留） | 属实：`session.ts:320-330` 从 `CatalogModelBinding.model.maxContextSize` 取值，取不到则整条 `usage_update` 省略（v2 同语义） |
| ⑦ thinking effort 选择 | 已解决（第 52 轮） | 属实：`model-catalog.ts` 元数据原语投影 + `session.ts:534-565` `setThinking` 校验 + `,thinking` 后缀解析 |

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 包形态与挂载 | 独立包 `acp-server`，`start.ts` 组合根自行 `bootstrap()` 引擎 + 内存 klient + 优雅关闭 drain 序列 | `createAcp({streams})` app tier Feature，不进 preset；生命周期由宿主 `createHarness` 承担（`pushCleanup` 关连接） | Handoff 约束问答末条（2026-09-29 用户：独立传输层 feature、参照 feature-http） |
| 引擎访问面 | 全程经 klient facade（`klient.session(id).agent('main')` RPC + 事件订阅） | 直接消费 `SessionHandle`/`AgentHandle` + Feature facade 可选探测（`tryResolve` TodoRef/UsageRef/TaskRef/CompactionRef/McpRef/SkillRef/SkillCatalogRef/PlanRef/PermissionRef） | Handoff 设计要点；新架构无 klient 层 |
| auth 门语义 | `auth.ensureReady()`（默认模型就绪探针）为主、`auth.summarize()` OAuth 兜底 | `credentialProbe`：`disableAuth` 或 `OAuthTokensRef`/`ConfigRef` 任一 provider 在场（`providerRef` 可选探测） | 第 36 轮②（v2 默认模型探针新架构无对应物，记录在案） |
| cwd 承载 | 引擎 SessionSummary 一等 `cwd` 字段 | `SessionRecord.metadata['cwd']`，session/new 写入、`/status` 与 session/list 同源读取（`server.ts:428-431`） | 第 36 轮①（SessionRecord 无 cwd 字段） |
| 能力宣告 | 恒宣告 `image/embeddedContext`、`mcpCapabilities:{http,sse}`、`delete`、`additionalDirectories`、`auth:{logout}` | 诚实化宣告：`mcpCapabilities` 仅 mcp 挂载时出现（`server.ts:227`）；`delete` 已实现并宣告；不宣告 additionalDirectories/auth.logout（与方法面一致） | 第 36 轮③ + 第 51 轮①（「注入空转下宣告即虚假」） |
| 图片压缩管线 | acp-server 内 `compressPromptImageParts`（边缘压缩 + caption + 原件持久化 + 压缩期 cancel 标记） | 不重复实现，由 media 域 `usePromptGate` intake 承接（media:// ref + caption + 20MB/10MB inline 预算治理，语义更强） | 第 39 轮（media 域落地后用户指示接通） |
| diff/plan 卡片重建路线 | 引擎 `ToolInputDisplay` block（diff/file_io/plan_review 携执行期真实内容） | feature-acp 内派生：Edit 由参数 `{path,old_string,new_string}` 同步派生；Write 经客户端 `fs/read_text_file` 预读 oldText、**终局折叠**进 done 卡；todo plan 经 `TodoRef` 投影 watch | 第 43 轮（用户批准「diff + plan 在 feature-acp 重建、terminal 后做」；终局折叠为该轮定稿） |
| skill 命令接通 | 每会话缓存 skill 摘要 + `skills.changed` 事件刷新 | 每次 `resolveCommands()` 经 `SkillCatalogRef.listInvocableSkills()` 实时取；app 级 `useOnApp('skill.changed')` 向全部 live 会话广播 | 第 47 轮④（目录 app 全局共享，语义等价） |
| v2 host slash commands | `SlashCommandsResolver`（静态/按会话解析宿主命令 + skill 别名映射） | 不迁（新架构无宿主命令概念） | 第 47 轮③ |
| skill 激活失败映射 | `mapPromptLaunchError`：auth 码 → `auth_required`、`turn.agent_busy` → `invalidRequest`、其余 → `internalError('session prompt failed')` | 统一 `internalError('session prompt failed')`；driver 级忙碌仍本地 `invalidRequest(turn.agent_busy)` | 第 47 轮①（SkillRef 抛无码 plain Error，细分不迁） |
| set_model/set_thinking 写入 | `agent.setModel/setThinking` 引擎服务（经 klient RPC） | 裸 `agent.setConfig({...config, model/thinking})` + `agent.setRequester(binding.requester)`；不走 AgentModelRef | 第 52 轮②（alias 不可得 + 受管 watcher 停管自洽 + v2 非持久语义三重依据） |
| thinking 能力判定 | v2 启发式：capabilities 声明 + 名字 `/thinking|reason/i` 匹配 + `TOGGLEABLE_THINKING_MODELS` 硬编码名单（kimi-for-coding/kimi-code） | agent-core 元数据原语（`modelSupportsThinking`/`thinkingMetadataOf`/`defaultThinkingEffortForModel`）；名字匹配与硬编码名单不迁 | 第 52 轮（用户批准以元数据判定取代 v2 启发式——klient 投影丢元数据的代偿） |
| question 响应包装 | 失败/取消 → respond `null`（引擎 ask-user 工具走 `question_dismissed` 分支） | 恒 respond `{answers}` 包装，失败/取消 → `{answers:{}}`（新架构 AskUserQuestion 工具把 response 原样 JSON 化给模型，无 dismissed 分支，取消走 interaction cancellation 通道） | 第 36 轮⑤（`{answers}` 包装为契约）；`features/interaction/tool.ts:151-157` |
| 标题变更通道 | klient `metadata.changed` 事件（过滤 `changed.includes('title')`） | `stores.session.onCommit` 过滤 `session.meta_updated`（每次 meta 提交都推，标题缺席推 null） | 第 36 轮⑧（journal 事件不经 node 事件面） |
| 日志诊断 | 全量 `log.warn/log.error`（推送失败、降级、忽略入参等） | 不迁；一律静默 `.catch(() => {})` | 第 39 轮①（feature-acp 无 log 通道） |
| acp-fs/acp-terminal 接线 | 模块副作用注册 Session 级 `IHostFileSystem` 遮蔽 + App 级 `IAcpConnection` 持有器 + `RuntimeProviderFactory` 注册 per-session Runtime | 导出纯工厂 `createAcpOsHost({connection, local?})`，宿主自行 `createOs({host})` 组合；Feature 不强制接管 | Handoff 设计要点 + 横切约定（host 端口注入）；`os-host.ts:31-39` |
| 终端↔工具卡关联 | `AcpRuntimeProviderFactory` 建终端时 `notifyTerminalCreated` 广播，按 `shellCommand.endsWith(command)` 尾匹配关联 Bash 工具卡；`HideOutputMarker` sentinel 抑制终局卡文本重复（`session.ts:826-848`、`marker.ts`） | 精确构造无匹配：`OsProcess.external`（`kind:'terminal'` + id，`host/types.ts`）由 `AcpTerminalProcess` 填充，Bash 工具 spawn 后经既有 `tool.update` 通道转发 `{key:'terminal'}`（`bash.ts`），feature-acp stash wireId→terminalId——进行中卡即嵌 `{type:'terminal'}`、终局卡以嵌入块替代文本输出/rawOutput（marker 机制不需要） | terminal 卡片轮（定稿方案：C→B 一跳（spawn 返回值）+ 既有 B→A 通道，零 agent-core 改动、零启发式） |
| available_commands 推送时机 | 响应 settle 后 `setTimeout(0)` 推送 | 同（`server.ts:183-187`） | 第 36 轮⑨（语义保留 v2）——已对齐 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| `logout` 方法 | 有：`auth.logout()` 退登 managed provider；宣告 `auth:{logout:{}}` | 无 | 客户端无法经 ACP 触发退登；同上未见记录 |
| `additionalDirectories` | `session/new` 时合并附加工作区根（`sessions.create({additionalDirs})`），load/resume 忽略并告警；宣告能力 | 全部静默忽略，不宣告能力 | 多根工作区客户端能力缺失；Handoff 第 36 轮①称「v2 KLIENT-GAP 同语义」不准确——v2 仅 load/resume 忽略，new 是兑现的 |
| tool 终局 status 语义 | `event.isError`（模型语义错误）→ `failed`——工具执行成功但结果标记错误也显示 failed | 已对齐：live `tool.done` succeeded+`result.isError` → `failed`（`events-map.ts`），与 v2 `event.isError` 语义一致 | A 步已落地（第 76 轮） |
| compaction 生命周期通知 | 订阅 `compaction.started/completed/cancelled/blocked` 四事件推本地 chunk（自动 compact 起止、token 摘要、blocked 提示，`session.ts:882-904`） | 无订阅；只有 `/compact` 命令的即时回执 | 自动触发的 compaction 对 ACP 客户端完全不可见 |
| turn 归属粒度 | 事件自带 `turnId` 精确归属；launch 回合前到达的事件进 `early[]` 缓冲回放 | `turn.started` 追踪 `currentTurnId` + `toolCallTurnIds` 映射（`session.ts:148-158`）；并发外部 turn（cron 等）交叠时无法细分 | 记录在案保真度损失（第 36 轮④）；单 agent 串行 turn 与 v2 等价 |
| cancel 悬挂窗口 | launch 回合兜底：no-launch 即 settle | `prompt.blocked` 兜底；但「prompt 滞留队列且 turn 永不启动」理论窗口仍在；skill activate 被 gate 拦截时 `waitTurnStarted` 不返回 → ACP prompt RPC 悬挂 | 第 36 轮遗留 + 第 47 轮②记录在案（不改 skill 域） |
| usage 口径与文案 | `used` = `agent.getContext().tokenCount`（当前上下文 token 数）；`/usage` 显示 `Context: X / Y tokens (Z%)` | `used` = 末次 usage 记录 input+cache+output 合计（`session.ts:324-329`）；`/usage` 仅 `Context: X tokens` 无 size/百分比（`builtin-commands.ts:122`） | 数值口径近似但不同；`/usage` 文案信息量少一档 |
| 工具卡 title | `event.description ?? event.name`（工具自描述优先） | 恒 `toolCall.name`（agent-core ToolCall 无 description 字段） | 卡片标题信息量少一档 |
| toolCallLocations 回退 | display block（diff/file_io）路径优先，args 路径兜底 | 仅 args 路径（`convert.ts:173-177`） | 无 display 概念，位置信息覆盖略窄 |
| 审批 diff 内容 | 引擎执行期 display block（真实 before/after、行尾归一、含上下文） | 模型请求参数派生片段；`replace_all` 多处替换只显示一处 | 审批/预览展示的是「意图」而非「实际编辑」；第 43 轮①记录在案 |
| replay 细节 | 读 live context memory；tool 消息按 `message.isError` 分 `failed/completed` | 已对齐：replay 按 `entry.meta.isError` 分 `failed/completed`（`replay.ts`）；数据源不同（读 journal `history` 投影）但 compaction 后两侧均为切割后视图，语义基本等价 | A 步已落地（第 76 轮） |
| elicitation 字段描述 | `description: q.body`（问题正文作字段描述） | `description: undefined`——新架构 `QuestionItem` 无 `body` 字段（`features/interaction/tool.ts:19-24`，且 `multi_select` 蛇形命名） | form 模式客户端少一层提示文案；域契约差异非 ACP 自有选择 |
| interaction 初始补扫 | 订阅前 `interactions.list()` 补扫已停放请求 | 仅订 `interaction.requested` 事件，无补扫 | 桥接线前停放的请求不会转发（实际桥随会话激活即建，窗口极小） |
| 未知 skill 激活的 busy 细分 | activateSkill 拒 `turn.agent_busy` → `invalidRequest` | 映射 `internalError('session prompt failed')` | 客户端无法区分「忙碌」与「失败」；第 47 轮①记录在案（分类见人为设计） |
| `escapeXmlAttr` 转义面 | 五字符（`& < > " '`） | 三字符（`& < >`，`convert.ts:50-52`） | resource_link/resource 包装文本含引号时不转义；**Handoff 第 39 轮①称「三转义逐字」，与 v2 五转义不符** |
| `session/list` 字段 | `updatedAt` 真实 ISO 时间、`nextCursor` 透传分页 | 恒 `updatedAt:null`、`nextCursor:null`（`server.ts:323-328`）；空字符串 title 不归一为 null | 列表排序/分页信息缺失 |
| 默认模型兜底绑定 | `wireSession` 时 `bindDefaultModel`：agent 未绑模型则读 `defaultModel` config 绑定 | feature-acp 无此步骤，依赖宿主 feature 组合（kimi/config 域受管绑定） | 未挂受管绑定时 agent 无模型，`currentModelId` 为 `''`、prompt 至 LLM 层才失败 |
| `createAcpOsHost` 会话粒度 | v2 acp-fs 经 `ISessionContext` 每会话解析 sessionId，App 级连接持有器全局共享 | `AcpOsConnection` 绑定**单一** `sessionId`（`os-host.ts:15-21`） | 多会话 ACP 下宿主难以为每会话建独立 OsHost——结构性限制（单会话 stdio 场景无碍） |
| acp-terminal 细节 | 本地/远端 spawn 默认 `cwd` 回落会话 cwd；`kill(signal)` 带信号 | terminal create `cwd: options?.cwd ?? null`；`kill()` 无信号参数 | 边角语义差异，Bash 工具恒显式传 cwd，实际无感 |
| fork 忽略入参提示 | 忽略 `mcpServers`/`additionalDirectories` 时 `log.warn` 明示 | 静默忽略（测试 1432 行锁定 mcpServers 忽略） | 仅诊断差异（log 不迁的连带） |

### 新增 / 更强
| 差异点 | 说明 |
| --- | --- |
| todo plan 投影订阅 | `watch(TodoRef.items)` 对**任何途径**的 todo 变化都推 `plan` 通知（v2 仅 TodoWrite 工具调用的 display 瞬时投影）；挂载时非空 initial 补发一条恢复面板（`session.ts:304-311`；第 43 轮②自评更强） |
| mcpServers 注入的会话治理 | `McpRef.connect(name, config, {cwd})` 按 cwd 作用域控制工具可见性（测试锁定他 cwd 会话不可见该工具 schema）+ 会话关闭自动 `disconnect` + 同 cwd 多会话引用计数防误断（`server.ts:121-135`）；v2 为引擎 ephemeral overlay，harness-core 以 app 全局 manager + ACP 侧归属追踪达到等价会话隔离。**Handoff 第 51 轮记为「不实现、记录在案」，代码已实现，与记录不符** |
| `/status` thinking 显示 | 显示真实 level 字符串（如 `high`），v2 仅布尔 `on/off`（`builtin-commands.ts:102`；第 52 轮③定稿） |
| builtin 命令门控广告 | compact 未挂载不广告、mcp 未挂载不广告（`builtin-commands.ts:56-62`）；v2 恒广告全部 6 条（不可用时回解释性文案） |
| `AcpConnectionRef` 暴露面 | `useExpose` 出 typed client + 客户端 capabilities（`feature.ts:81`），供宿主组合 `createAcpOsHost` 等——v2 对应物为包内 DI 持有器，无对外 facade |
| `setModel` 同步绑 requester | `agent.setRequester(binding.requester)` 一并切换（`session.ts:519-520`）；v2 由引擎模型服务内部解析，harness-core 显式双路绑定更直接 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| 传输流 | `start.ts` 组合根：`input`/`output`（默认 stdio） | `CreateAcpProps.streams` 注入 + `acpStdioStreams()` helper（console 重定向 stderr 对齐） | 已对齐（归属由组合根变为 props） |
| `agentInfo` | `AcpServerOptions.agentInfo` | `AcpHostOptions.agentInfo` | 已对齐 |
| `disableAuth` | 同 | 同 | 已对齐 |
| `terminalAuthEnv` / `terminalAuthLegacyCommand` | 同（authMethods env 传播 + `_meta['terminal-auth']` 回退） | 逐字同（`auth-methods.ts` 与 v2 行为一致） | 已对齐 |
| `slashCommands`（宿主命令 + skill 别名） | `SlashCommandsResolver`（数组/快照/按会话函数） | 无 | 人为设计不迁（第 47 轮③） |
| `resolveOriginalsDir` | prompt 图片原件目录解析 | 无（media 域 `originalsDir` 职责） | 人为设计（第 39 轮，media 域承接） |
| `bindSessionRuntime` / `unbindSessionRuntime` | per-session Runtime 绑定（acp-terminal 执行环境） | 无（宿主 `createOs({host})` 组合替代） | 人为设计（host 端口注入约定） |
| `homeDir` / `configPath` / `extraSeeds` | 引擎 bootstrap 参数 | 无（宿主 createHarness 职责） | 架构归属变化，非缺口 |
| 协议版本协商 | `negotiateVersion`（SUPPORTED_VERSIONS 仅 v1，恒协商到 1） | 恒 `protocolVersion: 1` | 已对齐（实质等价） |
| config 节 / env 绑定 / experimental flag | 两侧均无 | 两侧均无 | 已对齐 |
| 4 模式 taxonomy / `session/set_model` 扩展方法 / `,thinking` 后缀 / thinking allowed 集合校验 | v2 全量 | 逐字对齐（`modes.ts`、`feature.ts:41-57`、`session.ts:511-565`） | 已对齐 |

## 工具 / 事件 / facade 面差异

**ACP 方法面**（agent 侧 JSON-RPC）：v2 多 `logout` 一个方法（见简化表）；其余 initialize / authenticate / session{new,load,resume,fork,list,close,delete,prompt,cancel,set_mode,set_config_option} + 自定义 `session/set_model` 全部对齐（含参数解析与 -32602/-32600/-32000 错误映射）。`session/delete` 走 agent-core `AppCommands.delete`（live 先 close、再 `space.delete` 清持久数据，未知 id → -32602；v2 的 waitUntil 清理钩子与 session 索引墓碑在新架构无对应物，不迁）。

**session/update 通知面**：`agent_message_chunk`/`agent_thought_chunk`/`user_message_chunk`/`tool_call`（含懒建 CREATE→delta→upgrade 全序列）/`tool_call_update`/`plan`/`usage_update`/`session_info_update`/`current_mode_update`/`config_option_update`/`available_commands_update` 全部对齐；`{type:'terminal'}` content 卡片已对齐（机制见人为设计表「终端↔工具卡关联」——进行中卡与终局卡均嵌 terminal，文本输出抑制同 v2）；v2 独有 compaction 本地消息（见简化表）。

**Feature 事件 / facade**：feature-acp 自身无 Feature 事件；facade 面为 `AcpConnectionRef`（client + capabilities，新增）。v2 无对应概念（DI 服务 `IAcpConnection` 为包内持有器）。`stopReason` 映射有一处细微差：v2 把 hook-blocked 的 turn（reason `blocked`）映射 `refusal`，harness-core 的 `prompt.blocked` settle 为 `end_turn`（`session.ts:163`）。

## 摘要
总体对齐程度高：ACP 方法面、事件通知面、approval/question 双桥、replay、set_mode/set_model/thinking、skill 命令面板等主干语义均按 v2 逐字或记录在案的等价路径落地，Handoff 缺口清单①–⑦全部关闭（④ terminal 卡片于 terminal 卡片轮以精确构造方案落地、②⑥代码层面超出 Handoff 原记录），`session/delete` 亦已实现并宣告。最重要的剩余差异：① `logout` 方法连同其能力宣告未迁；② tool 终局 status 与 replay 的 `isError` 语义已随 A 步接通（第 76 轮）；③ 自动 compaction 通知对 ACP 客户端不可见。另需注意 `createAcpOsHost` 单 sessionId 绑定对多会话 ACP 宿主的结构性限制。
