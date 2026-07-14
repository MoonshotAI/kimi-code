/**
 * `fileTools` domain — GlobTool, file pattern matching via ripgrep.
 *
 * Finds files matching a glob pattern, returned sorted by modification time
 * (most recent first). Implemented by shelling out to `rg --files` through the
 * host `IHostProcessService` — sharing the ripgrep subprocess plumbing,
 * gitignore handling, and sensitive-file filtering with the Grep domain.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/glob.ts`) onto
 * the v2 os domains:
 *   - Search: v1 `kaos.exec(rgPath, ...)` maps to
 *     `this.processService.spawn(rgPath, [...], { cwd: searchRoot })`. Pinning
 *     the subprocess cwd to the search root so `--glob` patterns match paths
 *     relative to that root.
 *   - Binary resolution: `ensureRgPath` (`./rgLocator`) probes the execution
 *     environment for a working `rg` (system PATH, then the cached bootstrap
 *     binary) so a missing `rg` surfaces an actionable message instead of a
 *     naked `spawn rg ENOENT`.
 *   - Subprocess plumbing: `runRgOnce` / `shouldRetryRipgrepEagain`
 *     (`./runRg`) own spawn, capped draining, abort/timeout, two-phase kill,
 *     and the single-threaded EAGAIN retry shared with v1's run-rg.
 *   - Directory pre-check: `fs.stat(searchRoot)` surfaces a missing or
 *     non-directory root as "does not exist" / "is not a directory" instead of
 *     a misleading "No matches found" (or, for a file root, rg listing the
 *     file itself as its own match).
 *   - Path safety / home expansion / path class: `resolvePathAccessPath` over
 *     the `hostEnvironment` domain, identical to Read/Write/Edit/Grep.
 *
 * Behaviour:
 *   - `.gitignore` / `.ignore` / `.rgignore` are respected by default
 *     (ripgrep native). Pass `include_ignored` to also surface ignored files
 *     (e.g. build outputs, `node_modules`). Sensitive files such as `.env` are
 *     always filtered out (authoritative post-filter via
 *     {@link isSensitiveFile}).
 *   - Results are files-only — `rg --files` never lists directories.
 *     `include_dirs` is accepted but deprecated and ignored.
 *   - Brace expansion (`*.{ts,tsx}`, `{src,test}/**`) is handled by ripgrep's
 *     glob engine; the pattern is passed through to a single `--glob`.
 *   - Match count is capped at {@link MAX_MATCHES}. Callers are expected to add
 *     an anchor (extension, subdirectory) when that would not be enough.
 *
 * Output convention: paths shown to the LLM are relativized to the search
 * base only when that base sits inside the primary workspace. External roots
 * stay absolute so downstream Read/Edit calls keep targeting the same file.
 */

import { normalize, resolve } from 'pathe';
import { z } from 'zod';

