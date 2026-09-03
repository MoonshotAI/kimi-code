import { APIProviderRateLimitError, isProviderRateLimitError } from '#/kosong/contract/errors';

import { linkAbortSignal, userCancellationReason } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { Error2, ErrorCodes, toKimiErrorPayload, type KimiErrorPayload } from '#/errors';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import {
  IAgentLoopService,
  isMaxStepsExceededError,
  type Turn,
  type TurnResult,
} from '#/agent/loop/loop';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';

import type { AgentRunCompletion, AgentRunHandle, AgentRunRequest } from './subagent';

export const AGENT_RUN_PROMPT_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'subagent',
};

const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';

type CompletedTurnResult = Extract<TurnResult, { readonly type: 'completed' }>;

export interface RunAgentTurnOptions {
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
}

export async function runAgentTurn(
  target: IAgentScopeHandle,
  request: AgentRunRequest,
  options: RunAgentTurnOptions,
): Promise<AgentRunHandle> {
  options.signal.throwIfAborted();
  const promptService = target.accessor.get(IAgentPromptService);
  const turn =
    request.kind === 'prompt'
      ? await (await promptService.enqueue({ message: {
          role: 'user',
          content: [{ type: 'text', text: request.prompt }],
          toolCalls: [],
          origin: AGENT_RUN_PROMPT_ORIGIN,
        } })).launched
      : await promptService.retry();
  if (turn === undefined) throw new Error2(ErrorCodes.INTERNAL, 'Agent turn could not be started');

  if (options.onReady !== undefined) {
    void turn.ready.then(() => options.onReady?.()).catch(() => {});
  }

  const completion = awaitRun(target, turn, options);
  return { agentId: target.id, turn, completion };
}

async function awaitRun(
  target: IAgentScopeHandle,
  turn: Turn,
  options: RunAgentTurnOptions,
): Promise<AgentRunCompletion> {
  const controller = new AbortController();
  const unlink = linkAbortSignal(options.signal, controller);
  const loop = target.accessor.get(IAgentLoopService);
  const cancelTurn = (reason: unknown): void => {
    loop.cancel(turn.id, reason);
  };
  try {
    const result = classifyTurnResult(await awaitTurn(turn, controller, cancelTurn));
    const summary = latestAssistantText(target.accessor.get(IAgentContextMemoryService).get());
    const stopReason = result.stopReason;
    if (summary.trim().length === 0) {
      throw new Error2(
        ErrorCodes.AGENT_NO_FINAL_MESSAGE,
        noFinalMessageError(stopReason),
        stopReason === undefined ? undefined : { details: { stopReason } },
      );
    }
    const usage = target.accessor.get(ISessionUsageService)?.status(agentContextOf(target)).total;
    return { summary, usage, stopReason };
  } finally {
    unlink();
    if (controller.signal.aborted) {
      cancelTurn(controller.signal.reason);
    }
  }
}

async function awaitTurn(
  turn: Turn,
  controller: AbortController,
  cancelTurn: (reason: unknown) => void,
): Promise<TurnResult> {
  const cancelOnAbort = (): void => {
    cancelTurn(controller.signal.reason);
  };
  controller.signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    if (controller.signal.aborted) {
      cancelOnAbort();
    }
    const result = await turn.result;
    controller.signal.throwIfAborted();
    return result;
  } finally {
    controller.signal.removeEventListener('abort', cancelOnAbort);
  }
}

function classifyTurnResult(result: TurnResult): CompletedTurnResult {
  switch (result.type) {
    case 'completed':
      if (result.truncated) {
        throw new Error2(ErrorCodes.AGENT_MAX_TOKENS_EXCEEDED, SUBAGENT_MAX_TOKENS_ERROR);
      }
      return result;
    case 'failed': {
      const error = result.error;
      if (isProviderRateLimitError(error)) throw error;
      const payload = toKimiErrorPayload(error);
      if (payload.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
        throw providerRateLimitErrorFromPayload(payload);
      }
      if (isMaxStepsExceededError(error)) {
        throw maxStepsErrorFromPayload(payload);
      }
      throw toRunError(error);
    }
    case 'cancelled':
      throw toRunError(result.reason ?? userCancellationReason());
  }
}

function noFinalMessageError(stopReason: string | undefined): string {
  const base = 'Subagent turn ended without a final message';
  return stopReason === undefined ? `${base}.` : `${base} (stop reason: ${stopReason}).`;
}

function maxStepsErrorFromPayload(payload: KimiErrorPayload): Error2 {
  const maxSteps = payload.details?.['maxSteps'];
  const cap = typeof maxSteps === 'number' ? ` (maxSteps=${String(maxSteps)})` : '';
  return new Error2(
    ErrorCodes.LOOP_MAX_STEPS_EXCEEDED,
    `Subagent hit the per-turn step cap${cap} before finishing its handoff.`,
    typeof maxSteps === 'number' ? { details: { maxSteps } } : undefined,
  );
}

function toRunError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error === undefined || error === null) return new Error('Agent turn failed');
  return new Error(stringifyRunError(error));
}

function stringifyRunError(value: unknown): string {
  if (typeof value === 'string') return value;
  return String(value);
}

function providerRateLimitErrorFromPayload(error: KimiErrorPayload): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function latestAssistantText(messages: readonly ContextMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    return contentText(message.content);
  }
  return '';
}

function contentText(content: ContextMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<(typeof content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
