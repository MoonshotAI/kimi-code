import {
  createUserEntry,
  type AssistantEntry,
  type createTurnMachine,
  type HistoryMessage,
  type TurnOutput,
} from '#/agent/turn';
import { createUserMessage, extractText } from '#/llm/message';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { TokenUsage } from '#/llm/usage';
import { createActor, waitFor } from '#/xstate2';

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
  request: LlmRequestConfig;
  llm: () => ReturnType<typeof createTurnMachine>;
  maxShrinkAttempts?: number;
  timeoutMs?: number;
}

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
      const output = await runSummaryTurn(options, [...attemptHistory, instructionEntry], signal);
      if (output.type === 'done') {
        const entry = lastAssistantEntry(output.produced);
        const text = entry === undefined ? undefined : extractText(entry.message);
        if (entry !== undefined && text !== undefined && text.trim().length > 0) {
          return {
            text,
            usage: entry.meta.usage,
            traceId: entry.meta.headers?.['x-trace-id'],
            attempts: attempt + 1,
            droppedCount: history.length - attemptHistory.length,
          };
        }
      }
      if (output.type === 'aborted') {
        throw new CompactError('aborted', 'summary turn was aborted');
      }
      const error = output.type === 'failed' ? output.error : undefined;
      if (
        attempt + 1 >= maxShrinkAttempts ||
        attemptHistory.length <= 1 ||
        (error !== undefined && !isShrinkableSummaryError(error))
      ) {
        throw new CompactError(
          'summary-failed',
          `summary turn failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      attemptHistory = dropOldestAndLeadingToolResults(attemptHistory);
    }
  };
}

async function runSummaryTurn(
  options: CreateSummarizeOptions,
  history: readonly HistoryMessage[],
  signal: AbortSignal,
): Promise<TurnOutput> {
  const actor = createActor(options.llm(), {
    input: { request: options.request, history, parentSignal: signal },
  });
  actor.start();
  try {
    const snapshot = await waitFor(actor, (s) => s.status !== 'active', {
      timeout: options.timeoutMs ?? 120_000,
    });
    return snapshot.output as TurnOutput;
  } finally {
    actor.stop();
  }
}

function lastAssistantEntry(produced: readonly HistoryMessage[]): AssistantEntry | undefined {
  for (let i = produced.length - 1; i >= 0; i--) {
    const entry = produced[i];
    if (entry !== undefined && entry.message.role === 'assistant') {
      return entry as AssistantEntry;
    }
  }
  return undefined;
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
