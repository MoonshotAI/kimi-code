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
 * — the exact canonical path the tool itself computed. `stale` blocks with an
 * outside-modification conflict and `no-baseline` blocks with a read-first
 * reason (Edit-over-existing, or Write over an already existing file). The
 * did-hook baselines the ledger from the revision the successful call captured
 * on its own result (ranged Reads excepted — per the ledger contract they
 * never count as full reads); direct creation of a new file is verdict-`clean`,
 * so it never blocks. Checked after `permission` (ignition order is set by
 * `agentLifecycle`). Bound at Agent scope.
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
import { toolFileRevision, type ToolAccesses } from '#/tool/toolContract';

import { IAgentFileFencingService } from './fileFencing';

const READ_TOOL = 'Read';
const WRITE_TOOLS = new Set(['Write', 'Edit']);

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

export class AgentFileFencingService extends Disposable implements IAgentFileFencingService {
  declare readonly _serviceBrand: undefined;

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
      this.onDid(ctx);
      await next();
    });
  }

  private onBefore(ctx: ToolBeforeExecuteContext): void {
    if (!isFenced(ctx)) return;
    const path = targetPathOf(ctx);
    if (path === undefined) return;
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

  private onDid(ctx: ToolDidExecuteContext): void {
    if (!isFenced(ctx)) return;
    if (ctx.result.isError === true) return;
    if (ctx.toolCall.name === READ_TOOL && isRangedRead(ctx.args)) return;
    const revision = ctx.result[toolFileRevision];
    if (revision !== undefined) {
      this.ledger.recordBaseline(revision.path, {
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
