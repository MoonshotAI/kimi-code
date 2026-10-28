import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService, type LoopErrorContext } from '#/agent/loop/loop';
import type { LlmOutputLimitRecoveryEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes, unwrapErrorCause } from '#/errors';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { APIEmptyResponseError } from '#/llm-adapter/contract/errors';

import {
  IAgentOutputLimitRecoveryService,
  OUTPUT_LIMIT_RECOVERY_VARIANT,
} from './outputLimitRecovery';

const MAX_OUTPUT_LIMIT_RECOVERIES = 3;
const OUTPUT_LIMIT_RECOVERY_REMINDER = [
  'Output token limit hit while you were still reasoning, before this response produced any text or tool call.',
  'That reasoning was not kept and is not part of this conversation, so there is nothing to resume.',
  'Continue from the conversation above: reason much more briefly and produce your answer or next tool call well within the output limit.',
].join(' ');
const OUTPUT_LIMIT_EXHAUSTED_MESSAGE =
  'The model hit the output token limit while still reasoning on every attempt and produced no answer. Lower the thinking effort or raise the output token limit.';

export class AgentOutputLimitRecoveryService
  extends Disposable
  implements IAgentOutputLimitRecoveryService
{
  declare readonly _serviceBrand: undefined;

  private consecutiveRecoveries = 0;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(
      loop.hooks.onWillBeginStep.register('outputLimitRecovery', async (ctx, next) => {
        if (ctx.firstStepOfTurn) this.consecutiveRecoveries = 0;
        await next();
      }),
    );
    this._register(
      loop.hooks.onDidFinishStep.register('outputLimitRecovery', async (_ctx, next) => {
        this.consecutiveRecoveries = 0;
        await next();
      }),
    );
    this._register(
      loop.registerLoopErrorHandler({
        id: 'outputLimitRecovery',
        match: (ctx) => isOutputLimitBeforeAnswer(ctx.error),
        handle: async (ctx) => this.recover(ctx),
      }),
    );
  }

  private recover(ctx: LoopErrorContext): boolean {
    if (ctx.signal.aborted) return false;
    if (this.consecutiveRecoveries >= MAX_OUTPUT_LIMIT_RECOVERIES) {
      this.track(ctx, 'exhausted');
      this.consecutiveRecoveries = 0;
      throw new Error2(ErrorCodes.AGENT_MAX_TOKENS_EXCEEDED, OUTPUT_LIMIT_EXHAUSTED_MESSAGE);
    }
    this.consecutiveRecoveries += 1;
    this.context.append({
      role: 'user',
      content: [{ type: 'text', text: wrapSystemReminder(OUTPUT_LIMIT_RECOVERY_REMINDER) }],
      toolCalls: [],
      origin: {
        kind: 'injection',
        variant: OUTPUT_LIMIT_RECOVERY_VARIANT,
        ownerPromptId: this.loop.snapshot().activePromptId,
      },
    });
    this.track(ctx, 'nudged');
    ctx.retry();
    return true;
  }

  private track(ctx: LoopErrorContext, action: LlmOutputLimitRecoveryEvent['action']): void {
    const properties: LlmOutputLimitRecoveryEvent = {
      turn_id: ctx.turnId,
      step_no: ctx.step ?? 0,
      action,
      attempt: this.consecutiveRecoveries,
    };
    this.telemetry.track2('llm_output_limit_recovery', properties);
  }
}

function isOutputLimitBeforeAnswer(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  return unwrapped instanceof APIEmptyResponseError && unwrapped.finishReason === 'truncated';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentOutputLimitRecoveryService,
  AgentOutputLimitRecoveryService,
  ScopeActivation.OnScopeCreated,
  'outputLimitRecovery',
);
