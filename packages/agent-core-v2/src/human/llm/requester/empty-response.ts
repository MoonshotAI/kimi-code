import type { LlmErrorMessage } from '#/llm/errors';
import { NO_FINISH, type FinishInfo } from '#/llm/finish-reason';
import { createMessageAccumulator } from '#/llm/message';
import type { LlmModel } from '#/llm/model';

import type {
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestControl,
  LlmRequester,
  LlmRequestEvent,
} from './requester';

function formatFinishReasonHint(finish: FinishInfo): string {
  if (finish.finishReason === null && finish.rawFinishReason === null) return '';
  const raw =
    finish.rawFinishReason === null ? '' : `, rawFinishReason=${finish.rawFinishReason}`;
  const filteredHint =
    finish.finishReason === 'filtered'
      ? ' The provider filtered the response before visible output was emitted.'
      : '';
  return ` Provider stop details: finishReason=${finish.finishReason ?? 'unknown'}${raw}.${filteredHint}`;
}

export function createEmptyResponseError(
  model: LlmModel,
  finish: FinishInfo,
  thinkOnly: boolean,
): LlmErrorMessage<'empty_response'> {
  const detail = thinkOnly
    ? 'The API returned a response containing only thinking content without any text or tool calls. This usually indicates the stream was interrupted or the output token budget was exhausted during reasoning.'
    : 'The API returned an empty response (no content, no tool calls).';
  return {
    kind: 'empty_response',
    message: `${detail}${formatFinishReasonHint(finish)} Provider: ${model.provider}, model: ${model.model}`,
    finishReason: finish.finishReason,
    rawFinishReason: finish.rawFinishReason,
  };
}

export function withEmptyResponseGuard(requester: LlmRequester): LlmRequester {
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const { onEvent } = control;
      if (onEvent === undefined) {
        await requester.generate(config, content, control);
        return;
      }
      let accumulator = createMessageAccumulator();
      let finish: FinishInfo = NO_FINISH;
      await requester.generate(config, content, {
        ...control,
        onEvent: (event: LlmRequestEvent) => {
          switch (event.type) {
            case 'llm.sent':
              accumulator = createMessageAccumulator();
              finish = NO_FINISH;
              onEvent(event);
              return;
            case 'llm.delta':
              accumulator.push(event.part);
              onEvent(event);
              return;
            case 'llm.finish':
              finish = event.finish;
              onEvent(event);
              return;
            case 'llm.done': {
              const message = accumulator.finish();
              const hasToolCalls = message.toolCalls.length > 0;
              if (message.content.length === 0 && !hasToolCalls) {
                onEvent({
                  type: 'llm.failed.remote',
                  error: createEmptyResponseError(config.model, finish, false),
                });
                return;
              }
              const hasThink = message.content.some((part) => part.type === 'think');
              const hasText = message.content.some(
                (part) => part.type === 'text' && part.text.trim().length > 0,
              );
              if (hasThink && !hasText && !hasToolCalls) {
                onEvent({
                  type: 'llm.failed.remote',
                  error: createEmptyResponseError(config.model, finish, true),
                });
                return;
              }
              onEvent(event);
              return;
            }
            default:
              onEvent(event);
          }
        },
      });
    },
  };
}
