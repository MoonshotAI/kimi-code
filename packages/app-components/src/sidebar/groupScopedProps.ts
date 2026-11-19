export interface SessionGroupLike {
  readonly workspace: { readonly id: string };
  readonly sessions: readonly { readonly id: string }[];
}

export const ACTIVE_SESSION_IN_OTHER_GROUP = '#active-session-in-other-group';

export const EMPTY_GROUP_RECORD: Readonly<Record<string, never>> = Object.freeze({});

export function workspaceIdsContainingSession(
  groups: readonly SessionGroupLike[],
  sessionId: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!sessionId) return ids;
  for (const group of groups) {
    if (group.sessions.some((session) => session.id === sessionId)) ids.add(group.workspace.id);
  }
  return ids;
}

export function scopedActiveSessionId(activeSessionId: string, groupContainsActive: boolean): string {
  if (!activeSessionId || groupContainsActive) return activeSessionId;
  return ACTIVE_SESSION_IN_OTHER_GROUP;
}

export type GroupRecordScoper<T> = (
  groups: readonly SessionGroupLike[],
  source: Readonly<Record<string, T>>,
) => ReadonlyMap<string, Readonly<Record<string, T>>>;

export function createGroupScopedRecords<T>(
  sameValue: (a: T, b: T) => boolean = Object.is,
): GroupRecordScoper<T> {
  let previous = new Map<string, Readonly<Record<string, T>>>();
  return (groups, source) => {
    const next = new Map<string, Readonly<Record<string, T>>>();
    for (const group of groups) {
      let scoped: Record<string, T> | null = null;
      for (const session of group.sessions) {
        if (!Object.hasOwn(source, session.id)) continue;
        scoped ??= {};
        scoped[session.id] = source[session.id]!;
      }
      const prior = previous.get(group.workspace.id);
      if (scoped === null) {
        next.set(group.workspace.id, EMPTY_GROUP_RECORD);
      } else if (prior !== undefined && sameRecord(prior, scoped, sameValue)) {
        next.set(group.workspace.id, prior);
      } else {
        next.set(group.workspace.id, scoped);
      }
    }
    previous = next;
    return next;
  };
}

function sameRecord<T>(
  a: Readonly<Record<string, T>>,
  b: Readonly<Record<string, T>>,
  sameValue: (a: T, b: T) => boolean,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key) || !sameValue(a[key]!, b[key]!)) return false;
  }
  return true;
}
