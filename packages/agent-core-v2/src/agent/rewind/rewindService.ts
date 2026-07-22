/**
 * `rewind` domain (L6) — `IAgentRewindService` implementation.
 *
 * Coordinates `prompt`, `loop`, and `fullCompaction`; persists history changes
 * through `contextMemory`; reconciles `task` delivery and `sessionMetadata`;
 * and reports through `telemetry` and `event`. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  computeUndoCut,
  formatUndoUnavailableMessage,
  precheckUndo,
} from '#/agent/contextMemory/contextOps';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentRewindService, type RewindAvailability } from './rewind';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'context.rewound': { turns: number };
  }
}

export class AgentRewindService extends Disposable implements IAgentRewindService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly fullCompaction: IAgentFullCompactionService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @IEventBus private readonly eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
  }

  availability(): RewindAvailability {
    const cut = computeUndoCut(this.context.get(), Number.MAX_SAFE_INTEGER);
    return { maxTurns: cut.removedCount, stoppedAtCompaction: cut.stoppedAtCompaction };
  }

  async rewind(turns: number): Promise<number> {
    if (turns <= 0) return 0;
    const pause = this.prompt.pauseLaunching();
    try {
      if (this.loop.status().state === 'running') {
        this.loop.cancel(this.loop.status().activeTurnId);
      }
      await this.loop.settled();
      await this.fullCompaction.cancel();

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
      this.context.undo(turns);
      await this.tasks.reconcileNotificationDeliveryAfterUndo().catch(() => {});
      await this.reconcileLastPrompt().catch(() => {});
      this.telemetry.track2('conversation_undo', { count: turns });
      this.eventBus.publish({ type: 'context.rewound', turns });
      return turns;
    } finally {
      pause.dispose();
    }
  }

  private async reconcileLastPrompt(): Promise<void> {
    const history = this.context.get();
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i]!;
      if (!isRealUserInput(message)) continue;
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentRewindService,
  AgentRewindService,
  InstantiationType.Eager,
  'rewind',
);
