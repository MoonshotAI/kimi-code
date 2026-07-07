import { describe, expect, it } from 'vitest';

import {
  canonicalizePath,
  DEFAULT_WORKSPACE_ACCESS_POLICY,
  isWithinDirectory,
  isWithinWorkspace,
  normalizeUserPath,
  PathSecurityError,
  assertPathAllowed,
  resolvePathAccess,
  resolvePathAccessPath,
} from '../../src/tools/policies/path-access';
import { isSensitiveFile } from '../../src/tools/policies/sensitive';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';

const WORKSPACE: WorkspaceConfig = {
  workspaceDir: '/workspace',
  additionalDirs: ['/extra'],
};

const WIN_WORKSPACE: WorkspaceConfig = {
  workspaceDir: 'C:\\workspace',
  additionalDirs: ['D:\\extra'],
};

const POSIX_KAOS = {
  pathClass: () => 'posix' as const,
  gethome: () => '/home/test',
};

describe('path access policy', () => {
  it('default policy allows absolute paths outside workspace roots', () => {
    const result = resolvePathAccess('/etc/hosts', '/workspace', WORKSPACE, {
      operation: 'read',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
    });
    expect(result).toEqual({ path: '/etc/hosts', outsideWorkspace: true });
  });

  it('default policy rejects relative paths that escape workspace roots', () => {
    expect(() =>
      resolvePathAccess('../../outside.txt', '/workspace/project', WORKSPACE, {
        operation: 'read',
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      }),
    ).toThrow(/absolute path/);
  });

  it('does not duplicate outside-working-directory wording for search paths', () => {
    try {
      resolvePathAccess('../../outside.txt', '/workspace/project', WORKSPACE, {
        operation: 'search',
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PathSecurityError);
      const message = (error as PathSecurityError).message;
      const matches = message.match(/outside the working directory/g) ?? [];
      expect(matches).toHaveLength(1);
      expect(message).toBe(
        '"../../outside.txt" is not an absolute path. You must provide an absolute path to search outside the working directory.',
      );
      return;
    }

    throw new Error('Expected resolvePathAccess to reject escaping relative search path');
  });

  it('disabled policy allows relative paths that escape workspace roots', () => {
    const result = resolvePathAccess('../../outside.txt', '/workspace/project', WORKSPACE, {
      operation: 'read',
      policy: { guardMode: 'disabled', checkSensitive: true },
    });
    expect(result).toEqual({ path: '/outside.txt', outsideWorkspace: true });
  });

  it('expands leading tilde paths against the provided home directory', () => {
    const file = resolvePathAccess('~/notes/today.txt', '/workspace', WORKSPACE, {
      operation: 'read',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      homeDir: '/home/test',
    });
    expect(file).toEqual({ path: '/home/test/notes/today.txt', outsideWorkspace: true });

    const home = resolvePathAccess('~', '/workspace', WORKSPACE, {
      operation: 'read',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      homeDir: '/home/test',
    });
    expect(home).toEqual({ path: '/home/test', outsideWorkspace: true });

    const namedUser = resolvePathAccess('~other/notes.txt', '/workspace', WORKSPACE, {
      operation: 'read',
      policy: { guardMode: 'disabled', checkSensitive: true },
      homeDir: '/home/test',
    });
    expect(namedUser).toEqual({ path: '/workspace/~other/notes.txt', outsideWorkspace: false });
  });

  it('sensitive-file protection is independent from workspace policy', () => {
    expect(() =>
      resolvePathAccess('/tmp/.env', '/workspace', WORKSPACE, {
        operation: 'read',
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      }),
    ).toThrow(/sensitive-file pattern/);
  });

  it('resolves only the canonical path for file tools', () => {
    const result = resolvePathAccessPath('src/../README.md', {
      kaos: POSIX_KAOS,
      workspace: { workspaceDir: '/workspace/project', additionalDirs: [] },
      operation: 'read',
    });

    expect(result).toBe('/workspace/project/README.md');
  });

  it('expands home for file tools unless explicitly disabled', () => {
    const workspace = { workspaceDir: '/workspace', additionalDirs: [] };

    expect(
      resolvePathAccessPath('~/notes/today.txt', {
        kaos: POSIX_KAOS,
        workspace,
        operation: 'read',
      }),
    ).toBe('/home/test/notes/today.txt');
    expect(
      resolvePathAccessPath('~/notes/today.txt', {
        kaos: POSIX_KAOS,
        workspace,
        operation: 'read',
        expandHome: false,
      }),
    ).toBe('/workspace/~/notes/today.txt');
  });

  it('legacy assertPathAllowed allows absolute outside paths but rejects relative escapes', () => {
    expect(
      assertPathAllowed('/workspace-evil/secrets.txt', '/workspace', WORKSPACE, {
        mode: 'read',
      }),
    ).toBe('/workspace-evil/secrets.txt');

    expect(() =>
      assertPathAllowed('../../outside.txt', '/workspace/project', WORKSPACE, {
        mode: 'read',
      }),
    ).toThrow(/absolute path/);
  });

  it('canonicalizes paths with an explicit posix path class', () => {
    expect(canonicalizePath('../file.txt', '/workspace/project', 'posix')).toBe(
      '/workspace/file.txt',
    );
  });

  it('canonicalizes and checks windows paths with an explicit win32 path class', () => {
    const result = resolvePathAccess('sub\\..\\file.txt', 'C:\\workspace', WIN_WORKSPACE, {
      operation: 'read',
      pathClass: 'win32',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
    });

    expect(result).toEqual({ path: 'C:/workspace/file.txt', outsideWorkspace: false });
    expect(isWithinDirectory('C:/WORKSPACE/file.txt', 'c:/workspace', 'win32')).toBe(true);
  });

  it('converts Git Bash POSIX drive paths before applying win32 workspace checks', () => {
    const result = resolvePathAccess('/c/workspace/file.txt', 'C:\\workspace', WIN_WORKSPACE, {
      operation: 'read',
      pathClass: 'win32',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      homeDir: 'C:\\Users\\test',
    });

    expect(result).toEqual({ path: 'C:/workspace/file.txt', outsideWorkspace: false });
  });

  it('uses the provided path class when deciding whether an outside path is absolute', () => {
    const result = resolvePathAccess('C:\\outside\\file.txt', 'C:\\workspace', WIN_WORKSPACE, {
      operation: 'read',
      pathClass: 'win32',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
    });

    expect(result).toEqual({ path: 'C:/outside/file.txt', outsideWorkspace: true });
  });

  it('expands leading tilde paths with the provided win32 home directory', () => {
    const result = resolvePathAccess('~\\notes\\today.txt', 'C:\\workspace', WIN_WORKSPACE, {
      operation: 'read',
      pathClass: 'win32',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      homeDir: 'C:\\Users\\test',
    });

    expect(result).toEqual({
      path: 'C:/Users/test/notes/today.txt',
      outsideWorkspace: true,
    });
  });

  it('rejects windows drive-relative paths without consulting host cwd state', () => {
    expect(() =>
      resolvePathAccess('D:outside.txt', 'C:\\workspace', WIN_WORKSPACE, {
        operation: 'read',
        pathClass: 'win32',
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      }),
    ).toThrow(/drive-relative Windows path/);
  });

  it('uses the provided path class for sensitive-file detection', () => {
    expect(() =>
      resolvePathAccess('C:\\tmp\\.env', 'C:\\workspace', WIN_WORKSPACE, {
        operation: 'read',
        pathClass: 'win32',
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      }),
    ).toThrow(/sensitive-file pattern/);
  });

  it('matches sensitive-file patterns case-insensitively for windows paths', () => {
    expect(() =>
      resolvePathAccess('C:\\tmp\\.ENV', 'C:\\workspace', WIN_WORKSPACE, {
        operation: 'read',
        pathClass: 'win32',
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      }),
    ).toThrow(/sensitive-file pattern/);

    expect(() =>
      resolvePathAccess('C:\\Users\\me\\.AWS\\Credentials', 'C:\\workspace', WIN_WORKSPACE, {
        operation: 'read',
        pathClass: 'win32',
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
      }),
    ).toThrow(/sensitive-file pattern/);
  });

  it('treats a directory as within itself', () => {
    expect(isWithinDirectory('/home/user/project', '/home/user/project')).toBe(true);
  });

  it('accepts the workspace root path against itself', () => {
    expect(isWithinWorkspace('/workspace', WORKSPACE)).toBe(true);
  });

  it('accepts an additionalDir entry path itself', () => {
    expect(isWithinDirectory('/extra', '/extra')).toBe(true);
    expect(isWithinWorkspace('/extra', WORKSPACE)).toBe(true);
  });

  it('accepts paths inside any additionalDir entry', () => {
    expect(isWithinWorkspace('/extra/lib/file.py', WORKSPACE)).toBe(true);

    const result = resolvePathAccess('/extra/lib/file.py', '/workspace', WORKSPACE, {
      operation: 'read',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
    });
    expect(result).toEqual({ path: '/extra/lib/file.py', outsideWorkspace: false });
  });

  it('treats additionalDir descendants as inside the workspace', () => {
    expect(isWithinWorkspace('/extra/src/nested/file.ts', WORKSPACE)).toBe(true);

    const result = resolvePathAccess('/extra/src/nested/file.ts', '/workspace', WORKSPACE, {
      operation: 'read',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
    });
    expect(result).toEqual({ path: '/extra/src/nested/file.ts', outsideWorkspace: false });
  });

  it('does not treat shared-prefix directories as additionalDir descendants', () => {
    expect(isWithinWorkspace('/extra-evil/file.ts', WORKSPACE)).toBe(false);

    const result = resolvePathAccess('/extra-evil/file.ts', '/workspace', WORKSPACE, {
      operation: 'read',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
    });
    expect(result).toEqual({ path: '/extra-evil/file.ts', outsideWorkspace: true });
  });

  it('treats multiple additionalDir entries as a union', () => {
    const multi: WorkspaceConfig = {
      workspaceDir: '/workspace',
      additionalDirs: ['/lib', '/opt/shared'],
    };
    expect(isWithinWorkspace('/opt/shared/config.json', multi)).toBe(true);
    expect(isWithinWorkspace('/lib/module.js', multi)).toBe(true);
    expect(isWithinWorkspace('/elsewhere/file', multi)).toBe(false);
  });

  it('does not classify shared-prefix paths as additionalDir entries', () => {
    const cfg: WorkspaceConfig = {
      workspaceDir: '/workspace',
      additionalDirs: ['/lib'],
    };
    expect(isWithinWorkspace('/lib-evil/hack.py', cfg)).toBe(false);

    const result = resolvePathAccess('/lib-evil/hack.py', '/workspace', cfg, {
      operation: 'read',
      policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
    });
    expect(result).toEqual({ path: '/lib-evil/hack.py', outsideWorkspace: true });
  });

  it('uses path-segment containment rather than naive startsWith for additionalDir entries', () => {
    const cfg: WorkspaceConfig = {
      workspaceDir: '/workspace',
      additionalDirs: ['/app-data'],
    };
    expect(isWithinWorkspace('/app-data/file.txt', cfg)).toBe(true);
    expect(isWithinWorkspace('/app-data-evil/file.txt', cfg)).toBe(false);
  });

  it('tolerates forward slashes in win32 mode for containment checks', () => {
    expect(
      isWithinDirectory(
        'C:/Users/user/project/src/main.py',
        'C:/Users/user/project',
        'win32',
      ),
    ).toBe(true);
  });

  describe('normalizeUserPath on win32', () => {
    it('rewrites MSYS-style drive paths to native form', () => {
      expect(normalizeUserPath('/c/Users/foo/file.txt', 'win32')).toBe('C:/Users/foo/file.txt');
    });

    it('rewrites a bare MSYS drive root to native form', () => {
      expect(normalizeUserPath('/c/', 'win32')).toBe('C:/');
      expect(normalizeUserPath('/c', 'win32')).toBe('C:/');
    });

    it('canonicalizes the drive letter to uppercase', () => {
      expect(normalizeUserPath('/C/Users/foo', 'win32')).toBe('C:/Users/foo');
    });

    it('rewrites cygdrive-style paths to native form', () => {
      expect(normalizeUserPath('/cygdrive/c/Users/foo', 'win32')).toBe('C:/Users/foo');
      expect(normalizeUserPath('/cygdrive/d/Projects', 'win32')).toBe('D:/Projects');
    });

    it('rewrites UNC paths to forward slashes', () => {
      expect(normalizeUserPath('//server/share/file', 'win32')).toBe('//server/share/file');
      expect(normalizeUserPath('//server/share', 'win32')).toBe('//server/share');
    });

    it('leaves already-native windows paths untouched', () => {
      expect(normalizeUserPath('C:\\Users\\foo', 'win32')).toBe('C:\\Users\\foo');
      expect(normalizeUserPath('D:\\Projects', 'win32')).toBe('D:\\Projects');
    });

    it('does not rewrite relative paths', () => {
      expect(normalizeUserPath('relative/path', 'win32')).toBe('relative/path');
      expect(normalizeUserPath('relative\\path', 'win32')).toBe('relative\\path');
      expect(normalizeUserPath('file.txt', 'win32')).toBe('file.txt');
    });

    it('leaves leading tilde untouched (expansion happens elsewhere)', () => {
      expect(normalizeUserPath('~/Documents', 'win32')).toBe('~/Documents');
    });

  });

  describe('normalizeUserPath on posix', () => {
    it('leaves MSYS-shaped paths alone', () => {
      expect(normalizeUserPath('/c/Users/foo', 'posix')).toBe('/c/Users/foo');
      expect(normalizeUserPath('/cygdrive/x', 'posix')).toBe('/cygdrive/x');
    });

    it('leaves UNC-shaped paths alone', () => {
      expect(normalizeUserPath('//server/share', 'posix')).toBe('//server/share');
    });
  });

  describe('normalizeUserPath full posix-to-windows coverage', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/c/Users/foo', 'C:/Users/foo'],
      ['/d/Projects/kimi', 'D:/Projects/kimi'],
      ['/C/Users/foo', 'C:/Users/foo'],
      ['/c/', 'C:/'],
      ['/c', 'C:/'],
      ['/cygdrive/c/Users/foo', 'C:/Users/foo'],
      ['/cygdrive/d/Projects', 'D:/Projects'],
      ['//server/share', '//server/share'],
      ['//server/share/file.txt', '//server/share/file.txt'],
      ['relative/path/file.txt', 'relative/path/file.txt'],
      ['relative\\already\\windows', 'relative\\already\\windows'],
      ['filename.txt', 'filename.txt'],
    ];

    for (const [input, expected] of cases) {
      it(`normalizes "${input}"`, () => {
        expect(normalizeUserPath(input, 'win32')).toBe(expected);
      });
    }
  });

  it('aggressively rewrites short-input forms on win32', () => {
    // Pathological short inputs: empty, lone slash, and a single character.
    // The bare "/" branch returns a forward slash so downstream pathe
    // operations stay uniform.
    expect(normalizeUserPath('', 'win32')).toBe('');
    expect(normalizeUserPath('/', 'win32')).toBe('/');
    expect(normalizeUserPath('a', 'win32')).toBe('a');
  });

  describe('isSensitiveFile SSH key coverage', () => {
    const keys = ['id_rsa', 'id_ed25519', 'id_ecdsa'];

    for (const key of keys) {
      it(`flags ${key} as sensitive by basename`, () => {
        expect(isSensitiveFile(key)).toBe(true);
      });

      it(`flags /home/user/.ssh/${key} as sensitive`, () => {
        expect(isSensitiveFile(`/home/user/.ssh/${key}`)).toBe(true);
      });
    }
  });
});
