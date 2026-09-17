import { spawn as localSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  CdnExecutorArtifactLocator,
  classifyHandshakeFailure,
  connectWithAutoInstall,
  installExecutor,
  RemoteEnvironment,
  type ExecutorArtifactLocator,
  type LauncherSpec,
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

async function remotePidAlive(runtime: RemoteEnvironment, pid: number): Promise<boolean> {
  const proc = await runtime.process.spawn('kill', ['-0', String(pid)]);
  const { code } = await collectStdout(proc);
  return code === 0;
}

async function scenarioBasic(runtime: RemoteEnvironment, cwd: string): Promise<void> {
  process.stdout.write('scenario: basic\n');
  record('basic', 'connect + handshake', true, `executor ${runtime.executorVersion} on ${runtime.host.osKind}/${runtime.host.osArch}`);
  await check('basic', 'environment payload is sane', async () => {
    const env = runtime.host;
    for (const field of ['osKind', 'osArch', 'osVersion', 'shellName', 'shellPath', 'pathClass', 'homeDir', 'cwd', 'tempDir'] as const) {
      if (env[field].length === 0) throw new Error(`environment.${field} is empty`);
    }
    if (env.pathClass !== 'posix') throw new Error(`pathClass ${env.pathClass} is not posix`);
  });
  const file = `${cwd}/remote-exec-e2e-basic.txt`;
  await check('basic', 'fs write/read/rename/remove round-trip', async () => {
    await runtime.fs.writeText(file, 'e2e-data');
    expectEqual(await runtime.fs.readText(file), 'e2e-data', 'readText');
    const renamed = `${file}.renamed`;
    await runtime.fs.rename(file, renamed);
    expectEqual(await runtime.fs.readText(renamed), 'e2e-data', 'readText after rename');
    await runtime.fs.remove(renamed);
    const stat = await runtime.fs.stat(renamed).then(
      () => 'present',
      () => 'gone',
    );
    expectEqual(stat, 'gone', 'remove');
  });
  await check('basic', 'process run with output and exit code', async () => {
    const proc = await runtime.process.spawn('bash', ['-c', 'echo e2e-out; echo e2e-err >&2; exit 5'], { cwd });
    const { out, code } = await collectStdout(proc);
    expectEqual(out, 'e2e-out\n', 'stdout');
    expectEqual(code, 5, 'exit code');
  });
  await check('basic', 'only explicit env overrides cross the wire', async () => {
    const witness = 'REMOTE_EXEC_E2E_WITNESS';
    const plain = await runtime.process.spawn('sh', ['-c', `printf '[%s]' "$${witness}"`], { cwd });
    expectEqual((await collectStdout(plain)).out, '[]', 'without override');
    const explicit = await runtime.process.spawn('sh', ['-c', `printf '[%s]' "$${witness}"`], {
      cwd,
      env: { [witness]: 'explicit-e2e' },
    });
    expectEqual((await collectStdout(explicit)).out, '[explicit-e2e]', 'with override');
  });
}

async function scenarioPty(runtime: RemoteEnvironment, cwd: string): Promise<void> {
  process.stdout.write('scenario: pty\n');
  const shell = runtime.host.shellPath;
  try {
    const terminal = await runtime.terminal.spawn({ cwd, shell, cols: 90, rows: 30 });
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

async function scenarioTermIgnore(runtime: RemoteEnvironment, cwd: string): Promise<void> {
  process.stdout.write('scenario: term-ignore\n');
  await check('term-ignore', 'SIGTERM-ignoring process is escalated to SIGKILL', async () => {
    const processId = randomUUID();
    await runtime.connection.call('process/start', {
      processId,
      argv: ['bash', '-c', 'trap "" TERM; sleep 300'],
      cwd,
      pipeStdin: false,
    });
    const started = Date.now();
    const terminate = (await runtime.connection.call('process/terminate', { processId })) as {
      running: boolean;
    };
    expectEqual(terminate.running, true, 'terminate.running');
    let exited = false;
    const deadline = Date.now() + 10_000;
    while (!exited && Date.now() < deadline) {
      const read = (await runtime.connection.call('process/read', { processId, waitMs: 1000 })) as {
        exited: boolean;
      };
      exited = read.exited;
    }
    if (!exited) throw new Error('process never exited after terminate');
    if (Date.now() - started > 8_000) throw new Error('escalation took too long');
  });
}

async function scenarioGroupResidue(runtime: RemoteEnvironment, cwd: string): Promise<void> {
  process.stdout.write('scenario: group-residue\n');
  await check('group-residue', 'residue of an exited leader is cleaned on signal', async () => {
    const proc = await runtime.process.spawn('sh', ['-c', 'sleep 300 & echo $!; exit 0'], { cwd });
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
    if (!(await remotePidAlive(runtime, childPid))) {
      throw new Error(`residue pid ${childPid} was never alive`);
    }
    await proc.kill('SIGTERM');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (!(await remotePidAlive(runtime, childPid))) return;
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    throw new Error(`residue pid ${childPid} survived the group signal`);
  });
}

async function scenarioDisconnect(
  runtime: RemoteEnvironment,
  cwd: string,
  reconnect: () => Promise<RemoteEnvironment>,
): Promise<void> {
  process.stdout.write('scenario: disconnect\n');
  let sleepPid = -1;
  await check('disconnect', 'long-running process started', async () => {
    const proc = await runtime.process.spawn('sleep', ['300'], { cwd });
    sleepPid = proc.pid;
  });
  if (sleepPid <= 0) return;
  await runtime.dispose();
  await check('disconnect', 'calls after disconnect reject instead of falling back to local', async () => {
    await runtime.process.spawn('touch', ['/tmp/remote-exec-e2e-must-not-exist']).then(
      () => {
        throw new Error('spawn succeeded after disconnect — silent fallback suspected');
      },
      () => {},
    );
    await runtime.fs.readText('/etc/hostname').then(
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

async function scenarioContainerStop(runtime: RemoteEnvironment, container: string, cwd: string): Promise<void> {
  process.stdout.write('scenario: container-stop\n');
  const proc = await runtime.process.spawn('sleep', ['300'], { cwd });
  const stop = localSpawn('docker', ['stop', container], { stdio: 'ignore' });
  await new Promise<void>((resolve) => {
    stop.on('exit', () => {
      resolve();
    });
  });
  await check('container-stop', 'runtime reports disconnected after the container stops', async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (runtime.status === 'disconnected') return;
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    throw new Error(`runtime status is still ${runtime.status}`);
  });
  await check('container-stop', 'calls after the stop reject, no local fallback', async () => {
    await runtime.process.spawn('true').then(
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

  await check('install', 'a tampered checksum aborts the auto-install without a connect retry', async () => {
    const badLocator: ExecutorArtifactLocator = {
      locate: async (target, version) => ({
        ...(await locator.locate(target, version)),
        sha256: '0'.repeat(64),
      }),
    };
    let attempts = 0;
    let outcome: 'connected' | unknown;
    try {
      await connectWithAutoInstall(
        async (retryLauncher) => {
          attempts += 1;
          return RemoteEnvironment.connect({ ...connectBase, launcher: retryLauncher });
        },
        { launcher, artifactLocator: badLocator, clientVersion, onDiagnostic },
      );
      outcome = 'connected';
    } catch (error) {
      outcome = error;
    }
    if (outcome === 'connected') {
      throw new Error('connect succeeded despite the tampered checksum');
    }
    const message = outcome instanceof Error ? outcome.message : String(outcome);
    if (!message.includes('Auto-install failed') || !message.includes('checksum mismatch')) {
      throw new Error(`unexpected failure text: ${message}`);
    }
    if (attempts !== 1) {
      throw new Error(`connect was retried ${String(attempts - 1)} times after the failed install`);
    }
  });

  await check('install', 'auto-install on the handshake failure yields a working runtime', async () => {
    let attempts = 0;
    const runtime = await connectWithAutoInstall(
      async (retryLauncher) => {
        attempts += 1;
        return RemoteEnvironment.connect({ ...connectBase, launcher: retryLauncher });
      },
      { launcher, artifactLocator: locator, clientVersion, onDiagnostic },
    );
    try {
      if (attempts !== 2) {
        throw new Error(`expected exactly 2 connect attempts (fail + one retry), got ${String(attempts)}`);
      }
      const binPath = flags.remoteBin ?? `${runtime.host.homeDir}/.kimi-code/bin/kimi`;
      const meta = await runtime.fs.stat(binPath);
      if (!meta.isFile) throw new Error(`${binPath} is not a file on the target`);
      const probe = `${runtime.host.tempDir}/remote-exec-e2e-install.txt`;
      await runtime.fs.writeText(probe, 'installed');
      const text = await runtime.fs.readText(probe);
      await runtime.fs.remove(probe);
      if (text !== 'installed') throw new Error('fs round-trip after install failed');
    } finally {
      await runtime.dispose();
    }
  });

  await check('install', 'a second install is a no-op (already installed)', async () => {
    const result = await installExecutor({
      launcher,
      locator,
      version: clientVersion,
      onProgress: onDiagnostic,
    });
    if (!result.alreadyInstalled) throw new Error('the second install downloaded again');
  });
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
    const runtime = await connect();
    const cwd = flags.remoteCwd ?? runtime.host.cwd;

    for (const name of ordered) {
      switch (name) {
        case 'basic':
          await scenarioBasic(runtime, cwd);
          break;
        case 'pty':
          await scenarioPty(runtime, cwd);
          break;
        case 'term-ignore':
          await scenarioTermIgnore(runtime, cwd);
          break;
        case 'group-residue':
          await scenarioGroupResidue(runtime, cwd);
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

    if (runtime.status !== 'disposed') {
      await runtime.dispose();
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
