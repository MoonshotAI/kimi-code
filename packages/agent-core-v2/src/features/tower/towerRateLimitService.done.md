# ITowerRateLimitService（towerRateLimitService）

- v2: `packages/agent-core-v2/src/features/tower/towerRateLimit.ts`（22 行接口，实现见同目录 towerRateLimitService.ts，146 行）
- 新架构: `packages/harness-core/src/features/tower/rateLimit.ts`（createTowerRateLimiter，经 TowerRateLimitRef 在 app 层暴露）

## 能力对照

- [x] reportRateLimited/reportSuccess：容量治理（收缩间隔 2s、恢复间隔 180s）与 60s spawn 暂停 → `packages/harness-core/src/features/tower/rateLimit.ts`（RateLimitCapacityGovernor，常量逐一相同）
- [x] budget()：1–16 自适应并发预算（TOWER_MAX_BUDGET=16）→ 同文件 budget()
- [x] acquire/release：暂停期与预算耗尽的结构化拒绝文案（与 v2 逐字相同）→ 同文件 acquire/release
- [x] snapshot/reset：budget/inflight/blockedUntil 快照与复位 → 同文件 snapshot/reset
- [x] app 级单例语义（v2 App 作用域 DI 贡献）→ `packages/harness-core/src/features/tower/feature.ts`（app() 层 useExpose(TowerRateLimitRef)）
- [x] 消费方：spawn 的 acquire/release 与 status 的 snapshot → `packages/harness-core/src/features/tower/tools/spawn.ts`、`tools/status.ts`；新栈另把 reportSuccess/reportRateLimited 接入 spawn 完成路径（v2 这两个方法本就无消费方）

## 结论

全部对齐——接口七方法、治理常量与拒绝文案逐一对齐，挂载层级等价（App 作用域服务 → app 层 facade）。
