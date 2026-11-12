import { isAbortError, toLlmErrorMessage } from '#human/llm/protocol/errors';
import { CLIENT_ERROR_STRIP_ACTION } from '#human/llm/builtin/policy/media-degrade';
import type { LlmModelSpec, LlmRequestProfile } from '#human/llm/request';
import type { LlmDimension, LlmRequester } from '#human/llm/requester';
import type { LlmOutcome, LlmRunEvent } from '#human/llm/response';
import type { LlmRecoveryLedger } from '#human/llm/policy/recovery';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import { toRequestMessages, type HistoryMessage } from '#human/agent/turn';
import { estimateUsedContextTokens as usedContextTokens } from '#human/agent/context-usage';
import type { LoopProfile } from './contract/profile';
import { isLlmOutcome } from './guards';

export type LoopLlmRequester = LlmRequester<LlmDimension>;

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
        ledger: ledger.fork(
        (entry) => entry.strategy === 'media-degrade' && entry.action !== CLIENT_ERROR_STRIP_ACTION,
      ),
      };
    },
  };
}

export interface LoopRequestRuntime {
  readonly historyRevision: () => number;
  readonly mediaRecovery: MediaRecoveryStore;
}

export interface TurnExecution {
  readonly profile: LoopProfile;
  readonly thinkingEffort?: ThinkingEffort;
  readonly requester: LoopLlmRequester;
  readonly prepare?: (signal: AbortSignal) => Promise<LoopProfile>;
}

export interface TurnExecutionInput extends LoopRequestRuntime {
  readonly turnId: number;
  readonly profile: LoopProfile;
  readonly step: () => number;
}

export type TurnExecutionFactory = (input: TurnExecutionInput) => TurnExecution;

export interface LoopRequestInput {
  readonly messages: readonly HistoryMessage[];
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
  execution: TurnExecution,
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
      const requester = execution.requester;
      const messages = toLoopRequestMessages(input.messages);
      const { systemPrompt, tools } = execution.profile;
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
