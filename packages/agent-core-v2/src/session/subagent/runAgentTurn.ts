import { APIProviderRateLimitError, isProviderRateLimitError } from '#/kosong/contract/errors';
import { type TokenUsage } from '#/kosong/contract/usage';

import { linkAbortSignal, userCancellationReason } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { Error2, ErrorCodes, toKimiErrorPayload, type KimiErrorPayload } from '#/errors';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLoopService, type Turn, type TurnResult } from '#/agent/loop/loop';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';

import type { AgentRunHandle, AgentRunRequest } from './subagent';

export const AGENT_RUN_PROMPT_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'subagent',
};

const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';

export interface RunAgentTurnOptions {
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
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
): Promise<{ summary: string; usage?: TokenUsage }> {
  const controller = new AbortController();
  const unlink = linkAbortSignal(options.signal, controller);
  const loop = target.accessor.get(IAgentLoopService);
  const cancelTurn = (turnToCancel: Turn, reason: unknown): void => {
    loop.cancel(turnToCancel.id, reason);
  };
  let turnRef: Turn = turn;
  try {
    const result = await awaitTurn(turnRef, controller, cancelTurn);
    classifyTurnResult(result);
    const summary = await distillSummary(
      target,
      controller,
      options.summaryPolicy,
      (t) => {
        turnRef = t;
      },
      cancelTurn,
    );
    const usage = target.accessor.get(ISessionUsageService)?.status(agentContextOf(target)).total;
    return { summary, usage };
  } finally {
    unlink();
    if (controller.signal.aborted) {
      cancelTurn(turnRef, controller.signal.reason);
    }
  }
}

async function awaitTurn(
  turn: Turn,
  controller: AbortController,
  cancelTurn: (turn: Turn, reason: unknown) => void,
): Promise<TurnResult> {
  const cancelOnAbort = (): void => {
    cancelTurn(turn, controller.signal.reason);
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

async function distillSummary(
  target: IAgentScopeHandle,
  controller: AbortController,
  policy: AgentProfileSummaryPolicy | undefined,
  setTurn: (turn: Turn) => void,
  cancelTurn: (turn: Turn, reason: unknown) => void,
): Promise<string> {
  const memory = target.accessor.get(IAgentContextMemoryService);
  let summary = latestAssistantText(memory.get());
  if (policy === undefined) return summary;
  if (isSummaryAdequate(summary, policy)) return summary;

  const promptService = target.accessor.get(IAgentPromptService);
  for (let attempt = 0; attempt < policy.retries; attempt++) {
    const turn = await (await promptService.enqueue({ message: {
      role: 'user',
      content: [{ type: 'text', text: policy.continuationPrompt }],
      toolCalls: [],
      origin: AGENT_RUN_PROMPT_ORIGIN,
    } })).launched;
    if (turn === undefined) break;
    setTurn(turn);
    const result = await awaitTurn(turn, controller, cancelTurn);
    classifyTurnResult(result);
    const continued = latestAssistantText(memory.get());
    if (continued.trim().length > 0) summary = continued;
    if (isSummaryAdequate(summary, policy)) break;
  }
  return summary;
}

function isSummaryAdequate(summary: string, policy: AgentProfileSummaryPolicy): boolean {
  return summary.trim().length >= policy.minChars;
}

function classifyTurnResult(result: TurnResult): void {
  switch (result.type) {
    case 'completed':
      if (result.truncated) {
        throw new Error2(ErrorCodes.AGENT_MAX_TOKENS_EXCEEDED, SUBAGENT_MAX_TOKENS_ERROR);
      }
      return;
    case 'failed': {
      const error = result.error;
      if (isProviderRateLimitError(error)) throw error;
      const payload = toKimiErrorPayload(error);
      if (payload.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
        throw providerRateLimitErrorFromPayload(payload);
      }
      throw toRunError(error);
    }
    case 'cancelled':
      throw toRunError(result.reason ?? userCancellationReason());
  }
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
