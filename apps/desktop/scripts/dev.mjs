#!/usr/bin/env node
// Dev launcher for the desktop app: Vite dev server (renderer HMR) + tsdown
// (Electron main bundle, built once) + Electron.
//
// The Vite dev server port is read after listen and handed to the main process
// via KIMI_RENDERER_DEV_URL; src/main/connect.ts then loads the renderer from
// the dev server (and CORS-allows its origin) instead of the built
// desktop-dist. Renderer edits hot-reload in the running window; main-process
// edits require re-running `pnpm dev` (tsdown is not watched here).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
import { createServer } from 'vite';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));

function run(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    // On Windows pnpm is a .cmd shim: CreateProcess can't execute batch
    // files, so spawn must go through the shell. Single-string form (args are
    // fixed literals) — an args array with shell:true trips Node's DEP0190.
    const child =
      process.platform === 'win32'
        ? spawn(`${cmd} ${args.join(' ')}`, { cwd: desktopDir, stdio: 'inherit', shell: true })
        : spawn(cmd, args, { cwd: desktopDir, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

// 1. Renderer dev server (HMR). Host/port defaults live in
//    vite.renderer.config.ts; strictPort is false, so read the actual port.
const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.renderer.config.ts', import.meta.url)),
});
await server.listen();
const address = server.httpServer?.address();
const port =
  typeof address === 'object' && address !== null ? address.port : server.config.server.port;
const devUrl = `http://127.0.0.1:${port}/`;
process.stdout.write(`[dev] renderer dev server: ${devUrl}\n`);

async function shutdown(code) {
  try {
    await server.close();
  } catch {
    // Vite is going down with us; nothing worth surfacing.
  }
  process.exit(code);
}

// 2. Electron main bundle (out/main.cjs + out/preload.cjs). One-shot: the
//    config rarely changes during a renderer-focused session.
try {
  await run('pnpm', ['exec', 'tsdown']);
} catch (error) {
  process.stderr.write(`[dev] tsdown build failed: ${String(error)}\n`);
  await shutdown(1);
}

// 3. Electron, pointed at the dev server. Forward any extra CLI args
//    (e.g. --remote-debugging-port=9222) to Electron. Drop the pnpm `--`
//    separator if the caller used it.
const extraArgs = process.argv.slice(2);
if (extraArgs[0] === '--') extraArgs.shift();
const electronArgs = [...extraArgs, '.'];
const electronChild = spawn(electron, electronArgs, {
  cwd: desktopDir,
  stdio: 'inherit',
  env: { ...process.env, KIMI_RENDERER_DEV_URL: devUrl },
});
electronChild.on('exit', (code) => void shutdown(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => electronChild.kill(signal));
}
