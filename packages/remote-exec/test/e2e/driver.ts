import { spawn as localSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { RemoteRuntime, type LauncherSpec } from '../../src/client/index';

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

async function remotePidAlive(runtime: RemoteRuntime, pid: number): Promise<boolean> {
  const proc = await runtime.process.spawn('kill', ['-0', String(pid)]);
  const { code } = await collectStdout(proc);
  return code === 0;
}

async function scenarioBasic(runtime: RemoteRuntime, cwd: string): Promise<void> {
  process.stdout.write('scenario: basic\n');
  record('basic', 'connect + handshake', true, `executor ${runtime.executorVersion} on ${runtime.environment.osKind}/${runtime.environment.osArch}`);
  await check('basic', 'environment payload is sane', async () => {
    const env = runtime.environment;
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

async function scenarioPty(runtime: RemoteRuntime, cwd: string): Promise<void> {
  process.stdout.write('scenario: pty\n');
  const shell = runtime.environment.shellPath;
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

async function scenarioTermIgnore(runtime: RemoteRuntime, cwd: string): Promise<void> {
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

async function scenarioGroupResidue(runtime: RemoteRuntime, cwd: string): Promise<void> {
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
  runtime: RemoteRuntime,
  cwd: string,
  reconnect: () => Promise<RemoteRuntime>,
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

async function scenarioContainerStop(runtime: RemoteRuntime, container: string, cwd: string): Promise<void> {
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

const SCENARIOS = ['basic', 'pty', 'term-ignore', 'group-residue', 'container-stop', 'disconnect'] as const;

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const launcher = buildLauncher(flags);
  const requested = (flags.scenario ?? SCENARIOS.join(',')).split(',').map((name) => name.trim());
  for (const name of requested) {
    if (!(SCENARIOS as readonly string[]).includes(name)) {
      throw new Error(`unknown scenario "${name}" (want one of ${SCENARIOS.join(', ')})`);
    }
  }
  // Destructive scenarios run last, disconnect before container-stop: a
  // stopped container would break any later scenario's fresh connection.
  const ordered = [...requested].toSorted((a, b) => {
    const weight = (name: string): number => (name === 'disconnect' ? 1 : name === 'container-stop' ? 2 : 0);
    return weight(a) - weight(b);
  });

  process.stdout.write(`connecting via ${flags.target} launcher...\n`);
  const connect = (): Promise<RemoteRuntime> =>
    RemoteRuntime.connect({
      workspaceId: 'remote-exec-e2e',
      runtimeId: 'e2e-target',
      launcher,
      clientName: 'remote-exec-e2e-driver',
      clientVersion: '0.0.0',
      minExecutorVersion: '0.0.0',
      onDiagnostic: (line) => {
        process.stdout.write(`  [diag] ${line}\n`);
      },
    });
  const runtime = await connect();
  const cwd = flags.remoteCwd ?? runtime.environment.cwd;

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
