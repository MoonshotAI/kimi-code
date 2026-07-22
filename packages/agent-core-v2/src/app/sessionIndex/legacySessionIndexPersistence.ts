/**
 * `sessionIndex` domain (L2) — legacy v1 session-index persistence boundary.
 *
 * Owns the fixed storage address, UTF-8 physical-line framing, conservative
 * adjacent-container recovery, and schema projection. The exported names
 * preserve the existing package-root compatibility surface.
 */

import { isAbsolute } from 'pathe';

import type { IFileSystemStorageService } from '#/persistence/interface/storage';

export const SESSION_INDEX_SCOPE = '';
export const SESSION_INDEX_KEY = 'session_index.jsonl';
const textDecoder = new TextDecoder();

export interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

export async function readSessionIndexEntries(
  storage: IFileSystemStorageService,
): Promise<SessionIndexLine[]> {
  const bytes = await storage.read(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY);
  if (bytes === undefined) return [];
  const entries: SessionIndexLine[] = [];
  for (const physicalLine of textDecoder.decode(bytes).split(/\r?\n/)) {
    const line = physicalLine.trim();
    if (line === '') continue;
    for (const entry of parseRecords(line)) entries.push(entry);
  }
  return entries;
}

export async function readSessionIndexWorkDirs(
  storage: IFileSystemStorageService,
): Promise<readonly string[]> {
  const workDirs: string[] = [];
  for (const entry of await readSessionIndexEntries(storage)) {
    if (isAbsolute(entry.workDir)) workDirs.push(entry.workDir);
  }
  return workDirs;
}

export function parseSessionIndexLine(line: string): SessionIndexLine | undefined {
  try {
    return entryFromJson(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
}

function parseRecords(line: string): SessionIndexLine[] {
  const entry = parseSessionIndexLine(line);
  if (entry !== undefined) return [entry];

  const entries: SessionIndexLine[] = [];
  for (const candidate of scanJsonContainers(line)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch {
      break;
    }
    const candidateEntry = entryFromJson(parsed);
    if (candidateEntry !== undefined) entries.push(candidateEntry);
  }
  return entries;
}

function* scanJsonContainers(line: string): Iterable<string> {
  let offset = 0;
  while (offset < line.length) {
    while (offset < line.length && isJsonWhitespace(line[offset]!)) offset++;
    if (offset >= line.length) return;
    const opener = line[offset]!;
    if (opener !== '{' && opener !== '[') return;

    const start = offset;
    const closers = [opener === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    let completed = false;
    for (let cursor = offset + 1; cursor < line.length; cursor++) {
      const char = line[cursor]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') closers.push('}');
      else if (char === '[') closers.push(']');
      else if (char === '}' || char === ']') {
        if (closers.at(-1) !== char) return;
        closers.pop();
      }
      if (closers.length === 0) {
        yield line.slice(start, cursor + 1);
        offset = cursor + 1;
        completed = true;
        break;
      }
    }
    if (!completed) return;
  }
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function entryFromJson(parsed: unknown): SessionIndexLine | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const entry = parsed as Record<string, unknown>;
  if (
    typeof entry['sessionId'] !== 'string' ||
    typeof entry['sessionDir'] !== 'string' ||
    typeof entry['workDir'] !== 'string'
  ) {
    return undefined;
  }
  return {
    sessionId: entry['sessionId'],
    sessionDir: entry['sessionDir'],
    workDir: entry['workDir'],
  };
}
