/**
 * GlobTool — file pattern matching via ripgrep.
 *
 * Finds files matching a glob pattern, returned sorted by modification
 * time (most recent first). Implemented by shelling out to `rg --files`
 * through Kaos — sharing the ripgrep binary, subprocess plumbing, and
 * gitignore / sensitive-file handling with GrepTool.
 *
 * Output convention: `content` shown to the LLM is relativized to the
 * search base only when the base is inside the primary workspace. External
 * roots stay absolute so downstream Read/Edit target the same file.
 *
 * Behaviour:
 *   - `.gitignore` / `.ignore` / `.rgignore` are respected by default
 *     (ripgrep native). Pass `include_ignored` to also surface ignored
 *     files (e.g. build outputs, `node_modules`). Sensitive files such
 *     as `.env` are always filtered out.
 *   - Brace expansion (`*.{ts,tsx}`, `{src,test}/**`) is handled by
 *     ripgrep's glob engine.
 *   - `path` is validated by `resolvePathAccess` in `absolute-outside-allowed`
 *     mode. Explicit absolute paths outside the workspace are allowed; relative
 *     paths that escape the workspace stay rejected.
 *   - Match count is capped at `MAX_MATCHES`. Callers are expected to add an
 *     anchor (extension, subdirectory) when that would not be enough.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { normalize, resolve } from 'pathe';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { isAbortError } from '../../../loop/errors';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { noopTelemetryClient, type TelemetryClient } from '../../../telemetry';
import { isWithinDirectory, resolvePathAccessPath } from '../../policies/path-access';
import type { PathClass } from '../../policies/path-access';
import { isSensitiveFile } from '../../policies/sensitive';
import { toInputJsonSchema } from '../../support/input-schema';
import { ensureRgPath, rgUnavailableMessage } from '../../support/rg-locator';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  SENSITIVE_GLOBS_TO_EXCLUDE,
  VCS_DIRECTORIES_TO_EXCLUDE,
  runRipgrepOnce,
  shouldRetryRipgrepEagain,
} from '../../support/run-rg';
import type { WorkspaceConfig } from '../../support/workspace';
import GLOB_DESCRIPTION from './glob.md?raw';

export const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files.'),
  path: z
    .string()
    .optional()
    .describe(
      'Absolute path to the directory to search in. Defaults to the current working directory.',
    ),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      'Also match files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. Defaults to false.',
    ),
  include_dirs: z
    .boolean()
    .optional()
    .describe(
      'Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.',
    ),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

export const MAX_MATCHES = 100;

/**
 * Path-shape hint appended to the tool description only on a Windows
 * (`win32` path class) backend. The `path` argument accepts both native
 * Windows paths and POSIX-style paths, but matched paths come back in
 * Windows backslash form — a command run through Bash must convert them
 * to forward slashes first. Injected conditionally so non-Windows
 * sessions are not shown a hint that does not apply to them.
 */
export const WINDOWS_PATH_HINT =
  '\n\nWindows note: the `path` argument accepts both Windows paths ' +
  '(e.g. `C:\\Users\\foo`) and POSIX-style paths (e.g. `/c/Users/foo`). Matched paths are ' +
  'returned in Windows backslash form; convert them to forward slashes before ' +
  'using them in a Bash command.';

// POSIX mode bits for the search-root directory check.
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/**
 * Tool-level description shown to the LLM at tool declaration time.
 * Tells the model — before any round-trip — which patterns are accepted,
 * how brace expansion is handled, and which directories are too large to
 * recurse into. On a Windows backend the description also carries
 * `WINDOWS_PATH_HINT` (path-shape guidance).
 */
