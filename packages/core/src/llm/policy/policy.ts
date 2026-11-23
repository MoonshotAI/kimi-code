import { estimateUsedContextTokens } from '#/llm/context-usage';
import type { ToolDescription } from '#/llm/message';
import { isAbortError, toLlmErrorMessage } from '#/llm/protocol/errors';
import type { LlmRequest } from '#/llm/request';
import type { LlmOutcome, LlmRunEvent, LlmRunRequested, LlmRunStarted } from '#/llm/response';
import { sha256Hex } from '#/utils/hash';
import { log } from '#/utils/log';

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
    request: LlmRequest,
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
    message: result.message ?? null,
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

export function llmRequestedEvent(request: LlmRequest, attempt: number): LlmRunRequested {
  const { maxOutputTokens, ...summary } = llmStartedEvent(request);
  const encoder = new TextEncoder();
  return {
    ...summary,
    type: 'llm.requested',
    maxTokens: typeof maxOutputTokens === 'number' ? maxOutputTokens : undefined,
    systemPromptHash: summary.systemPromptHash ?? sha256Hex(encoder.encode('')),
    toolsHash: summary.toolsHash ?? sha256Hex(encoder.encode('[]')),
    attempt: String(attempt),
  };
}

export async function runLlmRequest(
  request: LlmRequest,
  control: LlmRunControl,
  execution: LlmRequesterExecution = createLlmRequesterExecution(),
): Promise<LlmOutcome> {
  let outcome: LlmOutcome;
  try {
    const started: LlmRunEvent = llmStartedEvent(request);
    log.info({ ...started }, 'llm event');
    control.onEvent?.(started);
    const sizedRequest: LlmRequest =
      request.content.usedTokens === undefined
        ? {
            ...request,
            content: {
              ...request.content,
              usedTokens: estimateUsedContextTokens(request.content.messages, request.profile),
            },
          }
        : request;
    outcome = await runAttempts(sizedRequest, control, execution.recoveries);
  } catch (error) {
    if (control.signal.aborted || isAbortError(error)) {
      outcome = { type: 'aborted', message: null, usage: undefined };
    } else {
      const llmError = toLlmErrorMessage(error);
      log.error(
        {
          kind: llmError.kind,
          message: llmError.message,
          provider: request.model.spec.provider,
          model: request.model.spec.name,
        },
        'llm request threw before completion',
      );
      outcome = {
        type: 'failed',
        error: llmError,
        rawError: error,
        diagnostics: request.protocol.base.diagnoseError?.({ error: llmError, rawError: error }),
      };
    }
  }
  const ended: LlmRunEvent = { type: 'llm.ended', outcome };
  log.info({ ...ended }, 'llm event');
  control.onEvent?.(ended);
  return outcome;
}

async function runAttempts(
  request: LlmRequest,
  control: LlmRunControl,
  recoveries: LlmRecoveryMemory,
): Promise<LlmOutcome> {
  const { signal, onEvent } = control;
  const policy = request.policy ?? {};
  const ledger = createRecoveryLedger(recoveries.read(request));
  let attempt = 1;
  const maxAttempts = resolveMaxAttempts(policy.retry);

  while (!signal.aborted) {
    const recoveredRequest = ledger.apply(request);
    let resolvedRequest = recoveredRequest;
    let recoveryRequest = recoveredRequest;
    for (const resolver of listOf(policy.resolvers)) {
      resolvedRequest = await resolver.resolve(resolvedRequest, {
        signal,
        appliedRecoveries: ledger.applied,
        report: (notice) => {
          const event: LlmRunEvent = {
            type: 'llm.notice',
            notice: { ...notice, source: resolver.id },
          };
          log.info({ ...event }, 'llm event');
          onEvent?.(event);
        },
      });
      if (resolver.recoveryRequest === 'resolved') recoveryRequest = resolvedRequest;
      if (signal.aborted) {
        return { type: 'aborted', message: null, usage: undefined };
      }
    }

    control.onAttempt?.(resolvedRequest, { appliedRecoveries: ledger.applied });
    const requested: LlmRunEvent = llmRequestedEvent(resolvedRequest, attempt);
    log.info({ ...requested }, 'llm event');
    onEvent?.(requested);
    log.debug(
      {
        attempt,
        maxAttempts,
        provider: resolvedRequest.model.spec.provider,
        model: resolvedRequest.model.spec.name,
        recoveries: ledger.applied.length,
      },
      'llm attempt',
    );
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
      const retry: LlmRunEvent = {
        type: 'llm.retry',
        reason: 'recovery',
        strategy: proposal.strategy,
        action: proposal.action,
        error: result.error,
        message: result.message,
        usage: result.usage,
        headers: result.headers,
        finish: result.finish,
        messageId: result.messageId,
        requestId: result.requestId,
        timing: result.timing,
      };
      log.info({ ...retry }, 'llm event');
      onEvent?.(retry);
      continue;
    }

    if (shouldRetry(policy.retry, attempt, result.error, listOf(policy.retryables))) {
      const delayMs = readRetryAfterMs(result.error) ?? retryBackoffDelay(attempt - 1);
      const retry: LlmRunEvent = {
        type: 'llm.retry',
        reason: 'backoff',
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        error: result.error,
        message: result.message,
        usage: result.usage,
        headers: result.headers,
        finish: result.finish,
        messageId: result.messageId,
        requestId: result.requestId,
        timing: result.timing,
      };
      log.info({ ...retry }, 'llm event');
      onEvent?.(retry);
      if (!(await delay(delayMs, signal))) {
        return abortedOf(result, signal.reason);
      }
      attempt += 1;
      continue;
    }

    log.error(
      {
        kind: result.error.kind,
        message: result.error.message,
        provider: resolvedRequest.model.spec.provider,
        model: resolvedRequest.model.spec.name,
        attempts: attempt,
        recoveries: ledger.applied.length,
        requestId: result.requestId ?? null,
      },
      'llm request failed',
    );
    return result;
  }

  return { type: 'aborted', message: null, usage: undefined };
}
