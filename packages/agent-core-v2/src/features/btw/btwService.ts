import { Disposable } from '#/_base/di/lifecycle';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { registerLegacyStarting } from '#/agent/toolExecutor/legacyHooks';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import {
  BTW_AGENT_LABEL,
  BTW_READONLY_TOOLS,
  ISessionBtwService,
  SIDE_QUESTION_SYSTEM_REMINDER,
  TOOL_CALL_DISABLED_MESSAGE,
} from './btw';

export class SessionBtwService extends Disposable implements ISessionBtwService {
  declare readonly _serviceBrand: undefined;
  private readonly closing = new Map<string, Promise<void>>();

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
  ) {
    super();
    this._register(
      this.agentLifecycle.onDidCreateScope(({ meta, handle }) => {
        if (meta?.labels?.[BTW_AGENT_LABEL] !== 'true') return;
        const reason =
          handle.accessor.get(IAgentToolApprovalService)?.formatDenyMessage(
            TOOL_CALL_DISABLED_MESSAGE,
          ) ?? TOOL_CALL_DISABLED_MESSAGE;
        const toolExecutor = handle.accessor.get(IAgentToolExecutorService);
        if (toolExecutor !== undefined) {
          this._register(registerLegacyStarting(toolExecutor, (event) => {
            if (!BTW_READONLY_TOOLS.has(event.toolCall.name)) {
              event.veto(denyToolExecution(reason));
            }
          }));
        }
      }),
    );
  }

  async start(): Promise<string> {
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    const childContext = await this.agentLifecycle.fork(
      main.accessor.get(IAgentScopeContext).agentContext,
      { labels: { [BTW_AGENT_LABEL]: 'true' } },
    );
    const child = this.agentLifecycle.handleOf(childContext.agentId)!;
    child.accessor
      .get(IAgentReminderService)
      .notify(SIDE_QUESTION_SYSTEM_REMINDER, { variant: 'btw' });
    return childContext.agentId;
  }

  async close(agentId: string): Promise<void> {
    if (agentId === MAIN_AGENT_ID) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_CLOSABLE,
        `Agent "${agentId}" is not a side-channel agent and cannot be closed`,
      );
    }
    const inflight = this.closing.get(agentId);
    if (inflight !== undefined) return inflight;
    const task = this.doClose(agentId).finally(() => {
      if (this.closing.get(agentId) === task) this.closing.delete(agentId);
    });
    this.closing.set(agentId, task);
    return task;
  }

  private async doClose(agentId: string): Promise<void> {
    const persisted = (await this.sessionMetadata.read()).agents?.[agentId];
    const live = this.agentLifecycle.get(agentId);
    const liveHandle = this.agentLifecycle.handleOf(agentId);
    if (persisted === undefined && live === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" was not found`);
    }
    let liveMeta: { readonly labels?: Readonly<Record<string, string>> } | undefined;
    if (liveHandle !== undefined) {
      try {
        liveMeta = liveHandle.accessor.get(IAgentScopeContext).meta;
      } catch {
        liveMeta = undefined;
      }
    }
    const isBtw =
      persisted?.labels?.[BTW_AGENT_LABEL] === 'true' ||
      liveMeta?.labels?.[BTW_AGENT_LABEL] === 'true';
    if (!isBtw) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_CLOSABLE,
        `Agent "${agentId}" is not a side-channel agent and cannot be closed`,
      );
    }
    await this.sessionMetadata.unregisterAgent(agentId);
    if (this.agentLifecycle.removeById !== undefined) {
      await this.agentLifecycle.removeById(agentId);
      return;
    }
    const target = this.agentLifecycle.get(agentId) ?? live;
    if (target !== undefined) {
      await this.agentLifecycle.remove(target);
    }
  }
}
