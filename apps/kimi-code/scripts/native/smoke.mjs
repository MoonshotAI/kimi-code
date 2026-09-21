import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  let notificationTap;
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
        if (notificationTap !== undefined && (parsed === null || typeof parsed !== 'object' || !('id' in parsed))) {
          notificationTap(parsed);
        }
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

  // Responses carry a request `id`; server notifications (e.g. process/output)
  // do not — skip those while awaiting a specific response.
  const nextResponse = async () => {
    for (;;) {
      const frame = await nextFrame();
      if (frame !== null && typeof frame === 'object' && 'id' in frame) return frame;
    }
  };

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  // The remote terminal is a core executor feature: a tty spawn must work in
  // the shipped SEA, where node-pty loads from the native-asset cache through
  // the module hook. Guards against silent regressions of the SEA node-pty
  // loading path (native-deps registration, bundle externalization, hook).
  const runTtySmoke = async () => {
    const argv =
      process.platform === 'win32'
        ? ['cmd.exe', '/c', 'echo tty-smoke-ok']
        : ['sh', '-c', 'echo tty-smoke-ok'];
    let output = '';
    let closed = false;
    let exitCode;
    notificationTap = (frame) => {
      if (frame.params?.processId !== 'smoke-tty') return;
      if (frame.method === 'process/output') {
        output += Buffer.from(frame.params.chunkBase64, 'base64').toString('utf8');
      } else if (frame.method === 'process/exited') {
        exitCode = frame.params.exitCode;
      } else if (frame.method === 'process/closed') {
        closed = true;
      }
    };
    send({
      method: 'process/start',
      id: 3,
      params: { processId: 'smoke-tty', argv, cwd: tmpdir(), tty: true },
    });
    const started = await nextResponse();
    if (started.id !== 3 || typeof started.result?.pid !== 'number') {
      fail(`exec-server tty spawn failed: ${JSON.stringify(started)}`);
    }
    const deadline = Date.now() + 30_000;
    while ((!closed || !output.includes('tty-smoke-ok')) && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    notificationTap = undefined;
    if (!closed) {
      send({ method: 'process/terminate', id: 100, params: { processId: 'smoke-tty' } });
      fail(`exec-server tty process did not exit in time; output so far: ${JSON.stringify(output)}`);
    }
    if (exitCode !== 0) {
      fail(`exec-server tty process exited ${exitCode}: ${JSON.stringify(output)}`);
    }
    if (!output.includes('tty-smoke-ok')) {
      fail(`exec-server tty output missing the smoke marker: ${JSON.stringify(output)}`);
    }
    console.log('exec-server tty smoke passed');
  };

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
    send({ method: 'environment/status', id: 2 });
    const status = await nextFrame();
    if (status.id !== 2 || status.result?.status !== 'ready') {
      fail(`exec-server environment/status mismatch: ${JSON.stringify(status)}`);
    }
    await runTtySmoke();
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

await runExecServerSmoke();

console.log(`Native smoke passed: ${executablePath}`);
