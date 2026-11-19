import type { AppSession, AppWorkspace } from '../api/types';
import { basename } from './pathBasename';
import { workspaceRootKey } from './rootKey';

export interface MergeWorkspacesInput {
  workspaces: AppWorkspace[];
  sessions: Pick<AppSession, 'id' | 'cwd' | 'workspaceId' | 'hostId'>[];
  hiddenWorkspaceIds: string[];
  sessionsHasMoreByWorkspace: Record<string, boolean>;
}

export function mergeWorkspaces(input: MergeWorkspacesInput): AppWorkspace[] {
  const {
    workspaces,
    sessions,
    hiddenWorkspaceIds,
    sessionsHasMoreByWorkspace,
  } = input;

  const hidden = new Set(hiddenWorkspaceIds);
  const idByRootKey = new Map<string, string>();
  for (const w of workspaces) {
    const key = workspaceRootKey(w.root);
    if (!idByRootKey.has(key)) idByRootKey.set(key, w.id);
  }
  const bucketIdFor = (s: Pick<AppSession, 'cwd' | 'workspaceId'>): string =>
    s.workspaceId ?? idByRootKey.get(workspaceRootKey(s.cwd)) ?? s.cwd;

  const byId = new Map<string, AppWorkspace>();
  for (const w of workspaces) {
    if (hidden.has(w.id)) continue;
    if (!byId.has(w.id)) byId.set(w.id, { ...w });
  }
  for (const s of sessions) {
    if (!s.cwd) continue;
    const wid = bucketIdFor(s);
    if (hidden.has(wid)) continue;
    if (!byId.has(wid)) {
      byId.set(wid, {
        id: wid,
        hostId: s.hostId,
        root: s.cwd,
        name: basename(s.cwd),
        kind: 'implicit',
        additionalDirs: [],
        sessionCount: 0,
      });
    }
  }

  const counts = new Map<string, number>();
  for (const s of sessions) {
    const wid = bucketIdFor(s);
    counts.set(wid, (counts.get(wid) ?? 0) + 1);
  }

  const realIds = new Set<string>();
  for (const w of workspaces) {
    if (!hidden.has(w.id)) realIds.add(w.id);
  }
  const derivedIds = [...byId.keys()].filter((id) => !realIds.has(id));
  derivedIds.sort((a, b) => byId.get(a)!.root.localeCompare(byId.get(b)!.root));

  const result: AppWorkspace[] = [];
  for (const id of [...realIds, ...derivedIds]) {
    const w = byId.get(id)!;
    const localCount = counts.get(w.id) ?? 0;
    const count =
      sessionsHasMoreByWorkspace[w.id] === false
        ? localCount
        : Math.max(w.sessionCount, localCount);
    if (w.kind === 'implicit' && count === 0) continue;
    result.push({ ...w, sessionCount: count });
  }
  return result;
}
