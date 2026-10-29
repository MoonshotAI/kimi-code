# Internal central AgentLoop server (M1)

This is an experimental, single-writer deployment mode for an intranet. One `kap-server`/`agent-core-v2` process owns one `KIMI_CODE_HOME`; every REST/WS client reads and mutates the same session state. Do not start a second writer against that home.

## Enable and provision users

Enable the experiment with `KIMI_CODE_EXPERIMENTAL_INTERNAL_CENTRAL_SERVER=1`. The existing `server.token` and RPC token remain valid for compatibility and resolve to the stable principal `local-server`. Independent users authenticate with their own bearer tokens; request headers never select the user.

Provision users before starting the server:

```ts
import { registerCentralUser } from '@moonshot-ai/kap-server';

const alice = await registerCentralUser({
  homeDir: '/srv/kimi-central/home',
  userId: 'alice',
  displayName: 'Alice',
});
const oneTimeToken = alice.token;
```

`registerCentralUser` returns the plaintext token once. It writes only a SHA-256 token hash to `<home>/server/central-users.json` with mode `0600`; user IDs and display names are stable. Do not log the returned token. A supplied token may be used for deterministic test provisioning. The authenticator accepts user tokens only when the experimental flag is enabled, and invalid credentials never fall back to a user named in a request header.

Clients can verify the authenticated principal with `GET /api/v1/auth/principal`:

```json
{ "user_id": "alice", "display_name": "Alice" }
```

## Shared-session API semantics

All sessions are shared within the team; M1 does not add ACLs or multi-tenancy. Client-local state such as `activeSession`, editor drafts, selected tabs and per-profile UI preferences is not synchronized by this feature.

- `POST /api/v1/sessions/{id}/prompts` accepts every valid prompt from every authenticated user. The service keeps one active turn and queues other prompts in the order in which the server actually submits them. Existing `prompt_id` conflict and validation protections remain in force.
- Prompt responses and prompt-list items carry `submitted_by` when the prompt has a known user origin.
- `POST /api/v1/sessions/{id}/prompts:steer` returns `steered_by` for the authenticated user who performed the steer.
- `POST /api/v1/sessions/{id}/interactions/{interaction_id}` returns `resolved_by`. The first valid approval/question response completes the interaction; a competing response returns `INTERACTION_ENDED`.
- WS interaction frames carry `resolved_by`. Transcript prompt entities carry `actor` and `steeredBy`; transcript interaction entities carry `resolvedBy`. These fields are optional so existing clients and older sessions remain valid.

A typical actor object is:

```json
{ "user_id": "alice", "display_name": "Alice" }
```

Core `agent-core-v2` and transcript models use the corresponding `{ "userId": "alice", "displayName": "Alice" }` shape.

Existing health, version and meta routes already provide the required centralized-server bootstrap information; M1 adds no duplicate health or version endpoint.

## M2 device Runtime and bridge

M2 adds an FS-only `RemoteRuntimeProviderFactory` without changing session, queue, transcript, or AgentLoop ownership. One central writer still owns each `KIMI_CODE_HOME`; a Desktop supplies only filesystem operations for explicitly authorized directories. It does not supply process execution, a terminal, or another AgentLoop writer.

Protocol v1 currently accepts POSIX device paths only. A Windows `path_class` is rejected with `runtime.unsupported` instead of being interpreted with the central host's path rules. Remote workspaces support one primary authorized root and no `additional_dirs` in this iteration.

### Connection and identity

Desktop makes an outbound WebSocket connection to `/api/v1/devices/bridge`; it never listens for inbound connections. Authenticate the upgrade with the same independent user Bearer token as M1, using either the `Authorization` header or the existing `kimi-code.bearer.<token>` WebSocket subprotocol. Tokens are not accepted in the URL and are not logged. There is no device-specific PKI.

The first frame must be `device.hello`:

