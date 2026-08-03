/**
 * `agentsMdReminder` domain — `IAgentAgentsMdReminderService`
 * implementation.
 *
 * Self-wiring plugin: registers an `onDidExecuteTool` hook on `toolExecutor`
 * that probes the directories a tool call touches for AGENTS.md files the
 * system prompt did not inject, and prepends a once-per-agent
 * `<system-reminder>` to the result suggesting the model read them (head
 * insertion on purpose: oversized results are truncated to a short head
 * preview later in the execution pipeline, and a tail reminder would be
 * silently dropped after the file was already counted as reminded).
 * `Read`/`Edit`/`Write` consume the canonical file access declared by their
 * resolved execution (a successful touch landing on an AGENTS.md itself marks
 * just that file known), `Glob`/`Grep` consume their canonical search root,
 * and `Bash` contributes its explicit `cwd` plus the literal directory
 * operands extracted from the command's syntax tree (see `./bashTargets`),
 * resolved against the frozen
 * `sessionContext.cwd` exactly like the Bash tool itself (`args.cwd ??
 * sessionContext.cwd` — a base that deliberately differs from the live agent
 * cwd after a chdir). Only calls whose `ToolDidExecuteContext.outcome` is
 * `executed` are probed: preflight rejects, resolution failures, aborts,
 * permission vetoes, and synthetic/duplicate results have not touched the
 * requested resource and are left unchanged. The hook is ordered before
 * `toolDedupe` so an executed original carries the reminder into the
 * deferred result returned for a duplicate; no dedupe implementation state is
 * needed here. The ordered registration throws when its target is absent, so
 * scopes without `toolDedupe` fall back to plain append-order registration,
 * which still lands ahead of a `toolDedupe` hook constructed later.
 *
 * Known-set discipline: candidates are claimed synchronously per discovered
 * file into an in-memory `claimed` set (parallel calls can never duplicate a
 * reminder and a failed attempt releases the claim), while `agentState`
 * (`agentsMdReminder.known`) is only ever whole-value replaced after the
 * reminder text is attached and the telemetry emitted — never mutated in
 * place, and never ahead of the reminder it records. Probing anchors at the
 * nearest existing ancestor (so `Write` into a not-yet-created directory
 * still resolves), walks `findProjectRoot → touched dir`, skips chain
 * directories whose candidates are all known, and applies the same
 * per-directory candidate rules as the init-time load (shared through
 * `profile/context`'s `findAgentsMdInDir`; blank files are included in
 * neither). Directories with unknown candidates are re-statted on every
 * qualifying call — deliberate, so an AGENTS.md created mid-session is
 * picked up on the next touch; there is no negative cache. Probing is
 * lexical like the tools' own path policy: a symlinked directory's AGENTS.md
 * is discovered through the link at its lexical address, never by realpath.
 * The hook never throws — a probe failure yields the untouched result.
 *
 * Seeding: `profile` reports the injected paths after every successful
 * bind/apply/refresh and `sessionInit` re-seeds after `/init`. A prompt can
 * also commit without any of those entry points — session resume and forks
 * restore the already-rendered system prompt (AGENTS.md content included)
 * from the wire journal or a binding snapshot. The wire restore hook seeds
 * the exact persisted paths (legacy prompts recover their source annotations),
 * so the first qualifying call of a never-seeded agent does not confuse the
 * current filesystem with the restored prompt. The seeded cwd lives in
 * `agentState` as well; restored provenance comes from `wire`/`profile`; fs
 * probes go through the os `IHostFileSystem`, the home directory through
 * `IHostEnvironment`, the brand home through `bootstrap`, syntax
 * trees through `bashParser`, and the shown-event
 * through `telemetry`. Bound at Agent scope.
 */

