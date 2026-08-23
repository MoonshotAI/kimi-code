/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import {
  computeUndoCut,
  formatUndoUnavailableMessage,
  precheckUndo,
} from '#/agent/contextMemory/contextOps';
import {
  isUndoAnchor,
  isValidUndoCount,
} from '#/agent/contextMemory/conversationTime';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventService } from '#/app/event/event';
import { AgentEvent2 } from '#/app/event/event2';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { keepsUndoCheckpoints } from '#/state/state';

import { IAgentConversationUndoService, type UndoAvailability } from './undo';

export class ContextUndone extends AgentEvent2<{ readonly agentId: string; readonly turns: number }> {
  static override readonly type = 'context.undone';
  static override readonly observable = true;
}
export interface ContextUndone {
  readonly agentId: string;
  readonly turns: number;
}

export class AgentConversationUndoService
  extends Service
  implements IAgentConversationUndoService
{
  declare readonly _serviceBrand: undefined;

  private undoQueue: Promise<void> = Promise.resolve();

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentConversationUndoParticipantRegistry
    private readonly participants: IAgentConversationUndoParticipantRegistry,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  availability(): UndoAvailability {
    const cut = computeUndoCut(this.context.get(), Number.MAX_SAFE_INTEGER);
    const maxTurns = Math.min(cut.removedCount, this.checkpointDepth().depth);
    return {
      maxTurns,
      stoppedAtCompaction: cut.stoppedAtCompaction || maxTurns < cut.removedCount,
    };
  }

  async undo(turns: number): Promise<number> {
    if (!isValidUndoCount(turns)) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Undo count must be a positive safe integer',
        { details: { field: 'count' } },
      );
    }
    const run = this.undoQueue.then(() => this.undoNow(turns));
    this.undoQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async undoNow(turns: number): Promise<number> {
    let quiescence: IDisposable | undefined;
    try {
      quiescence = this.loop.tryAcquireQuiescence();
      if (quiescence === undefined) {
        throw this.busyError('loop');
      }
      if (this.fullCompaction.compacting !== null) {
        throw this.busyError('compaction');
      }
      this.assertUndoAvailable(turns);
      this.context.undo(turns);
      await this.flushAfterCommit('context cut');
      await this.reconcileParticipants();
      await this.flushAfterCommit('state reconciliation');
      await this.reconcileLastPromptSafely();
      this.telemetry.track2('conversation_undo', { count: turns });
      await this.dispatcher.dispatch(
        new ContextUndone({ agentId: this.agentCtx.agentId, turns }),
      );
      return turns;
    } finally {
      quiescence?.dispose();
    }
  }

  private checkpointDepth(): { depth: number; model: string } {
    let depth = Number.POSITIVE_INFINITY;
    let model = '';
    for (const key of this.agentState.replayableKeys()) {
      if (!keepsUndoCheckpoints(key)) continue;
      const stateDepth = this.dispatcher.checkpointDepth(key);
      if (stateDepth < depth) {
        depth = stateDepth;
        model = key.name;
      }
    }
    for (const entry of this.dispatcher.modelCheckpointDepths()) {
      if (entry.depth < depth) {
        depth = entry.depth;
        model = entry.id;
      }
    }
    return { depth, model };
  }

  private busyError(reason: 'loop' | 'compaction'): Error2 {
    const message = reason === 'loop'
      ? 'Cannot undo while a turn is active or queued. Wait for it to finish, then retry.'
      : 'Cannot undo while conversation compaction is running. Wait for it to finish, then retry.';
    return new Error2(ErrorCodes.SESSION_BUSY, message, { details: { reason } });
  }

  private assertUndoAvailable(turns: number): void {
    const check = precheckUndo(this.context.get(), turns);
    if (!check.ok) {
      throw new Error2(
        ErrorCodes.SESSION_UNDO_UNAVAILABLE,
        formatUndoUnavailableMessage(check),
        {
          details: {
            reason: check.reason,
            requestedCount: check.requested,
            undoableCount: check.undoable,
          },
        },
      );
    }
    const { depth, model } = this.checkpointDepth();
    if (depth >= turns) return;
    const fullCut = computeUndoCut(this.context.get(), Number.MAX_SAFE_INTEGER);
    const reason = fullCut.stoppedAtCompaction ? 'compaction_boundary' : 'checkpoint_lost';
    throw new Error2(
      ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      formatUndoUnavailableMessage({
        ok: false,
        reason,
        requested: turns,
        undoable: depth,
      }),
      {
        details: {
          reason,
          requestedCount: turns,
          undoableCount: depth,
          model,
        },
      },
    );
  }

  private async reconcileParticipants(): Promise<void> {
    const participants = this.participants.list();
    const results = await Promise.allSettled(
      participants.map((participant) => participant.reconcileAfterUndo()),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      this.log.error('undo participant reconciliation failed', {
        participantId: participants[index]?.id,
        error: result.reason,
      });
    });
  }

  private async reconcileLastPromptSafely(): Promise<void> {
    try {
      await this.reconcileLastPrompt();
    } catch (error) {
      this.log.error('undo lastPrompt reconciliation failed', { error });
    }
  }

  private async flushAfterCommit(stage: string): Promise<void> {
    try {
      await this.dispatcher.flush();
    } catch (error) {
      this.log.error('undo wire flush failed after in-memory commit', { stage, error });
      throw error;
    }
  }

  private async reconcileLastPrompt(): Promise<void> {
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) return;
    const pending = this.prompt.list().pending.at(-1);
    let lastPrompt = pending === undefined
      ? undefined
      : promptMetadataTextFromContentParts(pending.message.content);
    if (lastPrompt === undefined) {
      const history = this.context.get();
      for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i]!;
        if (!isUndoAnchor(message)) continue;
        lastPrompt = promptMetadataTextFromContentParts(message.content);
        if (lastPrompt !== undefined) break;
      }
    }
    await this.metadata.update({ lastPrompt });
    this.eventService.publish(
      new SessionMetaUpdated({
        payload: {
          agentId: MAIN_AGENT_ID,
          sessionId: this.session.sessionId,
          patch: { lastPrompt },
        },
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentConversationUndoService,
  AgentConversationUndoService,
  ScopeActivation.OnScopeCreated,
  'undo',
);
