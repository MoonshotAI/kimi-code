/**
 * `workspace` domain (L2) — alias-folding pure helpers.
 *
 * One physical folder can arrive under several id spellings (Windows
 * drive-letter casing, slash direction, typed-vs-realpath variants, legacy
 * `encodeWorkDirKey` outputs). These helpers enumerate or collapse those
 * spellings without owning any state: `collectAliasIds` expands one root to
 * every id that addresses it, `dedupeByRoot` collapses a catalog to one
 * representative per directory, and the session-index readers parse the
 * legacy v1 `session_index.jsonl`. Shared by `WorkspaceService` (delete and
 * list) and `WorkspaceAliasesService` (`resolveAliasIds`).
 */

import { isAbsolute } from 'pathe';

import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { Workspace } from './workspace';

// Legacy v1 session index, read for the one-shot rebuild and for alias
// folding (session-index-only id spellings). Empty scope resolves to
// `<homeDir>/<key>` (join skips empty segments).
export const SESSION_INDEX_SCOPE = '';
export const SESSION_INDEX_KEY = 'session_index.jsonl';

const textDecoder = new TextDecoder();

export interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

/**
 * Every id identifying `root`'s directory: all registered spellings plus
 * `workDir` spellings recorded only in `session_index.jsonl` (legacy split
 * buckets that were never registered). Read-only — ids/buckets are never
 * rewritten.
 */
export function collectAliasIds(
  workspaces: readonly Workspace[],
  sessionIndexEntries: readonly SessionIndexLine[],
  root: string,
): string[] {
  const rootKey = workspaceRootKey(root);
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (alias: string): void => {
    if (seen.has(alias)) return;
    seen.add(alias);
    ids.push(alias);
  };
  for (const ws of workspaces) {
    if (workspaceRootKey(ws.root) === rootKey) add(ws.id);
  }
  // Legacy split buckets may exist under spellings never registered: fold in
  // every session-index `workDir` that identifies the same directory.
  for (const line of sessionIndexEntries) {
    if (workspaceRootKey(line.workDir) === rootKey) add(encodeWorkDirKey(line.workDir));
  }
  return ids;
}

/**
 * Collapse registered workspaces that identify the same directory. The
 * persisted catalog (v1-compatible `workspaces.json`) can hold legacy entries
 * whose id was computed by an older `encodeWorkDirKey` (e.g. realpath-based on
 * Windows) for the same folder, and Windows roots additionally differ by
 * casing or slash spelling, so one directory may map to multiple ids. Entries
 * merge on the `workspaceRootKey` identity key; prefer the entry whose id
 * matches the canonical key computed on its own root string so current
 * sessions' `workspace_id` still resolves and the same folder is not listed
 * twice.
 */
export function dedupeByRoot(byId: ReadonlyMap<string, Workspace>): Workspace[] {
  const byRoot = new Map<string, Workspace>();
  for (const ws of byId.values()) {
    const rootKey = workspaceRootKey(ws.root);
    const existing = byRoot.get(rootKey);
    if (existing === undefined) {
      byRoot.set(rootKey, ws);
      continue;
    }
    const canonicalId = encodeWorkDirKey(ws.root);
    if (existing.id !== canonicalId && ws.id === canonicalId) {
      byRoot.set(rootKey, ws);
    }
  }
  return [...byRoot.values()];
}

/**
 * Parse the legacy v1 session index. Blank and malformed lines are skipped
 * individually so one bad record never fails the whole file (matches the
 * rebuild's tolerance).
 */
export async function readSessionIndexEntries(
  storage: IFileSystemStorageService,
): Promise<SessionIndexLine[]> {
  const bytes = await storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
  if (bytes === undefined) return [];
  const entries: SessionIndexLine[] = [];
  for (const line of textDecoder.decode(bytes).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const entry = parseSessionIndexLine(trimmed);
    if (entry === undefined) continue;
    entries.push(entry);
  }
  return entries;
}

export async function readSessionIndexWorkDirs(
  storage: IFileSystemStorageService,
): Promise<readonly string[]> {
  const workDirs: string[] = [];
  for (const entry of await readSessionIndexEntries(storage)) {
    if (!isAbsolute(entry.workDir)) continue;
    workDirs.push(entry.workDir);
  }
  return workDirs;
}

export function parseSessionIndexLine(line: string): SessionIndexLine | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexLine>;
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
