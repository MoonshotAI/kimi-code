/**
 * `agentLifecycle` domain (L6) — helper that runs one prompt (or retry) turn on
 * a child agent, mirrors the child's turn lifecycle onto the caller's record
 * stream + external hooks, and distills a summary the caller can hand back to
 * its own tool result.
 *
 * Not a Service: `observeChildAgentTurn` is a pure function that borrows
 * `IAgentPromptService`, `IAgentContextMemoryService`, `IAgentUsageService`
 * from the child scope and `IAgentRecordService`, `IAgentExternalHooksService`
 * from the caller scope. It replaces the free-function `spawnChildAgent` /
 * `resumeChildAgent` orchestration under the old `agentTool` domain: the fork
 * step is now `IAgentLifecycleService.spawn`, profile application is
 * `applyProfileToAgent`, and the caller-side spawn record (`subagent.spawned`)
 * is emitted by the caller directly because it carries tool-call provenance
 * (`parentToolCallId`, `swarmIndex`, `runInBackground`) the observer does not
 * know about.
 *
 * The lifecycle is imperative — the caller (`Agent` tool, `sessionSwarmService`)
 * awaits the returned `completion` promise. Turn hooks are not used because
 * there is exactly one observer (the caller who spawned the child); a hook
 * indirection would only obscure the flow.
 */

import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '#/app/llmProtocol';

import { linkAbortSignal, userCancellationReason } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import {
  IAgentContextMemoryService,
  type ContextMessage,
  type PromptOrigin,
} from '#/agent/contextMemory';
import { ErrorCodes, toKimiErrorPayload, type KimiErrorPayload } from '#/errors';
import { IAgentRecordService } from '#/agent/record';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import { isAbortError } from '#/agent/loop/errors';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentUsageService } from '#/agent/usage';
import type { Turn } from '#/agent/turn';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog';

/**
 * Legacy `PromptOrigin` tag emitted by the `Agent` tool and swarm scheduler
 * when they submit a prompt to a child agent. Wire shape kept unchanged
 * (`kind: 'system_trigger', name: 'subagent'`) so existing session recordings
 * replay against v2 without a protocol schema bump. Rename lives on a separate
 * wire-cleanup PR.
 */
export const CHILD_AGENT_PROMPT_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'subagent',
};

const HOOK_TEXT_PREVIEW_LENGTH = 500;

export type ChildAgentTurnRequest =
  | { readonly kind: 'prompt'; readonly prompt: string }
  | { readonly kind: 'retry'; readonly trigger?: string };

export interface ObserveChildAgentTurnOptions {
  /** Profile the child was configured under; only used for external hooks / record labels. */
  readonly profileName: string;
  /** When set, drives a continuation-prompt loop when the child's summary is too short. */
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
  /** Skip the caller-side `subagent.failed` record for provider-rate-limit / aborted failures. */
  readonly suppressRateLimitFailureEvent?: boolean;
  /** Caller's cancellation signal. Aborting it cancels the child's turn. */
  readonly signal: AbortSignal;
  /** Fires once the child's first request is committed (used by swarm to fan out). */
  readonly onReady?: () => void;
}

export interface ObservedChildAgentTurn {
  readonly turn: Turn;
  readonly completion: Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
}

/**
 * Submit a prompt (or a retry) to `child`, wire the caller's record/hook
 * projections and the summary-distillation policy, and return the running
 * `Turn` plus a promise of the distilled summary/usage.
 *
 * Returns `undefined` when the underlying `IAgentPromptService.prompt/retry`
 * refuses to launch a turn (busy / no head).
 */
export function observeChildAgentTurn(
  caller: IAgentScopeHandle,
  child: IAgentScopeHandle,
  request: ChildAgentTurnRequest,
  options: ObserveChildAgentTurnOptions,
): ObservedChildAgentTurn | undefined {
  options.signal.throwIfAborted();
  const promptService = child.accessor.get(IAgentPromptService);
  const turn =
    request.kind === 'prompt'
      ? promptService.prompt({
          role: 'user',
          content: [{ type: 'text', text: request.prompt }],
          toolCalls: [],
          origin: CHILD_AGENT_PROMPT_ORIGIN,
        })
      : promptService.retry(request.trigger ?? 'agent-host');
  if (turn === undefined) return undefined;

  if (options.onReady !== undefined) {
    void turn.ready.then(() => options.onReady?.()).catch(() => {});
  }

  const completion = runObservation(caller, child, turn, request, options);
  return { turn, completion };
}

