import { normalize, resolve } from 'pathe';

import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import { unwrapErrorCause, type OsHost } from '#/features/os/host/types';
import {
  isSensitiveFile,
  isWithinDirectory,
  PathSecurityError,
  resolvePathAccessPath,
  SENSITIVE_DOT_VARIANT_SUFFIXES,
  type PathClass,
  type WorkspaceConfig,
} from '#/features/os/path-access';
import { DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS } from '#/features/os/output-accumulator';
import {
  DEFAULT_TIMEOUT_MS,
  ensureRgPath,
  MAX_OUTPUT_BYTES,
  rgUnavailableMessage,
  runRgOnce,
  shouldRetryRipgrepEagain,
} from '#/features/os/rg/index';
import GLOB_DESCRIPTION from './glob.md?raw';

export const GLOB_TOOL_NAME = 'Glob';

export const DEFAULT_HEAD_LIMIT = 100;

export const WINDOWS_PATH_HINT =
  '\n\nWindows note: the `path` argument accepts both Windows paths ' +
  '(e.g. `C:\\Users\\foo`) and POSIX-style paths (e.g. `/c/Users/foo`). Matched paths are ' +
  'returned in Windows backslash form; convert them to forward slashes before ' +
  'using them in a Bash command.';

const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;

const SENSITIVE_KEY_BASENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa'] as const;
const SENSITIVE_GLOBS_TO_EXCLUDE: readonly string[] = [
  '**/.env',
  ...SENSITIVE_KEY_BASENAMES.flatMap((name) => [
    `**/${name}`,
    `**/${name}[-_]*`,
    ...SENSITIVE_DOT_VARIANT_SUFFIXES.map((suffix) => `**/${name}${suffix}`),
  ]),
  '**/.aws/credentials',
  '**/.aws/credentials/**',
  '**/.gcp/credentials',
  '**/.gcp/credentials/**',
];

export interface CreateGlobToolProps {
  readonly host: OsHost;
  readonly workspace: {
    readonly workDir: string;
    readonly additionalDirs?: readonly string[];
  };
}

interface GlobArguments {
  pattern: string;
  head_limit?: number;
  offset?: number;
  path?: string;
  include_ignored?: boolean;
  include_dirs?: boolean;
}

