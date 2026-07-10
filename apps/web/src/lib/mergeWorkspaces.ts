// apps/kimi-web/src/lib/mergeWorkspaces.ts
// Pure helper that merges registered (daemon) workspaces with workspaces
// DERIVED from the current sessions' cwds. Extracted from the
// `useKimiWebClient` composable so the merge is unit-testable without a Vue
// reactivity harness.

import type { AppSession, AppWorkspace } from '../api/types';
import { basename } from './pathBasename';

/** The workspace id a session belongs to: prefer the registered workspace whose
 *  root matches the session cwd; otherwise the daemon-provided workspaceId;
 *  otherwise the cwd itself (derived/fallback mode). */
function workspaceIdForSession(
  workspaces: AppWorkspace[],
  s: { workspaceId?: string; cwd: string },
): string {
  return workspaces.find((w) => w.root === s.cwd)?.id ?? s.workspaceId ?? s.cwd;
}

export interface MergeWorkspacesInput {
  /** Registered workspaces from the daemon (listWorkspaces). */
  workspaces: AppWorkspace[];
  /** Currently loaded sessions (only id/cwd/workspaceId are read). */
  sessions: Pick<AppSession, 'id' | 'cwd' | 'workspaceId'>[];
  /** Root paths the user removed from the sidebar. */
  hiddenWorkspaceRoots: string[];
  /** cwd of the active session, used to hint the branch on the active workspace. */
  activeRoot: string | undefined;
  /** Live git branch of the active session, or null when unknown. */
  activeBranch: string | null;
  /** Per-workspace "server has more sessions" flag; false means the local
   *  session count is exact. */
  sessionsHasMoreByWorkspace: Record<string, boolean>;
}

/**
 * Merge real (daemon) workspaces with workspaces DERIVED from the current
 * sessions' cwds. Each distinct cwd with no matching real workspace becomes one
 * derived workspace (id = root = cwd). Real workspaces win on root.
 */
export function mergeWorkspaces(input: MergeWorkspacesInput): AppWorkspace[] {
  const {
    workspaces,
    sessions,
    hiddenWorkspaceRoots,
    activeRoot,
    activeBranch,
    sessionsHasMoreByWorkspace,
  } = input;

  const hidden = new Set(hiddenWorkspaceRoots);
  const byRoot = new Map<string, AppWorkspace>();
  // Real workspaces win on root (unless the user removed them from the sidebar).
  // Keep the FIRST entry per root: the daemon orders by last_opened_at desc, so
  // the most recently opened (typically the canonical re-add) comes first. This
  // must match `workspaceIdForSession` / the sidebar's first-match session
  // assignment — if byRoot kept a different id than sessions are counted and
  // grouped under, the only rendered workspace would look empty.
  for (const w of workspaces) {
    if (hidden.has(w.root)) continue;
    if (!byRoot.has(w.root)) byRoot.set(w.root, { ...w });
  }
  // Derive from sessions for any cwd without a real workspace.
  for (const s of sessions) {
    const root = s.cwd;
    if (!root) continue;
    if (hidden.has(root)) continue; // removed from the sidebar — keep it hidden
    if (!byRoot.has(root)) {
      byRoot.set(root, {
        // Use the session's REAL daemon workspace_id (wd_<slug>_<hash>) so
        // createSession({ workspaceId }) is accepted; fall back to cwd only
        // when the daemon hasn't tagged the session yet.
        id: s.workspaceId ?? root,
        root,
        name: basename(root),
        isGitRepo: false,
        sessionCount: 0,
      });
    }
  }
  // Compute live session counts.
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const wid = workspaceIdForSession(workspaces, s);
    counts.set(wid, (counts.get(wid) ?? 0) + 1);
  }

  // Order: real workspaces in listWorkspaces order, then derived workspaces
  // sorted by root path so the order is stable (not tied to session activity).
  // Hidden roots must be excluded here too — `byRoot` skips them, so a hidden
  // real workspace would otherwise make `byRoot.get(root)` return undefined.
  //
  // Dedup by root: the registry can legitimately hold two entries for the same
  // folder (e.g. a legacy id from an older encodeWorkDirKey plus the current
  // one). `byRoot` already collapses them, but a duplicated root in the
  // ordering list would render the same workspace twice — and because both
  // copies share an id, selecting one would highlight both.
  const realRoots = [...new Set(workspaces.filter((w) => !hidden.has(w.root)).map((w) => w.root))];
  const derivedRoots = [...byRoot.keys()].filter((r) => !realRoots.includes(r));
  derivedRoots.sort((a, b) => a.localeCompare(b));

  const result: AppWorkspace[] = [];
  for (const root of [...realRoots, ...derivedRoots]) {
    const w = byRoot.get(root)!;
    // When a workspace's sessions are fully loaded (hasMore === false), the
    // local count is exact — prefer it so archiving the last session drops the
    // count to 0 immediately. While pages remain, the local count is only a
    // lower bound, so keep the daemon session_count as a floor.
    const localCount = counts.get(w.id) ?? counts.get(w.root) ?? 0;
    const count =
      sessionsHasMoreByWorkspace[w.id] === false
        ? localCount
        : Math.max(w.sessionCount, localCount);
    let branch = w.branch;
    if (!branch && activeBranch && activeRoot === w.root) branch = activeBranch;
    result.push({ ...w, sessionCount: count, branch });
  }
  return result;
}
