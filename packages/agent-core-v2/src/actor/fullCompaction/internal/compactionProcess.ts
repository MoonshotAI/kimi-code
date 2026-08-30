import { renderPrompt } from '#/_base/utils/render-prompt';
import {
  APIEmptyResponseError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { createUserMessage, type Message } from '#/kosong/contract/message';
import { retryBackoffDelays, sleepForRetry } from '#/_base/utils/retry';
import { isAbortError } from '#/_base/utils/abort';
import type { Emitter } from '#/_base/event';
import type { OrderedHookSlot } from '#/hooks';
import { buildCompactionSummaryText } from '#/actor/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { stripDynamicToolContext } from '#/agent/toolSelect/dynamicTools';
import { renderTodoList } from '#/actor/todo/todoItem';
import type { CompactionFailedEvent, CompactionFinishedEvent } from '#/app/telemetry/events';
import {
  ErrorCodes,
  Error2,
  isError2,
  toKimiErrorPayload,
  unwrapErrorCause,
} from '#/errors';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';

import compactionInstructionTemplate from '../compaction-instruction.md?raw';
import type { CompactionState } from '../compactionOps';
import type {
  FullCompactionHookContext,
  FullCompactionTask,
} from '../fullCompactionAgentRuntime';
import type { CompactionResult } from '../types';
import {
  collectSummary,
  compactionCancelledReason,
  CompactionTruncatedError,
  dropOldestMessageAndLeadingToolResults,
  findAPIStatusError,
  historySafeToCompact,
  shrinkCompactionHistoryAfterOverflow,
  usageTelemetry,
  type CompactionAttemptResult,
} from './compactionHelpers';
import {
  compactionContextOf,
  compactionTaskOf,
  contextMemoryOf,
  llmRequesterOf,
  observeContextOverflow,
  profileOf,
  requestTokens,
  shouldRecoverFromContextOverflow,
  telemetryOf,
  todoOf,
  tokenCountingOf,
} from './compactionOperations';
import type { ActiveCompactionHandle } from './compactionMachine';

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;
const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;
const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;

export interface CompactionProcessInput {
  readonly runtime: AgentRuntimeContext<CompactionState>;
  readonly handle: ActiveCompactionHandle;
  readonly hooks: OrderedHookSlot<FullCompactionHookContext>;
  readonly emitter: Emitter<FullCompactionTask>;
}

function sendWhileAttached(input: CompactionProcessInput, event: unknown): void {
  if (input.handle.detached) return;
  input.runtime.send(event);
}

export async function runFullCompactionProcess(
  input: CompactionProcessInput,
): Promise<CompactionResult> {
  const { runtime, handle } = input;
  try {
    const result = await compactionRound(input);
    if (compactionContextOf(runtime).active !== handle) throw compactionCancelledReason(handle);
    sendWhileAttached(input, { type: 'fullCompaction.completed', result });
    return result;
  } catch (error) {
    if (handle.abortController.signal.aborted || isAbortError(error)) {
      sendWhileAttached(input, { type: 'fullCompaction.cancelled' });
      throw error;
    }
    const current = compactionContextOf(runtime).active;
    const blockedByTurn = current === handle && handle.blockedByTurn;
    if (current === handle) {
      sendWhileAttached(input, {
        type: 'fullCompaction.failed',
        errorPayload: toKimiErrorPayload(error),
        notify: !blockedByTurn,
      });
    }
    throw error;
  } finally {
    try {
      input.emitter.fire(compactionTaskOf(handle));
    } finally {
      handle.quiescence?.dispose();
    }
  }
}

async function compactionRound(input: CompactionProcessInput): Promise<CompactionResult> {
  const { runtime, handle } = input;
  const data = handle.data;
  const startedAt = Date.now();
  const originalHistory = [...contextMemoryOf(runtime).get()];
  const tokensBefore = requestTokens(runtime, originalHistory);
  let retryCount = 0;
  let thinkingEffort = profileOf(runtime).data().thinkingLevel;

  try {
    const signal = handle.abortController.signal;
    signal.throwIfAborted();

    await input.hooks.run({
      trigger: handle.trigger,
      tokenCount: handle.tokenCount,
      signal,
      settlement: handle.promise,
    });

    const resolvedModel = profileOf(runtime).modelContext();
    thinkingEffort = resolvedModel.thinkingLevel;
    const maxContextTokens = resolvedModel.modelCapabilities.max_context_tokens;
    const defaultCompactionCap =
      maxContextTokens > 0
        ? Math.min(maxContextTokens, DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS)
        : undefined;
    const compactionMaxOutputSize = resolvedModel.maxOutputSize ?? defaultCompactionCap;

    const customInstruction = data.instruction?.trim() ?? '';
    const instruction = renderPrompt(compactionInstructionTemplate, {
      custom_instruction_block:
        customInstruction.length > 0 ? `\nOptional user instruction:\n${customInstruction}\n` : '',
    }).trimEnd();

    const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
    let attempt: CompactionAttemptResult | undefined;
    let historyForModel: readonly ContextMessage[] = stripDynamicToolContext(originalHistory);
    let droppedCount = 0;
    let overflowShrinkCount = 0;
    let emptyOrTruncatedShrinkCount = 0;
    while (true) {
      const messagesToCompact = historyForModel;
      const messages: Message[] = [...messagesToCompact, createUserMessage(instruction)];
      const estimatedCompactionRequestTokens = requestTokens(runtime, messages);

      try {
        const request = llmRequesterOf(runtime).stream(
          {
            messages,
            maxOutputSize: compactionMaxOutputSize,
            source: {
              type: 'operation',
              turnId: handle.originTurnId,
              requestKind: 'full_compaction',
              logFields: { droppedCount },
            },
          },
          undefined,
          signal,
        );
        handle.trace = request.trace;
        attempt = collectSummary(await request.result);
        break;
      } catch (error) {
        const isContextOverflow = shouldRecoverFromContextOverflow(
          runtime,
          error,
          estimatedCompactionRequestTokens,
        );
        if (isContextOverflow) {
          observeContextOverflow(runtime, estimatedCompactionRequestTokens);
          overflowShrinkCount += 1;
          if (
            overflowShrinkCount > MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS ||
            messagesToCompact.length <= 1
          ) {
            throw error;
          }
          const before = messagesToCompact.length;
          historyForModel = shrinkCompactionHistoryAfterOverflow(
            messagesToCompact,
            overflowShrinkCount,
            (message) => tokenCountingOf(runtime).estimateMessage(message),
          );
          droppedCount += before - historyForModel.length;
          retryCount = 0;
          continue;
        }
        const unwrappedError = unwrapErrorCause(error);
        if (
          (error instanceof CompactionTruncatedError ||
            (unwrappedError instanceof APIEmptyResponseError &&
              unwrappedError.finishReason !== 'filtered')) &&
          messagesToCompact.length > 1
        ) {
          emptyOrTruncatedShrinkCount += 1;
          if (emptyOrTruncatedShrinkCount > MAX_COMPACTION_RETRY_ATTEMPTS) {
            throw error;
          }
          const reduced = dropOldestMessageAndLeadingToolResults(messagesToCompact);
          droppedCount += messagesToCompact.length - reduced.length;
          historyForModel = reduced;
          retryCount = 0;
          continue;
        }
        if (!isRetryableGenerateError(unwrappedError)) {
          throw error;
        }
        if (retryCount + 1 >= MAX_COMPACTION_RETRY_ATTEMPTS) {
          throw error;
        }
        await sleepForRetry(delays[retryCount]!, signal);
        retryCount += 1;
      }
    }

    if (attempt === undefined) {
      throw new APIEmptyResponseError(
        'The compaction response did not contain a usable summary.',
      );
    }

    if (!historySafeToCompact(contextMemoryOf(runtime).get(), originalHistory)) {
      const current = compactionContextOf(runtime).active;
      if (current !== undefined) {
        sendWhileAttached(input, { type: 'fullCompaction.cancelled' });
      }
      throw compactionCancelledReason(current ?? null);
    }

    const summary = await postProcessSummary(input, attempt.summary);
    const result = await contextMemoryOf(runtime).applyCompaction({
      summary,
      contextSummary: buildCompactionSummaryText(summary),
      compactedCount: originalHistory.length,
      tokensBefore,
      summaryOutputTokens: attempt.usage?.output,
      requestOverheadTokens: requestTokens(runtime, []),
      droppedCount: droppedCount === 0 ? undefined : droppedCount,
    });

    const properties: CompactionFinishedEvent = {
      turn_id: handle.originTurnId,
      source: data.source,
      tokens_before: result.tokensBefore,
      tokens_after: result.tokensAfter,
      duration_ms: Date.now() - startedAt,
      compacted_count: result.compactedCount,
      dropped_count: result.droppedCount,
      retry_count: retryCount,
      round: 1,
      thinking_effort: thinkingEffort,
      trace_id: attempt.traceId,
      ...usageTelemetry(attempt.usage),
    };
    telemetryOf(runtime).track2('compaction_finished', properties);
    return result;
  } catch (error) {
    if (isAbortError(error)) throw error;
    const properties: CompactionFailedEvent = {
      turn_id: handle.originTurnId,
      source: data.source,
      tokens_before: tokensBefore,
      duration_ms: Date.now() - startedAt,
      round: 1,
      retry_count: retryCount,
      thinking_effort: thinkingEffort,
      error_type: error instanceof Error ? error.name : 'Unknown',
      trace_id: findAPIStatusError(error)?.traceId ?? handle.traceId,
    };
    telemetryOf(runtime).track2('compaction_failed', properties);
    if (
      isError2(error) &&
      (error.code === ErrorCodes.AUTH_LOGIN_REQUIRED ||
        error.code === ErrorCodes.PROVIDER_AUTH_ERROR)
    ) {
      throw error;
    }
    throw new Error2(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
  }
}

async function postProcessSummary(input: CompactionProcessInput, summary: string): Promise<string> {
  const todos = todoOf(input.runtime).get();
  if (todos.length === 0) {
    return summary;
  }
  return `${summary.trim()}\n\n${renderTodoList(todos, '## TODO List')}`;
}
