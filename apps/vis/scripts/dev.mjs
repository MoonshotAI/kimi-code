#!/usr/bin/env node
// Wraps `concurrently` so that the vis-server and vite both agree on which
// API port to use, even when the default (3001) is already taken — common
// when a previous dev session leaked a child node process.

import { spawn } from 'node:child_process';
import net from 'node:net';

const DEFAULT_PORT = 3001;
const MAX_PROBE = 50;

async function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => {
      resolve(false);
    });
    srv.once('listening', () => {
      srv.close(() => {
        resolve(true);
      });
    });
    srv.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

async function pickPort(startPort) {
  for (let port = startPort; port < startPort + MAX_PROBE; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isFree(port)) return port;
  }
  throw new Error(
    `no free port in [${startPort}, ${startPort + MAX_PROBE}); something is hogging the range`,
  );
}

const requested = Number(process.env.PORT) || DEFAULT_PORT;
const port = await pickPort(requested);
if (port !== requested) {
  process.stdout.write(
    `[vis] port ${requested} busy, using ${port} instead\n`,
  );
}

const env = { ...process.env, PORT: String(port) };
const child = spawn(
  'concurrently',
  [
    '-k',
    '-n', 'server,web',
    '-c', 'cyan,magenta',
    'pnpm --filter @moonshot-ai/vis-server dev',
    'pnpm --filter @moonshot-ai/vis-web dev',
  ],
  { stdio: 'inherit', env, shell: false },
);

child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
