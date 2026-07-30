/**
 * `agentsMdReminder` domain (L4) — `IAgentAgentsMdReminderService`
 * implementation.
 *
 * Self-wiring plugin: registers an `onDidExecuteTool` hook on `toolExecutor`
 * that probes the directories a tool call touches for AGENTS.md files the
 * system prompt did not inject, and prepends a once-per-agent
 * `<system-reminder>` to the result suggesting the model read them (head
 * insertion on purpose: oversized results are truncated to a short head
 * preview later in the execution pipeline, and a tail reminder would be
 * silently dropped after the file was already counted as reminded).
 * `Read`/`Edit`/`Write` contribute their `path`'s directory (a successful
 * touch landing on an AGENTS.md itself marks just that file known),
 * `Glob`/`Grep` contribute their optional search root, and `Bash` contributes
 * its explicit `cwd` plus the literal directory operands extracted from the
 * command's syntax tree (see `./bashTargets`), resolved against the frozen
 * `sessionContext.cwd` exactly like the Bash tool itself. Preflight-rejected
 * calls (no `tool` on the context — guard denials included) are never
 * probed: the path policy already said no to that path. The gate
 * (`agents-md-reminder` experimental flag) is evaluated per tool call, so
 * runtime config overrides take effect without reconstructing the agent. The
 * hook is ordered before `toolDedupe` when that hook is present (falling back
 * to plain append-order registration otherwise), so a same-step duplicate
 * resolves its deferred result with the reminder already attached.
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
 * The hook never throws — a probe failure yields the untouched result. The
 * seeded cwd lives in `agentState` as well; fs probes go through the os
 * `IHostFileSystem`, the home directory through `IHostEnvironment`, syntax
 * trees through `bashParser`, the gate through `flag`, and the shown-event
 * through `telemetry`. Bound at Agent scope.
 */

import { basename, dirname, isAbsolute, join, normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IFlagService } from '#/app/flag/flag';
import type { AgentsMdReminderShownEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart } from '#/kosong/contract/message';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableToolOutput, ExecutableToolResult } from '#/tool/toolContract';
import {
  agentsMdCandidatePaths,
  dirsRootToLeaf,
  findAgentsMdInDir,
  findProjectRoot,
} from '#/agent/profile/context';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';

import { IAgentAgentsMdReminderService } from './agentsMdReminder';
import { extractBashTargetDirs } from './bashTargets';
import { AGENTS_MD_REMINDER_FLAG_ID } from './flag';

const AGENTS_MD_BASENAMES: ReadonlySet<string> = new Set(['AGENTS.md', 'agents.md']);

const BASH_PARSE_OPTIONS = { timeoutMs: 20, maxNodes: 10_000 } as const;

export const agentsMdReminderKnownKey = defineState<Set<string>>(
  'agentsMdReminder.known',
  () => new Set(),
);
export const agentsMdReminderCwdKey = defineState<string | undefined>(
  'agentsMdReminder.cwd',
  () => undefined as string | undefined,
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
    @IBashParserService private readonly bashParser: IBashParserService,
    @IFlagService private readonly flags: IFlagService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.states.register(agentsMdReminderKnownKey);
    this.states.register(agentsMdReminderCwdKey);
    const handler = async (ctx: ToolDidExecuteContext, next: () => Promise<void>): Promise<void> => {
      if (this.flags.enabled(AGENTS_MD_REMINDER_FLAG_ID)) {
        ctx.result = await this.augmentWithReminder(ctx);
      }
      await next();
    };
    // `before: 'toolDedupe'` throws when that hook is absent (minimal scopes);
    // plain registration still lands ahead of it whenever it constructs later.
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
  }

  private readonly claimed = new Set<string>();

  private get known(): Set<string> {
    return this.states.get(agentsMdReminderKnownKey);
  }

  private get agentCwd(): string {
    return this.states.get(agentsMdReminderCwdKey) ?? this.sessionContext.cwd;
  }

  private async augmentWithReminder(ctx: ToolDidExecuteContext): Promise<ExecutableToolResult> {
    // Preflight-rejected calls (guard denial, missing tool, invalid args)
    // arrive without `tool`: the path policy already said no to this path, so
    // probing it (and reporting what exists there) is out of bounds.
    if (ctx.tool === undefined) return ctx.result;
    const discovered: string[] = [];
    try {
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
    const args = ctx.args;
    const selfKnown: string[] = [];
    switch (ctx.toolCall.name) {
      case 'Read':
      case 'Edit':
      case 'Write': {
        const path = stringArg(args, 'path');
        if (path === undefined) return { dirs: [], selfKnown };
        const resolved = this.resolve(path);
        if (ctx.result.isError !== true && AGENTS_MD_BASENAMES.has(basename(resolved))) {
          selfKnown.push(resolved);
        }
        return { dirs: [dirname(resolved)], selfKnown };
      }
      case 'Glob':
      case 'Grep': {
        const path = stringArg(args, 'path');
        return { dirs: [path === undefined ? this.agentCwd : this.resolve(path)], selfKnown };
      }
      case 'Bash': {
        const command = stringArg(args, 'command');
        if (command === undefined) return { dirs: [], selfKnown };
        const cwdArg = stringArg(args, 'cwd');
        // The Bash tool executes with `args.cwd ?? sessionContext.cwd` (frozen
        // at session creation), so its base differs from the live agent cwd
        // after a chdir — resolve exactly like the tool does.
        const base = this.sessionContext.cwd;
        const effectiveCwd =
          cwdArg === undefined
            ? base
            : normalize(isAbsolute(cwdArg) ? cwdArg : join(base, cwdArg));
        const parsed = this.bashParser.parse(command, BASH_PARSE_OPTIONS);
        if (!parsed.ok || parsed.hasError) return cwdArg === undefined ? { dirs: [], selfKnown } : { dirs: [effectiveCwd], selfKnown };
        const targets = extractBashTargetDirs(parsed.root, effectiveCwd, this.env.homeDir);
        if (cwdArg !== undefined && !targets.includes(effectiveCwd)) {
          targets.unshift(effectiveCwd);
        }
        return { dirs: targets, selfKnown };
      }
      default:
        return { dirs: [], selfKnown };
    }
  }

  private resolve(path: string): string {
    return normalize(isAbsolute(path) ? path : join(this.agentCwd, path));
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
