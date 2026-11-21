import { describe, expect, it } from 'vitest';

import {
  resolveEffectiveWorkspaceRoots,
  sessionPlacementOf,
  sessionWorkDir,
} from '#/session/workspaceContext/workspaceRoots';

describe('session placement', () => {
  it('reads a local session with an environment cwd as pinned there', () => {
    expect(sessionPlacementOf({ cwd: '/repo', environmentCwd: '/repo-fix' })).toEqual({
      kind: 'pinned',
      workDir: '/repo-fix',
    });
    expect(sessionPlacementOf({ environmentId: 'local', environmentCwd: '/repo-fix' })).toEqual({
      kind: 'pinned',
      workDir: '/repo-fix',
    });
  });

  it('reads a local session without an environment cwd as following the project root', () => {
    expect(sessionPlacementOf({ cwd: '/created-in' })).toEqual({
      kind: 'follows-project-root',
      createdIn: '/created-in',
    });
    expect(sessionPlacementOf({})).toEqual({ kind: 'follows-project-root', createdIn: undefined });
  });

  it('reads a session bound to another environment as remote with its host cwd', () => {
    expect(sessionPlacementOf({ cwd: '/host', environmentId: 'ssh', environmentCwd: '/remote' })).toEqual({
      kind: 'remote',
      hostCwd: '/host',
    });
  });
});

describe('sessionWorkDir', () => {
  it('keeps a pinned session in its own directory whatever the project root is', () => {
    const pinned = sessionPlacementOf({ cwd: '/repo', environmentCwd: '/repo-fix' });

    expect(sessionWorkDir(pinned, '/repo')).toBe('/repo-fix');
    expect(sessionWorkDir(pinned, '/moved')).toBe('/repo-fix');
    expect(sessionWorkDir(pinned, undefined)).toBe('/repo-fix');
  });

  it('moves an old session without an environment cwd with the project root', () => {
    const old = sessionPlacementOf({ cwd: '/created-in' });

    expect(sessionWorkDir(old, '/repo')).toBe('/repo');
    expect(sessionWorkDir(old, '/moved')).toBe('/moved');
  });

  it('falls back to the recorded cwd of an old session whose project is gone', () => {
    expect(sessionWorkDir(sessionPlacementOf({ cwd: '/created-in' }), undefined)).toBe('/created-in');
    expect(sessionWorkDir(sessionPlacementOf({}), undefined)).toBeUndefined();
  });

  it('reports a remote session at its host cwd and never at the remote environment cwd', () => {
    expect(
      sessionWorkDir(sessionPlacementOf({ cwd: '/host', environmentId: 'ssh', environmentCwd: '/remote' }), '/repo'),
    ).toBe('/host');
    expect(
      sessionWorkDir(sessionPlacementOf({ environmentId: 'ssh', environmentCwd: '/remote' }), '/repo'),
    ).toBe('/repo');
    expect(sessionWorkDir(sessionPlacementOf({ environmentId: 'ssh', environmentCwd: '/remote' }), undefined)).toBeUndefined();
  });
});

describe('resolveEffectiveWorkspaceRoots', () => {
  const session = { workspaceId: 'wd_repo', cwd: '/created-in' };
  const workspace = { primaryByWorkspace: { wd_repo: '/repo' }, additionalDirs: ['/shared'] };

  it('derives the local working directory from the session placement', () => {
    expect(resolveEffectiveWorkspaceRoots(session, undefined, workspace)).toEqual({
      workDir: '/repo',
      primaryDir: '/repo',
      additionalDirs: ['/shared'],
      followsPrimary: true,
    });
    expect(resolveEffectiveWorkspaceRoots(session, { environmentId: 'local', cwd: '/repo-fix' }, workspace)).toEqual({
      workDir: '/repo-fix',
      primaryDir: '/repo',
      additionalDirs: ['/repo', '/shared'],
      followsPrimary: false,
    });
    expect(
      resolveEffectiveWorkspaceRoots(session, undefined, { primaryByWorkspace: {}, additionalDirs: [] }).workDir,
    ).toBe('/created-in');
  });

  it('keeps the remote working directory on the environment side', () => {
    expect(resolveEffectiveWorkspaceRoots(session, { environmentId: 'ssh', cwd: '/remote' }, workspace)).toEqual({
      workDir: '/remote',
      primaryDir: undefined,
      additionalDirs: ['/shared'],
      followsPrimary: false,
    });
    expect(
      resolveEffectiveWorkspaceRoots(session, { environmentId: 'ssh' }, workspace, { cwd: '/home/me/work', homeDir: '/home/me' })
        .workDir,
    ).toBe('/home/me/work');
  });
});
