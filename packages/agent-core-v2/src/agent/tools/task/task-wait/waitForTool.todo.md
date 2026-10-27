# IWaitForTool（waitForTool）

- v2: `packages/agent-core-v2/src/agent/tools/task/task-wait/task-wait.ts`（约 28 行；实现 taskWaitTool.ts 约 420 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/wait-for/`（tool.ts / feature.ts）

## 能力对照

- [x] 等待指定 task_id 或任意后台任务直到完成/超时，超时非错误并返回仍在运行的任务 → `packages/harness-core/src/features/wait-for/tool.ts` + `packages/agent-core/src/loop/`（waitForTasks，引擎内建）
- [x] 审批规则（按 task_id 或 any 匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（WaitFor 条目）
- [ ] 完成结果内联任务输出（32KB 预览、output_path、terminalReason、[completed_during_wait] 附带同时完成的其他任务）— 降级：新栈只回 completed/running 的 id 列表，需再调 TaskOutput 取输出
- [ ] 等待中的进度更新（每秒 status 刷新）、steer 中断（interrupted 语义与提示）、同回合重复等待警告（[wait_warning]）— 未迁
- [ ] 超时上限行为差异 — v2 上限 90s，新栈 600s（WAIT_FOR_MAX_TIMEOUT_S 不同，记录在案）

## 结论

未对齐 3 项——结果不含输出预览与附带完成列表、进度/中断/重复等待引导未迁、超时上限 90s→600s；等待主能力已对齐。
