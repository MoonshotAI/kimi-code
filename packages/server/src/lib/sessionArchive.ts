import { readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { SessionNotFoundError } from '@moonshot-ai/agent-core';

/**
 * Temporary server-side session restore.
 *
 * TODO: remove once `@moonshot-ai/agent-core` exposes `ISessionService.restore`
 * natively. At that point the `:restore` route should delegate to the service
 * instead of rewriting `state.json` here.
 *
 * Archive is a boolean flag (`archived`) persisted in each session's
 * `<sessionDir>/state.json`. agent-core's `SessionStore` can set it to `true`
 * (`archive`) but has no inverse; while agent-core is being refactored we flip
 * it back from the server by:
 *   1. reading `<homeDir>/session_index.jsonl` to resolve `sessionId -> sessionDir`;
 *   2. validating the resolved dir is inside `<homeDir>/sessions` (defense
 *      against a tampered index);
 *   3. read-modify-write `state.json` with `archived: false`.
 *
 * This mirrors `SessionStore.archive` and publishes no event (same as archive).
 * The query read-model rebuilds from the store on every call, so a restored
 * session shows up in subsequent lists with no extra invalidation.
 */

interface SessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export async function restoreArchivedSession(homeDir: string, sessionId: string): Promise<void> {
  const sessionDir = await findSessionDir(homeDir, sessionId);
  if (sessionDir === undefined) {
    throw new SessionNotFoundError(sessionId);
  }

  const statePath = join(sessionDir, 'state.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf-8')) as unknown;
  } catch {
    throw new SessionNotFoundError(sessionId);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionNotFoundError(sessionId);
  }

  const next: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
    archived: false,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

async function findSessionDir(homeDir: string, sessionId: string): Promise<string | undefined> {
  const indexPath = join(homeDir, 'session_index.jsonl');
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf-8');
  } catch {
    return undefined;
  }

  const sessionsDir = join(homeDir, 'sessions');
  let found: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const entry = parseIndexLine(trimmed);
    if (entry === undefined || entry.sessionId !== sessionId) continue;
    const sessionDir = resolve(entry.sessionDir);
    if (!isAbsolute(entry.sessionDir)) continue;
    if (!isPathInside(sessionsDir, sessionDir)) continue;
    if (basename(sessionDir) !== entry.sessionId) continue;
    // Last valid line wins, matching `readSessionIndex`'s Map semantics.
    found = sessionDir;
  }
  return found;
}

function parseIndexLine(line: string): SessionIndexEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexEntry>;
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

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
