/**
 * GlobTool — file pattern matching.
 *
 * Finds files matching a glob pattern, returned sorted by modification
 * time (most recent first). Uses `kaos.glob`.
 *
 * Output convention: `content` shown to the LLM is relativized to the
 * search base only when the base is inside the primary workspace. External
 * roots stay absolute so downstream Read/Edit target the same file.
 *
 * Behaviour:
 *   - Brace expansion (`*.{ts,tsx}`, `{src,test}/**`) is expanded at
 *     this layer into a list of sub-patterns before handing each to
 *     `kaos.glob`. The kaos walker treats `{` / `}` as literals, so the
 *     fan-out has to happen here for any results to come back. Cartesian
 *     and one level of nesting are supported; unbalanced or comma-less
 *     braces fall through as literals.
 *   - `path` is validated by `resolvePathAccess` in `absolute-outside-allowed`
 *     mode. Explicit absolute paths outside the workspace are allowed; relative
 *     paths that escape the workspace stay rejected.
 *   - Match count is capped at `MAX_MATCHES` (unique paths). A separate
 *     `YIELD_SAFETY_CAP` on the raw yield stream is a secondary belt that
 *     still terminates the stream if the kaos layer's own symlink-cycle
 *     detection were ever absent or bypassed. Primary cycle defense lives
 *     in `packages/kaos/src/local.ts:_globWalk` via a path-local visited
 *     inode set. With brace expansion the legitimate yield volume scales
 *     with the number of sub-patterns, so the safety cap scales too.
 *   - Pre-rejection of pure-wildcard / `**`-leading patterns has been
 *     removed; the 100-match cap is the only safety against runaway
 *     enumeration. Callers are expected to add an anchor (extension,
 *     subdirectory) when 100 results would not be enough.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { normalize } from 'pathe';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { isWithinDirectory, resolvePathAccessPath } from '../../policies/path-access';
import type { PathClass } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import GLOB_DESCRIPTION from './glob.md?raw';

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

export const MAX_MATCHES = 100;

/**
 * Hard upper bound on the number of sub-patterns a single brace expansion
 * is allowed to produce. Generous enough for the common LLM patterns
 * (`*.{ts,tsx,js,jsx,mjs,cjs}` etc.) while still keeping pathological
 * cartesian inputs like `{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}` (= 64) from
 * fanning out unboundedly. Beyond this we fall through with the original
 * pattern unexpanded — kaos would then treat the braces as literals and
 * match zero, which is the right "obvious failure" signal for a pattern
 * the model probably did not mean.
 */
