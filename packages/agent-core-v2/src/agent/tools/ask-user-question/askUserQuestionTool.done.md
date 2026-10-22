# IAskUserQuestionTool（askUserQuestionTool）

- v2: `packages/agent-core-v2/src/agent/tools/ask-user-question/ask-user-question.ts`（约 94 行；实现 askUserQuestionTool.ts 约 295 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/todo-features/interaction/`（传输层 + 工具本体）

## 能力对照

- [x] question 交互的传输与落地（request/respond、withQuestionIds 载荷、取消语义）→ `packages/harness-core/src/todo-features/interaction/interaction.ts`、`question-payload.ts`
- [x] 客户端应答通道（HTTP questions 列表/resolve/dismiss 路由、ACP elicitation 桥）→ `packages/harness-core/src/feature-http/route-features/interaction.ts`、`packages/harness-core/src/feature-acp/interaction-bridge.ts`
- [x] AskUserQuestion 工具本体（1-4 题 / 每题 2-4 选项 / multi_select / header 的 schema 与唯一性校验）→ `packages/harness-core/src/todo-features/interaction/tools/ask-user-question.ts`（zod schema + 执行层唯一性检查，经 interaction feature 的 agent slot 用 `useAgentTools` 注册；载荷字段按新栈契约用 `multi_select`）
- [x] background=true 后台提问 — 同上文件：经 loop 原生 `detach()` 机制（detached tool call，`toolCall.id` 即 task_id，ack 文案与 v2 一致），替代 v2 的 QuestionBackgroundTask/IAgentTaskService；完成经 `tool.async_ended` 自动通知。background 默认可用、不依赖 task feature（有别于 v2 按 TaskList/TaskOutput/TaskStop 激活门控）——task feature 只是后台 tool-call 的管理面：安装后任务进 TaskRef 记录，TaskStop/abort 时以 dismissed 输出 settle completed
- [x] dismiss / 客户端不支持（NOT_IMPLEMENTED）时的回退文案 — 同上文件：respond null / cancellation / 空 answers 均归一为 dismissed 结果（`{ answers: {}, note }`）；`not_implemented` 形态错误保留 v2 的 unsupported 错误文案（新栈传输层暂无该信令，防御性保留）
- [x] question_answered / question_dismissed 遥测 — 同上文件 `questionTelemetryEvents`（interaction feature agent slot 注册），属性 `answered` / `method`；trace_id 不再由工具显式传（新栈 ambient context 承载，v2 中本为可选）

## 结论

已对齐——interaction 传输层、HTTP/ACP 应答面、AskUserQuestion 工具本体（schema、前后台执行、回退文案、遥测）均已落在 `packages/harness-core/src/todo-features/interaction/`。契约用例移植至 `packages/harness-core/test/todo-features/interaction.test.ts`（13 例），v2 专属用例（DI 元数据、schema 层校验、tool policy 动态开关、trace_id 合并、v1 wire parity）保留在 v2 测试文件（6 例），测试总数净零。
