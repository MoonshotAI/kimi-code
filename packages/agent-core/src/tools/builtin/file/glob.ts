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
 *     picomatch in-process.
 *   - `path` is validated by `resolvePathAccess` in `absolute-outside-allowed`
 *     mode. Explicit absolute paths outside the workspace are allowed; relative
 *     paths that escape the workspace stay rejected.
 *   - Match count is capped at `MAX_MATCHES`. Callers are expected to add an
 *     anchor (extension, subdirectory) when that would not be enough.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'pathe';
import picomatch from 'picomatch';
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

    const patternError = validateGlobPattern(args.pattern);
    if (patternError !== undefined) {
      return { isError: true, output: patternError };
    }

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

    const insideGitRepo =
      args.include_ignored === true ? true : await isInsideGitRepo(this.kaos, searchRoot);

    const pathClass = this.kaos.pathClass();
    const lineFilter = makeLineFilter(args.pattern, pathClass, searchRoot);

    let runResult = await runRipgrepOnce(execKaos, buildRgArgs(rgPath, args, insideGitRepo), signal, {
      abortedMessage: 'Glob aborted',
      lineFilter,
    });
    if (runResult.kind === 'tool-error') return runResult.result;
    if (shouldRetryRipgrepEagain(runResult)) {
      runResult = await runRipgrepOnce(
        execKaos,
        buildRgArgs(rgPath, args, insideGitRepo, true),
        signal,
        { abortedMessage: 'Glob aborted', lineFilter },
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

    // Filter by the user's positive glob pattern in-process. A positive
    // --glob would override ignore-file logic, so the pattern is not passed
    // to rg; instead rg --files enumerates non-ignored files and we filter
    // here to preserve both the pattern match and the ignore-file respect.
    // The streaming lineFilter already applied this filter before the cap,
    // but we re-check here as a safety net for any paths that slipped
    // through (e.g. broad patterns where the filter is skipped).
    const patternMatched = filterByPattern(rawPaths, searchRoot, args.pattern, pathClass);

    // Authoritative sensitive-file check (the rg prefilter is conservative).
    const kept: string[] = [];
    let filteredSensitive = 0;
    for (const p of patternMatched) {
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

function buildRgArgs(
  rgPath: string,
  args: GlobInput,
  insideGitRepo: boolean,
  singleThreaded = false,
): string[] {
  const cmd: string[] = [rgPath];
  if (singleThreaded) cmd.push('-j', '1');
  cmd.push('--files', '--hidden', '--sortr=modified');
  if (!insideGitRepo && args.include_ignored !== true) {
    cmd.push('--no-require-git');
  }
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    cmd.push('--glob', `!${dir}`);
  }
  // The user's positive pattern is NOT passed as --glob. A positive --glob
  // "always overrides any other ignore logic" (ripgrep docs), so it would
  // re-include files excluded by .gitignore/.ignore/.rgignore. Instead, let
  // rg --files enumerate non-ignored files and filter the results
  // in-process via matchUserPattern().
  for (const glob of SENSITIVE_GLOBS_TO_EXCLUDE) {
    cmd.push('--glob', `!${glob}`);
  }
  if (args.include_ignored) cmd.push('--no-ignore');
  // Search path is `.` because the process cwd is pinned to the search root
  // (see execution()). Passing a derived subdirectory as the rg PATH would
  // override ignore rules — rg treats command-line paths as authoritative,
  // so `rg --files dist` traverses a gitignored `dist/` even with `--glob
  // !dist`. It would also allow patterns like `../outside/**` to escape the
  // authorized search tree, and error out on non-existent prefixes. The
  // streaming line filter (makeLineFilter) already prevents the output cap
  // from being exhausted by non-matching paths, so narrowing the traversal
  // is not needed for correctness.
  cmd.push('.');
  return cmd;
}

function isBroadPattern(pattern: string): boolean {
  // rg treats an empty --glob as matching all files (respecting ignores),
  // so skip picomatch compilation for it — picomatch throws on empty input.
  return pattern === '' || pattern === '*' || pattern === '**' || pattern === '**/*';
}

/**
 * Compile a glob matcher for the user's pattern, using the same semantics
 * ripgrep's `--glob` would have applied:
 *   - Patterns without `/` match the basename at any depth.
 *   - Patterns with `/` match the relative path from the search root.
 *   - A leading `/` is stripped — ripgrep treats `/src/*.ts` as rooted at
 *     the search root, equivalent to `src/*.ts`.
 *   - `**` matches zero or more directory levels.
 *   - Dotfiles are matched (rg runs with `--hidden`).
 *   - Matching is case-sensitive, matching ripgrep's default (use
 *     `--glob-case-insensitive` / `--iglob` for case-insensitive mode).
 *   - Brace expansion (`*.{ts,tsx}`) is handled by picomatch natively.
 *
 * Returns a function that takes a relative path and returns whether it
 * matches. The picomatch matcher is compiled once so large trees don't
 * reparse the pattern on every line.
 */
function compileGlobMatcher(pattern: string): (relPath: string) => boolean {
  const opts = { dot: true };
  const rooted = pattern.startsWith('/');
  const normalizedPattern = rooted ? pattern.slice(1) : pattern;
  // Escape picomatch-only extensions that rg --glob does not support:
  //   - extglob: @(a|b), !(a), +(a), ?(a), *(a) — rg treats these as
  //     literal characters, not extended glob patterns.
  //   - range braces: {1..2} — rg treats {1..2} as a literal, not a range.
  // Brace alternatives like {ts,tsx} are still supported by both rg and
  // picomatch, so they are left intact.
  const escapedPattern = escapePicomatchExtensions(normalizedPattern);
  // A pattern without `/` matches the basename at any depth — unless the
  // original pattern was rooted with a leading `/`, in which case it
  // matches only at the search root (gitignore-style rooted globs).
  if (!normalizedPattern.includes('/') && !rooted) {
    const matcher = picomatch(escapedPattern, opts);
    return (relPath: string) => matcher(relPath.split('/').pop()!);
  }
  const matcher = picomatch(escapedPattern, opts);
  return (relPath: string) => matcher(relPath);
}

/**
 * Escape picomatch-only glob extensions that rg --glob does not support,
 * so the in-process matcher matches the same files rg would.
 *
 * - extglob constructs like @(a|b), !(a), +(a) are escaped so picomatch
 *   treats the prefix character and parentheses as literal. `@`, `!`, `+`
 *   are literal characters in rg's glob engine.
 * - `*` and `?` before `(` are NOT extglob prefixes in rg — they are
 *   regular wildcards, and `(` is a literal character. Only the
 *   parentheses are escaped so picomatch doesn't interpret `*(...)` or
 *   `?(...)` as extglobs, but the wildcard semantics of `*` and `?` are
 *   preserved.
 * - range braces like {1..2} are reduced to `1..2` (braces removed) to
 *   match rg, which treats a brace group with a single alternative (no
 *   comma) as that alternative with the braces stripped.
 * - brace alternatives like {ts,tsx} are left intact (supported by both),
 *   but empty alternatives ({,c} or {a,,b}) are dropped to match rg, which
 *   ignores them.
 * - braces inside character classes ([{a}]) are left intact — inside `[]`
 *   `{` and `}` are literal class members, not brace-group delimiters.
 */
function escapePicomatchExtensions(pattern: string): string {
  let result = pattern;
  // Escape extglob: [@!+](...) → literal prefix + literal parens.
  // `*` and `?` are wildcards in rg, so only the parens are escaped.
  result = result.replaceAll(/([@!?+*])\(([^)]*)\)/g, (_match, prefix: string, inner: string) => {
    const escapedInner = inner.replaceAll('|', '\\|');
    if (prefix === '*' || prefix === '?') {
      return `${prefix}\\(${escapedInner}\\)`;
    }
    return `[${prefix}]\\(${escapedInner}\\)`;
  });
  // Rewrite brace groups outside character classes. Inside `[]`, braces
  // are literal class members and must be preserved. rg also drops empty
  // alternatives (e.g. `ab{,c}` matches `abc` only, not `ab`), so they are
  // filtered out here to prevent picomatch from expanding them.
  result = rewriteBraces(result);
  return result;
}

/**
 * Rewrite brace groups in `pattern` to match rg's semantics:
 *   - Single-alternative braces `{foo}` → `foo` (braces stripped).
 *   - Comma alternatives with empty arms `{a,,b}` → `{a,b}` (empty arms
 *     dropped; if only one non-empty arm remains, braces are removed).
 *   - All-empty `{,,}` → empty string (braces removed, no content).
 *   - Nested brace groups `{a,{b,c}}` are left intact (both rg and
 *     picomatch expand them).
 *   - Escaped braces `\{...\}` are left intact.
 *   - Braces inside character classes `[{a}]` are left intact — inside
 *     `[]` they are literal class members, not group delimiters.
 */
function rewriteBraces(pattern: string): string {
  let result = '';
  let i = 0;
  let inBracket = false;
  let bracketContentStart = -1;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (inBracket) {
      result += ch;
      if (ch === '\\' && i + 1 < pattern.length) {
        result += pattern[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === ']') {
        // A `]` at the first content position is a literal, not the
        // terminator (mirrors validateGlobPattern logic).
        if (i !== bracketContentStart) inBracket = false;
      }
      i++;
      continue;
    }
    if (ch === '[') {
      inBracket = true;
      const next = pattern[i + 1];
      bracketContentStart = next === '!' || next === '^' ? i + 2 : i + 1;
      result += ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < pattern.length) {
      result += ch + (pattern[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '{') {
      // Scan forward to the matching `}`, respecting escaped chars.
      let depth = 1;
      let j = i + 1;
      while (j < pattern.length && depth > 0) {
        const cj = pattern[j]!;
        if (cj === '\\' && j + 1 < pattern.length) {
          j += 2;
          continue;
        }
        if (cj === '{') depth++;
        else if (cj === '}') depth--;
        if (depth > 0) j++;
      }
      if (depth !== 0) {
        // Unclosed brace — keep as-is (validator will catch it).
        result += ch;
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, j);
      // Nested brace groups are left intact (both rg and picomatch
      // expand them).
      if (inner.includes('{') || inner.includes('}')) {
        result += pattern.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (inner.includes(',')) {
        const nonEmpty = inner.split(',').filter((a) => a !== '');
        if (nonEmpty.length === 0) {
          // All alternatives empty — rg strips to empty string.
        } else if (nonEmpty.length === 1) {
          result += nonEmpty[0]!;
        } else {
          result += `{${nonEmpty.join(',')}}`;
        }
      } else {
        // Single alternative — rg strips the braces.
        result += inner;
      }
      i = j + 1;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Filter absolute paths from `rg --files` against the user's positive glob
 * pattern. Broad patterns (star, double-star, star-slash-star) match
 * everything, so the filter is skipped for those. Returns the filtered list
 * in the same order. On Windows, the search root and absolute paths are
 * case-normalized only to compute the relative path boundary — the original-
 * case relative path is then used for case-sensitive pattern matching.
 */
function filterByPattern(
  absPaths: string[],
  searchRoot: string,
  pattern: string,
  pathClass: PathClass,
): string[] {
  if (isBroadPattern(pattern)) return absPaths;
  const matches = compileGlobMatcher(pattern);
  const result: string[] = [];
  for (const absPath of absPaths) {
    const rel = relativePath(searchRoot, absPath, pathClass);
    if (rel === undefined) continue;
    if (matches(rel)) result.push(absPath);
  }
  return result;
}

/**
 * Compute the relative path from `searchRoot` to `absPath`, preserving the
 * original casing of `absPath`. On Windows, the root and path are compared
 * case-insensitively to find the boundary, but the returned relative path
 * keeps the original case so case-sensitive glob matching works correctly.
 * Returns `undefined` if `absPath` is not under `searchRoot`.
 */
function relativePath(searchRoot: string, absPath: string, pathClass: PathClass): string | undefined {
  const normAbs = normalize(absPath);
  const normRoot = normalize(searchRoot);
  if (pathClass !== 'win32') {
    const rel = relative(normRoot, normAbs);
    // Only reject paths that actually escape the root: `..` (the parent
    // itself) or `../…` (something inside the parent). A file whose name
    // starts with two dots — e.g. `..config/a.ts` — is under the root and
    // must be kept.
    return rel === '..' || rel.startsWith('../') ? undefined : rel;
  }
  const lowerAbs = normAbs.toLowerCase();
  const lowerRoot = normRoot.toLowerCase();
  if (lowerAbs === lowerRoot) return '.';
  const prefix = lowerRoot.endsWith('/') ? lowerRoot : lowerRoot + '/';
  if (!lowerAbs.startsWith(prefix)) return undefined;
  return normAbs.slice(prefix.length);
}

/**
 * Build a streaming line filter for `runRipgrepOnce` that applies the user's
 * glob pattern to each path line before it counts toward the output cap.
 * Returns `undefined` for broad patterns (no filtering needed) so the
 * original byte-level cap path is used.
 *
 * rg runs with cwd pinned to the search root, so each line is normally a
 * relative path like `./src/a.ts` (POSIX) or `.\src\a.ts` (Windows). The
 * filter strips the leading `./` or `.\` and normalizes backslashes to
 * forward slashes on Windows before matching. If the line is an absolute
 * path (e.g. from a test mock or an external root), it is made relative to
 * the search root first, preserving original case for pattern matching.
 */
function makeLineFilter(
  pattern: string,
  pathClass: PathClass,
  searchRoot: string,
): ((line: string) => boolean) | undefined {
  if (isBroadPattern(pattern)) return undefined;
  const matches = compileGlobMatcher(pattern);
  return (line: string): boolean => {
    let relPath = line;
    if (pathClass === 'win32') relPath = relPath.replaceAll('\\', '/');
    if (relPath.startsWith('./') || relPath.startsWith('.\\')) {
      relPath = relPath.slice(2);
    } else if (isAbsolute(relPath)) {
      const rel = relativePath(searchRoot, relPath, pathClass);
      if (rel === undefined) return false;
      relPath = rel;
    }
    return matches(relPath);
  };
}

/**
 * Validate a glob pattern for common malformed syntax. Returns an error
 * message if the pattern is invalid, or `undefined` if it is well-formed.
 * This mirrors ripgrep's globset parser, which rejects these with a hard
 * error — picomatch would silently treat them as literals and report "No
 * matches found" instead.
 *
 * Detected errors:
 *   - Unclosed `[` or `{` (balanced tracking).
 *   - Empty character class: `[]`, `[!]`, `[^]` — a `]` right after the
 *     opening bracket prefix (`[`, `[!`, `[^`) is a literal `]`, not the
 *     terminator, so the class is unclosed.
 *   - Invalid range: `[z-a]` where the start character is greater than the
 *     end character.
 *   - Dangling backslash: a trailing `\` with no character to escape.
 *
 * Braces inside a character class (`[{]foo`) are literal characters and do
 * not count toward brace depth.
 */
function validateGlobPattern(pattern: string): string | undefined {
  let inBracket = false;
  let bracketDepth = 0;
  let braceDepth = 0;
  // Position of the first content character inside the current bracket
  // (after `[`, `[!`, or `[^`). A `]` at this position is a literal, not
  // the class terminator.
  let bracketContentStart = -1;
  // Last unescaped character seen inside the current bracket, for range
  // validation. Reset to '' on bracket open or after an escape.
  let bracketPrevChar = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      if (i === pattern.length - 1) {
        return `Invalid glob pattern: dangling '\\' in "${pattern}"`;
      }
      i++;
      bracketPrevChar = '';
      continue;
    }
    if (inBracket) {
      if (ch === ']') {
        if (i === bracketContentStart) {
          // Literal ] — the class is still open.
          bracketPrevChar = ']';
          continue;
        }
        inBracket = false;
        bracketDepth--;
        bracketPrevChar = '';
      } else if (ch === '-' && bracketPrevChar !== '' && bracketPrevChar !== '-') {
        const nextCh = pattern[i + 1];
        if (nextCh !== undefined && nextCh !== ']' && nextCh !== '\\') {
          if (bracketPrevChar > nextCh) {
            return `Invalid glob pattern: invalid range '${bracketPrevChar}-${nextCh}' in "${pattern}"`;
          }
        }
      } else {
        bracketPrevChar = ch;
      }
    } else if (ch === '[') {
      inBracket = true;
      bracketDepth++;
      const next = pattern[i + 1];
      bracketContentStart = next === '!' || next === '^' ? i + 2 : i + 1;
      bracketPrevChar = '';
    } else if (ch === '{') {
      braceDepth++;
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth--;
    }
  }
  if (bracketDepth > 0) return `Invalid glob pattern: unclosed '[' in "${pattern}"`;
  if (braceDepth > 0) return `Invalid glob pattern: unclosed '{' in "${pattern}"`;
  return undefined;
}

async function isInsideGitRepo(kaos: Kaos, searchRoot: string): Promise<boolean> {
  let current = kaos.normpath(searchRoot);
  for (;;) {
    if (await pathExists(kaos, join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function pathExists(kaos: Kaos, path: string): Promise<boolean> {
  try {
    await kaos.stat(path);
    return true;
  } catch {
    return false;
  }
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
