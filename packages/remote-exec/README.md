# @moonshot-ai/remote-exec

Remote execution protocol and bridge: a self-contained NDJSON line-framed RPC
(codex exec-server dialect) between the local `ExecBridge` and the light
`kimi exec-server` executor, plus the fs/process/terminal RPC stubs behind the
agent-core-v2 `Runtime` interface.

```text
packages/remote-exec/src/
├── protocol/   message types, error codes, NDJSON codec (self-contained)
├── client/     execBridge, launchers, connection, fs/process/terminal stubs, remoteRuntime
└── server/     stdioHost, fsHandler, processManager, environment, entry, standalone
```

## Entries

- `.` — client side: protocol + bridge + stubs + `RemoteRuntime`.
- `./client` — the same client surface.
- `./server` — the executor side: `runExecServer` (light entry), `StdioHost`.
- `./protocol` — wire types and codec only.

The CLI consumes only the server entry: argv pre-dispatch
(`kimi exec-server --listen stdio`) then `await import('@moonshot-ai/remote-exec/server')`
and `runExecServer({ version })`. The entry composes only node-local OS
backends and awaits the environment probe; it creates no App scope and starts
no config/OAuth/telemetry/session services. Logs go to stderr; stdout carries
protocol frames only.

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
- Added `fs/rename` and `process/resize` (no codex counterpart).
- `process/signal` is three-state (`interrupt|terminate|kill`, codex only
  interrupt); signal/terminate act on the whole process group, and group
  residue is cleaned even when the leader has already exited (spec §5.3 —
  codex no-ops signals on exited processes).
- `process/write` accepts `eof: true` (with an empty chunk) to close remote
  stdin. Codex has no stdin close on the wire; our `IHostProcess.stdin.end()`
  makes it necessary. After EOF, writes report `stdinClosed`.
- `environment` adds `osArch`/`osVersion`/`pathClass` over codex (rg artifact
  selection needs arch), plus `cwd`/`tempDir`.
- No ws transport, no `resumeSessionId`, no sandbox parameter family, no
  `fs/walk`/`fs/copy`/`capabilityRoots/discoverV1`/`environmentConfig/read`.

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
- `test/e2e/` holds the real-machine (ssh/docker) acceptance driver and
  step-by-step docs; the vitest suite covers the local loopback.
