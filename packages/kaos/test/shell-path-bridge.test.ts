/**
 * Shell path bridge — drives `createShellPathBridge` with injected
 * `execFileSync` / `isFile` fakes (no real processes): lexical drive forms,
 * pass-through tiers, cygpath resolution and caching, `toShellPath`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createShellPathBridge,
  type ShellPathBridgeDeps,
  type ShellPathBridgeEnv,
} from '#/shell-path-bridge';

const WINDOWS_ENV: ShellPathBridgeEnv = {
  osKind: 'Windows',
  shellName: 'bash',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
};

const POSIX_ENV: ShellPathBridgeEnv = {
  osKind: 'Linux',
  shellName: 'bash',
  shellPath: '/bin/bash',
};

// cygpath.exe candidates probed for `C:\Program Files\Git\bin\bash.exe`.
const BIN_CYGPATH = 'C:\\Program Files\\Git\\bin\\cygpath.exe';
const USR_BIN_CYGPATH = 'C:\\Program Files\\Git\\usr\\bin\\cygpath.exe';

interface StubOpts {
  readonly existingPaths?: readonly string[];
  readonly execFileResults?: Readonly<Record<string, string>>;
  readonly execFileSync?: ShellPathBridgeDeps['execFileSync'];
}

function stubDeps(opts: StubOpts = {}) {
  const existing = new Set(opts.existingPaths ?? []);
  const execFileSync = vi.fn(
    opts.execFileSync ??
      ((file: string, args: readonly string[]): string => {
        const result = opts.execFileResults?.[[file, ...args].join(' ')];
        if (result === undefined) throw new Error(`unexpected execFileSync: ${file}`);
        return result;
      }),
  );
  const deps: ShellPathBridgeDeps = {
    execFileSync,
    isFile: (path: string) => existing.has(path),
  };
  return { deps, execFileSync };
}

function cygpathKey(firstSegment: string): string {
  return `${USR_BIN_CYGPATH} -w -C UTF8 -- /${firstSegment}`;
}

describe('fromShellPath lexical drive forms', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['/c:/Users/foo', 'C:/Users/foo'],
    ['/c:', 'C:/'],
    ['/cygdrive/c/Users/foo', 'C:/Users/foo'],
    ['/cygdrive/d', 'D:/'],
    ['/c/Users/foo', 'C:/Users/foo'],
    ['/C/Users/foo', 'C:/Users/foo'],
    ['/c/', 'C:/'],
    ['/c', 'C:/'],
  ];

  for (const [input, expected] of cases) {
    it(`rewrites "${input}"`, () => {
      const { deps, execFileSync } = stubDeps();
      const bridge = createShellPathBridge(WINDOWS_ENV, deps);
      expect(bridge.fromShellPath(input)).toBe(expected);
      expect(execFileSync).not.toHaveBeenCalled();
    });
  }
});

describe('fromShellPath pass-through', () => {
  it.each(['/dev/null', '/dev/pty0', '/proc/self/status', '/sys/kernel'])(
    'leaves virtual-fs path %s unchanged',
    (input) => {
      const { deps, execFileSync } = stubDeps();
      const bridge = createShellPathBridge(WINDOWS_ENV, deps);
      expect(bridge.fromShellPath(input)).toBe(input);
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/',
    '//server/share',
    '//server/share/file.txt',
    'relative/path',
    'relative\\path',
    'file.txt',
    'C:\\Users\\foo',
    'C:/Users/foo',
    '~/Documents',
  ])('leaves %s unchanged without consulting cygpath', (input) => {
    const { deps, execFileSync } = stubDeps();
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);
    expect(bridge.fromShellPath(input)).toBe(input);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('fromShellPath cygpath resolution', () => {
  it('resolves a root-relative path through cygpath and caches per first segment', () => {
    const { deps, execFileSync } = stubDeps({
      existingPaths: [USR_BIN_CYGPATH],
      execFileResults: {
        [cygpathKey('tmp')]: 'C:\\Users\\me\\AppData\\Local\\Temp\\\n',
      },
    });
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath('/tmp/scratch/a.txt')).toBe(
      'C:/Users/me/AppData/Local/Temp/scratch/a.txt',
    );
    expect(bridge.fromShellPath('/tmp/other')).toBe('C:/Users/me/AppData/Local/Temp/other');
    expect(bridge.fromShellPath('/tmp')).toBe('C:/Users/me/AppData/Local/Temp');
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(USR_BIN_CYGPATH, [
      '-w',
      '-C',
      'UTF8',
      '--',
      '/tmp',
    ]);
  });

  it('folds dot segments before resolving the mount segment', () => {
    const { deps, execFileSync } = stubDeps({
      existingPaths: [USR_BIN_CYGPATH],
      execFileResults: {
        [cygpathKey('tmp')]: 'C:\\Users\\me\\AppData\\Local\\Temp\n',
        [cygpathKey('home')]: 'C:\\Program Files\\Git\\home\n',
      },
    });
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath('/./tmp/note.txt')).toBe(
      'C:/Users/me/AppData/Local/Temp/note.txt',
    );
    expect(bridge.fromShellPath('/../tmp/note.txt')).toBe(
      'C:/Users/me/AppData/Local/Temp/note.txt',
    );
    expect(bridge.fromShellPath('/tmp/../home/x.txt')).toBe('C:/Program Files/Git/home/x.txt');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('folds dot segments before lexical drive translation', () => {
    const { deps, execFileSync } = stubDeps();
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath('/./c/Projects')).toBe('C:/Projects');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each(['/.', '/..'])('normalizes %s to / without consulting cygpath', (input) => {
    const { deps, execFileSync } = stubDeps();
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath(input)).toBe('/');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('resolves a drive-root mount and keeps it absolute', () => {
    const { deps, execFileSync } = stubDeps({
      existingPaths: [USR_BIN_CYGPATH],
      execFileResults: { [cygpathKey('work')]: 'D:\\\n' },
    });
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath('/work/app')).toBe('D:/app');
    expect(bridge.fromShellPath('/work')).toBe('D:/');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('prefers cygpath.exe next to bash.exe when present', () => {
    const key = `${BIN_CYGPATH} -w -C UTF8 -- /home`;
    const { deps, execFileSync } = stubDeps({
      existingPaths: [BIN_CYGPATH, USR_BIN_CYGPATH],
      execFileResults: { [key]: 'C:\\Users\n' },
    });
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath('/home/u/f.txt')).toBe('C:/Users/u/f.txt');
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(BIN_CYGPATH, ['-w', '-C', 'UTF8', '--', '/home']);
  });

  it('passes through and retries on the next access when cygpath fails', () => {
    const { deps, execFileSync } = stubDeps({
      existingPaths: [USR_BIN_CYGPATH],
      execFileSync: () => {
        throw new Error('cygpath exited 1');
      },
    });
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath('/tmp/x')).toBe('/tmp/x');
    expect(bridge.fromShellPath('/tmp/y')).toBe('/tmp/y');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('passes through and retries when cygpath output is not an absolute win32 path', () => {
    const { deps, execFileSync } = stubDeps({
      existingPaths: [USR_BIN_CYGPATH],
      execFileResults: { [cygpathKey('tmp')]: 'not a win32 path\n' },
    });
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath('/tmp/x')).toBe('/tmp/x');
    expect(bridge.fromShellPath('/tmp/y')).toBe('/tmp/y');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('passes through without spawning when cygpath.exe is missing', () => {
    const { deps, execFileSync } = stubDeps();
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);

    expect(bridge.fromShellPath('/tmp/x')).toBe('/tmp/x');
    expect(bridge.fromShellPath('/home/u')).toBe('/home/u');
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('identity outside win32 bash', () => {
  it('is identity on posix', () => {
    const { deps, execFileSync } = stubDeps();
    const bridge = createShellPathBridge(POSIX_ENV, deps);
    expect(bridge.fromShellPath('/c/Users/foo')).toBe('/c/Users/foo');
    expect(bridge.fromShellPath('/tmp/x')).toBe('/tmp/x');
    expect(bridge.toShellPath('C:\\Users\\foo')).toBe('C:\\Users\\foo');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('is identity on Windows without bash', () => {
    const { deps, execFileSync } = stubDeps();
    const bridge = createShellPathBridge(
      { osKind: 'Windows', shellName: 'sh', shellPath: 'C:\\sh.exe' },
      deps,
    );
    expect(bridge.fromShellPath('/c/Users/foo')).toBe('/c/Users/foo');
    expect(bridge.toShellPath('C:\\Users\\foo')).toBe('C:\\Users\\foo');
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('toShellPath', () => {
  it.each([
    ['C:\\Users\\foo', '/c/Users/foo'],
    ['C:/Users/foo', '/c/Users/foo'],
    ['C:\\', '/c/'],
    ['D:\\Projects', '/d/Projects'],
    ['\\\\server\\share\\dir', '//server/share/dir'],
    ['relative\\path', 'relative/path'],
    ['already/posix', 'already/posix'],
  ])('maps %s → %s', (input, expected) => {
    const { deps } = stubDeps();
    const bridge = createShellPathBridge(WINDOWS_ENV, deps);
    expect(bridge.toShellPath(input)).toBe(expected);
  });
});
