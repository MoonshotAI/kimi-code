# IBashTool（bashTool）

- v2: `packages/agent-core-v2/src/agent/tools/os/bash/bash.ts`（约 77 行；实现 bashTool.ts 约 480 行 + process-task.ts，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/os/tools/bash.ts`

## 能力对照

- [x] 前台/后台执行与超时档位（前台 60s 默认/300s 上限，后台 600s 默认/24h 上限，disable_timeout）→ `packages/harness-core/src/features/os/tools/bash.ts`
- [x] 前台超时自动转后台、完成自动通知 → `packages/harness-core/src/features/os/tools/bash.ts`（doDetach('foreground_detached')）+ `packages/agent-core/src/tool/executor.ts`（detach）+ `packages/harness-core/src/features/task/feature.ts`
- [x] 输出超阈值溢写 spill 文件并附 Read 分页提示 → `packages/harness-core/src/features/os/tools/bash.ts`（startSpill/queueSpill）
- [x] 审批规则（按命令做 glob 匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（Bash 条目）
- [x] Windows 适配（NUL 重定向改写、shell 路径桥、非交互环境变量）→ `packages/harness-core/src/features/os/tools/bash.ts`、`host/execEnv/shellPathBridge`
- [ ] 前台命令由用户主动转后台 — 工具面通道已备（`bash.ts` 的 BashPendingDetach，经 BashRef 暴露），但 src 内无消费者：HTTP :detach 路由只认已后台的 TaskRecord —— 记录在案未接线
- [ ] runtime lease 代际检查（runtime 变更时拒绝执行）— 决策不迁：新栈为单一 Node 宿主
- [ ] 执行器级统一截断（v2 `agent/toolResultTruncation/toolResultTruncationService.ts` 的头尾整形 + 溢出指针，覆盖全部工具结果）— 未迁：新栈执行器仅有宿主可选的 maxResultChars 策略且默认未接线，bash 依靠自备 spill 机制

## 结论

未对齐 3 项——前台命令用户转后台未接线、runtime lease 决策不迁、执行器级统一截断未迁；命令执行主链路已对齐。
