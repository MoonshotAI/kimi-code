import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { appRoot, nativeBinPath, nativeSmokeHome, targetTriple } from './paths.mjs';

const execFileAsync = promisify(execFile);
const target = targetTriple();
const executablePath = nativeBinPath(target);
const smokeHome = nativeSmokeHome();
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const expectedVersion = packageJson.version;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function ensureExecutableExists() {
  try {
    await stat(executablePath);
  } catch {
    fail(`Native executable not found at ${executablePath}. Run build:native:sea first.`);
  }
}

// `kimi exec-server --listen stdio` is the remote-executor light entry: the
// SEA binary must answer the NDJSON handshake with the package version and a
// posix environment, keep stdout protocol-only, and exit 0 on stdin EOF.
async function runExecServerSmoke() {
  const { spawn } = await import('node:child_process');
  const startedAt = performance.now();
  const child = spawn(executablePath, ['exec-server', '--listen', 'stdio'], {
    cwd: appRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const pending = [];
  const waiters = [];
  let buffer = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        const parsed = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(parsed);
        else pending.push(parsed);
      }
      index = buffer.indexOf('\n');
    }
  });

  const nextFrame = () =>
    new Promise((resolveFrame, rejectFrame) => {
      const queued = pending.shift();
      if (queued !== undefined) {
        resolveFrame(queued);
        return;
      }
      const timer = setTimeout(() => {
        rejectFrame(new Error(`timed out waiting for a protocol frame; stderr so far:\n${stderr}`));
      }, 30_000);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolveFrame(frame);
      });
    });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  try {
    send({ method: 'initialize', id: 1, params: { clientName: 'native-smoke', clientVersion: expectedVersion } });
    const initialize = await nextFrame();
    const handshakeMs = performance.now() - startedAt;
    const result = initialize.result ?? {};
    if (initialize.id !== 1 || result.executorVersion !== expectedVersion) {
      fail(`exec-server handshake mismatch: expected executorVersion ${expectedVersion}, got ${JSON.stringify(initialize)}`);
    }
    if (result.environment?.osKind === undefined || result.environment.osKind === 'windows') {
      fail(`exec-server reported a non-posix environment: ${JSON.stringify(result.environment)}`);
    }
    send({ method: 'initialized' });
    send({ method: 'fs/getMetadata', id: 2, params: { path: '/' } });
    const metadata = await nextFrame();
    if (metadata.id !== 2 || metadata.result?.isDirectory !== true) {
      fail(`exec-server fs/getMetadata mismatch: ${JSON.stringify(metadata)}`);
    }
    child.stdin.end();
    const exitCode = await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveExit(null);
      }, 30_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
    if (exitCode !== 0) {
      fail(`exec-server did not exit 0 on stdin EOF (exit=${exitCode}).\n${stderr}`);
    }
    console.log(`exec-server smoke passed (handshake in ${handshakeMs.toFixed(0)}ms)`);
  } finally {
    child.kill('SIGKILL');
  }
}

async function runKimi(args) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: appRoot,
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

async function runKimiWithEnv(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: appRoot,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    fail(`Native smoke output for "${command}" did not include "${expected}".\n${output}`);
  }
}

await ensureExecutableExists();

const versionOutput = await runKimi(['--version']);
assertIncludes(versionOutput, expectedVersion, '--version');

const helpOutput = await runKimi(['--help']);
assertIncludes(helpOutput, 'Usage: kimi', '--help');

const exportHelpOutput = await runKimi(['export', '--help']);
assertIncludes(exportHelpOutput, 'Usage: kimi export', 'export --help');

const smokeCache = resolve(smokeHome, 'cache');
await rm(smokeHome, { recursive: true, force: true });
await mkdir(smokeCache, { recursive: true });
try {
  const nativeAssetOutput = await runKimiWithEnv(['--version'], {
    KIMI_CODE_CACHE_DIR: smokeCache,
    KIMI_CODE_HOME: smokeHome,
    KIMI_CODE_NATIVE_ASSET_SMOKE: '1',
  });
  assertIncludes(nativeAssetOutput, `Native asset smoke passed: ${target}`, 'native asset smoke');
  assertIncludes(nativeAssetOutput, 'MiniDb worker build passed', 'MiniDb worker smoke');
  assertIncludes(nativeAssetOutput, 'search worker ready', 'search worker smoke');
} finally {
  await rm(smokeHome, { recursive: true, force: true });
}

// Plugin MCP servers declared with `command: "node"` are re-executed through
// this binary as `__plugin_run_node`, which loads the plugin script with a
// dynamic import(). Keep that path covered so bundler or SEA settings that
// break dynamic import() fail here instead of inside users' plugins.
const pluginRoot = resolve(smokeHome, 'plugin');
await rm(smokeHome, { recursive: true, force: true });
await mkdir(pluginRoot, { recursive: true });
try {
  const pluginEntry = resolve(pluginRoot, 'entry.mjs');
  await writeFile(
    pluginEntry,
    'await Promise.resolve();\nconsole.log(`plugin entry ran ${process.argv.slice(2).join(" ")}`);\n',
  );
  const pluginOutput = await runKimiWithEnv(['__plugin_run_node', pluginEntry, 'alpha', 'beta'], {
    KIMI_CODE_HOME: smokeHome,
    KIMI_PLUGIN_ROOT: pluginRoot,
  });
  assertIncludes(pluginOutput, 'plugin entry ran alpha beta', 'plugin node entry');
} finally {
  await rm(smokeHome, { recursive: true, force: true });
}

await runExecServerSmoke();

console.log(`Native smoke passed: ${executablePath}`);
