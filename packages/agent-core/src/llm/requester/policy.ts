import type { LlmErrorMessage, LlmRemoteErrorMessage } from '#/llm/errors';
import type { MediaLowerPorts } from '#/llm/media/materialize';
import type { Message } from '#/llm/message';
import { emptyUsage } from '#/llm/usage';

import { applyCredential } from './credentials';
import type { MessageResolver } from './input';
import { proposeFirst, type LlmRecovering, type LlmRecovery, type LlmRecoveryRecord } from './recovery';
import type { LlmCredentialProvider, LlmRequester } from './requester';
import {
  readRetryAfterMs,
  resolveMaxAttempts,
  retryBackoffDelay,
  shouldRetry,
  type LlmRetryable,
  type LlmRetrying,
  type LlmRetryOptions,
} from './retry';
import {
  settleLlmRequest,
  type LlmResult,
  type LlmStreamEvent,
  type SettleLlmRequestInput,
} from './settle';

export type LlmPolicyList<T> = readonly T[] | (() => readonly T[]);

export interface LlmPolicy {
  readonly resolvers?: LlmPolicyList<MessageResolver>;
  readonly recoveries?: LlmPolicyList<LlmRecovery>;
  readonly retryables?: LlmPolicyList<LlmRetryable>;
  readonly media?: () => MediaLowerPorts | undefined;
  readonly retry?: LlmRetryOptions;
}

export type LlmPolicyEvent = LlmStreamEvent | LlmRetrying | LlmRecovering;

export interface RunLlmRequestInput extends SettleLlmRequestInput {
  readonly credentialProvider?: LlmCredentialProvider;
}

function listOf<T>(value: LlmPolicyList<T> | undefined): readonly T[] {
  if (value === undefined) return [];
  return typeof value === 'function' ? value() : value;
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    function finish() {
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function asRemote(error: LlmErrorMessage): LlmRemoteErrorMessage | undefined {
  return error.kind === 'syntax' ? undefined : error;
}

function abortedOf(result: Extract<LlmResult, { type: 'failed' }>): LlmResult {
  return {
    type: 'aborted',
    message: result.message ?? null,
    usage: result.usage ?? emptyUsage(),
    headers: result.headers,
    finish: result.finish,
    messageId: result.messageId,
  };
}

export async function runLlmRequest(
  requester: LlmRequester,
  input: RunLlmRequestInput,
  policy: LlmPolicy = {},
  onEvent?: (event: LlmPolicyEvent) => void,
): Promise<LlmResult> {
  let messages: readonly Message[] = input.content.messages;
  let attempt = 1;
  const appliedRecoveries: LlmRecoveryRecord[] = [];
  const maxAttempts = resolveMaxAttempts(policy.retry);

  while (!input.signal.aborted) {
    const credential = input.credentialProvider?.resolve();
    const resolved =
      credential === undefined
        ? undefined
        : credential instanceof Promise
          ? await credential
          : credential;
    if (input.signal.aborted) break;
    const config =
      resolved === undefined
        ? input.config
        : { ...input.config, model: applyCredential(input.config.model, resolved) };

    let resolvedMessages = messages;
    for (const resolver of listOf(policy.resolvers)) {
      resolvedMessages = await resolver.resolve(resolvedMessages, {
        model: config.model,
        signal: input.signal,
      });
      if (input.signal.aborted) {
        return { type: 'aborted', message: null, usage: emptyUsage() };
      }
    }

    const result = await settleLlmRequest(
      requester,
      {
        config,
        content: {
          ...input.content,
          messages: resolvedMessages,
          media: input.content.media ?? policy.media?.(),
        },
        signal: input.signal,
        toolCallIds: input.toolCallIds,
      },
      onEvent,
    );
    if (result.type === 'done' || result.type === 'aborted') {
      return result;
    }

    const remote = asRemote(result.error);
    if (remote !== undefined) {
      const proposal = proposeFirst(listOf(policy.recoveries), {
        error: remote,
        messages,
        appliedRecoveries,
        credentialProvider: input.credentialProvider,
      });
      if (proposal !== undefined) {
        proposal.beforeNextAttempt?.();
        appliedRecoveries.push({ strategy: proposal.strategy, action: proposal.action });
        if (proposal.attemptMessageOverride !== undefined) {
          messages = proposal.attemptMessageOverride;
        }
        attempt = 1;
        onEvent?.({
          type: 'llm.recovering',
          strategy: proposal.strategy,
          action: proposal.action,
          error: result.error,
        });
        continue;
      }
    }

    if (shouldRetry(policy.retry, attempt, result.error, listOf(policy.retryables))) {
      const delayMs = readRetryAfterMs(result.error) ?? retryBackoffDelay(attempt - 1);
      onEvent?.({
        type: 'llm.retrying',
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        error: result.error,
      });
      if (!(await delay(delayMs, input.signal))) {
        return abortedOf(result);
      }
      attempt += 1;
      continue;
    }

    return result;
  }

  return { type: 'aborted', message: null, usage: emptyUsage() };
}