export class GlobTool implements BuiltinTool<GlobInput> {
  readonly name = 'Glob' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GlobInputSchema);
  private readonly telemetry: TelemetryClient;
  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    telemetry: TelemetryClient = noopTelemetryClient,
  ) {
    this.telemetry = telemetry;
    this.description =
      this.kaos.pathClass() === 'win32'
        ? GLOB_DESCRIPTION + WINDOWS_PATH_HINT
        : GLOB_DESCRIPTION;
  }

  resolveExecution(args: GlobInput): ToolExecution {
    let path: string | undefined;
    if (args.path !== undefined) {
      path = resolvePathAccessPath(args.path, {
        kaos: this.kaos,
        workspace: this.workspace,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const searchRoots = [path ?? this.workspace.workspaceDir];

    const detailParts: string[] = [`pattern: ${args.pattern}`];
    if (args.path !== undefined) {
      detailParts.push(`path: ${args.path}`);
    }
    if (args.include_ignored === true) {
      detailParts.push('include_ignored: true');
    }

    return {
      accesses: ToolAccesses.searchTree(searchRoots[0]!),
      description: `Searching ${args.pattern}`,
      display: {
        kind: 'file_io',
        operation: 'glob',
        path: searchRoots[0]!,
        detail: detailParts.join(', '),
      },
      approvalRule: literalRulePattern(this.name, args.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
      execute: ({ signal }) => this.execution(args, signal, searchRoots),
    };
  }

  private async execution(
    args: GlobInput,
    signal: AbortSignal,
    searchRoots: string[],
  ): Promise<ExecutableToolResult> {
    const searchRoot = searchRoots[0] ?? this.workspace.workspaceDir;

    // Validate the search root is a directory. `rg --files <file>` exits 0
    // and lists the file itself, so without this check a file root would be
    // returned as its own match instead of rejected. A missing root surfaces
    // here as "does not exist".
    try {
      const st = await this.kaos.stat(searchRoot);
      if ((st.stMode & S_IFMT) !== S_IFDIR) {
        return { isError: true, output: `${searchRoot} is not a directory` };
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { isError: true, output: `${searchRoot} does not exist` };
      }
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }

    let rgPath: string;
    try {
      const resolution = await ensureRgPath({ signal });
      rgPath = resolution.path;
      if (resolution.source !== 'system-path') {
        this.telemetry.track('glob_tool_rg_fallback', {
          source: resolution.source,
          outcome: 'resolved',
        });
      }
    } catch (error) {
      if (isAbortError(error)) {
        return { isError: true, output: 'Glob aborted' };
      }
      this.telemetry.track('glob_tool_rg_fallback', { outcome: 'failed' });
      return { isError: true, output: rgUnavailableMessage(error) };
    }

    // Run rg with its cwd pinned to the search root and `.` as the search
    // path. ripgrep matches `--glob` patterns against the path *as passed to
    // rg*, so with an absolute search path a pattern containing a `/` (e.g.
    // `src/**/*.ts`) is matched against the absolute path and never matches.
    // Running from the search root makes glob matching relative to it.
    const execKaos = this.kaos.withCwd(searchRoot);

    let runResult = await runRipgrepOnce(
      execKaos,
      buildRgArgs(rgPath, args),
      signal,
      { abortedMessage: 'Glob aborted' },
    );
    if (runResult.kind === 'tool-error') return runResult.result;
    if (shouldRetryRipgrepEagain(runResult)) {
      runResult = await runRipgrepOnce(
        execKaos,
        buildRgArgs(rgPath, args, true),
        signal,
        { abortedMessage: 'Glob aborted' },
      );
      if (runResult.kind === 'tool-error') return runResult.result;
    }

    const { exitCode, stdoutText, stderrText, bufferTruncated, timedOut } = runResult;

    // rg exit codes: 0 = matches, 1 = no matches, 2+ = error. Timeout
    // kills usually surface as a signal exit code; keep any partial paths.
    // If rg returned complete paths before failing on a traversal error such
    // as an unreadable subdirectory, keep those paths and surface a warning
    // instead of failing the whole search. If no complete path was produced,
    // treat stderr as authoritative (invalid glob, spawn failure, etc.).
    let traversalWarning: string | undefined;
    if (exitCode !== 0 && exitCode !== 1 && !timedOut) {
      const rawPathsBeforeError = splitCompletePaths(stdoutText, true);
      if (rawPathsBeforeError.length === 0) {
        return { isError: true, output: formatGlobError(searchRoot, stderrText) };
      }
      traversalWarning = formatGlobWarning(stderrText);
    }
    if (signal.aborted) {
      return { isError: true, output: 'Glob aborted' };
    }

    // One path per line from `rg --files`. When stdout is capped or the run
    // timed out, the final chunk can cut a path in half; drop any trailing
    // line that lacks its terminating newline so a half-written path is never
    // surfaced as a match. Mirrors GrepTool's omitIncompleteTrailingRecord.
    // rg reports paths relative to its cwd (the search root), e.g.
    // `./src/a.ts`; resolve them back to absolute paths so the sensitive-file
    // check, workspace relativization, and display all keep working on
    // absolute paths as before.
    const rawPaths = splitCompletePaths(stdoutText, bufferTruncated || timedOut).map((p) =>
      resolve(searchRoot, p),
    );

    // Authoritative sensitive-file check (the rg prefilter is conservative).
    const kept: string[] = [];
    let filteredSensitive = 0;
    for (const p of rawPaths) {
      if (isSensitiveFile(p)) {
        filteredSensitive++;
      } else {
        kept.push(p);
      }
    }

    const truncated = kept.length > MAX_MATCHES;
    const limited = truncated ? kept.slice(0, MAX_MATCHES) : kept;

    if (limited.length === 0 && !timedOut) {
      if (filteredSensitive > 0) {
        return {
          output: `No non-sensitive matches found (${String(filteredSensitive)} sensitive file(s) filtered).`,
        };
      }
      return { output: 'No matches found' };
    }

    // Content shown to the LLM uses paths relative to the search base to
    // save tokens, but only for the primary workspace. Relative paths are
    // later resolved against workspaceDir, so additionalDir matches stay
    // absolute to keep follow-up Read/Edit calls on the same file.
    const pathClass = this.kaos.pathClass();
    const shouldRelativize = isWithinDirectory(searchRoot, this.workspace.workspaceDir, pathClass);
    const displayLines = limited.map((p) =>
      shouldRelativize ? relativizeIfUnder(p, searchRoot, pathClass) : p,
    );

    const lines: string[] = [];
    if (timedOut) {
      lines.push(
        `Glob timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s; partial results returned.`,
      );
    }
    if (bufferTruncated) {
      lines.push(
        `[stdout truncated at ${String(MAX_OUTPUT_BYTES)} bytes; results may be incomplete — use a more specific pattern]`,
      );
    }
    if (traversalWarning !== undefined) {
      lines.push(traversalWarning);
    }
    if (truncated) {
      lines.push(`[Truncated at ${String(MAX_MATCHES)} matches — use a more specific pattern]`);
      lines.push(`Only the first ${String(MAX_MATCHES)} matches are returned.`);
    }
    lines.push(...displayLines);
    if (filteredSensitive > 0) {
      lines.push(`Filtered ${String(filteredSensitive)} sensitive file(s).`);
    }
    if (!truncated && limited.length === MAX_MATCHES) {
      lines.push(`Found ${String(limited.length)} matches`);
    }
    return { output: lines.join('\n') };
  }
}

function buildRgArgs(rgPath: string, args: GlobInput, singleThreaded = false): string[] {
  const cmd: string[] = [rgPath];
  if (singleThreaded) cmd.push('-j', '1');
  cmd.push('--files', '--hidden', '--sortr=modified');
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    cmd.push('--glob', `!${dir}`);
  }
  // Positive pattern first, then sensitive-file exclusions so a broad
  // pattern cannot re-include a sensitive path.
  cmd.push('--glob', args.pattern);
  for (const glob of SENSITIVE_GLOBS_TO_EXCLUDE) {
    cmd.push('--glob', `!${glob}`);
  }
  if (args.include_ignored) cmd.push('--no-ignore');
  // Search path is `.` because the process cwd is pinned to the search root
  // (see execution()); this keeps `--glob` matching relative to that root.
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

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Split `rg --files` stdout into complete paths. When the run was capped or
 * timed out (`truncatedOutput`), a path cut mid-write lacks its terminating
 * newline; drop that trailing fragment so it is never surfaced as a match.
 * Complete output always ends in `\n`, so the split is lossless in that case.
 */
export function splitCompletePaths(stdoutText: string, truncatedOutput: boolean): string[] {
  let text = stdoutText;
  if (truncatedOutput && !text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
  }
  return text.split('\n').filter((p) => p.length > 0);
}

/**
 * If `candidate` is under `base`, return the portion after `base/`.
 * Otherwise return `candidate` unchanged (absolute). Both arguments
 * should be canonical absolute paths.
 */
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
