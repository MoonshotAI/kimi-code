import { Disposable } from '#/_base/di/lifecycle';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
} from '#/agent/toolExecutor/toolHooks';
import type { ToolCall } from '#/kosong/contract/message';
import type { HostFileStat } from '#/os/interface/hostFileSystem';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ToolAccesses, ToolFileAccessOperation } from '#/tool/toolContract';

import { IStaleGuardService } from './staleGuard';
import { StaleGuardCleared, StaleGuardRecorded, staleGuardKey } from './staleGuardOps';

const WRITE_OPERATIONS: readonly ToolFileAccessOperation[] = ['write', 'readwrite'];
const READ_OPERATIONS: readonly ToolFileAccessOperation[] = ['read'];

function accessedFilePath(
  accesses: ToolAccesses | undefined,
  operations: readonly ToolFileAccessOperation[],
): string | undefined {
  for (const access of accesses ?? []) {
    if (access.kind === 'file' && operations.includes(access.operation)) return access.path;
  }
  return undefined;
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function callPathArg(call: ToolCall): string | undefined {
  if (typeof call.arguments !== 'string') return undefined;
  try {
    return stringArg(JSON.parse(call.arguments), 'path');
  } catch {
    return undefined;
  }
}

export class StaleGuardService extends Disposable implements IStaleGuardService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this.states.contributeState(staleGuardKey);
    this._register(toolExecutor.onBeforeExecuteTool((event) => this.guardWrite(event)));
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('staleGuard', async (ctx, next) => {
        await this.observeExecution(ctx);
        await next();
      }),
    );
    this._register(
      this.runtime.onDidChange(() => {
        void this.dispatcher.dispatch(new StaleGuardCleared({}));
      }),
    );
  }

  recordedMtimeMs(path: string): number | undefined {
    return this.states.get(staleGuardKey).get(path);
  }

  private guardWrite(event: BeforeToolExecuteEvent): void {
    const name = event.toolCall.name;
    if (name !== 'Edit' && name !== 'Write') return;
    const path = accessedFilePath(event.execution.accesses, WRITE_OPERATIONS);
    if (path === undefined) return;
    const displayPath = stringArg(event.args, 'path') ?? path;
    if (coveredByEarlierRead(event, displayPath)) return;
    event.waitUntil(async () => {
      const error = await this.checkWritable(path, displayPath);
      return error === undefined ? undefined : { veto: denyToolExecution(error) };
    });
  }

  private async observeExecution(ctx: ToolDidExecuteContext): Promise<void> {
    if (ctx.outcome !== 'executed' || ctx.result.isError === true) return;
    const name = ctx.toolCall.name;
    if (name === 'Read') {
      const path = accessedFilePath(ctx.accesses, READ_OPERATIONS);
      if (path !== undefined) await this.recordCurrentMtime(path);
      return;
    }
    if (name === 'Edit' || name === 'Write') {
      const path = accessedFilePath(ctx.accesses, WRITE_OPERATIONS);
      if (path !== undefined) await this.recordCurrentMtime(path);
    }
  }

  private async checkWritable(path: string, displayPath: string): Promise<string | undefined> {
    const stat = await this.statFile(path);
    if (stat === undefined || stat.mtimeMs === undefined) return undefined;
    const recorded = this.recordedMtimeMs(path);
    if (recorded === undefined) {
      return (
        `"${displayPath}" has not been read by this agent yet. ` +
        'Read the file before writing to it.'
      );
    }
    if (recorded !== stat.mtimeMs) {
      return (
        `"${displayPath}" has been modified on disk since this agent last read it. ` +
        'Read the file again before writing to it.'
      );
    }
    return undefined;
  }

  private async recordCurrentMtime(path: string): Promise<void> {
    const stat = await this.statFile(path);
    if (stat?.mtimeMs === undefined) return;
    await this.dispatcher.dispatch(new StaleGuardRecorded({ path, mtimeMs: stat.mtimeMs }));
  }

  private async statFile(path: string): Promise<HostFileStat | undefined> {
    const lease = this.runtime.acquire(['fs']);
    try {
      const stat = await lease.runtime.fs!.stat(path);
      return stat.isFile ? stat : undefined;
    } catch {
      return undefined;
    } finally {
      lease.dispose();
    }
  }
}

function coveredByEarlierRead(event: BeforeToolExecuteEvent, rawPath: string): boolean {
  for (const call of event.toolCalls) {
    if (call.id === event.toolCall.id) return false;
    if (call.name === 'Read' && callPathArg(call) === rawPath) return true;
  }
  return false;
}
