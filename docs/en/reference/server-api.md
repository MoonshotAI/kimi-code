<script setup>
import { onMounted } from 'vue'
import { redirectLegacyServerApiAnchor } from '../../.vitepress/theme/serverApiLegacyAnchors'

onMounted(() => redirectLegacyServerApiAnchor('en'))
</script>

# Server API (Beta)

The local server started by `kimi web` exposes two interfaces: a REST API (`/api/v1`) and a WebSocket event stream (`/api/v1/ws`). Scripts and third-party clients can use them to create sessions, submit prompts, receive the conversation in real time, and manage configuration, models, and workspaces. For how to start the server and its command-line options, see [kimi command](./kimi-command.md#kimi-web).

::: warning Note
These APIs are experimental, and their stability is not guaranteed: endpoints, fields, and event types may change in any release. When integrating, rely on the `/openapi.json` and `/asyncapi.json` documents served by your version.
:::

This page covers the conventions shared by all endpoints and walks through the complete flow with a minimal example. The details of each group of endpoints are split across these pages:

- [Sessions and conversations](./server-api-conversation.md): the WebSocket protocol, and how a client subscribes to a session, displays the conversation, submits input, handles approvals and tasks, and recovers after a disconnect. Start here when writing a client.
- [Session endpoints](./server-api-sessions.md): creating, listing, and modifying sessions, session actions (fork, compaction, undo, and more), paginated reads of messages and turns, and the REST endpoints for prompts and interactions.
- [Service and configuration endpoints](./server-api-service.md): server info, login and usage, Remote Control, configuration, models and providers, skills and MCP, plugins, workspaces, file uploads, and global search.
- [File endpoints](./server-api-files.md): reading and writing files in the session directory, the workspace, and the local machine, and the HTTP behavior of download endpoints.

## Online schemas

These pages are a curated, human-readable reference. The precise machine-readable definition of every endpoint is owned by two documents the server provides at runtime: `GET /openapi.json` (REST, in OpenAPI format) and `GET /asyncapi.json` (WebSocket, in AsyncAPI format). Both are generated from the validation schemas the server actually enforces, and both require authentication. When this page and the online schemas disagree, the online schemas win.

## Address

The default address is `http://127.0.0.1:58627`. When the port is taken, the server tries the next port, up to 100 times. Use `--port` and `--host` to change the bind address.

Multiple instances can run under the same home directory at once. Running instances register under `~/.kimi-code/server/instances/`.

## Authentication

All `/api/*` paths, plus `/openapi.json` and `/asyncapi.json`, require the bearer token. The only exceptions are these three kinds of requests:

- `OPTIONS` preflight requests;
- `GET /api/v1/healthz` (liveness probe);
- static web assets (paths outside `/api/`).

REST requests carry the token in the `Authorization: Bearer <token>` header. The WebSocket upgrade request accepts the same header or the subprotocol `kimi-code.bearer.<token>`. Token generation and rotation are covered in [Using Kimi Code in the browser](../guides/web.md#getting-started).

Failed authentication returns HTTP 401 with envelope `code` `40101`. When the server binds a non-loopback address, a source that fails authentication 10 times within 60 seconds is banned for 60 seconds. During the ban, every request gets HTTP 429 with `code` `42901`.

## Response envelope

Every JSON response is wrapped in the same envelope:

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

| Field | Description |
| --- | --- |
| `code` | The business outcome. `0` means success; see [Error codes](#error-codes) for other values |
| `msg` | A description of the outcome |
| `data` | The payload on success. Some errors also carry `data`: for example, an undo that cannot run returns `40911` with `data` set to `{ reason, requestedCount, undoableCount }`. Clients should check `code` first, then read `data` |
| `request_id` | A ULID for this request. Clients may supply one in the `X-Request-Id` header; the server regenerates invalid values |

The HTTP status is almost always 200, and the business outcome lives in `code`. The exceptions are:

| Situation | HTTP status |
| --- | --- |
| Authentication failure / rate limit | 401 / 429 |
| Provider created, provider catalog imported (`:import_catalog`), or custom registry imported (`:import_registry`) | 201; the body is still an envelope with `code` `0` |
| Provider deleted | 204, with no body |
| Binary and streaming endpoints | 206 (Range) and 304 (ETag unchanged) where supported. Capabilities differ per endpoint; see [Binary and streaming endpoints](./server-api-files.md#binary-and-streaming-endpoints) |
| Errors from `GET /api/v1/files/{file_id}`, `GET /api/v1/fs:content`, and session file `:download` | Real 4xx / 500 statuses; the body is still an envelope |

## Error codes

Error codes are grouped into bands by their first three digits:

| Band | Meaning | Examples |
| --- | --- | --- |
| `0` | Success | |
| `400xx` | Bad request | `40001` validation failed (`details` lists each field), `40003` provider is OAuth-managed, `40006` duplicate workspace source folder |
| `401xx` | Auth and readiness | `40101` unauthorized, `40110` no provider configured, `40113` model not resolved |
| `404xx` | Not found | `40401` session, `40408` MCP server, `40409` file path |
| `409xx` | State conflict | `40901` session busy, `40902` interaction already ended, `40922` query conditions do not match `page_token`, `40931` session in use by another client, `40932` session updated by another client, `40935` Tower mode cannot be entered |
| `413xx` | Size or range exceeded | `41302` file read over 10 MB, `41304` path outside the session directory |
| `429xx` | Rate limited | `42901` auth-failure ban, `42902` too many file watches |
| `500xx` | Server internal error | `50001` uncaught exception, `50003` persistence failure |
| `6xxxx` / `7xxxx` / `8xxxx` | Errors passed through from the tool runtime, LLM providers, and MCP | `msg` keeps the upstream text |

The error codes each endpoint may return are listed at the end of its description.

### When several clients open the same session

`40931` and `40932` only appear when the same session is open in several clients.

- **`40931`**: another Kimi Code process is writing to the session. Retry after it goes idle. If you are sure that process has exited and only left its lock behind, call [`POST /api/v1/sessions/{session_id}:takeover`](./server-api-sessions.md#post-api-v1-sessions-session-id-takeover) first, then retry.
- **`40932`**: another client has updated the session. When this happens to prompt submission, skill activation, or compaction, the server reloads the session, sends subscribers a fresh `turns` frame, and runs the request again, so the caller never sees `40932`. Only undo returns `40932`: the server has already reloaded the session, and nothing was undone this time. The client should let the user review the refreshed history before deciding whether to undo.

## Pagination

List endpoints page in one of two ways:

- **Cursor pagination**: `before_id` or `after_id` (mutually exclusive) plus `page_size` (1–100), responding with `items` and `has_more`. The message list, child-session list, and flat session list support it. Agent turns are the exception: they page by the turn's `ordinal` (`before_ordinal` plus `page_size`).
- **`page_token` pagination**: the token is opaque and bound to the query conditions. `GET /api/v1/sessions` and `POST /api/v1/search` use it. Changing any query condition while paging invalidates the token: `/api/v1/sessions` returns `40922`, and search returns `40001`. `GET /api/v1/sessions` also offers a stateless `page` page-number mode.

## Action paths

Operations on a single resource other than create, read, update, and delete use a path that ends in `:action` and are called with POST, for example `POST /api/v1/sessions/{session_id}:fork` and `POST /api/v1/sessions/{session_id}:archive`.

## Drive a session over the API

This walkthrough runs the minimal flow with curl: check the server, create a session, subscribe to events, submit a prompt, and read the history back. The examples assume the server runs at the default address and the token is stored in the shell variable `TOKEN`.

1. Check server status:

   ```sh
   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/api/v1/meta
   ```

2. Create a session, using `metadata.cwd` to set the working directory:

   ```sh
   curl -s -X POST http://127.0.0.1:58627/api/v1/sessions \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"metadata": {"cwd": "/path/to/project"}}'
   ```

   The `data.id` in the response (shaped like `session_...`) is the session id used by later requests.

3. Connect to the WebSocket and subscribe to the session. Any WebSocket client works. Below is a dependency-free Node.js script (Node.js 22 and later ship a built-in `WebSocket` client):

   ```js
   // subscribe.mjs. Usage: TOKEN=... node subscribe.mjs session_...
   const ws = new WebSocket('ws://127.0.0.1:58627/api/v1/ws', [
     `kimi-code.bearer.${process.env.TOKEN}`,
   ]);
   ws.onmessage = (e) => console.log(e.data);
   ws.onopen = () =>
     ws.send(
       JSON.stringify({
         type: 'subscribe',
         request_id: '1',
         session_id: process.argv[2],
       }),
     );
   ```

4. Submit a prompt:

   ```sh
   curl -s -X POST http://127.0.0.1:58627/api/v1/sessions/<session_id>/prompts \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"content": [{"type": "text", "text": "Describe this repository in one sentence"}]}'
   ```

   The subscriber first gets a `turns` frame with the main agent's latest turns. It then receives, in order: `turn.started` (the turn begins), `item.ended` for the prompt, `item.started`, `item.delta`, and `item.ended` as reasoning, the reply, and tool calls stream, `turn.updated` as each step ends, and finally `turn.ended` (the turn finishes). See [Live updates](./server-api-conversation.md#live-updates) for what these frames mean.

5. Read the message history back over REST at any time:

   ```sh
   curl -s -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:58627/api/v1/sessions/<session_id>/messages?page_size=20"
   ```

## Next steps

- [Sessions and conversations](./server-api-conversation.md): the WebSocket protocol and the client flow
- [Using Kimi Code in the browser](../guides/web.md): start the server and use Kimi Code in a browser
- [kimi command](./kimi-command.md#kimi-web): all `kimi web` command-line options
