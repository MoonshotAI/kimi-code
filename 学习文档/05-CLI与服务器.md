# 05 · CLI 与服务器

> 时效基线：基于 commit `d4e0ad4b2`（2026-08）。
> `apps/kimi-code`（npm 包 `@moonshot-ai/kimi-code`，bin 命令 `kimi`）是整套系统的**组合根**：同一套引擎在这里被接到三种宿主形态上。

## apps/kimi-code 的结构

```
src/
├── main.ts          入口：命令解析与分发
├── cli/             命令层：options、run-prompt（一次性 -p 提示）、run-shell、
│                    experimental-v2、v2/（v2 组装）、update…
│   └── sub/         子命令：web/（kap-server）、acp.ts（v1 ACP）、acp-native.ts（v2 ACP）、
│                    login、provider、doctor、vis、export…
├── tui/             终端交互界面（基于 packages/pi-tui；改 TUI 前先看 .agents/skills/write-tui）
├── migration/       旧数据迁移
└── native/          单文件可执行（SEA）构建相关
```

三种形态与引擎的关系：

| 形态 | 启动 | 引擎接入方式 |
|---|---|---|
| TUI（默认） | `kimi` 或 `pnpm dev:cli` | 进程内直接组装（`src/cli/experimental-v2.ts`、`src/cli/v2/`） |
| Web 服务 | `kimi web`（`src/cli/sub/web/run.ts`） | 引擎跑在同进程，经 **kap-server** 暴露 REST+WS |
| ACP 服务 | `kimi acp`（v1，遗留）/ `kimi acp --native`（v2，`src/cli/sub/acp-native.ts`） | stdio JSON-RPC，供 Zed 等编辑器驱动 |

## kap-server（`packages/kap-server`）

Fastify 服务器，把 agent-core-v2 的四层（App/Workspace/Session/Agent 概念层）映射到 HTTP：

- **REST**：`/api/v1`（会话 CRUD/resume/fork、文件、transcript、终端、审批、提问、插件、skill、配置、跨会话搜索、OAuth…），`/api/v2` 起步中；统一响应信封与 keyset 分页由 `packages/protocol` 定义。
- **WebSocket**：`/api/v1/ws`——全局事件族向所有连接扇出，会话/agent 粒度事件只发给订阅了的连接；transcript 用 op-batch `seq` 记账 + `transcript_since` 游标补发，断线重连不丢事件。
- **会话路由**：`ISessionIndex` → `IWorkspaceLifecycleService.handlerFor` → handler 的 `ISessionLifecycleService`（与 `04` 讲的组合入口同一条链）。
- **跨会话搜索**：`POST /api/v1/search`，minidb 全文索引（`<home>/search-index`），worker 线程后端。
- **调试面**：`--debug-endpoints` 挂 `/api/v1/debug/*`（配合 kimi-inspect，见 `03-调试指南.md` §4）。

浏览器 Web UI：`kimi web` 起来后由 `apps/kimi-code/dist-web` 里的**预构建 bundle** 提供——源码在外部 code-app 仓库，用 `KIMI_SERVER_URL` 指向本仓 dev server 联调（根 `AGENTS.md` 有联调命令说明）。

## 读代码的切入顺序

1. `src/main.ts` → `src/cli/commands.ts`：命令如何分发到子命令；
2. `src/cli/sub/web/run.ts`：`kimi web` 如何从 kap-server 的 `start.ts`（`packages/kap-server/src/start.ts`）把服务拉起来——注意它与 TUI 共享同一引擎装配代码；
3. `packages/kap-server/src/routes/`：挑 `sessions` 和 `transcript` 两个路由文件读，理解 REST→引擎服务的映射；
4. `src/cli/sub/acp-native.ts` + `packages/acp-server/src/start.ts`：ACP 如何用 klient memory facade 把引擎翻成 Agent Client Protocol——"又一层薄门面"的好例子；
5. （可选）`src/tui/`：终端 UI 与插件 webview 解决的是同一类问题（渲染事件流、收集输入、审批交互），对照着看能加深对"引擎与 UI 分离"的理解。

## 动手练习

- [ ] `pnpm dev:server` + kimi-inspect，创建一个会话发条消息，在 Sessions 面板看事件流；再开浏览器 DevTools 的 Network/WS 面板对照 `/api/v1/ws` 的帧。
- [ ] `pnpm vis` 打开同一个会话的回放，对比两种工具展示同一份 wire 数据的角度差异。
- [ ] 读 `packages/kap-server` 的 transcript 路由，回答：断线重连后客户端如何不丢事件？（提示：op-batch `seq`）

## 下一步

→ `06-支撑包速览.md`
