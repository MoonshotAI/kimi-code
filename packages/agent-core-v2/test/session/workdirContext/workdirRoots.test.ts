import { describe, expect, it } from 'vitest';

import {
  resolveEffectiveWorkdirRoots,
  sessionWorkDir,
} from '#/session/workdirContext/workdirRoots';

describe('sessionWorkDir', () => {
  it('keeps a local session with an environment cwd in its own directory whatever the project root is', () => {
    const pinned = { cwd: '/repo', environmentCwd: '/repo-fix' };

    expect(sessionWorkDir(pinned, '/repo')).toBe('/repo-fix');
    expect(sessionWorkDir(pinned, '/moved')).toBe('/repo-fix');
    expect(sessionWorkDir(pinned, undefined)).toBe('/repo-fix');
    expect(sessionWorkDir({ environmentId: 'local', environmentCwd: '/repo-fix' }, '/repo')).toBe('/repo-fix');
  });

  it('moves an old session without an environment cwd with the project root', () => {
    const old = { cwd: '/created-in' };

    expect(sessionWorkDir(old, '/repo')).toBe('/repo');
    expect(sessionWorkDir(old, '/moved')).toBe('/moved');
    expect(sessionWorkDir({}, '/repo')).toBe('/repo');
  });

  it('falls back to the recorded cwd of an old session whose project is gone', () => {
    expect(sessionWorkDir({ cwd: '/created-in' }, undefined)).toBe('/created-in');
    expect(sessionWorkDir({}, undefined)).toBeUndefined();
  });

  it('reports a session bound to another environment at its host cwd and never at the remote environment cwd', () => {
    expect(sessionWorkDir({ cwd: '/host', environmentId: 'ssh', environmentCwd: '/remote' }, '/repo')).toBe('/host');
    expect(sessionWorkDir({ environmentId: 'ssh', environmentCwd: '/remote' }, '/repo')).toBe('/repo');
    expect(sessionWorkDir({ environmentId: 'ssh', environmentCwd: '/remote' }, undefined)).toBeUndefined();
  });
});

describe('resolveEffectiveWorkspaceRoots', () => {
  const session = { workspaceId: 'wd_repo', cwd: '/created-in' };
  const workspace = { primaryByWorkspace: { wd_repo: '/repo' }, additionalDirs: ['/shared'] };

  it('derives the local working directory from the session placement', () => {
    expect(resolveEffectiveWorkdirRoots(session, undefined, workspace)).toEqual({
      workDir: '/repo',
      primaryDir: '/repo',
      additionalDirs: ['/shared'],
      followsPrimary: true,
    });
    expect(resolveEffectiveWorkdirRoots(session, { environmentId: 'local', cwd: '/repo-fix' }, workspace)).toEqual({
      workDir: '/repo-fix',
      primaryDir: '/repo',
      additionalDirs: ['/repo', '/shared'],
      followsPrimary: false,
    });
    expect(
      resolveEffectiveWorkdirRoots(session, undefined, { primaryByWorkspace: {}, additionalDirs: [] }).workDir,
    ).toBe('/created-in');
  });

  it('keeps the remote working directory on the environment side', () => {
    expect(resolveEffectiveWorkdirRoots(session, { environmentId: 'ssh', cwd: '/remote' }, workspace)).toEqual({
      workDir: '/remote',
      primaryDir: undefined,
      additionalDirs: ['/shared'],
      followsPrimary: false,
    });
    expect(
      resolveEffectiveWorkdirRoots(session, { environmentId: 'ssh' }, workspace, { cwd: '/home/me/work', homeDir: '/home/me' })
        .workDir,
    ).toBe('/home/me/work');
  });
});
