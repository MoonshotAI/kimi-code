import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyLoginShellPath,
  type LoginShellPathDeps,
  mergeLoginShellPath,
  probeLoginShellPath,
} from '#/_base/execEnv/loginShellPath';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StubOpts {
  readonly platform?: string;
  readonly env?: Record<string, string | undefined>;
  readonly execFileResult?: string | undefined;
  readonly execFileText?: LoginShellPathDeps['execFileText'];
  readonly userShell?: string | undefined;
}

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
  it('runs $SHELL -l -c /usr/bin/env and returns its PATH', async () => {
    const { deps, calls } = stubDeps({
      execFileResult: 'HOME=/Users/u\nPATH=/opt/homebrew/bin:/usr/bin:/bin\nTERM=dumb\n',
    });
    await expect(probeLoginShellPath(deps)).resolves.toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(calls).toEqual([['/bin/zsh', ['-l', '-c', '/usr/bin/env'], 5_000]]);
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
    for (const env of [{}, { SHELL: '' }, { SHELL: '   ' }]) {
      const { deps, calls } = stubDeps({
        env,
        userShell: '/bin/zsh',
        execFileResult: 'PATH=/opt/homebrew/bin:/usr/bin\n',
      });
      await expect(probeLoginShellPath(deps)).resolves.toBe('/opt/homebrew/bin:/usr/bin');
      expect(calls).toEqual([['/bin/zsh', ['-l', '-c', '/usr/bin/env'], 5_000]]);
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

  it('returns the current PATH string verbatim when nothing is missing', () => {
    expect(mergeLoginShellPath('/a::/b:/a:', '/b:/a')).toBe('/a::/b:/a:');
  });

  it('preserves empty components (cwd lookup) in the current PATH while appending', () => {
    expect(mergeLoginShellPath(':/usr/bin', '/new')).toBe(':/usr/bin:/new');
    expect(mergeLoginShellPath('/usr/bin:', '/new')).toBe('/usr/bin::/new');
    expect(mergeLoginShellPath('/a::/b', '/c')).toBe('/a::/b:/c');
    expect(mergeLoginShellPath('', '/a')).toBe(':/a');
  });

  it('handles an unset current PATH', () => {
    expect(mergeLoginShellPath(undefined, '/a:/b')).toBe('/a:/b');
  });

  it('skips empty and duplicate login-shell entries', () => {
    expect(mergeLoginShellPath('/a', ':/b::/a:')).toBe('/a:/b');
  });

  it('skips relative login-shell entries', () => {
    expect(mergeLoginShellPath('/a', '.:bin:../x:/b')).toBe('/a:/b');
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

  it('does not set an unset PATH when the login shell contributes nothing', async () => {
    const env: Record<string, string | undefined> = { SHELL: '/bin/zsh' };
    const { deps } = stubDeps({ env, execFileResult: 'PATH=:::\n' });
    await applyLoginShellPath(deps);
    expect('PATH' in env).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('applyLoginShellPathFromNode', () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let originalShell: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'v2-login-path-'));
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
    await writeFile(stubShell, `#!/bin/sh\necho "HOME=$HOME"\necho "PATH=${extraDir}:/usr/bin:/bin"\n`);
    await chmod(stubShell, 0o755);
    process.env['SHELL'] = stubShell;

    vi.resetModules();
    const { applyLoginShellPathFromNode } = await import('#/_base/execEnv/loginShellPath');
    await applyLoginShellPathFromNode();

    const entries = (process.env['PATH'] ?? '').split(':');
    expect(entries).toContain(extraDir);
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
