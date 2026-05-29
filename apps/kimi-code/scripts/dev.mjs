#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPluginMarketplaceServer } from './dev-plugin-marketplace-server.mjs';

// Suppress DEP0190 deprecation warning for shell+args in this dev script.
// The args are safe (hardcoded paths + CLI flags forwarded by the user).
process.removeAllListeners('warning');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');
const MARKETPLACE_ENV = 'KIMI_CODE_PLUGIN_MARKETPLACE_URL';

let marketplaceServer;
const env = { ...process.env };

if (env[MARKETPLACE_ENV] === undefined || env[MARKETPLACE_ENV]?.trim().length === 0) {
  marketplaceServer = await startPluginMarketplaceServer();
  env[MARKETPLACE_ENV] = marketplaceServer.marketplaceUrl;
  console.error(`Plugin marketplace dev server: ${marketplaceServer.marketplaceUrl}`);
}

// On Windows, .cmd wrappers in node_modules/.bin cannot be spawned directly
// without shell:true. Shell is only used on Windows to avoid EINVAL.
const useShell = process.platform === 'win32';
const tsxBin = useShell ? 'tsx.cmd' : 'tsx';
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
const child = spawn(
  tsxBin,
  ['--import', '../../build/register-raw-text-loader.mjs', './src/main.ts', ...cliArgs],
  {
    cwd: APP_ROOT,
    env,
    stdio: 'inherit',
    shell: useShell,
    windowsHide: true,
  },
);

child.on('error', async (error) => {
  console.error(`Failed to start Kimi Code dev CLI: ${error.message}`);
  await marketplaceServer?.close();
  process.exit(1);
});

child.on('exit', async (code, signal) => {
  await marketplaceServer?.close();
  if (signal !== null) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
