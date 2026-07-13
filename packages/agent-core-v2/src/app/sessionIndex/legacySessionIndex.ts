/**
 * `sessionIndex` domain (L2) — v1 legacy session index file format.
 *
 * Single definition of the byte format of `<homeDir>/session_index.jsonl`,
 * shared by the v2 writer (`sessionLifecycle` appends one line per
 * create/fork) and the v2 readers (`FileSessionIndex` point lookups,
 * `workspaceRegistry` one-shot rebuild). The file is a v1 interop artifact:
 * v2's own source of truth is the `<sessionsDir>/<workspaceId>/<sessionId>/`
 * directory tree; this file exists so a v1 CLI sharing the same homeDir can
 * discover v2-created sessions, and so v2 can locate sessions the v1 way.
 *
 * Format (identical to v1 `packages/agent-core/src/session/store/session-index.ts`):
 * append-only JSONL, one `{sessionId, sessionDir, workDir}` object per line;
 * later lines override earlier ones for the same sessionId; `workDir` is
 * informational only and never authoritative on read.
 */

import { basename, dirname, isAbsolute, relative, resolve } from 'pathe';

/** Scope of the legacy index file: the homeDir root (join skips empty segments). */
export const LEGACY_SESSION_INDEX_SCOPE = '';
export const LEGACY_SESSION_INDEX_KEY = 'session_index.jsonl';

export interface LegacySessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

/**
 * Tolerantly parse one index line. Returns `undefined` for blank-ish garbage,
 * non-JSON text, and entries with non-string fields — same acceptance as v1's
 * `parseIndexLine`, so a corrupt line never breaks a whole read.
 */
export function parseLegacySessionIndexLine(line: string): LegacySessionIndexEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<LegacySessionIndexEntry>;
    if (
      typeof entry.sessionId !== 'string' ||
      typeof entry.sessionDir !== 'string' ||
      typeof entry.workDir !== 'string'
    ) {
      return undefined;
    }
    return {
      sessionId: entry.sessionId,
      sessionDir: entry.sessionDir,
      workDir: entry.workDir,
    };
  } catch {
    return undefined;
  }
}

/**
 * Validate a parsed entry against v1's read-side rules and derive the
 * workspaceId from the sessionDir layout. Returns `undefined` for entries v1
 * would skip: a non-absolute `sessionDir`, one outside `sessionsDir`, or one
 * whose basename does not match `sessionId`. The workspaceId is the name of
 * the bucket directory the session lives in (`<sessionsDir>/<workspaceId>/<sessionId>`).
 */
export function validateLegacySessionIndexEntry(
  entry: LegacySessionIndexEntry,
  sessionsDir: string,
): { sessionDir: string; workspaceId: string } | undefined {
  if (!isAbsolute(entry.sessionDir)) return undefined;
  const sessionDir = resolve(entry.sessionDir);
  const rel = relative(resolve(sessionsDir), sessionDir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  if (basename(sessionDir) !== entry.sessionId) return undefined;
  return { sessionDir, workspaceId: basename(dirname(sessionDir)) };
}
