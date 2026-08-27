import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { AgentContextMemory, type ContextMemoryRuntime } from '#/features/contextMemory/contextMemoryAgentRuntime';
import {
  computeUndoCut,
  formatUndoUnavailableMessage,
  precheckUndo,
} from '#/features/contextMemory/contextOps';
import {
  isUndoAnchor,
  isValidUndoCount,
} from '#/features/contextMemory/conversationTime';
import { AgentFullCompaction } from '#/features/fullCompaction/fullCompactionAgentRuntime';
import { LoopControlToken, type LoopControl } from '#/features/loop/internal/loop';
import { AgentPrompt } from '#/features/prompt/promptAgentRuntime';
import { promptMetadataTextFromContentParts } from '#/features/prompt/promptMetadataText';
import { IAgentStateService } from '#/agent/state/agentState';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { IEventService } from '#/app/event/event';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { BugIndicatingError, ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { keepsUndoCheckpoints } from '#/state/state';

import type { AgentConversationUndoParticipant, UndoAvailability, UndoResult } from '../undoAgentRuntime';
import { ContextUndone } from '../undoEvents';

export class UndoDomain {
  private undoQueue: Promise<void> = Promise.resolve();
  private readonly participants = new Map<string, AgentConversationUndoParticipant>();

  constructor(private readonly runtime: AgentRuntimeContext<null>) {}

  private get loop(): LoopControl {
    return this.runtime.get(LoopControlToken);
  }

  private get manager(): IAgentLifecycleService {
    return this.runtime.get(IAgentLifecycleService);
  }

  private get session(): ISessionContext {
    return this.runtime.get(ISessionContext);
  }

  private get metadata(): ISessionMetadata {
    return this.runtime.get(ISessionMetadata);
  }

  private get eventService(): IEventService {
    return this.runtime.get(IEventService);
  }

  private get telemetry(): ITelemetryService {
    return this.runtime.get(ITelemetryService);
  }

  private get dispatcher(): IEventDispatcher {
    return this.runtime.get(IEventDispatcher);
  }

  private get agentState(): IAgentStateService {
    return this.runtime.get(IAgentStateService);
  }

  private get log(): ILogService {
    return this.runtime.get(ILogService);
  }

  private get agentId(): string {
    return this.runtime.agent.agentId;
  }

  private get context(): ContextMemoryRuntime {
    return this.manager.resolve(this.runtime.agent, AgentContextMemory);
  }

  availability(): UndoAvailability {
    const cut = computeUndoCut(this.context.get(), Number.MAX_SAFE_INTEGER);
    const maxTurns = Math.min(cut.removedCount, this.checkpointDepth().depth);
    return { canUndo: maxTurns > 0 };
  }

  async undo(count: number): Promise<UndoResult> {
    if (!isValidUndoCount(count)) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Undo count must be a positive safe integer',
        { details: { field: 'count' } },
      );
    }
    const run = this.undoQueue.then(() => this.undoNow(count));
    this.undoQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  registerParticipant(participant: AgentConversationUndoParticipant): IDisposable {
    if (this.participants.has(participant.id)) {
      throw new BugIndicatingError(
        `Conversation undo participant "${participant.id}" is already registered`,
      );
    }
    this.participants.set(participant.id, participant);
    return toDisposable(() => {
      if (this.participants.get(participant.id) === participant) {
        this.participants.delete(participant.id);
      }
    });
  }

  private async undoNow(count: number): Promise<UndoResult> {
    let quiescence: IDisposable | undefined;
    try {
      quiescence = this.loop.tryAcquireQuiescence();
      if (quiescence === undefined) {
        throw this.busyError('loop');
      }
      if (
        this.manager.resolve(this.runtime.agent, AgentFullCompaction).status() === 'running'
      ) {
        throw this.busyError('compaction');
      }
      this.assertUndoAvailable(count);
      void this.context.undo(count);
      await this.flushAfterCommit('context cut');
      await this.reconcileParticipants();
      await this.flushAfterCommit('state reconciliation');
      await this.reconcileLastPromptSafely();
      this.telemetry.track2('conversation_undo', { count });
      await this.dispatcher.dispatch(
        new ContextUndone({ agentId: this.agentId, turns: count }),
      );
      return { applied: true };
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
    for (const entry of this.dispatcher.participantCheckpointDepths()) {
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

  private assertUndoAvailable(count: number): void {
    const check = precheckUndo(this.context.get(), count);
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
    if (depth >= count) return;
    const fullCut = computeUndoCut(this.context.get(), Number.MAX_SAFE_INTEGER);
    const reason = fullCut.stoppedAtCompaction ? 'compaction_boundary' : 'checkpoint_lost';
    throw new Error2(
      ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      formatUndoUnavailableMessage({
        ok: false,
        reason,
        requested: count,
        undoable: depth,
      }),
      {
        details: {
          reason,
          requestedCount: count,
          undoableCount: depth,
          model,
        },
      },
    );
  }

  private async reconcileParticipants(): Promise<void> {
    const participants = [...this.participants.values()];
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
    if (this.agentId !== MAIN_AGENT_ID) return;
    const pending = this.manager.resolve(this.runtime.agent, AgentPrompt).list().pending.at(-1);
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
