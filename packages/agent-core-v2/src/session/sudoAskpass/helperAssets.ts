/**
 * `sudoAskpass` domain (L7) — askpass helper script sources.
 *
 * Pure builders for the files dropped into the per-session
 * `<sessionDir>/sudo-askpass/` directory:
 *   - `helper.sh` — the `SUDO_ASKPASS` entrypoint; execs the current node
 *     binary on `helper.mjs`, forwarding sudo's prompt argv;
 *   - `helper.mjs` — dependency-free node script: connects to the askpass
 *     unix socket whose absolute path is baked in at generation time (see
 *     below), sends one JSON line (`{token, prompt, command}`), waits one
 *     JSON line reply, prints the password on `{"password": "…"}`
 *     (exit 0), exits 1 on `{"cancelled": true}` / error / disconnect;
 *   - `bin/sudo` — PATH shim that prepends `-A` and execs the real sudo:
 *     sudo only consults `SUDO_ASKPASS` in askpass mode, and the Bash
 *     tool's pipes give it no TTY, so without the shim it would fail
 *     with its no-TTY error instead of prompting.
 *
 * Why the socket path is baked in: unix-domain socket paths are capped at
 * ~104 bytes on macOS, so the socket cannot always live inside the (deep)
 * session dir — the service picks the path and stamps it here. Deriving it
 * from the helper's own location would also break because node's ESM loader
 * realpaths `import.meta.url` (`/var` → `/private/var`), inflating the
 * derived path past the same limit.
 *
 * SECURITY: the token travels via the `KIMI_SUDO_ASKPASS_TOKEN` env var of
 * the spawned shell, never on a command line; the password only ever exists
 * as one stdout line from helper to sudo. The server ends the connection
 * right after the reply line, so on a successful answer helper.mjs removes
 * its `end` listener before flushing stdout — otherwise the disconnect
 * would exit(1) ahead of the flush.
 */

export function helperMjsSource(socketPath: string): string {
  return `import net from 'node:net';

const socketPath = ${JSON.stringify(socketPath)};
const token = process.env.KIMI_SUDO_ASKPASS_TOKEN ?? '';
const command = process.env.KIMI_SUDO_ASKPASS_COMMAND;
const prompt = process.argv.slice(2).join(' ');

const socket = net.createConnection(socketPath, () => {
  socket.write(JSON.stringify({ token, prompt, command }) + '\\n');
});

let buf = '';
socket.on('data', (chunk) => {
  buf += chunk;
  const idx = buf.indexOf('\\n');
  if (idx === -1) return;
  try {
    const reply = JSON.parse(buf.slice(0, idx));
    if (reply && typeof reply.password === 'string') {
      socket.removeAllListeners('end');
      process.stdout.write(reply.password + '\\n', () => process.exit(0));
      return;
    }
  } catch {
    // malformed reply — fall through to exit 1
  }
  process.exit(1);
});
socket.on('error', () => process.exit(1));
socket.on('end', () => process.exit(1));
`;
}

export function helperShSource(dir: string, execPath: string): string {
  return `#!/bin/sh
exec ${shellQuote(execPath)} ${shellQuote(`${dir}/helper.mjs`)} "$@"
`;
}

export function sudoShimSource(realSudoPath: string): string {
  return `#!/bin/sh
# Force askpass mode so SUDO_ASKPASS is consulted (sudo 1.9+ requires -A) —
# unless the caller asked for stdin passwords (-S/--stdin), which sudo
# rejects in combination with -A; keep sudo's own behavior there.
for arg do
  case $arg in
    --) break ;;
    -S*|--stdin) exec ${shellQuote(realSudoPath)} "$@" ;;
    -*) ;;
    *) break ;;
  esac
done
exec ${shellQuote(realSudoPath)} -A "$@"
`;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
