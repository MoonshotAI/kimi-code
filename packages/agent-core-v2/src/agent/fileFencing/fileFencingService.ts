/**
 * `fileFencing` domain (L4) — `IAgentFileFencingService` implementation.
 *
 * Owns one Agent's in-memory file revision baselines and participates in the
 * `toolExecutor` hooks to enforce read-before-write and stale-write blocking
 * for `Write`/`Edit`. Reads current revisions through the os host filesystem
 * and keys paths with the normalization owned by `sessionFs`. Bound at Agent
 * scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { fileStatTuplesEqual } from '#/_base/utils/fs';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  ToolBeforeExecuteContext,
  ToolDidExecuteContext,
  ToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { normalizeFsWatchKey } from '#/session/sessionFs/fsWatch';
import { toolFileRevision, type ToolAccesses } from '#/tool/toolContract';

import { IAgentFileFencingService } from './fileFencing';

const READ_TOOL = 'Read';
const WRITE_TOOLS = new Set(['Write', 'Edit']);

type FileRevision =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly ino?: number;
      readonly mtimeMs?: number;
      readonly size: number;
    };

type FileFencingVerdict = 'clean' | 'stale' | 'no-baseline';

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

function isAppendWrite(ctx: ToolExecutionHookContext): boolean {
  if (ctx.toolCall.name !== 'Write' || typeof ctx.args !== 'object' || ctx.args === null) {
    return false;
  }
  return (ctx.args as { readonly mode?: unknown }).mode === 'append';
}

function fileRevisionsEqual(a: FileRevision, b: FileRevision): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists || !b.exists) return true;
  return fileStatTuplesEqual(a, b);
}

function blockReason(toolName: string, path: string, verdict: FileFencingVerdict): string {
  if (verdict === 'no-baseline') {
    return toolName === 'Edit'
      ? `Editing "${path}" is blocked: the file exists but has not been read by this agent. Read it first, then retry the edit.`
      : `Writing "${path}" is blocked: the file already exists but has not been read by this agent. Read it first, then retry the write.`;
  }
  const verb = toolName === 'Edit' ? 'Editing' : 'Writing';
  return (
    `${verb} "${path}" is blocked: the file changed on disk since it was last read or written ` +
    'by this agent. Read it again, then retry.'
  );
}

export class AgentFileFencingService extends Disposable implements IAgentFileFencingService {
  declare readonly _serviceBrand: undefined;

  private readonly baselines = new Map<string, FileRevision>();

  constructor(
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
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
    if (isAppendWrite(ctx)) return;
    const execute = ctx.decision?.execute ?? ctx.execution.execute;
    ctx.decision = {
      ...ctx.decision,
      execute: async (executeCtx) => {
        const verdict = await this.compareRevision(path);
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
      this.baselines.set(normalizeFsWatchKey(revision.path), {
        exists: true,
        ino: revision.ino,
        mtimeMs: revision.mtimeMs,
        size: revision.size,
      });
    }
  }

  private async compareRevision(path: string): Promise<FileFencingVerdict> {
    const baseline = this.baselines.get(normalizeFsWatchKey(path));
    const currentRevision = await this.tryStat(path);
    if (currentRevision === undefined) return 'stale';
    if (baseline === undefined) return currentRevision.exists ? 'no-baseline' : 'clean';
    return fileRevisionsEqual(baseline, currentRevision) ? 'clean' : 'stale';
  }

  private async tryStat(path: string): Promise<FileRevision | undefined> {
    try {
      const stat = await this.hostFs.stat(path);
      return { exists: true, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false };
      return undefined;
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
