import type { ToolDescription } from '#/llm/message';
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmRequest } from '#/llm/request';
import type {
  LlmErrorMessage,
  LlmOutcome,
  LlmRemoteErrorMessage,
  LlmRunEvent,
  LlmRunStarted,
} from '#/llm/response';
import { sha256Hex } from '#/utils/hash';

import {
  createRecoveryLedger,
  proposeFirst,
  type LlmRecovery,
  type LlmRecoveryLedger,
} from './recovery';
import type { LlmResolver } from './resolver';
import {
  readRetryAfterMs,
  resolveMaxAttempts,
  retryBackoffDelay,
  shouldRetry,
  type LlmRetryable,
  type LlmRetryOptions,
} from './retry';
import { settleLlmRequest } from './settle';

export type LlmPolicyList<T> = readonly T[] | (() => readonly T[]);

export interface LlmPolicy {
  readonly resolvers?: LlmPolicyList<LlmResolver>;
  readonly recoveries?: LlmPolicyList<LlmRecovery>;
  readonly retryables?: LlmPolicyList<LlmRetryable>;
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

const toolSignature = ({ name, description, parameters }: ToolDescription) => ({
  name,
  description,
  parameters,
});

export function llmStartedEvent(request: LlmRequest): LlmRunStarted {
  const { model, profile, content } = request;
  const encoder = new TextEncoder();
  const systemPromptHash =
    profile?.systemPrompt === undefined ? undefined : sha256Hex(encoder.encode(profile.systemPrompt));
  const toolsHash =
    profile?.tools === undefined
      ? undefined
      : sha256Hex(
          encoder.encode(
            JSON.stringify(profile.tools.filter((tool) => tool.deferred !== true).map(toolSignature)),
          ),
        );
  return {
    type: 'llm.started',
    provider: model.spec.provider,
    model: model.spec.name,
    thinkingEffort: model.thinking?.effort,
    thinkingKeep: model.thinking?.keep,
    temperature: model.sampling?.temperature,
    topP: model.sampling?.topP,
    maxOutputTokens: model.maxOutputTokens,
    systemPromptHash,
    toolsHash,
    messageCount: content.messages.length,
  };
}

export async function runLlmRequest(
  request: LlmRequest,
  control: LlmRunControl,
): Promise<LlmOutcome> {
  control.onEvent?.(llmStartedEvent(request));
  let outcome: LlmOutcome;
  try {
    outcome = await runAttempts(request, control);
  } catch (error) {
    outcome =
      control.signal.aborted || isAbortError(error)
        ? { type: 'aborted', message: null, usage: undefined }
        : { type: 'failed', error: toLlmErrorMessage(error), rawError: error };
  }
  control.onEvent?.({ type: 'llm.ended', outcome });
  return outcome;
}

async function runAttempts(request: LlmRequest, control: LlmRunControl): Promise<LlmOutcome> {
  const { signal, onEvent } = control;
  const policy = request.policy ?? {};
  const ledger = control.recoveries ?? createRecoveryLedger();
  let attempt = 1;
  const maxAttempts = resolveMaxAttempts(policy.retry);

  while (!signal.aborted) {
    const recoveredRequest = ledger.apply(request);
    let resolvedRequest = recoveredRequest;
    for (const resolver of listOf(policy.resolvers)) {
      resolvedRequest = await resolver.resolve(resolvedRequest, {
        signal,
        report: (notice) =>
          onEvent?.({ type: 'llm.notice', notice: { ...notice, source: resolver.id } }),
      });
      if (signal.aborted) {
        return { type: 'aborted', message: null, usage: undefined };
      }
    }

    const result = await settleLlmRequest(resolvedRequest, { signal, onEvent });
    if (result.type === 'done' || result.type === 'aborted') {
      return result;
    }

    const remote = asRemote(result.error);
    if (remote !== undefined) {
      const proposal = proposeFirst(listOf(policy.recoveries), {
        error: remote,
        request: recoveredRequest,
        appliedRecoveries: ledger.applied,
        endpoint: recoveredRequest.endpoint,
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
        });
        continue;
      }
    }

    if (shouldRetry(policy.retry, attempt, result.error, listOf(policy.retryables))) {
      const delayMs = readRetryAfterMs(result.error) ?? retryBackoffDelay(attempt - 1);
      onEvent?.({
        type: 'llm.retrying',
        reason: 'backoff',
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        error: result.error,
      });
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
