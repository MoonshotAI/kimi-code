import { describe, expect, it } from 'vitest';

import {
  resolveEffectiveWorkspaceRoots,
  sessionWorkDir,
  workDirToPin,
} from '#/session/workspaceContext/workspaceRoots';

describe('sessionWorkDir', () => {
  it('keeps a local session with an environment cwd in its own directory whatever the project root is', () => {
    const pinned = { cwd: '/repo', environmentCwd: '/repo-fix' };

    expect(sessionWorkDir(pinned, '/repo')).toBe('/repo-fix');
    expect(sessionWorkDir(pinned, '/moved')).toBe('/repo-fix');
    expect(sessionWorkDir(pinned, undefined)).toBe('/repo-fix');
    expect(sessionWorkDir({ environmentId: 'local', environmentCwd: '/repo-fix' }, '/repo')).toBe('/repo-fix');
  });

  it('moves a session without an environment cwd with the project root', () => {
    const following = { cwd: '/created-in' };

    expect(sessionWorkDir(following, '/repo')).toBe('/repo');
    expect(sessionWorkDir(following, '/moved')).toBe('/moved');
    expect(sessionWorkDir({}, '/repo')).toBe('/repo');
  });

  it('falls back to the recorded cwd of a following session whose project is gone', () => {
    expect(sessionWorkDir({ cwd: '/created-in' }, undefined)).toBe('/created-in');
    expect(sessionWorkDir({}, undefined)).toBeUndefined();
  });

  it('reports a session bound to another environment at its host cwd and never at the remote environment cwd', () => {
    expect(sessionWorkDir({ cwd: '/host', environmentId: 'ssh', environmentCwd: '/remote' }, '/repo')).toBe('/host');
    expect(sessionWorkDir({ environmentId: 'ssh', environmentCwd: '/remote' }, '/repo')).toBe('/repo');
    expect(sessionWorkDir({ environmentId: 'ssh', environmentCwd: '/remote' }, undefined)).toBeUndefined();
  });
});

describe('workDirToPin', () => {
  it('leaves a session started at the project root following it, however the root is spelled', () => {
    expect(workDirToPin('/repo', '/repo')).toBeUndefined();
    expect(workDirToPin('/repo/', '/repo')).toBeUndefined();
    expect(workDirToPin('/repo/src/..', '/repo')).toBeUndefined();
    expect(workDirToPin(String.raw`c:\work\app`, 'C:/Work/App')).toBeUndefined();
    expect(workDirToPin('C:/Work/App/', String.raw`C:\Work\App`)).toBeUndefined();
  });

  it('pins a session started anywhere else at the directory as the user spelled it', () => {
    expect(workDirToPin('/repo-fix', '/repo')).toBe('/repo-fix');
    expect(workDirToPin('/repo/src', '/repo')).toBe('/repo/src');
    expect(workDirToPin('/link-to-repo', '/repo')).toBe('/link-to-repo');
    expect(workDirToPin('/Repo', '/repo')).toBe('/Repo');
    expect(workDirToPin(String.raw`C:\Work\App-Fix`, 'C:/Work/App')).toBe(String.raw`C:\Work\App-Fix`);
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
