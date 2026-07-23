/**
 * `sudoAskpass` domain (L7) — askpass helper script sources.
 *
 * Pure builders for the two files dropped into the per-session
 * `<sessionDir>/sudo-askpass/` directory:
 *   - `helper.sh` — the `SUDO_ASKPASS` entrypoint; execs the current node
 *     binary on `helper.mjs`, forwarding sudo's prompt argv;
 *   - `helper.mjs` — dependency-free node script: connects to the askpass
 *     unix socket whose absolute path is baked in at generation time (see
 *     below), sends one JSON line (`{token, prompt, command}`), waits one
 *     JSON line reply, prints the password on `{"password": "…"}`
 *     (exit 0), exits 1 on `{"cancelled": true}` / error / disconnect.
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
 * as one stdout line from helper to sudo.
 */

/**
 * `helper.mjs` source. The reply race note: the server ends the connection
 * right after the reply line, so a successful answer removes the `end`
 * listener before it can exit(1) ahead of the stdout flush.
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

/** `helper.sh` source — sudo invokes this via `SUDO_ASKPASS`. */
export function helperShSource(dir: string, execPath: string): string {
  return `#!/bin/sh
exec ${shellQuote(execPath)} ${shellQuote(`${dir}/helper.mjs`)} "$@"
`;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
