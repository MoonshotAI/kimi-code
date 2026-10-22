# ISessionInitService（sessionInitService）

- v2: `packages/agent-core-v2/src/features/sessionInit/sessionInit.ts`（接口约 12 行；实现 `sessionInitService.ts` 约 120 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/sessionInit/feature.ts`（`SessionInitRef` facade）

## 能力对照

- [x] `generateAgentsMd()`：以 coder profile 起子代理跑初始化 prompt（复用主 agent 模型、同步权限模式），busy/无主 agent/无模型绑定三类报错 → `packages/harness-core/src/features/sessionInit/feature.ts`（`SESSION_INIT_BUSY`/`AGENT_NOT_FOUND`/`SESSION_INIT_FAILED` 与 `INIT_PROFILE_NAME = 'coder'`）
- [x] `cancelInit()` 中断正在运行的初始化 → 同文件（`AbortController` abort）
- [x] 初始化完成后重新加载 AGENTS.md 内容、seed agentsMdReminder 并发完成提醒 → 同文件（`findProjectRoot`/`loadAgentsMdForRoots`/`loadAgentsMdContent` + `reminderFaces.seed` + `loop.remind(initCompletionReminder)`）；init prompt 与完成提醒文案 → `packages/harness-core/src/features/sessionInit/init.ts`、`init.md`
- [x] host 门控：无宿主（host 未注入）时 feature 不激活 → 同文件 `props.host === undefined` 早退（v2 由 OS 宿主服务注入天然门控，语义等价）
- [x] 子代理来源可辨识（v2 labels `sessionInit: agents-md`，新栈 roster `source = 'session-init'`）→ 同文件 `SESSION_INIT_SOURCE`

备注：v2 的 `emitAgentRunSpawned`/`mirrorAgentRun`（把初始化运行镜像为宿主可见的子代理运行卡片）在新栈由 roster source + spawn 域的宿主观测取代，宿主展示接线归属宿主层；初始化结果本身（AGENTS.md 生成 + seed + 提醒）无缺失。

## 结论

全部对齐：host 门控、coder 子代理管线、seed/完成提醒全迁，镜像展示改由 roster source 承载。
