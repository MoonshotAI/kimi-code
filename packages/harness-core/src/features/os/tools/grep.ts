import { normalize } from 'pathe';

import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core';

import { unwrapErrorCause, type OsFsPort, type OsHost } from '#/features/os/host/types';
import {
  isSensitiveFile,
  PathSecurityError,
  resolvePathAccessPath,
  SENSITIVE_DOT_VARIANT_SUFFIXES,
  type PathClass,
  type WorkspaceConfig,
} from '#/features/os/path-access';
import { ToolOutputAccumulator } from '#/features/os/output-accumulator';
import {
  DEFAULT_TIMEOUT_MS,
  ensureRgPath,
  MAX_OUTPUT_BYTES,
  rgUnavailableMessage,
  runRgOnce,
  shouldRetryRipgrepEagain,
  type RunRgResult,
} from '#/features/os/rg/index';
import GREP_DESCRIPTION from './grep.md?raw';

export const GREP_TOOL_NAME = 'Grep';

const RG_MAX_COLUMNS = 500;
const DEFAULT_HEAD_LIMIT = 250;
const MTIME_STAT_CONCURRENCY = 32;

const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;
const SENSITIVE_KEY_BASENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa'] as const;
const SENSITIVE_KEY_GLOBS_TO_EXCLUDE = SENSITIVE_KEY_BASENAMES.flatMap((name) => [
  `**/${name}`,
  `**/${name}[-_]*`,
  ...SENSITIVE_DOT_VARIANT_SUFFIXES.map((suffix) => `**/${name}${suffix}`),
]);
const SENSITIVE_GLOBS_TO_EXCLUDE = [
  '**/.env',
  ...SENSITIVE_KEY_GLOBS_TO_EXCLUDE,
  '**/.aws/credentials',
  '**/.aws/credentials/**',
  '**/.gcp/credentials',
  '**/.gcp/credentials/**',
] as const;

const CONTENT_LINE_RE = /^(.*?)([:-])(\d+)\2/;

type GrepMode = 'content' | 'files_with_matches' | 'count_matches';

type ParsedGrepLine =
  | {
      readonly kind: 'record';
      readonly filePath: string;
      readonly payload: string;
    }
  | {
      readonly kind: 'separator';
    }
  | {
      readonly kind: 'legacy';
      readonly text: string;
    };

class GrepAbortedError extends Error {
  constructor() {
    super('Grep aborted');
    this.name = 'GrepAbortedError';
  }
}

export interface CreateGrepToolProps {
  readonly host: OsHost;
  readonly workspace: {
    readonly workDir: string;
    readonly additionalDirs?: readonly string[];
  };
}

interface GrepArguments {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: GrepMode;
  '-i'?: boolean;
  '-n'?: boolean;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
  include_ignored?: boolean;
}

