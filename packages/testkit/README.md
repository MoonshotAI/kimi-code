# @moonshot-ai/testkit

Shared test infrastructure for this repository: a protocol-level fake model, fake Kimi managed services, a driver for the Kimi Agent Protocol (KAP), and the fixtures around them. The package depends on no `@moonshot-ai/*` package, so the tests of any package can use it. Code that needs a product package, such as the server, is passed in by the caller.

| Import | What it provides |
|---|---|
| `@moonshot-ai/testkit/model` | the fake model, the step DSL, tool-call builders, and the provider config that points the product at the fake model |
| `@moonshot-ai/testkit/services` | fake Kimi managed services: session titles and feedback with signed uploads, scripted and recorded like the fake model |
| `@moonshot-ai/testkit/kap` | `startKap`: an in-process KAP server backed by the fake model; `KapProcess`: the CLI's `web --json` server in a child process; `KapClient`: the session operations both of them share, with REST and WebSocket clients and a turn reducer |
| `@moonshot-ai/testkit/fixtures` | temporary homes, a `config.toml` writer, git repositories with a linked worktree, environment isolation, the network guard, child processes that stay offline, the CLI command and environment, repository paths, directory snapshots, waits, timeouts, media samples, normalizers, and fake MCP servers over stdio, streamable HTTP and SSE |
| `@moonshot-ai/testkit/contract` | a field-per-line summary of OpenAPI and AsyncAPI documents, a check that lists contract changes as breaking, non-breaking or unclassified, and a digest that ignores wording, for pinning an API level |
| `@moonshot-ai/testkit/vitest` | fixture definitions for `test.extend` and the network guard hooks |

## Writing a test

This is a private workspace package. When adopting it in another package, add `"@moonshot-ai/testkit": "workspace:^"` to that package's `devDependencies` and run `pnpm install` at the repository root. Choose a guide by what the test needs to observe.

