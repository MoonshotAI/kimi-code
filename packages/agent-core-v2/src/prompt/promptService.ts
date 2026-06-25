import { registerSingleton, SyncDescriptor } from "#/_base/di";
import { ErrorCodes, KimiError, makeErrorPayload } from "#/_base/errors";
import { USER_PROMPT_ORIGIN } from '../../../agent/context';

import { IContextMemory } from '../contextMemory/contextMemory';
import { IEventBus } from '../eventBus/eventBus';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage, Turn } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import { IPromptService } from './prompt';

export class PromptService implements IPromptService {
  private readonly steerQueue: ContextMessage[] = [];
  private observedTurn: Turn | undefined;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @ITurnRunner private readonly turnRunner: ITurnRunner,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
  ) {
    turnRunner.hooks.beforeStep.register('prompt-service-steer-before-step', async (_ctx, next) => {
      this.flushSteerQueue();
      await next();
    });
    turnRunner.hooks.afterStep.register('prompt-service-steer', async (ctx, next) => {
      await next();
      if (this.flushSteerQueue()) {
        ctx.continueTurn = true;
      }
    });
  }

  prompt(message: ContextMessage): Turn | undefined {
    if (this.emitBusyIfActive()) return undefined;
    this.append(message);
    const turn = this.turnRunner.launch(message.origin ?? USER_PROMPT_ORIGIN);
    this.observe(turn);
    return turn;
  }

  steer(message: ContextMessage): Turn | undefined {
    const activeTurn = this.turnRunner.getActiveTurn();
    if (activeTurn !== undefined) {
      this.steerQueue.push(message);
      this.observe(activeTurn);
      return undefined;
    }

    this.append(message);
    const turn = this.turnRunner.launch(message.origin ?? USER_PROMPT_ORIGIN);
    this.observe(turn);
    return turn;
  }

  retry(trigger?: string): Turn | undefined {
    if (this.emitBusyIfActive()) return undefined;
    const turn = this.turnRunner.launch({ kind: 'retry', trigger });
    this.observe(turn);
    return turn;
  }

  undo(count: number): number {
    if (count <= 0) return 0;

    const history = this.context.getHistory();
    let removedUserCount = 0;
    let stoppedAtCompaction = false;
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message === undefined) continue;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') {
        stoppedAtCompaction = true;
        break;
      }

      this.context.spliceHistory(index, 1, []);
      if (isRealUserPrompt(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }

    if (!this.wireRecord.restoring && (removedUserCount < count || stoppedAtCompaction)) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        formatUndoUnavailableMessage(count, removedUserCount, stoppedAtCompaction),
        {
          details: {
            reason: 'undo_limit',
            requestedCount: count,
            undoableCount: removedUserCount,
            stoppedAtCompaction,
          },
        },
      );
    }
    return removedUserCount;
  }

  clear(): void {
    this.steerQueue.length = 0;
    const historyLength = this.context.getHistory().length;
    if (historyLength === 0) return;
    this.context.spliceHistory(0, historyLength, []);
  }

  private append(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.context.spliceHistory(this.context.getHistory().length, 0, messages);
  }

  private observe(turn: Turn): void {
    if (this.observedTurn === turn) return;
    this.observedTurn = turn;
    void turn.result.then((result) => {
      if (this.observedTurn === turn) {
        this.observedTurn = undefined;
      }
      if (result.reason !== 'completed') {
        this.steerQueue.length = 0;
      }
    });
  }

  private flushSteerQueue(): boolean {
    if (this.steerQueue.length === 0) return false;

    const messages = this.steerQueue.splice(0);
    this.append(...messages);
    return true;
  }

  private emitBusyIfActive(): boolean {
    const activeTurn = this.turnRunner.getActiveTurn();
    if (activeTurn === undefined) return false;
    this.events.emit({
      type: 'error',
      ...makeErrorPayload(
        ErrorCodes.TURN_AGENT_BUSY,
        `Cannot launch a new turn while another turn (ID ${activeTurn.id}) is active`,
        { details: { turnId: activeTurn.id } },
      ),
    });
    return true;
  }
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  return false;
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

registerSingleton(IPromptService, new SyncDescriptor(PromptService, [], true));
