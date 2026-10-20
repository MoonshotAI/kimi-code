import {
  createUserEntry,
  toRequestMessages,
  usedContextTokens,
  type HistoryMessage,
} from '@moonshot-ai/agent-core/history/index';
import { createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LlmOutcome, TokenUsage } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import { describeUnknownError } from '#/features/config/index';

import instructionTemplate from './compaction-instruction.md?raw';
import { CompactError, isShrinkableSummaryError } from './errors';

export interface SummaryOutcome {
  text: string;
  usage?: TokenUsage;
  traceId?: string;
  attempts: number;
  droppedCount: number;
}

export type Summarize = (input: {
  history: readonly HistoryMessage[];
  instruction?: string;
  signal: AbortSignal;
}) => Promise<SummaryOutcome>;

export interface CreateSummarizeOptions {
  requester: LoopLlmRequester;
  systemPrompt?: string;
  maxShrinkAttempts?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function createSummarize(options: CreateSummarizeOptions): Summarize {
  const maxShrinkAttempts = options.maxShrinkAttempts ?? 3;
  return async ({ history, instruction, signal }) => {
    const instructionEntry = createUserEntry(
      createUserMessage(compactionInstructionText(instruction)),
      { source: 'input' },
    );
    let attemptHistory = [...history];
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) {
        throw new CompactError('aborted', 'compaction was aborted');
      }
      const outcome = await runSummaryRequest(options, [...attemptHistory, instructionEntry], signal);
      if (outcome.type === 'done') {
        const text = extractText(outcome.message);
        if (text.trim().length > 0) {
          return {
            text,
            usage: outcome.usage,
            traceId: outcome.headers?.['x-trace-id'],
            attempts: attempt + 1,
            droppedCount: history.length - attemptHistory.length,
          };
        }
      }
      if (outcome.type === 'aborted') {
        throw new CompactError('aborted', 'summary turn was aborted');
      }
      const error = outcome.type === 'failed' ? outcome.error : undefined;
      if (
        attempt + 1 >= maxShrinkAttempts ||
        attemptHistory.length <= 1 ||
        (error !== undefined && !isShrinkableSummaryError(error))
      ) {
        throw new CompactError(
          'summary-failed',
          `summary turn failed: ${describeUnknownError(error)}`,
        );
      }
      attemptHistory = dropOldestAndLeadingToolResults(attemptHistory);
    }
  };
}

function runSummaryRequest(
  options: CreateSummarizeOptions,
  history: readonly HistoryMessage[],
  signal: AbortSignal,
): Promise<LlmOutcome> {
  return options.requester.generate(
    {
      profile: { systemPrompt: options.systemPrompt, tools: [] },
      content: { messages: toRequestMessages(history), usedTokens: usedContextTokens(history) },
    },
    { signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)]) },
  );
}

function compactionInstructionText(customInstruction?: string): string {
  const custom = customInstruction?.trim() ?? '';
  const block = custom.length > 0 ? `\nOptional user instruction:\n${custom}\n` : '';
  return instructionTemplate.replace('${custom_instruction_block}', () => block).trimEnd();
}

function dropOldestAndLeadingToolResults(
  history: readonly HistoryMessage[],
): HistoryMessage[] {
  const rest = history.slice(1);
  let start = 0;
  while (start < rest.length && rest[start]?.message.role === 'tool') {
    start++;
  }
  return rest.slice(start);
}
