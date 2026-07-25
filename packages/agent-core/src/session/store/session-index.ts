import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';

import { normalizeWorkDir } from '#/session/store/workdir-key';

export interface SessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export interface SessionIndexDeletion {
  readonly sessionId: string;
  readonly deleted: true;
}

type SessionIndexRecord = SessionIndexEntry | SessionIndexDeletion;

// Per-homeDir append chain. Within one process, concurrent index appends are
// serialized so two lines can never be interleaved at the filesystem layer.
// Cross-process, a single short line written with O_APPEND is atomic on POSIX
// (well under PIPE_BUF), so this closes the realistic same-process tearing gap
// without taking a file lock. A failed append is reported to its caller but does
// not poison the chain for later appends.
const appendQueues = new Map<string, Promise<void>>();

export function sessionIndexPath(homeDir: string): string {
  return join(homeDir, 'session_index.jsonl');
}

export async function appendSessionIndexEntry(
  homeDir: string,
  entry: SessionIndexEntry,
): Promise<void> {
  return appendSessionIndexRecord(homeDir, entry);
}

export async function appendSessionIndexDeletion(
  homeDir: string,
  sessionId: string,
): Promise<void> {
  return appendSessionIndexRecord(homeDir, { sessionId, deleted: true });
}

async function appendSessionIndexRecord(
  homeDir: string,
  record: SessionIndexRecord,
): Promise<void> {
  const indexPath = sessionIndexPath(homeDir);
  const line = `${JSON.stringify(record)}\n`;
  const previous = appendQueues.get(homeDir) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
    await appendFile(indexPath, line, 'utf-8');
  });
  appendQueues.set(homeDir, next.then(() => undefined, () => undefined));
  return next;
}

export async function readSessionIndex(
  homeDir: string,
  sessionsDir: string,
): Promise<Map<string, SessionIndexEntry>> {
  let raw: string;
  try {
    raw = await readFile(sessionIndexPath(homeDir), 'utf-8');
  } catch {
    return new Map();
  }

  const result = new Map<string, SessionIndexEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = parseIndexLine(trimmed);
    if (record === undefined) continue;
    if ('deleted' in record) {
      result.delete(record.sessionId);
      continue;
    }
    const entry = record;
    const sessionDir = normalizeWorkDir(entry.sessionDir);
    if (!isAbsolute(entry.sessionDir)) continue;
    if (!isPathInside(sessionsDir, sessionDir)) continue;
    if (basename(sessionDir) !== entry.sessionId) continue;
    // `workDir` is no longer authoritative: summaries prefer the workDir stored
    // in each session's self-describing state.json, so a stale or relocated
    // index workDir must not drop an otherwise valid entry.
    result.set(entry.sessionId, {
      sessionId: entry.sessionId,
      sessionDir,
      workDir: entry.workDir,
    });
  }
  return result;
}

function parseIndexLine(line: string): SessionIndexRecord | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexEntry & SessionIndexDeletion>;
    if (typeof entry.sessionId !== 'string') return undefined;
    if (entry.deleted === true) {
      return { sessionId: entry.sessionId, deleted: true };
    }
    if (
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
  if (isWindowsAbsolutePath(parent) || isWindowsAbsolutePath(child)) {
    const rel = nodePath.win32.relative(
      nodePath.win32.resolve(parent),
      nodePath.win32.resolve(child),
    );
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${nodePath.win32.sep}`) && !nodePath.win32.isAbsolute(rel);
  }
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}
