# src/remote — remote execution

Remote execution protocol and bridge: a self-contained NDJSON line-framed RPC
(codex exec-server dialect) between the local `ExecBridge` and the light
`kimi exec-server` executor, and the provider that registers each declared
remote target as an engine `Environment` (`src/environment/`).

The fs/process RPC stubs are an OS backend, so they live next to the
node-local one rather than here:

```text
packages/agent-core-v2/src/
├── os/
│   ├── interface/            IHostFileSystem / IHostProcessService contracts
│   └── backends/
│       ├── node-local/       direct node implementation (host, local environment, executor)
│       └── remote/           RPC stubs over an ExecChannel (remoteFileSystem, remoteProcess)
└── remote/
    ├── protocol/             message types, error codes, NDJSON codec, ExecChannel (self-contained)
    ├── client/               execBridge, launchers, sshAskpass, connection, remoteSession,
    │                         remoteEnvironmentProvider, connectGuidance (executor detection + guidance)
    ├── server/               stdioHost, fsHandler, processManager, environment, entry
    ├── declaration/          [environments] config schema
    └── askpass.ts            SSH_ASKPASS helper process (light entry, node builtins only)
```

`os/backends/remote` may import only `#/remote/protocol`, `#/os/interface` and
`#/_base`; the connection lifecycle that feeds it an `ExecChannel` stays in
`remote/client`.

## Entries

- `@moonshot-ai/agent-core-v2/remote` — client side: protocol + bridge + `RemoteSession` + `RemoteEnvironmentProviderFactory`.
- `@moonshot-ai/agent-core-v2/remote/server` — the executor side: `runExecServer` (light entry), `StdioHost`.
- `@moonshot-ai/agent-core-v2/remote/askpass` — the SSH askpass helper side: env contract and `runSshAskpass` (light entry). The listener half is `remote/client/sshAskpass`; hosts opt into the password retry with `sshPassword: { prompt, askpassCommand }`, where `askpassCommand` re-enters a process whose entry dispatches to `runSshAskpass` when `isSshAskpassEnvironment()` holds.

The CLI consumes only the server entry: argv pre-dispatch
(`kimi exec-server --listen stdio`) then `await import('@moonshot-ai/kimi-code-sdk/exec-server')`
(a light SDK subpath re-exporting this entry) and `runExecServer({ version })`.
The fs/process handlers are protocol adapters over the same node-local
`HostFileSystem` / `HostProcessService` implementations the local environment
uses, so local and remote fs/process behave alike; the handlers keep only wire
concerns (validation, size limits, error mapping, process ids, output
notifications, flow control, process-group reaping). The entry awaits the
environment probe; it creates no App scope and starts no
config/OAuth/telemetry/session services. Logs go to stderr; stdout carries
protocol frames only. The light import graph is enforced by
`scripts/check-import-boundaries.mjs`: `src/remote/server` may import only
node builtins, relative modules, `#/remote/protocol`, `#/os/interface`,
`#/_base/execEnv` and the DI-free node-local `hostFsService` /
`hostProcessService` modules (their App-scope registration lives in
`os/backends/node-local/hostServices.ts`).

## Protocol notes (deviations from codex exec-server)

Blueprint is codex exec-server (`codex-rs/exec-server*`, master `0265dd7b`);
deviations per the design spec, plus one forced addition:

- Bare absolute paths instead of `file:` URIs (our abstraction is bare-path
  end to end).
- `fs/readFile` takes `offset`/`maxBytes` (stateless range read, `maxBytes ≤
  1MiB`) instead of codex's open/readBlock/close handle trio. Whole-file reads
  without `maxBytes` are capped well below the 64MiB frame cap.
- `fs/writeFile` takes `mode: truncate|append|exclusive` (codex only has
  truncate); `exclusive` maps EEXIST to `os.fs.already_exists`, which the
  client maps back to `createExclusive === false`. Optional `parent` folds
  directory preparation into the first write while chunks remain sequential.
- `fs/readDirectory` preserves the symlink marker on each entry. The client
  rejects a truncated listing with `os.fs.directory_too_large` rather than
  exposing an incomplete directory; the current limit is 50,000 entries.
- `fs/walk` performs a bounded recursive listing in one call. It accepts the
  root ignore rules needed to prune ignored directories before traversal and
  reports entries, recoverable directory errors, and truncation. Clients fall
  back to per-directory reads when the JSON-encoded ignore rules exceed 1MiB.
  Walks default to a 55-second budget so they can return a truncated result
  before the 60-second RPC deadline.
- Added `fs/rename` (no codex counterpart).
- `fs/remove` takes only `path` and always removes recursively and ignores a
  missing path, matching `IHostFileSystem.remove` (codex has `recursive`/`force`).
- `process/signal` is three-state (`interrupt|terminate|kill`, codex only
  interrupt); signals act on the whole process group, and group residue is
  cleaned even when the leader has already exited (spec §5.3 — codex no-ops
  signals on exited processes). `terminate` is SIGTERM with a 1s SIGKILL
  escalation: against a starting process it is applied once the process runs,
  against an exited leader's group it escalates the residue, and against an id
  that has not started yet the id is remembered so the late start is rejected
  instead of leaking the process.
- `process/write` accepts `eof: true` (with an empty chunk) to close remote
  stdin. Codex has no stdin close on the wire; our `IHostProcess.stdin.end()`
  makes it necessary. After EOF, writes report `stdinClosed`.
