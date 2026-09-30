# LLM Errors, Retries and Recoveries

This is a reference document: it lists how the llm layer reports failures, which failures are retried or recovered, and what a host should do with each.

## Two failure channels

| Channel | Raised by | Event (`generate`) | Retried |
|---|---|---|---|
| Syntax | Encode: the request violates the input contract or a protocol constraint | `attempt.failed` with `error.kind === 'syntax'` (`LlmErrorMessage<'syntax'>`) | Never |
| Remote | Transport, provider status, decoding, empty reply | `attempt.failed` with an `LlmRemoteErrorMessage` and `rawError` | Depends on `kind` |

`runLlmRequest` (and `requester.generate`) resolves to an `LlmOutcome`; the same object is emitted as the `outcome` of the `llm.ended` event:

- `{ type: 'done', message, usage, finish, headers, messageId, requestId, timing }`
- `{ type: 'failed', error, rawError?, ...partial output }` after retries and recoveries are exhausted
- `{ type: 'aborted', message }` where `message` keeps the salvageable part of an interrupted reply

During the run it also emits `llm.retrying` (`reason` is `backoff` or `recovery`) and `llm.notice`. The `attempt.failed` in the table above is attempt-internal and never reaches the boundary: a failure that is retried or taken over by a recovery shows up only as `llm.retrying`, and a final failure shows up as a `failed` outcome on `llm.ended`.

An exception thrown by a resolver is also folded into the outcome instead of rejecting `requester.generate()`: an abort exception yields `aborted`, any other yields `failed` (`kind: 'unknown'`, the original exception in `rawError`). This guarantees that every `llm.started` has an `llm.ended`.

## Syntax error codes

| `code` | Source | Host action |
|---|---|---|
| `request_format` | `SyntaxRequestFormatError`: input contract or protocol constraint violated | Fix the history or request; the message names the offending id or field |
| `thinking_config` | `ThinkingConfigError`: the effort cannot be expressed for this model | Change the configured effort or the model catalog entry |
| `internal` | Any other exception thrown during encode | Bug in the layer or a protocol hook |

## Remote error kinds (`src/llm/response.ts`)

| `kind` | Meaning | Retried by default |
|---|---|---|
| `abort` | Signal aborted | No |
| `connection`, `timeout` | Transport failure | Yes |
| `rate_limit` | HTTP 429 | Yes |
| `auth` | HTTP 401/403 | Yes (and credential recovery) |
| `overloaded` | HTTP 529, or 500/503 mentioning overload | Yes |
| `status` | Other HTTP status | Only 408, 409, 429, 500, 502, 503, 504, 529 |
| `provider` | Provider-reported error without a status | Yes |
| `context_overflow` | Prompt longer than the context window | No |
| `request_too_large` | HTTP 413 payload size | No (media recovery) |
| `request_structure` | Provider rejected message structure | No (structure recovery) |
| `image_format` | Provider could not decode an image | No (media recovery) |
| `quota_exhausted` | Account quota used up (Kimi) | No |
| `empty_response` | Reply had no content | Yes, unless `finishReason` is `filtered` |
| `unknown` | Unclassified | No |

Status errors carry `statusCode`, `requestId`, `retryAfterMs` and `headers`. `policy.retryables` adds predicates that make more errors retryable.

## Retry (`src/llm/policy/retry.ts`)

- Up to `retry.maxAttemptsPerStep` attempts (default 10).
- Delay is `Retry-After` when present, otherwise `500 ms × 2^n` capped at 32 s, plus up to 25% jitter.
- `retry.infiniteRetry` retries everything except `syntax`, `abort` and `context_overflow`.
- `llm.retrying { reason: 'backoff', failedAttempt, nextAttempt, maxAttempts, delayMs, error }` is emitted before waiting.
- Aborting during the delay ends the run as `aborted`.

## Recovery (`src/llm/policy/recovery.ts`)

Before retrying, `policy.recoveries` are asked in order; the first proposal that changes something is applied, recorded in the recovery ledger, the attempt counter resets, and `llm.retrying { reason: 'recovery', strategy, action, error }` is emitted. A strategy and action pair is applied at most once per run. Pass `control.recoveries` to keep the ledger across runs.

| Built-in | Trigger | Action |
|---|---|---|
| `credentialsRecovery` (`builtin/policy/credentials.ts`) | `credentials.canRecover(error)` | Invalidate and refresh credentials once |
| `structureRecovery` (`builtin/policy/structure.ts`) | `request_structure` | Merge consecutive assistant messages and drop leading non-user messages, once |
| `createMediaDegradeRecovery()` (`builtin/policy/media-degrade.ts`) | `request_too_large` | Mark all but the 2 most recent media `degraded`, then strip all |
| | `image_format` | Mark the current media `stripped` |

Structure recovery exists for provider layout rules the encoder does not model. It never repairs invariant violations; those fail as syntax errors before sending.

## Notices

Notices are not errors. They report an adaptation the layer made (`whitespace_text_dropped`, `vacuous_message_dropped`, `tool_result_reordered`, `consecutive_assistants_merged`, `leading_non_user_dropped`, `media-budget-exceeded`, `anthropic-thinking-effort-not-listed`). `source` is the encode pass or resolver id that reported it.
