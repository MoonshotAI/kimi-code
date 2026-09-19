import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { HostProcessError } from '@moonshot-ai/agent-core-v2/os/interface/hostProcess';

import type { RemoteExecConnection } from '../src/client/connection';
import { RemoteTerminalService } from '../src/client/remoteTerminal';
import { connectSubprocess, type SpawnedExecutor } from './helpers/loopback';

async function ptyAvailable(): Promise<boolean> {
  try {
    await import('node-pty');
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('terminal over a subprocess loopback', () => {
  let connection: RemoteExecConnection;
  let spawned: SpawnedExecutor;
  let terminals: RemoteTerminalService;
  let skip = false;

  beforeAll(async () => {
    skip = !(await ptyAvailable());
    if (skip) return;
    ({ connection, spawned } = await connectSubprocess());
    terminals = new RemoteTerminalService(connection);
  }, 60_000);

  afterAll(() => {
    if (skip) return;
    connection.close();
    spawned.bridge.close();
  });

  it('drives an interactive shell: write, output, resize, kill', async () => {
    if (skip) return;
    const terminal = await terminals.spawn({ cwd: '/tmp', shell: '/bin/bash', cols: 100, rows: 40 });
    let output = '';
    terminal.onProcessData((data) => {
      output += data;
    });
    const exited = new Promise<number | null>((resolve) => {
      terminal.onProcessExit(({ exitCode }) => {
        resolve(exitCode);
      });
    });
    terminal.write('echo terminal-$((40+2))\n');
    const deadline = Date.now() + 8_000;
    while (!output.includes('terminal-42') && Date.now() < deadline) {
      await delay(50);
    }
    expect(output).toContain('terminal-42');
    terminal.resize(120, 50);
    terminal.kill();
    await expect(exited).resolves.not.toBeNull();
  }, 15_000);

  it('merges stdout and stderr into a single pty stream', async () => {
    if (skip) return;
    const terminal = await terminals.spawn({ cwd: '/tmp', shell: '/bin/bash', cols: 80, rows: 24 });
    let output = '';
    terminal.onProcessData((data) => {
      output += data;
    });
    const exited = new Promise<number | null>((resolve) => {
      terminal.onProcessExit(({ exitCode }) => {
        resolve(exitCode);
      });
    });
    terminal.write('echo out-stream; echo err-stream >&2; exit 7\n');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (output.includes('out-stream') && output.includes('err-stream')) break;
      await delay(50);
    }
    expect(output).toContain('out-stream');
    expect(output).toContain('err-stream');
    await expect(exited).resolves.toBe(7);
  }, 15_000);

  it('points at the cwd when the spawn cwd does not exist', async () => {
    if (skip) return;
    const missing = '/definitely-missing-cwd-9f3x';
    await expect(
      terminals.spawn({ cwd: missing, shell: '/bin/bash', cols: 80, rows: 24 }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(HostProcessError);
      const hostError = error as HostProcessError;
      expect(hostError.code).toBe('os.process.spawn_failed');
      expect(hostError.message).toContain(`cwd ${missing} does not exist or is not a directory`);
      return true;
    });
  });

  it('reports exit when the connection drops', async () => {
    if (skip) return;
    const terminal = await terminals.spawn({ cwd: '/tmp', shell: '/bin/bash', cols: 80, rows: 24 });
    const exited = new Promise<number | null>((resolve) => {
      terminal.onProcessExit(({ exitCode }) => {
        resolve(exitCode);
      });
    });
    connection.close();
    spawned.bridge.close();
    await expect(exited).resolves.toBe(-1);
  }, 15_000);
});
