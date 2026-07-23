/**
 * `rewind` domain (L6) — `IAgentRewindService` implementation.
 *
 * Owns conversation rewind coordination and restored observable state.
 * Coordinates `contextMemory`, conversation reconciliation, `fullCompaction`,
 * `loop`, `prompt`, Agent and Session identity, `sessionMetadata`, `event`,
 * `eventBus`, `telemetry`, and `wire`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  IAgentConversationReconciliationRegistry,
  type AgentConversationReconciliationPhase,
} from '#/agent/contextMemory/conversationReconciliation';
import {
  computeUndoCut,
  formatUndoUnavailableMessage,
  precheckUndo,
} from '#/agent/contextMemory/contextOps';
import {
  CHECKPOINTED_MODELS,
  isUndoAnchor,
  type Checkpointed,
} from '#/agent/contextMemory/conversationTime';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IWireService } from '#/wire/wire';

import { IAgentRewindService, type RewindAvailability } from './rewind';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'context.rewound': { turns: number };
  }
}

export class AgentRewindService extends Disposable implements IAgentRewindService {
  declare readonly _serviceBrand: undefined;

  private rewindQueue: Promise<void> = Promise.resolve();

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentConversationReconciliationRegistry
    private readonly participants: IAgentConversationReconciliationRegistry,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @IEventBus private readonly eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWireService private readonly wire: IWireService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  availability(): RewindAvailability {
    const cut = computeUndoCut(this.context.get(), Number.MAX_SAFE_INTEGER);
    const maxTurns = Math.min(cut.removedCount, this.checkpointDepth());
    return {
      maxTurns,
      stoppedAtCompaction: cut.stoppedAtCompaction || maxTurns < cut.removedCount,
    };
  }

  async rewind(turns: number): Promise<number> {
    if (turns <= 0) return 0;
    this.assertUndoAvailable(turns);
    const run = this.rewindQueue.then(() => this.rewindNow(turns));
    this.rewindQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async rewindNow(turns: number): Promise<number> {
    this.assertUndoAvailable(turns);
    const pause = this.prompt.pauseLaunching();
    const compactionPause = this.fullCompaction.pauseLaunching();
    let quiescence: IDisposable | undefined;
    try {
      [quiescence] = await Promise.all([
        this.loop.acquireQuiescence(),
        this.fullCompaction.cancel(),
      ]);
      this.assertUndoAvailable(turns);
      this.context.undo(turns);
      await this.flushAfterCommit('context cut');
      await this.reconcileParticipants('state');
      await this.flushAfterCommit('state reconciliation');
      await this.reconcileParticipants('projection');
      await this.flushAfterCommit('projection reconciliation');
      await this.reconcileLastPromptSafely();
      this.telemetry.track2('conversation_undo', { count: turns });
      this.eventBus.publish({ type: 'context.rewound', turns });
      return turns;
    } finally {
      compactionPause.dispose();
      quiescence?.dispose();
      pause.dispose();
    }
  }

  private checkpointDepth(): number {
    let depth = Number.POSITIVE_INFINITY;
    for (const def of CHECKPOINTED_MODELS) {
      const state = this.wire.getModel(def) as Checkpointed<unknown>;
      depth = Math.min(depth, state.checkpoints.length);
    }
    return depth;
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
    const depth = this.checkpointDepth();
    if (depth >= turns) return;
    throw new Error2(
      ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      formatUndoUnavailableMessage({
        ok: false,
        reason: 'compaction_boundary',
        requested: turns,
        undoable: depth,
      }),
      {
        details: {
          reason: 'compaction_boundary',
          requestedCount: turns,
          undoableCount: depth,
        },
      },
    );
  }

  private async reconcileParticipants(phase: AgentConversationReconciliationPhase): Promise<void> {
    const participants = this.participants
      .list()
      .filter((participant) => (participant.phase ?? 'state') === phase);
    const results = await Promise.allSettled(
      participants.map((participant) => participant.reconcileAfterRewind()),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      this.log.error('rewind participant reconciliation failed', {
        participantId: participants[index]?.id,
        error: result.reason,
      });
    });
  }

  private async reconcileLastPromptSafely(): Promise<void> {
    try {
      await this.reconcileLastPrompt();
    } catch (error) {
      this.log.error('rewind lastPrompt reconciliation failed', { error });
    }
  }

  private async flushAfterCommit(stage: string): Promise<void> {
    try {
      await this.wire.flush();
    } catch (error) {
      this.log.error('rewind wire flush failed after in-memory commit', { stage, error });
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
    this.eventService.publish({
      type: 'session.meta.updated',
      payload: {
        agentId: MAIN_AGENT_ID,
        sessionId: this.session.sessionId,
        patch: { lastPrompt },
      },
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRewindService,
  AgentRewindService,
  InstantiationType.Eager,
  'rewind',
);
