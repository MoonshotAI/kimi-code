# 本地服务与 API

Kimi Code CLI 内置一个本地服务：运行 `kimi web` 会在前台启动一个进程，同时挂载浏览器里的 web UI、REST API（`/api/v1`）和 WebSocket 事件流（`/api/v1/ws`）。web UI 用于在浏览器里直接使用 Kimi Code；REST 与 WebSocket API 面向脚本和第三方工具，可以用代码创建会话、提交提示词、实时跟进执行过程——它们与 TUI、web UI 读写同一份会话数据。

> 开始前请确认 Kimi Code CLI 已安装并处于可用状态——完成 `/login` 登录（TUI 内或 `kimi login`），或已在 `config.toml` 配置供应商。服务与 CLI 共享同一份登录态与配置，无需为服务单独准备凭证。

::: warning 注意
本页介绍的 REST 与 WebSocket API 为实验性特性：不保证接口稳定性，端点、字段与事件类型可能随版本随时更改。集成时请以当前版本服务的 `/openapi.json` 与 `/asyncapi.json` 为准。
:::

## 启动服务

```sh
kimi web                 # 前台运行服务并打开浏览器
kimi web --no-open       # 只运行服务，不打开浏览器
kimi web --port 58628    # 指定绑定端口
```

服务默认绑定 `127.0.0.1:58627`（仅本机访问）；端口被占用时自动 +1 重试，同一台机器因此可以并存多个实例，每个实例登记在 `~/.kimi-code/server/instances/` 下。启动横幅会打印访问地址和明文 token：

```text
Local:   http://127.0.0.1:58627/#token=...
Token:   ...
Stop:    Ctrl+C
```

服务在前台运行，按 `Ctrl-C` 干净退出。`--host`、`--log-level` 等完整选项见 [kimi 命令参考](../reference/kimi-command.md#kimi-web)。

## 鉴权

所有 `/api/*` 接口都要求 bearer token（持有者令牌：任何携带该字符串的请求都被视为已授权）。token 在首次启动服务时生成，持久化在 `~/.kimi-code/server.token`（文件权限 0600），跨重启复用。

按客户端类型选择携带方式：

- **REST**：请求头 `Authorization: Bearer <token>`。
- **web UI**：启动横幅里的地址自带 `#token=` 片段，浏览器打开后自动完成登录；该片段不会发送到服务端。
- **WebSocket**：能自定义请求头的客户端用 `Authorization: Bearer`；浏览器等不能自定义头的客户端改用子协议（WebSocket 握手时声明的协议名）`kimi-code.bearer.<token>`。

token 泄露时运行 `kimi web rotate-token` 轮换：新 token 立即写入 `server.token`，旧 token 即刻失效，正在运行的实例无需重启。

如果把服务绑定到非本机地址（`--host`），建议额外设置 `KIMI_CODE_PASSWORD` 环境变量作为并列凭证；此时服务端会对鉴权失败自动限流。

::: danger 警告
`--dangerous-bypass-auth` 会彻底关闭鉴权，任何能访问该端口的人都能控制你的会话、文件系统和 shell。仅在可信网络或自有鉴权代理之后使用，详见 [kimi 命令参考](../reference/kimi-command.md#kimi-web)。
:::

## 用 API 驱动一个会话

下面用 curl 走一遍最小流程：确认服务状态 → 创建会话 → 订阅事件 → 提交提示词 → 回读历史。示例假设服务跑在默认地址，token 已存入 shell 变量 `TOKEN`。

1. 确认服务状态：

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/api/v1/meta
```

所有 JSON 响应都包在统一信封里——`{ "code": 0, "msg": "success", "data": ..., "request_id": "..." }`，业务结果以 `code` 为准（`0` 表示成功），HTTP 状态码只表达传输层结果。

2. 创建会话，`metadata.cwd` 指定工作目录：

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"cwd": "/path/to/project"}}'
```

返回的 `data.id`（形如 `session_...`）就是后续所有请求要用的会话 id。

3. 连接 WebSocket 并订阅会话事件。任何 WebSocket 客户端都可以；下面是一个零依赖的 Node.js 脚本（Node.js 22+ 内置 `WebSocket` 客户端）：

```js
// subscribe.mjs —— 用法：TOKEN=... node subscribe.mjs session_...
const ws = new WebSocket('ws://127.0.0.1:58627/api/v1/ws', [
  `kimi-code.bearer.${process.env.TOKEN}`,
]);
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () =>
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      id: '1',
      payload: { session_ids: [process.argv[2]] },
    }),
  );
```

4. 提交提示词：

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions/<session_id>/prompts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": [{"type": "text", "text": "用一句话介绍这个仓库"}]}'
```

订阅端会依次看到 `turn.started`（轮次开始）→ `assistant.delta`（流式文本增量）→ 发生工具调用时的 `tool.call.started` / `tool.result` → `turn.ended`（轮次结束）。

5. 随时可以用 REST 回读历史消息：

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:58627/api/v1/sessions/<session_id>/messages?page_size=20"
```

## 在线规范文档

服务运行时会自描述两份规范文档，同样需要 bearer token：

- `GET /openapi.json` — REST API 的 OpenAPI 文档，含每个端点的请求 / 响应 schema，可直接导入 Swagger UI、Postman 等工具。
- `GET /asyncapi.json` — WebSocket 协议的 AsyncAPI 文档，覆盖控制帧与事件类型。

## 下一步

- [服务 API](../reference/server-api.md) — REST 端点全集、错误码、WebSocket 事件与转录协议
- [kimi 命令](../reference/kimi-command.md#kimi-web) — `kimi web` 的全部命令行选项
