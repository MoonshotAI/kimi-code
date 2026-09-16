# remote-exec real-machine acceptance (ssh / docker)

Loopback (local subprocess, no ssh) is covered by the vitest suite. This
directory holds the reproducible real-machine acceptance for the spec §11
scenarios the loopback cannot reach: real ssh, real docker, and fault
injection (bridge drop, container stop, TERM-ignore, leader-exited group
residue).

The driver (`driver.ts`) connects a `RemoteRuntime` to a real target through a
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

Useful flags: `--scenario basic,pty,term-ignore,group-residue,container-stop,disconnect`
(default: all), `--remote-cwd <dir>` (working directory for the checks).

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
- `container-stop` — `docker stop` mid-session: runtime reports `disconnected`
  and later calls reject (no local fallback). docker targets only.
- `disconnect` — client-side bridge drop: later fs/process calls reject, and a
  fresh probe connection confirms the dropped connection's processes are dead.

## 5. Manual fault injection

- **ssh bridge drop / half-open**: run any long scenario (e.g. `--scenario
  disconnect` paused at a prompt, or a manual `sleep` via the driver), then
  kill the local ssh process (`pkill -f 'ssh.*dev-box'`) or drop the network.
  The ServerAlive options in the ssh lowering (`ServerAliveInterval=15`,
  `ServerAliveCountMax=3`) bound the half-open detection to ~45s; the runtime
  must go `disconnected` and calls must reject.
- **executor missing (127)**: point `--remote-bin` at a nonexistent path; the
  driver must fail with the exit code and bounded stderr, not hang.
- **stdout pollution**: prepend something to the remote shell rc that prints
  to stdout; the zero-tolerance handshake must reject the connection
  immediately.

## 6. Notes

- The standalone executor reports version `0.0.0-standalone`; the driver
  passes `--minExecutorVersion 0.0.0`. The real version gate is covered by the
  loopback suite (`test/handshake.test.ts`).
- Launcher discipline (spec §3.1): every launcher must be verified to allocate
  no TTY and to carry only protocol frames on stdout. The shipped ssh lowering
  uses `-T` and docker lowering uses `exec -i` (no `-t`); the zero-tolerance
  handshake is the runtime guard for any launcher that violates this.
