/**
 * Header chip providers — produce a short "stat" suffix appended to the
 * tool call header once a result has arrived. Chips own the *numeric*
 * summary (line counts, exit codes, byte sizes), so summary renderers
 * below don't repeat them.
 *
 * A chip returning `''` is suppressed; tools without an entry in the
 * registry get no chip at all.
 */

import { computeDiffLines } from '#/tui/components/media/diff-preview';
import { OUTCOME_MAX_LINES } from '#/tui/constant/rendering';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import { goalStatusChip } from './goal';
import { parseGlobOutput, parseGrepOutput } from './grep-output';
import { readMediaChip } from './media';
import { nonEmptyLines } from './outcome';
import { strArg } from './types';
import { waitForChip } from './wait-for';

export type ChipProvider = (toolCall: ToolCallBlockData, result: ToolResultBlockData) => string;

export function countNonEmptyLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (const line of text.split('\n')) if (line.length > 0) n++;
  return n;
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${String(n)} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface EditStats {
  readonly added: number;
  readonly removed: number;
}

export interface WriteStats {
  readonly lines: number;
}

export function computeEditStats(args: Record<string, unknown>): EditStats {
  const oldStr = strArg(args, 'old_string');
  const newStr = strArg(args, 'new_string');
  if (oldStr.length === 0 && newStr.length === 0) return { added: 0, removed: 0 };
  const diff = computeDiffLines(oldStr, newStr);
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'delete') removed++;
  }
  return { added, removed };
}

export function computeWriteStats(args: Record<string, unknown>): WriteStats {
  const content = strArg(args, 'content');
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = normalized.length > 0 ? normalized.split('\n').length : 0;
  return { lines };
}

export function formatEditChip(stats: EditStats): string {
  const parts: string[] = [];
  if (stats.added > 0) parts.push(`+${String(stats.added)}`);
  if (stats.removed > 0) parts.push(`-${String(stats.removed)}`);
  return parts.join(' ');
}

export function formatWriteChip(stats: WriteStats): string {
  return pluralize(stats.lines, 'line');
}

const editChip: ChipProvider = (toolCall) => {
  const stats = computeEditStats(toolCall.args);
  if (stats.added === 0 && stats.removed === 0) return '';
  return formatEditChip(stats);
};

const writeChip: ChipProvider = (toolCall) => formatWriteChip(computeWriteStats(toolCall.args));

const readChip: ChipProvider = (_toolCall, result) =>
  pluralize(countNonEmptyLines(result.output), 'line');

// A collapsed Bash card shows its output whole when it fits the outcome
// rows; once one line stands in for the rest, the chip counts the hidden
// lines, not the total. A failed command keeps its multi-line preview, whose
// own trailer already counts what is left, so the chip stays out of its way.
const bashChip: ChipProvider = (_toolCall, result) => {
  if (result.is_error === true) return '';
  // Counted the way the outcome rows are, so whitespace-only rows neither
  // count as hidden nor leave the chip claiming more than the card holds.
  const lines = nonEmptyLines(result.output).length;
  return lines <= OUTCOME_MAX_LINES ? '' : pluralize(lines - 1, 'more line');
};

// Grep's default mode lists files, so the chip counts what the mode
// returns: files, or matches and the files they fall in. Unnumbered content
// with context flags mixes match and context rows, so only the file count
// is exact there.
const grepChip: ChipProvider = (toolCall, result) => {
  const stats = parseGrepOutput(toolCall, result.output);
  // A paginated count-mode page past the last row still carries the totals.
  if (stats.files === 0) return 'no matches';
  if (stats.mode === 'files_with_matches') return pluralize(stats.files, 'file');
  if (stats.matches === null) return pluralize(stats.files, 'file');
  const matches = pluralize(stats.matches, 'match', 'matches');
  // A paginated content result only shows the files on its page.
  if (stats.filesPartial) return matches;
  return stats.files === 1
    ? `${matches} in 1 file`
    : `${matches} across ${pluralize(stats.files, 'file')}`;
};

const globChip: ChipProvider = (_toolCall, result) => {
  const files = parseGlobOutput(result.output).length;
  if (files === 0) return 'no files';
  return pluralize(files, 'file');
};

const fetchChip: ChipProvider = (_toolCall, result) =>
  formatBytes(Buffer.byteLength(result.output, 'utf8'));

const webSearchChip: ChipProvider = (_toolCall, result) => {
  const lines = result.output.split('\n').filter((l) => l.trim().length > 0);
  let count = 0;
  for (const line of lines) {
    if (/^\s*(\d+\.|[-*])\s+/.test(line)) count++;
  }
  if (count === 0) return lines.length === 0 ? 'no results' : 'web result';
  return pluralize(count, 'result');
};

const goalStatusOutputChip: ChipProvider = (_toolCall, result) =>
  result.is_error ? '' : goalStatusChip(result.output);

const REGISTRY: Record<string, ChipProvider> = {
  Bash: bashChip,
  Edit: editChip,
  Write: writeChip,
  Read: readChip,
  ReadMediaFile: readMediaChip,
  Grep: grepChip,
  Glob: globChip,
  FetchURL: fetchChip,
  WebSearch: webSearchChip,
  CreateGoal: goalStatusOutputChip,
  GetGoal: goalStatusOutputChip,
  WaitFor: waitForChip,
};

export function pickChip(toolName: string): ChipProvider | undefined {
  return REGISTRY[toolName];
}
