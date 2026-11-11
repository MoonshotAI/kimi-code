import type { UserPromptOrigin } from '#/agent/contextMemory/types';
/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { BugIndicatingError } from '#/_base/errors/errors';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import { formatUndoUnavailableMessage } from '#/agent/contextMemory/contextOps';
import { cutTurnUndo, isUndoAnchorOrigin, isValidUndoCount, type TurnUndoCutResult } from '#/agent/undo/turnUndo';
import { activeChain, parseTree } from '#/wire/tree/tree';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { isUserPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import { IAgentLoopService } from '#/agent/loop/loop';
import { AgentLoopService } from '#/agent/loop/loopService';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventService } from '#/app/event/event';
import { AgentEvent2 } from '#/app/event/event2';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionRunGate } from '#/session/sessionActivity/sessionRunGate';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ForkLineError, IWireService } from '#/wire/wire';

import { IAgentConversationUndoService, type UndoAvailability } from './undo';

export class ContextUndone extends AgentEvent2<{
  readonly agentId: string;
  readonly turns: number;
  readonly fromTurnId?: number;
}> {
  static override readonly type = 'context.undone';
  static override readonly observable = true;
}
export interface ContextUndone {
  readonly agentId: string;
  readonly turns: number;
  readonly fromTurnId?: number;
}

export class AgentConversationUndoService
  extends Service
  implements IAgentConversationUndoService
{
  declare readonly _serviceBrand: undefined;

  private undoQueue: Promise<void> = Promise.resolve();

  constructor(
    @IAgentLoopService private readonly loop: AgentLoopService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentLoopService private readonly context: IAgentLoopService,
    @IAgentConversationUndoParticipantRegistry
    private readonly participants: IAgentConversationUndoParticipantRegistry,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IWireService private readonly wire: IWireService,
    @ILogService private readonly log: ILogService,
    @ISessionRunGate private readonly runGate: ISessionRunGate,
  ) {
    super();
  }

  availability(): UndoAvailability {
    const result = this.undoResult(Number.MAX_SAFE_INTEGER);
    return {
      maxTurns: result.anchors.length,
      stoppedAtCompaction: result.stoppedAtCompaction,
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
      if (this.dispatcher.restorePhase !== 'ready') {
        throw new BugIndicatingError(
          `Conversation undo requires a restored dispatcher (phase '${this.dispatcher.restorePhase}')`,
        );
      }
      this.runGate.begin();
      await this.wire.drainPersisted();
      const fromTurnId = this.assertUndoAvailable(turns);
      try {
        await this.wire.switchBranch({ turns, fromTurnId });
      } catch (error) {
        throw this.forkError(error, turns);
      }
      try {
        await this.dispatcher.restore();
      } catch (error) {
        this.log.warn('undo state restore failed; retrying once', { error });
        await this.dispatcher.restore();
      }
      await this.loop.resetLoop();
      this.tokenCounting.recordTruncation(
        this.agentCtx.agentContext,
        this.context.history().length,
      );
      await this.reconcileParticipants();
      await this.flushAfterReconcile();
      await this.reconcileParticipants('after-flush');
      this.loop.flushReminders();
      await this.reconcileLastPromptSafely();
      this.telemetry.track2('conversation_undo', { count: turns });
      await this.dispatcher.dispatch(
        new ContextUndone({ agentId: this.agentCtx.agentId, turns, fromTurnId }),
      );
      return turns;
    } finally {
      quiescence?.dispose();
    }
  }

  private forkError(error: unknown, turns: number): unknown {
    if (!(error instanceof ForkLineError)) return error;
    return new Error2(
      ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      formatUndoUnavailableMessage({
        ok: false,
        reason: error.reason,
        requested: turns,
        undoable: error.available,
      }),
      {
        details: {
          reason: error.reason,
          requestedCount: turns,
          undoableCount: error.available,
        },
      },
    );
  }

  private activeUndoChain() {
    const entries = this.wire.readHumanJournal();
    const tree = parseTree(entries, entries.at(-1)?.line ?? 0);
    return {
      chain: activeChain(entries, tree),
      pairedLegacyUndoLines: tree.pairedLegacyUndoLines,
    };
  }

  private undoResult(turns: number): TurnUndoCutResult {
    const { chain, pairedLegacyUndoLines } = this.activeUndoChain();
    return cutTurnUndo(chain, pairedLegacyUndoLines, turns);
  }

  private busyError(reason: 'loop' | 'compaction'): Error2 {
    const message = reason === 'loop'
      ? 'Cannot undo while a turn is active or queued. Wait for it to finish, then retry.'
      : 'Cannot undo while conversation compaction is running. Wait for it to finish, then retry.';
    return new Error2(ErrorCodes.SESSION_BUSY, message, { details: { reason } });
  }

  private assertUndoAvailable(turns: number): number | undefined {
    const result = this.undoResult(turns);
    if (result.cut !== undefined) return result.cut.anchor.turnId;
    const check = {
      ok: false as const,
      reason: result.stoppedAtCompaction
        ? 'compaction_boundary' as const
        : result.anchors.length === 0
          ? 'empty' as const
          : 'insufficient' as const,
      requested: turns,
      undoable: result.anchors.length,
    };
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

  private async reconcileParticipants(phase?: 'after-flush'): Promise<void> {
    const participants = this.participants.list().filter((participant) => participant.phase === phase);
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

  private async flushAfterReconcile(): Promise<void> {
    try {
      await this.dispatcher.flush();
    } catch (error) {
      this.log.error('undo wire flush failed after in-memory commit', {
        stage: 'state reconciliation',
        error,
      });
      throw error;
    }
  }

  private async reconcileLastPrompt(): Promise<void> {
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) return;
    const pending = this.loop.snapshot().queue.filter((item) => item.meta?.origin?.kind === 'user').at(-1);
    let lastPrompt = pending === undefined
      ? undefined
      : promptMetadataTextFromContentParts(pending.message.content.filter((part) => !isUserPromptSubmitHookPart(part)), (pending.meta?.origin as UserPromptOrigin | undefined)?.clientMetadata);
    if (lastPrompt === undefined) {
      const steered = new Set<string>();
      for (const { record } of this.activeUndoChain().chain) {
        if (record.type !== 'turn.steer') continue;
        const promptIds = record['promptIds'];
        if (Array.isArray(promptIds)) {
          for (const id of promptIds) {
            if (typeof id === 'string') steered.add(id);
          }
        }
        const messageId = record['messageId'];
        if (typeof messageId === 'string') steered.add(messageId);
      }
      const history = this.context.history();
      for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i]!;
        if (message.id !== undefined && steered.has(message.id)) continue;
        if (!isUndoAnchorOrigin(message.origin)) continue;
        lastPrompt = promptMetadataTextFromContentParts(
          message.content.filter((part) => !isUserPromptSubmitHookPart(part)),
          message.origin?.kind === 'user' || message.origin?.kind === 'skill_activation'
            ? message.origin.clientMetadata
            : undefined,
        );
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
