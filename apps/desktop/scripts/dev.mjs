#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
import { createServer } from 'vite';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));

function run(cmd, args, extraEnv) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env, ...extraEnv };
    const child =
      process.platform === 'win32'
        ? spawn(`${cmd} ${args.join(' ')}`, { cwd: desktopDir, stdio: 'inherit', shell: true, env })
        : spawn(cmd, args, { cwd: desktopDir, stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

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
  } catch {}
  process.exit(code);
}

try {
  await run('pnpm', ['exec', 'tsdown'], { KIMI_DESKTOP_DEV: '1' });
} catch (error) {
  process.stderr.write(`[dev] tsdown build failed: ${String(error)}\n`);
  await shutdown(1);
}

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
