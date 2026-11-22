import type { TranscriptEntry } from '../types';

export function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

export const TRANSCRIPT_WINDOW_ENABLED = true;

export const TRANSCRIPT_MAX_TURNS = readEnvInt('KIMI_CODE_TUI_MAX_TURNS', 15);

export const TRANSCRIPT_EXPAND_TURNS = readEnvInt('KIMI_CODE_TUI_EXPAND_TURNS', 3);

export const TRANSCRIPT_HYSTERESIS = readEnvInt('KIMI_CODE_TUI_HYSTERESIS', 5);

export const TRANSCRIPT_KEEP_RECENT_STEPS = readEnvInt('KIMI_CODE_TUI_KEEP_RECENT_STEPS', 30);

export const TRANSCRIPT_KEEP_RECENT_ASSISTANT = readEnvInt('KIMI_CODE_TUI_KEEP_RECENT_ASSISTANT', 20);

export const TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED = readEnvInt(
  'KIMI_CODE_TUI_KEEP_RECENT_ASSISTANT_COMPLETED',
  2,
);

export interface TranscriptTurn {
  readonly turnId: string | undefined;
  readonly entries: TranscriptEntry[];
}

/**
 * Group consecutive entries into turns by `turnId`. Entries with the same
 * non-undefined `turnId` that are adjacent belong to the same turn.
 *
 * Entries with an undefined `turnId` are buffered and attached to the *next*
 * defined turn. This matters because a user message is appended (with
 * `turnId: undefined`) before its turn actually starts, so without this
 * buffering every user message would become its own single-entry turn at the
 * front and get trimmed first. A buffered run is flushed into its own turn
 * when the next user entry arrives: `!` shell echoes are user entries too,
 * but no defined turn ever follows them, so each one starts a fresh group.
 * Any undefined entries left at the tail (no following turn) become their
 * own turn.
 */
export function groupTurns(entries: readonly TranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | undefined;
  let pendingUndefined: TranscriptEntry[] = [];

  for (const entry of entries) {
    const turnId = entry.turnId;
    if (turnId === undefined) {
      // A `!` shell echo is a user entry with no turnId, and no defined turn
      // ever follows it. Flush the buffered entries at each one so a
      // `!`-heavy stretch becomes many small trimmable turns instead of a
      // single tail turn that turnsToTrim can never touch.
      if (entry.kind === 'user' && pendingUndefined.length > 0) {
        turns.push({ turnId: undefined, entries: pendingUndefined });
        pendingUndefined = [];
      }
      pendingUndefined.push(entry);
      continue;
    }
    if (current !== undefined && current.turnId === turnId) {
      current.entries.push(entry);
    } else {
      current = { turnId, entries: [...pendingUndefined, entry] };
      pendingUndefined = [];
      turns.push(current);
    }
  }

  if (pendingUndefined.length > 0) {
    turns.push({ turnId: undefined, entries: pendingUndefined });
  }

  return turns;
}

export function turnsToTrim(
  turns: readonly TranscriptTurn[],
  maxTurns: number,
  hysteresis: number,
): Set<TranscriptEntry> {
  const toRemove = new Set<TranscriptEntry>();

  if (turns.length <= maxTurns + hysteresis) return toRemove;

  let remaining = turns.length;
  for (let i = 0; i < turns.length - 1 && remaining > maxTurns; i++) {
    const turn = turns[i]!;
    for (const entry of turn.entries) toRemove.add(entry);
    remaining--;
  }
  return toRemove;
}

export function expandCutoffIndex(
  childCount: number,
  boundaries: readonly number[],
  expandTurns: number,
): number {
  if (expandTurns <= 0) return childCount;
  return boundaries.length > expandTurns ? boundaries[boundaries.length - expandTurns]! : 0;
}
