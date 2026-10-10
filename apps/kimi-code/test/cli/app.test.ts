import { resolve } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerAppCommand } from '#/cli/sub/app';
import { openUrl } from '#/utils/open-url';

vi.mock('#/utils/open-url', () => ({ openUrl: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('kimi app', () => {
  it.each([undefined, '.', '../project', '/tmp/项目 & a#b%'])('opens a new desktop chat for %s', async (path) => {
    const program = new Command('kimi');
    registerAppCommand(program);
    await program.parseAsync(['node', 'kimi', 'app', ...(path === undefined ? [] : [path])]);
    const url = new URL(vi.mocked(openUrl).mock.calls[0]![0]);
    expect(url.protocol).toBe('kimi-code:');
    expect(url.host).toBe('open');
    expect(url.searchParams.get('root')).toBe(resolve(path ?? process.cwd()));
    expect(url.searchParams.get('new')).toBe('1');
    expect(url.hash).toBe('');
  });

  it('shows the installation command when the OS opener fails', async () => {
    const exitCode = process.exitCode;
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(openUrl).mockImplementation((_url, onError) => onError?.(new Error('no handler')));
    try {
      const program = new Command('kimi');
      registerAppCommand(program);
      await program.parseAsync(['node', 'kimi', 'app']);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('kimi install-desktop'));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
    }
  });
});
