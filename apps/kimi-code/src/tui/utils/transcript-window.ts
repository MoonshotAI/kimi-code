/**
 * Sliding window for the TUI transcript.
 *
 * The transcript grows unbounded as the conversation goes on. To keep the TUI
 * responsive and bounded, we only keep the most recent N *turns* (a turn = a
 * user prompt plus everything the assistant does in response, identified by a
 * shared `turnId`), and destroy older turns wholesale (component + entry).
 *
 * All threshold logic here is pure so it can be unit-tested in isolation; the
 * constants are the production defaults passed in by the TUI.
 */

import type { TranscriptEntry } from '../types';

/**
 * Read a non-negative integer env var, falling back to `fallback` when it is
 * unset, empty, negative, or not an integer. `0` is a valid value (call sites
 * treat it as "feature disabled").
 */
export function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

/** Master switch for the sliding window. */
export const TRANSCRIPT_WINDOW_ENABLED = true;

/** Keep the most recent N turns. `0` disables trimming. */
export const TRANSCRIPT_MAX_TURNS = readEnvInt('KIMI_CODE_TUI_MAX_TURNS', 15);

/** Only the most recent E turns are allowed to expand (Ctrl+O). `0` disables expanding. */
export const TRANSCRIPT_EXPAND_TURNS = readEnvInt('KIMI_CODE_TUI_EXPAND_TURNS', 3);

/** Only trim once the window exceeds maxTurns by this much (avoids churn). */
export const TRANSCRIPT_HYSTERESIS = readEnvInt('KIMI_CODE_TUI_HYSTERESIS', 5);

/** Keep this many recent steps untouched inside a turn; older steps are merged into a summary. `0` disables merging. */
export const TRANSCRIPT_KEEP_RECENT_STEPS = readEnvInt('KIMI_CODE_TUI_KEEP_RECENT_STEPS', 30);

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
 * front and get trimmed first. Any undefined entries left at the tail (no
 * following turn) become their own turn.
 */
export function groupTurns(entries: readonly TranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | undefined;
  let pendingUndefined: TranscriptEntry[] = [];

  for (const entry of entries) {
    const turnId = entry.turnId;
    if (turnId === undefined) {
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

/**
 * Decide which entries to destroy so the remaining turns fit within
 * `maxTurns`. Returns an empty set when the turn count is within
 * `maxTurns + hysteresis`. Oldest turns are removed first; the most recent
 * turn is never removed (it is the active / just-finished turn).
 */
export function turnsToTrim(
  turns: readonly TranscriptTurn[],
  maxTurns: number,
  hysteresis: number,
): Set<TranscriptEntry> {
  const toRemove = new Set<TranscriptEntry>();

  if (turns.length <= maxTurns + hysteresis) return toRemove;

  let remaining = turns.length;
  // `turns.length - 1` keeps the most recent turn off-limits.
  for (let i = 0; i < turns.length - 1 && remaining > maxTurns; i++) {
    const turn = turns[i]!;
    for (const entry of turn.entries) toRemove.add(entry);
    remaining--;
  }
  return toRemove;
}