const MAX_BRACE_EXPANSIONS = 64;

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
 * Tells the model — before any round-trip — which patterns are accepted,
 * how brace expansion is handled, and which directories are too large to
 * recurse into. On a Windows backend the description also carries
 * `WINDOWS_PATH_HINT` (path-shape guidance).
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
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const searchRoots = [path ?? this.workspace.workspaceDir];

    const detailParts: string[] = [];
    detailParts.push(`pattern: ${args.pattern}`);
    if (args.path !== undefined) {
      detailParts.push(`path: ${args.path}`);
    }
    if (args.include_dirs === false) {
      detailParts.push('include_dirs: false');
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
      execute: () => this.execution(args, searchRoots),
    };
  }

  private async execution(args: GlobInput, searchRoots: string[]): Promise<ExecutableToolResult> {
    const subPatterns = expandBraces(args.pattern).map((p) =>
      hasGlobEscape(p) ? p : normalize(p),
    );

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
      //     depend on the kaos implementation for cycle safety. With
      //     brace expansion the legitimate yield volume scales with the
      //     number of sub-patterns (each is its own walk), so the cap
      //     scales too.
      const seen = new Set<string>();
      const entries: Array<{ path: string; mtime: number }> = [];
      const YIELD_SAFETY_CAP = MAX_MATCHES * 2 * subPatterns.length;
      let yielded = 0;
      let truncated = false;

      outer: for (const root of searchRoots) {
        for (const subPattern of subPatterns) {
          for await (const filePath of this.kaos.glob(root, subPattern)) {
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
      }

      entries.sort((a, b) => b.mtime - a.mtime);

      const paths = entries.map((e) => e.path);
      // Content shown to the LLM uses paths relative to the search base
      // to save tokens, but only for the primary workspace. Relative paths
      // are later resolved against workspaceDir, so additionalDir matches
      // must stay absolute to keep follow-up Read/Edit calls on the same file.
      const pathClass = this.kaos.pathClass();
      const relBase = searchRoots[0] ?? this.workspace.workspaceDir;
      const shouldRelativize = isWithinDirectory(relBase, this.workspace.workspaceDir, pathClass);
      const displayLines = paths.map((p) =>
        shouldRelativize ? relativizeIfUnder(p, relBase, pathClass) : p,
      );

      if (entries.length === 0 && !truncated) {
        return { output: 'No matches found' };
      }
      const lines: string[] = [];
      if (truncated) {
        lines.push(`[Truncated at ${String(MAX_MATCHES)} matches — ${String(seen.size)} matched so far, use a more specific pattern]`);
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

/**
 * Expand brace alternations (`{a,b,c}`, `{src,test}/**`) into a flat list
 * of sub-patterns. Recursive — handles cartesian products (`{a,b}/{c,d}.ts`
 * → 4 patterns) and one or more levels of nesting (`{a,{b,c}}.ts`).
 *
 * Falls through with the original pattern as a single-element list when:
 *   - the pattern contains no `{...}` group at all;
 *   - the pattern contains `{...}` groups but none have a top-level comma
 *     (e.g. `{abc}` — bash treats those as literal);
 *   - braces are unbalanced (a stray `{` with no matching `}`, etc.);
 *   - expansion would produce more than `MAX_BRACE_EXPANSIONS` patterns —
 *     pathological cartesian inputs (`{a,b}{c,d}{e,f}{g,h}{i,j}{k,l,m}`
 *     ≥ 192) bail out rather than fan out unboundedly.
 *
 * Backslash-escaped braces (`\{`, `\}`) are treated as literals and skip
 * the structural recognition so a user can opt out of expansion.
 */
export function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  if (!expandInto(pattern, out, MAX_BRACE_EXPANSIONS)) {
    // Cap exceeded somewhere down the recursion — discard partial
    // fan-out and report the original. Letting half the alternatives
    // through would be a silent footgun.
    return [pattern];
  }
  return out;
}

function hasGlobEscape(pattern: string): boolean {
  return /\\[{}[\]*?,]/.test(pattern);
}

function expandInto(pattern: string, out: string[], cap: number): boolean {
  // Find the first balanced `{...}` group containing a top-level comma.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      i++;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) {
        // Stray `}` — treat the whole pattern as literal.
        return pushLiteral(pattern, out, cap);
      }
      depth--;
      if (depth === 0 && start !== -1) {
        const inner = pattern.slice(start + 1, i);
        const parts = splitTopLevelCommas(inner);
        if (parts.length < 2) {
          // No commas at the top level → literal group; skip past it
          // and keep scanning for a real alternation further right.
          start = -1;
          continue;
        }
        const prefix = pattern.slice(0, start);
        const suffix = pattern.slice(i + 1);
        for (const part of parts) {
          if (out.length >= cap) return false;
          if (!expandInto(prefix + part + suffix, out, cap)) return false;
        }
        return true;
      }
    }
  }

  if (depth !== 0) {
    // Unbalanced `{` — treat the whole pattern as literal.
    return pushLiteral(pattern, out, cap);
  }

  return pushLiteral(pattern, out, cap);
}

function pushLiteral(pattern: string, out: string[], cap: number): boolean {
  if (out.length >= cap) return false;
  out.push(pattern);
  return true;
}

/**
 * Split on commas that sit at brace depth zero. Used by `expandBraces`
 * to slice a `{a,{b,c},d}` group into `["a", "{b,c}", "d"]` rather than
 * `["a", "{b", "c}", "d"]`.
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}
