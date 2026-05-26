import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe';

export interface SessionIndexEntry {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export function sessionIndexPath(homeDir: string): string {
  return join(homeDir, 'session_index.jsonl');
}

export async function appendSessionIndexEntry(
  homeDir: string,
  entry: SessionIndexEntry,
): Promise<void> {
  const indexPath = sessionIndexPath(homeDir);
  await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
  await appendFile(indexPath, `${JSON.stringify(entry)}\n`, 'utf-8');
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
    const entry = parseIndexLine(trimmed);
    if (entry === undefined) continue;
    const sessionDir = resolve(entry.sessionDir);
    if (!isAbsolute(entry.sessionDir)) continue;
    if (!isAbsolute(entry.workDir)) continue;
    if (!isPathInside(sessionsDir, sessionDir)) continue;
    if (basename(sessionDir) !== entry.sessionId) continue;
    result.set(entry.sessionId, {
      sessionId: entry.sessionId,
      sessionDir,
      workDir: resolve(entry.workDir),
    });
  }
  return result;
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
