import { describe, expect, it } from 'vitest';

import type { Project } from '#/app/project/project';
import { registryDirSet } from '#/project/projectDirs/registryDirSet';

function project(id: string, root: string, additionalDirs: readonly string[], kind: Project['kind'] = 'implicit'): Project {
  return { id, root, name: id, kind, additionalDirs, createdAt: 0, lastOpenedAt: 0 };
}

const repo = project('wd_app', '/code/app', ['/shared/lib']);

describe('registryDirSet', () => {
  it('gives the root view the additional dirs and maps the project to its primary', () => {
    expect(registryDirSet({ project: repo, others: [repo], cwd: '/code/app', local: true, followsPrimary: true })).toEqual({
      registryDirs: ['/shared/lib'],
      primaryByWorkspace: { wd_app: '/code/app' },
    });
  });

  it('gives a view pinned at a registered dir the rest of the set, primary included', () => {
    expect(registryDirSet({ project: repo, others: [], cwd: '/shared/lib', local: true, followsPrimary: false })).toEqual({
      registryDirs: ['/code/app'],
      primaryByWorkspace: { wd_app: '/code/app' },
    });
  });

  it.each([
    ['a worktree of the repository', '/code/app-fix'],
    ['a subdirectory of the primary', '/code/app/src'],
  ])('gives a local view pinned at %s the additional dirs but never the primary', (_label, cwd) => {
    expect(registryDirSet({ project: repo, others: [repo], cwd, local: true, followsPrimary: false })).toEqual({
      registryDirs: ['/shared/lib'],
      primaryByWorkspace: {},
    });
  });

  it('keeps a remote view outside the registered dirs without local registry dirs', () => {
    expect(registryDirSet({ project: repo, others: [], cwd: '/srv/app', local: false, followsPrimary: false })).toEqual({
      registryDirs: [],
      primaryByWorkspace: {},
    });
  });

  it('absorbs other implicit projects that register the cwd and never managed ones', () => {
    const member = project('wd_member', '/code/member', []);
    const implicitNeighbour = project('wd_neighbour', '/code/neighbour', ['/code/member', '/extra/implicit']);
    const managedNeighbour = project('wm_neighbour', '/code/managed', ['/code/member', '/extra/managed'], 'managed');

    expect(registryDirSet({
      project: member,
      others: [member, implicitNeighbour, managedNeighbour],
      cwd: '/code/member',
      local: true,
      followsPrimary: true,
    })).toEqual({
      registryDirs: ['/code/neighbour', '/extra/implicit'],
      primaryByWorkspace: { wd_member: '/code/member', wd_neighbour: '/code/neighbour' },
    });
  });

  it('dedupes directories across Windows spelling variants', () => {
    const typed = project('wd_typed', 'C:\\Users\\Me\\App', ['C:\\Users\\Me\\Lib']);
    const alias = project('wd_alias', 'c:/users/me/app', ['c:/users/me/lib/', 'D:\\Other']);

    expect(registryDirSet({ project: typed, others: [alias], cwd: 'C:\\Users\\Me\\App', local: true, followsPrimary: true })).toEqual({
      registryDirs: ['C:\\Users\\Me\\Lib', 'D:\\Other'],
      primaryByWorkspace: { wd_typed: 'C:\\Users\\Me\\App', wd_alias: 'c:/users/me/app' },
    });
  });

  it('keeps only absorbed projects when the own entry is gone', () => {
    const neighbour = project('wd_neighbour', '/code/neighbour', ['/code/app']);

    expect(registryDirSet({ others: [neighbour], cwd: '/code/app', local: true, followsPrimary: true })).toEqual({
      registryDirs: ['/code/neighbour'],
      primaryByWorkspace: { wd_neighbour: '/code/neighbour' },
    });
  });
});
