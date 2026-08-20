// packages/app-core/test/openGroups.test.ts
import { describe, expect, it } from 'vitest';
import { visibleOpenGroups, type OpenGroupLike } from '../src/lib/openGroups';

interface Group extends OpenGroupLike {
  readonly workspace: { readonly id: string };
}

function group(id: string, sessionCount: number): Group {
  return {
    workspace: { id },
    sessions: Array.from({ length: sessionCount }, (_, i) => ({ id: `s${i}` })),
  };
}

describe('visibleOpenGroups', () => {
  it('status-tabs view: drops groups with no open sessions', () => {
    const groups = [group('a', 2), group('b', 0), group('c', 1)];
    const result = visibleOpenGroups(groups, null, true);
    expect(result.map((g) => g.workspace.id)).toEqual(['a', 'c']);
  });

  it('status-tabs view: keeps the ACTIVE workspace even when empty (draft head fill)', () => {
    const groups = [group('a', 0), group('b', 0)];
    const result = visibleOpenGroups(groups, 'b', true);
    expect(result.map((g) => g.workspace.id)).toEqual(['b']);
  });

  it('legacy single-list view: keeps EVERY group, empty ones included', () => {
    // Regression: with no 工作空间 tab to fall back on, archiving a
    // workspace's last session must not make the workspace unreachable.
    const groups = [group('a', 2), group('b', 0)];
    const result = visibleOpenGroups(groups, 'a', false);
    expect(result.map((g) => g.workspace.id)).toEqual(['a', 'b']);
  });

  it('legacy single-list view: returns the input array itself (no copy)', () => {
    const groups = [group('a', 0)];
    expect(visibleOpenGroups(groups, null, false)).toBe(groups);
  });
});
