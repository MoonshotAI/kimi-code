#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPluginMarketplaceServer } from './dev-plugin-marketplace-server.mjs';

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

const tsxBin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
const child = spawn(
  tsxBin,
  ['--import', '../../build/register-raw-text-loader.mjs', './src/main.ts', ...cliArgs],
  {
    cwd: APP_ROOT,
    env,
    stdio: 'inherit',
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
