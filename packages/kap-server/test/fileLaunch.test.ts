import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));

import { getAvailableOpenInApps, launchDetached } from '../src/lib/fileLaunch';

describe('launchDetached', () => {
  async function launchAndCapture(cmd: Parameters<typeof launchDetached>[0]) {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    const promise = launchDetached(cmd);
    child.emit('spawn');
    await promise;
    return mocks.spawn.mock.calls.at(-1);
  }

  it('hides the console window for shell-shim launches', async () => {
    await launchAndCapture({ command: 'code file.ts', args: [], shell: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'code file.ts',
      [],
      expect.objectContaining({ detached: true, windowsHide: true }),
    );
  });

  it('hides the console window for direct cmd.exe launches', async () => {
    await launchAndCapture({ command: 'cmd', args: ['/c', 'start', '""', 'C:\\f'] });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '""', 'C:\\f'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('keeps GUI windows visible (explorer.exe reveal)', async () => {
    await launchAndCapture({ command: 'explorer.exe', args: ['/select,C:\\f'] });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'explorer.exe',
      ['/select,C:\\f'],
      expect.objectContaining({ windowsHide: false }),
    );
  });
});

describe('commandExists probe on win32', () => {
  it('hides the transient cmd.exe console window', () => {
    mocks.spawnSync.mockReturnValue({ status: 0 });
    getAvailableOpenInApps('win32');
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'where', expect.any(String)],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true }),
    );
  });
});
