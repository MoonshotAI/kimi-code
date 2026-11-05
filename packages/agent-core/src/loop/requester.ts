import { toRequestMessages, type HistoryMessage } from '#/history/message';
import { usedContextTokens } from '#/history/usage';
import { contentsOf, mergeFields, requesterContents, type LlmRequestPart } from '#/llm/requester';

import type { LoopProfile } from './contract/profile';
import { requestProfileOf, type LoopLlmRequester } from './request';

type Fields = Readonly<Record<string, unknown>>;

export function createLoopRequester(
  requester: () => LoopLlmRequester,
  messages: () => readonly HistoryMessage[],
  profile: () => LoopProfile,
): LoopLlmRequester {
  const accumulate = (part: LlmRequestPart): LoopLlmRequester => {
    const resolve = (): LoopLlmRequester => {
      const history = messages();
      const content = toRequestMessages(history);
      const requestProfile = requestProfileOf(profile());
      const current = requester();
      const prepared = current.request({ content: { messages: content }, profile: requestProfile });
      const usedTokens = usedContextTokens(history, prepared.profile);
      return current.with({ profile: requestProfile, content: { messages: content, usedTokens } }).with(part);
    };
    return {
      [requesterContents]: part,
      with: ((next: LlmRequestPart | LoopLlmRequester) =>
        accumulate(mergeFields(part as Fields, contentsOf(next) as Fields) as LlmRequestPart)) as LoopLlmRequester['with'],
      request: (rest) => resolve().request(rest),
      generate: (rest, control) => resolve().generate(rest, control),
    };
  };
  return accumulate({});
}
