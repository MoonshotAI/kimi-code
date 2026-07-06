import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError } from '#/errors';

import {
  ensureMessageId,
  IAgentContextMemoryService,
  type ContextMessage,
} from '#/agent/contextMemory';
import { IAgentLoopService } from '#/agent/loop';
import { IAgentTurnService, type Turn } from '#/agent/turn';
import { OrderedHookSlot } from '#/hooks';
import {
  IAgentPromptService,
  type PromptSubmitContext,
  type PromptSteerHandle,
} from './prompt';

interface QueuedSteer {
  readonly message: ContextMessage;
  emitted: boolean;
  removed: boolean;
}

export class AgentPromptService implements IAgentPromptService {
  declare readonly _serviceBrand: undefined;
  private readonly steerQueue: QueuedSteer[] = [];
  private observedTurn: Turn | undefined;

  readonly hooks = {
    onWillSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>(),
  };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTurnService private readonly turnService: IAgentTurnService,
    @IAgentLoopService loopService: IAgentLoopService,
  ) {
    loopService.hooks.beforeStep.register('prompt-service-steer-before-step', async (_ctx, next) => {
      this.flushSteerQueue();
      await next();
    });
    loopService.hooks.afterStep.register('prompt-service-steer', async (ctx, next) => {
      if (this.flushSteerQueue()) {
        ctx.continue = true;
      }
      await next();
    });
  }

  async prompt(message: ContextMessage): Promise<Turn | undefined> {
    const stamped = ensureMessageId(message);
    this.append(stamped);
    if (await this.blockedByHook(stamped, false)) return undefined;
    return this.launch();
  }

  steer(message: ContextMessage): PromptSteerHandle {
    const activeTurn = this.turnService.getActiveTurn();
    if (activeTurn === undefined) {
      return {
        removeFromQueue: () => {
          throw steerAlreadyEmittedError();
        },
        launched: this.prompt(message),
      };
    }

    const entry: QueuedSteer = {
      message: ensureMessageId(message),
      emitted: false,
      removed: false,
    };
    return {
      removeFromQueue: () => this.removeQueuedSteer(entry),
      launched: this.enqueueSteer(activeTurn, entry),
    };
  }

  retry(trigger?: string): Turn | undefined {
    return this.launch();
  }

  undo(count: number): number {
    if (count <= 0) return 0;

    const history = this.context.get();
    let removedCount = 0;
    let stoppedAtCompaction = false;
    for (let index = history.length - 1; index >= 0 && removedCount < count; index--) {
      const message = history[index];
      if (message === undefined || message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') {
        stoppedAtCompaction = true;
        break;
      }

      this.context.splice(index, 1, []);
      if (isRealUserPrompt(message)) {
        removedCount++;
      }
    }

    // `undo` is only ever invoked live (user / RPC); the legacy `context.undo`
    // record is migrated to `context.splice` and replayed by contextMemory, so
    // this method never runs during restore and needs no restoring-phase guard.
    if (removedCount < count) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        formatUndoUnavailableMessage(count, removedCount, stoppedAtCompaction),
        {
          details: {
            reason: 'undo_limit',
            requestedCount: count,
            undoableCount: removedCount,
            stoppedAtCompaction,
          },
        },
      );
    }
    return removedCount;
  }

  clear(): void {
    this.discardQueuedSteers();
    const historyLength = this.context.get().length;
    if (historyLength > 0) {
      this.context.splice(0, historyLength, []);
    }
  }

  private append(...messages: ContextMessage[]): void {
    this.context.splice(this.context.get().length, 0, messages);
  }

  private launch(): Turn {
    const turn = this.turnService.launch();
    this.observe(turn);
    return turn;
  }

  private async blockedByHook(promptMessage: ContextMessage, isSteer: boolean): Promise<boolean> {
    const hookContext: PromptSubmitContext = {
      promptMessage,
      isSteer,
      block: false,
    };
    await this.hooks.onWillSubmitPrompt.run(hookContext);
    return hookContext.block;
  }

  private observe(turn: Turn): void {
    if (this.observedTurn === turn) return;
    this.observedTurn = turn;
    void turn.result.then((result) => {
      if (this.observedTurn === turn) {
        this.observedTurn = undefined;
      }
      if (result.reason !== 'completed') {
        this.discardQueuedSteers();
      }
    });
  }

  private flushSteerQueue(): boolean {
    const pending = this.steerQueue.splice(0).filter((entry) => !entry.removed);
    if (pending.length === 0) return false;

    for (const entry of pending) {
      entry.emitted = true;
    }
    this.append(...pending.map((entry) => entry.message));
    return true;
  }

  private async enqueueSteer(activeTurn: Turn, entry: QueuedSteer): Promise<Turn | undefined> {
    if (await this.blockedByHook(entry.message, true)) return undefined;
    if (entry.removed) return undefined;

    this.steerQueue.push(entry);
    this.observe(activeTurn);
    return activeTurn;
  }

  private removeQueuedSteer(entry: QueuedSteer): void {
    if (entry.emitted) {
      throw steerAlreadyEmittedError();
    }
    entry.removed = true;
    const index = this.steerQueue.indexOf(entry);
    if (index >= 0) {
      this.steerQueue.splice(index, 1);
    }
  }

  private discardQueuedSteers(): void {
    for (const entry of this.steerQueue.splice(0)) {
      entry.removed = true;
    }
  }
}

function steerAlreadyEmittedError(): KimiError {
  return new KimiError(
    ErrorCodes.REQUEST_INVALID,
    'Cannot remove a steer after it has been emitted',
    { details: { reason: 'steer_already_emitted' } },
  );
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

function formatUndoUnavailableMessage(
  requestedCount: number,
  undoableCount: number,
  stoppedAtCompaction: boolean,
): string {
  const reason = stoppedAtCompaction ? ' after the last compaction' : '';
  return `Cannot undo ${formatPromptCount(requestedCount)}; only ${formatPromptCount(undoableCount)} can be undone in the active context${reason}.`;
}

function formatPromptCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'prompt' : 'prompts'}`;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptService,
  AgentPromptService,
  InstantiationType.Delayed,
  'prompt',
);