import { basename, dirname, isAbsolute, join, normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { AgentsMdReminderShownEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart } from '#/kosong/contract/message';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableToolOutput, ExecutableToolResult } from '#/tool/toolContract';
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
import { ProfileModel } from '#/agent/profile/profileOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IWireService } from '#/wire/wire';

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
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IBashParserService private readonly bashParser: IBashParserService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWireService private readonly wire: IWireService,
  ) {
    super();
    this.states.register(agentsMdReminderKnownKey);
    this.states.register(agentsMdReminderCwdKey);
    this.states.register(agentsMdReminderSeededKey);
    this._register(
      this.wire.hooks.onDidRestore.register('agentsMdReminder', async (_ctx, next) => {
        const profile = this.wire.getModel(ProfileModel);
        const paths =
          profile.agentsMdPaths ?? extractAgentsMdPathsFromSystemPrompt(profile.systemPrompt);
        this.seedInjected(paths, this.sessionContext.cwd);
        await next();
      }),
    );
    const handler = async (ctx: ToolDidExecuteContext, next: () => Promise<void>): Promise<void> => {
      ctx.result = await this.augmentWithReminder(ctx);
      await next();
    };
    try {
      this._register(toolExecutor.hooks.onDidExecuteTool.register('agentsMdReminder', handler, { before: 'toolDedupe' }));
    } catch {
      this._register(toolExecutor.hooks.onDidExecuteTool.register('agentsMdReminder', handler));
    }
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
    const { paths } = await loadAgentsMdDetailed(
      { fs: this.fs, homeDir: this.env.homeDir },
      this.agentCwd,
      this.bootstrap.homeDir,
    );
    this.seedInjected(paths, this.agentCwd);
  }

  private async augmentWithReminder(ctx: ToolDidExecuteContext): Promise<ExecutableToolResult> {
    if (ctx.outcome !== 'executed') return ctx.result;
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
        return ctx.result;
      }
      const result = prependReminder(ctx.result, reminderText(discovered));
      const properties: AgentsMdReminderShownEvent = {
        turn_id: ctx.turnId,
        tool_name: ctx.toolCall.name,
        reminded_count: discovered.length,
        trace_id: ctx.trace?.traceId,
      };
      this.telemetry.track2('agents_md_reminder_shown', properties);
      this.publishKnown([...selfKnown, ...discovered]);
      return result;
    } catch {
      return ctx.result;
    } finally {
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
        const base = hostPath(this.sessionContext.cwd, this.env.pathClass);
        const normalizedCwdArg =
          cwdArg === undefined ? undefined : normalizeUserPath(cwdArg, this.env.pathClass);
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
          this.env.homeDir,
        ).map((target) => hostPath(target, this.env.pathClass));
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
    const anchor = await this.nearestExistingDir(dir);
    if (anchor === undefined) return [];
    const deps = { fs: this.fs };
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
  }

  private async nearestExistingDir(path: string): Promise<string | undefined> {
    let current = path;
    for (;;) {
      const stat = await this.fs.stat(current).catch(() => undefined);
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
    '<system-reminder>\n' +
    'The path(s) touched by this call are covered by AGENTS.md instruction file(s) that were not part of the injected instructions:\n' +
    paths.map((path) => `- ${path}`).join('\n') +
    '\nRead them before making changes in those directories. Each file is suggested at most once per agent.' +
    '\n</system-reminder>\n\n'
  );
}

function prependReminder(result: ExecutableToolResult, text: string): ExecutableToolResult {
  const output = result.output;
  let newOutput: ExecutableToolOutput;
  if (typeof output === 'string') {
    newOutput = text + output;
  } else {
    const parts: ContentPart[] = [...output];
    const first = parts[0];
    if (first !== undefined && first.type === 'text') {
      parts[0] = { type: 'text', text: text + first.text };
    } else {
      parts.unshift({ type: 'text', text });
    }
    newOutput = parts;
  }
  return result.isError === true
    ? { ...result, output: newOutput, isError: true }
    : { ...result, output: newOutput };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAgentsMdReminderService,
  AgentAgentsMdReminderService,
  ScopeActivation.OnScopeCreated,
  'agentsMdReminder',
);
