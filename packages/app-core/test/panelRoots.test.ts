import { describe, expect, it } from 'vitest';
import { panelRoots } from '../src/lib/panelRoots';

const repo = { root: '/repo', additionalDirs: ['/shared', '/repo-fix'] };

describe('panelRoots', () => {
  it('roots the draft page at the project root followed by the additional directories', () => {
    expect(panelRoots(undefined, repo)).toEqual({ root: '/repo', roots: ['/repo', '/shared', '/repo-fix'] });
  });

  it('roots a worktree session at its working directory without the project root', () => {
    expect(panelRoots({ cwd: '/repo-wt' }, repo)).toEqual({
      root: '/repo-wt',
      roots: ['/repo-wt', '/shared', '/repo-fix'],
    });
  });

  it('keeps a session that runs in the project root on the project directories', () => {
    expect(panelRoots({ cwd: '/repo' }, repo)).toEqual(panelRoots(undefined, repo));
  });

  it('keeps every other registered directory for a session that runs in an additional directory', () => {
    expect(panelRoots({ cwd: '/repo-fix' }, repo)).toEqual({
      root: '/repo-fix',
      roots: ['/repo-fix', '/repo', '/shared'],
    });
  });

  it('matches registered directories by path key and keeps the first spelling', () => {
    expect(panelRoots(undefined, { root: 'C:\\Repo', additionalDirs: ['c:/repo/', 'D:\\lib', 'd:/Lib/'] })).toEqual({
      root: 'C:\\Repo',
      roots: ['C:\\Repo', 'D:\\lib'],
    });
    expect(panelRoots({ cwd: 'c:/repo-fix/' }, { root: 'C:\\Repo', additionalDirs: ['C:\\Repo-fix', 'D:\\lib'] })).toEqual({
      root: 'c:/repo-fix/',
      roots: ['c:/repo-fix/', 'C:\\Repo', 'D:\\lib'],
    });
  });

  it('falls back to the project root while the session working directory is unknown', () => {
    expect(panelRoots({ cwd: '' }, repo)).toEqual(panelRoots(undefined, repo));
  });

  it('roots a session outside any project at its working directory alone', () => {
    expect(panelRoots({ cwd: '/loose' }, undefined)).toEqual({ root: '/loose', roots: ['/loose'] });
    expect(panelRoots({ cwd: '' }, undefined)).toEqual({ root: '', roots: [] });
    expect(panelRoots(undefined, undefined)).toEqual({ root: '', roots: [] });
  });
});
