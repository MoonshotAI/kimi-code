/**
 * `sessionExport` domain (L6) — persisted wire activity scanner.
 *
 * Reads both legacy root `wire.jsonl` logs and v2 per-agent
 * `agents/<agentId>/wire.jsonl` logs to derive activity timestamps for the
 * export manifest without depending on live Agent services.
 */

import { open, readdir, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { join } from 'pathe';

const WIRE_FILENAME = 'wire.jsonl';

export interface SessionWireScan {
  readonly firstActivityMs?: number | undefined;
  readonly lastActivityMs?: number | undefined;
  readonly lastUserMessageMs?: number | undefined;
  readonly firstUserInput?: string | undefined;
}

export async function scanSessionWire(
  sessionDir: string,
  signal?: AbortSignal,
): Promise<SessionWireScan> {
  signal?.throwIfAborted();
  const wireFiles = await collectWireFiles(sessionDir, signal);
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserMessageMs: number | undefined;
  let firstUserInput: string | undefined;

  for (const file of wireFiles) {
    signal?.throwIfAborted();
    const scan = await scanWireFile(file, signal);
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

async function collectWireFiles(
  sessionDir: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const files = [join(sessionDir, WIRE_FILENAME)];
  const agentsDir = join(sessionDir, 'agents');
  try {
    const entries = await readdir(agentsDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isFile() || entry.name !== WIRE_FILENAME) continue;
      files.push(join(entry.parentPath, entry.name));
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return files;
}

async function scanWireFile(path: string, signal?: AbortSignal): Promise<SessionWireScan> {
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
        type?: unknown;
        time?: unknown;
        userInput?: unknown;
      };
      const timeMs =
        typeof record.time === 'number' ? normalizeTimestampMs(record.time) : undefined;
      if (timeMs !== undefined) {
        firstActivityMs = minDefined(firstActivityMs, timeMs);
        lastActivityMs = maxDefined(lastActivityMs, timeMs);
      }
      if (record.type === 'turn_begin') {
        if (timeMs !== undefined) {
          lastUserMessageMs = maxDefined(lastUserMessageMs, timeMs);
        }
        if (
          firstUserInput === undefined &&
          typeof record.userInput === 'string' &&
          record.userInput.trim().length > 0
        ) {
          firstUserInput = record.userInput;
        }
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
