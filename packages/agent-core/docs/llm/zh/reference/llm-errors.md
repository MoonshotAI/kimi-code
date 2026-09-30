# LLM 错误、重试与恢复

这是一篇 reference 文档：列出 llm 层如何报告失败、哪些失败会被重试或恢复，以及宿主应当如何处理每一种。

## 两条失败通道

| 通道 | 来源 | 事件（`generate`） | 是否重试 |
|---|---|---|---|
| Syntax | Encode：请求违反输入契约或协议约束 | `attempt.failed`，`error.kind === 'syntax'`（`LlmErrorMessage<'syntax'>`） | 从不 |
| Remote | 传输、provider 状态码、解码、空响应 | `attempt.failed`，携带 `LlmRemoteErrorMessage` 和 `rawError` | 取决于 `kind` |

`runLlmRequest`（以及 `requester.generate`）最终返回一个 `LlmOutcome`，同一个对象也会作为 `llm.ended` 事件的 `outcome` 发出：

- `{ type: 'done', message, usage, finish, headers, messageId, requestId, timing }`
- `{ type: 'failed', error, rawError?, ...部分输出 }`：重试和恢复都用尽之后
- `{ type: 'aborted', message }`：`message` 保留被中断响应中可用的部分

运行过程中还会发出 `llm.retrying`（`reason` 为 `backoff` 或 `recovery`）和 `llm.notice` 事件。上表的 `attempt.failed` 是单次 attempt 内部的事件，不出现在边界上：被重试或被 recovery 接手的失败只表现为 `llm.retrying`，最终失败表现为 `llm.ended` 的 `failed` 结果。

resolver 抛出的异常也会收敛进结果，而不是让 `requester.generate()` reject：中止类异常得到 `aborted`，其他异常得到 `failed`（`kind: 'unknown'`，原始异常在 `rawError`）。这保证每个 `llm.started` 都有一个 `llm.ended`。

## Syntax 错误码

| `code` | 来源 | 宿主应如何处理 |
|---|---|---|
| `request_format` | `SyntaxRequestFormatError`：违反输入契约或协议约束 | 修正历史或请求；错误信息会指出出问题的 id 或字段 |
| `thinking_config` | `ThinkingConfigError`：该 effort 在这个模型上无法表达 | 修改配置的 effort，或修改模型目录条目 |
| `internal` | encode 过程中抛出的其他异常 | llm 层或某个协议钩子的 bug |

## 远端错误类型（`src/llm/response.ts`）

| `kind` | 含义 | 默认是否重试 |
|---|---|---|
| `abort` | signal 被中止 | 否 |
| `connection`、`timeout` | 传输失败 | 是 |
| `rate_limit` | HTTP 429 | 是 |
| `auth` | HTTP 401/403 | 是（另有凭据恢复） |
| `overloaded` | HTTP 529，或提到 overload 的 500/503 | 是 |
| `status` | 其他 HTTP 状态码 | 仅 408、409、429、500、502、503、504、529 |
| `provider` | provider 报告的、不带状态码的错误 | 是 |
| `context_overflow` | prompt 超出上下文窗口 | 否 |
| `request_too_large` | HTTP 413，请求体过大 | 否（媒体恢复） |
| `request_structure` | provider 拒绝了消息结构 | 否（结构恢复） |
| `image_format` | provider 无法解码图片 | 否（媒体恢复） |
| `quota_exhausted` | 账户额度用尽（Kimi） | 否 |
| `empty_response` | 响应没有内容 | 是，除非 `finishReason` 为 `filtered` |
| `unknown` | 无法归类 | 否 |

状态码类错误带有 `statusCode`、`requestId`、`retryAfterMs`、`headers`。`policy.retryables` 可以追加判定函数，让更多错误变为可重试。

## 重试（`src/llm/policy/retry.ts`）

- 最多 `retry.maxAttemptsPerStep` 次 attempt（默认 10）。
- 有 `Retry-After` 时按它等待，否则为 `500 ms × 2^n`，上限 32 s，另加最多 25% 的抖动。
- `retry.infiniteRetry` 会重试除 `syntax`、`abort`、`context_overflow` 之外的所有错误。
- 等待之前发出 `llm.retrying { reason: 'backoff', failedAttempt, nextAttempt, maxAttempts, delayMs, error }`。
- 在等待期间中止，本次运行以 `aborted` 结束。

## 恢复（`src/llm/policy/recovery.ts`）

重试之前，先依次询问 `policy.recoveries`；第一个提出有效改动的方案会被应用，并记入 recovery ledger，attempt 计数归零，同时发出 `llm.retrying { reason: 'recovery', strategy, action, error }`。同一个 strategy 和 action 组合在一次运行中最多应用一次。传入 `control.recoveries` 可以让 ledger 跨多次运行保留。

| 内置 recovery | 触发条件 | 动作 |
|---|---|---|
| `credentialsRecovery`（`builtin/policy/credentials.ts`） | `credentials.canRecover(error)` | 作废并刷新一次凭据 |
| `structureRecovery`（`builtin/policy/structure.ts`） | `request_structure` | 合并相邻的 assistant 消息，去掉开头的非 user 消息，只做一次 |
| `createMediaDegradeRecovery()`（`builtin/policy/media-degrade.ts`） | `request_too_large` | 先把除最近 2 个之外的媒体标记为 `degraded`，再全部 strip |
| | `image_format` | 把当前所有媒体标记为 `stripped` |

结构恢复是为 encoder 没有建模的 provider 布局规则准备的。它从不修补不变量违规，那些在发送前就已经以 syntax 错误失败了。

## Notice

Notice 不是错误，它报告的是 llm 层做过的某个适配（`whitespace_text_dropped`、`vacuous_message_dropped`、`tool_result_reordered`、`consecutive_assistants_merged`、`leading_non_user_dropped`、`media-budget-exceeded`、`anthropic-thinking-effort-not-listed`）。`source` 是报告它的 encode pass 或 resolver id。
