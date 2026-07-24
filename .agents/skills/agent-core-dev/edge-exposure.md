# Edge exposure — `resource:action` + WS events

How a domain's Services become the wire surface (`/api/v2`) and WebSocket events. This is a **design-time** decision: which Services are exposed, under what public `resource:action` name, and which events stream.

The transport (`/api/v2` over HTTP + WS) lives in the **edge** layer (`gateway`/`rpc`/`transport`). It borrows business Services by interface; business code never imports it.

## 1. The edge model

Three scopes, three URL shapes, one dispatcher:

```text
GET|POST /api/v2/:sa                                       Core
GET|POST /api/v2/session/:session_id/:sa                   Session
GET|POST /api/v2/session/:session_id/agent/:agent_id/:sa   Agent
```

`:sa` is a single path segment of the form `<resource>:<action>` (e.g.
`sessions:list`, `session:read`, `profile:getModel`).

- `:resource` is a **public** name (`sessions`, `session`, `profile`), never an internal domain token (`ISessionMetadata`).
- `:action` is the method. `GET` for reads, `POST` for writes.
- Body = the method's single argument (JSON), omitted for no-arg.
- Response = the project envelope `{ code, msg, data, request_id, details? }`.
- The dispatcher resolves the **scope** from the URL, the **Service** from an `actionMap`, calls the method, wraps the result.

```ts
// actionMap — the allowlist; hides internal domain names.
const actionMap = {
  core:    { 'sessions:list': { service: ISessionIndex, method: 'list' }, ... },
  session: { 'session:read':  { service: ISessionMetadata, method: 'read' }, ... },
  agent:   { 'profile:getModel': { service: IProfileService, method: 'getModel' }, ... },
};
```

The `actionMap` is the single allowlist: only mapped `resource:action` pairs are callable; unknown → `40001`.

## 2. What may be exposed directly

A Service method is directly exposable iff **all** hold:

1. Args are JSON-serializable (no live objects, `AbortSignal`, callbacks, resumer fns).
2. Return is JSON-serializable data or `void` (no `IScopeHandle`, `Turn`, `IProcess`, `AsyncIterable`, `IDisposable`, `Event`).
3. Errors are `KimiError` (coded).
4. It is a command/query, not a factory, stream, byte-store, or sink.

If any fail → wrap in a **facade** (a Service that takes ids, returns data, throws `KimiError`) and expose the facade. The repo already ships a wire-shaped facade in `rpc/core-api.ts` (`CoreAPI` / `SessionAPI` / `AgentAPI`) behind `IAgentRPCService` / `ISessionRPCService` — prefer building the HTTP edge on top of it rather than re-deriving a new one.

## 3. Per-scope `resource:action` map

Read = `GET`, write = `POST`. `sid` = `session_id`, `aid` = `agent_id`.

### Core (`/api/v2/:resource:action`)

| resource | action | Service.method | verb |
|---|---|---|---|
| `sessions` | `list` | ISessionIndex.list | GET |
| `sessions` | `get` | ISessionIndex.get | GET |
| `sessions` | `countActive` | ISessionIndex.countActive | GET |
| `workspaces` | `list` | IWorkspaceService.list | GET |
| `workspaces` | `get` | IWorkspaceService.get | GET |
| `workspaces` | `createOrTouch` | IWorkspaceService.createOrTouch | POST |
| `workspaces` | `update` | IWorkspaceService.update | POST |
| `workspaces` | `delete` | IWorkspaceService.delete | POST |
| `config` | `get` / `getAll` / `inspect` | IConfigService.* | GET |
| `config` | `set` / `replace` / `reload` | IConfigService.* | POST |
| `providers` | `list` / `get` | IProviderService.* | GET |
| `providers` | `set` / `delete` | IProviderService.* | POST |
| `oauth` | `startLogin` / `cancelLogin` / `logout` | IOAuthService.* | POST |
| `oauth` | `getFlow` / `status` | IOAuthService.* | GET |
| `auth` | `summarize` | IAuthSummaryService.summarize | GET |
| `auth` | `ensureReady` | IAuthSummaryService.ensureReady | POST |
| `flags` | `snapshot` / `enabled` / `explain` / `explainAll` | IFlagService.* | GET |
| `fs` | `browse` / `home` | IHostFolderBrowser.* | GET |
| `meta` | `getEnv` / `detect` | IBootstrapService.* | GET |

### Session (`/api/v2/session/:sid/:resource:action`)

| resource | action | Service.method | verb |
|---|---|---|---|
| `session` | `read` | ISessionMetadata.read | GET |
| `session` | `update` | ISessionMetadata.update | POST |
| `session` | `setTitle` | ISessionMetadata.setTitle | POST |
| `session` | `setArchived` | ISessionMetadata.setArchived | POST |
| `session` | `status` | ISessionActivity.status | GET |
| `session` | `isIdle` | ISessionActivity.isIdle | GET |
| `session` | `archive` | ISessionLifecycleService.archive | POST |
| `approvals` | `listPending` | IApprovalService.listPending | GET |
| `approvals` | `decide` | IApprovalService.decide | POST |
| `questions` | `listPending` | IQuestionService.listPending | GET |
| `questions` | `answer` | IQuestionService.answer | POST |
| `interactions` | `listPending` | IInteractionService.listPending | GET |
| `interactions` | `respond` | IInteractionService.respond | POST |
| `workspace` | `setWorkDir` / `addAdditionalDir` / `removeAdditionalDir` / `resolve` | IWorkspaceContext.* | GET/POST |