function parseGrepArguments(
  raw: string | null,
): { args: GrepArguments; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid Grep arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid Grep arguments: ${raw}` };
  }
  const {
    pattern,
    path,
    glob,
    type,
    output_mode,
    '-i': i,
    '-n': n,
    '-A': a,
    '-B': b,
    '-C': c,
    head_limit,
    offset,
    multiline,
    include_ignored,
  } = parsed as Record<string, unknown>;
  if (typeof pattern !== 'string') {
    return { parseError: `invalid Grep arguments: ${raw}` };
  }
  if (path !== undefined && typeof path !== 'string') {
    return { parseError: `invalid Grep arguments: ${raw}` };
  }
  if (glob !== undefined && typeof glob !== 'string') {
    return { parseError: `invalid Grep arguments: ${raw}` };
  }
  if (type !== undefined && typeof type !== 'string') {
    return { parseError: `invalid Grep arguments: ${raw}` };
  }
  if (
    output_mode !== undefined &&
    output_mode !== 'content' &&
    output_mode !== 'files_with_matches' &&
    output_mode !== 'count_matches'
  ) {
    return { parseError: `invalid Grep arguments: ${raw}` };
  }
  for (const flag of [i, n, multiline, include_ignored]) {
    if (flag !== undefined && typeof flag !== 'boolean') {
      return { parseError: `invalid Grep arguments: ${raw}` };
    }
  }
  for (const count of [a, b, c, head_limit, offset]) {
    if (
      count !== undefined &&
      (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
    ) {
      return { parseError: `invalid Grep arguments: ${raw}` };
    }
  }
  return {
    args: {
      pattern,
      path,
      glob,
      type,
      output_mode,
      '-i': i,
      '-n': n,
      '-A': a,
      '-B': b,
      '-C': c,
      head_limit,
      offset,
      multiline,
      include_ignored,
    } as GrepArguments,
  };
}

function buildRgArgs(
  rgPath: string,
  args: GrepArguments,
  searchPaths: readonly string[],
  singleThreaded = false,
): string[] {
  const cmd: string[] = [rgPath];
  if (singleThreaded) cmd.push('-j', '1');
  cmd.push('--hidden');
  const mode = args.output_mode ?? 'files_with_matches';
  if (mode !== 'content') {
    cmd.push('--max-columns', String(RG_MAX_COLUMNS));
  }
  cmd.push('--null');
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    cmd.push('--glob', `!${dir}`);
  }

  if (mode === 'files_with_matches') cmd.push('-l');
  else if (mode === 'count_matches') {
    cmd.push('--count-matches', '--with-filename');
  }

  if (args['-i']) cmd.push('-i');
  if (mode === 'content') {
    cmd.push('--with-filename');
    if (args['-n'] !== false) {
      cmd.push('-n');
    } else {
      cmd.push('--field-context-separator', ':');
    }
    if (args['-C'] !== undefined) {
      cmd.push('-C', String(args['-C']));
    } else {
      if (args['-A'] !== undefined) cmd.push('-A', String(args['-A']));
      if (args['-B'] !== undefined) cmd.push('-B', String(args['-B']));
    }
  }
  if (args.glob !== undefined) cmd.push('--glob', args.glob);
  if (args.type !== undefined) cmd.push('--type', args.type);
  if (args.multiline) cmd.push('-U', '--multiline-dotall');
  if (args.include_ignored) cmd.push('--no-ignore');
  for (const glob of SENSITIVE_GLOBS_TO_EXCLUDE) {
    cmd.push('--glob', `!${glob}`);
  }

  cmd.push('--', args.pattern, ...searchPaths);
  return cmd;
}

function splitRgLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }
  return lines.map((line) => stripTrailingCarriageReturn(line));
}

function parseRipgrepOutput(text: string, mode: GrepMode): ParsedGrepLine[] {
  if (text === '') return [];
  if (!text.includes('\0')) {
    return splitRgLines(text).map((line) =>
      mode === 'content' && line === '--' ? { kind: 'separator' } : { kind: 'legacy', text: line },
    );
  }

  if (mode === 'files_with_matches') {
    return text
      .split('\0')
      .map((filePath) => stripTrailingCarriageReturn(filePath))
      .filter((filePath) => filePath !== '')
      .map((filePath) => ({ kind: 'record', filePath, payload: '' }));
  }

  const records: ParsedGrepLine[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === '\n') {
      cursor += 1;
      continue;
    }
    if (text.startsWith('--\r\n', cursor)) {
      records.push({ kind: 'separator' });
      cursor += 4;
      continue;
    }
    if (text.startsWith('--\n', cursor)) {
      records.push({ kind: 'separator' });
      cursor += 3;
      continue;
    }

    const nulIndex = text.indexOf('\0', cursor);
    if (nulIndex < 0) {
      const tail = stripTrailingCarriageReturn(text.slice(cursor));
      if (tail !== '') records.push({ kind: 'legacy', text: tail });
      break;
    }

    const lineEnd = text.indexOf('\n', nulIndex + 1);
    const payloadEnd = lineEnd >= 0 ? lineEnd : text.length;
    const filePath = text.slice(cursor, nulIndex);
    const payload = stripTrailingCarriageReturn(text.slice(nulIndex + 1, payloadEnd));
    records.push({ kind: 'record', filePath, payload });
    cursor = lineEnd >= 0 ? lineEnd + 1 : text.length;
  }
  return records;
}

function formatDisplayLine(
  line: ParsedGrepLine,
  mode: GrepMode,
  workspaceDir: string,
  pathClass: PathClass,
  contentIncludesLineNumbers: boolean,
): string {
  if (line.kind === 'separator') return '--';
  if (line.kind === 'record') {
    const displayPath = relativizeIfUnder(line.filePath, workspaceDir, pathClass);
    if (mode === 'files_with_matches') return displayPath;
    if (mode === 'count_matches') return `${displayPath}:${line.payload}`;
    const separator = contentIncludesLineNumbers ? contentPayloadPathSeparator(line.payload) : ':';
    return `${displayPath}${separator}${line.payload}`;
  }

  const text = line.text;
  if (mode === 'files_with_matches') {
    return relativizeIfUnder(text, workspaceDir, pathClass);
  }
  if (mode === 'count_matches') {
    const idx = text.lastIndexOf(':');
    if (idx <= 0) return text;
    return relativizeIfUnder(text.slice(0, idx), workspaceDir, pathClass) + text.slice(idx);
  }

  const filePath = extractContentFilePath(text, pathClass);
  if (filePath !== undefined) {
    return relativizeIfUnder(filePath, workspaceDir, pathClass) + text.slice(filePath.length);
  }
  return text;
}

function relativizeIfUnder(candidate: string, base: string, pathClass: PathClass): string {
  const normCandidate = normalize(candidate);
  const normBase = normalize(base);
  const comparableCandidate = pathClass === 'win32' ? normCandidate.toLowerCase() : normCandidate;
  const comparableBase = pathClass === 'win32' ? normBase.toLowerCase() : normBase;
  if (comparableCandidate === comparableBase) return '.';
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  if (comparableCandidate.startsWith(prefix)) {
    return normCandidate.slice(prefix.length);
  }
  return normCandidate;
}

function omitIncompleteTrailingRecord(text: string, mode: GrepMode): string {
  if (!text.includes('\0')) return omitIncompleteTrailingLine(text);
  if (mode === 'files_with_matches') {
    const lastNul = text.lastIndexOf('\0');
    return lastNul >= 0 ? text.slice(0, lastNul + 1) : '';
  }

  let cursor = 0;
  let lastCompleteEnd = 0;
  while (cursor < text.length) {
    if (text[cursor] === '\n') {
      cursor += 1;
      lastCompleteEnd = cursor;
      continue;
    }
    if (text.startsWith('--\r\n', cursor)) {
      cursor += 4;
      lastCompleteEnd = cursor;
      continue;
    }
    if (text.startsWith('--\n', cursor)) {
      cursor += 3;
      lastCompleteEnd = cursor;
      continue;
    }

    const nulIndex = text.indexOf('\0', cursor);
    if (nulIndex < 0) break;
    const lineEnd = text.indexOf('\n', nulIndex + 1);
    if (lineEnd < 0) break;
    cursor = lineEnd + 1;
    lastCompleteEnd = cursor;
  }
  return text.slice(0, lastCompleteEnd);
}

function omitIncompleteTrailingLine(text: string): string {
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline >= 0 ? text.slice(0, lastNewline) : '';
}

function formatRipgrepError(
  exitCode: number,
  stderrText: string,
  stderrTruncated: boolean,
): string {
  const stderr = stderrText.trim();
  if (stderr.length === 0) {
    return `Failed to grep: ripgrep exited with code ${String(exitCode)}`;
  }

  const summary = summarizeRipgrepStderr(stderr);
  const lines = [`Failed to grep: ${summary}`, '', 'ripgrep stderr:', stderr];
  if (stderrTruncated) {
    lines.push(`[stderr truncated at ${String(MAX_OUTPUT_BYTES)} bytes]`);
  }
  return lines.join('\n');
}

function summarizeRipgrepStderr(stderr: string): string {
  const lines = splitRgLines(stderr)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLine = lines.findLast((line) => line.toLowerCase().startsWith('error:'));
  return errorLine ?? lines.at(-1) ?? 'ripgrep error';
}

function filterSensitiveLines(
  lines: readonly ParsedGrepLine[],
  mode: GrepMode,
  filteredPaths: Set<string>,
  pathClass: PathClass,
): ParsedGrepLine[] {
  const kept: ParsedGrepLine[] = [];
  for (const line of lines) {
    if (line.kind === 'separator') {
      kept.push(line);
      continue;
    }
    const filePath = parsedFilePath(line, mode, pathClass);
    if (filePath !== undefined && isSensitiveFile(filePath)) {
      filteredPaths.add(filePath);
      continue;
    }
    kept.push(line);
  }
  return mode === 'content' ? normalizeContextSeparators(kept) : kept;
}

function normalizeContextSeparators(lines: readonly ParsedGrepLine[]): ParsedGrepLine[] {
  const normalized: ParsedGrepLine[] = [];
  for (const line of lines) {
    if (
      line.kind === 'separator' &&
      (normalized.length === 0 || normalized.at(-1)?.kind === 'separator')
    ) {
      continue;
    }
    normalized.push(line);
  }
  while (normalized.length > 0 && normalized.at(-1)?.kind === 'separator') {
    normalized.pop();
  }
  return normalized;
}

function parsedFilePath(
  line: ParsedGrepLine,
  mode: GrepMode,
  pathClass: PathClass,
): string | undefined {
  if (line.kind === 'record') return normalize(line.filePath);
  if (line.kind === 'separator') return undefined;
  const text = line.text;
  if (mode === 'files_with_matches') return normalize(text);
  if (mode === 'count_matches') {
    const idx = text.lastIndexOf(':');
    return idx > 0 ? normalize(text.slice(0, idx)) : normalize(text);
  }
  return extractContentFilePath(text, pathClass);
}

function extractContentFilePath(line: string, pathClass: PathClass): string | undefined {
  const m = CONTENT_LINE_RE.exec(line);
  if (m?.[1] !== undefined) return normalize(m[1]);

  const separatorIndex = noLineNumberContentSeparatorIndex(line, pathClass);
  return separatorIndex > 0 ? normalize(line.slice(0, separatorIndex)) : undefined;
}

function noLineNumberContentSeparatorIndex(line: string, pathClass: PathClass): number {
  const searchFrom = pathClass === 'win32' && /^[A-Za-z]:/.test(line) ? 2 : 0;
  return line.indexOf(':', searchFrom);
}

function contentPayloadPathSeparator(payload: string): ':' | '-' {
  const m = /^(\d+)([:-])/.exec(payload);
  return m?.[2] === '-' ? '-' : ':';
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function formatCountSummary(lines: readonly ParsedGrepLine[], redactedSensitive: boolean): string {
  let totalMatches = 0;
  let totalFiles = 0;
  for (const line of lines) {
    const rawCount =
      line.kind === 'record'
        ? line.payload
        : line.kind === 'legacy'
          ? countPayloadFromLegacyLine(line.text)
          : undefined;
    if (rawCount === undefined) continue;
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 0) continue;
    totalMatches += count;
    totalFiles++;
  }

  const occurrenceWord = totalMatches === 1 ? 'occurrence' : 'occurrences';
  const fileWord = totalFiles === 1 ? 'file' : 'files';
  const scope = redactedSensitive ? 'total non-sensitive' : 'total';
  return `Found ${String(totalMatches)} ${scope} ${occurrenceWord} across ${String(totalFiles)} ${fileWord}.`;
}

function countPayloadFromLegacyLine(line: string): string | undefined {
  const idx = line.lastIndexOf(':');
  return idx > 0 ? line.slice(idx + 1) : undefined;
}

function formatSpawnError(error: unknown): string {
  return errorCode(error) === 'ENOENT'
    ? rgUnavailableMessage(error)
    : error instanceof Error
      ? error.message
      : String(error);
}

function errorCode(error: unknown): string | undefined {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped !== null && typeof unwrapped === 'object' && 'code' in unwrapped) {
    const code = (unwrapped as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (signal.aborted) throw new GrepAbortedError();
  if (items.length === 0) return [];

  const results: U[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (signal.aborted) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );
  if (signal.aborted) throw new GrepAbortedError();
  return results;
}

async function sortFilesWithMatchesByMtime(
  fs: OsFsPort,
  lines: readonly ParsedGrepLine[],
  signal: AbortSignal,
): Promise<ParsedGrepLine[]> {
  const entries = await mapWithConcurrency(
    lines,
    MTIME_STAT_CONCURRENCY,
    signal,
    async (line, index) => {
      const path =
        line.kind === 'record' ? line.filePath : line.kind === 'legacy' ? line.text : undefined;
      let mtime = 0;
      if (path !== undefined) {
        try {
          const mtimeMs = (await fs.stat(path)).mtimeMs ?? 0;
          mtime = Math.trunc(mtimeMs / 1000);
        } catch {
        }
      }
      return { line, mtime, index };
    },
  );
  entries.sort((a, b) => b.mtime - a.mtime || a.index - b.index);
  return entries.map((entry) => entry.line);
}

async function executeGrep(
  host: OsHost,
  workspace: WorkspaceConfig,
  args: GrepArguments,
  signal: AbortSignal,
  searchPaths: string[],
): Promise<{ text: string; isError?: true }> {
  if (signal.aborted) {
    return { text: 'Aborted before search started', isError: true };
  }

  const pathClass = host.environment.pathClass;
  let rgPath: string;
  try {
    const resolution = await ensureRgPath({ signal, allowDownload: true });
    rgPath = resolution.path;
  } catch (error) {
    if (signal.aborted) {
      return { text: 'Grep aborted', isError: true };
    }
    return { text: rgUnavailableMessage(error), isError: true };
  }

  let runResult: RunRgResult;
  try {
    const firstRun = await runRgOnce(
      host.process,
      buildRgArgs(rgPath, args, searchPaths),
      signal,
    );
    if (firstRun.kind === 'aborted') {
      return { text: 'Grep aborted', isError: true };
    }
    runResult = firstRun;

    if (shouldRetryRipgrepEagain(runResult)) {
      const retryRun = await runRgOnce(
        host.process,
        buildRgArgs(rgPath, args, searchPaths, true),
        signal,
      );
      if (retryRun.kind === 'aborted') {
        return { text: 'Grep aborted', isError: true };
      }
      runResult = retryRun;
    }
  } catch (error) {
    return { text: formatSpawnError(error), isError: true };
  }

  const { exitCode, stderrText, bufferTruncated, stderrTruncated, timedOut } = runResult;
  let { stdoutText } = runResult;

  if (exitCode !== 0 && exitCode !== 1 && !timedOut) {
    return { text: formatRipgrepError(exitCode, stderrText, stderrTruncated), isError: true };
  }

  const mode = args.output_mode ?? 'files_with_matches';
  if (bufferTruncated || timedOut) {
    stdoutText = omitIncompleteTrailingRecord(stdoutText, mode);
  }
  if (timedOut && stdoutText.trim() === '') {
    return {
      text: `Grep timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s. Try a more specific path or pattern.`,
      isError: true,
    };
  }
  if (signal.aborted) {
    return { text: 'Grep aborted', isError: true };
  }

  const rawLines = parseRipgrepOutput(stdoutText, mode);

  const filteredSensitive = new Set<string>();
  const keptLines = filterSensitiveLines(rawLines, mode, filteredSensitive, pathClass);
  let orderedLines: ParsedGrepLine[];
  try {
    orderedLines =
      mode === 'files_with_matches' && !timedOut
        ? await sortFilesWithMatchesByMtime(host.fs, keptLines, signal)
        : keptLines;
  } catch (error) {
    if (error instanceof GrepAbortedError) {
      return { text: 'Grep aborted', isError: true };
    }
    throw error;
  }

  const offset = args.offset ?? 0;
  const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const afterOffset = offset > 0 ? orderedLines.slice(offset) : orderedLines;
  const limitActive = headLimit > 0;
  const limited = limitActive ? afterOffset.slice(0, headLimit) : afterOffset;
  const paginationTruncated = limitActive && afterOffset.length > headLimit;

  const headerLines: string[] = [];
  const messages: string[] = [];
  if (filteredSensitive.size > 0) {
    const displayedFilteredPaths = [...filteredSensitive].map((path) =>
      relativizeIfUnder(path, workspace.workspaceDir, pathClass),
    );
    messages.push(
      `Filtered ${String(filteredSensitive.size)} sensitive file(s): ${displayedFilteredPaths.join(', ')}`,
    );
  }
  if (mode === 'count_matches' && orderedLines.length > 0) {
    headerLines.push(formatCountSummary(orderedLines, filteredSensitive.size > 0));
  }
  if (paginationTruncated) {
    const total = afterOffset.length + offset;
    const nextOffset = offset + headLimit;
    const paginationNotice =
      bufferTruncated || timedOut
        ? `Results truncated to ${String(headLimit)} lines (total: ${String(total)} of a partial result set). Use offset=${String(nextOffset)} to see more.`
        : `Results truncated to ${String(headLimit)} lines (total: ${String(total)}). Use offset=${String(nextOffset)} to see more.`;
    if (mode === 'count_matches') {
      headerLines.push(paginationNotice);
    } else {
      messages.push(paginationNotice);
    }
  }
  if (bufferTruncated) {
    messages.push(
      `[Output truncated at ${String(MAX_OUTPUT_BYTES)} bytes of rg output — the result set is incomplete. Narrow the pattern, path, or glob filters and re-run to recover complete results.]`,
    );
  }
  if (timedOut) {
    messages.push(
      `Grep timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s; partial results returned. Narrow the path, glob, or pattern and retry for complete results.`,
    );
  }

  const contentIncludesLineNumbers = mode === 'content' && args['-n'] !== false;
  const displayedLines = limited.map((line) =>
    formatDisplayLine(
      line,
      mode,
      workspace.workspaceDir,
      pathClass,
      contentIncludesLineNumbers,
    ),
  );
  const contentBody = displayedLines.join('\n');
  const visibleBody =
    orderedLines.length === 0 && filteredSensitive.size > 0
      ? 'No non-sensitive matches found'
      : contentBody;
  const emptyResultMessage =
    SENSITIVE_GLOBS_TO_EXCLUDE.length > 0 ? 'No non-sensitive matches found' : 'No matches found';
  const body =
    visibleBody === '' && headerLines.length === 0 && messages.length === 0
      ? emptyResultMessage
      : visibleBody;
  const combined = [...headerLines, body, ...messages].filter((part) => part !== '').join('\n');

  const builder = new ToolOutputAccumulator();
  builder.write(combined);
  return { text: builder.ok() };
}

export function createGrepTool(props: CreateGrepToolProps): ToolDefinition {
  return {
    name: GREP_TOOL_NAME,
    description: GREP_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression to search for.',
        },
        path: {
          type: 'string',
          description:
            'File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.',
        },
        glob: {
          type: 'string',
          description:
            "Optional glob filter for which files to search, e.g. `*.ts`. Matched against each file's full absolute path, so a path-anchored pattern like `src/**/*.ts` silently matches nothing — use a basename pattern (`*.ts`), or anchor with `**/` (`**/src/**/*.ts`). To scope the search to a directory, use `path` instead.",
        },
        type: {
          type: 'string',
          description:
            'Optional ripgrep file type filter, such as ts or py. Prefer this over `glob` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count_matches'],
          description:
            'Shape of the result. `content` shows matching lines (honors `-A`, `-B`, `-C`, `-n`, and `head_limit`); `files_with_matches` shows only the paths of files that contain a match, most-recently-modified first (honors `head_limit`); `count_matches` shows per-file match counts as `path:count` lines, preceded by an aggregate total line. Defaults to `files_with_matches`.',
        },
        '-i': {
          type: 'boolean',
          description: 'Perform a case-insensitive search. Defaults to false.',
        },
        '-n': {
          type: 'boolean',
          description:
            'Prefix each matching line with its line number. Applies only when `output_mode` is `content`. Defaults to true.',
        },
        '-A': {
          type: 'integer',
          minimum: 0,
          description:
            'Number of lines to show after each match. Applies only when `output_mode` is `content`.',
        },
        '-B': {
          type: 'integer',
          minimum: 0,
          description:
            'Number of lines to show before each match. Applies only when `output_mode` is `content`.',
        },
        '-C': {
          type: 'integer',
          minimum: 0,
          description:
            'Number of lines to show before and after each match. Applies only when `output_mode` is `content`; takes precedence over `-A` and `-B`.',
        },
        head_limit: {
          type: 'integer',
          minimum: 0,
          description:
            'Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'Number of leading lines/entries to skip before applying `head_limit`. Use it together with `head_limit` to page through large result sets. Defaults to 0.',
        },
        multiline: {
          type: 'boolean',
          description:
            'Enable multiline matching, where the pattern can span line boundaries and `.` also matches newlines. Defaults to false.',
        },
        include_ignored: {
          type: 'boolean',
          description:
            'Also search files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. VCS metadata directories (`.git` and similar) are always skipped, even when this is true. Defaults to false.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute({ toolCall, signal }): Promise<ToolResult> {
      const errorText = (value: string): ToolResult => ({
        content: [{ type: 'text' as const, text: value }],
        isError: true,
      });
      const parsed = parseGrepArguments(toolCall.arguments);
      if (parsed.parseError !== undefined) {
        return errorText(parsed.parseError);
      }
      const args = parsed.args;
      await props.host.environment.ready;
      const workspace: WorkspaceConfig = {
        workspaceDir: props.workspace.workDir,
        additionalDirs: props.workspace.additionalDirs ?? [],
      };
      const searchPaths: string[] = [];
      try {
        searchPaths.push(
          args.path !== undefined
            ? resolvePathAccessPath(args.path, {
                env: props.host.environment,
                workspace,
                operation: 'search',
                policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
              })
            : workspace.workspaceDir,
        );
      } catch (error) {
        if (error instanceof PathSecurityError) {
          return errorText(error.message);
        }
        throw error;
      }
      const finished = await executeGrep(props.host, workspace, args, signal, searchPaths);
      return {
        content: [{ type: 'text' as const, text: finished.text }],
        isError: finished.isError,
      };
    },
  };
}
