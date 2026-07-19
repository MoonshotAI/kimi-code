/**
 * `fileFencing` domain (L4) — `IAgentFileFencingService` implementation.
 *
 * Registers the `writeFencing` participant on the `toolExecutor`
 * `onBeforeExecuteTool` / `onDidExecuteTool` hook slots, matching
 * `Read`/`Write`/`Edit` by tool name and letting every other tool pass
 * through. The target path comes from the resolved execution's file accesses
 * — the exact canonical path the tool itself computed — so the ledger and
 * the watcher key it identically. The before-hook records the target keyed
 * by `toolCall.id` (cleared in the did-hook and swept on turn change) and,
 * for `Write`/`Edit`, computes the ledger verdict: with the `multi_server`
 * flag on, `stale` blocks with an outside-modification conflict and
 * `no-baseline` blocks with a read-first reason (Edit-over-existing, or
 * Write over an already existing file); with the flag off nothing ever
 * blocks and the verdict is marked for the did-hook. The did-hook
 * re-baselines the ledger after any successful fenced call (ranged Reads
 * excepted — per the ledger contract they never count as full reads) and,
 * for a flag-off stale mark, composes a `<system>` advisory onto the result
 * note; direct creation of a new file is verdict-`clean`, so it is never
 * advisory'd. Watcher echos of the session's own writes are absorbed by the
 * ledger's stat punch, so consecutive Edits stay clean. Checked after
 * `permission` (ignition order is set by `agentLifecycle`). Bound at Agent
 * scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  ToolBeforeExecuteContext,
  ToolDidExecuteContext,
  ToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IFlagService } from '#/app/flag/flag';
import { MULTI_SERVER_FLAG_ID } from '#/app/multiServer/flag';
import {
  ISessionFileLedger,
  type FileLedgerVerdict,
} from '#/session/sessionFileLedger/fileLedger';
import type { ToolAccesses } from '#/tool/toolContract';

import { IAgentFileFencingService } from './fileFencing';

const READ_TOOL = 'Read';
const WRITE_TOOLS = new Set(['Write', 'Edit']);

interface FencingTarget {
  readonly toolName: string;
  readonly path: string;
}

function isFenced(ctx: ToolExecutionHookContext): boolean {
  return ctx.toolCall.name === READ_TOOL || WRITE_TOOLS.has(ctx.toolCall.name);
}

function targetPathOf(ctx: ToolBeforeExecuteContext): string | undefined {
  return fileAccessPath(ctx.execution.accesses);
}

function fileAccessPath(accesses: ToolAccesses | undefined): string | undefined {
  if (accesses === undefined) return undefined;
  for (const access of accesses) {
    if (access.kind === 'file') return access.path;
  }
  return undefined;
}

function isRangedRead(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false;
  const input = args as { readonly line_offset?: unknown; readonly n_lines?: unknown };
  return input.line_offset !== undefined || input.n_lines !== undefined;
}

function blockReason(toolName: string, path: string, verdict: FileLedgerVerdict): string {
  if (verdict === 'no-baseline') {
    return toolName === 'Edit'
      ? `Editing "${path}" is blocked: the file exists but has not been read in this session. Read it first, then retry the edit.`
      : `Writing "${path}" is blocked: the file already exists but has not been read in this session. Read it first, then retry the write.`;
  }
  const verb = toolName === 'Edit' ? 'Editing' : 'Writing';
  return (
    `${verb} "${path}" is blocked: the file changed on disk since it was last read or written ` +
    'in this session. Read it again, then retry.'
  );
}

function advisoryNote(target: FencingTarget, verdict: FileLedgerVerdict): string {
  const body =
    verdict === 'no-baseline'
      ? `"${target.path}" already existed on disk and had not been read in this session; your change overwrote it anyway.`
      : `"${target.path}" changed on disk since it was last read in this session; your change was applied anyway.`;
  return `<system>Warning: ${body} Read the file to verify the current content.</system>`;
}

function composeNote(existing: string | undefined, advisory: string): string {
  return existing === undefined || existing.length === 0
    ? advisory
    : `${existing}\n${advisory}`;
}

export class AgentFileFencingService extends Disposable implements IAgentFileFencingService {
  declare readonly _serviceBrand: undefined;

  private readonly targets = new Map<string, FencingTarget>();
  private readonly staleMarks = new Map<string, FileLedgerVerdict>();
  private markerTurnId: number | undefined;

  constructor(
    @ISessionFileLedger private readonly ledger: ISessionFileLedger,
    @IFlagService private readonly flags: IFlagService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    toolExecutor.hooks.onBeforeExecuteTool.register('writeFencing', async (ctx, next) => {
      await this.onBefore(ctx);
      if (ctx.decision?.block === true) return;
      await next();
    });
    toolExecutor.hooks.onDidExecuteTool.register('writeFencing', async (ctx, next) => {
      await this.onDid(ctx);
      await next();
    });
  }

  private async onBefore(ctx: ToolBeforeExecuteContext): Promise<void> {
    if (!isFenced(ctx)) return;
    const path = targetPathOf(ctx);
    if (path === undefined) return;
    if (this.markerTurnId !== ctx.turnId) {
      this.markerTurnId = ctx.turnId;
      this.targets.clear();
      this.staleMarks.clear();
    }
    this.targets.set(ctx.toolCall.id, { toolName: ctx.toolCall.name, path });
    if (!WRITE_TOOLS.has(ctx.toolCall.name)) return;
    const verdict = await this.ledger.compare(path);
    if (verdict === 'clean') return;
    if (this.flags.enabled(MULTI_SERVER_FLAG_ID)) {
      ctx.decision = { block: true, reason: blockReason(ctx.toolCall.name, path, verdict) };
      return;
    }
    this.staleMarks.set(ctx.toolCall.id, verdict);
  }

  private async onDid(ctx: ToolDidExecuteContext): Promise<void> {
    if (!isFenced(ctx)) return;
    const target = this.targets.get(ctx.toolCall.id);
    this.targets.delete(ctx.toolCall.id);
    const mark = this.staleMarks.get(ctx.toolCall.id);
    this.staleMarks.delete(ctx.toolCall.id);
    if (target === undefined || ctx.result.isError === true) return;
    if (target.toolName === READ_TOOL && isRangedRead(ctx.args)) return;
    await this.ledger.recordBaseline(target.path);
    if (mark !== undefined) {
      ctx.result = { ...ctx.result, note: composeNote(ctx.result.note, advisoryNote(target, mark)) };
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFileFencingService,
  AgentFileFencingService,
  InstantiationType.Eager,
  'fileFencing',
);
