# 使用外部 kimi-code Server 开发

在 kimi-code 工作克隆里直接运行 server（改动可以随时编辑、随时重启），并通过一个环境变量让 code-app 的 desktop 或 web 前端指向它——不用来回折腾 submodule。

## 流程

```bash
# 1. 在 kimi-code 克隆里（如 ~/code/kimi-code-5）启动 server，
#    并放行 desktop renderer 的 origin（仅 desktop 需要；
#    web dev server 走同源代理，不需要 CORS）：
KIMI_CODE_CORS_ORIGINS=app://renderer pnpm dev:server

# 2a. desktop 指向该 server（不会启动内嵌 server）：
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop

# 2b. 或者 web 指向该 server：
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:web
```

## 说明

- **Token 通过 `KIMI_CODE_HOME` 共享。** 两边默认都是 `~/.kimi-code`，所以 desktop 读到的 token 文件正是外部 server 写入的那份——零 token 配置。如果 server 启动时用了自定义 `KIMI_CODE_HOME`，`pnpm dev:desktop` 也要传同一个。
- 外部 server 使用 CLI 的 host 身份（不是 `kimi-desktop`），开发场景下没有影响。
- 不带 `KIMI_SERVER_URL` 运行 `pnpm dev:desktop` 时，保持原有内嵌 server 行为。
