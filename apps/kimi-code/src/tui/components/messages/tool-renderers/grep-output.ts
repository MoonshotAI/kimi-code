/**
 * Shape-aware reading of Grep and Glob output for the header chip and the
 * glance row. Both tools append notices (pagination, sensitive-file
 * filtering, timeouts) and an empty-result sentence around the result lines;
 * those must stay out of the counts and the path samples.
 */

import type { ToolCallBlockData } from '#/tui/types';

import { strArg } from './types';

export type GrepMode = 'files_with_matches' | 'content' | 'count_matches';

export interface GrepEntry {
  /** File the entry belongs to. */
  readonly path: string;
  /** What the glance shows for it: `path`, `path:line`, or `path:count`. */
  readonly label: string;
}

export interface GrepStats {
  readonly mode: GrepMode;
  /** Glance samples in output order; unnumbered content rows collapse to one entry per file. */
  readonly entries: readonly GrepEntry[];
  /**
   * What the mode counts: files in `files_with_matches`, matching lines in
   * `content`, the summed per-file counts in `count_matches`. `null` when the
   * count is not derivable from the text: unnumbered content rows with
   * context flags are indistinguishable from context rows.
   */
  readonly matches: number | null;
  readonly files: number;
}

// Lines the tools add around the results: the empty-result sentence, the
// count-mode summary, and the pagination / filtering / timeout notices.
// Glob prepends its own diagnostics (timeout, truncation, read warnings)
// and appends an exact-cap count line.
const NOTICE =
  /^(?:No matches found|No non-sensitive matches found|Found \d+ total (?:non-sensitive )?occurrences? across |Found \d+ matches$|Filtered \d+ sensitive file|Results truncated to \d+ lines|\[Output truncated at \d+ bytes|Grep timed out after |Glob timed out after |Glob completed with warnings|\[stdout truncated at |\[Truncated at |Only the first )/;

// `path:line:text`; context lines use `-` separators and are not matches.
const CONTENT_MATCH = /^(.+?):(\d+):/;
const COUNT_LINE = /^(.+):(\d+)$/;

function resultLines(output: string): string[] {
  if (output.length === 0) return [];
  return output
    .split('\n')
    .filter((line) => line.length > 0 && line !== '--' && !NOTICE.test(line));
}

export function grepMode(toolCall: ToolCallBlockData): GrepMode {
  const mode = strArg(toolCall.args, 'output_mode');
  return mode === 'content' || mode === 'count_matches' ? mode : 'files_with_matches';
}

export function parseGrepOutput(toolCall: ToolCallBlockData, output: string): GrepStats {
  const mode = grepMode(toolCall);
  const lines = resultLines(output);

  if (mode === 'files_with_matches') {
    const entries = lines.map((path) => ({ path, label: path }));
    return { mode, entries, matches: entries.length, files: entries.length };
  }

  if (mode === 'count_matches') {
    const entries: GrepEntry[] = [];
    let matches = 0;
    for (const line of lines) {
      const [, path, count] = COUNT_LINE.exec(line) ?? [];
      if (path === undefined || count === undefined) continue;
      entries.push({ path, label: line });
      matches += Number(count);
    }
    return { mode, entries, matches, files: entries.length };
  }

  // Content mode: with line numbers (the default) only `path:line:` rows are
  // matches; without them every match row is `path:text`, and context rows
  // (`-A`/`-B`/`-C`) look exactly the same — the backend separates fields
  // with ':' unconditionally — so an exact match count is unknowable then.
  const numbered = toolCall.args['-n'] !== false;
  const hasContext =
    toolCall.args['-A'] !== undefined ||
    toolCall.args['-B'] !== undefined ||
    toolCall.args['-C'] !== undefined;
  const countable = numbered || !hasContext;
  const entries: GrepEntry[] = [];
  const paths = new Set<string>();
  let rows = 0;
  for (const line of lines) {
    if (numbered) {
      const [, path, lineNumber] = CONTENT_MATCH.exec(line) ?? [];
      if (path === undefined || lineNumber === undefined) continue;
      rows++;
      paths.add(path);
      entries.push({ path, label: `${path}:${lineNumber}` });
      continue;
    }
    // Unnumbered rows are labelled by their path alone, so the glance lists
    // each file once instead of repeating it per match or context row.
    const idx = line.indexOf(':');
    const path = idx > 0 ? line.slice(0, idx) : line;
    rows++;
    if (paths.has(path)) continue;
    paths.add(path);
    entries.push({ path, label: path });
  }
  return { mode, entries, matches: countable ? rows : null, files: paths.size };
}

export function parseGlobOutput(output: string): string[] {
  return resultLines(output);
}
