# remote execution real-machine acceptance (ssh / docker)

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
pnpm --filter @moonshot-ai/agent-core-v2 run build:executor
# → packages/agent-core-v2/dist-executor/executor.mjs
```

It accepts the stock argv shape (`executor.mjs exec-server --listen stdio`),
so the ssh/docker launcher lowering works unchanged. It needs only `node` on
the target.

(The bundle is an interim acceptance vehicle. The shipped executor is the SEA
`kimi` binary at `~/.kimi-code/bin/kimi`; swap it in via `--remote-bin` once
the CLI wiring lands — the protocol is identical.)

## 2. Deploy to the target

ssh target (host alias `dev-box` in `~/.ssh/config`):

```bash
scp packages/agent-core-v2/dist-executor/executor.mjs dev-box:~/executor.mjs
```

docker target (container `myapp-dev`):

```bash
docker cp packages/agent-core-v2/dist-executor/executor.mjs myapp-dev:/executor.mjs
```

## 3. Run the scenarios

ssh — the ssh lowering expands `~` on the remote side, so `node ~/executor.mjs`
works as `remoteBin`:

```bash
cd packages/agent-core-v2
npx tsx test/remote/e2e/driver.ts --target ssh --host dev-box \
  --remote-bin "node ~/executor.mjs"
```

docker — use the generic command launcher (docker exec takes argv, no shell):

```bash
npx tsx test/remote/e2e/driver.ts --target command --program docker \
  --args "exec -i myapp-dev node /executor.mjs exec-server --listen stdio"
```

Or, with the real executor already installed on the target:

```bash
npx tsx test/remote/e2e/driver.ts --target ssh --host dev-box           # default remoteBin ~/.kimi-code/bin/kimi
npx tsx test/remote/e2e/driver.ts --target docker --container myapp-dev --remote-bin /root/.kimi-code/bin/kimi
```

Useful flags: `--scenario install,basic,term-ignore,group-residue,container-stop,disconnect`
(default: everything except `install`), `--remote-cwd <dir>` (working directory
for the checks). The `install` scenario additionally needs `--cdn-base <url>`
and `--client-version <semver>` (§5) and runs first, before the other
scenarios' upfront connect.

## 4. What each scenario proves

- `basic` — handshake + environment payload; fs write/read/rename/remove;
  process output/exit code; **env hygiene** (a local-only variable does not
  cross the wire; an explicit override does).
- `term-ignore` — `trap "" TERM` process is SIGKILL-escalated after the short
  grace window (spec §5.3).
- `group-residue` — `sleep & exit 0` leader exits; the residue group member is
  killed on `process/signal` (verified with remote `kill -0`).
- `container-stop` — `docker stop` mid-session: environment reports `disconnected`
  and later calls reject (no local fallback). Runs on a fresh connection and is
  skipped (not failed) when `--container` is absent.
- `disconnect` — client-side bridge drop: later fs/process calls reject, and a
  fresh probe connection confirms the dropped connection's processes are dead.
- `install` — missing-executor guidance and manual install acceptance on a
  fresh target; see §5.

## 5. Manual install acceptance (scenario `install`)

The `install` scenario verifies spec D8/D9 end-to-end on a **fresh** target
(no executor installed): the connect fails as missing-executor, the failure
guidance prints the concrete per-launcher install commands (real download URL
+ pinned sha256) while installing nothing, and performing those documented
steps manually yields a working environment on the next connect. It runs real
ssh/docker and a real HTTP download against a manifest you serve locally.

### 5.1 Stage the artifact + manifest

The guidance's download URL and the driver's manual install both expect the
SEA release layout
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
cd packages/agent-core-v2
npx tsx test/remote/e2e/driver.ts --target ssh --host dev-box --scenario install \
  --cdn-base http://127.0.0.1:8000 --client-version $VERSION
npx tsx test/remote/e2e/driver.ts --target docker --container myapp-dev --scenario install \
  --cdn-base http://127.0.0.1:8000 --client-version $VERSION
```

What each check proves:

- `connect on a fresh target fails as a missing executor` — the failure is
  classified (ssh exit 127 / docker exit 126), not a generic error.
- `the failure prints per-launcher install guidance and installs nothing` —
  the connect is attempted exactly once; the error guidance names the real
  artifact URL and the launcher-matching copy+activate commands (`scp`+`ssh`
  for ssh, `docker cp`+`docker exec` for docker); a raw re-connect still
  fails as missing-executor, proving the client copied nothing.
- `following the guidance manually yields a working environment` — the driver
  performs the documented steps (download, sha256 verify, copy, chmod+mv) and
  the next connect succeeds on the first attempt; the executor binary exists
  at the expected absolute path on the target and an fs round-trip works
  through it.

On success the executor stays installed, so the other scenarios can run
against the same target afterwards (drop `--scenario install` or pass the
full list). To re-run `install`, remove the executor on the target
(`ssh dev-box 'rm -f ~/.kimi-code/bin/kimi'` /
`docker exec myapp-dev rm -f /root/.kimi-code/bin/kimi`).

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
  loopback suite (`test/remote/handshake.test.ts`).
- Launcher discipline (spec §3.1): every launcher must be verified to allocate
  no TTY and to carry only protocol frames on stdout. The shipped ssh lowering
  uses `-T` and docker lowering uses `exec -i` (no `-t`); the zero-tolerance
  handshake is the environment guard for any launcher that violates this.
