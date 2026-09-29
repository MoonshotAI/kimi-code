import { open, readdir, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { join } from 'pathe';

export interface SessionJournalScan {
  readonly firstActivityMs?: number;
  readonly lastActivityMs?: number;
  readonly lastUserMessageMs?: number;
  readonly firstUserInput?: string;
}

export async function scanSessionJournal(
  sessionDir: string,
  signal?: AbortSignal,
): Promise<SessionJournalScan> {
  signal?.throwIfAborted();
  const journalFiles = await collectJournalFiles(sessionDir);
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserMessageMs: number | undefined;
  let firstUserInput: string | undefined;

  for (const file of journalFiles) {
    signal?.throwIfAborted();
    const scan = await scanJournalFile(file, signal);
    firstActivityMs = minDefined(firstActivityMs, scan.firstActivityMs);
    lastActivityMs = maxDefined(lastActivityMs, scan.lastActivityMs);
    lastUserMessageMs = maxDefined(lastUserMessageMs, scan.lastUserMessageMs);
    firstUserInput ??= scan.firstUserInput;
  }

  return {
    firstActivityMs,
    lastActivityMs,
    lastUserMessageMs,
    firstUserInput,
  };
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

async function scanJournalFile(path: string, signal?: AbortSignal): Promise<SessionJournalScan> {
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return {};
  }

  let input: Readable | undefined;

  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserMessageMs: number | undefined;
  let firstUserInput: string | undefined;

  try {
    signal?.throwIfAborted();
    const size = (await file.stat()).size;
    signal?.throwIfAborted();
    input =
      size === 0
        ? Readable.from([])
        : file.createReadStream({
            encoding: 'utf8',
            autoClose: false,
            end: size - 1,
            signal,
          });
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
      const record = parsed as {
        kind?: unknown;
        ts?: unknown;
        type?: unknown;
        payload?: unknown;
      };
      if (record.kind !== 'entry') continue;
      const timeMs =
        typeof record.ts === 'number' ? normalizeTimestampMs(record.ts) : undefined;
      if (timeMs !== undefined) {
        firstActivityMs = minDefined(firstActivityMs, timeMs);
        lastActivityMs = maxDefined(lastActivityMs, timeMs);
      }
      if (record.type !== 'message.appended') continue;
      const text = userMessageText(record.payload);
      if (text === undefined) continue;
      if (timeMs !== undefined) {
        lastUserMessageMs = maxDefined(lastUserMessageMs, timeMs);
      }
      if (firstUserInput === undefined && text.trim().length > 0) {
        firstUserInput = text;
      }
    }
  } finally {
    input?.destroy();
    if (input !== undefined) await finished(input, { cleanup: true }).catch(() => {});
    await file.close();
  }

  return {
    firstActivityMs,
    lastActivityMs,
    lastUserMessageMs,
    firstUserInput,
  };
}

function userMessageText(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const data = (payload as { data?: unknown }).data;
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

export function normalizeTimestampMs(value: number): number | undefined {
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
