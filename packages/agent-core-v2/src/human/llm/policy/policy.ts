import { isAbortError, toLlmErrorMessage, type LlmErrorMessage, type LlmRemoteErrorMessage } from '#/llm/errors';
import {
  readRetryAfterMs,
  resolveMaxAttempts,
  retryBackoffDelay,
  shouldRetry,
  type LlmRetryOptions,
} from '#/llm/requester/retry';
import type { LlmRequest } from '#/llm/request';
import type { LlmOutcome, LlmRetrying, LlmRunEvent } from '#/llm/response';
import { effectiveModelSpec } from '#/llm/protocol/rules/model';

import {
  createRecoveryLedger,
  proposeFirst,
  type LlmRecovery,
  type LlmRecoveryLedger,
} from './recovery';
import type { MessageResolver } from './resolver';
import { settleLlmRequest } from './settle';

export type LlmPolicyList<T> = readonly T[] | (() => readonly T[]);

export interface LlmPolicy {
  readonly resolvers?: LlmPolicyList<MessageResolver>;
  readonly recoveries?: LlmPolicyList<LlmRecovery>;
  readonly retry?: LlmRetryOptions;
}

export interface LlmRunControl {
  readonly signal: AbortSignal;
  readonly recoveries?: LlmRecoveryLedger;
  readonly onEvent?: (event: LlmRunEvent) => void;
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

function abortedOf(result: Extract<LlmOutcome, { type: 'failed' }>): LlmOutcome {
  return {
    type: 'aborted',
    message: result.message ?? null,
    usage: result.usage,
    headers: result.headers,
    finish: result.finish,
    messageId: result.messageId,
    requestId: result.requestId,
    timing: result.timing,
  };
}

export async function runLlmRequest(
  request: LlmRequest,
  control: LlmRunControl,
): Promise<LlmOutcome> {
  try {
    return await runAttempts(request, control);
  } catch (error) {
    return control.signal.aborted || isAbortError(error)
      ? { type: 'aborted', message: null, usage: undefined }
      : { type: 'failed', error: toLlmErrorMessage(error), rawError: error };
  }
}

async function runAttempts(request: LlmRequest, control: LlmRunControl): Promise<LlmOutcome> {
  const { signal, onEvent } = control;
  const policy = request.policy ?? {};
  const ledger = control.recoveries ?? createRecoveryLedger();
  const model = effectiveModelSpec(request.protocol.base, request.model.spec);
  let attempt = 1;
  const maxAttempts = resolveMaxAttempts(policy.retry);

  while (!signal.aborted) {
    const messages = ledger.apply(request.content.messages);
    let resolvedMessages = messages;
    for (const resolver of listOf(policy.resolvers)) {
      resolvedMessages = await resolver.resolve(resolvedMessages, {
        model,
        endpoint: request.endpoint,
        media: request.protocol.base.media,
        signal,
        report: (notice) =>
          onEvent?.({ type: 'llm.notice', notice: { ...notice, source: resolver.id } }),
      });
      if (signal.aborted) {
        return { type: 'aborted', message: null, usage: undefined };
      }
    }

    const result = await settleLlmRequest(
      { ...request, content: { ...request.content, messages: resolvedMessages } },
      { signal, onEvent },
    );
    if (result.type === 'done' || result.type === 'aborted') {
      return result;
    }

    const remote = asRemote(result.error);
    if (remote !== undefined) {
      const proposal = proposeFirst(listOf(policy.recoveries), {
        error: remote,
        messages,
        appliedRecoveries: ledger.applied,
        endpoint: request.endpoint,
      });
      if (proposal !== undefined) {
        proposal.beforeNextAttempt?.();
        ledger.record(proposal);
        attempt = 1;
        onEvent?.({
          type: 'llm.retrying',
          reason: 'recovery',
          strategy: proposal.strategy,
          action: proposal.action,
          error: result.error,
        } satisfies LlmRetrying);
        continue;
      }
    }

    if (shouldRetry(policy.retry, attempt, result.error)) {
      const delayMs = readRetryAfterMs(result.error) ?? retryBackoffDelay(attempt - 1);
      onEvent?.({
        type: 'llm.retrying',
        reason: 'backoff',
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        error: result.error,
      } satisfies LlmRetrying);
      if (!(await delay(delayMs, signal))) {
        return abortedOf(result);
      }
      attempt += 1;
      continue;
    }

    return result;
  }

  return { type: 'aborted', message: null, usage: undefined };
}
