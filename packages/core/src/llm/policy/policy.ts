/**
 * `runLlmRequest`: the policy-driven attempt loop. Each attempt applies recorded recovery rewrites and
 * the resolvers, then settles; failures are recovered or retried per the request policy, and every run
 * ends with `llm.ended` and an `LlmOutcome`.
 */
import { estimateUsedContextTokens } from '#/llm/context-usage';
import { toRequestMessages } from '#/llm/history';
import type { ToolDescription } from '#/llm/message';
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmProtocolRequest, LlmRequest } from '#/llm/request';
import type { LlmOutcome, LlmRunEvent, LlmRunStarted } from '#/llm/response';
import { sha256Hex } from '#/utils/hash';

import {
  createRecoveryLedger,
  createRecoveryMemory,
  proposeFirst,
  type LlmRecovery,
  type LlmRecoveryMemory,
  type LlmRecoveryRecord,
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
  readonly onAttempt?: (
    request: LlmProtocolRequest,
    context: { readonly appliedRecoveries: readonly LlmRecoveryRecord[] },
  ) => void;
  readonly onEvent?: (event: LlmRunEvent) => void;
}

export interface LlmRequesterExecution {
  readonly recoveries: LlmRecoveryMemory;
}

export function createLlmRequesterExecution(): LlmRequesterExecution {
  return { recoveries: createRecoveryMemory() };
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

function abortedOf(
  result: Extract<LlmOutcome, { type: 'failed' }>,
  reason: unknown,
): LlmOutcome {
  return {
    type: 'aborted',
    entry: result.entry ?? null,
    reason,
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

export function llmStartedEvent(request: LlmProtocolRequest): LlmRunStarted {
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
  execution: LlmRequesterExecution = createLlmRequesterExecution(),
): Promise<LlmOutcome> {
  let outcome: LlmOutcome;
  try {
    const protocolRequest: LlmProtocolRequest = {
      ...request,
      content: {
        messages: toRequestMessages(request.content.entries),
        usedTokens: request.content.usedTokens ?? estimateUsedContextTokens(request.content.entries, request.profile),
      },
    };
    outcome = await runAttempts(protocolRequest, control, execution.recoveries);
  } catch (error) {
    if (control.signal.aborted || isAbortError(error)) {
      outcome = { type: 'aborted', entry: null, usage: undefined };
    } else {
      const llmError = toLlmErrorMessage(error);
      outcome = {
        type: 'failed',
        error: llmError,
        rawError: error,
        diagnostics: request.protocol.base.diagnoseError?.({ error: llmError, rawError: error }),
      };
    }
  }
  control.onEvent?.({ type: 'llm.ended', outcome });
  return outcome;
}

async function runAttempts(
  request: LlmProtocolRequest,
  control: LlmRunControl,
  recoveries: LlmRecoveryMemory,
): Promise<LlmOutcome> {
  const { signal, onEvent } = control;
  const policy = request.policy ?? {};
  const ledger = createRecoveryLedger(recoveries.read(request));
  let attempt = 1;
  let started = false;
  const pendingNotices: LlmRunEvent[] = [];
  const maxAttempts = resolveMaxAttempts(policy.retry);
  const start = (resolvedRequest: LlmProtocolRequest): void => {
    if (started) return;
    started = true;
    onEvent?.(llmStartedEvent(resolvedRequest));
    for (const event of pendingNotices) onEvent?.(event);
    pendingNotices.length = 0;
  };

  while (!signal.aborted) {
    const recoveredRequest = ledger.apply(request);
    let resolvedRequest = recoveredRequest;
    let recoveryRequest = recoveredRequest;
    try {
      for (const resolver of listOf(policy.resolvers)) {
        resolvedRequest = await resolver.resolve(resolvedRequest, {
          signal,
          appliedRecoveries: ledger.applied,
          report: (notice) => {
            const event: LlmRunEvent = {
              type: 'llm.notice',
              notice: { ...notice, source: resolver.id },
            };
            if (started) onEvent?.(event);
            else pendingNotices.push(event);
          },
        });
        if (resolver.recoveryRequest === 'resolved') recoveryRequest = resolvedRequest;
        if (signal.aborted) {
          start(recoveredRequest);
          return { type: 'aborted', entry: null, usage: undefined };
        }
      }
    } catch (error) {
      start(recoveredRequest);
      throw error;
    }

    start(resolvedRequest);
    control.onAttempt?.(resolvedRequest, { appliedRecoveries: ledger.applied });
    const result = await settleLlmRequest(resolvedRequest, { signal, onEvent });
    if (result.type === 'done' || result.type === 'aborted') {
      return result;
    }

    const proposal = proposeFirst(listOf(policy.recoveries), {
      error: result.error,
      request: recoveryRequest,
      appliedRecoveries: ledger.applied,
      endpoint: recoveryRequest.endpoint,
    });
    if (proposal !== undefined) {
      proposal.beforeNextAttempt?.();
      ledger.record(proposal);
      recoveries.record(request, proposal);
      attempt = 1;
      onEvent?.({
        type: 'llm.retrying',
        reason: 'recovery',
        strategy: proposal.strategy,
        action: proposal.action,
        error: result.error,
        entry: result.entry,
        usage: result.usage,
        headers: result.headers,
        finish: result.finish,
        messageId: result.messageId,
        requestId: result.requestId,
        timing: result.timing,
      });
      continue;
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
        entry: result.entry,
        usage: result.usage,
        headers: result.headers,
        finish: result.finish,
        messageId: result.messageId,
        requestId: result.requestId,
        timing: result.timing,
      });
      if (!(await delay(delayMs, signal))) {
        return abortedOf(result, signal.reason);
      }
      attempt += 1;
      continue;
    }

    return result;
  }

  return { type: 'aborted', entry: null, usage: undefined };
}
