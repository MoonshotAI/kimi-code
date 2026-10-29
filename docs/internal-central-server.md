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

## M2 device Runtime/bridge extension point

M2 should add a device provider, not change the ownership of session state or add another AgentLoop writer. The extension points are `RuntimeProviderFactory`, `WorkspaceInstanceManager.addProvider()`, `IAgentRuntimeService` and the existing `runtime_id` route fields. A provider can expose `desktop:<deviceId>` as a runtime ID and bind it per workspace.

The device bridge should use an authenticated outbound channel to the central server, a stable device ID, and an explicit per-device root allowlist. Device credentials can reuse the M1 authenticated-user identity; no device-specific PKI is required. Unknown runtime IDs must continue to fail closed with `RUNTIME_NOT_FOUND` and must never fall back to the development machine's `local` runtime or same-named path.

M2's intended capability is FS-only `Read`/`Write`/`Edit` plus their required path operations. The remote `IHostFileSystem` surface to review and implement as needed is `readText`, `writeText`, `appendText`, `readBytes`, `writeBytes`, `readLines`, `createExclusive`, `stat`, `lstat`, `readdir`, `mkdir`, `remove` and `realpath`. `Glob`/`Grep`/`Bash`/Git/test/PTY/process execution is outside M2 and should report the execution environment as unavailable or unsupported. A disconnected device also fails closed; it must not silently execute against the central host.

M1 does not implement the remote FS bridge, a device runtime, a deployment profile manager, or any CDN/relay integration.

## Desktop M1 integration

Use a complete server profile per environment, keyed by `serverId`; do not mix session, workspace, credential or draft state between profiles. Configure the central base URL and the user's independent bearer token, and fail closed if the external server cannot be reached instead of starting an embedded writer. Read session lists/details/transcripts over REST, subscribe over WS, and use the actor fields above to show who submitted a prompt, steered it or resolved an interaction. Existing local-only operation can continue to use the legacy token, which maps to `local-server`.
