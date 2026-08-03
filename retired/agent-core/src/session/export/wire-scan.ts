import { readFile } from 'node:fs/promises';
import { join } from 'pathe';

export interface SessionWireScan {
  readonly firstActivityMs?: number | undefined;
  readonly lastActivityMs?: number | undefined;
  readonly lastUserMessageMs?: number | undefined;
  readonly firstUserInput?: string | undefined;
}

export async function scanSessionWire(sessionDir: string): Promise<SessionWireScan> {
  let raw: string;
  try {
    raw = await readFile(join(sessionDir, 'wire.jsonl'), 'utf-8');
  } catch {
    return {};
  }

  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let lastUserMessageMs: number | undefined;
  let firstUserInput: string | undefined;

  for (const line of raw.split('\n')) {
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
    const timeMs = typeof record.time === 'number' ? normalizeTimestampMs(record.time) : undefined;
    if (timeMs !== undefined) {
      firstActivityMs ??= timeMs;
      lastActivityMs = timeMs;
    }
    if (record.type === 'turn_begin') {
      if (timeMs !== undefined) {
        lastUserMessageMs = timeMs;
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
