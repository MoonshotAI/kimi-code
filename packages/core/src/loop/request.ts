/**
 * Bridges a loop step to an LLM request by combining the active requester, profile, history, and
 * step-scoped abort signal. Also holds the media recovery ledger reused across steps.
 */
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmModelSpec, LlmRequestProfile } from '#/llm/request';
import type { LlmDimension, LlmRequester } from '#/llm/requester';
import type { LlmOutcome, LlmRunEvent } from '#/llm/response';
import type { LlmRecoveryLedger } from '#/llm/policy/recovery';
import { toRequestMessages, type HistoryMessage } from '#/history/history';
import { estimateUsedContextTokens as usedContextTokens } from '#/history/context-usage';
import type { LoopProfile } from './contract/profile';
import { isLlmOutcome } from './guards';

export interface LoopLlmRequester extends LlmRequester<LlmDimension> {
  snapshot?(): LoopLlmRequester;
}

export interface MediaRecoveryStore {
  read(modelAlias: string, revision: number): LlmRecoveryLedger | undefined;
  write(modelAlias: string, revision: number, ledger: LlmRecoveryLedger): void;
}

export function createMediaRecoveryStore(): MediaRecoveryStore {
  let current: { readonly modelAlias: string; readonly revision: number; readonly ledger: LlmRecoveryLedger } | undefined;
  return {
    read: (modelAlias, revision) =>
      current?.modelAlias === modelAlias && current.revision === revision ? current.ledger : undefined,
    write: (modelAlias, revision, ledger) => {
      current = {
        modelAlias,
        revision,
        ledger: ledger.fork((entry) => entry.strategy === 'media-degrade'),
      };
    },
  };
}

export interface LoopRequestRuntime {
  readonly historyRevision: () => number;
  readonly mediaRecovery: MediaRecoveryStore;
}

export interface LoopRequestInput {
  readonly messages: readonly HistoryMessage[];
  readonly profile: LoopProfile;
  readonly signal: AbortSignal;
}

export type LoopRequestProgress = Exclude<LlmRunEvent, { type: 'llm.ended' }> | {
  readonly type: 'llm.prepared';
  readonly model?: LlmModelSpec;
};

export function toLoopRequestMessages(history: readonly HistoryMessage[]): ReturnType<typeof toRequestMessages> {
  const messages = toRequestMessages(history);
  return messages.map((message, index) => {
    const origin = history[index]!.meta?.origin;
    return origin === undefined ? message : { ...message, origin };
  });
}

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
      const messages = toLoopRequestMessages(input.messages);
      const { systemPrompt, tools } = input.profile;
      const requestProfile: LlmRequestProfile = {
        ...(systemPrompt === undefined || systemPrompt === '' ? {} : { systemPrompt }),
        ...(tools === undefined ? {} : { tools }),
      };
      const { model, profile } = requester.request({ content: { messages }, profile: requestProfile });
      onProgress({ type: 'llm.prepared', model: model?.spec });
      const usedTokens = usedContextTokens(input.messages, profile);
      end(
        await requester.generate(
          { content: { messages, usedTokens }, profile: requestProfile },
          { signal: input.signal, onEvent: forward },
        ),
      );
    } catch (error) {
      end(
        isAborted(input.signal, error)
          ? { type: 'aborted', message: null, usage: undefined, reason: input.signal.reason }
          : failedOutcome(error),
      );
    }
  })();
  return promise;
}
