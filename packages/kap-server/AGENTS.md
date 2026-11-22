# kap-server Agent 指南

`@moonshot-ai/kap-server` 通过 REST（`/api/v1`）和 WebSocket（`/api/v1/ws`）提供 Kimi Agent Protocol（KAP `1.0.0`）。主要的外部调用方包括通过普通 HTTP 实时管理 Kimi Code 的 AI agent（使用 `:wait`、`/interactions`、`/turns`、`/prompts`、`/steer`），以及轻量机器人和自定义界面。第一方桌面端和 Web 端也使用这个协议。

## 核心会话兼容性与宿主管理接口

- **核心会话和对话流程保持向后兼容。** 下列外部接口的默认参数语义和响应结构都必须兼容已有调用方。
  - REST 接口包括 `/api/v1/meta`、`/api/v1/kap.md`、`/api/v1/sessions`（含 `:wait`、`:cancel`、`:fork`、`:undo`、`:archive`、`:restore` 及 `/profile`）、`/agents/{agent_id}/turns`、`/prompts`、`/steer`、`/interactions` 和 `/files`。
  - WebSocket 核心对话帧和状态帧包括 `subscribe`、`turns`、`turn.*`、`item.*`、`interaction`、`agent` 和 `task.*`。
  - 需要调用方主动启用的新行为，通过可选参数或新的 `:action` 后缀提供。如果 agent 或客户端需要在运行时探测新的对外能力，就在 `GET /api/v1/meta` 的 `data.capabilities` 里声明。
- **第一方宿主管理接口可以随产品演进。** `/config`、`/providers`、`/models`、`/oauth/*`、`/mcp/*`、`/plugins/*`、`/capabilities/*`、`/hosts*`、`/remote-control*`、`/workspaces*`、`/fs:*` 供第一方桌面端和 Web 端使用。修改时同步更新本仓桌面端与 Web 端受影响的调用方（协议适配在 `packages/app-core/src/api/daemon`），并用 `pnpm qa:refresh schema` 刷新 `packages/kap-server/schema/` 下的契约文档，不要为外部调用方加兼容层。

## 协议字段与内置文档

- **公开协议的字段名使用 `snake_case`。** 这条约定适用于请求体、查询字符串、响应的 `data` 载荷和 WebSocket 帧。文档明确标注为透传的载荷除外。
- **核心流程变化时同步更新内置协议指南。** 运行中的二进制通过 `GET /api/v1/kap.md` 直接提供 `packages/kap-server/docs/kap.md`。修改连接建立流程（`kimi web --json`、`server.token` / `instances`）、核心会话、对话或交互接口，或 `meta.capabilities` 时，都要更新这份指南。连接建立流程有变时，还要同步更新公开技能 `skills/use-kimi-code/SKILL.md` 和双语用户指南 `docs/{en,zh}/guides/other-agents.md`。`docs/kap.md` 保持简明（约 500 行），字段级定义由运行中的服务通过 `/openapi.json` 和 `/asyncapi.json` 提供。
