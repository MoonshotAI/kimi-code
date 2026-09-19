# 从这里开始

How-to 入口：产品路径按编号读。最小闭环是 [1. 启动最小 App 并跑完一个 turn](how-to-guides/01-run-a-turn.md)。完整表见 [README](README.md)。

| # | 下一步 |
|---|---|
| 1 | [跑完一个 turn](how-to-guides/01-run-a-turn.md) — 报文 [HistoryMessage](reference/history-message.md)，队列 [状态机](explanation/agent-machine.md) |
| 2 | [Todo Feature](how-to-guides/02-add-todo-feature.md) |
| 3 | [听事件并触发请求](how-to-guides/03-listen-and-trigger.md) |
| 4 | [暴露 facade](how-to-guides/04-expose-facade.md) |
| 5 | [可后台 Tool + WaitFor](how-to-guides/05-background-tool.md) |
| 6 | [Bash 与手动 detach](how-to-guides/06-bash-and-detach.md) |
| 7 | [provider-catalog](how-to-guides/07-use-provider-catalog.md) |

可运行参照：`example/app.ts`（`mountExample`）、`example/cli.ts`（`runCli`）。

```sh
pnpm --filter @moonshot-ai/harness-core example
pnpm --filter @moonshot-ai/harness-core example -- -p '你好' -c <session-id> --json
```

## 走 HTTP 而不是进程内调用

把 `createHttp({ listen: { port, host } })` 加进 `features`，同一套能力暴露为 REST（`/api/v1`）。缺 `agent_id` 默认 `MAIN_AGENT_ID`。session 必须已经 live（`get` 不到回 404）。

| 进程内 | HTTP |
|---|---|
| `agent.setConfig` / `setCredentialProvider` / `setRequester` | 无；只在进程内 |
| `agent.submit` | `POST /api/v1/sessions/:session_id/prompts` |
| `agent.notify` | `POST /api/v1/sessions/:session_id/notify` |
| `agent.remind` | `POST /api/v1/sessions/:session_id/remind`（必填 `key`） |
| `agent.steer` | `POST .../prompts::steer` 或 `POST .../prompts/:id:steer` |
| `agent.cancel` | `POST .../prompts/:id:abort`（名字是 abort，实现是 `cancel`） |
| `agent.abort` | `POST /api/v1/sessions/:session_id:abort` |
| `agent.pause` / `continue` | `POST .../:session_id:pause` / `:continue` |

## 相关文档

- 总览 → [overview](explanation/overview.md)
- 事件表 → [events](reference/events.md)
- 写 Feature 清单 → [08](how-to-guides/08-develop-feature.md)
