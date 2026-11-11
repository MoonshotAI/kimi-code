/**
 * Bridges a loop step to an LLM request by combining the active requester, profile, history, and
 * step-scoped abort signal.
 */
import type { HistoryMessage } from '#/llm/history';
import type { LlmPolicy, LlmRunControl } from '#/llm/policy/policy';
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmRequestProfile } from '#/llm/request';
import type { LlmDimension, LlmRequestRest } from '#/llm/requester';
import type { LlmOutcome, LlmRunEvent } from '#/llm/response';
import type { LoopProfile } from './contract/profile';
import { isLlmOutcome } from './guards';

export interface LoopLlmRequester {
  snapshot?(): LoopLlmRequester;
  generate(rest: LlmRequestRest<LlmDimension>, control: LlmRunControl): Promise<LlmOutcome>;
}

export interface LoopRequestRuntime {
  readonly historyRevision: () => number;
}

export interface LoopRequestInput {
  readonly messages: readonly HistoryMessage[];
  readonly profile: LoopProfile;
  readonly policy?: LlmPolicy;
  readonly signal: AbortSignal;
}

export type LoopRequestProgress = Exclude<LlmRunEvent, { type: 'llm.ended' }>;

function failedOutcome(error: unknown): LlmOutcome {
  return { type: 'failed', error: toLlmErrorMessage(error), rawError: error };
}

function isAborted(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted) return true;
  try {
    return isAbortError(error);
  } catch {
    return false;
  }
}

export function runLoopRequest(
  requester: LoopLlmRequester,
  input: LoopRequestInput,
  onProgress: (event: LoopRequestProgress) => void,
): Promise<LlmOutcome> {
  let resolve: (outcome: LlmOutcome) => void = () => undefined;
  const promise = new Promise<LlmOutcome>((reply) => {
    resolve = reply;
  });
  let ended = false;
  const end = (value: unknown): void => {
    if (ended) return;
    ended = true;
    resolve(isLlmOutcome(value) ? value : failedOutcome(new Error('invalid llm outcome')));
  };
  const forward = (event: LlmRunEvent): void => {
    if (ended) return;
    if (event.type === 'llm.ended') end(event.outcome);
    else onProgress(event);
  };
  void (async () => {
    try {
      const { systemPrompt, tools } = input.profile;
      const requestProfile: LlmRequestProfile = {
        ...(systemPrompt === undefined || systemPrompt === '' ? {} : { systemPrompt }),
        ...(tools === undefined ? {} : { tools }),
      };
      end(
        await requester.generate(
          { content: { entries: input.messages }, profile: requestProfile, policy: input.policy },
          { signal: input.signal, onEvent: forward },
        ),
      );
    } catch (error) {
      end(
        isAborted(input.signal, error)
          ? { type: 'aborted', entry: null, usage: undefined, reason: input.signal.reason }
          : failedOutcome(error),
      );
    }
  })();
  return promise;
}