- `process/write` suspends the RPC response until the child's stdin drains
  (or the process exits / the connection drops), propagating backpressure to
  the caller instead of buffering unboundedly executor-side; codex uses a
  bounded channel for the same effect. A write broken by process exit settles
  as `stdinClosed`.
- `environment` adds `osArch`/`osVersion`/`pathClass` over codex (rg artifact
  selection needs arch), plus `cwd`/`tempDir`.
- No ws transport, no `resumeSessionId`, no sandbox parameter family, no
  `fs/copy`/`capabilityRoots/discoverV1`/`environmentConfig/read`.

Process output is delivered through notifications (`process/output`,
`process/exited`, `process/closed`). The executor retains process handles until
both the leader has exited and its output streams have closed, then keeps only
a bounded set of process-group identities for late signals and shutdown cleanup.
It does not retain output for replay or expose `process/read`.

Client-surface notes beyond the wire protocol:

- `RemoteSession` is one live executor connection (fs/process stubs, the
  handshake `host` payload that adds `cwd`/`tempDir` to `HostEnvironmentInfo`,
  and `dispose`). It is not an `Environment`: identity, status and generation
  live only on the registered `DeclaredRemoteEnvironment`.
- `RemoteSession.connection` is public as the protocol escape hatch for raw
  calls the `Environment` interface does not model (e.g. starting a process
  without an `IHostProcess` wrapper, as the e2e fault-injection scenarios do).
- Bounded business calls (fs/*, process/start, …) carry a per-request timeout
  (default 60s): a stall fails only that request with `RequestTimeoutError`,
  and a late response is discarded — the connection survives. `process/write`
  is exempt: its response is deliberately suspended until the child's stdin
  drains, so it carries no timeout and is never retried — a hung write fails
  only with the connection.
- Whole-file reads without `maxBytes` are rejected server-side above 32MiB
  (base64 of the response must fit the 64MiB frame cap); larger files are read
  through `offset`/`maxBytes` range reads.
- `RemoteEnvironmentProviderFactory` registers one `DeclaredRemoteEnvironment`
  per declaration id in the `EnvironmentRegistry`, and that declaration holds
  the connection one-to-one: at most one `RemoteSession` (one executor
  process) per id at a time. There is no per-workspace view or refcount —
  registry leases only point at the registered environment. Registration is
  still `pending` — no connection is opened until `connect()`. A temporary
  `RemoteSession.connect` does not enter the registry. Unregistering on detach
  is owned by `IEnvironmentService`, not by the provider.
- `connect()` while `ready` is a no-op, and concurrent connects share one
  in-flight attempt. A drop is process-wide for that id. The next `connect()`
  opens a new process; explicit reconnect is `disconnect()` then `connect()`,
  and it does not change the registered identity's generation. A different id
  is unaffected. SSH liveness is the ssh process (`ServerAliveInterval`); there
  is no protocol heartbeat and no merge by host or declaration fingerprint. A
  changed declaration replaces the launcher, bumps the identity's generation,
  and drops the live process; an in-flight connect from the old launcher is
  discarded. In-flight tool calls are not retried on the new process. The
  server bounds in-flight calls per connection (256); the client queues
  nothing.

## Executor detection and version guidance

The connect path (`connectWithGuidance`, wired into the factory) classifies
handshake failures and attaches per-launcher install/upgrade guidance to the
error. **The executor is never installed automatically**: a missing or too-old
executor fails the connect, and the error text tells the user where to get the
binary and where to put it. Both typed launchers go through a remote shell, so
a `~`-prefixed `remoteBin` (the default `~/.kimi-code/bin/kimi` is) expands on
the target: ssh runs the command line in the remote shell, and docker runs
`docker exec -i <container> sh -c 'exec <remoteBin> exec-server --listen
stdio'` — the same word-initial tilde expansion on both, with the remainder of
`remoteBin` single-quoted against shell re-parsing.

- **Missing executor** — the launcher exited 127 (the remote shell could not
  find the executor binary) or 126 (the remote shell found the executor but
  could not execute it, e.g. a missing exec bit), or the handshake **timed out**.
  The error gains install guidance: download the `kimi` binary for the target
  platform from the Kimi Code release CDN and install it at the executor path
  the launcher invokes (named in the message; `command` environments append
  `<remoteBin> exec-server` to their args and are pointed at that `remoteBin`,
  unless their args already invoke `exec-server`, in which case they are
  pointed at the path their command invokes). Guidance generation
  never masks the original handshake failure.
- **Too-old executor** — the handshake answered but `executorVersion <
  MIN_EXECUTOR_VERSION`. The client rejects with *upgrade* guidance (current
  vs minimum version, then the same install wording), deliberately
  distinct from the missing-executor guidance; no auto-upgrade is performed.

Wire discipline: NDJSON frames (`\n`-terminated, `\r\n` tolerated, blank lines
skipped, strict UTF-8), one message capped at 64MiB (disconnect on exceed),
base64 for binary, no `jsonrpc` field (four-way classification by
`method`/`id`/`result` key presence), `id` string|number, errors
`{code, message, data?}` with the domain code in `data.domainCode`
(`-32004` NotFound, `-32600` InvalidRequest, `-32601` MethodNotFound,
`-32602` InvalidParams, `-32603` InternalError). Zero tolerance before the
handshake completes: any byte or unknown notification disconnects.

## Operational notes

- The executor is posix-only; the client refuses non-posix environments and
  executors below `MIN_EXECUTOR_VERSION` at the handshake gate.
- `test/remote/e2e/` holds the real-machine (ssh/docker) acceptance driver and
  step-by-step docs; the vitest suite covers the local loopback.
