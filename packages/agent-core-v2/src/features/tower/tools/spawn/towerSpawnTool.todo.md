# ITowerSpawnTool（towerSpawnTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/spawn/spawn.ts`（52 行，实现见同目录 spawnTool.ts，591 行）
- 新架构: `packages/harness-core/src/features/tower/tools/spawn.ts`（createTowerSpawnTool，604 行）

## 能力对照

- [x] 输入 schema（name/kind/mission_id/review_target/instructions + superRefine 按 kind 必填）与主 agent 限定、模式未激活拒绝 → `packages/harness-core/src/features/tower/tools/spawn.ts`
- [x] 启动前校验：空白/保留名拒绝、重名拒绝并指引 resume、unknown mission 拒绝并列出已知 → 同文件 execute
- [x] worktree 建立与 base 检出 WIP 快照（spawnBase 记录进 mission 并提示）→ 同文件 + `packages/harness-core/src/features/tower/protocol/store.ts`（addWorktree/updateMission）
- [x] briefing 组装（workplace/scope/通信协议/survey 只读纪律/reviewer 任务书与检查表、作者 review-request 自述段、instructions 追加）→ 同文件 buildPrompt
- [x] 速率门：acquire/release，拒绝文案一致；完成回报 reportSuccess、rate_limit 失败回报 reportRateLimited → `packages/harness-core/src/features/tower/rateLimit.ts` + spawn.ts finish()
- [x] 后台分离运行与完成/失败/取消回报（v2 SubagentTask + mirrorAgentRun；新栈 detach + tower.spawned/completed/failed/cancelled 事件）、失败/被杀标记 roster died → spawn.ts + `packages/harness-core/src/features/tower/feature.ts`（TowerEvent）
- [x] worker 权限置 auto、roster 注册、mission 置 active/owner、spawn 日志 → spawn.ts
- [x] 模型指定：v2 走 config 子代理绑定；新栈由宿主注入 models（worker 取第一项）→ spawn.ts（SpawnModelEntry/with({model})）
- [ ] terminal mission（merged/abandoned）拒绝 spawn — 新栈无该检查
- [ ] 分支租约（withBranchLease 包裹 spawn/merge/rebase）— 无对应
- [ ] 历史段：worker 简报携带前任最近评审与 review-request（workerHistorySection）、reviewer 简报携带既往评审轮次（reviewHistorySection，至多 5 轮含省略计数）— 新栈简报无
- [ ] reviewer 一次性、死亡先诊断、用户停止不复活等长文指引与子代理超时（resolveSubagentTimeoutMs）— 输出简化为一句 recover 指引，超时可由宿主另行注入

## 结论

未对齐 4 项——启动链路、简报主体、速率门与事件回报对齐；终态 mission 防护、租约、历史简报段与运营指引降级。
