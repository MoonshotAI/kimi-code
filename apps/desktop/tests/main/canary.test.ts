import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { appMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: true,
    getVersion: vi.fn(() => '0.0.20-canary.1'),
  },
}));

vi.mock('electron', () => ({ app: appMock }));

import { probeGh, resolveGhBinary, triggerBuild, type CanaryDeps, type ExecFileAsync } from '../../src/main/canary';
import { isCanaryVersion, isCanaryChannelEnabled, isCanaryDisplay, isDevCanaryOverride } from '../../src/main/release-channel';

beforeEach(() => {
  appMock.isPackaged = true;
  appMock.getVersion.mockReturnValue('0.0.20-canary.1');
});

afterEach(() => {
  delete process.env['KIMI_DESKTOP_CANARY'];
});

function makeDeps(exec: ExecFileAsync, overrides: Partial<CanaryDeps> = {}): CanaryDeps {
  return {
    exec,
    platform: 'darwin',
    exists: (p: string) => p === '/opt/homebrew/bin/gh',
    ...overrides,
  };
}

const GH_OK = { stdout: '', stderr: '' };

describe('release-channel helpers', () => {
  it('detects canary versions and channel enablement', () => {
    expect(isCanaryVersion('0.0.17-canary.42')).toBe(true);
    expect(isCanaryVersion('0.0.17')).toBe(false);
    expect(isCanaryChannelEnabled('0.0.17', false)).toBe(true); // dev always on
    expect(isCanaryChannelEnabled('0.0.17', true)).toBe(false); // stable packaged off
    expect(isCanaryChannelEnabled('0.0.17-canary.42', true)).toBe(true);
  });

  it('dev override simulates canary display identity without packaging', () => {
    expect(isDevCanaryOverride(false)).toBe(false);
    expect(isCanaryDisplay('0.0.17', false)).toBe(false);
    process.env['KIMI_DESKTOP_CANARY'] = 'true';
    expect(isDevCanaryOverride(false)).toBe(true);
    expect(isCanaryDisplay('0.0.17', false)).toBe(true);
    expect(isDevCanaryOverride(true)).toBe(false);
    expect(isCanaryDisplay('0.0.17', true)).toBe(false);
    expect(isCanaryDisplay('0.0.17-canary.42', true)).toBe(true);
  });
});

describe('resolveGhBinary', () => {
  it('prefers known absolute locations, falls back to bare gh', () => {
    const deps = { platform: 'darwin' as NodeJS.Platform, exists: (p: string) => p === '/opt/homebrew/bin/gh' };
    expect(resolveGhBinary(deps)).toBe('/opt/homebrew/bin/gh');
    expect(resolveGhBinary({ platform: 'darwin', exists: () => false })).toBe('gh');
    expect(resolveGhBinary({ platform: 'win32', exists: () => true })).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
  });
});

describe('probeGh', () => {
  it('reports missing / unauthenticated / ok', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const missing = await probeGh(makeDeps(vi.fn(async () => {
      throw enoent;
    }) as ExecFileAsync));
    expect(missing).toBe('missing');

    const unauth = await probeGh(
      makeDeps(vi.fn(async (_bin: string, args: string[]) => {
        if (args[0] === '--version') return GH_OK;
        throw new Error('not logged in');
      }) as ExecFileAsync),
    );
    expect(unauth).toBe('unauthenticated');

    const ok = await probeGh(makeDeps(vi.fn(async () => GH_OK) as ExecFileAsync));
    expect(ok).toBe('ok');
  });
});

describe('triggerBuild', () => {
  it('runs the canary workflow dispatch and reports gh states', async () => {
    const exec = vi.fn(async () => GH_OK) as unknown as ExecFileAsync;
    await expect(triggerBuild(makeDeps(exec))).resolves.toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith(
      '/opt/homebrew/bin/gh',
      ['workflow', 'run', 'desktop-build.yml', '--repo', 'MoonshotAI/kimi-code-app', '--ref', 'main', '-f', 'canary=true'],
      expect.objectContaining({ timeout: 20_000 }),
    );

    const unauth = await triggerBuild(
      makeDeps(vi.fn(async (_bin: string, args: string[]) => {
        if (args[0] === '--version') return GH_OK;
        throw new Error('not logged in');
      }) as ExecFileAsync),
    );
    expect(unauth).toEqual({ ok: false, error: 'gh not ready: unauthenticated' });

    const failing = await triggerBuild(
      makeDeps(vi.fn(async (_bin: string, args: string[]) => {
        if (args[0] === 'workflow') {
          const err = Object.assign(new Error('failed'), { stderr: 'could not create workflow dispatch\n' });
          throw err;
        }
        return GH_OK;
      }) as ExecFileAsync),
    );
    expect(failing).toEqual({ ok: false, error: 'could not create workflow dispatch' });
  });
});
