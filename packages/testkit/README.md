# @moonshot-ai/testkit

Shared test infrastructure for this repository: a protocol-level fake model, a driver for the Kimi Agent Protocol (KAP), and the fixtures around them. The package depends on no `@moonshot-ai/*` package, so the tests of any package can use it. Code that needs a product package, such as the server, is passed in by the caller.

| Import | What it provides |
|---|---|
| `@moonshot-ai/testkit/model` | the fake model, the step DSL, tool-call builders, and the provider config that points the product at the fake model |
| `@moonshot-ai/testkit/kap` | `startKap`: an in-process KAP server backed by the fake model; `KapProcess`: the CLI's `web --json` server in a child process; `KapClient`: the session operations both of them share, with REST and WebSocket clients and a turn reducer |
| `@moonshot-ai/testkit/fixtures` | temporary homes, a `config.toml` writer, git repositories with a linked worktree, environment isolation, the network guard, child processes that stay offline, the CLI command and environment, repository paths, directory snapshots, waits, timeouts, media samples and normalizers |
| `@moonshot-ai/testkit/contract` | a field-per-line summary of OpenAPI and AsyncAPI documents, a check that lists contract changes as breaking, non-breaking or unclassified, and a digest that ignores wording, for pinning an API level |
| `@moonshot-ai/testkit/vitest` | fixture definitions for `test.extend` and the network guard hooks |

## Writing a test

This is a private workspace package. When adopting it in another package, add `"@moonshot-ai/testkit": "workspace:^"` to that package's `devDependencies` and run `pnpm install` at the repository root. Choose a guide by what the test needs to observe.

| What you want to test | Guide |
|---|---|
| What a provider client sends and how it parses the reply | [假模型与 SDK 测试](docs/model.md) |
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

The network guard allows local TCP connections. It checks both numeric ports and port strings accepted by Node, and passes Unix socket paths and Windows named pipes through to Node. For IPv4, use a valid address in the loopback range (`127.0.0.0/8`). When guards overlap, their `allowHosts` lists combine. Uninstalling one guard removes its list.

Failed KAP tests also print summaries of the most recent 32 WebSocket frames and 32 server log entries. Pass the server package’s `createServerLogger` to collect info-level logs in memory for that test. The scenario suite does this by default. Frames show their type, IDs and error code. Logs show their level, message and request ID. The fixture respects an explicit `serverOptions.logger` or `serverOptions.logLevel` and reports when the diagnostic log stream is unavailable.

## The fake model

`createFakeModel(options)` returns a model that answers like a provider:

- `model.fetch` serves requests in process. `await model.listen()` also serves them on `127.0.0.1` with a random port; then `model.baseUrl` is `http://127.0.0.1:<port>/v1` and `model.origin` has no path.
- The request path picks the protocol: OpenAI chat completions (`kimi` and `openai` providers), Anthropic messages, or Google GenAI. `GET …/models` lists `options.models`.
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
| `withResponseId(id, step)` | the reply's ID: OpenAI `id`, Anthropic message `id`, Google `responseId`. Unscripted replies get `testkit-<requestIndex>` |
| `paced(ms, step)`, `after(ms, step)` | delay between chunks, or before the reply |
| `held(name, step, beforeUnit?)` | pauses before a chunk until the test releases it |
| `httpError(status, options)` | an HTTP error with body, headers, `retry-after`, request and trace ids |
| `streamError(step, options)`, `disconnect(step, { afterUsage })` | fails or drops the stream after the step's chunks; `afterUsage` sends the usage chunk before the drop |
| `networkError()`, `rawResponse({ status, headers, chunks })` | a connection reset, or a custom response body built from UTF-8 string chunks |

Tool calls get deterministic ids, `call_<requestIndex>_<callIndex>`; `model.callId(r, c)` returns them.

The model also answers the Kimi files API: `POST …/files` stores the upload and returns a ready file object with ID `file-<uploadIndex>`, and `GET …/files/<id>` returns it again. `model.uploads()` lists each upload's filename, purpose, content types and raw body. After `model.holdUploads()`, uploads stay open until the client gives up, and are then recorded as `aborted`.

When inspecting Google request history, use the IDs in `request.view.messages` to match results to calls. The view preserves explicit wire IDs. Each call with an omitted ID gets its own ID, and results with omitted IDs match pending calls of the same name in order.

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
- a scripted call names a tool the request did not offer, or its arguments break the offered schema: a missing required argument, an unknown argument, or a top-level type or enum mismatch. Pass `{ invalid: true }` to send such a call on purpose. Calls with unparseable `rawArguments` are not checked.

`checkMessages: false` disables message sequence checks. `checkCalls: false` disables checks on scripted tool calls. Both options apply to the whole model.

When the testkit itself cannot answer (a step function or a route matcher throws, or a step asks for a status or header the transport cannot send), the request gets HTTP 400, which the engine does not retry, and `verify()` reports why.

### Holds and requests

```ts
model.script(held('slow', say('late answer')));
await kap.prompt(session.id, 'go');
const request = await model.hold('slow').reached();
model.hold('slow').release();
```

A hold can also `fail(status)` before the headers or `cut()` the connection. `model.releaseHeld()` releases every hold a request is waiting at, and leaves holds that no request has reached yet. After parsing and routing, `model.requests(lane?)` and `model.request(index)` expose the raw body, parsed body, headers, metadata, state (`pending`, `streaming`, `held`, `finished`, `aborted`, `cut`, `failed`) and a normalized `view` of system text, tools and messages. Earlier failures such as invalid JSON or a wrong API key appear in `model.problems()`. Helpers include `firstUserText`, `userTextsSinceReply`, `remindersSinceReply` and `texts(role)`. `model.waitForRequest(index | predicate)` waits for a matching record.

For OpenAI chat completions, `request.texts('system')` returns the individual system and developer messages in request order, including empty entries. Use `request.view.system` for the combined prompt across providers.

## The KAP harness

`startKap({ startServer, model, provider, config, env, serverOptions, home, token })` writes `config.toml` into a temporary home with the fake model as the default model and model-catalog refresh turned off, points `HOME` at that home, and starts the server on `127.0.0.1` with a random port, silent logs and no instance registry.

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
- Not built yet: the OpenAI responses API, general model recording/replay, an ACP driver in this package, and fake MCP servers. The terminal session driver lives in the CLI tests and starts the CLI through `TestProcess`. See the [testing guide](../../tests/AGENTS.md).