function parseGlobArguments(
  raw: string | null,
): { args: GlobArguments; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid Glob arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid Glob arguments: ${raw}` };
  }
  const { pattern, head_limit, offset, path, include_ignored, include_dirs } = parsed as {
    pattern?: unknown;
    head_limit?: unknown;
    offset?: unknown;
    path?: unknown;
    include_ignored?: unknown;
    include_dirs?: unknown;
  };
  if (typeof pattern !== 'string') {
    return { parseError: `invalid Glob arguments: ${raw}` };
  }
  if (
    head_limit !== undefined &&
    (typeof head_limit !== 'number' || !Number.isInteger(head_limit) || head_limit < 0)
  ) {
    return { parseError: `invalid Glob arguments: ${raw}` };
  }
  if (
    offset !== undefined &&
    (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)
  ) {
    return { parseError: `invalid Glob arguments: ${raw}` };
  }
  if (path !== undefined && typeof path !== 'string') {
    return { parseError: `invalid Glob arguments: ${raw}` };
  }
  if (include_ignored !== undefined && typeof include_ignored !== 'boolean') {
    return { parseError: `invalid Glob arguments: ${raw}` };
  }
  if (include_dirs !== undefined && typeof include_dirs !== 'boolean') {
    return { parseError: `invalid Glob arguments: ${raw}` };
  }
  return { args: { pattern, head_limit, offset, path, include_ignored, include_dirs } };
}

function buildRgArgs(rgPath: string, args: GlobArguments, singleThreaded = false): string[] {
  const cmd: string[] = [rgPath];
  if (singleThreaded) cmd.push('-j', '1');
  cmd.push('--files', '--hidden', '--sortr=modified');
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    cmd.push('--glob', `!${dir}`);
  }
  cmd.push('--glob', args.pattern);
  for (const glob of SENSITIVE_GLOBS_TO_EXCLUDE) {
    cmd.push('--glob', `!${glob}`);
  }
  if (args.include_ignored) cmd.push('--no-ignore');
  cmd.push('.');
  return cmd;
}

function formatGlobError(searchRoot: string, stderr: string): string {
  const trimmed = stderr.trim();
  if (/no such file or directory/i.test(trimmed)) {
    return `${searchRoot} does not exist`;
  }
  return trimmed.length > 0 ? `Glob failed: ${trimmed}` : 'Glob failed';
}

function formatGlobWarning(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0
    ? `Glob completed with warnings; some directories could not be read: ${trimmed}`
    : 'Glob completed with warnings; some directories could not be read.';
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

function splitCompletePaths(stdoutText: string, truncatedOutput: boolean): string[] {
  let text = stdoutText;
  if (truncatedOutput && !text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
  }
  return text.split('\n').filter((p) => p.length > 0);
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

async function executeGlob(
  host: OsHost,
  workspace: WorkspaceConfig,
  args: GlobArguments,
  signal: AbortSignal,
  searchRoot: string,
): Promise<{ text: string; isError?: true }> {
  try {
    const st = await host.fs.stat(searchRoot);
    if (!st.isDirectory) {
      return { text: `${searchRoot} is not a directory`, isError: true };
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { text: `${searchRoot} does not exist`, isError: true };
    }
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }

  if (signal.aborted) {
    return { text: 'Glob aborted', isError: true };
  }

  let rgPath: string;
  try {
    const resolution = await ensureRgPath({ signal, allowDownload: true });
    rgPath = resolution.path;
  } catch (error) {
    if (signal.aborted) {
      return { text: 'Glob aborted', isError: true };
    }
    return { text: rgUnavailableMessage(error), isError: true };
  }

  let run;
  try {
    run = await runRgOnce(host.process, buildRgArgs(rgPath, args), signal, { cwd: searchRoot });
  } catch (error) {
    return { text: formatSpawnError(error), isError: true };
  }
  if (run.kind === 'aborted') {
    return { text: 'Glob aborted', isError: true };
  }

  if (shouldRetryRipgrepEagain(run)) {
    try {
      run = await runRgOnce(host.process, buildRgArgs(rgPath, args, true), signal, { cwd: searchRoot });
    } catch (error) {
      return { text: formatSpawnError(error), isError: true };
    }
    if (run.kind === 'aborted') {
      return { text: 'Glob aborted', isError: true };
    }
  }

  const { exitCode, stdoutText, stderrText, bufferTruncated, timedOut } = run;

  let traversalWarning: string | undefined;
  if (exitCode !== 0 && exitCode !== 1 && !timedOut) {
    const rawPathsBeforeError = splitCompletePaths(stdoutText, true);
    if (rawPathsBeforeError.length === 0) {
      return { text: formatGlobError(searchRoot, stderrText), isError: true };
    }
    traversalWarning = formatGlobWarning(stderrText);
  }
  if (signal.aborted) {
    return { text: 'Glob aborted', isError: true };
  }

  const rawPaths = splitCompletePaths(stdoutText, bufferTruncated || timedOut).map((p) =>
    resolve(searchRoot, p),
  );

  const kept: string[] = [];
  let filteredSensitive = 0;
  for (const p of rawPaths) {
    if (isSensitiveFile(p)) {
      filteredSensitive++;
    } else {
      kept.push(p);
    }
  }

  const offset = args.offset ?? 0;
  const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const limited = headLimit === 0 ? kept.slice(offset) : kept.slice(offset, offset + headLimit);
  const partial = bufferTruncated || timedOut || traversalWarning !== undefined;

  const pathClass = host.environment.pathClass;
  const shouldRelativize = isWithinDirectory(searchRoot, workspace.workspaceDir, pathClass);
  const candidates = limited.map((p) =>
    shouldRelativize ? relativizeIfUnder(p, searchRoot, pathClass) : p,
  );

  const warnings: string[] = [];
  if (timedOut) {
    warnings.push(
      `Glob timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s; partial results returned.`,
    );
  }
  if (bufferTruncated) {
    warnings.push(
      `[stdout truncated at ${String(MAX_OUTPUT_BYTES)} bytes; results may be incomplete — use a more specific pattern]`,
    );
  }
  if (traversalWarning !== undefined) {
    warnings.push(traversalWarning);
  }
  const pageNotices = (count: number, characterLimited: boolean): { lines: string[]; footer: string[] } => {
    const lines = [...warnings];
    const footer: string[] = [];
    const truncated = characterLimited || offset + count < kept.length;
    if (count === 0) {
      if (kept.length > 0) {
        const resultSet = partial ? 'collected partial result set' : 'current result set';
        lines.push(
          `No more matches at offset=${String(offset)} in the ${resultSet} (${String(kept.length)} matches).`,
        );
      } else if (partial) {
        lines.push('No matches collected; search incomplete.');
      } else if (filteredSensitive > 0) {
        lines.push(
          `No non-sensitive matches found (${String(filteredSensitive)} sensitive file(s) filtered).`,
        );
      } else {
        lines.push('No matches found');
      }
    } else if (truncated || offset > 0 || partial) {
      const total = partial
        ? `${String(kept.length)} collected matches (partial result set)`
        : String(kept.length);
      lines.push(`Showing matches ${String(offset + 1)}–${String(offset + count)} of ${total}.`);
    }
    if (characterLimited) lines.push('Character limit reached; only complete paths are returned.');
    if (truncated) {
      lines.push(
        `Continue with the same search arguments and offset=${String(offset + count)}.`,
      );
      if (!characterLimited) lines.push('To remove the match-count limit, omit offset and use head_limit=0.');
    }
    if (filteredSensitive > 0 && (kept.length > 0 || partial)) {
      footer.push(`Filtered ${String(filteredSensitive)} sensitive file(s).`);
    }
    if (!truncated && !partial && offset === 0 && headLimit > 0 && count === headLimit) {
      footer.push(`Found ${String(count)} matches`);
    }
    return { lines, footer };
  };
  const noticeChars = Math.max(...[false, true].map((characterLimited) => {
    const { lines, footer } = pageNotices(candidates.length, characterLimited);
    return [...lines, ...footer].join('\n').length + 2;
  }));
  let remaining = DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS - noticeChars;
  const displayLines: string[] = [];
  for (const path of candidates) {
    if (path.length + 1 > remaining) break;
    displayLines.push(path);
    remaining -= path.length + 1;
  }
  if (candidates.length > 0 && displayLines.length === 0) {
    return {
      text: 'Glob cannot fit a complete path and its diagnostics within the output limit. Narrow the search path or pattern.',
      isError: true,
    };
  }
  const notices = pageNotices(displayLines.length, displayLines.length < candidates.length);
  return { text: [...notices.lines, ...displayLines, ...notices.footer].join('\n') };
}

export function createGlobTool(props: CreateGlobToolProps): ToolDefinition {
  return {
    name: GLOB_TOOL_NAME,
    get description(): string {
      return props.host.environment.pathClass === 'win32'
        ? GLOB_DESCRIPTION + WINDOWS_PATH_HINT
        : GLOB_DESCRIPTION;
    },
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files.',
        },
        head_limit: {
          type: 'integer',
          minimum: 0,
          description:
            'Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.',
        },
        path: {
          type: 'string',
          description:
            'Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.',
        },
        include_ignored: {
          type: 'boolean',
          description:
            'Also match files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. VCS metadata directories (`.git` and similar) are always skipped, even when this is true. Defaults to false.',
        },
        include_dirs: {
          type: 'boolean',
          description:
            'Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.',
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
      const parsed = parseGlobArguments(toolCall.arguments);
      if (parsed.parseError !== undefined) {
        return errorText(parsed.parseError);
      }
      const args = parsed.args;
      await props.host.environment.ready;
      const workspace: WorkspaceConfig = {
        workspaceDir: props.workspace.workDir,
        additionalDirs: props.workspace.additionalDirs ?? [],
      };
      let searchRoot = workspace.workspaceDir;
      try {
        if (args.path !== undefined) {
          searchRoot = resolvePathAccessPath(args.path, {
            env: props.host.environment,
            workspace,
            operation: 'search',
            policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
          });
        }
      } catch (error) {
        if (error instanceof PathSecurityError) {
          return errorText(error.message);
        }
        throw error;
      }
      const finished = await executeGlob(props.host, workspace, args, signal, searchRoot);
      return {
        content: [{ type: 'text' as const, text: finished.text }],
        isError: finished.isError,
      };
    },
  };
}
