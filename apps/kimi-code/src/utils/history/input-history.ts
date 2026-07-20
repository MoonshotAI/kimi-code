/**
 * User input history persistence — JSONL file with `{"content": "..."}` per line.
 *
 * Semantics:
 * - One JSON object per line (`InputHistoryEntry { content }`)
 * - `content` is the raw input. Shell commands are stored with a leading `!`
 *   (e.g. `!ls -la`) so ↑ recall can distinguish them from prompts and restore
 *   bash mode; the `!` is stripped again when the entry is recalled. Plain
 *   prompts (and legacy entries without a leading `!`) are normal prompts.
 * - Append-only writes
 * - Skip empty entries
 * - Skip when same as last entry (consecutive deduplication)
 * - Tolerate corrupt lines: log + skip, do not abort load
 */

import { z } from 'zod';

import { appendJsonlLine, readJsonlFile } from '#/utils/persistence';

export interface InputHistoryEntry {
  content: string;
}

const InputHistoryEntrySchema: z.ZodType<InputHistoryEntry> = z.object({
  content: z.string(),
});

export async function loadInputHistory(file: string): Promise<InputHistoryEntry[]> {
  return readJsonlFile(file, InputHistoryEntrySchema);
}

/**
 * Append an entry to the history file. Returns true if written, false if
 * skipped (empty or equal to `lastContent`).
 */
export async function appendInputHistory(
  file: string,
  text: string,
  lastContent?: string,
): Promise<boolean> {
  const content = text.trim();
  if (content.length === 0) return false;
  if (content === lastContent) return false;
  await appendJsonlLine(file, InputHistoryEntrySchema, { content });
  return true;
}
