# agentsMdReminder：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/agentsMdReminder/`（约 868 行：service 398 / bash-targets 226 / agents-md-files 137 / git-work-tree 54 / feature 48 / index 5）
- agent-core-v2：`packages/agent-core-v2/src/agent/agentsMdReminder/`（613 行：agentsMdReminderService 377 / bashTargets 226 / agentsMdReminder 10）+ 强关联的 reminder 总线 `src/features/reminder/reminderService.ts`（321 行，不迁）、变更 watcher `src/workspace/workspaceInstructions/workspaceInstructionsService.ts`、AGENTS.md 助手族 `src/agent/profile/context.ts`
- 蓝本关系：v2 DI 版为唯一蓝本（271 第 22 轮迁移）。bash-targets 与 v2 逐字节一致（仅类型改名，diff 验证）；agents-md-files / git-work-tree 是 v2 `agent/profile/context.ts` 助手族在 OsFsPort 上的重写；service 是 DI 服务在 `useAfterTool` + `useBeforeStep` + `agent.remind` 体系下的重实现（v2 的 reminder 总线按用户 2026-09-27 决策不迁）。

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 注入通道 | reminder 总线：`register('agents_md', provider)`，每次 `onWillBeginStep`（排序在 full-compaction 前）由总线调 provider 注入；`lastDisclosure` 随消息 origin 持久化 | 无总线——`useAfterTool` 探测、发现即 `agent.remind`（key `agents-md-reminder`）被动注入，随 mid-turn drain 落账；`disclosed` 每次 beforeStep 从历史同 key 消息解析 `- <path>` 行重建 | 约束问答（2026-09-27）「不实现 reminder 域，各 Feature 直接 agent.remind」；271 第 22 轮设计定稿 |
| 变更检测 | fs watcher：`agentsMdWatchRoots` 计划 + 防抖 `watch()`，`onDidChange` **随时触发**，`reminder.notify` 立即 append 注入消息 | **轮询版**：种子时 `agentsMdWatchCandidates` 快照 mtime 基线，每次 beforeStep 重 stat 对比 created/modified/deleted；announce 文案逐字相同 | 271 第 22 轮用户决策①（轮询版，非跳过；新架构无 fs watch 原语） |
| denied 工具调用 | 不探测（`ctx.outcome !== 'executed'` 早退，agentsMdReminderService.ts:183） | 同样探测（机器层 denied → finishing 与执行成功在 afterTool 不可区分） | 271 第 22 轮用户决策②（只读无害偏差，用户接受并文档化） |
| host 门控 | DI 恒启用（runtime lease `acquire(['fs'])` 取能力） | `props.host === undefined` 时 agent slot 直接返回：不注册钩子、不暴露 facade（roster 仍记 feature 名保持 remount 一致） | 271 第 22 轮同日追加用户决策③「如果 os-host 没有传入，不要 create，而是不加载对应的服务」 |
| 种子来源 | restore 时 `profile.agentsMdPaths ?? extract(systemPrompt)`（onDidRestore 钩子）；ensureSeeded 经 runtime lease 加载 | 挂载时 `inject(AgentPort).getSystemPrompt()` 提取 `<!-- From: -->` 注解 + 首个工具调用惰性链式加载（brand home → `~/.agents` → findGitWorkTree 根→叶链，loadAgentsMdPaths） | 271 第 22 轮设计；偏差⑤「getSystemPrompt() 不含宿主 prompt（freeze 时才合并）——贡献 AGENTS.md 节的 Feature 必须排在挂载顺序之前」已写入 docs |
| facade | `seedInjected(paths, cwd)`（cwd 入 durable-ish state） | `AgentsMdReminderRef.seed(paths)`（workDir 由工厂 props 固定）；供 profiles/sessionInit 调用 | 271 第 22 轮（#12 sessionInit 的种子注入接此 facade，第 35 轮已接） |
| 串行化探测 | 无需——总线在 step 头统一 drain `remindQueue`，天然每步单条 | afterTool 内建串行队列（`queue` promise 链），并行同目录恰 1 条消息 | 271 第 22 轮（编排者抽查确认） |
| 消息元形态 | 注入消息 `origin: { kind:'injection', variant:'agents_md' \| 'agents_md_change' }`，disclosure 结构化存 origin | `agent.remind` 的 `meta.source:'reminder'` + `meta.key:'agents-md-reminder' \| 'agents-md-change'`，disclosed 从消息文本解析 | remind 横切约定（origin 无对应物，以 meta 承载） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 变更 announce 时机 | watcher 随时触发、立即注入（turn 外编辑 AGENTS.md 也即时进下一条请求） | 仅 turn 经过 gating（beforeStep）时轮询；remind 经下一次 mid-turn drain 落账——纯文本 turn（无工具调用）不经 draining，announce 进一步推迟 | 271 第 22 轮偏差⑦（记录在案，机器语义与 dateChange 同源）；变更通知最坏延迟到「带工具调用的下一轮」 |
| 同步骤消息条数 | 总线在 step 头 drain，每步至多 1 条聚合消息 | afterTool 内立即 flush：staggered 同步骤完成可产内容不相交的多条消息（并行同目录仍恰 1 条） | 271 第 22 轮偏差①（契约内已授权） |
| 直读抑制的撤回窗口 | 注入在 step 头发生：同步骤内「先探测入队、后直读」可在注入时被 readRecently 抑制 | remind 在 afterTool 立即发出：直读发生在同步骤 flush 之后无法撤回 | 271 第 22 轮偏差①（契约内已授权） |
| selfKnown 的 isError 判定 | `ctx.result.isError !== true` 才算「已读」（读失败的 AGENTS.md 仍会提醒） | 已切回：afterTool 直读 `result.isError !== true` 判定「已读」（v2 同构），文件现存且非空代理已移除 | A 步已落地（第 76 轮） |
| 工具路径解析 | 用工具侧 resolved `ctx.accesses`（`~` 展开、绝对化后的真实访问路径） | 解析原始 arguments（Read/Edit/Write 取 `file_path`/`path` 双键，Glob/Grep 取 `path`）；`normalizeUserPath` 只做 win32 盘符桥接，`~` 不展开 | 271 第 22 轮偏差④（记录在案）；`~` 路径目标目录探测落空 |
| 遥测 | `agents_md_reminder_shown {turn_id, tool_name, reminded_count, trace_id}`（telemetryFired 去重） | 不迁 | 271 第 22 轮偏差③ + 第 24 轮「遥测不迁」批次待补 |
| 状态载体 | `defineState` 三键（known/cwd/seeded，session 级内存）+ restore 重播钩子 | 模块闭包变量（known/readRecently/flushed/disclosed/seeded），remount 经 mount 种子 + 历史 disclosed 重建 | 语义等价（两侧均非 durable），无实际损失；实现形态差异 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| realpath 别名去重 | 大小写不敏感文件系统（APFS）上 AGENTS.md/agents.md 候选 stat 同一文件会双 announce，轮询按 `realpath` 规范身份去重（service.ts:308,318-321）；v2 无此问题（watcher 事件按实际文件路径）也未有此防护 | 271 第 22 轮偏差⑥ |
| created 检测覆盖不存在路径 | 轮询基线含尚不存在的候选（mtime undefined → 出现即 created）；与 v2 watcher 的 created 语义对齐但实现于无 watch 原语约束下 | 轮询版设计的组成部分 |
| 探测队列容错 | `armWatch`/`ensureSeeded` 失败只重置 promise 不锁死（`watch = undefined` 可重试），probeAndFlush/pollChanges 全路径 try/catch 静默 | 与 v2 的 `catch {}` 容错对齐，失败自愈性略强 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| workDir | `sessionContext.cwd`（会话运行时值，seedInjected 可覆写进 state） | 工厂 props `workDir` 必传（example：`process.cwd()`） | 人为设计（宿主端口） |
| host（fs/environment） | runtime lease `acquire(['fs'])` + `IAgentRuntimeService` | 工厂 props `host?: OsHost`；**缺省不创建、不挂载**（决策③） | 人为设计（host 端口注入横切约定；runtime lease 体系按 os 决策①不迁） |
| brandHome | `bootstrap.homeDir`（KIMI_CODE_HOME） | 工厂 props `brandHome?`，缺省 `join(host.environment.homeDir, '.kimi-code')` | 已对齐（语义等价，注入点不同） |
| Bash 解析 | `IBashParserService`（DI 共享） | 直接依赖 `@moonshot-ai/tree-sitter-bash` 包 `parse`，同 `BASH_PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 }` | 已对齐 |
| config 节 / env 绑定 / flag 门控 | 无 | 无 | 已对齐 |
| 默认启用 | DI Agent 级 `registerScopedService(OnScopeCreated)` 恒在 | 工厂不进 preset，宿主显式挂载（example 已挂，与 createOs 共享同一显式 node host） | 人为设计（工厂形态横切约定） |