### Agent (`/api/v2/session/:sid/agent/:aid/:resource:action`)

| resource | action | Service.method | verb |
|---|---|---|---|
| `goal` | `get` | IGoalService.getGoal | GET |
| `goal` | `create` / `pause` / `resume` / `cancel` | IGoalService.* | POST |
| `plan` | `status` | IPlanService.status | GET |
| `plan` | `enter` / `exit` / `cancel` / `clear` | IPlanService.* | POST |
| `tasks` | `list` / `get` / `readOutput` | IBackgroundService.* | GET |
| `tasks` | `stop` / `detach` | IBackgroundService.* | POST |
| `usage` | `status` | IUsageService.status | GET |
| `context` | `status` | IAgentContextSizeService.get | GET |
| `swarm` | `isActive` | ISwarmService.isActive | GET |
| `swarm` | `enter` / `exit` | ISwarmService.* | POST |
| `permission` | `getMode` | IPermissionModeService.mode | GET |
| `permission` | `setMode` | IPermissionModeService.setMode | POST |
| `permissionRules` | `list` | IPermissionRulesService.rules | GET |
| `permissionRules` | `addRules` | IPermissionRulesService.addRules | POST |
| `profile` | `get` / `getModel` / `getSystemPrompt` / `getActiveToolNames` | IProfileService.* | GET |
| `profile` | `setModel` / `setThinking` | IProfileService.* | POST |
| `messages` | `list` | IContextMemory.get | GET |
| `messages` | `splice` | IContextMemory.splice | POST |
| `toolStore` | `get` / `data` | IToolStoreService.* | GET |
| `toolStore` | `set` | IToolStoreService.set | POST |
| `mcp` | `list` | IMcpService.list | GET |
| `mcp` | `reconnect` | IMcpService.reconnect | POST |
| `tools` | `list` | IToolRegistry.list | GET |

## 4. Facade-needed (wrap before exposing)

These fail §2 and must be wrapped in a facade that takes ids and returns data:

| Service | Why not direct | Facade shape |
|---|---|---|
| ISessionLifecycleService | returns `IScopeHandle` | `sessions.create` / `fork` / `close` / `archive` → wire Session |
| IAgentPromptService / IAgentTurnService | returns `Turn` handle | `prompts.submit` / `steer` / `abort` / `undo` |
| ILLMRequester | `AsyncIterable` stream | stream over WS, not RPC |
| ISubagentHost | `SubagentHandle` | `subagents.spawn` / `resume` → info |
| IProcessRunner | `IProcess` streams | terminal (separate WS protocol) |
| Storage / Store (IFileSystemStorageService / IAppendLogStore / IAtomicDocumentStore / IBlobStore) | bytes / streams | not for RPC |
| IAgentFileSystem | `withCwd` handle | `fs.read` / `write` → text/bytes |
| IExternalHooksService | server-side outbound | not exposed |
| IWireRecord | write-ahead log | internal |

## 5. WS events

A single WebSocket endpoint multiplexes RPC `call`s and event `listen`s over a JSON protocol (the lean counterpart of VSCode's `IMessagePassingProtocol`, carrying the same safety features — see §6):

```text
WS /api/v2/ws
```

Client → server: `hello` (auth), `call` (scope + `resource:action` + arg), `cancel`, `listen` (scope + event), `unlisten`, `pong`.
Server → client: `ready`, `result`, `error`, `event`, `ping`.

`call` reuses the same dispatcher as the HTTP routes (scope + `actionMap`). `listen` subscribes to an `Event<T>` source and forwards each emission as an `event` message, keyed by the client-chosen `id`.

The `eventMap` binds a public event name to the scope's `Event` source (analogous to the `actionMap`):

| Scope | event | Source |
|---|---|---|
| Core | `events` | `IEventService.subscribe` (process-wide `DomainEvent` bus) |
| Agent | `events` | `IEventSink.on` (per-agent `AgentEvent` stream) |

Session-level `onDidChange` sources (metadata / interactions) carry no payload today, so they are not exposed until there is a concrete consumer.

Safety / reliability (carried over from `packages/server/src/ws/connection.ts` and VSCode's `ChannelServer`):

- request ids + active-request table — `cancel` / `unlisten` disposes them;
- heartbeat — `ping` every 30s, `pong` timeout 10s → `terminate`;
- schema validation — invalid frames are dropped, not fatal;
- graceful close — dispose listeners, cancel pending, reject in-flight calls;
- no stack traces over the wire;
- non-serializable event payloads are dropped, never fatal.

Cursor / replay / resync for events is a future addition (a separate `call` before `listen`); the raw stream is the foundation.

## 6. Red lines (edge exposure)

- Never expose an internal domain token (`ISessionMetadata`) as a URL segment — use a public `resource` name + `action`.
- Never expose a method that returns a handle / stream / bytes / disposable — wrap in a facade.
- Never expose a method that takes a live object / `AbortSignal` / callback / resumer fn — wrap in a facade.
- Session / Agent Services are reached by `accessor.get` with the id from the URL — never cache the result; finish before the scope disposes.
- The `actionMap` is the allowlist — only mapped `resource:action` pairs are callable; unknown → `40001`.
- Events stream over WS (`listen`), never RPC (`call`).
- Business code never imports the edge (`gateway` / `rpc` / `transport`) — the edge borrows business Services by interface.
- Read = `GET`, write = `POST`; do not overload `POST` for reads when caching / browser-friendliness matters.
