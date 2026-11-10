#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');
// Monorepo root. Used as the dev CLI's working directory so `make dev` opens
// the whole repo instead of just apps/kimi-code.
const REPO_ROOT = resolve(APP_ROOT, '../..');
const MARKETPLACE_ENV = 'KIMI_CODE_PLUGIN_MARKETPLACE_URL';
const EXTERNAL_MARKETPLACE_ENV = 'KIMI_CODE_DEV_MARKETPLACE_URL';

const env = { ...process.env };
const externalUrl = process.env[EXTERNAL_MARKETPLACE_ENV]?.trim();
if (externalUrl !== undefined && externalUrl.length > 0) {
  env[MARKETPLACE_ENV] = externalUrl;
  console.error(`Using external plugin marketplace: ${externalUrl}`);
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
    // decorators in agent-core-v2. Mirrors `dev:server` in package.json.
    '--tsconfig',
    resolve(APP_ROOT, 'tsconfig.dev.json'),
    '--import',
    pathToFileURL(resolve(REPO_ROOT, 'build/register-raw-text-loader.mjs')).href,
    resolve(APP_ROOT, 'src/main.ts'),
    ...cliArgs,
  ],
  {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error(`Failed to start Kimi Code dev CLI: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
