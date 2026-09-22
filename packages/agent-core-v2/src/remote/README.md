# src/remote — remote execution

Remote execution protocol and bridge: a self-contained NDJSON line-framed RPC
(codex exec-server dialect) between the local `ExecBridge` and the light
`kimi exec-server` executor, plus the fs/process/terminal RPC stubs behind
the engine `Environment` interface (`src/environment/`).

```text
packages/agent-core-v2/src/remote/
├── protocol/   message types, error codes, NDJSON codec (self-contained)
├── client/     execBridge, launchers, connection, fs/process/terminal stubs, remoteEnvironment, remoteConnectionPool,
│               remoteEnvironmentProvider, executorDetect, connectGuidance (executor detection + guidance)
└── server/     stdioHost, fsHandler, processManager, environment, entry, standalone
```

## Entries

- `@moonshot-ai/agent-core-v2/remote` — client side: protocol + bridge + stubs + `RemoteEnvironment` + `RemoteEnvironmentProviderFactory`.
- `@moonshot-ai/agent-core-v2/remote/server` — the executor side: `runExecServer` (light entry), `StdioHost`.

The CLI consumes only the server entry: argv pre-dispatch
(`kimi exec-server --listen stdio`) then `await import('@moonshot-ai/agent-core-v2/remote/server')`
and `runExecServer({ version })`. The entry composes only node-local OS
backends and awaits the environment probe; it creates no App scope and starts
no config/OAuth/telemetry/session services. Logs go to stderr; stdout carries
protocol frames only. The light import graph is enforced by
`scripts/check-import-boundaries.mjs`: `src/remote/server` may import only
node builtins, `node-pty`, relative modules, `#/remote/protocol`,
`#/os/interface` and `#/_base/execEnv`.

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
  client maps back to `createExclusive === false`.
- `fs/readDirectory` preserves the symlink marker on each entry. The client
  rejects a truncated listing with `os.fs.directory_too_large` rather than
  exposing an incomplete directory; the current limit is 50,000 entries.
- Added `fs/rename` and `process/resize` (no codex counterpart).
- `process/signal` is three-state (`interrupt|terminate|kill`, codex only
  interrupt); signal/terminate act on the whole process group, and group
  residue is cleaned even when the leader has already exited (spec §5.3 —
  codex no-ops signals on exited processes).
- `process/write` accepts `eof: true` (with an empty chunk) to close remote
  stdin. Codex has no stdin close on the wire; our `IHostProcess.stdin.end()`
  makes it necessary. After EOF, writes report `stdinClosed`.
- `process/resize` on an already-exited tty process is a success no-op, so a
  resize racing the process exit does not surface an ioctl error.
- `process/write` suspends the RPC response until the child's stdin drains
  (or the process exits / the connection drops), propagating backpressure to
  the caller instead of buffering unboundedly executor-side; codex uses a
  bounded channel for the same effect. A write broken by process exit settles
  as `stdinClosed`.
- `environment` adds `osArch`/`osVersion`/`pathClass` over codex (rg artifact
  selection needs arch), plus `cwd`/`tempDir`.
- No ws transport, no `resumeSessionId`, no sandbox parameter family, no
  `fs/walk`/`fs/copy`/`capabilityRoots/discoverV1`/`environmentConfig/read`.

Process output is delivered through notifications (`process/output`,
`process/exited`, `process/closed`). The executor retains process handles until
both the leader has exited and its output streams have closed, then keeps only
a bounded set of process-group identities for late signals and shutdown cleanup.
It does not retain output for replay or expose `process/read`.

Client-surface notes beyond the wire protocol:

- `RemoteEnvironment.environment` is the handshake payload (adds `cwd`/`tempDir`
  to `HostEnvironmentInfo`).
- `RemoteEnvironment.connection` is public as the protocol escape hatch for calls
  the `Environment` interface cannot express (e.g. `process/terminate` with its
  TERM-then-KILL escalation, which `IHostProcess.kill`'s single signal does
  not cover).
- Bounded business calls (fs/*, process/start, process/write, …) carry a
  per-request timeout (default 60s): a stall fails only that request with
  `RequestTimeoutError`, and a late response is discarded — the connection
  survives.
- Whole-file reads without `maxBytes` are rejected server-side above 32MiB
  (base64 of the response must fit the 64MiB frame cap); larger files are read
  through `offset`/`maxBytes` range reads.
- `RemoteEnvironmentProviderFactory` is the workspace composition root for
  declared environments: it attaches via `IWorkspaceInstanceManager.addProvider`,
  reads the declaration set from `config.toml` `[environments]` (resolved by
  agent-core-v2's `resolveWorkspaceEnvironmentDeclarations`), and registers
  each declared environment as a `pending` placeholder (`ManagedRemoteEnvironment`) — no connections
  are made at registration.
- Executor connections are owned by an app-level `RemoteConnectionPool`, not by
  workspaces: one connection per declaration fingerprint is shared by every
  workspace bound to the same target, and the pool destroys it once the last
  workspace holder lets go. Ephemeral
  environments (the agent-created `connect` tool) never enter the pool. An
  explicit `connect()` (the binding `connectAndSwitch` flow, or reconnect) goes
  through the pool: a first connect joins or builds the shared connection, and
  a **reconnect is a pool-level coordinated replacement** — the pool bumps its
  version so a stale in-flight connect cannot install, builds the replacement,
  and broadcasts it to every workspace view on the fingerprint. Each view swaps
  to the new connection with its fresh generation; turns pinned to the old
  generation fail explicitly through the registry drain and the disposed
  connection, exactly as if the connection had dropped — only the trigger may
  be another workspace. The replaced connection is disposed after every view
  settles, so old-generation leases keep their registry drain grace first.

## Executor detection and version guidance

The connect path (`connectWithGuidance`, wired into the factory) classifies
handshake failures and attaches per-launcher install/upgrade guidance to the
error. **The executor is never installed automatically**: a missing or too-old
executor fails the connect, and the error text tells the user where to get the
binary and where to put it. Before the first exec attempt, a docker launcher
whose `remoteBin` is `~`-prefixed (the default
`~/.kimi-code/bin/kimi` is) is resolved to the container user's absolute home
path with one `docker exec … sh -c` probe — `docker exec` passes argv to
execve without a shell, so the tilde would reach execve literally and every
connect would open with a failing exit-126 handshake. The provider caches the
resolved path per declaration fingerprint, so reconnects skip both the probe
and the failing handshake, and a
missing-executor classification below means the executor is genuinely absent
at the resolved path.

- **Missing executor** — the launcher exited 127 (ssh remote shell) or 126
  (docker exec "executable file not found"), or the handshake **timed out**.
  The error gains install guidance: download the `kimi` binary for the target
  platform from the Kimi Code release CDN and install it at the executor path
  the launcher invokes (named in the message; `command` environments are
  pointed at the absolute path their command invokes). Guidance generation
  never masks the original handshake failure.
- **Too-old executor** — the handshake answered but `executorVersion <
  MIN_EXECUTOR_VERSION`. The client rejects with *upgrade* guidance (current
  vs minimum version, then the same install wording), deliberately
  distinct from the missing-executor guidance; no auto-upgrade is performed.

`probeRunner` is the test seam for the docker home probe.

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
- node-pty is a native module loaded lazily (tty processes only). If it is not
  built for the current platform, everything except tty still works and tty
  spawns fail with `os.process.spawn_failed`. Build it with
  `pnpm rebuild node-pty` (needs node-gyp).
- `test/remote/e2e/` holds the real-machine (ssh/docker) acceptance driver and
  step-by-step docs; the vitest suite covers the local loopback.
