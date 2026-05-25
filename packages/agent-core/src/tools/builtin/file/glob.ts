/**
 * GlobTool — file pattern matching.
 *
 * Finds files matching a glob pattern, returned sorted by modification
 * time (most recent first). Uses `kaos.glob`.
 *
 * Output convention: `content` shown to the LLM is relativized to the
 * search base to save tokens; `output.paths` keeps absolute paths so
 * downstream Read/Edit can consume them directly.
 *
 * Safety rails:
 *   - Pure-wildcard patterns (nothing but `*` / `?` / `/`) are rejected
 *     because they have no literal anchor — they would enumerate every
 *     file under the search root and exhaust the caller's context on
 *     large trees. Examples: `**`, `** / *`, `** / **`, `* / *`.
 *     Constrained patterns (with any literal anchor such as an extension
 *     or subdirectory) are allowed — the literal bounds the result set.
 *   - Patterns using brace expansion (`{a,b,c}`) are rejected up-front
 *     because the underlying `_globWalk` treats `{` / `}` as literals,
 *     so such patterns would silently match zero files.
 *   - `path` is validated by `resolvePathAccess` in strict mode. Explicit
 *     paths must be absolute and within the workspace roots.
 *   - match count is capped at `MAX_MATCHES`; a separate `YIELD_SAFETY_CAP`
 *     (MAX_MATCHES × 2) on the raw yield stream is a secondary belt that
 *     still terminates the stream if the kaos layer's own symlink-cycle
 *     detection were ever absent or bypassed. Primary cycle defense lives
 *     in `packages/kaos/src/local.ts:_globWalk` via a path-local visited
 *     inode set.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import type { PathClass } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { listDirectory } from '../../support/list-directory';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import GLOB_DESCRIPTION from './glob.md';

export const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files/directories.'),
  path: z
    .string()
    .optional()
    .describe(
      'Absolute path to the directory to search in. Defaults to the current working directory.',
    ),
  include_dirs: z
    .boolean()
    .default(true)
    .optional()
    .describe(
      'Whether to include directories in results. Defaults to true. Set false to return only files.',
    ),
});

export type GlobInput = z.Infer<typeof GlobInputSchema>;

export const MAX_MATCHES = 1000;

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

// POSIX mode bits — same constants used by KaosPath.isDir (packages/kaos/src/path.ts:199).
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/**
 * Tool-level description shown to the LLM at tool declaration time.
 * Tells the model — before any round-trip — which patterns are
 * accepted, which are rejected, and which directories are too large to
 * recurse into. Patterns with a literal anchor before a double-star are
 * allowed; pure-wildcard patterns (a bare double-star or a double-star
 * followed by `/<wildcard>`) are rejected outright. On a Windows backend
 * the description also carries `WINDOWS_PATH_HINT` (path-shape guidance).
 */
