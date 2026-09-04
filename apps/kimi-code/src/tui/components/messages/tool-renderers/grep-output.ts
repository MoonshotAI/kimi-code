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
   * Entries in the whole result set — the tool-reported total when the
   * result is paginated — which the glance counts its "+N more" against.
   */
  readonly total: number;
  /**
   * What the mode counts: files in `files_with_matches`, matching lines in
   * `content`, the summed per-file counts in `count_matches`. `null` when the
   * count is not derivable from the text: unnumbered content rows with
   * context flags are indistinguishable from context rows.
   */
  readonly matches: number | null;
  /** Files in the whole result set when the tool reported a total (paginated results), else the files seen. */
  readonly files: number;
  /** True when a paginated content result only shows the files on its page, so `files` is a lower bound. */
  readonly filesPartial: boolean;
  /** True when the tool reported an incomplete result set (timeout or output cap): every count is a lower bound. */
  readonly partial: boolean;
}

export interface GlobStats {
  readonly entries: readonly string[];
  /** True when Glob timed out or hit its match cap: the count is a lower bound. */
  readonly partial: boolean;
}

// Lines the tools add around the results: the empty-result sentence, the
// count-mode summary, and the pagination / filtering / timeout notices.
// Glob prepends its own diagnostics (timeout, truncation, read warnings whose
// ripgrep stderr continues on `rg:` lines) and appends an exact-cap count line.
const NOTICE =
  /^(?:No matches found|No non-sensitive matches found|Found \d+ total (?:non-sensitive )?occurrences? across |Found \d+ matches$|Filtered \d+ sensitive file|Results truncated to \d+ lines|\[Output truncated at \d+ bytes|Grep timed out after |Glob timed out after |Glob completed with warnings|\[stdout truncated at |\[Truncated at |Only the first |rg: )/;

// Totals the tool reports for the whole result set when it paginates: the
// count-mode summary covers every file, and the pagination notice's total is
// the full line count — the file count in files mode.
const COUNT_SUMMARY = /^Found (\d+) total (?:non-sensitive )?occurrences? across (\d+) files?\.$/m;
const PAGINATION_TOTAL = /^Results truncated to \d+ lines \(total: (\d+)/m;
// Notices that mark the result set itself as incomplete, as opposed to merely paginated.
const INCOMPLETE =
  /^(?:\[Output truncated at \d+ bytes|Grep timed out after |Glob timed out after |Glob completed with warnings|\[stdout truncated at |\[Truncated at \d+ matches|Only the first \d+ matches)/m;

// `path:line:text`; context lines use `-` separators and are not matches.
const CONTENT_MATCH = /^(.+?):(\d+):/;
const COUNT_LINE = /^(.+):(\d+)$/;
// A Windows drive letter carries its own colon; the separator search skips it.
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

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
  const partial = INCOMPLETE.test(output);

  if (mode === 'files_with_matches') {
    const entries = lines.map((path) => ({ path, label: path }));
    const total = PAGINATION_TOTAL.exec(output)?.[1];
    const files = total === undefined ? entries.length : Number(total);
    return { mode, entries, total: files, matches: files, files, filesPartial: false, partial };
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
    const [, totalMatches, totalFiles] = COUNT_SUMMARY.exec(output) ?? [];
    if (totalMatches !== undefined && totalFiles !== undefined) {
      return {
        mode,
        entries,
        total: Number(totalFiles),
        matches: Number(totalMatches),
        files: Number(totalFiles),
        filesPartial: false,
        partial,
      };
    }
    return {
      mode,
      entries,
      total: entries.length,
      matches,
      files: entries.length,
      filesPartial: false,
      partial,
    };
  }

  // Content mode: with line numbers (the default) only `path:line:` rows are
  // matches; without them every match row is `path:text`, and context rows
  // (`-A`/`-B`/`-C`) look exactly the same — the backend separates fields
  // with ':' unconditionally — so an exact match count is unknowable then.
  const numbered = toolCall.args['-n'] !== false;
  // The schema allows zero, which asks for no context rows at all, and a
  // defined `-C` makes the backend drop `-A`/`-B` entirely.
  const positive = (flag: string): boolean => {
    const value = toolCall.args[flag];
    return typeof value === 'number' && value > 0;
  };
  const hasContext =
    typeof toolCall.args['-C'] === 'number' ? positive('-C') : positive('-A') || positive('-B');
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
    const idx = line.indexOf(':', DRIVE_PREFIX.test(line) ? 2 : 0);
    const path = idx > 0 ? line.slice(0, idx) : line;
    rows++;
    if (paths.has(path)) continue;
    paths.add(path);
    entries.push({ path, label: path });
  }
  // Without context flags every paginated row is a match, so the tool's
  // total is the exact match count; the files beyond the page stay unknown.
  const paginatedTotal = hasContext ? undefined : PAGINATION_TOTAL.exec(output)?.[1];
  const matches = countable ? (paginatedTotal === undefined ? rows : Number(paginatedTotal)) : null;
  return {
    mode,
    entries,
    total: numbered && matches !== null ? matches : paths.size,
    matches,
    files: paths.size,
    filesPartial: paginatedTotal !== undefined,
    partial,
  };
}

export function parseGlobOutput(output: string): GlobStats {
  return { entries: resultLines(output), partial: INCOMPLETE.test(output) };
}

/**
 * Whether a Grep or Glob result is only the tool's notice: the search was cut
 * short (timeout, output cap, unreadable directories) before any row. Such a
 * card shows the notice as a plain outcome row, the same way in both states.
 */
export function searchCutShort(toolCall: ToolCallBlockData, output: string): boolean {
  if (toolCall.name === 'Glob') {
    const { entries, partial } = parseGlobOutput(output);
    return partial && entries.length === 0;
  }
  const stats = parseGrepOutput(toolCall, output);
  return stats.partial && stats.entries.length === 0;
}
