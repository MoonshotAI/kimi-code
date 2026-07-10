import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { extractImageCompressionCaptions } from '#/_base/tools/support/image-compress';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { formatUndoUnavailableMessage, precheckUndo } from '#/agent/contextMemory/contextOps';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import type { ExecutableToolResult } from '#/agent/tool/toolContract';
import type { ToolDidExecuteContext } from '#/agent/tool/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTurnService, type Turn, type TurnPromptInfo } from '#/agent/turn/turn';
import type { ContentPart } from '#/app/llmProtocol/message';
import { ErrorCodes, KimiError } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import { IAgentPromptService, type PromptSubmitContext, type PromptSteerHandle } from './prompt';

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
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentLoopService loopService: IAgentLoopService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    loopService.hooks.beforeStep.register(
      'prompt-service-steer-before-step',
      async (_ctx, next) => {
        this.flushSteerQueue();
        await next();
      },
    );
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
    const { message: rerouted, captions } = this.extractCompressionCaptions(message);
    if (await this.blockedByHook(rerouted, false)) {
      this.appendPrompt(rerouted, captions);
      return undefined;
    }
    const turn = this.launch({ input: rerouted.content, origin: rerouted.origin });
    this.appendPrompt(rerouted, captions);
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
      message,
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
    return this.launch({ input: [], origin: { kind: 'retry' } });
  }

  undo(count: number): number {
    if (count <= 0) return 0;

    // Precheck on the live history so a request that cannot be fully satisfied
    // fails with `session.undo_unavailable` (and a structured reason) BEFORE any
    // state is removed. `context.undo` is a no-op when the cut is short, but
    // surfacing *why* (`empty` / `compaction_boundary` / `insufficient`) is the
    // caller's signal — mirrors v1's `canUndoHistory` gate.
    const precheck = precheckUndo(this.context.get(), count);
    if (!precheck.ok) {
      throw new KimiError(
        ErrorCodes.SESSION_UNDO_UNAVAILABLE,
        formatUndoUnavailableMessage(precheck),
        {
          details: {
            reason: precheck.reason,
            requestedCount: count,
            undoableCount: precheck.undoable,
          },
        },
      );
    }
    return this.context.undo(count).removedCount;
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
      if (result.type !== 'completed') {
        this.discardQueuedSteers();
      }
    });
  }

  private flushSteerQueue(): boolean {
    const pending = this.steerQueue.splice(0).filter((entry) => !entry.removed);
    if (pending.length === 0) return false;

    for (const entry of pending) {
      entry.emitted = true;
      const { message, captions } = this.extractCompressionCaptions(entry.message);
      this.turnService.recordSteer(message.content, message.origin);
      this.appendPrompt(message, captions);
    }
    return true;
  }

  /**
   * Split inline image-compression captions out of a user message so they can
   * be delivered through the built-in system-reminder injection instead.
   *
   * Prompt ingestion (server upload/base64 route, TUI paste, ACP) annotates a
   * compressed image with an inline `<system>` caption next to the image. Left
   * inside the user message, that raw markup is user-visible in every history
   * projection (TUI replay, vis, export). The reminder's `injection` origin is
   * hidden by every UI, while the model still receives the full note.
   *
   * Pure: the reminders are appended by {@link appendPrompt} at append time,
   * so the launch-before-append wire ordering is preserved and the reminders
   * stay adjacent to their user message in context.
   */
  private extractCompressionCaptions(message: ContextMessage): {
    message: ContextMessage;
    captions: readonly string[];
  } {
    if ((message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') {
      return { message, captions: [] };
    }
    const { captions, parts } = splitImageCompressionCaptions(message.content);
    if (captions.length === 0) return { message, captions };
    return { message: { ...message, content: parts }, captions };
  }

  /**
   * Append a prompt message preceded by its rerouted caption reminders. A
   * message whose content was caption-only is dropped entirely rather than
   * appended empty.
   */
  private appendPrompt(message: ContextMessage, captions: readonly string[]): void {
    for (const caption of captions) {
      this.reminders.appendSystemReminder(caption, {
        kind: 'injection',
        variant: 'image_compression',
      });
    }
    if (message.content.length > 0) this.append(message);
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

// Split inline image-compression captions (see buildImageCompressionCaption)
// out of user prompt content. A caption may be a standalone text part (server
// route, ACP) or merged into an adjacent text segment (TUI paste), so each
// text part is scanned rather than matched whole. Text left empty once its
// captions are removed is dropped entirely.
function splitImageCompressionCaptions(content: readonly ContentPart[]): {
  captions: readonly string[];
  parts: ContentPart[];
} {
  const captions: string[] = [];
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type !== 'text') {
      parts.push(part);
      continue;
    }
    const extracted = extractImageCompressionCaptions(part.text);
    if (extracted.captions.length === 0) {
      parts.push(part);
      continue;
    }
    captions.push(...extracted.captions);
    if (extracted.text.trim().length > 0) {
      parts.push({ type: 'text', text: extracted.text });
    }
  }
  return { captions, parts };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptService,
  AgentPromptService,
  InstantiationType.Delayed,
  'prompt',
);
