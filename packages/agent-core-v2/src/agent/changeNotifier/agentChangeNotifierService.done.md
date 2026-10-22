# IAgentChangeNotifierService（agentChangeNotifierService）

- v2: `packages/agent-core-v2/src/agent/changeNotifier/changeNotifier.ts`（约 30 行，读 interface 与 changeNotifierService.ts 得出）
- 新架构: 不统一构建——通知按域各自实施：AGENTS.md → `packages/harness-core/src/features/agentsMdReminder/feature.ts`；技能清单 → `packages/harness-core/src/todo-features/skill/feature.ts`；子代理目录 → `packages/harness-core/src/todo-features/spawn/feature.ts`（目录与变更事件归 `packages/harness-core/src/todo-features/profiles/`）

## 能力对照

- [x] AGENTS.md 磁盘变化（新增/修改/删除）后给模型发提醒 → `packages/harness-core/src/features/agentsMdReminder/feature.ts`（初始披露、发现、变化三类提醒均经 `loop.remind`）
- [x] 技能目录变化后向模型推送新清单（notifySkillChanges）→ `packages/harness-core/src/todo-features/skill/feature.ts`：`SkillCatalogFace.onDidChange` 订阅目录变化（app slot 在 fire `skill.changed` 的四处同步通知），agent slot 以挂载时写入 system prompt section 的清单为基线 diff，变化经 `loop.remind` 推送（key `skill-listing-change`，文案与 v2 `skillsChangeText` 逐字一致，含空清单分支）；仅 main agent，与 v2 相同。v2 的 toolActiveForBoundProfile 门控不迁（新栈无工具政策组合面，feature 挂载即 Skill 工具在场）
- [x] 子代理 profile 变化提醒（notifySubagentChanges 的 profile 增删部分）→ `packages/harness-core/src/todo-features/spawn/feature.ts`：`props.catalog` 缺席时回落 profiles 域的 `ProfileCatalogRef`（Agent 工具 description 本就按活目录逐请求渲染），经 `ProfileCatalogFace.onDidChange` 对可见 profile 集做 diff 后 `loop.remind`（key `subagent-profile-change`；可见集口径与工具 description 同源 `visibleSpawnProfiles`；仅 main agent，与 v2 相同）；swarm 同一行回落共享目录、不重复提醒（提醒归 spawn 单一持有）。模型池/defaultModel 运行期 diff 不迁：新栈模型池是宿主静态 props（`createSpawn({ models })`），无运行时变化源，重启后工具 description 自然重渲
- [x] seedBeliefs（"模型已信"基线）→ 各域内存自持，无统一 seed API：AGENTS.md 有 `AgentsMdReminderRef.seed`；技能基线 = agent slot 挂载时写进 system prompt section 的清单（ready 后经同一 check 补齐竞态）；子代理基线 = 挂载时可见 profile 集（ready 后静默重置，对齐 v2 `legacySubagentBaseline` 语义）。v2 的跨重启快照（changeNotifierSnapshotKey）不迁：新栈 resume 重挂 agent 时 system prompt section 与工具 description 都按当前目录重渲，基线随挂载自然等于模型所见，无跨重启 diff 对象
- [x] mute/unmute 临时静默 — v2 侧已无调用方（休眠 API），按记录在案不迁

## 结论

全部对齐——按「各域实施、不统一构建」定稿：三类变化提醒分落 agentsMdReminder / skill / spawn（profiles 域出目录与变更事件），基线各域内存自持。与 v2 的既定差异：① 模型池/defaultModel 运行期 diff 无数据源不迁；② v2 的 toolActiveForBoundProfile 门控不迁；③ 子代理提醒文本头为「The available subagent profiles changed:」（v2 含 models，因 v2 同时 diff 模型池），profile 增删行与尾行逐字一致；④ 簿记为内存态，跨重启快照不迁（重挂载即重渲，无 diff 对象）。
