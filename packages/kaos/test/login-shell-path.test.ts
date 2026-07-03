/**
 * Login-shell PATH enrichment.
 *
 * Reproduces the "Bash tool can't find local `gh`" report: when kimi-code
 * is launched from a context that skipped the user's shell profile (GUI
 * launcher, non-login parent shell), `process.env.PATH` misses entries
 * like `/opt/homebrew/bin`, so every command spawned by the Bash tool
 * inherits the impoverished PATH.
 *
 * `LocalKaos.create()` must probe the user's login shell (`$SHELL -l -c
 * env`, falling back to the OS account's login shell when $SHELL is unset
 * or blank) once and append the missing PATH entries to
 * `process.env.PATH` — without reordering or overriding what is already
 * there. Probe failures (no resolvable shell, hung or broken profile)
 * must leave PATH untouched.
 *
 * The probe/merge unit tests are pure (injected deps) and run on every
 * platform. The end-to-end LocalKaos suite spawns a stub shell and is
 * skipped on Windows: the problem is specific to POSIX login-shell
 * profiles, and the probe must not run there.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyLoginShellPath,
  type LoginShellPathDeps,
  mergeLoginShellPath,
  probeLoginShellPath,
} from '#/login-shell-path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StubOpts {
  readonly platform?: string;
  readonly env?: Record<string, string | undefined>;
  readonly execFileResult?: string | undefined;
  readonly execFileText?: LoginShellPathDeps['execFileText'];
  readonly userShell?: string | undefined;
}

/** Build a stub deps bag; records `execFileText` invocations in `calls`. */
function stubDeps(opts: StubOpts): { deps: LoginShellPathDeps; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    deps: {
      platform: opts.platform ?? 'darwin',
      env: opts.env ?? { SHELL: '/bin/zsh' },
      userShell: () => opts.userShell,
      execFileText:
        opts.execFileText ??
        (async (file, args, timeoutMs) => {
          calls.push([file, args, timeoutMs]);
          return opts.execFileResult;
        }),
    },
  };
}

describe('probeLoginShellPath', () => {
  it('runs $SHELL -l -c env and returns its PATH', async () => {
    const { deps, calls } = stubDeps({
      execFileResult: 'HOME=/Users/u\nPATH=/opt/homebrew/bin:/usr/bin:/bin\nTERM=dumb\n',
    });
    await expect(probeLoginShellPath(deps)).resolves.toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(calls).toEqual([['/bin/zsh', ['-l', '-c', 'env'], 5_000]]);
  });

  it('keeps the last PATH= line, ignoring profile noise printed earlier', async () => {
    const { deps } = stubDeps({
      execFileResult: 'PATH=/from-profile-echo\nsome profile banner\nPATH=/real/bin:/usr/bin\n',
    });
    await expect(probeLoginShellPath(deps)).resolves.toBe('/real/bin:/usr/bin');
  });

  it('returns undefined on Windows without spawning anything', async () => {
    const { deps, calls } = stubDeps({ platform: 'win32', execFileResult: 'PATH=/x' });
    await expect(probeLoginShellPath(deps)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('falls back to the account login shell when SHELL is unset or blank', async () => {
    // launchd/daemon launches can leave $SHELL unset or blank (the very
    // contexts whose PATH is impoverished); the probe must then use the
    // OS account's login shell instead of giving up.
    for (const env of [{}, { SHELL: '' }, { SHELL: '   ' }]) {
      const { deps, calls } = stubDeps({
        env,
        userShell: '/bin/zsh',
        execFileResult: 'PATH=/opt/homebrew/bin:/usr/bin\n',
      });
      await expect(probeLoginShellPath(deps)).resolves.toBe('/opt/homebrew/bin:/usr/bin');
      expect(calls).toEqual([['/bin/zsh', ['-l', '-c', 'env'], 5_000]]);
    }
  });

  it('returns undefined when SHELL is unset and no account shell is available', async () => {
    for (const env of [{}, { SHELL: '' }, { SHELL: '   ' }]) {
      const { deps, calls } = stubDeps({ env, execFileResult: 'PATH=/x' });
      await expect(probeLoginShellPath(deps)).resolves.toBeUndefined();
      expect(calls).toEqual([]);
    }
  });

  it('returns undefined when the shell fails or times out', async () => {
    const { deps } = stubDeps({ execFileResult: undefined });
    await expect(probeLoginShellPath(deps)).resolves.toBeUndefined();
  });

  it('returns undefined when the output has no PATH line', async () => {
    const { deps } = stubDeps({ execFileResult: 'HOME=/Users/u\nTERM=dumb\n' });
    await expect(probeLoginShellPath(deps)).resolves.toBeUndefined();
  });
});

describe('mergeLoginShellPath', () => {
  it('appends entries the current PATH lacks, keeping current priority', () => {
    expect(mergeLoginShellPath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin:/extra')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin:/extra',
    );
  });

  it('returns the current PATH unchanged when nothing is missing', () => {
    expect(mergeLoginShellPath('/a:/b:/c', '/b:/a')).toBe('/a:/b:/c');
  });

  it('handles an unset current PATH', () => {
    expect(mergeLoginShellPath(undefined, '/a:/b')).toBe('/a:/b');
  });

  it('drops empty segments and duplicates', () => {
    expect(mergeLoginShellPath('/a::/b', ':/c::/a:')).toBe('/a:/b:/c');
  });
});

describe('applyLoginShellPath', () => {
  it('merges the probed PATH into the env bag', async () => {
    const env: Record<string, string | undefined> = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    const { deps } = stubDeps({ env, execFileResult: 'PATH=/opt/homebrew/bin:/usr/bin\n' });
    await applyLoginShellPath(deps);
    expect(env['PATH']).toBe('/usr/bin:/opt/homebrew/bin');
  });

  it('leaves PATH untouched when the probe fails', async () => {
    const env: Record<string, string | undefined> = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    const { deps } = stubDeps({ env, execFileResult: undefined });
    await applyLoginShellPath(deps);
    expect(env['PATH']).toBe('/usr/bin');
  });
});

describe.skipIf(process.platform === 'win32')('LocalKaos login-shell PATH enrichment', () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let originalShell: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kaos-login-path-'));
    originalPath = process.env['PATH'];
    originalShell = process.env['SHELL'];
  });

  afterEach(async () => {
    restoreEnv('PATH', originalPath);
    restoreEnv('SHELL', originalShell);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('appends login-shell PATH entries missing from process.env.PATH', async () => {
    const extraDir = join(tempDir, 'login-only-bin');
    const stubShell = join(tempDir, 'stub-shell.sh');
    // Stands in for the user's login shell: whatever flags it is invoked
    // with, it reports an environment whose PATH carries an entry the
    // kimi-code process does not have.
    await writeFile(stubShell, `#!/bin/sh\necho "HOME=$HOME"\necho "PATH=${extraDir}:/usr/bin:/bin"\n`);
    await chmod(stubShell, 0o755);
    process.env['SHELL'] = stubShell;

    // The suite's setup.ts already ran LocalKaos.create() with the real
    // $SHELL, consuming the memoised probe. Import a fresh module graph so
    // this create() probes the stub shell instead.
    vi.resetModules();
    const { LocalKaos } = await import('#/local');
    await LocalKaos.create();

    const entries = (process.env['PATH'] ?? '').split(':');
    expect(entries).toContain(extraDir);
    // Existing entries keep priority: the login-shell extras are appended.
    expect(process.env['PATH']?.startsWith(originalPath ?? '')).toBe(true);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
