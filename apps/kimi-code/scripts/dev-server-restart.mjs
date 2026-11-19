#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');

const tsxBin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();

const tsxArgs = [
  '--tsconfig',
  './tsconfig.dev.json',
  '--import',
  '../../build/register-raw-text-loader.mjs',
  './src/main.ts',
  'web',
  '--no-open',
  ...cliArgs,
];

let child = null;
let restarting = false;
let shuttingDown = false;
let killTimer = null;

function start() {
  console.error('[dev:server:restart] starting server…');
  child = spawn(tsxBin, tsxArgs, {
    cwd: APP_ROOT,
    env: { ...process.env, KIMI_CODE_DEV_SERVER: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  child.on('error', (err) => {
    console.error(`[dev:server:restart] spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    const prev = child;
    child = null;
    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    const tag = signal !== null ? `signal=${signal}` : `code=${code}`;
    console.error(
      `[dev:server:restart] server exited (${tag}). Press Enter to restart, Ctrl+C to quit.`,
    );
    void prev;
  });
}

function restart() {
  if (shuttingDown) return;
  if (child === null) {
    start();
    return;
  }
  if (restarting) return;
  restarting = true;
  console.error('[dev:server:restart] restarting…');
  child.kill('SIGTERM');
  killTimer = setTimeout(() => {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      console.error('[dev:server:restart] SIGTERM timed out, sending SIGKILL');
      child.kill('SIGKILL');
    }
  }, 5000);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\n') || chunk.includes('\r')) {
    restart();
  }
});

const onShutdownSignal = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child !== null) {
    child.kill(signal);
    setTimeout(() => process.exit(0), 1000).unref();
  } else {
    process.exit(0);
  }
};
process.on('SIGINT', () => onShutdownSignal('SIGINT'));
process.on('SIGTERM', () => onShutdownSignal('SIGTERM'));

start();
