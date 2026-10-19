import { isAbsolute } from 'pathe';

import { encodeWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { Workspace } from './workspace';

export const SESSION_INDEX_SCOPE = '';
export const SESSION_INDEX_KEY = 'session_index.jsonl';

export const SESSION_INDEX_COMPACTION_MIN_STALE = 16;
export const SESSION_INDEX_COMPACTION_MIN_STALE_RATIO = 0.2;

const SESSION_INDEX_COMPACTION_MAX_ATTEMPTS = 3;
const SESSION_INDEX_STAT_CONCURRENCY = 64;

const textDecoder = new TextDecoder();

export interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export interface SessionIndexCompactionDeps {
  readonly storage: IFileSystemStorageService;
  readonly appendLogs: Pick<IAppendLogStore, 'flushLog' | 'rewrite'>;
  readonly sessionDirExists: (sessionDir: string) => Promise<boolean>;
}

export interface SessionIndexCompactionOutcome {
  readonly lines: number;
  readonly kept: number;
  readonly droppedStale: number;
  readonly droppedGarbage: number;
}

type ClassifiedSessionIndexLine =
  | { readonly kind: 'entry'; readonly record: unknown; readonly sessionDir: string }
  | { readonly kind: 'other'; readonly record: unknown }
  | { readonly kind: 'garbage' };

function classifySessionIndexLine(line: string): ClassifiedSessionIndexLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'garbage' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'other', record: parsed };
  const entry = parsed as Partial<SessionIndexLine>;
  if (
    typeof entry.sessionId === 'string' &&
    typeof entry.sessionDir === 'string' &&
    typeof entry.workDir === 'string'
  ) {
    return { kind: 'entry', record: parsed, sessionDir: entry.sessionDir };
  }
  return { kind: 'other', record: parsed };
}

function classifySessionIndexLines(bytes: Uint8Array): ClassifiedSessionIndexLine[] {
  const lines: ClassifiedSessionIndexLine[] = [];
  for (const raw of textDecoder.decode(bytes).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    lines.push(classifySessionIndexLine(trimmed));
  }
  return lines;
}

async function findStaleSessionDirs(
  dirs: readonly string[],
  sessionDirExists: (sessionDir: string) => Promise<boolean>,
): Promise<Set<string>> {
  const unique = [...new Set(dirs)];
  const stale = new Set<string>();
  for (let start = 0; start < unique.length; start += SESSION_INDEX_STAT_CONCURRENCY) {
    const batch = unique.slice(start, start + SESSION_INDEX_STAT_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (dir) => ((await sessionDirExists(dir)) ? undefined : dir)),
    );
    for (const dir of results) {
      if (dir !== undefined) stale.add(dir);
    }
  }
  return stale;
}

export async function compactSessionIndexIfStale(
  deps: SessionIndexCompactionDeps,
): Promise<SessionIndexCompactionOutcome | undefined> {
  const initial = await deps.storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
  if (initial === undefined) return undefined;
  const survey = classifySessionIndexLines(initial);
  const entryDirs: string[] = [];
  for (const line of survey) {
    if (line.kind === 'entry') entryDirs.push(line.sessionDir);
  }
  if (entryDirs.length === 0) return undefined;
  const staleDirs = await findStaleSessionDirs(entryDirs, deps.sessionDirExists);
  const staleLines = survey.filter(
    (line) => line.kind === 'entry' && staleDirs.has(line.sessionDir),
  ).length;
  if (
    staleLines < SESSION_INDEX_COMPACTION_MIN_STALE ||
    staleLines / survey.length < SESSION_INDEX_COMPACTION_MIN_STALE_RATIO
  ) {
    return undefined;
  }
  for (let attempt = 0; attempt < SESSION_INDEX_COMPACTION_MAX_ATTEMPTS; attempt++) {
    await deps.appendLogs.flushLog(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
    const bytes = await deps.storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
    if (bytes === undefined) return undefined;
    const size = await deps.storage.size(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
    if (size !== bytes.length) continue;
    const lines = classifySessionIndexLines(bytes);
    const records: unknown[] = [];
    let droppedStale = 0;
    let droppedGarbage = 0;
    for (const line of lines) {
      if (line.kind === 'garbage') {
        droppedGarbage++;
        continue;
      }
      if (line.kind === 'entry' && staleDirs.has(line.sessionDir)) {
        droppedStale++;
        continue;
      }
      records.push(line.record);
    }
    let rewriteError: Error | undefined;
    await deps.appendLogs.rewrite(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY, records, {
      onError: (error) => {
        rewriteError = error instanceof Error ? error : new Error(String(error));
      },
    });
    if (rewriteError !== undefined) throw rewriteError;
    return { lines: lines.length, kept: records.length, droppedStale, droppedGarbage };
  }
  return undefined;
}

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
  for (const line of sessionIndexEntries) {
    if (workspaceRootKey(line.workDir) === rootKey) add(encodeWorkDirKey(line.workDir));
  }
  return ids;
}

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