## 工具 / 事件 / facade 面差异
- 无 agent 工具（两侧一致）。
- 无 Feature 事件（两侧一致；v2 的注入/变更经 reminder 总线消息呈现，harness-core 经 `agent.remind` 回执与 history 呈现）。
- facade：v2 `IAgentAgentsMdReminderService.seedInjected(paths, cwd)`；harness-core `AgentsMdReminderRef.seed(paths)`（cwd 由 props workDir 固定承担）。
- 文案：discovery（"The following AGENTS.md file(s) apply to paths accessed by your recent tool call…"）与 change（"The AGENTS.md instruction file(s) below changed on disk…" + `(deleted)` 后缀）两侧逐字一致；探测目标提取（Read/Edit/Write 文件参数目录、Glob/Grep path 目录、Bash 经 tree-sitter-bash 提取列目录命令目标 + 显式 cwd 恒探测 + 解析失败 cwd 兜底 + win32 路径桥接）逐字一致；probeDir 的根→叶链与 `.kimi-code/AGENTS.md` 优先规则一致。

## 摘要
总体对齐程度高：发现探测的工具面/文案/链式加载/去重语义与 v2 基本同构，bash-targets 逐字节一致，两个核心提醒文案逐字一致，且有 realpath 去重这一超出 v2 的防护。最重要的三个差异：① 注入从 reminder 总线改为 `agent.remind` 被动注入（用户 2026-09-27 的全局决策），带来同步骤多条消息与直读抑制不可撤回两个记录在案的偏差；② 变更检测从 fs watcher 改为轮询（用户决策①），announce 时机从「随时」退化为「turn 经过 gating 时 + 下一次 drain」；③ denied 调用也探测（用户决策②，selfKnown 的 isError 判定已随 A 步切回 v2 同构）。最需关注的缺口：遥测 `agents_md_reminder_shown` 待 telemetry 批次补回，以及 `~` 路径不展开导致的探测落空是否在真实使用中可见。
