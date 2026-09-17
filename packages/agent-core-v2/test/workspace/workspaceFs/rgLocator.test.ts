import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FakeRuntime } from '#/runtime/fakeRuntime';
import {
  ensureRgPath,
  getShareBinRgPath,
  rgUnavailableMessage,
  type RgProbe,
} from '#/workspace/workspaceFs/internal/rgLocator';

function probeWith(
  resolveExitCode: (args: readonly string[]) => number,
): RgProbe & { exec: ReturnType<typeof vi.fn> } {
  return {
    exec: vi.fn(async (args: readonly string[]) => ({ exitCode: resolveExitCode(args) })),
  };
}

function noRgProbe(): RgProbe & { exec: ReturnType<typeof vi.fn> } {
  return probeWith(() => -1);
}

function remoteRuntime(runtimeId: string, homeDir = '/home/remote'): FakeRuntime {
  return new FakeRuntime(
    { workspaceId: 'workspace', runtimeId, generation: `${runtimeId}-g1` },
    { capabilities: ['process'], environment: { homeDir } },
  );
}

function localRuntime(): FakeRuntime {
  return new FakeRuntime(
    { workspaceId: 'workspace', runtimeId: 'local', generation: 'local-g1' },
    { capabilities: ['process'] },
  );
}

describe('ensureRgPath cached fallback', () => {
  it('probes the target share bin on a remote runtime, never the local one', async () => {
    const probe = probeWith((args) => (args[0] === 'rg' ? -1 : 0));

    const resolution = await ensureRgPath(probe, {
      runtime: remoteRuntime('ssh-dev'),
      allowCachedFallback: true,
    });

    expect(resolution).toEqual({
      path: '/home/remote/.kimi-code/bin/rg',
      source: 'share-bin-cached',
    });
    expect(probe.exec).toHaveBeenCalledWith(['/home/remote/.kimi-code/bin/rg', '--version']);
    expect(probe.exec).not.toHaveBeenCalledWith([getShareBinRgPath(), '--version']);
  });

  it('uses the runtime homeDir of the bound generation', async () => {
    const probe = probeWith((args) => (args[0] === 'rg' ? -1 : 0));

    const resolution = await ensureRgPath(probe, {
      runtime: remoteRuntime('docker-dev', '/root'),
      allowCachedFallback: true,
    });

    expect(resolution).toEqual({ path: '/root/.kimi-code/bin/rg', source: 'share-bin-cached' });
  });

  it('fails when neither the target PATH nor the target share bin has rg', async () => {
    const probe = noRgProbe();

    await expect(
      ensureRgPath(probe, { runtime: remoteRuntime('ssh-dev'), allowCachedFallback: true }),
    ).rejects.toThrow(/on PATH/);
    expect(probe.exec).toHaveBeenCalledWith(['/home/remote/.kimi-code/bin/rg', '--version']);
    expect(probe.exec).not.toHaveBeenCalledWith([getShareBinRgPath(), '--version']);
  });

  it('probes the local share bin on the local runtime', async () => {
    const probe = probeWith((args) => (args[0] === 'rg' ? -1 : 0));

    const resolution = await ensureRgPath(probe, {
      runtime: localRuntime(),
      allowCachedFallback: true,
    });

    expect(resolution).toEqual({ path: getShareBinRgPath(), source: 'share-bin-cached' });
  });

  it('probes the local share bin without a runtime', async () => {
    const probe = probeWith((args) => (args[0] === 'rg' ? -1 : 0));

    const resolution = await ensureRgPath(probe, { allowCachedFallback: true });

    expect(resolution).toEqual({ path: getShareBinRgPath(), source: 'share-bin-cached' });
  });
});

describe('rgUnavailableMessage', () => {
  it('names the runtime and the target-side path for a remote runtime', () => {
    const msg = rgUnavailableMessage(new Error('boom'), remoteRuntime('ssh-dev'));

    expect(msg).toContain('ssh-dev');
    expect(msg).toContain('boom');
    expect(msg).toContain('on the target');
    expect(msg).toContain('brew install ripgrep');
    expect(msg).toContain('/home/remote/.kimi-code/bin/rg');
    expect(msg).not.toContain(getShareBinRgPath());
  });

  it('keeps the local message byte-identical for the local runtime and for no runtime', () => {
    const saved = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/kimi-home-test';
    try {
      const shareBin = join('/kimi-home-test', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
      const expected =
        'ripgrep (rg) is not available.\n' +
        '\n' +
        'Error: boom\n' +
        '\n' +
        'Fix options:\n' +
        '  macOS:   brew install ripgrep\n' +
        '  Ubuntu:  sudo apt-get install ripgrep\n' +
        '  Other:   https://github.com/BurntSushi/ripgrep#installation\n' +
        '\n' +
        `Alternatively, drop a static rg binary at ${shareBin}`;

      expect(rgUnavailableMessage(new Error('boom'))).toBe(expected);
      expect(rgUnavailableMessage(new Error('boom'), localRuntime())).toBe(expected);
    } finally {
      if (saved === undefined) {
        delete process.env['KIMI_CODE_HOME'];
      } else {
        process.env['KIMI_CODE_HOME'] = saved;
      }
    }
  });
});
