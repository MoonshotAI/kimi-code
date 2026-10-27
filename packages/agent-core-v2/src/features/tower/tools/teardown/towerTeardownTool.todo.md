# ITowerTeardownTool（towerTeardownTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/teardown/teardown.ts`（34 行，实现见同目录 teardownTool.ts，82 行；store 侧 teardown() 在 protocol/store.ts）
- 新架构: `packages/harness-core/src/features/tower/tools/teardown.ts`（createTowerTeardownTool）+ `packages/harness-core/src/features/tower/protocol/store.ts`（teardown）

## 能力对照

- [x] 主 agent 限定与 live owner 拒绝（他会话拥有且在线时报错）→ `packages/harness-core/src/features/tower/tools/teardown.ts`（priorOwner/isSessionLive）
- [x] 逐 worktree 拆除与逐行报告：git 已不识别的报 already removed、含未提交改动默认保留、force 时强删、删除失败单列原因、activity log → `packages/harness-core/src/features/tower/protocol/store.ts`（teardown）
- [x] .tower/comms 审计保留与模式保持激活的收尾说明 → 同文件输出文案一致
- [ ] exclude 参数：按名保留指定 worktree 并在报告中注明 — 新栈 schema 无该字段
- [ ] dry_run 预演：只报告 would-remove/would-keep 与理由，不改盘与状态 — 未迁
- [ ] 运行中 roster agent 的 worktree 保护（v2 以 liveAgentIds 判定，force 也不可覆盖，报 "live agent"）— 新栈无（store.teardown 仅 force 一项）

## 结论

未对齐 3 项——拆除与脏保护主干对齐；exclude、dry_run 与 live agent 强制保护未迁，最后一项涉及仍在运行 worker 的数据安全。