```json
{
  "type": "device.hello",
  "protocol_version": 1,
  "device_id": "desktop-a",
  "display_name": "Alice Desktop",
  "connection_id": "conn-unique-1",
  "environment": {
    "os_kind": "macOS",
    "os_arch": "arm64",
    "os_version": "15.0",
    "shell_name": "bash",
    "shell_path": "/bin/bash",
    "path_class": "posix",
    "home_dir": "/Users/alice"
  },
  "capabilities": { "fs": true, "process": false, "terminal": false }
}
```

A successful connection receives `device.welcome` with the same `device_id` and `connection_id`, plus a server-assigned `generation` such as `g_1` and the protocol limits. A second simultaneously active `device_id` or `connection_id` is rejected with `device.conflict`. Every runtime request and response carries `device_id`, `connection_id`, `generation`, `request_id`, and `protocol_version`. Responses from a stale generation are ignored and can never settle a request from the current generation.

The bridge uses JSON text frames and base64 for binary values. Limits are 16 MiB per frame, 10 MiB per text/binary payload, 32 pending requests per device, and 4 MiB of socket buffering before `runtime.busy` is returned. The default RPC timeout is 15 seconds. Protocol errors fail the call or connection; there is no implicit fallback and no automatic write replay. Reads are not retried automatically either, so a caller can apply its own explicit idempotency policy.

### Authorization and workspace binding

Only the connected Desktop can authorize a directory after its local folder-selection flow. It sends:

```json
{
  "type": "device.command",
  "request_id": "root-1",
  "command": "root.register",
  "root": { "path": "/Users/alice/project", "display_name": "Project" }
}
```

The server calls `device.inspect_root` on that same connection and persists the canonical real path, the registering user, and the connection/generation in `<KIMI_CODE_HOME>/server/device-catalog.json` with mode `0600`. A `device.result` contains the root in the bridge's internal camelCase form: `root`, `displayName`, `registeredBy: { userId, displayName }`, `registeredAt`, `connectionId`, and `generation`. No REST endpoint can create or claim an authorized root.

The same bridge-only command channel accepts `root.unregister` with `root: { path }`. Its result is `{ root, revoked: true }`; the server removes the persisted authorization and emits the updated device catalog. Every later FS RPC re-checks the current catalog and fails with `runtime.denied` after revocation. REST clients cannot register or revoke roots.

`POST /api/v1/workspaces` accepts an existing local workspace request or a remote request with `root`, `runtime_id: "desktop:<deviceId>"`, optional `name`, and optional `idempotency_key`. The root must exactly match an already authorized canonical root; arbitrary REST clients cannot add roots indirectly. Remote creation validates the device online state and current root without calling the central host's `hostFs.stat` on the remote path. Workspace responses add optional `runtime_id` and `device_id`. Managed workspace IDs remain globally unique even when two devices expose the same path string.

`GET /api/v1/devices` returns devices, online state, environment, capabilities, and authorized roots. Root/user objects use the REST snake_case forms `registered_by` and `connected_by`. `GET /api/v1/runtimes` returns central `local` plus `desktop:<deviceId>` entries and explicit `fs`, `process`, and `terminal` capabilities. Existing app WS connections receive a global `event.device.updated` envelope whose payload contains the complete `device` object whenever a connection, root registration, or root revocation changes. `GET /openapi.json` and `GET /asyncapi.json` include the REST and bridge contracts.

### Runtime RPC

After authorization, the central server sends `runtime.rpc`:

```json
{
  "type": "runtime.rpc",
  "protocol_version": 1,
  "device_id": "desktop-a",
  "connection_id": "conn-unique-1",
  "generation": "g_1",
  "request_id": "request-uuid",
  "method": "fs.read_bytes",
  "params": { "path": "/Users/alice/project/image.png", "n": 65536, "offset": 0 },
  "timeout_ms": 15000
}
```

Desktop responds with `runtime.result` and a `result` value, or `runtime.error` with `error: { code, message, retryable?, uncertain? }`; all identity fields must match the request. The supported methods and result shapes are:

