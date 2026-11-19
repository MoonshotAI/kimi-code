import { isAbsolute, join } from 'pathe';

import { canonicalWorkspaceRoot } from '#/_base/utils/paths';

import { encodeWorkDirKey, isWorkDirKey, workspaceRootKey } from '#/_base/utils/workdir-slug';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { Project } from '#/app/project/project';

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
  | { readonly kind: 'entry'; readonly record: unknown; readonly entry: SessionIndexLine }
  | { readonly kind: 'deleted'; readonly record: unknown; readonly sessionId: string }
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
  if ('sessionId' in parsed && typeof parsed.sessionId === 'string') {
    if ('deleted' in parsed && parsed.deleted === true) {
      return { kind: 'deleted', record: parsed, sessionId: parsed.sessionId };
    }
    if ('sessionDir' in parsed && typeof parsed.sessionDir === 'string') {
      const location = 'workDir' in parsed ? parsed.workDir : 'cwd' in parsed ? parsed.cwd : undefined;
      if (typeof location === 'string') {
        const entry = { sessionId: parsed.sessionId, sessionDir: parsed.sessionDir, workDir: location };
        return { kind: 'entry', record: parsed, entry };
      }
    }
  }
  return { kind: 'other', record: parsed };
}

function classifySessionIndexLines(
  bytes: Uint8Array,
  storage: IFileSystemStorageService,
  sessionsScope = 'sessions',
): ClassifiedSessionIndexLine[] {
  const sessionsRoot = storage.pathFor(sessionsScope, '');
  const lines: ClassifiedSessionIndexLine[] = [];
  for (const raw of textDecoder.decode(bytes).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const line = classifySessionIndexLine(trimmed);
    if (line.kind !== 'entry') {
      lines.push(line);
      continue;
    }
    const sessionDir = resolveSessionDir(line.entry, sessionsScope, sessionsRoot);
    lines.push(sessionDir === undefined
      ? { kind: 'other', record: line.record }
      : { ...line, entry: { ...line.entry, sessionDir } });
  }
  return lines;
}

function resolveSessionDir(entry: SessionIndexLine, scope: string, root: string | undefined): string | undefined {
  const bucket = sessionIndexBucket(entry);
  if (!bucket || !entry.sessionId || entry.sessionId === '.' || entry.sessionId === '..') return undefined;
  const relative = join(scope, bucket, entry.sessionId);
  const path = root === undefined ? entry.sessionDir : join(root, bucket, entry.sessionId);
  const expected = isAbsolute(entry.sessionDir) ? path : relative;
  return canonicalWorkspaceRoot(entry.sessionDir) === canonicalWorkspaceRoot(expected) ? path : undefined;
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
  if (initial === undefined || deps.storage.pathFor('sessions', '') === undefined) return undefined;
  const survey = classifySessionIndexLines(initial, deps.storage);
  const entryDirs: string[] = [];
  for (const line of survey) {
    if (line.kind === 'entry') entryDirs.push(line.entry.sessionDir);
  }
  if (entryDirs.length === 0) return undefined;
  const staleDirs = await findStaleSessionDirs(entryDirs, deps.sessionDirExists);
  const staleLines = survey.filter(
    (line) => line.kind === 'entry' && staleDirs.has(line.entry.sessionDir),
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
    const lines = classifySessionIndexLines(bytes, deps.storage);
    const records: unknown[] = [];
    let droppedStale = 0;
    let droppedGarbage = 0;
    for (const line of lines) {
      if (line.kind === 'garbage') {
        droppedGarbage++;
        continue;
      }
      if (line.kind === 'entry' && staleDirs.has(line.entry.sessionDir)) {
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

export function sessionIndexBucket(line: SessionIndexLine): string | undefined {
  const segments = line.sessionDir.replaceAll('\\', '/').replace(/\/+$/, '').split('/');
  const bucket = segments.at(-2);
  return segments.at(-1) === line.sessionId && bucket !== '.' && bucket !== '..' ? bucket : undefined;
}

export function isImplicitBucketSessionLine(line: SessionIndexLine): boolean {
  const bucket = sessionIndexBucket(line);
  return bucket !== undefined && isWorkDirKey(bucket);
}

export function isOriginalImplicitLocation(line: SessionIndexLine): boolean {
  return isAbsolute(line.workDir) && sessionIndexBucket(line) === encodeWorkDirKey(line.workDir);
}

export function hasOriginalImplicitRoot(ws: Project): boolean {
  return ws.kind === 'implicit' && ws.id === encodeWorkDirKey(ws.root);
}

export function implicitRoots(workspaces: readonly Project[], entries: readonly SessionIndexLine[]): Map<string, string> {
  const roots = new Map<string, string>();
  for (const entry of entries) {
    if (isOriginalImplicitLocation(entry)) roots.set(encodeWorkDirKey(entry.workDir), entry.workDir);
  }
  for (const ws of workspaces) {
    if (hasOriginalImplicitRoot(ws)) roots.set(ws.id, ws.root);
    else if (ws.kind === 'managed') roots.delete(ws.id);
  }
  return roots;
}

export function collectAliasIds(
  workspaces: readonly Project[],
  entries: readonly SessionIndexLine[],
  root: string,
): string[] {
  const roots = implicitRoots(workspaces, entries);
  const key = workspaceRootKey(root);
  return [...roots].filter(([, original]) => workspaceRootKey(original) === key).map(([id]) => id);
}

export function dedupeByRoot(
  byId: ReadonlyMap<string, Project>,
  roots: ReadonlyMap<string, string> = implicitRoots([...byId.values()], []),
): Project[] {
  const byRoot = new Map<string, Project>();
  const rest: Project[] = [];
  for (const ws of byId.values()) {
    const original = roots.get(ws.id);
    if (original === undefined || !isWorkDirKey(ws.id)) {
      rest.push(ws);
      continue;
    }
    const key = workspaceRootKey(original);
    const existing = byRoot.get(key);
    if (existing === undefined || (existing.vcs === undefined &&
      (ws.vcs !== undefined || ws.id === encodeWorkDirKey(key)))) byRoot.set(key, ws);
  }
  return [...byRoot.values(), ...rest];
}

export async function readSessionIndexEntries(
  storage: IFileSystemStorageService,
  sessionsScope = 'sessions',
): Promise<SessionIndexLine[]> {
  const bytes = await storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
  if (bytes === undefined) return [];
  const entries: SessionIndexLine[] = [];
  const deleted = new Set<string>();
  const lines = classifySessionIndexLines(bytes, storage, sessionsScope);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.kind === 'deleted') deleted.add(line.sessionId);
    else if (line.kind === 'entry' && !deleted.has(line.entry.sessionId)) entries.push(line.entry);
  }
  return entries.toReversed();
}

export function parseSessionIndexLine(line: string): SessionIndexLine | undefined {
  const classified = classifySessionIndexLine(line);
  return classified.kind === 'entry' ? classified.entry : undefined;
}
