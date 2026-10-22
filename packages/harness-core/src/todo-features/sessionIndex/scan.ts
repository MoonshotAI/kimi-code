import { open, readdir, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
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

interface JournalFile {
  readonly path: string;
  readonly main: boolean;
}

interface JournalCommit {
  readonly seq: number;
  readonly time?: number;
  readonly rewind?: number;
  readonly events: readonly unknown[];
}

interface ActivityMark {
  readonly seq: number;
  readonly userText?: string;
  readonly turn?: SessionDirLastTurn;
}

interface JournalFileScan {
  readonly firstActivityMs?: number;
  readonly lastActivityMs?: number;
  readonly lastUserText?: string;
  readonly lastTurn?: SessionDirLastTurn;
}

export async function scanSessionDir(sessionDir: string): Promise<SessionDirScan> {
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserText: string | undefined;
  let lastTurn: SessionDirLastTurn | undefined;

  for (const file of await collectJournalFiles(sessionDir)) {
    const scan = await scanJournalFile(file);
    firstActivityMs = minDefined(firstActivityMs, scan.firstActivityMs);
    lastActivityMs = maxDefined(lastActivityMs, scan.lastActivityMs);
    if (scan.lastUserText !== undefined) lastUserText = scan.lastUserText;
    if (scan.lastTurn !== undefined) lastTurn = scan.lastTurn;
  }

  return { firstActivityMs, lastActivityMs, lastUserText, lastTurn };
}

async function collectJournalFiles(sessionDir: string): Promise<readonly JournalFile[]> {
  let entries;
  try {
    entries = await readdir(sessionDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => ({
      path: join(entry.parentPath, entry.name),
      main:
        entry.name === `${MAIN_AGENT_ID}.jsonl` &&
        entry.parentPath.replaceAll('\\', '/').endsWith('/agents'),
    }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

async function scanJournalFile(file: JournalFile): Promise<JournalFileScan> {
  let handle: FileHandle;
  try {
    handle = await open(file.path, 'r');
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return {};
  }

  let input: Readable | undefined;
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let marks: ActivityMark[] = [];

  try {
    input = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const commit = parseCommit(line);
      if (commit === undefined) continue;
      if (commit.time !== undefined) {
        firstActivityMs = minDefined(firstActivityMs, commit.time);
        lastActivityMs = maxDefined(lastActivityMs, commit.time);
      }
      if (!file.main) continue;
      const rewind = commit.rewind;
      if (rewind !== undefined) marks = marks.filter((mark) => mark.seq < rewind);
      commit.events.forEach((event, index) => {
        const seq = commit.seq + index;
        const userText = userMessageText(event);
        if (userText !== undefined) {
          marks.push({ seq, userText });
          return;
        }
        const turn = turnEnded(event);
        if (turn !== undefined) marks.push({ seq, turn });
      });
    }
  } finally {
    input?.destroy();
    if (input !== undefined) await finished(input, { cleanup: true }).catch(() => {});
    await handle.close();
  }

  return {
    firstActivityMs,
    lastActivityMs,
    lastUserText: marks.findLast((mark) => mark.userText !== undefined)?.userText,
    lastTurn: marks.findLast((mark) => mark.turn !== undefined)?.turn,
  };
}

function parseCommit(line: string): JournalCommit | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { seq, time, rewind, events } = value as {
    seq?: unknown;
    time?: unknown;
    rewind?: unknown;
    events?: unknown;
  };
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return undefined;
  return {
    seq,
    time: normalizeMs(time),
    rewind: typeof rewind === 'number' && Number.isFinite(rewind) ? rewind : undefined,
    events: Array.isArray(events) ? events : [],
  };
}

function userMessageText(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  if ((event as { type?: unknown }).type !== 'message.appended') return undefined;
  const { entry } = event as { entry?: unknown };
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { message } = entry as { message?: unknown };
  if (typeof message !== 'object' || message === null) return undefined;
  if ((message as { role?: unknown }).role !== 'user') return undefined;
  const { content } = message as { content?: unknown };
  if (!Array.isArray(content)) return undefined;
  let text = '';
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') text += typed.text;
  }
  return text.trim().length > 0 ? text : undefined;
}

function turnEnded(event: unknown): SessionDirLastTurn | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  if ((event as { type?: unknown }).type !== 'turn.ended') return undefined;
  const { turnId, outcome } = event as { turnId?: unknown; outcome?: unknown };
  if (typeof turnId !== 'number' || !Number.isFinite(turnId)) return undefined;
  const type = typeof outcome === 'object' && outcome !== null ? (outcome as { type?: unknown }).type : undefined;
  if (typeof type !== 'string') return undefined;
  return { turnId, outcome: type };
}

function normalizeMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
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
