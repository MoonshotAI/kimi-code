// apps/kimi-web/src/lib/mergeWorkspaces.test.ts
import { describe, expect, it } from 'vitest';
import type { AppWorkspace } from '../api/types';
import { mergeWorkspaces, type MergeWorkspacesInput } from './mergeWorkspaces';
import { workspaceRootKey } from './rootKey';

function ws(root: string, extra: Partial<AppWorkspace> = {}): AppWorkspace {
  return { id: `wd_${root}`, root, name: root, sessionCount: 0, ...extra };
}

function input(overrides: Partial<MergeWorkspacesInput>): MergeWorkspacesInput {
  return {
    workspaces: [],
    sessions: [],
    hiddenWorkspaceRoots: [],
    sessionsHasMoreByWorkspace: {},
    ...overrides,
  };
}

describe('mergeWorkspaces — folded root identity', () => {
  it('assigns a session to the registered workspace when only the drive-letter case differs', () => {
    const w = ws('C:\\Users\\Foo\\Proj', { id: 'wd_proj' });
    const result = mergeWorkspaces(
      input({ workspaces: [w], sessions: [{ id: 's1', cwd: 'c:\\Users\\Foo\\Proj' }] }),
    );
    expect(result).toHaveLength(1); // no derived duplicate group
    expect(result[0]!.id).toBe('wd_proj');
    expect(result[0]!.root).toBe('C:\\Users\\Foo\\Proj'); // registered spelling kept
    expect(result[0]!.sessionCount).toBe(1); // counted under the registered id
  });

  it('collapses legacy registered duplicates whose roots only differ by case', () => {
    const first = ws('C:\\Users\\Foo\\Proj', { id: 'wd_first' });
    const second = ws('c:\\Users\\Foo\\Proj', { id: 'wd_second' });
    const result = mergeWorkspaces(
      input({
        workspaces: [first, second],
        sessions: [
          { id: 's1', cwd: 'C:\\Users\\Foo\\Proj' },
          { id: 's2', cwd: 'c:\\Users\\Foo\\Proj' },
        ],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('wd_first'); // daemon order: first entry wins
    expect(result[0]!.root).toBe('C:\\Users\\Foo\\Proj');
    expect(result[0]!.sessionCount).toBe(2); // both cwd variants assigned to it
  });

  it('merges slash variants of the same Windows path', () => {
    const w = ws('C:/Users/Foo/Proj', { id: 'wd_proj' });
    const result = mergeWorkspaces(
      input({ workspaces: [w], sessions: [{ id: 's1', cwd: 'C:\\Users\\Foo\\Proj' }] }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('wd_proj');
    expect(result[0]!.root).toBe('C:/Users/Foo/Proj');
    expect(result[0]!.sessionCount).toBe(1);
  });

  it('hides Windows-shaped roots case-insensitively', () => {
    const w = ws('C:\\Users\\Foo\\Proj', { id: 'wd_proj' });
    const result = mergeWorkspaces(
      input({
        workspaces: [w],
        sessions: [{ id: 's1', cwd: 'c:\\Users\\Foo\\Proj' }],
        hiddenWorkspaceRoots: ['c:\\users\\foo\\proj'],
      }),
    );
    expect(result).toHaveLength(0); // one casing removed, all spellings hidden
  });

  it('hides POSIX roots only by exact directory (trailing slash tolerated)', () => {
    const hidden = mergeWorkspaces(
      input({ workspaces: [ws('/home/Foo')], hiddenWorkspaceRoots: ['/home/Foo/'] }),
    );
    expect(hidden).toHaveLength(0);
    const kept = mergeWorkspaces(
      input({ workspaces: [ws('/home/Foo')], hiddenWorkspaceRoots: ['/home/foo'] }),
    );
    expect(kept).toHaveLength(1);
  });

  it('keeps POSIX paths case-sensitive', () => {
    const result = mergeWorkspaces(
      input({ workspaces: [ws('/home/Foo', { id: 'wd_a' }), ws('/home/foo', { id: 'wd_b' })] }),
    );
    expect(result.map((w) => w.root)).toEqual(['/home/Foo', '/home/foo']);
  });

  it('keeps case-variant derived POSIX cwds as separate groups', () => {
    const result = mergeWorkspaces(
      input({
        sessions: [
          { id: 's1', cwd: '/home/Foo' },
          { id: 's2', cwd: '/home/foo' },
        ],
      }),
    );
    expect(result).toHaveLength(2);
  });

  it('merges derived groups whose session cwds differ only by case', () => {
    const result = mergeWorkspaces(
      input({
        sessions: [
          { id: 's1', cwd: 'C:\\Users\\Foo\\Proj' },
          { id: 's2', cwd: 'c:\\Users\\Foo\\Proj' },
        ],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.root).toBe('C:\\Users\\Foo\\Proj'); // first-seen cwd kept
  });

  it('orders real workspaces in daemon order and derived ones by display root', () => {
    const result = mergeWorkspaces(
      input({
        workspaces: [ws('/home/x/bbb'), ws('/home/x/aaa')],
        sessions: [
          { id: 's1', cwd: '/home/x/ccc' },
          { id: 's2', cwd: '/home/x/000' },
        ],
      }),
    );
    expect(result.map((w) => w.root)).toEqual([
      '/home/x/bbb',
      '/home/x/aaa',
      '/home/x/000',
      '/home/x/ccc',
    ]);
  });
});

describe('workspaceRootKey', () => {
  it('folds drive-letter casing', () => {
    expect(workspaceRootKey('C:\\Users\\Foo')).toBe(workspaceRootKey('c:\\Users\\Foo'));
    expect(workspaceRootKey('C:\\Users\\Foo')).toBe('c:/users/foo');
  });

  it('folds drive roots before separator stripping can mask the shape', () => {
    // `C:\` would strip to `C:` and stop reading as Windows-shaped.
    expect(workspaceRootKey('C:\\')).toBe('c:');
    expect(workspaceRootKey('C:\\')).toBe(workspaceRootKey('c:\\'));
    expect(workspaceRootKey('C:\\')).toBe(workspaceRootKey('c:/'));
  });

  it('folds UNC paths', () => {
    expect(workspaceRootKey('\\\\HOST\\Share\\Dir')).toBe('//host/share/dir');
    expect(workspaceRootKey('\\\\HOST\\Share\\Dir')).toBe(workspaceRootKey('//host/share/dir'));
  });

  it('normalizes slashes and strips trailing separators', () => {
    expect(workspaceRootKey('C:\\Users\\Foo\\')).toBe('c:/users/foo');
    expect(workspaceRootKey('C:/Users/Foo/')).toBe('c:/users/foo');
    expect(workspaceRootKey('/home/Foo/')).toBe('/home/Foo');
  });

  it('never folds POSIX paths', () => {
    expect(workspaceRootKey('/home/Foo')).toBe('/home/Foo');
    expect(workspaceRootKey('/home/Foo')).not.toBe(workspaceRootKey('/home/foo'));
  });
});
