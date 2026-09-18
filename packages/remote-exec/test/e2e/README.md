# remote-exec real-machine acceptance (ssh / docker)

Loopback (local subprocess, no ssh) is covered by the vitest suite. This
directory holds the reproducible real-machine acceptance for the spec §11
scenarios the loopback cannot reach: real ssh, real docker, and fault
injection (bridge drop, container stop, TERM-ignore, leader-exited group
residue).

The driver (`driver.ts`) connects a `RemoteEnvironment` to a real target through a
launcher and asserts behavior on the target itself (remote `kill -0`, remote
file reads), so a PASS always means something really happened on the target —
no fake success, and every failure path is checked for silent local fallback.

## 1. Build the standalone executor

Until the CLI ships `kimi exec-server`, use the bundled single-file executor:

```bash
pnpm --filter @moonshot-ai/remote-exec run build:executor
# → packages/remote-exec/dist-executor/executor.mjs
```

It accepts the stock argv shape (`executor.mjs exec-server --listen stdio`),
so the ssh/docker launcher lowering works unchanged. It needs only `node` on
the target. For the `pty` scenario the target also needs `node-pty` next to
the bundle:

```bash
# on the target, next to executor.mjs
npm init -y && npm install node-pty@^1.1.0
```

(The bundle is an interim acceptance vehicle. The shipped executor is the SEA
`kimi` binary at `~/.kimi-code/bin/kimi`; swap it in via `--remote-bin` once
the CLI wiring lands — the protocol is identical.)

## 2. Deploy to the target

ssh target (host alias `dev-box` in `~/.ssh/config`):

```bash
scp packages/remote-exec/dist-executor/executor.mjs dev-box:~/executor.mjs
```

docker target (container `myapp-dev`):

```bash
docker cp packages/remote-exec/dist-executor/executor.mjs myapp-dev:/executor.mjs
```

## 3. Run the scenarios

ssh — the ssh lowering expands `~` on the remote side, so `node ~/executor.mjs`
works as `remoteBin`:

```bash
cd packages/remote-exec
npx tsx test/e2e/driver.ts --target ssh --host dev-box \
  --remote-bin "node ~/executor.mjs"
```

docker — use the generic command launcher (docker exec takes argv, no shell):

```bash
npx tsx test/e2e/driver.ts --target command --program docker \
  --args "exec -i myapp-dev node /executor.mjs exec-server --listen stdio"
```

Or, with the real executor already installed on the target:

```bash
npx tsx test/e2e/driver.ts --target ssh --host dev-box           # default remoteBin ~/.kimi-code/bin/kimi
npx tsx test/e2e/driver.ts --target docker --container myapp-dev --remote-bin /root/.kimi-code/bin/kimi
```

Useful flags: `--scenario install,basic,pty,term-ignore,group-residue,container-stop,disconnect`
(default: everything except `install`), `--remote-cwd <dir>` (working directory
for the checks). The `install` scenario additionally needs `--cdn-base <url>`
and `--client-version <semver>` (§5) and runs first, before the other
scenarios' upfront connect.

## 4. What each scenario proves

- `basic` — handshake + environment payload; fs write/read/rename/remove;
  process output/exit code; **env hygiene** (a local-only variable does not
  cross the wire; an explicit override does).
- `pty` — interactive shell, merged stdout/stderr pty stream, resize, exit
  code. Requires node-pty on the target; reports SKIP-OR-FAIL with the reason
  otherwise.
- `term-ignore` — `trap "" TERM` process is SIGKILL-escalated after the short
  grace window (spec §5.3).
- `group-residue` — `sleep & exit 0` leader exits; the residue group member is
  killed on `process/signal` (verified with remote `kill -0`).
- `container-stop` — `docker stop` mid-session: environment reports `disconnected`
  and later calls reject (no local fallback). Runs on a fresh connection and is
  skipped (not failed) when `--container` is absent.
- `disconnect` — client-side bridge drop: later fs/process calls reject, and a
  fresh probe connection confirms the dropped connection's processes are dead.
- `install` — auto-install acceptance on a fresh target; see §5.

## 5. Auto-install acceptance (scenario `install`)

The `install` scenario verifies spec D8/D9 end-to-end on a **fresh** target
(no executor installed): the connect fails as missing-executor, the
auto-install downloads + verifies + activates the executor, the retried
connect yields a working environment, a tampered checksum is rejected without a
retry, and a second install is a no-op. It runs real ssh/docker and a real
HTTP download against a manifest you serve locally.

### 5.1 Stage the artifact + manifest

