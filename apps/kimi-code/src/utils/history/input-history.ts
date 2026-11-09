/**
 * User input history persistence — JSONL file with `{"content": "..."}` per line.
 *
 * Semantics:
 * - One JSON object per line (`InputHistoryEntry { content }`)
 * - `content` is the raw input. Shell commands are stored with a leading `!`
 *   (e.g. `!ls -la`) so ↑ recall can distinguish them from prompts and restore
 *   bash mode; the `!` is stripped again when the entry is recalled. Plain
 *   prompts (and legacy entries without a leading `!`) are normal prompts.
 * - Skill activations retain their selected paths and token occurrences.
 * - Append-only writes
 * - Skip empty entries
 * - Skip when the complete entry equals the last entry
 * - Tolerate corrupt lines: log + skip, do not abort load
 */

import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { appendJsonlLine, readJsonlFile } from '#/utils/persistence';

export interface InputHistorySkillOccurrence {
  readonly commandName: string;
  readonly start: number;
}

export interface InputHistorySkillActivation {
  readonly skillName: string;
  readonly path?: string;
  readonly args?: string;
  readonly start?: number;
  readonly occurrences?: readonly InputHistorySkillOccurrence[];
}

export interface InputHistoryEntry {
  content: string;
  readonly inlineSkillActivations?: readonly InputHistorySkillActivation[];
}

const skillOccurrenceSchema = z.object({
  commandName: z.string(),
  start: z.number().int().nonnegative(),
});

const skillActivationSchema = z.object({
  skillName: z.string(),
  path: z.string().optional(),
  args: z.string().optional(),
  start: z.number().int().nonnegative().optional(),
  occurrences: z.array(skillOccurrenceSchema).optional(),
});

const InputHistoryEntrySchema: z.ZodType<InputHistoryEntry> = z.object({
  content: z.string(),
  inlineSkillActivations: z.array(skillActivationSchema).optional(),
});

function normalizeHistoryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeHistoryValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeHistoryValue(entry)]),
  );
}

export function inputHistoryEntryEquals(
  left: InputHistoryEntry | undefined,
  right: InputHistoryEntry | undefined,
): boolean {
  return isDeepStrictEqual(normalizeHistoryValue(left), normalizeHistoryValue(right));
}

export async function loadInputHistory(file: string): Promise<InputHistoryEntry[]> {
  return readJsonlFile(file, InputHistoryEntrySchema);
}

export async function appendInputHistory(
  file: string,
  entry: InputHistoryEntry,
  lastEntry?: InputHistoryEntry,
): Promise<boolean> {
  const content = entry.content.trim();
  if (content.length === 0) return false;
  const normalized = { ...entry, content };
  if (inputHistoryEntryEquals(normalized, lastEntry)) return false;
  await appendJsonlLine(file, InputHistoryEntrySchema, normalized);
  return true;
}
