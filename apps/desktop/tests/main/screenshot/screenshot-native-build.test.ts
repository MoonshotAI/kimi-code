import { afterEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock('node:child_process', () => ({ spawnSync: run }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), realpath: vi.fn(async () => '/node/bin/node'), writeFile: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  vi.clearAllMocks();
});

describe('native screenshot build compatibility', () => {
  it.each([['arm64', 'arm64'], ['x64', 'x86_64']])('targets macOS 12 for every %s binary', async (nodeArch, targetArch) => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: nodeArch });
    const build = '../../../native/screenshot-window-list/build.mjs';
    await import(build);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [command, args] of run.mock.calls as unknown as [string, string[]][]) {
      expect(command).toBe('xcrun');
      expect(args[args.indexOf('-target') + 1]).toBe(`${targetArch}-apple-macosx12.0`);
    }
  });
});
