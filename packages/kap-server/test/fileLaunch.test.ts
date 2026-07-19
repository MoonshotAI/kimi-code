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
  it('hides the console window a detached child would get on Windows', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    const promise = launchDetached({ command: 'code', args: ['file.ts'], shell: true });
    child.emit('spawn');
    await promise;
    expect(child.unref).toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      'code',
      ['file.ts'],
      expect.objectContaining({ detached: true, windowsHide: true }),
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
