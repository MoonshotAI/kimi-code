import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError } from '#/errors';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ensureMessageId } from '#/agent/contextMemory/messageId';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTurnService, type Turn, type TurnPromptInfo } from '#/agent/turn/turn';
import type { ExecutableToolResult } from '#/agent/tool/toolContract';
import type { ToolDidExecuteContext } from '#/agent/tool/toolHooks';
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
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
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
    toolExecutor.hooks.onDidExecuteTool.register('prompt-service-delivery', async (ctx, next) => {
      await this.deliverToolResult(ctx);
      await next();
    });
  }

  async prompt(message: ContextMessage): Promise<Turn | undefined> {
    const stamped = ensureMessageId(message);
    if (await this.blockedByHook(stamped, false)) {
      this.append(stamped);
      return undefined;
    }
    const turn = this.launch({ input: stamped.content, origin: stamped.origin });
    this.append(stamped);
    return turn;
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

  private async deliverToolResult(ctx: ToolDidExecuteContext): Promise<void> {
    const delivery = ctx.result.delivery;
    if (delivery === undefined) return;

    // Consume the side channel: strip it from the result so it never reaches the
    // loop / persistence, then perform the declared delivery here on the agent
    // (L4) side where `steer` lives (the L3 executor only threads it through).
    const { delivery: _consumed, ...rest } = ctx.result;
    ctx.result = rest as ExecutableToolResult;

    switch (delivery.kind) {
      case 'steer':
        // The tool built a full user `ContextMessage`; the L3 contract carries it
        // as an opaque `ToolDeliveryMessage`, so restore the type at the L4 edge.
        await this.steer(delivery.message as ContextMessage).launched;
        return;
      default: {
        const _exhaustive: never = delivery.kind;
        void _exhaustive;
      }
    }
  }

  retry(): Turn | undefined {
    return this.launch({ origin: { kind: 'retry' } });
  }

  undo(count: number): number {
    if (count <= 0) return 0;

    const { removedCount, stoppedAtCompaction } = this.context.undo(count);
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
    this.context.clear();
  }

  private append(...messages: ContextMessage[]): void {
    this.context.append(...messages);
  }

  private launch(prompt?: TurnPromptInfo): Turn {
    const turn = this.turnService.launch(prompt);
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
      this.turnService.recordSteer(entry.message.content, entry.message.origin);
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