The auto-install expects the SEA release layout
(`<cdnBase>/binaries/<version>/manifest.json` +
`<cdnBase>/binaries/<version>/kimi-code-<target>`). Either download the
published binary for the target platform from the release CDN, or build one
with the native chain (`apps/kimi-code/scripts/native`). Then stage a local
site:

```bash
VERSION=0.3.0            # the release to install (must be >= MIN_EXECUTOR_VERSION 0.1.0)
TARGET=linux-x64         # the TARGET's platform-arch: linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
mkdir -p site/binaries/$VERSION
cp /path/to/kimi site/binaries/$VERSION/kimi-code-$TARGET
SHA=$(shasum -a 256 site/binaries/$VERSION/kimi-code-$TARGET | cut -d' ' -f1)
cat > site/binaries/$VERSION/manifest.json <<EOF
{"version":"$VERSION","tag":"v$VERSION","platforms":{"$TARGET":{"filename":"kimi-code-$TARGET","checksum":"$SHA"}}}
EOF
(cd site && python3 -m http.server 8000)
```

### 5.2 Run the scenario

```bash
cd packages/remote-exec
npx tsx test/e2e/driver.ts --target ssh --host dev-box --scenario install \
  --cdn-base http://127.0.0.1:8000 --client-version $VERSION
npx tsx test/e2e/driver.ts --target docker --container myapp-dev --scenario install \
  --cdn-base http://127.0.0.1:8000 --client-version $VERSION
```

What each check proves:

- `connect on a fresh target fails as a missing executor` — the failure is
  classified (ssh exit 127 / docker exit 126), not a generic error.
- `a tampered checksum aborts the auto-install without a connect retry` — a
  manifest whose sha256 does not match the served binary fails at the
  `download` step with `checksum mismatch`, and the connect is NOT retried.
- `auto-install on the handshake failure yields a working environment` — the
  trigger installs once and retries the connect exactly once; the executor
  binary exists at the expected absolute path on the target and an fs
  round-trip works through it.
- `a second install is a no-op` — an executor answering `--version` at or
  above the minimum is left untouched (no re-download).

On success the executor stays installed, so the other scenarios can run
against the same target afterwards (drop `--scenario install` or pass the
full list). To re-run `install`, remove the executor on the target
(`ssh dev-box 'rm -f ~/.kimi-code/bin/kimi'` /
`docker exec myapp-dev rm -f /root/.kimi-code/bin/kimi`).

### 5.3 Manual fault injection for half-installs

- **Unwritable bin dir**: `ssh dev-box 'chmod 500 ~/.kimi-code/bin'` — the
  install must fail at the `upload` or `activate` step naming argv, exit code
  and stderr; `~/.kimi-code/bin/kimi` must not appear, and no stale
  `.kimi-install-*` tmp file remains after the best-effort cleanup.
- **Interrupted upload**: kill `scp` mid-transfer (throttle with a large
  file) — the tmp file may remain on the target, but the destination never
  appears half-written (activation is a single atomic `mv -f`), and the next
  install attempt starts from a fresh tmp name.
- **Missing local ssh/docker**: remove the launcher program from PATH — the
  connect fails before the handshake with the spawn error in the message; no
  install is attempted.

## 6. Manual fault injection

- **ssh bridge drop / half-open**: run any long scenario (e.g. `--scenario
  disconnect` paused at a prompt, or a manual `sleep` via the driver), then
  kill the local ssh process (`pkill -f 'ssh.*dev-box'`) or drop the network.
  The ServerAlive options in the ssh lowering (`ServerAliveInterval=15`,
  `ServerAliveCountMax=3`) bound the half-open detection to ~45s; the environment
  must go `disconnected` and calls must reject.
- **executor missing (127)**: point `--remote-bin` at a nonexistent path; the
  driver must fail with the exit code and bounded stderr, not hang.
- **stdout pollution**: prepend something to the remote shell rc that prints
  to stdout; the zero-tolerance handshake must reject the connection
  immediately.

## 7. Notes
- The standalone executor reports version `0.0.0-standalone`; the driver
  passes `--minExecutorVersion 0.0.0`. The real version gate is covered by the
  loopback suite (`test/handshake.test.ts`).
- Launcher discipline (spec §3.1): every launcher must be verified to allocate
  no TTY and to carry only protocol frames on stdout. The shipped ssh lowering
  uses `-T` and docker lowering uses `exec -i` (no `-t`); the zero-tolerance
  handshake is the environment guard for any launcher that violates this.