export class GlobTool implements BuiltinTool<GlobInput> {
  readonly name = 'Glob' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GlobInputSchema);
  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {
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
        policy: { guardMode: 'strict', checkSensitive: false },
      });
    }
    const searchRoots = [path ?? this.workspace.workspaceDir];
    return {
      accesses: ToolAccesses.searchTree(searchRoots[0]!),
      description: `Searching ${args.pattern}`,
      display: { kind: 'file_io', operation: 'glob', path: searchRoots[0]! },
      approvalRule: literalRulePattern(this.name, args.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
      execute: () => this.execution(args, searchRoots),
    };
  }

  private async execution(args: GlobInput, searchRoots: string[]): Promise<ExecutableToolResult> {
    if (startsWithDoubleStarPrefix(args.pattern)) {
      let tree: string;
      try {
        tree = await listDirectory(this.kaos, this.workspace.workspaceDir);
      } catch {
        tree = '(listing unavailable)';
      }
      return {
        isError: true,
        output:
          `Pattern "${args.pattern}" starts with '**' which is not allowed — ` +
          `the leading '**/' has no literal anchor in front of it and would ` +
          `enumerate every file under the search root, typically exhausting ` +
          `the caller's context on large trees. Use more specific patterns ` +
          `instead, such as "src/**/*.py" or "test/**/*.py".\n\n` +
          `Top of ${this.workspace.workspaceDir}:\n${tree}`,
      };
    }

    if (isPureWildcard(args.pattern)) {
      const allowedRoots = [this.workspace.workspaceDir, ...this.workspace.additionalDirs];
      const rootList = allowedRoots.map((d) => `  - ${d}`).join('\n');
      let tree: string;
      try {
        tree = await listDirectory(this.kaos, this.workspace.workspaceDir);
      } catch {
        tree = '(listing unavailable)';
      }
      return {
        isError: true,
        output:
          `Pattern "${args.pattern}" is a pure wildcard (only \`*\`, \`?\`, \`**\`, \`/\`) ` +
          `and would enumerate every file under the search root — with no literal ` +
          `anchor to bound the result set, this typically exhausts your context on ` +
          `large trees. Add an extension ` +
          `("${args.pattern === '**' || args.pattern === '**/*' ? '**/*.ts' : '**/*.md'}") ` +
          `or a subdirectory ("src/**/*.ts") to constrain the walk.\n\n` +
          `Allowed roots for explicit path searches:\n${rootList}\n\n` +
          `Top of ${this.workspace.workspaceDir}:\n${tree}`,
      };
    }

    if (containsBraceExpansion(args.pattern)) {
      return {
        isError: true,
        output:
          `Pattern "${args.pattern}" uses brace expansion (\`{a,b,...}\`), which ` +
          `is not supported by this Glob tool. Split it into separate calls, ` +
          `one pattern per alternative. For example, instead of "*.{ts,tsx}" ` +
          `issue two calls: "*.ts" and "*.tsx".`,
      };
    }

    // Default true. When false, directories yielded by kaos are
    // filtered out using the same stat that fuels the mtime sort
    // (no second stat per path).
    const includeDirs = args.include_dirs ?? true;

    // kaos.glob silently returns empty for missing or non-directory roots
    // (its _globWalk catches the readdir failure and exits without yielding).
    // Without this pre-check, a Glob against a missing path would report
    // "No matches found" instead of "does not exist", and the model would
    // not realize the search root itself was wrong. iterdir is the right
    // signal: pulling one entry triggers the same readdir that kaos.glob
    // would do, so ENOENT/ENOTDIR surface here for the realistic backends
    // before the walker is invoked. Any other failure (e.g. an unmocked
    // test backend that throws "not implemented") falls through silently
    // so the existing kaos.glob path still runs.
    for (const root of searchRoots) {
      try {
        const iter = this.kaos.iterdir(root);
        await iter.next();
        if (typeof iter.return === 'function') {
          await iter.return(undefined);
        }
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error) {
          const code = (error as { code?: string }).code;
          if (code === 'ENOENT') {
            return { isError: true, output: `${root} does not exist` };
          }
          if (code === 'ENOTDIR') {
            return { isError: true, output: `${root} is not a directory` };
          }
        }
        // Unknown failure (including unmocked test backends): fall
        // through and let kaos.glob run; it will either yield results
        // or its own catch path will surface the error.
      }
    }

    try {
      // Two counters, two jobs:
      //   - `entries.length` caps the *unique* paths we return, so a
      //     truncation warning only fires after MAX_MATCHES real hits.
      //   - `yielded` counts every path the kaos stream emits, including
      //     duplicates. Secondary safety belt: the kaos `_globWalk`
      //     itself detects symlink cycles, so a well-formed kaos layer
      //     never re-yields the same real
      //     file. `yielded` still terminates the stream if that primary
      //     defense were ever absent or bypassed (e.g. a future kaos
      //     backend without inode tracking), so the tool layer doesn't
      //     depend on the kaos implementation for cycle safety.
      const seen = new Set<string>();
      const entries: Array<{ path: string; mtime: number }> = [];
      const YIELD_SAFETY_CAP = MAX_MATCHES * 2;
      let yielded = 0;
      let truncated = false;

      outer: for (const root of searchRoots) {
        for await (const filePath of this.kaos.glob(root, args.pattern)) {
          yielded++;
          if (yielded >= YIELD_SAFETY_CAP) {
            truncated = true;
            break outer;
          }
          if (seen.has(filePath)) continue;
          if (entries.length >= MAX_MATCHES) {
            truncated = true;
            break outer;
          }
          seen.add(filePath);
          let mtime = 0;
          let isDir = false;
          try {
            const st = await this.kaos.stat(filePath);
            mtime = st.stMtime ?? 0;
            isDir = (st.stMode & S_IFMT) === S_IFDIR;
          } catch {
            // stat failure — use 0 mtime / assume file so it still surfaces
          }
          // Apply include_dirs *after* marking seen so a filtered dir
          // doesn't re-enter via a later duplicate yield, and *before*
          // pushing to entries so MAX_MATCHES continues to cap output
          // (not pre-filter) size.
          if (!includeDirs && isDir) continue;
          entries.push({ path: filePath, mtime });
        }
      }

      entries.sort((a, b) => b.mtime - a.mtime);

      const paths = entries.map((e) => e.path);
      // Content shown to the LLM uses paths relative to the search base
      // to save tokens; `output.paths` keeps the absolute form so callers
      // can feed them into Read/Edit without further resolution.
      const pathClass = this.kaos.pathClass();
      const relBase = searchRoots[0] ?? this.workspace.workspaceDir;
      const displayLines = paths.map((p) => relativizeIfUnder(p, relBase, pathClass));

      if (entries.length === 0 && !truncated) {
        return { output: 'No matches found' };
      }
      const lines: string[] = [];
      if (truncated) {
        lines.push(`[Truncated at ${String(MAX_MATCHES)} matches — use a more specific pattern]`);
        lines.push(`Only the first ${String(MAX_MATCHES)} matches are returned.`);
      }
      lines.push(...displayLines);
      if (!truncated && entries.length === MAX_MATCHES) {
        lines.push(`Found ${String(entries.length)} matches`);
      }
      return { output: lines.join('\n') };
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error) {
        const code = (error as { code?: string }).code;
        const path = searchRoots[0] ?? this.workspace.workspaceDir;
        if (code === 'ENOENT') {
          return { isError: true, output: `${path} does not exist` };
        }
        if (code === 'ENOTDIR') {
          return { isError: true, output: `${path} is not a directory` };
        }
      }
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }
  }

}

