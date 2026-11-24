# packages/agent-core-v2

本文件补充根目录的 `AGENTS.md`，只管 `packages/agent-core-v2`。

## 结构

- 引擎是 DI × Scope 架构。`LifecycleScope` 有三个层级：`App`、`Session`、`Agent`（`src/app/scopes.ts`）。
- L3 单元层提供 `Service` 和 `Fiber` 单元、集合贡献点，以及 `src/features/` 里的 Feature 接缝。
- `WorkspaceInstance` 和 `Program` 图在运行时通过 `IWorkspaceInstanceManager` 实例化；App 作用域的 `ISessionManager` 通过 `Program` 为每个工作区创建会话控制器。

## 导入边界

`pnpm lint` 会运行 `scripts/check-import-boundaries.mjs`，检查包内的导入边界（也可以单独跑 `pnpm --filter @moonshot-ai/agent-core-v2 lint:imports`）。它管着 `src/human` 的边界（只有 `src/llm-adapter`、`src/agent/loop` 和 `src/session/agentLifecycle` 能导入 human 实现，其余 v2 代码只能用词汇模块），并要求 protocol 的 format/lower/patterns 等模块只被 llm/builtin 的协议与 provider 代码和测试导入。违反时，报错信息会写明哪些导入是允许的；具体规则以这个脚本为准。
