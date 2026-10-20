import { toRequestMessages, type HistoryMessage } from '#/history/message';
import { usedContextTokens } from '#/history/usage';
import { mergeFields, type LlmRequestPart } from '#/llm/requester';

import type { LoopLlmRequester } from './machine/request-actor';

type Fields = Readonly<Record<string, unknown>>;

export function createLoopRequester(
  requester: () => LoopLlmRequester,
  messages: () => readonly HistoryMessage[],
): LoopLlmRequester {
  const accumulate = (part: LlmRequestPart): LoopLlmRequester => {
    const resolve = (): LoopLlmRequester => {
      const history = messages();
      const content = toRequestMessages(history);
      const current = requester();
      const prepared = current.request({ content: { messages: content } });
      const usedTokens = usedContextTokens(history, prepared.profile);
      return current.with({ content: { messages: content, usedTokens } }).with(part);
    };
    return {
      with: (next) => accumulate(mergeFields(part as Fields, next as Fields) as LlmRequestPart),
      request: (rest) => resolve().request(rest),
      generate: (rest, control) => resolve().generate(rest, control),
    };
  };
  return accumulate({});
}
