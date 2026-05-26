#!/usr/bin/env node
// Wraps `concurrently` so the vis-server (API) and vite (web) each pick a
// free port and agree on each other's, even when the defaults are taken by
// a previous dev session or another local app.

import { spawn } from 'node:child_process';
import net from 'node:net';

const DEFAULT_API_PORT = 5174;
const DEFAULT_WEB_PORT = 5173;
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

async function pickPort(startPort, exclude = new Set()) {
  for (let port = startPort; port < startPort + MAX_PROBE; port += 1) {
    if (exclude.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isFree(port)) return port;
  }
  throw new Error(
    `no free port in [${startPort}, ${startPort + MAX_PROBE}); something is hogging the range`,
  );
}

const requestedApi = Number(process.env.PORT) || DEFAULT_API_PORT;
const apiPort = await pickPort(requestedApi);
if (apiPort !== requestedApi) {
  process.stdout.write(`[vis] api port ${requestedApi} busy, using ${apiPort} instead\n`);
}

const requestedWeb = Number(process.env.WEB_PORT) || DEFAULT_WEB_PORT;
const webPort = await pickPort(requestedWeb, new Set([apiPort]));
if (webPort !== requestedWeb) {
  process.stdout.write(`[vis] web port ${requestedWeb} busy, using ${webPort} instead\n`);
}

process.stdout.write(`[vis] web → http://localhost:${webPort}  (api on ${apiPort})\n`);

const env = { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort) };
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
