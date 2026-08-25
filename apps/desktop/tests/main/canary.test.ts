import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

const { openPathMock } = vi.hoisted(() => ({
  openPathMock: vi.fn(),
}));

// canary.ts imports electron only for the production singleton (init /
// request* wrappers); the unit under test is the injected startCanaryChannel
// state machine plus the pure helpers.
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.1-canary.1', getPath: () => '/tmp' },
  shell: { openPath: openPathMock },
}));

import {
  startCanaryChannel,
  parseCanaryVersion,
  compareCanaryVersions,
  canaryAssetPattern,
  canaryAssetFileName,
  resolveGhBinary,
  pickLatestCanaryRelease,
  type CanaryDeps,
  type CanaryStatus,
  type ExecFileAsync,
} from '../../src/main/canary';
import { isCanaryVersion, isCanaryChannelEnabled, isCanaryDisplay, isDevCanaryOverride } from '../../src/main/release-channel';

const GH_OK = { stdout: '', stderr: '' };

const CANARY_RELEASES = [
  { tag_name: 'v0.0.17-canary.3', prerelease: true, draft: false, published_at: '2026-08-20T00:00:00Z' },
  { tag_name: 'v0.0.17', prerelease: false, draft: false, published_at: '2026-08-19T00:00:00Z' },
];

