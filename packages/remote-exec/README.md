# @moonshot-ai/remote-exec

Remote execution protocol and bridge: a self-contained NDJSON line-framed RPC
(codex exec-server dialect) between the local `ExecBridge` and the light
`kimi exec-server` executor, plus the fs/process/terminal RPC stubs behind the
agent-core-v2 `Runtime` interface.

```text
packages/remote-exec/src/
├── protocol/   message types, error codes, NDJSON codec (self-contained)
├── client/     execBridge, launchers, connection, fs/process/terminal stubs, remoteRuntime, remoteRuntimeProvider,
│               artifactLocator, executorInstaller, installTrigger (executor auto-install, spec D8/D9)
└── server/     stdioHost, fsHandler, processManager, environment, entry, standalone
```

## Entries

- `.` — client side: protocol + bridge + stubs + `RemoteRuntime` + `RemoteRuntimeProviderFactory`.
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

Client-surface notes beyond the wire protocol:

- `RemoteRuntime.environment` is the handshake payload (adds `cwd`/`tempDir`
  to `HostEnvironmentInfo`).
- `RemoteRuntime.connection` is public as the protocol escape hatch for calls
  the `Runtime` interface cannot express (e.g. `process/terminate` with its
  TERM-then-KILL escalation, which `IHostProcess.kill`'s single signal does
  not cover).
- Whole-file reads without `maxBytes` are rejected server-side above 32MiB
  (base64 of the response must fit the 64MiB frame cap); larger files are read
  through `offset`/`maxBytes` range reads.
- `RemoteRuntimeProviderFactory` is the workspace composition root for
  declared runtimes: it attaches via `IWorkspaceInstanceManager.addProvider`,
  reads the merged declaration set (`config.toml` `[runtimes]` plus a trusted
  project-level `.kimi-code/runtimes.toml`, resolved by agent-core-v2's
  `resolveWorkspaceRuntimeDeclarations`), and registers each declared runtime
  as a `disconnected` placeholder (`ManagedRemoteRuntime`) — no connections
  are made at registration. An explicit `connect()` (the binding
  `connectAndSwitch` flow, or reconnect) builds the `RemoteRuntime` and swaps
  it into the registry with a fresh generation; the old generation drains and
  its leases never migrate. The whole provider is inert unless
  `KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME` is enabled.

## Executor install and version guidance (spec D8/D9)

The connect path (`connectWithAutoInstall`, wired into the factory) classifies
handshake failures and acts on them:

- **Missing executor** — the launcher exited 127 (ssh remote shell) or 126
  (docker exec "executable file not found"), or the handshake **timed out**.
  For typed `ssh`/`docker` runtimes with an artifact locator configured, the
  trigger runs **one** auto-install attempt and then retries the connect
  **exactly once**; a failed install or a failed retry surfaces as a
  `HandshakeError` carrying the original failure plus install guidance.
  `command` runtimes are never auto-installed — they fail with manual install
  guidance.
- **Too-old executor** — the handshake answered but `executorVersion <
  MIN_EXECUTOR_VERSION`. The client rejects with *upgrade* guidance (current
  vs minimum version), deliberately distinct from the missing-executor
  guidance; no auto-upgrade is performed.

`installExecutor` (ssh/docker) runs: probe the target environment (`uname
-sm`, plus the container user's `$HOME` for docker) → skip when a usable
executor already answers `--version` at the destination → locate the artifact
→ download with pinned SHA-256 verification (same discipline as rgLocator) →
upload to a unique tmp path (`scp` / `docker cp`) → `chmod 755` + atomic
`mv -f` into the destination (tmp+rename, so a half-install never presents as
success) → post-check that the installed binary runs `--version` at or above
the minimum. Every step failure throws `ExecutorInstallError` naming the step,
argv, exit code and bounded stderr, and the remote tmp file is removed
best-effort. The default destination is `~/.kimi-code/bin/kimi` (ssh: expanded
by the remote shell as `$HOME`; docker: the probed container-user absolute
home path — `docker exec` has no tilde expansion, and the connect retry uses
that absolute path). A custom `remoteBin` is installed at that literal path.

### Artifact locator — injection point

`ExecutorArtifactLocator` resolves `(osKind, osArch, version)` to
`{url, sha256, filename, version}`. The default implementation,
`CdnExecutorArtifactLocator`, follows the SEA native release chain
(`apps/kimi-code/scripts/native`): it fetches
`<cdnBaseUrl>/binaries/<version>/manifest.json`, selects the
`<platform>-<arch>` platform entry (`linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64` — the executor is posix-only), verifies the manifest's own
`version` matches the request, and downloads
`<cdnBaseUrl>/binaries/<version>/<filename>` pinning the entry's `checksum`
(SHA-256 of the bare binary).

The CDN base is region-dependent app-layer knowledge, so it is **injected**:
the composition root (kap-server mission) constructs the factory with

```ts
new RemoteRuntimeProviderFactory({
  artifactLocator: new CdnExecutorArtifactLocator({
    cdnBaseUrl: kimiRegionProfile(resolveKimiRegion({ configuredOAuthHost, configuredOAuthKey })).cdnBase,
  }),
  clientVersion: <the server/CLI version>,
})
```

`kimiRegionProfile`/`resolveKimiRegion` come from `@moonshot-ai/kimi-code-oauth`
(already a kap-server dependency — the same source rgLocator uses). Without a
locator, missing executors get manual install guidance instead of an
auto-install attempt. `installRunner` and `installFetch` are test seams.

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
