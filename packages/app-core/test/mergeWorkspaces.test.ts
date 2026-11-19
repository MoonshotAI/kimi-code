import { describe, expect, it } from 'vitest';
import type { AppWorkspace } from '../src/api/types';
import { mergeWorkspaces, type MergeWorkspacesInput } from '../src/lib/mergeWorkspaces';
import { workspaceRootKey } from '../src/lib/rootKey';

function ws(root: string, extra: Partial<AppWorkspace> = {}): AppWorkspace {
  const id = extra.id ?? `wd_${root}`;
  return {
    id,
    root,
    name: root,
    kind: id.startsWith('wm_') ? 'managed' : 'implicit',
    sessionCount: 0,
    additionalDirs: [],
    ...extra,
  };
}

function input(overrides: Partial<MergeWorkspacesInput>): MergeWorkspacesInput {
  return {
    workspaces: [],
    sessions: [],
    hiddenWorkspaceIds: [],
    sessionsHasMoreByWorkspace: {},
    ...overrides,
  };
}

describe('mergeWorkspaces — bucket identity', () => {
  it('assigns a session to the registered workspace when only the drive-letter case differs', () => {
    const w = ws('C:\\Users\\Foo\\Proj', { id: 'wd_proj' });
    const result = mergeWorkspaces(
      input({ workspaces: [w], sessions: [{ id: 's1', cwd: 'c:\\Users\\Foo\\Proj' }] }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('wd_proj');
    expect(result[0]!.root).toBe('C:\\Users\\Foo\\Proj');
    expect(result[0]!.sessionCount).toBe(1);
  });

  it('keeps same-root registry entries as distinct workspaces and buckets sessions by workspaceId', () => {
    const first = ws('C:\\Users\\Foo\\Proj', { id: 'wd_first' });
    const second = ws('c:\\Users\\Foo\\Proj', { id: 'wm_second' });
    const result = mergeWorkspaces(
      input({
        workspaces: [first, second],
        sessions: [
          { id: 's1', cwd: 'C:\\Users\\Foo\\Proj', workspaceId: 'wm_second' },
          { id: 's2', cwd: 'c:\\Users\\Foo\\Proj' },
        ],
      }),
    );
    expect(result.map((w) => w.id)).toEqual(['wd_first', 'wm_second']);
    expect(result[0]!.sessionCount).toBe(1);
    expect(result[1]!.sessionCount).toBe(1);
  });

  it('merges slash variants of the same Windows path via the cwd fallback', () => {
    const w = ws('C:/Users/Foo/Proj', { id: 'wd_proj' });
    const result = mergeWorkspaces(
      input({ workspaces: [w], sessions: [{ id: 's1', cwd: 'C:\\Users\\Foo\\Proj' }] }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('wd_proj');
    expect(result[0]!.root).toBe('C:/Users/Foo/Proj');
    expect(result[0]!.sessionCount).toBe(1);
  });

  it('hides workspaces by id, including the bucket their sessions fall into', () => {
    const w = ws('C:\\Users\\Foo\\Proj', { id: 'wd_proj' });
    const result = mergeWorkspaces(
      input({
        workspaces: [w],
        sessions: [{ id: 's1', cwd: 'c:\\Users\\Foo\\Proj' }],
        hiddenWorkspaceIds: ['wd_proj'],
      }),
    );
    expect(result).toHaveLength(0);
  });

  it('hides POSIX workspaces only by exact id', () => {
    const hidden = mergeWorkspaces(
      input({ workspaces: [ws('/home/Foo')], hiddenWorkspaceIds: ['wd_/home/Foo'] }),
    );
    expect(hidden).toHaveLength(0);
    const kept = mergeWorkspaces(
      input({ workspaces: [ws('/home/Foo', { sessionCount: 1 })], hiddenWorkspaceIds: ['wd_other'] }),
    );
    expect(kept).toHaveLength(1);
  });

  it('keeps POSIX paths case-sensitive', () => {
    const result = mergeWorkspaces(
      input({
        workspaces: [
          ws('/home/Foo', { id: 'wd_a', sessionCount: 1 }),
          ws('/home/foo', { id: 'wd_b', sessionCount: 1 }),
        ],
      }),
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

  it('keeps derived groups with case-variant Windows cwds separate (verbatim cwd fallback)', () => {
    const result = mergeWorkspaces(
      input({
        sessions: [
          { id: 's1', cwd: 'C:\\Users\\Foo\\Proj' },
          { id: 's2', cwd: 'c:\\Users\\Foo\\Proj' },
        ],
      }),
    );
    expect(result).toHaveLength(2);
  });

  it('derives a workspace for sessions whose workspaceId left the registry', () => {
    const result = mergeWorkspaces(
      input({
        sessions: [{ id: 's1', cwd: '/home/x/proj', workspaceId: 'wm_gone' }],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('wm_gone');
    expect(result[0]!.root).toBe('/home/x/proj');
  });

  it('orders real workspaces in daemon order and derived ones by display root', () => {
    const result = mergeWorkspaces(
      input({
        workspaces: [ws('/home/x/bbb', { sessionCount: 1 }), ws('/home/x/aaa', { sessionCount: 1 })],
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

describe('mergeWorkspaces — empty implicit workspaces', () => {
  it('hides empty implicit workspaces while keeping managed and non-empty implicit ones', () => {
    const result = mergeWorkspaces(
      input({
        workspaces: [
          ws('/empty-implicit'),
          ws('/empty-managed', { id: 'wm_empty' }),
          ws('/archived-implicit', { sessionCount: 1 }),
        ],
      }),
    );
    expect(result.map((w) => w.id)).toEqual(['wm_empty', 'wd_/archived-implicit']);
  });

  it('keeps an implicit workspace when a locally loaded session makes it non-empty', () => {
    const result = mergeWorkspaces(
      input({
        workspaces: [ws('/with-session')],
        sessions: [{ id: 's1', cwd: '/with-session' }],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionCount).toBe(1);
  });

  it('hides an implicit workspace again after its local session list is cleared', () => {
    const workspace = ws('/with-session', { sessionCount: 1 });
    const result = mergeWorkspaces(
      input({
        workspaces: [workspace],
        sessionsHasMoreByWorkspace: { [workspace.id]: false },
      }),
    );
    expect(result).toEqual([]);
  });
});

describe('mergeWorkspaces — scale', () => {
  it('merges tens of thousands of workspaces in linear time', () => {
    const count = 30_000;
    const workspaces = Array.from({ length: count }, (_, i) =>
      ws(`/home/x/project-${i}`, { id: `wm_project-${i}` }),
    );
    const sessions = Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      cwd: `/home/x/${i % 2 === 0 ? 'project' : 'derived'}-${i}`,
    }));
    const startedAt = performance.now();
    const result = mergeWorkspaces(input({ workspaces, sessions }));
    const elapsedMs = performance.now() - startedAt;
    expect(result).toHaveLength(count + count / 2);
    expect(result[0]!.root).toBe('/home/x/project-0');
    expect(result[count - 1]!.root).toBe(`/home/x/project-${count - 1}`);
    expect(elapsedMs).toBeLessThan(300);
  });
});

describe('workspaceRootKey', () => {
  it('folds drive-letter casing', () => {
    expect(workspaceRootKey('C:\\Users\\Foo')).toBe(workspaceRootKey('c:\\Users\\Foo'));
    expect(workspaceRootKey('C:\\Users\\Foo')).toBe('c:/users/foo');
  });

  it('folds drive roots before separator stripping can mask the shape', () => {
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