/** A gh-shaped fake exec: answers --version / auth / api / release / workflow. */
function ghExec(routes: { releases?: unknown[]; authFails?: boolean; apiFails?: boolean; downloadFails?: boolean; workflowFails?: boolean } = {}): ExecFileAsync {
  return vi.fn(async (_bin: string, args: string[]) => {
    const [cmd] = args;
    if (cmd === '--version') return GH_OK;
    if (cmd === 'auth') {
      if (routes.authFails) throw new Error('not logged in');
      return GH_OK;
    }
    if (cmd === 'api') {
      if (routes.apiFails) throw new Error('HTTP 502');
      return { stdout: JSON.stringify(routes.releases ?? []), stderr: '' };
    }
    if (cmd === 'release') {
      if (routes.downloadFails) throw new Error('asset not found');
      return GH_OK;
    }
    if (cmd === 'workflow') {
      if (routes.workflowFails) throw new Error('could not create workflow dispatch');
      return GH_OK;
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  }) as ExecFileAsync;
}

function makeDeps(exec: ExecFileAsync, overrides: Partial<CanaryDeps> = {}) {
  const sent: CanaryStatus[] = [];
  const deps: CanaryDeps = {
    exec,
    platform: 'darwin',
    arch: 'arm64',
    version: '0.0.17-canary.1',
    isPackaged: true,
    downloadsDir: '/tmp/dl',
    exists: () => true,
    openPath: vi.fn().mockResolvedValue(''),
    send: (status) => sent.push(status),
    ...overrides,
  };
  return { deps, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env['KIMI_DESKTOP_CANARY'];
});

describe('release-channel helpers', () => {
  it('detects canary versions and channel enablement', () => {
    expect(isCanaryVersion('0.0.17-canary.42')).toBe(true);
    expect(isCanaryVersion('0.0.17')).toBe(false);
    expect(isCanaryChannelEnabled('0.0.17', false)).toBe(true); // dev always on
    expect(isCanaryChannelEnabled('0.0.17', true)).toBe(false); // stable packaged off
    expect(isCanaryChannelEnabled('0.0.17-canary.42', true)).toBe(true);
  });

  it('dev override simulates canary display identity without packaging', () => {
    // Off by default: a plain dev run of stable code shows no badge.
    expect(isDevCanaryOverride(false)).toBe(false);
    expect(isCanaryDisplay('0.0.17', false)).toBe(false);
    // KIMI_DESKTOP_CANARY=true pnpm dev:desktop: badge on, still not a real build.
    process.env['KIMI_DESKTOP_CANARY'] = 'true';
    expect(isDevCanaryOverride(false)).toBe(true);
    expect(isCanaryDisplay('0.0.17', false)).toBe(true);
    // Never fires in packaged runs (real builds are version-driven only).
    expect(isDevCanaryOverride(true)).toBe(false);
    expect(isCanaryDisplay('0.0.17', true)).toBe(false);
    expect(isCanaryDisplay('0.0.17-canary.42', true)).toBe(true);
  });
});

describe('version parsing / comparison', () => {
  it('parses core and canary components', () => {
    expect(parseCanaryVersion('0.0.17-canary.42')).toEqual({ core: [0, 0, 17], canary: 42 });
    expect(parseCanaryVersion('v1.2.3')).toEqual({ core: [1, 2, 3], canary: null });
    expect(parseCanaryVersion('nonsense')).toBeNull();
    expect(parseCanaryVersion('0.0.17-beta.3')).toBeNull();
  });

  it('orders core first, then stable > canary, then canary number', () => {
    expect(compareCanaryVersions('0.0.18-canary.1', '0.0.17-canary.99')).toBeGreaterThan(0);
    expect(compareCanaryVersions('0.0.17', '0.0.17-canary.99')).toBeGreaterThan(0);
    expect(compareCanaryVersions('0.0.17-canary.3', '0.0.17-canary.2')).toBeGreaterThan(0);
    expect(compareCanaryVersions('0.0.17-canary.3', '0.0.17-canary.3')).toBe(0);
    expect(compareCanaryVersions('junk', '0.0.17-canary.3')).toBe(0);
  });
});

describe('asset naming', () => {
  it('maps arch to the dmg pattern and file name, rejecting unknown arch', () => {
    expect(canaryAssetPattern('arm64')).toBe('KimiCodeCanary-*-mac-arm64.dmg');
    expect(canaryAssetPattern('x64')).toBe('KimiCodeCanary-*-mac-x64.dmg');
    expect(canaryAssetPattern('ia32')).toBeNull();
    expect(canaryAssetFileName('0.0.17-canary.3', 'arm64')).toBe('KimiCodeCanary-0.0.17-canary.3-mac-arm64.dmg');
    expect(canaryAssetFileName('0.0.17-canary.3', 'ia32')).toBeNull();
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

describe('pickLatestCanaryRelease', () => {
  it('filters drafts / non-prereleases / non-canary tags and picks the highest', () => {
    const payload = [
      { tag_name: 'v0.0.17', prerelease: false, draft: false },
      { tag_name: 'v0.0.17-canary.9', prerelease: true, draft: true }, // draft: skip
      { tag_name: 'v0.0.17-canary.3', prerelease: true, draft: false },
      { tag_name: 'v0.0.18-canary.1', prerelease: true, draft: false, published_at: '2026-08-21T00:00:00Z' },
      { tag_name: 'nightly', prerelease: true, draft: false },
    ];
    expect(pickLatestCanaryRelease(payload)).toEqual({
      version: '0.0.18-canary.1',
      tag: 'v0.0.18-canary.1',
      releaseDate: '2026-08-21T00:00:00Z',
    });
    expect(pickLatestCanaryRelease([])).toBeNull();
    expect(pickLatestCanaryRelease('junk')).toBeNull();
  });
});

describe('startCanaryChannel', () => {
  it('is disabled on stable packaged builds', () => {
    const { deps } = makeDeps(ghExec(), { version: '0.0.17', isPackaged: true });
    expect(startCanaryChannel(deps)).toBeNull();
  });

  it('offers a newer canary on the scheduled check and pushes the status', async () => {
    const { deps, sent } = makeDeps(ghExec({ releases: CANARY_RELEASES }));
    const controller = startCanaryChannel(deps);
    expect(controller).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([
      {
        state: 'available',
        version: '0.0.17-canary.3',
        tag: 'v0.0.17-canary.3',
        releaseDate: '2026-08-20T00:00:00Z',
      },
    ]);
    controller!.stop();
  });

  it('stays idle when already on the latest canary, and swallows background failures', async () => {
    const { deps, sent } = makeDeps(ghExec({ releases: CANARY_RELEASES }), { version: '0.0.17-canary.3' });
    const controller = startCanaryChannel(deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
    expect(controller.getStatus()).toEqual({ state: 'idle' });
    controller.stop();

    const failing = makeDeps(ghExec({ apiFails: true }));
    const c2 = startCanaryChannel(failing.deps)!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failing.sent).toEqual([]); // background failure never grows a state
    expect(c2.getStatus()).toEqual({ state: 'idle' });
    c2.stop();
  });

  it('manual check reports gh states and outcomes', async () => {
    const missing = makeDeps(
      (() => {
        const err = new Error('spawn gh ENOENT') as Error & { code?: string };
        err.code = 'ENOENT';
        return vi.fn(async () => {
          throw err;
        }) as ExecFileAsync;
      })(),
    );
    await expect(startCanaryChannel(missing.deps)!.check()).resolves.toEqual({ outcome: 'gh-missing' });

    const unauth = makeDeps(ghExec({ authFails: true }));
    await expect(startCanaryChannel(unauth.deps)!.check()).resolves.toEqual({ outcome: 'gh-unauthenticated' });

    const available = makeDeps(ghExec({ releases: CANARY_RELEASES }));
    await expect(startCanaryChannel(available.deps)!.check()).resolves.toEqual({
      outcome: 'available',
      version: '0.0.17-canary.3',
    });

    const latest = makeDeps(ghExec({ releases: CANARY_RELEASES }), { version: '0.0.17-canary.3' });
    await expect(startCanaryChannel(latest.deps)!.check()).resolves.toEqual({ outcome: 'latest' });

    const failing = makeDeps(ghExec({ apiFails: true }));
    await expect(startCanaryChannel(failing.deps)!.check()).resolves.toEqual({ outcome: 'error', message: 'HTTP 502' });
  });

  it('downloads the offered dmg and mounts it, landing in downloaded with a path', async () => {
    const exec = ghExec({ releases: CANARY_RELEASES });
    const { deps, sent } = makeDeps(exec);
    const controller = startCanaryChannel(deps)!;
    await expect(controller.check()).resolves.toEqual({ outcome: 'available', version: '0.0.17-canary.3' });
    // join() 与实现同路径拼装方式，POSIX/Windows 分隔符各自正确。
    const expectedPath = join('/tmp/dl', 'KimiCodeCanary-0.0.17-canary.3-mac-arm64.dmg');

    controller.download();
    await vi.waitFor(() => {
      expect(sent.at(-1)).toEqual({
        state: 'downloaded',
        version: '0.0.17-canary.3',
        tag: 'v0.0.17-canary.3',
        releaseDate: '2026-08-20T00:00:00Z',
        path: expectedPath,
      });
    });
    expect(exec).toHaveBeenCalledWith(
      '/opt/homebrew/bin/gh',
      [
        'release', 'download', 'v0.0.17-canary.3',
        '--repo', 'MoonshotAI/kimi-code-app',
        '--pattern', 'KimiCodeCanary-*-mac-arm64.dmg',
        '--dir', '/tmp/dl', '--clobber',
      ],
      expect.objectContaining({ timeout: 5 * 60 * 1000 }),
    );
    expect(deps.openPath).toHaveBeenCalledWith(expectedPath);

    // Re-open only works from the downloaded state.
    controller.openDownloaded();
    expect(deps.openPath).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('fails the download into the error state and never acts from idle', async () => {
    const { deps, sent } = makeDeps(ghExec({ releases: CANARY_RELEASES, downloadFails: true }));
    const controller = startCanaryChannel(deps)!;
    controller.download(); // idle: no-op
    expect(sent).toEqual([]);

    await controller.check();
    controller.download();
    await vi.waitFor(() => {
      expect(sent.at(-1)).toEqual({
        state: 'error',
        version: '0.0.17-canary.3',
        tag: 'v0.0.17-canary.3',
        message: 'asset not found',
      });
    });
    controller.stop();
  });

  it('does not regress an in-flight download when the same version is re-announced', async () => {
    const base = ghExec({ releases: CANARY_RELEASES });
    // The download never settles in this test — the state must stay
    // `downloading` while a re-check re-announces the same version.
    const exec = (async (bin: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
      if (args[0] === 'release') {
        return new Promise(() => {});
      }
      return base(bin, args, options);
    }) as ExecFileAsync;
    const { deps, sent } = makeDeps(exec);
    const controller = startCanaryChannel(deps)!;
    await controller.check();
    controller.download();
    expect(sent.at(-1)!.state).toBe('downloading');
    // A re-check while the download is in flight must keep `downloading`.
    await controller.check();
    expect(sent.filter((s) => s.state === 'available')).toHaveLength(1);
    expect(sent.at(-1)!.state).toBe('downloading');
    controller.stop();
  });

  it('clears a stale available state when the feed rolls back', async () => {
    const exec = ghExec({ releases: CANARY_RELEASES });
    const { deps, sent } = makeDeps(exec);
    const controller = startCanaryChannel(deps)!;
    await controller.check();
    expect(sent.at(-1)!.state).toBe('available');

    // The prerelease gets pulled: the next check settles back to idle.
    (exec as ReturnType<typeof vi.fn>).mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'api') return { stdout: '[]', stderr: '' };
      return GH_OK;
    });
    await expect(controller.check()).resolves.toEqual({ outcome: 'latest' });
    expect(sent.at(-1)).toEqual({ state: 'idle' });
    controller.stop();
  });

  it('triggers the build workflow with the canary input', async () => {
    const exec = ghExec();
    const { deps } = makeDeps(exec);
    const controller = startCanaryChannel(deps)!;
    await expect(controller.triggerBuild()).resolves.toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith(
      '/opt/homebrew/bin/gh',
      ['workflow', 'run', 'desktop-build.yml', '--repo', 'MoonshotAI/kimi-code-app', '--ref', 'main', '-f', 'canary=true'],
      expect.objectContaining({ timeout: 20_000 }),
    );

    const unauth = makeDeps(ghExec({ authFails: true }));
    await expect(startCanaryChannel(unauth.deps)!.triggerBuild()).resolves.toEqual({
      ok: false,
      error: 'gh not ready: unauthenticated',
    });

    const failing = makeDeps(ghExec({ workflowFails: true }));
    await expect(startCanaryChannel(failing.deps)!.triggerBuild()).resolves.toEqual({
      ok: false,
      error: 'could not create workflow dispatch',
    });
    controller.stop();
  });
});
