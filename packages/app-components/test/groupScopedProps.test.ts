import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SESSION_IN_OTHER_GROUP,
  EMPTY_GROUP_RECORD,
  createGroupScopedRecords,
  scopedActiveSessionId,
  workspaceIdsContainingSession,
  type SessionGroupLike,
} from '../src/sidebar/groupScopedProps';

function group(id: string, sessionIds: string[]): SessionGroupLike {
  return { workspace: { id }, sessions: sessionIds.map((sid) => ({ id: sid })) };
}

const GROUPS = [group('a', ['a1', 'a2']), group('b', ['b1']), group('c', [])];

describe('workspaceIdsContainingSession', () => {
  it('finds every group that lists the session', () => {
    expect([...workspaceIdsContainingSession(GROUPS, 'a2')]).toEqual(['a']);
    expect([...workspaceIdsContainingSession([...GROUPS, group('d', ['a2'])], 'a2')]).toEqual(['a', 'd']);
  });

  it('returns nothing for an empty or unknown session', () => {
    expect(workspaceIdsContainingSession(GROUPS, '').size).toBe(0);
    expect(workspaceIdsContainingSession(GROUPS, 'zz').size).toBe(0);
  });
});

describe('scopedActiveSessionId', () => {
  it('passes the active session through to the group that lists it', () => {
    expect(scopedActiveSessionId('a1', true)).toBe('a1');
  });

  it('keeps "no active session" distinguishable from "active elsewhere"', () => {
    expect(scopedActiveSessionId('', false)).toBe('');
    expect(scopedActiveSessionId('', true)).toBe('');
    expect(scopedActiveSessionId('a1', false)).toBe(ACTIVE_SESSION_IN_OTHER_GROUP);
    expect(ACTIVE_SESSION_IN_OTHER_GROUP).not.toBe('');
  });
});

describe('createGroupScopedRecords', () => {
  it('splits a record by group and shares one empty record for groups without entries', () => {
    const scope = createGroupScopedRecords<boolean>();
    const out = scope(GROUPS, { a2: true, b1: true, zz: true });
    expect(out.get('a')).toEqual({ a2: true });
    expect(out.get('b')).toEqual({ b1: true });
    expect(out.get('c')).toBe(EMPTY_GROUP_RECORD);
  });

  it('keeps the previous record identity for groups whose entries did not change', () => {
    const scope = createGroupScopedRecords<boolean>();
    const first = scope(GROUPS, { a1: true, b1: true });
    const second = scope(GROUPS, { a1: true, b1: false });
    expect(second.get('a')).toBe(first.get('a'));
    expect(second.get('b')).not.toBe(first.get('b'));
    expect(second.get('b')).toEqual({ b1: false });
  });

  it('compares values with the provided equality', () => {
    const scope = createGroupScopedRecords<{ approvals: number; questions: number }>(
      (x, y) => x.approvals === y.approvals && x.questions === y.questions,
    );
    const first = scope(GROUPS, { a1: { approvals: 1, questions: 0 } });
    const same = scope(GROUPS, { a1: { approvals: 1, questions: 0 } });
    expect(same.get('a')).toBe(first.get('a'));
    const changed = scope(GROUPS, { a1: { approvals: 2, questions: 0 } });
    expect(changed.get('a')).not.toBe(first.get('a'));
  });

  it('drops a record once its last entry disappears', () => {
    const scope = createGroupScopedRecords<boolean>();
    scope(GROUPS, { a1: true });
    expect(scope(GROUPS, {}).get('a')).toBe(EMPTY_GROUP_RECORD);
  });

  it('notices added and removed keys even when the count matches', () => {
    const scope = createGroupScopedRecords<boolean>();
    const first = scope(GROUPS, { a1: true });
    const moved = scope(GROUPS, { a2: true });
    expect(moved.get('a')).not.toBe(first.get('a'));
    expect(moved.get('a')).toEqual({ a2: true });
  });

  it('forgets groups that are no longer listed', () => {
    const scope = createGroupScopedRecords<boolean>();
    const first = scope(GROUPS, { b1: true });
    scope([group('a', ['a1'])], {});
    const back = scope(GROUPS, { b1: true });
    expect(back.get('b')).toEqual({ b1: true });
    expect(back.get('b')).not.toBe(first.get('b'));
  });
});
