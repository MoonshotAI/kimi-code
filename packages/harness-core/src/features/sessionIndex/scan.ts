import { open, readdir, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { join } from 'pathe';

export interface SessionDirLastTurn {
  readonly turnId: number;
  readonly outcome: string;
}

export interface SessionDirScan {
  readonly firstActivityMs?: number;
  readonly lastActivityMs?: number;
  readonly lastUserText?: string;
  readonly lastTurn?: SessionDirLastTurn;
}

export async function scanSessionDir(sessionDir: string): Promise<SessionDirScan> {
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserText: string | undefined;
  let lastUserTextMs = -1;
  let lastTurn: SessionDirLastTurn | undefined;
  let lastTurnMs = -1;

  for (const file of await collectJournalFiles(sessionDir)) {
    const scan = await scanJournalFile(file);
    firstActivityMs = minDefined(firstActivityMs, scan.firstActivityMs);
    lastActivityMs = maxDefined(lastActivityMs, scan.lastActivityMs);
    if (scan.lastUserText !== undefined && scan.lastUserTextMs >= lastUserTextMs) {
      lastUserText = scan.lastUserText;
      lastUserTextMs = scan.lastUserTextMs;
    }
    if (scan.lastTurn !== undefined && scan.lastTurnMs >= lastTurnMs) {
      lastTurn = scan.lastTurn;
      lastTurnMs = scan.lastTurnMs;
    }
  }

  return {
    ...(firstActivityMs !== undefined ? { firstActivityMs } : {}),
    ...(lastActivityMs !== undefined ? { lastActivityMs } : {}),
    ...(lastUserText !== undefined ? { lastUserText } : {}),
    ...(lastTurn !== undefined ? { lastTurn } : {}),
  };
}

interface JournalFileScan {
  readonly firstActivityMs?: number;
  readonly lastActivityMs?: number;
  readonly lastUserText?: string;
  readonly lastUserTextMs: number;
  readonly lastTurn?: SessionDirLastTurn;
  readonly lastTurnMs: number;
}

async function collectJournalFiles(sessionDir: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(join(sessionDir, 'trees'), { recursive: true, withFileTypes: true });
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted((a, b) => a.localeCompare(b));
}

async function scanJournalFile(path: string): Promise<JournalFileScan> {
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return { lastUserTextMs: -1, lastTurnMs: -1 };
  }

  let input: Readable | undefined;
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserText: string | undefined;
  let lastUserTextMs = -1;
  let lastTurn: SessionDirLastTurn | undefined;
  let lastTurnMs = -1;

  try {
    const size = (await file.stat()).size;
    input =
      size === 0
        ? Readable.from([])
        : file.createReadStream({ encoding: 'utf8', autoClose: false, end: size - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as { kind?: unknown; ts?: unknown; type?: unknown; payload?: unknown };
      if (record.kind !== 'entry') continue;
      const timeMs =
        typeof record.ts === 'number' ? normalizeTimestampMs(record.ts) : undefined;
      if (timeMs !== undefined) {
        firstActivityMs = minDefined(firstActivityMs, timeMs);
        lastActivityMs = maxDefined(lastActivityMs, timeMs);
      }
      const data = entryData(record.payload);
      if (record.type === 'message.appended') {
        const text = userMessageText(data);
        if (text !== undefined && text.trim().length > 0 && timeMs !== undefined && timeMs >= lastUserTextMs) {
          lastUserText = text;
          lastUserTextMs = timeMs;
        }
        continue;
      }
      if (record.type === 'session.meta_updated') {
        const turn = lastTurnOf(data);
        if (turn !== undefined && timeMs !== undefined && timeMs >= lastTurnMs) {
          lastTurn = turn;
          lastTurnMs = timeMs;
        }
      }
    }
  } finally {
    input?.destroy();
    if (input !== undefined) await finished(input, { cleanup: true }).catch(() => {});
    await file.close();
  }

  return {
    ...(firstActivityMs !== undefined ? { firstActivityMs } : {}),
    ...(lastActivityMs !== undefined ? { lastActivityMs } : {}),
    ...(lastUserText !== undefined ? { lastUserText } : {}),
    lastUserTextMs,
    ...(lastTurn !== undefined ? { lastTurn } : {}),
    lastTurnMs,
  };
}

function entryData(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as { data?: unknown }).data;
}

function userMessageText(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const entry = (data as { message?: unknown }).message;
  if (typeof entry !== 'object' || entry === null) return undefined;
  const message = (entry as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return undefined;
  if ((message as { role?: unknown }).role !== 'user') return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  let text = '';
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') text += typed.text;
  }
  return text;
}

function lastTurnOf(data: unknown): SessionDirLastTurn | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const meta = (data as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const lastTurn = (meta as { lastTurn?: unknown }).lastTurn;
  if (typeof lastTurn !== 'object' || lastTurn === null) return undefined;
  const turnId = (lastTurn as { turnId?: unknown }).turnId;
  const outcome = (lastTurn as { outcome?: unknown }).outcome;
  if (typeof turnId !== 'number' || !Number.isFinite(turnId)) return undefined;
  if (typeof outcome !== 'string') return undefined;
  return { turnId, outcome };
}

function normalizeTimestampMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
