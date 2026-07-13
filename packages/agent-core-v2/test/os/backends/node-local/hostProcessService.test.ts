/**
 * Scenario: node-local process spawning and tree-scoped termination.
 * Exercises `IHostProcessService` through DI with real local processes.
 * Run: `pnpm exec vitest run test/os/backends/node-local/hostProcessService.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { once } from 'node:events';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { Readable } from 'node:stream';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
  type IHostProcess,
} from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

const PROCESS_TREE_SCRIPT = `
  const { spawn } = require('node:child_process');
  const readline = require('node:readline');

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  process.stdout.write('READY:' + child.pid + '\\n');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line === 'PING') process.stdout.write('PONG\\n');
  });
  setInterval(() => {}, 1000);
`;

interface ProcessTree {
  readonly process: IHostProcess;
  readonly lines: ReadlineInterface;
  readonly grandchildPid: number;
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function nextLine(lines: ReadlineInterface): Promise<string> {
  const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(5_000) });
  return String(line);
}

async function spawnProcessTree(service: IHostProcessService): Promise<ProcessTree> {
  const proc = await service.spawn(process.execPath, ['-e', PROCESS_TREE_SCRIPT]);
  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  try {
    const ready = await nextLine(lines);
    const match = /^READY:(\d+)$/.exec(ready);
    if (match?.[1] === undefined) {
      throw new Error(`Process tree did not report a grandchild pid: ${ready}`);
    }
    return { process: proc, lines, grandchildPid: Number.parseInt(match[1], 10) };
  } catch (error) {
    lines.close();
    await stopProcess(proc);
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false), {
    interval: 25,
    timeout: 5_000,
  });
}

async function stopProcess(proc: IHostProcess): Promise<void> {
  if (proc.exitCode === null) {
    try {
      await proc.kill('SIGKILL');
    } catch {
      // Best-effort test cleanup; wait() below observes the real outcome.
    }
  }
  try {
    await proc.wait();
  } catch {
    // Best-effort test cleanup.
  }
  proc.dispose();
}

async function cleanupProcessTree(tree: ProcessTree): Promise<void> {
  tree.lines.close();
  await stopProcess(tree.process);
  if (!isProcessAlive(tree.grandchildPid)) return;
  try {
    process.kill(tree.grandchildPid, 'SIGKILL');
  } catch {
    // Best-effort fallback if the process exited between the probe and kill.
  }
  await waitForProcessExit(tree.grandchildPid);
}

describe('HostProcessService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('spawns a process and captures stdout + exit code', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write("ok")']);
    const out = await collect(proc.stdout);
    expect(out).toBe('ok');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('passes env overrides to the child', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write(process.env.FOO ?? "")'], {
      env: { FOO: 'bar' },
    });
    const out = await collect(proc.stdout);
    expect(out).toBe('bar');
    expect(await proc.wait()).toBe(0);
  });

  it('throws a coded error when the command does not exist', async () => {
    const svc = ix.get(IHostProcessService);
    await expect(svc.spawn('definitely-not-a-real-command-42')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(HostProcessError);
      const error = err as HostProcessError;
      expect(error.code).toBe(HostProcessErrorCode.SpawnFailed);
      expect(error.code).toBe('os.process.spawn_failed');
      expect(error.details).toMatchObject({
        command: 'definitely-not-a-real-command-42',
        errno: 'ENOENT',
      });
      expect(error.cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it('terminates a running process with kill()', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    expect(proc.pid).toBeGreaterThan(0);
    await proc.kill('SIGTERM');
    const code = await proc.wait();
    expect(code).not.toBe(0);
  });

  it('kill() terminates only the selected process tree', async () => {
    const svc = ix.get(IHostProcessService);
    const trees: ProcessTree[] = [];
    try {
      const selected = await spawnProcessTree(svc);
      trees.push(selected);
      const survivor = await spawnProcessTree(svc);
      trees.push(survivor);

      await selected.process.kill();
      await selected.process.wait();
      await waitForProcessExit(selected.grandchildPid);

      const pong = nextLine(survivor.lines);
      survivor.process.stdin.write('PING\n');
      await expect(pong).resolves.toBe('PONG');
      expect(isProcessAlive(survivor.process.pid)).toBe(true);
      expect(isProcessAlive(survivor.grandchildPid)).toBe(true);
    } finally {
      await Promise.all(trees.map(cleanupProcessTree));
    }
  }, 15_000);
});
