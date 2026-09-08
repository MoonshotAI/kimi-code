import { normalize, resolve } from 'pathe';

import { ensureRgPath, rgUnavailableMessage, type RgProbe } from '#/os/backends/node-local/tools/rgLocator';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  runRgOnce,
  shouldRetryRipgrepEagain,
} from '#/os/backends/node-local/tools/runRg';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS,
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
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
import {
  type GlobInput,
  GlobInputSchema,
  IGlobTool,
  DEFAULT_HEAD_LIMIT,
  WINDOWS_PATH_HINT,
} from './glob';

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

export class GlobTool implements IGlobTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Glob' as const;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GlobInputSchema);
  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  get description(): string {
    return inspectAgentRuntime(this.runtime).environment.pathClass === 'win32'
      ? globDescription + WINDOWS_PATH_HINT
      : globDescription;
  }

  private workspaceConfig(view: RuntimeWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  resolveExecution(args: GlobInput): ToolExecution {
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: [
        ...this.workspaceCtx.additionalDirs,
        ...(this.skillCatalog?.catalog.getSkillRoots() ?? []),
      ],
    });
    const env = { _serviceBrand: undefined, ...inspected.environment, ready: Promise.resolve() };
    const workspace = this.workspaceConfig(view);
    let path: string | undefined;
    if (args.path !== undefined) {
      path = resolvePathAccessPath(args.path, {
        env,
        workspace,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const searchRoots = [path ?? workspace.workspaceDir];

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
      execute: async ({ signal }) => {
        const lease = this.runtime.acquire(['fs', 'process']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          return await this.execution(
            lease.runtime.fs!,
            lease.runtime.process!,
            env,
            workspace,
            args,
            signal,
            searchRoots,
          );
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    fs: IHostFileSystem,
    processService: IHostProcessService,
    env: IHostEnvironment,
    workspace: WorkspaceConfig,
    args: GlobInput,
    signal: AbortSignal,
    searchRoots: readonly string[],
  ): Promise<ExecutableToolResult> {
    const searchRoot = searchRoots[0] ?? workspace.workspaceDir;

    try {
      const st = await fs.stat(searchRoot);
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
      const resolution = await ensureRgPath(createRgProbe(processService), {
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
      run = await runRgOnce(processService, buildRgArgs(rgPath, args), signal, { cwd: searchRoot });
    } catch (error) {
      return { isError: true, output: formatSpawnError(error) };
    }
    if (run.kind === 'aborted') {
      return { isError: true, output: 'Glob aborted' };
    }

    if (shouldRetryRipgrepEagain(run)) {
      try {
        run = await runRgOnce(processService, buildRgArgs(rgPath, args, true), signal, { cwd: searchRoot });
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

    const offset = args.offset ?? 0;
    const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
    const limited = headLimit === 0 ? kept.slice(offset) : kept.slice(offset, offset + headLimit);
    const partial = bufferTruncated || timedOut || traversalWarning !== undefined;

    const pathClass = env.pathClass;
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
    const pageNotices = (count: number, characterLimited: boolean) => {
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
        isError: true,
        output: 'Glob cannot fit a complete path and its diagnostics within the output limit. Narrow the search path or pattern.',
      };
    }
    const notices = pageNotices(displayLines.length, displayLines.length < candidates.length);
    return { output: [...notices.lines, ...displayLines, ...notices.footer].join('\n') };
  }
}

registerAgentToolService(IGlobTool, GlobTool, {
  name: 'Glob',
  domain: 'os/backends',
  requiredRuntimeCapabilities: ['fs', 'process'],
});

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
        void proc.dispose();
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
