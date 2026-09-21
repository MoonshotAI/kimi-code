import { spawn as localSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname as posixDirname } from 'node:path/posix';

import {
  CdnExecutorArtifactLocator,
  classifyHandshakeFailure,
  connectWithGuidance,
  dockerBaseArgs,
  probeExecutorTarget,
  RemoteEnvironment,
  type ExecutorArtifact,
  type LauncherSpec,
  type LocalRunner,
} from '../../src/client/index';

interface Flags {
  target?: string;
  host?: string;
  container?: string;
  context?: string;
  remoteBin?: string;
  program?: string;
  args?: string;
  env?: string;
  scenario?: string;
  remoteCwd?: string;
  cdnBase?: string;
  clientVersion?: string;
}

interface CheckResult {
  readonly scenario: string;
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

const results: CheckResult[] = [];

function record(scenario: string, name: string, ok: boolean, detail?: string): void {
  results.push({ scenario, name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${mark}] ${name}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

async function check(scenario: string, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    record(scenario, name, true);
  } catch (error) {
    record(scenario, name, false, error instanceof Error ? error.message : String(error));
  }
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error(`bad arguments: ${argv.join(' ')}`);
    }
    const name = key.slice(2);
    const camel = name.replaceAll(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    (flags as unknown as Record<string, string>)[camel] = value;
    i += 1;
  }
  return flags;
}

function buildLauncher(flags: Flags): LauncherSpec {
  switch (flags.target) {
    case 'ssh': {
      if (flags.host === undefined) throw new Error('--target ssh requires --host');
      return { type: 'ssh', host: flags.host, remoteBin: flags.remoteBin };
    }
    case 'docker': {
      if (flags.container === undefined) throw new Error('--target docker requires --container');
      return {
        type: 'docker',
        container: flags.container,
        context: flags.context,
        remoteBin: flags.remoteBin,
      };
    }
    case 'command': {
      if (flags.program === undefined) throw new Error('--target command requires --program');
      const env: Record<string, string> = {};
      if (flags.env !== undefined) {
        for (const pair of flags.env.split(',')) {
          const eq = pair.indexOf('=');
          if (eq <= 0) throw new Error(`bad --env entry "${pair}", want K=V`);
          env[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }
      return {
        type: 'command',
        program: flags.program,
        args: flags.args === undefined ? [] : flags.args.split(/\s+/).filter((arg) => arg.length > 0),
        env: Object.keys(env).length > 0 ? env : undefined,
      };
    }
    default:
      throw new Error(`unknown --target "${flags.target ?? ''}" (want ssh, docker or command)`);
  }
}

async function collectStdout(proc: {
  stdout: NodeJS.ReadableStream;
  wait(): Promise<number>;
}): Promise<{ out: string; code: number }> {
  const chunks: Buffer[] = [];
  proc.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const ended = new Promise<void>((resolve, reject) => {
    proc.stdout.on('end', () => {
      resolve();
    });
    proc.stdout.on('error', reject);
  });
  const code = await proc.wait();
  await ended;
  return { out: Buffer.concat(chunks).toString(), code };
}

async function remotePidAlive(environment: RemoteEnvironment, pid: number): Promise<boolean> {
  const proc = await environment.process.spawn('kill', ['-0', String(pid)]);
  const { code } = await collectStdout(proc);
  return code === 0;
}

async function scenarioBasic(environment: RemoteEnvironment, cwd: string): Promise<void> {
  process.stdout.write('scenario: basic\n');
  record('basic', 'connect + handshake', true, `executor ${environment.executorVersion} on ${environment.host.osKind}/${environment.host.osArch}`);
  await check('basic', 'environment payload is sane', async () => {
    const env = environment.host;
    for (const field of ['osKind', 'osArch', 'osVersion', 'shellName', 'shellPath', 'pathClass', 'homeDir', 'cwd', 'tempDir'] as const) {
      if (env[field].length === 0) throw new Error(`environment.${field} is empty`);
    }
    if (env.pathClass !== 'posix') throw new Error(`pathClass ${env.pathClass} is not posix`);
  });
  const file = `${cwd}/remote-exec-e2e-basic.txt`;
  await check('basic', 'fs write/read/rename/remove round-trip', async () => {
    await environment.fs.writeText(file, 'e2e-data');
    expectEqual(await environment.fs.readText(file), 'e2e-data', 'readText');
    const renamed = `${file}.renamed`;
    await environment.fs.rename(file, renamed);
    expectEqual(await environment.fs.readText(renamed), 'e2e-data', 'readText after rename');
    await environment.fs.remove(renamed);
    const stat = await environment.fs.stat(renamed).then(
      () => 'present',
      () => 'gone',
    );
    expectEqual(stat, 'gone', 'remove');
  });
  await check('basic', 'process run with output and exit code', async () => {
    const proc = await environment.process.spawn('bash', ['-c', 'echo e2e-out; echo e2e-err >&2; exit 5'], { cwd });
    const { out, code } = await collectStdout(proc);
    expectEqual(out, 'e2e-out\n', 'stdout');
    expectEqual(code, 5, 'exit code');
  });
  await check('basic', 'only explicit env overrides cross the wire', async () => {
    const witness = 'REMOTE_EXEC_E2E_WITNESS';
    const plain = await environment.process.spawn('sh', ['-c', `printf '[%s]' "$${witness}"`], { cwd });
    expectEqual((await collectStdout(plain)).out, '[]', 'without override');
    const explicit = await environment.process.spawn('sh', ['-c', `printf '[%s]' "$${witness}"`], {
      cwd,
      env: { [witness]: 'explicit-e2e' },
    });
    expectEqual((await collectStdout(explicit)).out, '[explicit-e2e]', 'with override');
  });
}

async function scenarioPty(environment: RemoteEnvironment, cwd: string): Promise<void> {
  process.stdout.write('scenario: pty\n');
  const shell = environment.host.shellPath;
  try {
    const terminal = await environment.terminal.spawn({ cwd, shell, cols: 90, rows: 30 });
    await check('pty', 'interactive shell over pty with merged streams', async () => {
      let output = '';
      terminal.onProcessData((data) => {
        output += data;
      });
      const exited = new Promise<number | null>((resolve) => {
        terminal.onProcessExit(({ exitCode }) => {
          resolve(exitCode);
        });
      });
      terminal.write('echo pty-out; echo pty-err >&2; exit 11\n');
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (output.includes('pty-out') && output.includes('pty-err')) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      if (!output.includes('pty-out')) throw new Error(`stdout missing in pty stream: ${JSON.stringify(output.slice(-200))}`);
      if (!output.includes('pty-err')) throw new Error(`stderr missing in pty stream: ${JSON.stringify(output.slice(-200))}`);
      terminal.resize(100, 40);
      const code = await exited;
      expectEqual(code, 11, 'pty exit code');
    });
  } catch (error) {
    record('pty', 'spawn pty', false, `SKIP-OR-FAIL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function scenarioTermIgnore(environment: RemoteEnvironment, cwd: string): Promise<void> {
  process.stdout.write('scenario: term-ignore\n');
  await check('term-ignore', 'SIGTERM-ignoring process is escalated to SIGKILL', async () => {
    const processId = randomUUID();
    await environment.connection.call('process/start', {
      processId,
      argv: ['bash', '-c', 'trap "" TERM; sleep 300'],
      cwd,
      pipeStdin: false,
    });
    const exited = new Promise<number>((resolve) => {
      const unsubscribe = environment.connection.onNotification('process/exited', (params) => {
        const event = params as { processId: string; exitCode: number };
        if (event.processId !== processId) return;
        unsubscribe();
        resolve(event.exitCode);
      });
    });
    const started = Date.now();
    const terminate = (await environment.connection.call('process/terminate', { processId })) as {
      running: boolean;
    };
    expectEqual(terminate.running, true, 'terminate.running');
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('process never exited after terminate'));
        }, 10_000);
      }),
    ]);
    expectEqual(typeof exitCode, 'number', 'exit code observed');
    if (Date.now() - started > 8_000) throw new Error('escalation took too long');
  });
}

async function scenarioGroupResidue(environment: RemoteEnvironment, cwd: string): Promise<void> {
  process.stdout.write('scenario: group-residue\n');
  await check('group-residue', 'residue of an exited leader is cleaned on signal', async () => {
    const proc = await environment.process.spawn('sh', ['-c', 'sleep 300 & echo $!; exit 0'], { cwd });
    let buffer = '';
    const childPid = await new Promise<number>((resolve, reject) => {
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /(\d+)/.exec(buffer);
        if (match !== null) resolve(Number(match[1]));
      });
      setTimeout(() => {
        reject(new Error('timed out waiting for the residue pid'));
      }, 8_000);
    });
    await proc.wait();
    if (!(await remotePidAlive(environment, childPid))) {
      throw new Error(`residue pid ${childPid} was never alive`);
    }
    await proc.kill('SIGTERM');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (!(await remotePidAlive(environment, childPid))) return;
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    throw new Error(`residue pid ${childPid} survived the group signal`);
  });
}

async function scenarioDisconnect(
  environment: RemoteEnvironment,
  cwd: string,
  reconnect: () => Promise<RemoteEnvironment>,
): Promise<void> {
  process.stdout.write('scenario: disconnect\n');
  let sleepPid = -1;
  await check('disconnect', 'long-running process started', async () => {
    const proc = await environment.process.spawn('sleep', ['300'], { cwd });
    sleepPid = proc.pid;
  });
  if (sleepPid <= 0) return;
  await environment.dispose();
  await check('disconnect', 'calls after disconnect reject instead of falling back to local', async () => {
    await environment.process.spawn('touch', ['/tmp/remote-exec-e2e-must-not-exist']).then(
      () => {
        throw new Error('spawn succeeded after disconnect — silent fallback suspected');
      },
      () => {},
    );
    await environment.fs.readText('/etc/hostname').then(
      () => {
        throw new Error('fs call succeeded after disconnect — silent fallback suspected');
      },
      () => {},
    );
  });
  await check('disconnect', 'remote processes of the dropped connection are gone', async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
    const probe = await reconnect();
    try {
      if (await remotePidAlive(probe, sleepPid)) {
        throw new Error(`sleep pid ${sleepPid} survived the connection drop`);
      }
    } finally {
      await probe.dispose();
    }
  });
}

async function scenarioContainerStop(environment: RemoteEnvironment, container: string, cwd: string): Promise<void> {
  process.stdout.write('scenario: container-stop\n');
  const proc = await environment.process.spawn('sleep', ['300'], { cwd });
  const stop = localSpawn('docker', ['stop', container], { stdio: 'ignore' });
  await new Promise<void>((resolve) => {
    stop.on('exit', () => {
      resolve();
    });
  });
  await check('container-stop', 'environment reports disconnected after the container stops', async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (environment.status === 'disconnected') return;
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    throw new Error(`environment status is still ${environment.status}`);
  });
  await check('container-stop', 'calls after the stop reject, no local fallback', async () => {
    await environment.process.spawn('true').then(
      () => {
        throw new Error('spawn succeeded after container stop — silent fallback suspected');
      },
      () => {},
    );
  });
  void proc;
}

async function scenarioInstall(flags: Flags): Promise<void> {
  process.stdout.write('scenario: install\n');
  const cdnBase = flags.cdnBase;
  const clientVersion = flags.clientVersion;
  if (cdnBase === undefined) throw new Error('--scenario install requires --cdn-base <url>');
  if (clientVersion === undefined) {
    throw new Error('--scenario install requires --client-version <semver>');
  }
  const launcher = buildLauncher(flags);
  if (launcher.type === 'command') {
    throw new Error('--scenario install requires a typed target (ssh or docker)');
  }
  const locator = new CdnExecutorArtifactLocator({ cdnBaseUrl: cdnBase });
  const onDiagnostic = (line: string): void => {
    process.stdout.write(`  [diag] ${line}\n`);
  };
  const connectBase = {
    workspaceId: 'remote-exec-e2e',
    environmentId: 'e2e-target',
    clientName: 'remote-exec-e2e-driver',
    clientVersion,
    onDiagnostic,
  };

  await check('install', 'connect on a fresh target fails as a missing executor', async () => {
    try {
      await RemoteEnvironment.connect({ ...connectBase, launcher });
    } catch (error) {
      const cls = classifyHandshakeFailure(error);
      if (cls === 'missing' || cls === 'timeout') return;
      throw new Error(
        `expected a missing/timeout failure, got ${cls}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    throw new Error('connect succeeded before any install — use a fresh target for this scenario');
  });

  await check('install', 'the failure prints per-launcher install guidance and installs nothing', async () => {
    let attempts = 0;
    const outcome = await connectWithGuidance(
      async (retryLauncher) => {
        attempts += 1;
        return RemoteEnvironment.connect({ ...connectBase, launcher: retryLauncher });
      },
      { launcher, artifactLocator: locator, clientVersion, runner: driverRunner },
    ).then(
      () => 'connected' as const,
      (error: unknown) => error,
    );
    if (outcome === 'connected') {
      throw new Error('connect succeeded on a fresh target');
    }
    if (attempts !== 1) {
      throw new Error(`expected exactly 1 connect attempt, got ${String(attempts)}`);
    }
    const message = outcome instanceof Error ? outcome.message : String(outcome);
    const probed = await probeExecutorTarget(launcher, driverRunner);
    if (probed === undefined) throw new Error('could not probe the target platform');
    const artifact = await locator.locate(probed.target, clientVersion);
    for (const expected of [artifact.url, 'curl -fL', '/tmp/kimi-install', '.kimi-code/bin/kimi', 'Then reconnect the environment.']) {
      if (!message.includes(expected)) {
        throw new Error(`guidance is missing ${JSON.stringify(expected)}:\n${message}`);
      }
    }
    if (launcher.type === 'ssh' && !message.includes(`scp /tmp/kimi-install ${launcher.host}:/tmp/kimi-install`)) {
      throw new Error(`guidance is missing the scp command:\n${message}`);
    }
    if (launcher.type === 'docker' && !message.includes(`cp /tmp/kimi-install ${launcher.container}:/tmp/kimi-install`)) {
      throw new Error(`guidance is missing the docker cp command:\n${message}`);
    }
    // Detection only: nothing was installed, so a raw connect still fails as
    // a missing executor.
    try {
      await RemoteEnvironment.connect({ ...connectBase, launcher });
    } catch (error) {
      const cls = classifyHandshakeFailure(error);
      if (cls === 'missing' || cls === 'timeout') return;
      throw new Error(
        `expected the target to still miss the executor, got ${cls}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    throw new Error('the executor appeared on the target without a manual install');
  });

  await check('install', 'following the guidance manually yields a working environment', async () => {
    const probed = await probeExecutorTarget(launcher, driverRunner);
    if (probed === undefined) throw new Error('could not probe the target platform');
    const artifact = await locator.locate(probed.target, clientVersion);
    await manualInstall(launcher, artifact);
    let attempts = 0;
    const environment = await connectWithGuidance(
      async (retryLauncher) => {
        attempts += 1;
        return RemoteEnvironment.connect({ ...connectBase, launcher: retryLauncher });
      },
      { launcher, artifactLocator: locator, clientVersion, runner: driverRunner },
    );
    try {
      if (attempts !== 1) {
        throw new Error(`expected the connect to succeed on the first attempt, got ${String(attempts)}`);
      }
      const binPath = flags.remoteBin ?? `${environment.host.homeDir}/.kimi-code/bin/kimi`;
      const meta = await environment.fs.stat(binPath);
      if (!meta.isFile) throw new Error(`${binPath} is not a file on the target`);
      const probe = `${environment.host.tempDir}/remote-exec-e2e-install.txt`;
      await environment.fs.writeText(probe, 'installed');
      const text = await environment.fs.readText(probe);
      await environment.fs.remove(probe);
      if (text !== 'installed') throw new Error('fs round-trip after install failed');
    } finally {
      await environment.dispose();
    }
  });
}

const driverRunner: LocalRunner = (request) =>
  new Promise((resolve, reject) => {
    const child = localSpawn(request.program, [...request.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });

async function runLocal(program: string, args: readonly string[]): Promise<void> {
  const result = await driverRunner({ program, args });
  if (result.code !== 0) {
    const output = result.stderr.trim() || result.stdout.trim() || 'no output';
    throw new Error(`${program} ${args.join(' ')} exited with code ${String(result.code)}: ${output}`);
  }
}

// The manual install the failure guidance describes: download the located
// artifact, verify the pinned sha256, copy it to the target (scp / docker
// cp), then chmod + mv it into the executor path.
async function manualInstall(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  artifact: ExecutorArtifact,
): Promise<void> {
  const localPath = await downloadVerified(artifact);
  if (launcher.type === 'ssh') {
    await runLocal('scp', [localPath, `${launcher.host}:/tmp/kimi-install`]);
    const dest = launcher.remoteBin;
    const script =
      dest === undefined
        ? 'mkdir -p "$HOME"/.kimi-code/bin && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "$HOME"/.kimi-code/bin/kimi'
        : `mkdir -p "${posixDirname(dest)}" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "${dest}"`;
    await runLocal('ssh', [launcher.host, script]);
    return;
  }
  const home = await dockerHomeDir(launcher);
  const dest = launcher.remoteBin ?? `${home}/.kimi-code/bin/kimi`;
  await runLocal('docker', [
    ...dockerBaseArgs(launcher.context),
    'cp',
    localPath,
    `${launcher.container}:/tmp/kimi-install`,
  ]);
  await runLocal('docker', [
    ...dockerBaseArgs(launcher.context),
    'exec',
    launcher.container,
    'sh',
    '-c',
    `mkdir -p "${posixDirname(dest)}" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "${dest}"`,
  ]);
}

async function dockerHomeDir(
  launcher: LauncherSpec & { readonly type: 'docker' },
): Promise<string> {
  const result = await driverRunner({
    program: 'docker',
    args: [...dockerBaseArgs(launcher.context), 'exec', launcher.container, 'sh', '-c', 'printf "%s" "$HOME"'],
  });
  if (result.code !== 0) {
    throw new Error(`container home probe failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const home = result.stdout.trim();
  if (!home.startsWith('/')) throw new Error(`unexpected container home ${JSON.stringify(home)}`);
  return home;
}

async function downloadVerified(artifact: ExecutorArtifact): Promise<string> {
  const response = await fetch(artifact.url);
  if (!response.ok) {
    throw new Error(`downloading ${artifact.url} returned HTTP ${String(response.status)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== artifact.sha256) {
    throw new Error(
      `checksum mismatch for ${artifact.filename}: expected ${artifact.sha256}, got ${sha256}`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), 'kimi-executor-e2e-'));
  const path = join(dir, artifact.filename);
  await writeFile(path, bytes);
  return path;
}

const SCENARIOS = ['install', 'basic', 'pty', 'term-ignore', 'group-residue', 'container-stop', 'disconnect'] as const;

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  // install is opt-in: it needs --cdn-base/--client-version and a fresh target.
  const defaultScenarios = SCENARIOS.filter((name) => name !== 'install').join(',');
  const requested = (flags.scenario ?? defaultScenarios).split(',').map((name) => name.trim());
  for (const name of requested) {
    if (!(SCENARIOS as readonly string[]).includes(name)) {
      throw new Error(`unknown scenario "${name}" (want one of ${SCENARIOS.join(', ')})`);
    }
  }
  // install runs first: it needs a fresh target (no executor), and afterwards
  // the executor is in place for the remaining scenarios.
  if (requested.includes('install')) {
    await scenarioInstall(flags);
  }
  const rest = requested.filter((name) => name !== 'install');

  if (rest.length > 0) {
    const launcher = buildLauncher(flags);
    // Destructive scenarios run last, disconnect before container-stop: a
    // stopped container would break any later scenario's fresh connection.
    const ordered = [...rest].toSorted((a, b) => {
      const weight = (name: string): number => (name === 'disconnect' ? 1 : name === 'container-stop' ? 2 : 0);
      return weight(a) - weight(b);
    });

    process.stdout.write(`connecting via ${flags.target ?? ''} launcher...\n`);
    const connect = (): Promise<RemoteEnvironment> =>
      RemoteEnvironment.connect({
        workspaceId: 'remote-exec-e2e',
        environmentId: 'e2e-target',
        launcher,
        clientName: 'remote-exec-e2e-driver',
        clientVersion: '0.0.0',
        minExecutorVersion: '0.0.0',
        onDiagnostic: (line) => {
          process.stdout.write(`  [diag] ${line}\n`);
        },
      });
    const environment = await connect();
    const cwd = flags.remoteCwd ?? environment.host.cwd;

    for (const name of ordered) {
      switch (name) {
        case 'basic':
          await scenarioBasic(environment, cwd);
          break;
        case 'pty':
          await scenarioPty(environment, cwd);
          break;
        case 'term-ignore':
          await scenarioTermIgnore(environment, cwd);
          break;
        case 'group-residue':
          await scenarioGroupResidue(environment, cwd);
          break;
        case 'container-stop': {
          if (flags.container === undefined) {
            record('container-stop', 'prerequisite', true, 'skipped: requires --container');
            break;
          }
          const fresh = await connect();
          try {
            await scenarioContainerStop(fresh, flags.container, cwd);
          } finally {
            if (fresh.status !== 'disposed') {
              await fresh.dispose();
            }
          }
          break;
        }
        case 'disconnect': {
          const fresh = await connect();
          await scenarioDisconnect(fresh, cwd, connect);
          break;
        }
      }
    }

    if (environment.status !== 'disposed') {
      await environment.dispose();
    }
  }

  const failures = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failures.length}/${results.length} checks passed\n`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`driver failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
