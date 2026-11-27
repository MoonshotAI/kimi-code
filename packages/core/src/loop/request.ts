import type { Message } from '#/llm/message';
import type { LlmPolicy } from '#/llm/policy/policy';
import type { LlmRecoveryRecord } from '#/llm/policy/recovery';
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmRequest, LlmRequestProfile } from '#/llm/request';
import type { LlmDimension, LlmRequester } from '#/llm/requester';
import type { LlmOutcome, LlmRunEvent } from '#/llm/response';
import type { LoopProfile } from './contract/profile';
import { isLlmOutcome } from './guards';

export type FullLoopLlmRequester = LlmRequester<LlmDimension>;

export interface LoopRequestRuntime {
  readonly historyRevision: () => number;
}

export interface LoopLlmRunObservation {
  attempt?(
    request: LlmRequest,
    info: { readonly appliedRecoveries: readonly LlmRecoveryRecord[] },
  ): void;
  event?(event: LlmRunEvent): void;
  settle?(outcome: LlmOutcome, signal: AbortSignal): void;
}

export interface LoopLlmRunObserver {
  start?(request: LlmRequest): LoopLlmRunObservation | undefined;
}

export interface LoopRequestInput {
  readonly turnId: number;
  readonly step: number;
  readonly messages: readonly Message[];
  readonly profile: LoopProfile;
  readonly policy?: LlmPolicy;
  readonly signal: AbortSignal;
  readonly observer?: LoopLlmRunObserver;
}

export type LoopRequestProgress = Exclude<LlmRunEvent, { type: 'llm.ended' }>;

export function requestProfileOf(profile: LoopProfile): LlmRequestProfile {
  const { systemPrompt, tools } = profile;
  return {
    ...(systemPrompt === undefined || systemPrompt === '' ? {} : { systemPrompt }),
    ...(tools === undefined ? {} : { tools }),
  };
}

export function normalizeLlmOutcome(value: unknown): LlmOutcome {
  return isLlmOutcome(value) ? value : failedOutcome(new Error('invalid llm outcome'));
}

export function outcomeForError(signal: AbortSignal, error: unknown): LlmOutcome {
  if (signal.aborted || isAbortErrorSafe(error)) {
    return { type: 'aborted', message: null, usage: undefined, reason: signal.reason };
  }
  return failedOutcome(error);
}

function failedOutcome(error: unknown): LlmOutcome {
  return { type: 'failed', error: toLlmErrorMessage(error), rawError: error };
}

function isAbortErrorSafe(error: unknown): boolean {
  try {
    return isAbortError(error);
  } catch {
    return false;
  }
}

export function runLoopRequest(
  requester: FullLoopLlmRequester,
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
    resolve(normalizeLlmOutcome(value));
  };
  void (async () => {
    let observation: LoopLlmRunObservation | undefined;
    let outcome: LlmOutcome;
    try {
      const prepared = requester.with({
        content: { messages: input.messages },
        profile: requestProfileOf(input.profile),
        policy: input.policy,
        attributes: { kind: 'loop', turnId: input.turnId, step: input.step },
      });
      observation = input.observer?.start?.(prepared.request({}));
      outcome = normalizeLlmOutcome(await prepared.generate(
        {},
        {
          signal: input.signal,
          onAttempt: (attemptRequest, info) => observation?.attempt?.(attemptRequest, info),
          onEvent: (event) => {
            observation?.event?.(event);
            if (event.type === 'llm.ended') end(event.outcome);
            else onProgress(event);
          },
        },
      ));
    } catch (error) {
      outcome = outcomeForError(input.signal, error);
    }
    observation?.settle?.(outcome, input.signal);
    end(outcome);
  })();
  return promise;
}
