import { describe, expect, it } from 'vitest';

import type { ShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import {
  DEFAULT_WORKSPACE_ACCESS_POLICY,
  extendWorkspaceWithSkillRoots,
  isSensitiveFile,
  resolvePathAccess,
  resolvePathAccessPath,
} from '#/tool/path-access';

describe('isSensitiveFile', () => {
  it('flags base .env files in any directory', () => {
    for (const path of ['.env', '/app/.env', 'project/.env']) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags .env.<environment> variants', () => {
    for (const path of ['.env.local', '.env.production', '/app/.env.staging']) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags cloud credential file locations', () => {
    for (const path of [
      '/home/user/.aws/credentials',
      '/home/user/.gcp/credentials',
      '.aws/credentials',
      '.gcp/credentials',
      'credentials',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('matches sensitive patterns case-insensitively on posix paths', () => {
    for (const path of [
      '.ENV',
      '/app/.Env.Local',
      '/home/user/.AWS/Credentials',
      '/home/user/.GCP/CREDENTIALS',
      '/home/user/.ssh/ID_RSA',
      '/home/user/.ssh/ID_ED25519.OLD',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('does not flag normal source / config files or env exemplars', () => {
    for (const path of [
      'app.py',
      'config.yml',
      'README.md',
      'package.json',
      'server.key.example',
      'id_rsa.pub',
      'credentials.json',
      '.envrc',
      'environment.py',
      '.env_example',
      '.env.example',
      '.ENV.EXAMPLE',
      '.env.sample',
      '.ENV.SAMPLE',
      '.env.template',
      '.ENV.TEMPLATE',
      '/app/.env.example',
      '/app/.ENV.EXAMPLE',
    ]) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });
});

describe('extendWorkspaceWithSkillRoots', () => {
  const workspace = { workspaceDir: '/repo', additionalDirs: ['/extra'] };

  it('returns the workspace unchanged when there are no skill roots', () => {
    expect(extendWorkspaceWithSkillRoots(workspace, [])).toBe(workspace);
  });

  it('appends roots outside the workspace and existing additional dirs', () => {
    expect(extendWorkspaceWithSkillRoots(workspace, ['/home/user/.kimi-code/skills'])).toEqual({
      workspaceDir: '/repo',
      additionalDirs: ['/extra', '/home/user/.kimi-code/skills'],
    });
  });

  it('skips roots already inside the workspace dir or an additional dir', () => {
    expect(
      extendWorkspaceWithSkillRoots(workspace, ['/repo/.agents/skills', '/extra/skills']),
    ).toBe(workspace);
  });

  it('dedupes roots that repeat or nest inside a just-added root', () => {
    expect(
      extendWorkspaceWithSkillRoots(workspace, ['/skills', '/skills', '/skills/sub']),
    ).toEqual({ workspaceDir: '/repo', additionalDirs: ['/extra', '/skills'] });
  });

  it('compares case-insensitively on win32 path class', () => {
    expect(
      extendWorkspaceWithSkillRoots(
        { workspaceDir: 'C:/repo', additionalDirs: [] },
        ['c:/Repo/skills'],
        'win32',
      ).additionalDirs,
    ).toEqual([]);
  });
});

describe('resolvePathAccess shell path bridge', () => {
  const WIN_ENV = {
    pathClass: 'win32' as const,
    homeDir: 'C:\\Users\\test',
    osKind: 'Windows',
    shellName: 'bash' as const,
    shellPath: 'C:\\kimi-test-nonexistent\\Git\\bin\\bash.exe',
  };

  it('routes win32 file-tool paths through the shell path bridge', () => {
    const result = resolvePathAccessPath('/c/workspace/file.txt', {
      env: WIN_ENV,
      workspace: { workspaceDir: 'C:\\workspace', additionalDirs: [] },
      operation: 'read',
    });
    expect(result).toBe('C:/workspace/file.txt');
  });

  it('passes root-relative POSIX paths through when cygpath is unavailable', () => {
    const result = resolvePathAccessPath('/tmp/scratch.txt', {
      env: WIN_ENV,
      workspace: { workspaceDir: 'C:\\workspace', additionalDirs: [] },
      operation: 'read',
    });
    expect(result).toBe('/tmp/scratch.txt');
  });

  it('normalizes through an explicitly injected shell path bridge', () => {
    const bridge: ShellPathBridge = {
      toShellPath: (p) => p,
      fromShellPath: (p) => (p.startsWith('/tmp/') ? `C:/Temp/${p.slice('/tmp/'.length)}` : p),
    };
    const result = resolvePathAccess(
      '/tmp/notes.txt',
      'C:\\workspace',
      { workspaceDir: 'C:\\workspace', additionalDirs: [] },
      {
        operation: 'read',
        pathClass: 'win32',
        policy: DEFAULT_WORKSPACE_ACCESS_POLICY,
        shellPathBridge: bridge,
      },
    );
    expect(result).toEqual({ path: 'C:/Temp/notes.txt', outsideWorkspace: true });
  });
});