| Method | Params beyond `path` | Result |
| --- | --- | --- |
| `device.inspect_root` | none | `{ root, is_directory: true }` |
| `fs.realpath` | none | `{ path }` |
| `fs.read_text` | `encoding?`, `errors?` | `{ text }` |
| `fs.write_text` / `fs.append_text` | `data` | `null` |
| `fs.read_bytes` | `n?`, `offset?` | `{ base64 }` |
| `fs.write_bytes` | `base64` | `null` |
| `fs.create_exclusive` | `base64` | `{ created }` |
| `fs.stat` / `fs.lstat` | none | `{ is_file, is_directory, is_symbolic_link?, size, mtime_ms?, ino? }` |
| `fs.readdir` | none | Array of `{ name, is_file, is_directory, is_symbolic_link? }` |
| `fs.mkdir` | `recursive` | `null` |
| `fs.remove` | none | `null` |
| `fs.rename` | `next_path` | `null` |

`IHostFileSystem.readLines` is implemented over bounded `readText`, not an unbounded stream. Every request has a `requestId`. A disconnect or timeout before a write result is known produces `runtime.write_uncertain` with `uncertain: true`; it is never retried blindly. Device `os.fs.*` failures are normalized to familiar `ENOENT`/`ENOTDIR`/`EACCES`/`EEXIST`/`EISDIR` values where applicable.

The server validates lexical root containment and real paths before remote operations. The Desktop must independently enforce the same allowlist and realpath policy and remains the final local security boundary. Symlinks escaping an authorized root are denied. No general mobile/other-client file save API is added.

### Tool and client behavior

- Agent `Read`, `Write`, and `Edit` use the bound remote `IHostFileSystem`, including text, binary, stat/lstat, readdir, mkdir, remove, rename, create-exclusive, and realpath dependencies.
- Agent `Glob` and `Grep` require `process` on the current main and are unavailable on a Desktop FS-only runtime. `Bash`, Git, tests, PTY, and all other process execution are also unavailable and can never run on the central host as a fallback.
- Existing workspace FS `list`, `read`, `download`, `search`, `suggest`, and `grep` routes accept `runtime_id`. Search/suggest/grep can use the existing Remote FS node fallback without a process. `git_status` and `diff` still require `process` and are unsupported remotely.
- A remote session inherits its workspace runtime by default. Unknown runtimes return `runtime.not_found`; offline devices return `runtime.unavailable`; unauthorized roots return `runtime.denied`; unsupported protocol/capabilities return `runtime.unsupported`. None of these paths starts another session writer or falls back to `local`.
- Device disconnection fails current reads and marks uncertain writes, while the central session and queue retain their identity. Reconnection creates a new runtime generation without restarting the central AgentLoop.

REST errors use `details.runtime_error: { code, retryable?, uncertain? }`. Numeric codes are `40420 RUNTIME_NOT_FOUND`, `40926 RUNTIME_UNAVAILABLE`, `40301 RUNTIME_DENIED`, `40933 RUNTIME_UNSUPPORTED`, `50301 RUNTIME_WRITE_UNCERTAIN`, `50401 RUNTIME_TIMEOUT`, and `41302 FS_TOO_LARGE` for payload-limit failures.

M2 does not implement Desktop main, deployment, distributed transactions, HA, remote process execution, or a CDN/relay integration. `packages/kap-server/test/deviceBridge.test.ts` is the fake-Desktop protocol and end-to-end reference for the app integration.

## Desktop M1 integration

Use a complete server profile per environment, keyed by `serverId`; do not mix session, workspace, credential or draft state between profiles. Configure the central base URL and the user's independent bearer token, and fail closed if the external server cannot be reached instead of starting an embedded writer. Read session lists/details/transcripts over REST, subscribe over WS, and use the actor fields above to show who submitted a prompt, steered it or resolved an interaction. Existing local-only operation can continue to use the legacy token, which maps to `local-server`.