/**
 * If `candidate` is under `base`, return the portion after `base/`.
 * Otherwise return `candidate` unchanged (absolute). Both arguments
 * should be canonical absolute paths.
 */
function relativizeIfUnder(candidate: string, base: string, pathClass: PathClass): string {
  const sep = pathClass === 'win32' ? '\\' : '/';
  const comparableCandidate = pathClass === 'win32' ? candidate.toLowerCase() : candidate;
  const comparableBase = pathClass === 'win32' ? base.toLowerCase() : base;
  if (comparableCandidate === comparableBase) return '.';
  const prefix = comparableBase.endsWith(sep) ? comparableBase : comparableBase + sep;
  if (comparableCandidate.startsWith(prefix)) {
    return candidate.slice(prefix.length);
  }
  return candidate;
}

// Return true iff `pattern` begins with the literal sequence `**` followed
// by a `/`. Such patterns have no literal anchor in front of the recursive
// wildcard, so the walk has nothing to bound it on the left and would
// descend into every top-level directory of the search root before any
// suffix constraint can filter. Rejected up-front to match the Python Glob
// behavior — callers must anchor with a top-level subdirectory.
function startsWithDoubleStarPrefix(pattern: string): boolean {
  return pattern.startsWith('**/');
}

/**
 * Return true if `pattern` is pure wildcards — only `*`, `?`, `**`, `/`.
 * Such patterns have no literal anchor and would enumerate every file
 * under the search root. Backslash-escaped characters (`\X`) count as
 * literals so `\*` or `\?` still means "pattern has an anchor".
 */
function isPureWildcard(pattern: string): boolean {
  if (pattern === '') return false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      // escaped literal — pattern has an anchor
      return false;
    }
    if (ch !== '*' && ch !== '?' && ch !== '/') {
      return false;
    }
  }
  return true;
}

/** Return true iff `pattern` looks like it uses `{a,b,c}` brace expansion. */
function containsBraceExpansion(pattern: string): boolean {
  let inBrace = false;
  let sawCommaInsideBrace = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      i++;
      continue;
    }
    if (ch === '{') {
      inBrace = true;
      sawCommaInsideBrace = false;
      continue;
    }
    if (ch === '}') {
      if (inBrace && sawCommaInsideBrace) return true;
      inBrace = false;
      continue;
    }
    if (ch === ',' && inBrace) sawCommaInsideBrace = true;
  }
  return false;
}
