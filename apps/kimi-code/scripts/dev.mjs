#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPluginMarketplaceServer } from './dev-plugin-marketplace-server.mjs';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');
// Runtime variable the CLI reads to locate the marketplace JSON.
const MARKETPLACE_ENV = 'KIMI_CODE_PLUGIN_MARKETPLACE_URL';
// Opt-in for dev: point this run at an external marketplace instead of a local one.
const EXTERNAL_MARKETPLACE_ENV = 'KIMI_CODE_DEV_MARKETPLACE_URL';

let marketplaceServer;
const env = { ...process.env };

const externalUrl = process.env[EXTERNAL_MARKETPLACE_ENV]?.trim();
if (externalUrl !== undefined && externalUrl.length > 0) {
  // Explicitly asked to use an external marketplace; don't start a local server.
  env[MARKETPLACE_ENV] = externalUrl;
  console.error(`Using external plugin marketplace: ${externalUrl}`);
} else {
  // Default: every `pnpm run dev:cli` runs its own isolated marketplace server on a
  // random port, so multiple concurrent dev instances never collide. Overwrite any
  // inherited MARKETPLACE_ENV so a stale URL from a dead instance can't break this run.
  const inherited = process.env[MARKETPLACE_ENV]?.trim();
  marketplaceServer = await startPluginMarketplaceServer();
  env[MARKETPLACE_ENV] = marketplaceServer.marketplaceUrl;
  console.error(`Plugin marketplace dev server: ${marketplaceServer.marketplaceUrl}`);
  if (inherited !== undefined && inherited.length > 0 && inherited !== marketplaceServer.marketplaceUrl) {
    console.error(
      `(ignored inherited ${MARKETPLACE_ENV}=${inherited}; set ${EXTERNAL_MARKETPLACE_ENV} to use an external marketplace)`,
    );
  }
}

const tsxCli = require.resolve('tsx/cli');
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
const child = spawn(
  process.execPath,
  [
    tsxCli,
    // Use the dev tsconfig whose `include` covers packages/*/src, so tsx's
    // esbuild transform sees `experimentalDecorators: true` for DI parameter
    // decorators in agent-core. Mirrors `dev:server` in package.json.
    '--tsconfig',
    './tsconfig.dev.json',
    '--import',
    '../../build/register-raw-text-loader.mjs',
    './src/main.ts',
    ...cliArgs,
  ],
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
