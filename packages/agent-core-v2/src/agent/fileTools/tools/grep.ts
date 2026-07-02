/**
 * `fileTools` domain — GrepTool, the model's content search tool.
 *
 * Searches file contents with ripgrep-style regular expressions, delegating
 * the actual scan to the `agentFs` domain's `ISessionFsService.grep` (which is
 * workspace-confined, `rg`-backed when available, and falls back to a Node
 * walker otherwise, honoring gitignore and glob filters). The tool maps the
 * model-facing input args onto an `FsGrepRequest`, then renders the
 * `FsGrepResponse` in the v1 Grep output shape (`files_with_matches` /
 * `content` / `count_matches`) with `offset` / `head_limit` pagination and a
 * sensitive-file post-filter.
 *
 * Path safety goes through the shared path access resolver used by
 * Read/Write/Edit/Grep: an explicit absolute path outside the workspace is
 * allowed for the access declaration, while a relative path that escapes the
 * workspace is rejected. The search itself is confined to the workspace by
 * `ISessionFsService`.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/grep.ts`). The
 * v1 tool shelled out to `rg` directly through Kaos and parsed its output;
 * that work now lives in `ISessionFsService.grep`, so this tool only maps arguments
 * and renders results. A few v1 behaviors that `ISessionFsService.grep` does not
 * expose (mtime ordering of `files_with_matches`, multiline matching, and
 * searching a path outside the workspace) are intentionally not replicated.
 */

import type { FsGrepMatch, FsGrepRequest, FsGrepResponse } from '@moonshot-ai/protocol';
import { z } from 'zod';

import { ISessionFsService } from '#/session/agentFs';
import { ErrorCodes, isKimiError } from '#/errors';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { ToolAccesses } from '#/agent/tool';
import type { BuiltinTool, ExecutableToolResult, ToolExecution } from '#/agent/tool';
import { resolvePathAccessPath } from '#/_base/tools/policies/path-access';
import { isSensitiveFile } from '#/_base/tools/policies/sensitive';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/_base/tools/support/rule-match';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import { renderPrompt } from '#/_base/utils/render-prompt';
import grepDescriptionTemplate from './grep.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const GrepInputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.',
    ),
  glob: z.string().optional().describe('Optional glob filter passed to ripgrep.'),
  type: z
    .string()
    .optional()
    .describe(
      'Optional ripgrep file type filter, such as ts or py. Prefer this over `glob` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count_matches'])
    .optional()
    .describe(
      'Shape of the result. `content` shows matching lines (honors `-A`, `-B`, `-C`, `-n`, and `head_limit`); `files_with_matches` shows only the paths of files that contain a match (honors `head_limit`); `count_matches` shows the total number of matches. Defaults to `files_with_matches`.',
    ),
  '-i': z.boolean().optional().describe('Perform a case-insensitive search. Defaults to false.'),
  '-n': z
    .boolean()
    .optional()
    .describe(
      'Prefix each matching line with its line number. Applies only when `output_mode` is `content`. Defaults to true.',
    ),
  '-A': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show after each match. Applies only when `output_mode` is `content`.',
    ),
  '-B': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show before each match. Applies only when `output_mode` is `content`.',
    ),
  '-C': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show before and after each match. Applies only when `output_mode` is `content`; takes precedence over `-A` and `-B`.',
    ),
  head_limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.',
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of leading lines/entries to skip before applying `head_limit`. Use it together with `head_limit` to page through large result sets. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Enable multiline matching, where the pattern can span line boundaries and `.` also matches newlines. Defaults to false.',
    ),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      'Also search files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. Defaults to false.',
    ),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

type GrepMode = 'content' | 'files_with_matches' | 'count_matches';

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_HEAD_LIMIT = 250;
// The fs layer is told not to cap its scan so the tool's own `head_limit`
// pagination is the only bound on output. These are the protocol maximums.
const FS_MAX_FILES = 10_000;
const FS_MAX_MATCHES_PER_FILE = 10_000;
const FS_MAX_TOTAL_MATCHES = 100_000;
const FS_MAX_CONTEXT_LINES = 10;

const GREP_DESCRIPTION = renderPrompt(grepDescriptionTemplate, {});

// ── Tool ─────────────────────────────────────────────────────────────

