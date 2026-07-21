/**
 * `fileFencing` domain (L4) — `IAgentFileFencingService` implementation.
 *
 * Registers the `writeFencing` participant on the `toolExecutor`
 * `onBeforeExecuteTool` / `onDidExecuteTool` hook slots, matching
 * `Read`/`Write`/`Edit` by tool name and letting every other tool pass
 * through. For Write/Edit the before hook injects an execution wrapper; the
 * wrapper re-checks the ledger only after the scheduler grants the declared
 * file access, so a queued write cannot rely on a stale preflight verdict. The
 * target path comes from the resolved execution's file accesses
 * — the exact canonical path the tool itself computed — so the ledger and
 * the watcher key it identically. The before-hook records the target keyed
 * by `toolCall.id` (cleared in the did-hook and swept on turn change) and,
 * for `Write`/`Edit`, computes the ledger verdict: `stale` blocks with an
 * outside-modification conflict and `no-baseline` blocks with a read-first
 * reason (Edit-over-existing, or Write over an already existing file). The
 * did-hook records the revision captured by the successful fenced call
 * (ranged Reads excepted — per the ledger contract they never count as full
 * reads); direct creation of a new file is verdict-`clean`, so it never
 * blocks. Watcher echos of the session's own writes are absorbed by the
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
import {
  ISessionFileLedger,
  type FileLedgerVerdict,
} from '#/session/sessionFileLedger/fileLedger';
import {
  toolFileRevision,
  type ToolAccesses,
  type ToolFileRevision,
} from '#/tool/toolContract';

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

function revisionForTarget(
  revision: ToolFileRevision | undefined,
  targetPath: string,
): ToolFileRevision | undefined {
  return revision?.path === targetPath ? revision : undefined;
}

export class AgentFileFencingService extends Disposable implements IAgentFileFencingService {
  declare readonly _serviceBrand: undefined;

  private readonly targets = new Map<string, FencingTarget>();
  private markerTurnId: number | undefined;

  constructor(
    @ISessionFileLedger private readonly ledger: ISessionFileLedger,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    toolExecutor.hooks.onBeforeExecuteTool.register('writeFencing', async (ctx, next) => {
      this.onBefore(ctx);
      if (ctx.decision?.block === true) return;
      await next();
    });
    toolExecutor.hooks.onDidExecuteTool.register('writeFencing', async (ctx, next) => {
      await this.onDid(ctx);
      await next();
    });
  }

  private onBefore(ctx: ToolBeforeExecuteContext): void {
    if (!isFenced(ctx)) return;
    const path = targetPathOf(ctx);
    if (path === undefined) return;
    if (this.markerTurnId !== ctx.turnId) {
      this.markerTurnId = ctx.turnId;
      this.targets.clear();
    }
    this.targets.set(ctx.toolCall.id, { toolName: ctx.toolCall.name, path });
    if (!WRITE_TOOLS.has(ctx.toolCall.name)) return;
    const execute = ctx.decision?.execute ?? ctx.execution.execute;
    ctx.decision = {
      ...ctx.decision,
      execute: async (executeCtx) => {
        const verdict = await this.ledger.compare(path);
        if (verdict !== 'clean') {
          const reason = blockReason(ctx.toolCall.name, path, verdict);
          return { output: reason, isError: true };
        }
        return execute(executeCtx);
      },
    };
  }

  private async onDid(ctx: ToolDidExecuteContext): Promise<void> {
    if (!isFenced(ctx)) return;
    const target = this.targets.get(ctx.toolCall.id);
    this.targets.delete(ctx.toolCall.id);
    if (target === undefined || ctx.result.isError === true) return;
    if (target.toolName === READ_TOOL && isRangedRead(ctx.args)) return;
    const revision = revisionForTarget(ctx.result[toolFileRevision], target.path);
    if (revision !== undefined) {
      this.ledger.recordBaseline(target.path, {
        exists: true,
        ino: revision.ino,
        mtimeMs: revision.mtimeMs,
        size: revision.size,
      });
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
