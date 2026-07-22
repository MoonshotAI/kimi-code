/**
 * `rewind` domain (L6) — `IAgentRewindService` implementation.
 *
 * Pipeline (see `rewind.ts` for the contract): quiesce → precheck →
 * `wire.rewind` → reconcile → telemetry/event. Quiesce pauses prompt
 * launching (pending queue preserved), aborts the active turn and waits for
 * the loop to settle, then cancels an in-flight compaction — so no producer
 * can append records between the precheck and the cut, and no in-flight
 * reader (a running turn's materialized context, a compaction's snapshot)
 * can write pre-rewind results onto post-rewind state. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  formatUndoUnavailableMessage,
  type UndoUnavailableReason,
} from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ContextSizeModel, contextSizeMeasured } from '#/agent/contextSize/contextSizeOps';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnIndexModel } from '#/agent/loop/turnIndexOps';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IWireService } from '#/wire/wire';

import { IAgentRewindService, type RewindAvailability } from './rewind';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    /**
     * Published after a rewind cut has been applied live. Subscribers with
     * history-derived bookkeeping (injection positions, pending tool loads,
     * task-notification delivery mirrors) re-derive from the rebuilt models.
     */
    'context.rewound': { target: number; turns: number };
  }
}

export class AgentRewindService extends Disposable implements IAgentRewindService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @IEventBus private readonly eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
  }

  availability(): RewindAvailability {
    const { turnStarts, lastCompactionIndex } = this.wire.getModel(TurnIndexModel);
    let maxTurns = 0;
    for (const start of turnStarts) {
      if (start > lastCompactionIndex) maxTurns++;
    }
    return { maxTurns, stoppedAtCompaction: lastCompactionIndex >= 0 };
  }

  async rewind(turns: number): Promise<number> {
    if (turns <= 0) return 0;
    const pause = this.prompt.pauseLaunching();
    try {
      // Quiesce: abort the active turn (its abort propagates into a blocking
      // compaction wait) and wait for the loop to drain, then cancel any
      // remaining in-flight compaction. No records are appended afterwards
      // until the cut lands.
      if (this.loop.status().state === 'running') {
        this.loop.cancel(this.loop.status().activeTurnId);
      }
      await this.loop.settled();
      await this.fullCompaction.cancel();

      const target = this.precheckTarget(turns);
      await this.wire.rewind(target, 'undo');
      this.rebaseMeasuredTokens();
      await this.reconcileLastPrompt();
      this.telemetry.track2('conversation_undo', { count: turns });
      this.eventBus.publish({ type: 'context.rewound', target, turns });
      return turns;
    } finally {
      pause.dispose();
    }
  }

  /**
   * The cut point is the journal line of the Nth-to-last `turn.prompt`
   * record, restricted to turns after the most recent compaction (the
   * product-level compaction boundary; the wire protocol itself could cut
   * across it). Throws `session.undo_unavailable` when unsatisfiable.
   */
  private precheckTarget(turns: number): number {
    const { turnStarts, lastCompactionIndex } = this.wire.getModel(TurnIndexModel);
    const eligible: number[] = [];
    for (const start of turnStarts) {
      if (start > lastCompactionIndex) eligible.push(start);
    }
    if (eligible.length >= turns) {
      return eligible[eligible.length - turns]!;
    }
    const reason: UndoUnavailableReason =
      eligible.length === 0
        ? lastCompactionIndex >= 0
          ? 'compaction_boundary'
          : 'empty'
        : lastCompactionIndex >= 0
          ? 'compaction_boundary'
          : 'insufficient';
    throw new Error2(
      ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      formatUndoUnavailableMessage({ reason, requested: turns, undoable: eligible.length }),
      { details: { reason, requestedCount: turns, undoableCount: eligible.length } },
    );
  }

  /**
   * The measured token prefix is a live-only (transient) model, so the rewind
   * cannot rebuild it; when the cut truncates the measured prefix, rebase it
   * to an estimate over the surviving history (the pre-rewind `undo`
   * behavior, centralized here).
   */
  private rebaseMeasuredTokens(): void {
    const surviving = this.context.get();
    const measured = this.wire.getModel(ContextSizeModel);
    if (measured.length <= surviving.length) return;
    this.wire.dispatch(
      contextSizeMeasured({
        length: surviving.length,
        tokens: estimateTokensForMessages(surviving),
      }),
    );
  }

  /** Best-effort `lastPrompt` reconcile: adopt the last surviving real user
   *  prompt; leave the field untouched when none survives. Titles are never
   *  rewritten here (custom or auto). */
  private async reconcileLastPrompt(): Promise<void> {
    const history = this.context.get();
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i]!;
      if (!isUserPromptMessage(message)) continue;
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n');
      await this.metadata.update({ lastPrompt: text });
      this.eventService.publish({
        type: 'session.meta.updated',
        payload: {
          agentId: 'main',
          sessionId: this.session.sessionId,
          patch: { lastPrompt: text },
        },
      });
      return;
    }
  }
}

function isUserPromptMessage(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  return origin === undefined || origin.kind === 'user';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRewindService,
  AgentRewindService,
  InstantiationType.Eager,
  'rewind',
);
