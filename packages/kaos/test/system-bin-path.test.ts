/**
 * System-bin PATH fallback.
 *
 * Reproduces the OpenHarmony smoke-test report: the CLI inherits a PATH
 * that only covers the package-manager prefixes, so every command spawned
 * by the Bash tool fails to find the OS toybox applets (`ls`, `date`,
 * `grep`, ...), which live in `/system/bin` (subset in `/bin`). The
 * login-shell probe cannot help there — it runs `$SHELL -l -c
 * /usr/bin/env` and `/usr/bin` does not exist on OpenHarmony.
 *
 * On `openharmony`, `LocalKaos.create()` must append the existing
 * well-known system bin dirs to `process.env.PATH` — after the inherited
 * entries, without reordering or duplicating them. On every other
 * platform the probe must not touch PATH and must not touch the
 * filesystem.
 *
 * The unit tests are pure (injected deps) and run on every platform.
 */

import {
  applySystemBinPath,
  probeSystemBinPath,
  type SystemBinPathDeps,
} from '#/system-bin-path';
import { describe, expect, it } from 'vitest';

interface StubOpts {
  readonly platform?: string;
  readonly env?: Record<string, string | undefined>;
  /** Directories that "exist"; defaults to both well-known dirs. */
  readonly existingDirs?: ReadonlySet<string>;
}

/** Build a stub deps bag; records `isDir` invocations in `dirCalls`. */
function stubDeps(opts: StubOpts): { deps: SystemBinPathDeps; dirCalls: string[] } {
  const dirCalls: string[] = [];
  const existingDirs =
    opts.existingDirs ?? new Set<string>(['/system/bin', '/bin']);
  return {
    dirCalls,
    deps: {
      platform: opts.platform ?? 'openharmony',
      env: opts.env ?? { PATH: '/harmonybrew/bin' },
      isDir: async (path) => {
        dirCalls.push(path);
        return existingDirs.has(path);
      },
    },
  };
}

describe('probeSystemBinPath', () => {
  it('returns both well-known dirs in append order when they exist', async () => {
    const { deps } = stubDeps({});
    await expect(probeSystemBinPath(deps)).resolves.toBe('/system/bin:/bin');
  });

  it('skips dirs that do not exist', async () => {
    const { deps } = stubDeps({ existingDirs: new Set(['/bin']) });
    await expect(probeSystemBinPath(deps)).resolves.toBe('/bin');
  });

  it('returns undefined when no candidate dir exists', async () => {
    const { deps } = stubDeps({ existingDirs: new Set() });
    await expect(probeSystemBinPath(deps)).resolves.toBeUndefined();
  });

  it.each(['darwin', 'linux', 'win32'])(
    'does not probe the filesystem on %s',
    async (platform) => {
      const { deps, dirCalls } = stubDeps({ platform });
      await expect(probeSystemBinPath(deps)).resolves.toBeUndefined();
      expect(dirCalls).toEqual([]);
    },
  );
});

describe('applySystemBinPath', () => {
  it('appends missing system dirs after the inherited entries', async () => {
    const env: Record<string, string | undefined> = { PATH: '/harmonybrew/bin' };
    const { deps } = stubDeps({ env });
    await applySystemBinPath(deps);
    expect(env['PATH']).toBe('/harmonybrew/bin:/system/bin:/bin');
  });

  it('appends only the entries PATH lacks', async () => {
    const env: Record<string, string | undefined> = {
      PATH: '/system/bin:/harmonybrew/bin',
    };
    const { deps } = stubDeps({ env });
    await applySystemBinPath(deps);
    expect(env['PATH']).toBe('/system/bin:/harmonybrew/bin:/bin');
  });

  it('leaves a complete PATH untouched', async () => {
    const env: Record<string, string | undefined> = {
      PATH: '/harmonybrew/bin:/system/bin:/bin',
    };
    const { deps } = stubDeps({ env });
    await applySystemBinPath(deps);
    expect(env['PATH']).toBe('/harmonybrew/bin:/system/bin:/bin');
  });

  it('leaves PATH untouched when no candidate dir exists', async () => {
    const env: Record<string, string | undefined> = { PATH: '/harmonybrew/bin' };
    const { deps } = stubDeps({ env, existingDirs: new Set() });
    await applySystemBinPath(deps);
    expect(env['PATH']).toBe('/harmonybrew/bin');
  });

  it('seeds an unset PATH with just the additions', async () => {
    const env: Record<string, string | undefined> = {};
    const { deps } = stubDeps({ env });
    await applySystemBinPath(deps);
    expect(env['PATH']).toBe('/system/bin:/bin');
  });

  it('does not touch PATH on non-openharmony platforms', async () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
    const { deps, dirCalls } = stubDeps({ platform: 'linux', env });
    await applySystemBinPath(deps);
    expect(env['PATH']).toBe('/usr/bin');
    expect(dirCalls).toEqual([]);
  });
});