import { ensureRgPath, rgUnavailableMessage, type RgProbe } from '#/os/backends/node-local/tools/rgLocator';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  runRgOnce,
  shouldRetryRipgrepEagain,
} from '#/os/backends/node-local/tools/runRg';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  ToolAccesses,
  type BuiltinTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import {
  extendWorkspaceWithSkillRoots,
  isWithinDirectory,
  resolvePathAccessPath,
  type PathClass,
  isSensitiveFile,
  SENSITIVE_DOT_VARIANT_SUFFIXES,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import globDescription from './glob.md?raw';

export const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files.'),
  path: z
    .string()
    .optional()
    .describe(
      'Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.',
    ),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      'Also match files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. VCS metadata directories (`.git` and similar) are always skipped, even when this is true. Defaults to false.',
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

export const WINDOWS_PATH_HINT =
  '\n\nWindows note: the `path` argument accepts both Windows paths ' +
  '(e.g. `C:\\Users\\foo`) and POSIX-style paths (e.g. `/c/Users/foo`). Matched paths are ' +
  'returned in Windows backslash form; convert them to forward slashes before ' +
  'using them in a Bash command.';

export class GlobTool implements BuiltinTool<GlobInput> {
  readonly name = 'Glob' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GlobInputSchema);
  constructor(
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IHostProcessService private readonly processService: IHostProcessService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {
    this.description =
      this.env.pathClass === 'win32' ? globDescription + WINDOWS_PATH_HINT : globDescription;
  }

  private get workspaceConfig(): WorkspaceConfig {
    return extendWorkspaceWithSkillRoots(
      {
        workspaceDir: this.workspaceCtx.workDir,
        additionalDirs: this.workspaceCtx.additionalDirs,
      },
      this.skillCatalog?.catalog.getSkillRoots() ?? [],
      this.env.pathClass,
    );
  }

  resolveExecution(args: GlobInput): ToolExecution {
    let path: string | undefined;
    if (args.path !== undefined) {
      path = resolvePathAccessPath(args.path, {
        env: this.env,
        workspace: this.workspaceConfig,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const searchRoots = [path ?? this.workspaceConfig.workspaceDir];

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
    searchRoots: readonly string[],
  ): Promise<ExecutableToolResult> {
    const searchRoot = searchRoots[0] ?? this.workspaceConfig.workspaceDir;

    try {
      const st = await this.fs.stat(searchRoot);
      if (!st.isDirectory) {
        return { isError: true, output: `${searchRoot} is not a directory` };
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { isError: true, output: `${searchRoot} does not exist` };
      }
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }

    if (signal.aborted) {
      return { isError: true, output: 'Glob aborted' };
    }

    let rgPath: string;
    try {
      const resolution = await ensureRgPath(createRgProbe(this.processService), {
        signal,
        allowCachedFallback: true,
      });
      rgPath = resolution.path;
      if (resolution.source !== 'system-path') {
        this.telemetry.track2('glob_tool_rg_fallback', {
          source: resolution.source,
          outcome: 'resolved',
        });
      }
    } catch (error) {
      if (signal.aborted) {
        return { isError: true, output: 'Glob aborted' };
      }
      this.telemetry.track2('glob_tool_rg_fallback', { outcome: 'failed' });
      return { isError: true, output: rgUnavailableMessage(error) };
    }

    let run;
    try {
      run = await runRgOnce(this.processService, buildRgArgs(rgPath, args), signal, { cwd: searchRoot });
    } catch (error) {
      return { isError: true, output: formatSpawnError(error) };
    }
    if (run.kind === 'aborted') {
      return { isError: true, output: 'Glob aborted' };
    }

    if (shouldRetryRipgrepEagain(run)) {
      try {
        run = await runRgOnce(this.processService, buildRgArgs(rgPath, args, true), signal, { cwd: searchRoot });
      } catch (error) {
        return { isError: true, output: formatSpawnError(error) };
      }
      if (run.kind === 'aborted') {
        return { isError: true, output: 'Glob aborted' };
      }
    }

    const { exitCode, stdoutText, stderrText, bufferTruncated, timedOut } = run;

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

    const pathClass = this.env.pathClass;
    const shouldRelativize = isWithinDirectory(searchRoot, this.workspaceConfig.workspaceDir, pathClass);
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

registerTool(GlobTool);

function createRgProbe(processService: IHostProcessService): RgProbe {
  return {
    exec: async (args) => {
      const [command, ...rest] = args;
      if (command === undefined) return { exitCode: -1 };
      const proc = await processService.spawn(command, rest);
      try {
        proc.stdin.end();
      } catch {
      }
      proc.stdout.resume();
      proc.stderr.resume();
      const exitCode = await proc.wait();
      try {
        proc.dispose();
      } catch {
      }
      return { exitCode };
    },
  };
}

function buildRgArgs(rgPath: string, args: GlobInput, singleThreaded = false): string[] {
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

export function splitCompletePaths(stdoutText: string, truncatedOutput: boolean): string[] {
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
