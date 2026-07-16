import { describe, expect, it } from 'vitest';

import { extendWorkspaceWithSkillRoots, isSensitiveFile } from '#/tool/path-access';

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

  it('matches SSH private key patterns in the .ssh directory', () => {
    for (const path of [
      '/home/user/.ssh/id_rsa',
      '/home/user/.ssh/id_ed25519',
      '/home/user/.ssh/id_ecdsa',
      '/home/user/.ssh/id_ed25519_sk',
      '/home/user/.ssh/id_ecdsa_sk',
      '.ssh/id_rsa',
      '/home/user/.ssh/id_rsa-backup',
      '.ssh/id_rsa.old',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('does not flag SSH public key files', () => {
    for (const path of [
      '/home/user/.ssh/id_rsa.pub',
      '/home/user/.ssh/id_ed25519.pub',
      '/home/user/.ssh/authorized_keys',
      '/home/user/.ssh/known_hosts',
    ]) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });

  it('flags paths with mixed-case sensitive patterns on posix systems', () => {
    expect(isSensitiveFile('/home/user/.SSH/ID_RSA')).toBe(true);
    expect(isSensitiveFile('/home/user/.Ssh/Id_Ed25519')).toBe(true);
    expect(isSensitiveFile('/app/.Env.Production')).toBe(true);
  });

  it('rejects extremely long paths gracefully', () => {
    const longBase = '/'.repeat(10_000) + '.env';
    expect(isSensitiveFile(longBase)).toBe(true);
    const longSafe = '/'.repeat(10_000) + 'README.md';
    expect(isSensitiveFile(longSafe)).toBe(false);
  });

  it('handles paths with special characters like spaces and parentheses', () => {
    expect(isSensitiveFile('/home/user/my project/.env')).toBe(true);
    expect(isSensitiveFile('/home/user/project (copy)/config.yml')).toBe(false);
    expect(isSensitiveFile('/home/user/.aws/credentials (backup)')).toBe(true);
  });

  it('flags .git-credentials in any directory', () => {
    expect(isSensitiveFile('/home/user/.git-credentials')).toBe(true);
    expect(isSensitiveFile('.git-credentials')).toBe(true);
  });

  it('does not flag .gitignore or .gitattributes', () => {
    expect(isSensitiveFile('/repo/.gitignore')).toBe(false);
    expect(isSensitiveFile('/repo/.gitattributes')).toBe(false);
    expect(isSensitiveFile('.gitignore')).toBe(false);
  });

  it('flags .npmrc and .yarnrc files', () => {
    expect(isSensitiveFile('/home/user/.npmrc')).toBe(true);
    expect(isSensitiveFile('/home/user/.yarnrc')).toBe(true);
    expect(isSensitiveFile('.npmrc')).toBe(true);
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

  it('handles a large number of skill roots without performance issues', () => {
    const manyRoots = Array.from({ length: 100 }, (_, i) => `/skills/root-${String(i)}`);
    const result = extendWorkspaceWithSkillRoots(workspace, manyRoots);
    expect(result.additionalDirs).toHaveLength(100 + 1); // original + 100 new
    expect(result.additionalDirs[0]).toBe('/extra');
  });

  it('dedupes a root that is an exact match of the workspace dir', () => {
    const result = extendWorkspaceWithSkillRoots(
      { workspaceDir: '/repo', additionalDirs: [] },
      ['/repo'],
    );
    expect(result.additionalDirs).toEqual([]);
  });

  it('does not add a root that is already a parent of the workspace dir', () => {
    const result = extendWorkspaceWithSkillRoots(
      { workspaceDir: '/repo/sub', additionalDirs: [] },
      ['/repo'],
    );
    expect(result.additionalDirs).toEqual([]);
  });

  it('handles empty additionalDirs and empty skill roots', () => {
    const result = extendWorkspaceWithSkillRoots(
      { workspaceDir: '/repo', additionalDirs: [] },
      [],
    );
    expect(result.additionalDirs).toEqual([]);
  });
});
