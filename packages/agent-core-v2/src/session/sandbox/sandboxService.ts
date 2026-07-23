/**
 * `sandbox` domain (L3) — `ISandboxService` implementation.
 *
 * Resolves the `[sandbox]` config section through `config`, picks the OS
 * sandbox backend for the host (`bwrap` on Linux, `seatbelt` on macOS; probed
 * lazily on first `decide` through `os/interface` host-process spawns and
 * cached afterwards), and folds the workspace roots from `workspaceContext`
 * with host path facts (`os/interface` host environment) into a
 * `ResolvedSandboxPolicy`. The writable roots come only from the session
 * workspace — the command's cwd is never promoted: a cwd inside the
 * workspace is already covered by workDir, and a cwd outside it stays
 * read-only (the shell cds in and can read, but writes hit EROFS). A
 * sandboxed decision wraps the full shell argv
 * (`<shell> -c 'cd <cwd> && <command>'`, POSIX only — Windows reports
 * `unsupported-platform`) so the caller can exec it directly. Backend
 * unavailable with `require = true` fails closed (`blocked`); otherwise it
 * warns once through `log` and runs unsandboxed. Commands matching
 * `excluded_commands` (per `&&`/`||`/`;`/`|`/newline segment, after stripping
 * leading `VAR=value` assignments; entries match the segment text as a prefix
 * followed by a space or end) bypass the sandbox and run through the normal
 * permission chain. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { BwrapSandboxBackend } from './backends/bwrapBackend';
import type { ISandboxBackend } from './backends/sandboxBackend';
import { SeatbeltSandboxBackend } from './backends/seatbeltBackend';
import { resolveSandboxConfig } from './configSection';
import { ISandboxService } from './sandbox';
import {
  hostSandboxPathEnv,
  resolveSandboxPolicy,
  type SandboxWorkspaceRoots,
} from './sandboxPolicy';
import type { SandboxBackendId, SandboxDecision } from './sandboxTypes';

type BackendProbeResult =
  | { readonly status: 'ok'; readonly backend: ISandboxBackend }
  | { readonly status: 'backend-unavailable'; readonly backendId: SandboxBackendId }
  | { readonly status: 'unsupported-platform' };

export class SandboxService implements ISandboxService {
  declare readonly _serviceBrand: undefined;

  private backendResult: Promise<BackendProbeResult> | undefined;
  private warnedUnavailable = false;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    @ILogService private readonly log: ILogService,
    private readonly createBackend: (osKind: string) => ISandboxBackend | undefined = pickBackend,
  ) {}

  async decide(command: string, cwd: string): Promise<SandboxDecision> {
    const config = resolveSandboxConfig(this.config);
    if (config?.enabled !== true) return { kind: 'unsandboxed', reason: 'disabled' };

    const matched = matchExcludedCommand(command, config.excludedCommands ?? []);
    if (matched !== undefined) return { kind: 'excluded', matched };

    const probe = await this.probeBackend();
    if (probe.status !== 'ok') {
      if (config.require === true) {
        return { kind: 'blocked', reason: this.blockedReason(probe) };
      }
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.log.warn(
          '[sandbox] sandbox.enabled = true but no usable sandbox backend; Bash commands run unsandboxed.',
          { platform: this.env.osKind, status: probe.status },
        );
      }
      return { kind: 'unsandboxed', reason: probe.status };
    }

    const policy = resolveSandboxPolicy(config, this.workspaceRoots(), hostSandboxPathEnv(this.env.homeDir));
    const shellArgv = [this.env.shellPath, '-c', `cd ${shellQuote(cwd)} && ${command}`];
    return {
      kind: 'sandboxed',
      argv: probe.backend.wrap(shellArgv, policy),
      backendId: probe.backend.id,
    };
  }

  private probeBackend(): Promise<BackendProbeResult> {
    this.backendResult ??= this.doProbeBackend();
    return this.backendResult;
  }

  private async doProbeBackend(): Promise<BackendProbeResult> {
    const backend = this.createBackend(this.env.osKind);
    if (backend === undefined) return { status: 'unsupported-platform' };
    const available = await backend.detect((argv) => this.spawnProbe(argv));
    return available
      ? { status: 'ok', backend }
      : { status: 'backend-unavailable', backendId: backend.id };
  }

  private async spawnProbe(argv: string[]): Promise<number> {
    const proc = await this.hostProcess.spawn(argv[0]!, argv.slice(1));
    try {
      return await proc.wait();
    } finally {
      proc.dispose();
    }
  }

  private blockedReason(probe: Exclude<BackendProbeResult, { status: 'ok' }>): string {
    if (probe.status === 'unsupported-platform') {
      return (
        `Sandbox is required (sandbox.require = true) but no sandbox backend exists ` +
        `for platform '${this.env.osKind}'.`
      );
    }
    return (
      `Sandbox is required (sandbox.require = true) but the '${probe.backendId}' backend ` +
      `is not available on this host.`
    );
  }

  private workspaceRoots(): SandboxWorkspaceRoots {
    return { workDir: this.workspace.workDir, additionalDirs: this.workspace.additionalDirs };
  }
}

function pickBackend(osKind: string): ISandboxBackend | undefined {
  if (osKind === 'Linux') return new BwrapSandboxBackend();
  if (osKind === 'macOS') return new SeatbeltSandboxBackend();
  return undefined;
}

const SEGMENT_SPLIT_RE = /&&|\|\||[;|\n]/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function matchExcludedCommand(
  command: string,
  excludedCommands: readonly string[],
): string | undefined {
  if (excludedCommands.length === 0) return undefined;
  for (const rawSegment of command.split(SEGMENT_SPLIT_RE)) {
    const segment = stripLeadingEnvAssignments(rawSegment.trim());
    if (segment === '') continue;
    for (const entry of excludedCommands) {
      const trimmed = entry.trim();
      if (trimmed === '') continue;
      if (segment === trimmed || segment.startsWith(`${trimmed} `)) return entry;
    }
  }
  return undefined;
}

function stripLeadingEnvAssignments(segment: string): string {
  const tokens = segment.split(/\s+/);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i]!)) i += 1;
  return tokens.slice(i).join(' ');
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

registerScopedService(
  LifecycleScope.Session,
  ISandboxService,
  SandboxService,
  InstantiationType.Eager,
  'sandbox',
);
