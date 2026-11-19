import { shallowEqualRecord } from '../api/daemon/sliceEquality';
import type { Session, WorkspaceGroup } from './types';

export type RowMemo<T> = (next: readonly T[]) => T[];

function shallowEqualRow<T>(a: T, b: T): boolean {
  return shallowEqualRecord(a as Record<string, unknown>, b as Record<string, unknown>);
}

export function createRowMemo<T>(
  keyOf: (row: T) => string,
  equal: (prev: T, next: T) => boolean = shallowEqualRow,
): RowMemo<T> {
  let prevRows: T[] = [];
  let prevByKey = new Map<string, T>();
  return (next) => {
    const byKey = new Map<string, T>();
    let unchanged = next.length === prevRows.length;
    const rows = next.map((row, index) => {
      const prev = prevByKey.get(keyOf(row));
      const kept = prev !== undefined && equal(prev, row) ? prev : row;
      byKey.set(keyOf(kept), kept);
      if (unchanged && prevRows[index] !== kept) unchanged = false;
      return kept;
    });
    prevByKey = byKey;
    if (unchanged) return prevRows;
    prevRows = rows;
    return rows;
  };
}

export function createSessionRowMemo(): RowMemo<Session> {
  return createRowMemo<Session>((row) => row.id);
}

export function createWorkspaceGroupMemo(): RowMemo<WorkspaceGroup> {
  const sessionMemos = new Map<string, RowMemo<Session>>();
  const groupMemo = createRowMemo<WorkspaceGroup>((group) => group.workspace.id);
  return (groups) => {
    const seen = new Set<string>();
    const stabilized = groups.map((group) => {
      const id = group.workspace.id;
      seen.add(id);
      let memo = sessionMemos.get(id);
      if (memo === undefined) {
        memo = createSessionRowMemo();
        sessionMemos.set(id, memo);
      }
      const sessions = memo(group.sessions);
      return sessions === group.sessions ? group : { ...group, sessions };
    });
    for (const id of sessionMemos.keys()) {
      if (!seen.has(id)) sessionMemos.delete(id);
    }
    return groupMemo(stabilized);
  };
}
