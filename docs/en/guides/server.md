# Local Server and API

Kimi Code CLI ships with a built-in local server: running `kimi web` starts a foreground process that mounts three things at once — the web UI in your browser, a REST API (`/api/v1`), and a WebSocket event stream (`/api/v1/ws`). The web UI lets you use Kimi Code in a browser; the REST and WebSocket APIs are for scripts and third-party tools, letting you create sessions, submit prompts, and follow execution from code — all reading and writing the same session data as the TUI and the web UI.

> Make sure Kimi Code CLI is installed and ready to use first — either logged in via `/login` (in the TUI, or `kimi login`), or with a provider configured in `config.toml`. The server shares the CLI's login state and configuration, so no separate credential is needed for it.

::: warning
The REST and WebSocket APIs described on this page are experimental: interface stability is not guaranteed, and endpoints, fields, and event types may change in any release. When integrating, rely on the `/openapi.json` and `/asyncapi.json` documents served by your version.
:::

## Start the server

```sh
kimi web                 # run the server in the foreground and open the browser
kimi web --no-open       # run the server only, don't open the browser
kimi web --port 58628    # pick a specific bind port
```

The server binds to `127.0.0.1:58627` by default (loopback only). If the port is taken it automatically retries with the next one, so multiple instances can coexist on the same machine; each instance registers under `~/.kimi-code/server/instances/`. The startup banner prints the access URL and the plaintext token:

```text
Local:   http://127.0.0.1:58627/#token=...
Token:   ...
Stop:    Ctrl+C
```

The server runs in the foreground; press `Ctrl-C` for a clean shutdown. For the full option list such as `--host` and `--log-level`, see the [kimi command reference](../reference/kimi-command.md#kimi-web).

## Authentication

Every `/api/*` endpoint requires a bearer token (any request carrying this string is treated as authorized). The token is generated on the first server boot, persisted at `~/.kimi-code/server.token` (file mode 0600), and reused across restarts.

Pick the carrying method that fits your client:

- **REST**: the `Authorization: Bearer <token>` request header.
- **web UI**: the URL in the startup banner carries a `#token=` fragment, so opening it in a browser completes sign-in automatically. The fragment is never sent to the server.
- **WebSocket**: clients that can set headers use `Authorization: Bearer`; clients that cannot (such as browsers) pass the subprotocol (a protocol name declared during the WebSocket handshake) `kimi-code.bearer.<token>` instead.

If the token leaks, run `kimi web rotate-token`: the new token is written to `server.token` immediately, the old one stops working at once, and running instances pick up the new token without a restart.

If you bind the server to a non-loopback address (`--host`), also set the `KIMI_CODE_PASSWORD` environment variable as a parallel credential; the server then rate-limits authentication failures automatically.

::: danger
`--dangerous-bypass-auth` disables authentication entirely — anyone who can reach the port can control your sessions, file system, and shell. Only use it on trusted networks or behind your own authenticating proxy. See the [kimi command reference](../reference/kimi-command.md#kimi-web).
:::

## Drive a session over the API

The minimal flow with curl: check the server → create a session → subscribe to events → submit a prompt → read history back. The examples assume the server runs at the default address and the token is stored in the shell variable `TOKEN`.

1. Check server status:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/api/v1/meta
```

Every JSON response is wrapped in a uniform envelope — `{ "code": 0, "msg": "success", "data": ..., "request_id": "..." }`. The business outcome lives in `code` (`0` means success); the HTTP status only reports transport-level results.

2. Create a session; `metadata.cwd` sets the working directory:

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"cwd": "/path/to/project"}}'
```

The returned `data.id` (shaped like `session_...`) is the session id used by every subsequent request.

3. Connect to the WebSocket and subscribe to session events. Any WebSocket client works; below is a dependency-free Node.js script (Node.js 22+ ships a built-in `WebSocket` client):

```js
// subscribe.mjs — usage: TOKEN=... node subscribe.mjs session_...
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

4. Submit a prompt:

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions/<session_id>/prompts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": [{"type": "text", "text": "Introduce this repository in one sentence"}]}'
```

The subscriber sees, in order: `turn.started` (turn begins) → `assistant.delta` (streaming text increments) → `tool.call.started` / `tool.result` when tool calls happen → `turn.ended` (turn finishes).

5. Read history back over REST at any time:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:58627/api/v1/sessions/<session_id>/messages?page_size=20"
```

## Live specification documents

While running, the server describes itself with two specification documents, both requiring the bearer token:

- `GET /openapi.json` — an OpenAPI document for the REST API, with request/response schemas for every endpoint; import it into Swagger UI, Postman, and similar tools.
- `GET /asyncapi.json` — an AsyncAPI document for the WebSocket protocol, covering control frames and event types.

## Next steps

- [Server API](../reference/server-api.md) — full REST endpoint inventory, error codes, WebSocket events, and the transcript protocol
- [kimi command](../reference/kimi-command.md#kimi-web) — all `kimi web` command-line options
