/**
 * `agentsMdReminder` domain — `IAgentAgentsMdReminderService`
 * implementation.
 *
 * Discovers AGENTS.md files reached through `toolExecutor` and the tool path
 * policy, parsing Bash targets through `bashParser` and probing through the os
 * services. Restores prompt provenance through the `profile` state on the
 * event dispatcher, resolves
 * roots through `sessionContext` and `bootstrap`, stores discovery state in
 * `agentState`, appends through `systemReminder`, and reports through
 * `telemetry`. Bound at Agent scope.
 */

import { basename, dirname, isAbsolute, join, normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { AgentsMdReminderShownEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { normalizeUserPath } from '#/tool/path-access';
import {
  AGENTS_MD_PLAIN_NAMES,
  agentsMdCandidatePaths,
  dirsRootToLeaf,
  findAgentsMdInDir,
  findProjectRoot,
  extractAgentsMdPathsFromSystemPrompt,
  loadAgentsMdDetailed,
} from '#/agent/profile/context';
import { profileKey } from '#/agent/profile/profileOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentAgentsMdReminderService } from './agentsMdReminder';
import { extractBashTargetDirs } from './bashTargets';

const AGENTS_MD_BASENAMES: ReadonlySet<string> = new Set<string>(AGENTS_MD_PLAIN_NAMES);

const BASH_PARSE_OPTIONS = { timeoutMs: 20, maxNodes: 10_000 } as const;

export const agentsMdReminderKnownKey = defineState<Set<string>>(
  'agentsMdReminder.known',
  () => new Set(),
);
export const agentsMdReminderCwdKey = defineState<string | undefined>(
  'agentsMdReminder.cwd',
  () => undefined as string | undefined,
);
export const agentsMdReminderSeededKey = defineState<boolean>(
  'agentsMdReminder.seeded',
  () => false,
);

export class AgentAgentsMdReminderService
  extends Disposable
  implements IAgentAgentsMdReminderService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IBashParserService private readonly bashParser: IBashParserService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
      @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.states.contributeState(agentsMdReminderKnownKey);
    this.states.contributeState(agentsMdReminderCwdKey);
    this.states.contributeState(agentsMdReminderSeededKey);
    this._register(
      this.dispatcher.hooks.onDidRestore.register('agentsMdReminder', async (_ctx, next) => {
        const profile = this.agentState.get(profileKey);
        const paths =
          profile.agentsMdPaths ?? extractAgentsMdPathsFromSystemPrompt(profile.systemPrompt);
        this.seedInjected(paths, this.sessionContext.cwd);
        await next();
      }),
    );
    const handler = async (ctx: ToolDidExecuteContext, next: () => Promise<void>): Promise<void> => {
      await this.probeAndRemind(ctx);
      await next();
    };
    this._register(toolExecutor.hooks.onDidExecuteTool.register('agentsMdReminder', handler));
  }

  seedInjected(paths: readonly string[], cwd: string): void {
    const known = this.states.get(agentsMdReminderKnownKey);
    for (const path of paths) known.add(normalize(path));
    this.states.set(agentsMdReminderKnownKey, new Set(known));
    this.states.set(agentsMdReminderCwdKey, cwd);
    this.states.set(agentsMdReminderSeededKey, true);
  }

  private readonly claimed = new Set<string>();

  private get known(): Set<string> {
    return this.states.get(agentsMdReminderKnownKey);
  }

  private get agentCwd(): string {
    return this.states.get(agentsMdReminderCwdKey) ?? this.sessionContext.cwd;
  }

  private async ensureSeeded(): Promise<void> {
    if (this.states.get(agentsMdReminderSeededKey)) return;
    const lease = this.runtime.acquire(['fs']);
    try {
      const { paths } = await loadAgentsMdDetailed(
        { fs: lease.runtime.fs!, homeDir: lease.runtime.environment.homeDir },
        this.agentCwd,
        this.bootstrap.homeDir,
      );
      this.seedInjected(paths, this.agentCwd);
    } finally {
      lease.dispose();
    }
  }

  private async probeAndRemind(ctx: ToolDidExecuteContext): Promise<void> {
    if (ctx.outcome !== 'executed') return;
    const discovered: string[] = [];
    try {
      await this.ensureSeeded();
      const { dirs, selfKnown } = this.targetDirs(ctx);
      const selfKnownSet = new Set(selfKnown);
      for (const dir of dirs) {
        for (const path of await this.probeDir(dir)) {
          if (this.known.has(path) || this.claimed.has(path) || selfKnownSet.has(path)) continue;
          this.claimed.add(path);
          discovered.push(path);
        }
      }
      if (discovered.length === 0) {
        this.publishKnown(selfKnown);
        return;
      }
      const properties: AgentsMdReminderShownEvent = {
        turn_id: ctx.turnId,
        tool_name: ctx.toolCall.name,
        reminded_count: discovered.length,
        trace_id: ctx.trace?.traceId,
      };
      this.telemetry.track2('agents_md_reminder_shown', properties);
      this.reminders.appendSystemReminder(reminderText(discovered), {
        kind: 'injection',
        variant: 'agents_md',
      });
      this.publishKnown([...selfKnown, ...discovered]);
    } catch {} finally {
      for (const path of discovered) this.claimed.delete(path);
    }
  }

  private publishKnown(paths: readonly string[]): void {
    if (paths.length === 0) return;
    const merged = new Set(this.known);
    for (const path of paths) merged.add(path);
    this.states.set(agentsMdReminderKnownKey, merged);
  }

  private targetDirs(ctx: ToolDidExecuteContext): { dirs: string[]; selfKnown: string[] } {
    const selfKnown: string[] = [];
    const lease = this.runtime.acquire();
    const env = lease.runtime.environment;
    lease.dispose();
    switch (ctx.toolCall.name) {
      case 'Read':
      case 'Edit':
      case 'Write':
      case 'Glob':
      case 'Grep':
        return this.targetDirsFromAccesses(ctx);
      case 'Bash': {
        const args = ctx.args;
        const command = stringArg(args, 'command');
        if (command === undefined) return { dirs: [], selfKnown };
        const cwdArg = stringArg(args, 'cwd');
        const base = hostPath(this.sessionContext.cwd, env.pathClass);
        const normalizedCwdArg =
          cwdArg === undefined ? undefined : normalizeUserPath(cwdArg, env.pathClass);
        const effectiveCwd =
          normalizedCwdArg === undefined
            ? base
            : normalize(
                isAbsolute(normalizedCwdArg)
                  ? normalizedCwdArg
                  : join(base, normalizedCwdArg),
              );
        const parsed = this.bashParser.parse(command, BASH_PARSE_OPTIONS);
        if (!parsed.ok || parsed.hasError) {
          return normalizedCwdArg === undefined
            ? { dirs: [], selfKnown }
            : { dirs: [effectiveCwd], selfKnown };
        }
        const targets = extractBashTargetDirs(
          parsed.root,
          effectiveCwd,
          env.homeDir,
        ).map((target) => hostPath(target, env.pathClass));
        if (normalizedCwdArg !== undefined && !targets.includes(effectiveCwd)) {
          targets.unshift(effectiveCwd);
        }
        return { dirs: targets, selfKnown };
      }
      default:
        return { dirs: [], selfKnown };
    }
  }

  private targetDirsFromAccesses(ctx: ToolDidExecuteContext): {
    dirs: string[];
    selfKnown: string[];
  } {
    const dirs: string[] = [];
    const selfKnown: string[] = [];
    const targetsFiles =
      ctx.toolCall.name === 'Read' ||
      ctx.toolCall.name === 'Edit' ||
      ctx.toolCall.name === 'Write';
    for (const access of ctx.accesses ?? []) {
      if (access.kind !== 'file') continue;
      if (
        targetsFiles &&
        ctx.result.isError !== true &&
        AGENTS_MD_BASENAMES.has(basename(access.path))
      ) {
        selfKnown.push(access.path);
      }
      dirs.push(targetsFiles ? dirname(access.path) : access.path);
    }
    return { dirs: [...new Set(dirs)], selfKnown: [...new Set(selfKnown)] };
  }

  private async probeDir(dir: string): Promise<string[]> {
    const lease = this.runtime.acquire(['fs']);
    try {
      const fs = lease.runtime.fs!;
      const anchor = await this.nearestExistingDir(fs, dir);
      if (anchor === undefined) return [];
      const deps = { fs };
      const projectRoot = await findProjectRoot(deps, anchor);
      const chain = dirsRootToLeaf(anchor, projectRoot);
      const found: string[] = [];
      for (const chainDir of chain) {
        const candidates = agentsMdCandidatePaths(chainDir);
        if (candidates.every((candidate) => this.known.has(normalize(candidate)))) continue;
        for (const path of await findAgentsMdInDir(deps, chainDir)) {
          found.push(normalize(path));
        }
      }
      return found;
    } finally {
      lease.dispose();
    }
  }

  private async nearestExistingDir(fs: IHostFileSystem, path: string): Promise<string | undefined> {
    let current = path;
    for (;;) {
      const stat = await fs.stat(current).catch(() => undefined);
      if (stat?.isDirectory === true) return current;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function hostPath(path: string, pathClass: 'posix' | 'win32'): string {
  return normalize(normalizeUserPath(path, pathClass));
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reminderText(paths: readonly string[]): string {
  return (
    'The path(s) touched by a recent tool call are covered by AGENTS.md instruction file(s) that were not part of the injected instructions:\n' +
    paths.map((path) => `- ${path}`).join('\n') +
    '\nRead them before making changes in those directories. Each file is suggested at most once per agent.'
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAgentsMdReminderService,
  AgentAgentsMdReminderService,
  ScopeActivation.OnScopeCreated,
  'agentsMdReminder',
);
