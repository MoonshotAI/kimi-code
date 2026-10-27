# ITaskOutputTool（taskOutputTool）

- v2: `packages/agent-core-v2/src/agent/tools/task/task-output/task-output.ts`（约 13 行；实现 taskOutputTool.ts 约 107 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/task/tools/task-output.ts`

## 能力对照

- [x] 按 task_id 读取后台任务输出（not_ready/success 检索状态、任务未找到报错）→ `packages/harness-core/src/features/task/tools/task-output.ts`
- [x] 审批规则（按 task_id 做 glob 匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（TaskOutput 条目）
- [ ] 32KB 尾部预览 + outputTruncated 标记 + output_path 持久化日志 + Read 分页提示 — 记录在案未迁：新栈将 output 全量内联返回（无预览截断、无日志文件、无 fullOutputHint）
- [ ] terminalReason 细分（timed_out）与 Wall time 显示 — 降级：新栈无 timed_out 状态（任务无超时概念），仅 killed/stopped、failed 两类 terminalReason，时间戳不格式化

## 结论

未对齐 2 项——output_path/Read 分页与预览截断未迁、timed_out 与 Wall time 降级；按 id 取输出主能力已对齐。
