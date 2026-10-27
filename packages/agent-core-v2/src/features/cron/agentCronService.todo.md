# IAgentCronService（agentCronService）

- v2: `packages/agent-core-v2/src/features/cron/cronService.ts`（约 592 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/cron/feature.ts`（`CronRef` facade + `projection.ts` durable 投影）

## 能力对照

- [x] cron 任务表的事件溯源持久化（add/delete/cursor 投影，恢复后重放）→ `packages/harness-core/src/features/cron/projection.ts`
- [x] 周期调度：默认 1s 轮询、`manualTick` 下 SIGUSR1 触发、loop 运行中跳过本轮 → `packages/harness-core/src/features/cron/feature.ts`（`watch(section)` + `tick()`）
- [x] 到点投递：`renderCronFireXml` 包装为 user 消息并携带 `CronJobOrigin` 提交 → 同文件 `deliverFire`（`agent.loop.submit`，loop 忙时放弃本次、下轮重试，与 v2 等价）
- [x] 合并唤醒（coalescedCount，上限 10000 次迭代）、7 天 stale 自动过期删除、one-shot 触发后自动删除 → 同文件 `countCoalesced`/`isStaleAt`/`processDue`
- [x] jitter 与展示用 nextFire 计算、时钟源可配（config.clock/debug）、任务 CRUD 与 `tick()` 手动触发 → `CronRef` face 的 `addTask/removeTasks/getTask/list/isStale/getNextFireForTask/computeDisplayNextFire/tick`
- [x] 进入产品默认装配 → `packages/harness-core/src/preset.ts`（`createCron()`）
- [ ] fork 继承语义 — v2 在 `Forked` 事件里清空 fork 的 cron 任务表并发 `cron_fork_cleared` 提醒（源会话任务继续运行）；新栈 cron projection 不处理 fork，fork 语义未定，未迁
- [ ] 埋点（`cron_scheduled`/`cron_fired`/`cron_missed`/`cron_deleted`）— 新栈只发 `cron.fired` 运行时事件，telemetry 未接，归属 telemetry 域记录在案未迁

备注：v2 接口中的 `handleMissed`（`cron_missed` 补火通知）在 v2 全仓仅测试引用，属死接口面；`getNextFireTime()` 聚合方法被 CLI v2 print 路径用于输出下次触发时间，新栈可由 `list()` + `getNextFireForTask` 派生，不计缺失。

## 结论

未对齐 2 项——fork 时清空任务与提醒的继承语义未定未迁；四项 cron 埋点未接；调度、持久化、合并/过期/jitter 等核心能力均已对齐。