export class GrepTool implements BuiltinTool<GrepInput> {
  readonly name = 'Grep' as const;
  readonly description = GREP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GrepInputSchema);
  constructor(
    private readonly fs: ISessionFsService,
    private readonly env: IHostEnvironment,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: GrepInput): ToolExecution {
    let searchPath: string | undefined;
    if (args.path !== undefined) {
      searchPath = resolvePathAccessPath(args.path, {
        env: this.env,
        workspace: this.workspace,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const accessPath = searchPath ?? this.workspace.workspaceDir;
    const displayPath = args.path ?? this.workspace.workspaceDir;
    return {
      accesses: ToolAccesses.searchTree(accessPath),
      description: `Searching for '${args.pattern}' in ${displayPath}`,
      display: { kind: 'file_io', operation: 'grep', path: accessPath },
      approvalRule: literalRulePattern(this.name, args.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
      execute: ({ signal }) => this.execution(args, signal),
    };
  }

  private async execution(args: GrepInput, signal: AbortSignal): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Aborted before search started' };
    }

    let response: FsGrepResponse;
    try {
      response = await this.fs.grep(buildGrepRequest(args));
    } catch (error) {
      return mapGrepError(error);
    }

    if (signal.aborted) {
      return { isError: true, output: 'Grep aborted' };
    }

    return renderGrepResponse(args, response);
  }
}

// ── Request mapping ──────────────────────────────────────────────────

function buildGrepRequest(args: GrepInput): FsGrepRequest {
  const includeGlobs: string[] = [];
  if (args.glob !== undefined) includeGlobs.push(args.glob);
  if (args.type !== undefined) includeGlobs.push(`**/*.${args.type}`);
  return {
    pattern: args.pattern,
    // The tool's `pattern` is documented as a regular expression, so always
    // ask the fs layer for regex matching.
    regex: true,
    case_sensitive: args['-i'] !== true,
    follow_gitignore: args.include_ignored !== true,
    max_files: FS_MAX_FILES,
    max_matches_per_file: FS_MAX_MATCHES_PER_FILE,
    max_total_matches: FS_MAX_TOTAL_MATCHES,
    context_lines: contextLines(args),
    include_globs: includeGlobs.length > 0 ? includeGlobs : undefined,
    exclude_globs: undefined,
  };
}

function contextLines(args: GrepInput): number {
  if (args['-C'] !== undefined) return clamp(args['-C'], 0, FS_MAX_CONTEXT_LINES);
  const before = args['-B'] ?? 0;
  const after = args['-A'] ?? 0;
  return clamp(Math.max(before, after), 0, FS_MAX_CONTEXT_LINES);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ── Error mapping ────────────────────────────────────────────────────

function mapGrepError(error: unknown): ExecutableToolResult {
  if (isKimiError(error) && error.code === ErrorCodes.FS_GREP_TIMEOUT) {
    return {
      isError: true,
      output: 'Grep timed out. Try a more specific path or pattern.',
    };
  }
  return {
    isError: true,
    output: `Failed to grep: ${error instanceof Error ? error.message : String(error)}`,
  };
}

// ── Response rendering ───────────────────────────────────────────────

interface Page<T> {
  readonly visible: readonly T[];
  readonly truncated: boolean;
  readonly total: number;
  readonly nextOffset: number;
}

function paginate<T>(items: readonly T[], args: GrepInput): Page<T> {
  const offset = args.offset ?? 0;
  const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const afterOffset = offset > 0 ? items.slice(offset) : items;
  const limitActive = headLimit > 0;
  const visible = limitActive ? afterOffset.slice(0, headLimit) : afterOffset;
  const truncated = limitActive && afterOffset.length > headLimit;
  return { visible, truncated, total: items.length, nextOffset: offset + headLimit };
}

function renderGrepResponse(args: GrepInput, response: FsGrepResponse): ExecutableToolResult {
  const mode: GrepMode = args.output_mode ?? 'files_with_matches';

  // Post-filter sensitive files, mirroring v1's post-rg sensitive filter.
  // `ISessionFsService.grep` searches the whole workspace and does not exclude
  // sensitive paths, so the tool drops them before rendering.
  const filteredSensitive: string[] = [];
  const keptFiles = response.files.filter((file) => {
    if (isSensitiveFile(file.path)) {
      filteredSensitive.push(file.path);
      return false;
    }
    return true;
  });

  const inlineMessages: string[] = [];
  if (filteredSensitive.length > 0) {
    inlineMessages.push(
      `Filtered ${String(filteredSensitive.length)} sensitive file(s): ${filteredSensitive.join(', ')}`,
    );
  }
  if (response.truncated) {
    inlineMessages.push(
      'Search stopped early after reaching the match limit; results may be incomplete. Try a more specific path or pattern.',
    );
  }

  if (mode === 'count_matches') {
    return renderCountMatches(args, keptFiles, filteredSensitive.length > 0, inlineMessages);
  }
  if (mode === 'content') {
    return renderContent(args, keptFiles, inlineMessages, filteredSensitive.length > 0);
  }
  return renderFilesWithMatches(args, keptFiles, inlineMessages, filteredSensitive.length > 0);
}

function renderFilesWithMatches(
  args: GrepInput,
  files: readonly { path: string }[],
  inlineMessages: string[],
  redactedSensitive: boolean,
): ExecutableToolResult {
  const page = paginate(files, args);
  const body = page.visible.map((file) => file.path).join('\n');
  appendPaginationNotice(inlineMessages, page);
  return {
    output: combineBody(body, inlineMessages, emptyMessage(redactedSensitive)),
  };
}

function renderContent(
  args: GrepInput,
  files: readonly { path: string; matches: readonly FsGrepMatch[] }[],
  inlineMessages: string[],
  redactedSensitive: boolean,
): ExecutableToolResult {
  const includeLineNumbers = args['-n'] !== false;
  const lines: string[] = [];
  for (const file of files) {
    for (const match of file.matches) {
      lines.push(...renderMatchLines(file.path, match, includeLineNumbers));
    }
  }
  const page = paginate(lines, args);
  const body = page.visible.join('\n');
  appendPaginationNotice(inlineMessages, page);
  return {
    output: combineBody(body, inlineMessages, emptyMessage(redactedSensitive)),
  };
}

function renderMatchLines(
  path: string,
  match: FsGrepMatch,
  includeLineNumbers: boolean,
): string[] {
  const lines: string[] = [];
  if (includeLineNumbers) {
    const beforeStart = match.line - match.before.length;
    for (let i = 0; i < match.before.length; i += 1) {
      lines.push(`${path}-${String(beforeStart + i)}-${match.before[i]}`);
    }
    lines.push(`${path}:${String(match.line)}:${match.text}`);
    for (let i = 0; i < match.after.length; i += 1) {
      lines.push(`${path}-${String(match.line + 1 + i)}-${match.after[i]}`);
    }
  } else {
    for (const text of match.before) lines.push(`${path}:${text}`);
    lines.push(`${path}:${match.text}`);
    for (const text of match.after) lines.push(`${path}:${text}`);
  }
  return lines;
}

function renderCountMatches(
  args: GrepInput,
  files: readonly { path: string; matches: readonly unknown[] }[],
  redactedSensitive: boolean,
  inlineMessages: string[],
): ExecutableToolResult {
  const counts = files.map((file) => ({ path: file.path, count: file.matches.length }));
  const totalMatches = counts.reduce((sum, entry) => sum + entry.count, 0);
  const page = paginate(counts, args);
  const body = page.visible.map((entry) => `${entry.path}:${String(entry.count)}`).join('\n');

  // The count data stream stays pure `path:count` lines; the summary and the
  // pagination notice move to the side channel so they don't contaminate it.
  const sideMessages: string[] = [];
  if (counts.length > 0) {
    sideMessages.push(formatCountSummary(totalMatches, counts.length, redactedSensitive));
  }
  if (page.truncated) {
    sideMessages.push(
      `Results truncated to ${String(args.head_limit ?? DEFAULT_HEAD_LIMIT)} lines (total: ${String(page.total)}). Use offset=${String(page.nextOffset)} to see more.`,
    );
  }

  return {
    output: combineBody(body, inlineMessages, emptyMessage(redactedSensitive)),
    message: sideMessages.length > 0 ? sideMessages.join('\n') : undefined,
  };
}

function appendPaginationNotice(messages: string[], page: Page<unknown>): void {
  if (!page.truncated) return;
  messages.push(
    `Results truncated to ${String(page.visible.length)} lines (total: ${String(page.total)}). Use offset=${String(page.nextOffset)} to see more.`,
  );
}

function emptyMessage(redactedSensitive: boolean): string {
  return redactedSensitive ? 'No non-sensitive matches found' : 'No matches found';
}

function combineBody(body: string, messages: readonly string[], empty: string): string {
  const base = body === '' ? empty : body;
  if (messages.length === 0) return base;
  return `${base}\n${messages.join('\n')}`;
}

function formatCountSummary(
  totalMatches: number,
  totalFiles: number,
  redactedSensitive: boolean,
): string {
  const occurrenceWord = totalMatches === 1 ? 'occurrence' : 'occurrences';
  const fileWord = totalFiles === 1 ? 'file' : 'files';
  const scope = redactedSensitive ? 'total non-sensitive' : 'total';
  return `Found ${String(totalMatches)} ${scope} ${occurrenceWord} across ${String(totalFiles)} ${fileWord}.`;
}
