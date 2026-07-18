// apps/kimi-web/src/lib/acpSessions.ts
// ACP-session filtering helpers. Sessions created via the ACP adapter (bot
// clients driving kimi-code headlessly) carry `source: 'acp'` in their
// persisted custom metadata, forwarded onto the wire session's `metadata`.
// When the user preference is on, these sessions (and workspaces that contain
// nothing else) are hidden from the sidebar.

import type { AppSession } from '../api/types';
import { workspaceRootKey } from './rootKey';

export function isAcpSession(session: AppSession): boolean {
  return session.source === 'acp';
}

/**
 * Folded root keys whose loaded sessions are ALL ACP-created (with at least
 * one such session). Keyed via `workspaceRootKey`, matching how
 * `mergeWorkspaces` applies `hiddenWorkspaceRoots`.
 *
 * Known limitation: sessions load paginated, so a mixed workspace whose
 * non-ACP sessions are all beyond the loaded pages is reported here until
 * those sessions load. Accepted — the preference toggle restores everything.
 */
export function acpOnlyWorkspaceRoots(sessions: AppSession[]): string[] {
  const stats = new Map<string, { acp: number; other: number }>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const key = workspaceRootKey(s.cwd);
    const entry = stats.get(key) ?? { acp: 0, other: 0 };
    if (isAcpSession(s)) entry.acp += 1;
    else entry.other += 1;
    stats.set(key, entry);
  }
  const roots: string[] = [];
  for (const [key, entry] of stats) {
    if (entry.acp > 0 && entry.other === 0) roots.push(key);
  }
  return roots;
}
