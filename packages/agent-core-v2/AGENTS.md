# packages/agent-core-v2

本文件补充根目录的 `AGENTS.md`，只管 `packages/agent-core-v2`。

## 结构

- 引擎是 DI × Scope 架构。`LifecycleScope` 有三个层级：`App`、`Session`、`Agent`（`src/app/scopes.ts`）。
- L3 单元层提供 `Service` 和 `Fiber` 单元、集合贡献点，以及 `src/features/` 里的 Feature 接缝。
- `WorkspaceInstance` 和 `Program` 图在运行时通过 `IWorkspaceInstanceManager` 实例化；App 作用域的 `ISessionManager` 通过 `Program` 为每个工作区创建会话控制器。

## 远程执行（`src/remote`）

- `src/remote` 是远程执行栈：本地 `ExecBridge`（ssh、docker 和 `command` 启动器）和轻量的 `kimi exec-server` 执行器之间，用一套自成一体、按行分帧的 NDJSON RPC 通信（codex exec-server 方言）；另有一个 provider，把声明的目标注册为 `Environment`。
- fs 和 process 的 RPC 存根是 `src/os/backends/remote` 下的一个 OS 后端，与 `node-local` 并列。
- 这套栈导出为 `@moonshot-ai/agent-core-v2/remote` 和 `@moonshot-ai/agent-core-v2/remote/server`。
- 执行器保持轻量：`src/remote/server` 只能导入 node 内置模块、相对路径模块、`#/remote/protocol`、`#/os/interface`、`#/_base/execEnv`，以及它所适配的 node-local `hostFsService` 和 `hostProcessService`。
- CLI 只通过 SDK 的轻量子路径 `@moonshot-ai/kimi-code-sdk/exec-server` 访问执行器，在 `apps/kimi-code/src/cli/exec-server.ts` 里动态加载。

## 导入边界

`pnpm lint` 会运行 `scripts/check-import-boundaries.mjs`，检查包内的导入边界（也可以单独跑 `pnpm --filter @moonshot-ai/agent-core-v2 lint:imports`）。除了上面执行器的规则，它还管着 `src/remote/askpass.ts`、`src/os/backends/remote`、`src/environment`、`src/remote/declaration` 和 `src/human` 的边界，并禁止引擎代码导入 `src/remote/server`。违反时，报错信息会写明哪些导入是允许的；具体规则以这个脚本为准。