async function runObservation(
  caller: IAgentScopeHandle,
  child: IAgentScopeHandle,
  turn: Turn,
  request: ChildAgentTurnRequest,
  options: ObserveChildAgentTurnOptions,
): Promise<{ summary: string; usage?: TokenUsage }> {
  const controller = new AbortController();
  const unlink = linkAbortSignal(options.signal, controller);
  const record = caller.accessor.get(IAgentRecordService);
  const hooks = caller.accessor.get(IAgentExternalHooksService);
  let turnRef: Turn = turn;
  record?.signal({ type: 'subagent.started', subagentId: child.id });
  if (request.kind === 'prompt') {
    try {
      await hooks?.triggerSubagentStart(
        {
          agentName: options.profileName,
          prompt: request.prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
        },
        options.signal,
      );
    } catch (error) {
      unlink();
      throw error;
    }
    if (options.signal.aborted) {
      unlink();
      throw options.signal.reason ?? userCancellationReason();
    }
  }
  try {
    const result = await awaitTurn(turnRef, controller);
    classifyTurnResult(result);
    const summary = await distillSummary(child, controller, options.summaryPolicy, (t) => {
      turnRef = t;
    });
    const usage = child.accessor.get(IAgentUsageService)?.status().total;
    record?.signal({
      type: 'subagent.completed',
      subagentId: child.id,
      resultSummary: summary,
      usage,
    });
    hooks?.triggerSubagentStop({
      agentName: options.profileName,
      response: summary.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
    });
    return { summary, usage };
  } catch (error) {
    if (!isAbortError(error) && !shouldSuppressFailure(options, error)) {
      record?.signal({
        type: 'subagent.failed',
        subagentId: child.id,
        error: errorMessage(error),
      });
    }
    throw error;
  } finally {
    unlink();
    if (controller.signal.aborted) {
      turnRef.abortController.abort(controller.signal.reason);
    }
  }
}

async function awaitTurn(
  turn: Turn,
  controller: AbortController,
): Promise<{ reason: string; error?: unknown }> {
  const onAbort = (): void => {
    turn.abortController.abort(controller.signal.reason);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([turn.result, abortPromise(controller.signal)]);
  } finally {
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function distillSummary(
  child: IAgentScopeHandle,
  controller: AbortController,
  policy: AgentProfileSummaryPolicy | undefined,
  setTurn: (turn: Turn) => void,
): Promise<string> {
  const memory = child.accessor.get(IAgentContextMemoryService);
  let summary = latestAssistantText(memory.get());
  if (policy === undefined) return summary;
  if (summary.trim().length >= policy.minChars) return summary;

  const promptService = child.accessor.get(IAgentPromptService);
  for (let attempt = 0; attempt < policy.retries; attempt++) {
    const turn = promptService.prompt({
      role: 'user',
      content: [{ type: 'text', text: policy.continuationPrompt }],
      toolCalls: [],
      origin: CHILD_AGENT_PROMPT_ORIGIN,
    });
    if (turn === undefined) break;
    setTurn(turn);
    const result = await awaitTurn(turn, controller);
    if (result.reason !== 'completed') break;
    const continued = latestAssistantText(memory.get());
    if (continued.trim().length > 0) summary = continued;
    if (summary.trim().length >= policy.minChars) break;
  }
  return summary;
}

function classifyTurnResult(result: { reason: string; error?: unknown }): void {
  if (result.reason === 'filtered') {
    throw new Error('Subagent turn blocked by provider safety policy');
  }
  if (result.reason === 'failed') {
    const error = result.error;
    if (isProviderRateLimitError(error)) throw error;
    const payload = toKimiErrorPayload(error);
    if (payload.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(payload);
    }
    throw error instanceof Error ? error : new Error(String(error ?? 'Subagent turn failed'));
  }
  if (result.reason === 'cancelled') {
    throw userCancellationReason();
  }
}

function shouldSuppressFailure(
  options: ObserveChildAgentTurnOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}

function providerRateLimitErrorFromPayload(error: KimiErrorPayload): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? userCancellationReason());
  }
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? userCancellationReason()),
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestAssistantText(messages: readonly ContextMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    return contentText(message.content);
  }
  return '';
}

function contentText(content: ContextMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<(typeof content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