| What you want to test | Guide |
|---|---|
| What a provider client sends and how it parses the reply | [假模型与 SDK 测试](docs/model.md) |
| How the product uses the session title or feedback service | [The fake Kimi services](#the-fake-kimi-services) |
| What a KAP client sees during tool use, approval, cancellation or restart | [编写 KAP 场景测试](docs/kap-scenarios.md) |
| Code that reads configuration, uses a workspace or produces snapshots | [夹具、隔离与快照](docs/fixtures.md) |
| A Playwright test that drives Kimi Code Desktop against a scripted provider | [在桌面端接入假模型](docs/model.md#在桌面端接入假模型) |

To try the tool-call example or run both suites, use these commands from the repository root.

```sh
pnpm exec vitest run --reporter=agent tests/scenarios/conversation.test.ts -t 'runs a tool call'
pnpm exec vitest run --reporter=agent packages/testkit tests/scenarios
```

## A scenario test

```ts
import { createServerLogger, startServer, type RunningServer } from '@moonshot-ai/kap-server';
import { bash, say } from '@moonshot-ai/testkit/model';
import { kapFixtures, type KapFixtures } from '@moonshot-ai/testkit/vitest';
import { test as base, expect } from 'vitest';

const test = base.extend<KapFixtures<RunningServer>>(kapFixtures({ startServer, createServerLogger, config: { defaultPermissionMode: 'yolo' } }));

test('runs a tool and answers', async ({ kap, model }) => {
  model.script(bash('echo hi'), say('done'));
  const session = await kap.createSession();

  await kap.prompt(session.id, 'run it');
  await kap.waitIdle(session.id);

  expect(model.request(1).view.messages.at(-1)).toMatchObject({ role: 'tool', text: 'hi\n' });
});
```

Define `test` in the test file itself with `base.extend(...)`. The repository's `vitest/no-standalone-expect` lint rule recognizes only `extend` chains of vitest's own `test` in the same file, so a `test` imported from a helper module fails lint.

The `model` fixture calls `model.verify()` after the test and prints a request summary on failure. The `kap` fixture runs verification before shutdown so an unreleased hold stays visible. It then stops the server and removes the temporary home. A fixture that owns another driver of the model, such as the engine harness's `testkitAgentFixtures()`, calls `verifyModelOnce(model)` before tearing that driver down; the `model` fixture then skips its own verification.

With `verifyInvariants: true`, the `kap` fixture also calls `verifyKapInvariants(kap)` after a test that passed, then verifies the model again so a request sent while the sessions settle is checked too. It looks at every session the test created with `kap.createSession()` or `kap.fork()` or saw on a WebSocket, and fails the test when:

- the session is not idle, without a pending interaction and with an empty prompt queue, by the deadline (`TIMEOUTS.wait` for the whole check, `timeoutMs` to change it); background work counts;
- once it is idle, a turn or item of its main agent, of an agent a client subscribed to, or of a subagent a tool call refers to in `agent_refs` is still `running`;
- a client's frames for an agent it subscribed to, including one whose stream ended when that agent finished, fold into other turns than REST returns; after a paged snapshot (`has_more`), the turns before that page are left out unless they started after it, as after an undo;
- a client's latest `session` frame disagrees with REST on `activity`, `pending_interaction`, `last_turn_outcome` or `archived`; a frame without `pending_interaction`, like an `archived` frame, counts as `none`;
- a client got a `session` frame saying nothing is pending while an `interaction` frame it was sent was still pending; that ends once the client stops receiving the session, because it unsubscribed or the last subagent it subscribed to ended, and on an `archived` or `deleted` frame.

Sessions and agents REST no longer knows (HTTP 404 or a `404xx` code), such as a deleted session or a closed side agent, are skipped. `tests/scenarios` turns this on for every scenario. Call `verifyKapInvariants(kap)` yourself when you start KAP with `startKap()`. A test that calls the `kap` fixture function directly passes its test context with the model: `fixtures.kap({ ...context, model }, run)`.

The network guard allows local TCP connections. It checks both numeric ports and port strings accepted by Node, and passes Unix socket paths and Windows named pipes through to Node. For IPv4, use a valid address in the loopback range (`127.0.0.0/8`). When guards overlap, their `allowHosts` lists combine. Uninstalling one guard removes its list.

Failed KAP tests also print summaries of the most recent 32 WebSocket frames and 32 server log entries. Pass the server package’s `createServerLogger` to collect info-level logs in memory for that test. The scenario suite does this by default. Frames show their type, IDs and error code. Logs show their level, message and request ID. The fixture respects an explicit `serverOptions.logger` or `serverOptions.logLevel` and reports when the diagnostic log stream is unavailable.

## The fake model

`createFakeModel(options)` returns a model that answers like a provider:

- `model.fetch` serves requests in process. `await model.listen()` also serves them on `127.0.0.1` with a random port; then `model.baseUrl` is `http://127.0.0.1:<port>/v1` and `model.origin` has no path.
- The request path picks the protocol: OpenAI chat completions (`kimi` and `openai` providers), OpenAI Responses (`…/responses`, the `openai_responses` provider and Kimi's Responses protocol), Anthropic messages, or Google GenAI. `GET …/models` lists `options.models`.
- `fakeModelConfig(model, { type })` produces the provider and model entries for `config.toml`. `startKap` adds them for you. New tests should use the default `kimi` type, because only that type sends the request metadata that routes subagent and compaction requests (see Lanes).
- `alias` names the configured model, `providerAlias` names its provider (defaults to `alias`), and `modelName` is sent to the provider. For example, the desktop fixture registers `e2e/stub` under provider `e2e` and sends `stub` on the wire.

### Scripts and steps

`model.script(...steps)` queues replies for the main lane. Each request takes the next step. A step can also be an async function `(request, { lane, call, signal }) => step`. Its `AbortSignal` fires when the client cancels the request or the model closes while a reply is pending. Pass it to work the script should cancel. The model records the request as aborted and discards a reply that arrives after cancellation. With `model.fetch`, the signal carries the caller's cancellation reason. Over HTTP it signals the disconnect.

| Step | Reply |
|---|---|
| `say(text \| chunks)` | text, one chunk per array entry |
| `{ ...say('ok'), headers: { 'x-request-id': 'example-request' } }` | response headers on a streamed or JSON reply |
| `think(text, then?)`, `thinkSigned(text, signature, then?)` | reasoning before the next step. For OpenAI chat completions, signed reasoning includes the signature in `reasoning_details` in both streaming and non-streaming replies |
| `call(name, args, { text, id, rawArguments, argumentChunks, invalid, extras })` | one tool call. OpenAI and streaming Anthropic can preserve raw argument text. Google and non-streaming Anthropic require a JSON object. `extras` rides on the OpenAI tool call as `extras`; its `thought_signature_b64` becomes a Google `thoughtSignature` |
| `reply(...)`, `batch(...)` | several parts in one reply; `batch` reads as parallel calls |
| `interleave(step)` | interleaves argument pieces of parallel calls in an OpenAI stream |
| `finishWith(reason, step)`, `withUsage(usage, step)` | finish reason and token usage, including cache reads and writes |
| `withResponseId(id, step)` | the reply's ID: OpenAI and OpenAI Responses `id`, Anthropic message `id`, Google `responseId`. Unscripted replies get `testkit-<requestIndex>` |
| `paced(ms, step)`, `after(ms, step)` | delay between chunks, or before the reply |
| `held(name, step, beforeUnit?)` | pauses before a chunk until the test releases it |
| `httpError(status, options)` | an HTTP error with body, headers, `retry-after`, request and trace ids |
| `streamError(step, options)`, `disconnect(step, { afterUsage })` | fails or drops the stream after the step's chunks; `afterUsage` sends the usage chunk before the drop |
| `networkError()`, `rawResponse({ status, headers, chunks })` | a connection reset, or a custom response body built from UTF-8 string chunks |

Tool calls get deterministic ids, `call_<requestIndex>_<callIndex>`; `model.callId(r, c)` returns them.

The model also answers the Kimi files API: `POST …/files` stores the upload and returns a ready file object with ID `file-<uploadIndex>`, and `GET …/files/<id>` returns it again. `model.uploads()` lists each upload's filename, purpose, content types and raw body. After `model.holdUploads()`, uploads stay open until the client gives up, and are then recorded as `aborted`.

When inspecting Google request history, use the IDs in `request.view.messages` to match results to calls. The view preserves explicit wire IDs. Each call with an omitted ID gets its own ID, and results with omitted IDs match pending calls of the same name in order.

A Google user content may open with ordinary parts and carry its function responses after them. The engine builds this when it merges a user message, such as the compaction instruction after a mid-turn tool call, into the tool results it follows, and Gemini accepts that order. The view lists those opening parts as a user message right after the results that follow them, so the sequence check passes. User parts anywhere else in the content, such as between two results, keep their wire position and are still checked.

The tool builders write calls in the wire shape of the engine's tools: `bash`, `read`, `write`, `edit`, `glob`, `grep`, `agent`, `waitFor`, `taskOutput`, `taskStop`, `todoList`, `askUserQuestion`, `exitPlanMode`, `createGoal`, `updateGoal` and `skill`. Their argument types mirror the engine's schemas, and `tests/scenarios/tool-builders.test.ts` checks every argument against the schemas a real engine offers.

### Lanes

Requests are sorted into lanes, and each lane has its own script:

- With the `kimi` provider type, the `X-Msh-Client-Metadata` header gives the role: `main`, `subagent` or `compaction`. `model.lane('subagent').script(...)` scripts a subagent.
- Other provider types send no metadata: requests with tools go to `main`, requests without tools go to `side`.
- `model.route(name, match)` and `model.scriptFor(firstUserTextIncludes, ...)` take requests before the built-in lanes.

### Strict by default

An unscripted request on `main`, `subagent` or `compaction` gets HTTP 400, which the engine does not retry, and the test fails. `lane.unscripted('hang')` holds such requests instead, and `lane.unscripted({ reply })` answers them. Unscripted `side` requests get `options.sideReply`, `OK` by default.

`model.verify()` fails the test when any of these happened:

- a lane with the `fail` policy received a request with no scripted step;
- a step was never used, or a request is still paused at a named hold;
- a message was empty, two adjacent user messages had the same nonempty text, or a tool result was missing, unknown or out of order;
- two tool calls used the same ID while the first call was still awaiting a result;
- a request used the wrong API key or an unknown endpoint;
- a scripted call names a tool the request did not offer, or its arguments break the offered schema: a missing required argument, an unknown argument, or a top-level type or enum mismatch. Pass `{ invalid: true }` to send such a call on purpose. Calls with unparseable `rawArguments` are not checked;
- a main or compaction request does not extend the prompt cache prefix of the previous main request, and the test did not declare the break (see Prompt cache).

`checkMessages: false` disables message sequence checks. `checkCalls: false` disables checks on scripted tool calls. `checkPromptCache: false` disables the prompt cache check. These options apply to the whole model.

When the testkit itself cannot answer (a step function or a route matcher throws, or a step asks for a status or header the transport cannot send), the request gets HTTP 400, which the engine does not retry, and `verify()` reports why.

### Prompt cache

The model keeps a ledger that imitates a provider's prefix cache. `model.promptCache()` returns one entry per request with:

- `lane`, and `role`: the built-in lane that the request's metadata or tools point to, even when a custom route took the request. The one difference is a subagent's compaction: it is scripted on the `compaction` lane, but its role is `subagent`, because it compacts the subagent's own history and is not checked against the main agent;
- `cacheKey`: `prompt_cache_key` for OpenAI chat completions and Responses, `metadata.user_id` for Anthropic, none for Google; and `model`, the model name the request was sent to. Requests without a key carry nothing that tells conversations apart, so all of them to one model count as one conversation: a test that runs several Google sessions gives each its own model;
- `rejected`: whether the request ended with an HTTP or network error, including a hold that failed before the response headers or reset the connection. The provider caches nothing for such a request, so it is never checked or a baseline. Baselines and breaks are worked out when you read them, so a request that arrived while an earlier one was still waiting for its step is compared as if that earlier request had never been sent once it is rejected;
- `totalTokens` and `reusedTokens`, estimated at four characters per token, and `reusedFrom`, the earlier request under the same key and model that shares the longest prefix. These are fixed when the request arrives, because the reused tokens go into its usage;
- for main and compaction requests, `baseline`, the latest main request under the same key and model, and `break`, the first difference from it. A request to another model starts its own baseline, because every model has its own cache. A subagent request that continues a run after tool results (`step_reason: tool_results`) takes as `baseline` that subagent's previous request. The candidates are the earlier subagent requests under the same key and model with the same agent role and parent request that nothing has continued yet, because a run is a chain and each step is continued once. A request that starts a turn is not checked, but it continues the latest such request it extends strictly, as a `/btw` follow-up does with the previous answer: the latest one it extends in full, and otherwise the one whose history shares the most leading segments with it, the latest one on a tie. A step therefore cannot fall back to an older step of its own run and hide a rewrite of the one before it, while two subagents that a parent starts with the same task each continue one of the identical opening requests. The request metadata carries no subagent id, the main agent and its subagents share one key, and forks such as `/btw` open with the main agent's history, so a run's next step is matched by its history rather than by its opening message.

Each request is split into segments in the order the provider caches them. The first segment holds the model, the thinking settings and the structured output schema (`response_format`, the Responses `text` settings, Anthropic `output_config`, Google `responseMimeType` and its response schema), which providers put ahead of the prompt. Then come system, tools and messages for OpenAI and Google, and tools, system and messages for Anthropic. An Anthropic message or a Google content is one segment for its role and one per content block or part, because those providers merge consecutive user messages by appending blocks: an appended block extends the prefix, while a changed block or one put in front still breaks it. Segments are compared as the JSON text that was sent, so a schema whose keys changed order counts as changed. Anthropic `cache_control` markers are ignored, and string content equals a single text block. Reuse stops at the first segment that differs, so the estimate is conservative: everything after a difference counts as uncached.

`verify()` fails when a main or compaction request, or a subagent's next step, does not extend its baseline, unless the test declared the break. One break is allowed without a declaration: the first main request after a compaction request under the same key may start a new history, but its model settings, system and tools must stay the same. Only the `kimi` provider type sends the metadata that marks compaction and subagent requests. With other types, every request with tools counts as a main request, so declare the break after a compaction, and prefer the `kimi` type for tests whose agents start subagents. `model.promptCacheProblems()` returns what the check would report now, for harnesses that report problems without `verify()`. `checkPromptCache: false` turns the check off for the whole model.

Declare every intended break with `model.expectCacheBreak(reason, { at })`, before or after the request, for example undo, clearing the context or media recovery rewriting the history. `at` is `header` (model settings, system or tools) or `history` (messages), and leaving it out accepts either. Breaks consume declarations in request order, and `verify()` also fails on a declaration that no break used. With `checkPromptCache: false`, `expectCacheBreak` throws.

`reportCachedTokens: true` also reports the reused tokens as cache reads in the usage of steps that do not script their own usage (`cached_tokens`, `cache_read_input_tokens` or `cachedContentTokenCount`). The prompt token total stays the same. It is off by default.

The check leaves some cases to the test: side requests, and subagent requests that start a turn (a subagent's first request, a fork such as `/btw`, a resumed subagent's next turn and a subagent's compaction), are recorded but not checked, and a main request under a new cache key starts a new baseline without failing.

### Holds and requests

```ts
model.script(held('slow', say('late answer')));
await kap.prompt(session.id, 'go');
const request = await model.hold('slow').reached();
model.hold('slow').release();
```

A hold can also `fail(status)` before the headers or `cut()` the connection. `model.releaseHeld()` releases every hold a request is waiting at, and leaves holds that no request has reached yet. After parsing and routing, `model.requests(lane?)` and `model.request(index)` expose the raw body, parsed body, headers, metadata, state (`pending`, `streaming`, `held`, `finished`, `aborted`, `cut`, `failed`) and a normalized `view` of system text, tools and messages. Earlier failures such as invalid JSON or a wrong API key appear in `model.problems()`. Helpers include `firstUserText`, `userTextsSinceReply`, `remindersSinceReply` and `texts(role)`. `model.waitForRequest(index | predicate)` waits for a matching record.

For OpenAI chat completions, `request.texts('system')` returns the individual system and developer messages in request order, including empty entries. Use `request.view.system` for the combined prompt across providers.

## The fake Kimi services

`createKimiServices({ accessToken })` answers the Kimi managed services that are not model calls. `services.fetch` serves them in process; `await services.listen()` (or `startKimiServices()`) also serves them on `127.0.0.1`. Point the product at `services.baseUrl`, which ends in `/coding/v1`, through its provider `base_url`, `KIMI_CODE_BASE_URL` or `KIMI_CODE_FEEDBACK_BASE_URL`. Endpoints are matched by the end of the path, so a test can tell two configured deployments apart by giving each its own path prefix under `services.origin`.

- Session titles: `services.title('A title', serviceError(503, 'unavailable'))` queues replies for `POST …/tools` `chat_title` calls, in order.
- Feedback: `POST …/feedback` returns ids from 1, `…/feedback/update` and `…/feedback/upload_url` answer 409 for an id the services did not hand out, and the upload URL points at `services.origin`. Storage rejects an `Authorization` header or a method other than the signed one (`services.uploadMethod('POST')` changes it). `services.feedback()` lists each submission with its updates, uploads, stored bytes and completion.
- `services.holdNext('title' | 'storage' | …)` holds the next request to that endpoint; `hold.reached()` resolves with the request and `hold.release()` lets it answer. A request whose client gives up while held is dropped.
- `services.requests(endpoint?)` lists every request with its path, headers, `authorization` and parsed JSON. With `accessToken` set, a wrong bearer token gets 401 and fails `verify()`.

`services.verify()` fails on an unexpected request, a title request with no scripted reply, a scripted title nobody asked for, a hold never reached or never released, an upload completed before its bytes reached storage, with the wrong etag or for an unknown upload, and a storage request that carried a token or used the wrong method. `packages/oauth/test/kimi-services-contract.test.ts` drives the real managed clients against these services.

## The KAP harness

`startKap({ startServer, model, provider, config, mcpServers, env, serverOptions, home, token })` writes `config.toml` into a temporary home with the fake model as the default model and model-catalog refresh turned off, writes `mcpServers` (from `fakeMcpServer`) into `mcp.json`, points `HOME` at that home, and starts the server on `127.0.0.1` with a random port, silent logs and no instance registry.

| Method | What it does |
|---|---|
| `createSession`, `session`, `prompt`, `steer`, `prompts`, `cancel`, `undo`, `fork`, `compact` | the REST calls of the same names |
| `turns(sessionId, agentId?)` | every persisted turn, across pages |
| `interactions`, `answer`, `waitForInteraction` | pending approvals and questions |
| `wait(sessionId, ms)` | returns one long-poll result, including pending interactions and whether the poll timed out |
| `waitIdle(sessionId, { onInteraction })` | waits for the active prompt and queue to clear. A pending interaction requires an answer or an `onInteraction` handler |
| `connect()` | a `KapSocket` that answers server pings, with `subscribe`, `command`, `waitFor`, `conversation` and `turns` |
| `restart()` | restarts the server on the same home and token |
| `rest` | a `KapRest` client for routes without a helper |
| `server` | the running server returned by `startServer`, including `core` and `app` for white-box tests that need its internals |

`socket.subscribe(sessionId, { agentIds })` waits for each agent's initial snapshot. Repeating a subscription reuses snapshots on that connection. A `turns.failed` snapshot raises a `KapCommandError` carrying the server’s code, message, session and agent. Set `waitForSnapshot: false` to wait for the command acknowledgement alone.

`socket.turns(sessionId)` rebuilds turns from the live frames. After `turn.ended` has arrived it equals `kap.turns(sessionId)`, which is how a test checks that streaming and persistence agree.

## Engine behaviors worth knowing

- The engine retries 408, 409, 429, 500, 502, 503, 504 and 529 with a backoff that starts at 0.5 s, up to 10 attempts per step. Use a 400 to fail a turn fast.
- For OpenAI and Anthropic, use `httpError(status, { retryAfterSeconds })` to supply a `retry-after` header in seconds. For Google the fake also encodes this delay in the error body's `google.rpc.RetryInfo`.
- A reply with no finish reason, or with reasoning only, is retried.
- A new tool-call index ends the previous call, so `interleave` exercises client robustness, not an engine happy path.
- Google clients detect a mid-stream error only when its JSON arrives as a chunk of its own. The fake model lets the client drain earlier chunks before it sends one.

## Known limitations

- Request indexes and the default tool-call ids follow arrival order. When subagents run concurrently, find their requests by lane and content (`waitForRequest(predicate)`) and take ids from `model.callId(request.index, k)`, or give the calls fixed ids with `call(name, args, { id })`.
- `startKap` points `process.env.HOME` at the test home while the server runs, because user-level skills are read from the OS home. Do not run KAP tests concurrently in one worker.
- Not built yet: the OpenAI responses API, general model recording/replay, and an ACP driver in this package. The terminal session driver lives in the CLI tests and starts the CLI through `TestProcess`. See the [testing guide](../../tests/AGENTS.md).
