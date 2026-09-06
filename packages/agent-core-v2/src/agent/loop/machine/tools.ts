import type {
  IAgentToolExecutorService,
  ToolCallStartedPayload,
  ToolExecutionResult,
} from '#/agent/toolExecutor/toolExecutor';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import type {
  ToolDelivery,
  ToolInfo,
  ToolResult as AgentToolResult,
  ToolUpdate as AgentToolUpdate,
} from '#/tool/toolContract';
import type { ContentPart, ToolCall } from '#human/llm/message';
import type { ToolExecuteInput, ToolResult, ToolUpdate } from '#human/tool/executor';
import type { ToolDefinition } from '#human/tool/tool';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export interface ToolResultExtras {
  readonly stopTurn?: boolean;
  readonly stopTurnReason?: string;
  readonly note?: string;
  readonly delivery?: ToolDelivery;
  readonly stopBatchAfterThis?: boolean;
  readonly output?: string | ContentPart[];
  readonly isError?: boolean;
}

export interface CreateMachineToolsOptions {
  readonly toolExecutor: IAgentToolExecutorService;
  readonly toolInfos: readonly ToolInfo[];
  readonly turnId: () => number;
  readonly trace?: () => LLMRequestTrace | undefined;
  readonly onToolCall?: (payload: ToolCallStartedPayload) => void;
  readonly onToolResult?: (toolCallId: string, result: AgentToolResult) => void;
  readonly onBatchError?: (error: unknown) => void;
}

export interface MachineTools {
  readonly tools: ToolDefinition[];
  readonly extras: ReadonlyMap<string, ToolResultExtras>;
  beginBatch(expectedCalls?: readonly ToolCall[]): void;
  handleProgress(toolCallId: string, update: AgentToolUpdate): void;
}

interface PendingEntry {
  readonly input: ToolExecuteInput;
  readonly resolve: (result: ToolResult) => void;
  readonly removeAbortListener: () => void;
}

function toContentParts(output: string | ContentPart[]): ContentPart[] {
  return typeof output === 'string' ? [{ type: 'text', text: output }] : output;
}

export function createMachineTools(options: CreateMachineToolsOptions): MachineTools {
  const extras = new Map<string, ToolResultExtras>();
  const progressHandlers = new Map<string, ((update: ToolUpdate) => void) | undefined>();
  const knownNames = new Set(options.toolInfos.map((info) => info.name));
  const pending = new Map<string, PendingEntry>();
  let expectedIds: readonly string[] | undefined;
  let batchInFlight = false;

  const settleEntry = (entry: PendingEntry, result: ToolResult): void => {
    entry.removeAbortListener();
    progressHandlers.delete(entry.input.toolCall.id);
    entry.resolve(result);
  };

  const settleAborted = (entry: PendingEntry): void => {
    settleEntry(entry, {
      content: [{ type: 'text', text: `Tool "${entry.input.toolCall.name}" aborted before execution.` }],
      isError: true,
    });
  };

  const runBatch = async (entries: readonly PendingEntry[]): Promise<void> => {
    batchInFlight = true;
    const inFlight = new Map<string, PendingEntry>();
    for (const entry of entries) inFlight.set(entry.input.toolCall.id, entry);
    const signal = AbortSignal.any(entries.map((entry) => entry.input.signal));
    const calls = entries.map((entry) => entry.input.toolCall);
    const settleRemaining = (error?: unknown): void => {
      for (const entry of inFlight.values()) {
        settleEntry(entry, {
          content: [
            {
              type: 'text',
              text:
                error === undefined
                  ? `Tool "${entry.input.toolCall.name}" produced no result.`
                  : `Tool "${entry.input.toolCall.name}" failed: ${toErrorMessage(error)}`,
            },
          ],
          isError: true,
        });
      }
      inFlight.clear();
    };
    try {
      const stream = options.toolExecutor.execute(calls, {
        signal,
        turnId: options.turnId(),
        trace: options.trace?.(),
        onToolCall: options.onToolCall,
      });
      for await (const result of stream) {
        const entry = inFlight.get(result.toolCallId);
        if (entry === undefined) continue;
        inFlight.delete(result.toolCallId);
        try {
          applyResult(entry, result);
        } catch (error) {
          settleEntry(entry, {
            content: [
              {
                type: 'text',
                text: `Tool "${entry.input.toolCall.name}" failed: ${toErrorMessage(error)}`,
              },
            ],
            isError: true,
          });
        }
      }
      settleRemaining();
    } catch (error) {
      try {
        options.onBatchError?.(error);
      } finally {
        settleRemaining(error);
      }
    } finally {
      batchInFlight = false;
    }
  };

  const applyResult = (entry: PendingEntry, matched: ToolExecutionResult): void => {
    const id = entry.input.toolCall.id;
    const { result } = matched;
    options.onToolResult?.(id, result);
    extras.set(id, {
      stopTurn: result.stopTurn,
      stopTurnReason: result.stopTurnReason,
      note: result.note,
      delivery: result.delivery,
      stopBatchAfterThis: result.stopBatchAfterThis,
      output: result.output,
      isError: result.isError,
    });
    settleEntry(entry, {
      content: toContentParts(result.output),
      isError: result.isError === true ? true : undefined,
    });
  };

  const flushIfReady = (): void => {
    if (expectedIds === undefined || batchInFlight) return;
    if (!expectedIds.every((id) => pending.has(id))) return;
    const entries: PendingEntry[] = [];
    for (const id of expectedIds) {
      const entry = pending.get(id)!;
      pending.delete(id);
      entries.push(entry);
    }
    if (entries.length === 0) return;
    void runBatch(entries);
  };

  const execute = (input: ToolExecuteInput): Promise<ToolResult> => {
    progressHandlers.set(input.toolCall.id, input.onUpdate);
    if (expectedIds === undefined || batchInFlight) {
      return new Promise<ToolResult>((resolve) => {
        const entry: PendingEntry = { input, resolve, removeAbortListener: () => {} };
        void runBatch([entry]);
      });
    }
    return new Promise<ToolResult>((resolve) => {
      const onAbort = (): void => {
        if (!pending.delete(input.toolCall.id)) return;
        const stale = [...pending.values()];
        pending.clear();
        settleAborted({ input, resolve, removeAbortListener: () => {} });
        for (const entry of stale) settleAborted(entry);
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      pending.set(input.toolCall.id, {
        input,
        resolve,
        removeAbortListener: () => {
          input.signal.removeEventListener('abort', onAbort);
        },
      });
      flushIfReady();
    });
  };

  return {
    tools: options.toolInfos.map((info) => ({
      name: info.name,
      description: info.description,
      parameters: info.parameters ?? EMPTY_TOOL_PARAMETERS,
      deferred: info.disclosure === 'deferred' ? true : undefined,
      execute,
    })),
    extras,
    beginBatch: (expectedCalls) => {
      if (expectedCalls === undefined) {
        expectedIds = undefined;
        const stale = [...pending.values()];
        pending.clear();
        for (const entry of stale) settleAborted(entry);
        return;
      }
      expectedIds = expectedCalls.filter((call) => knownNames.has(call.name)).map((call) => call.id);
      flushIfReady();
    },
    handleProgress: (toolCallId, update) => {
      const onUpdate = progressHandlers.get(toolCallId);
      if (onUpdate === undefined) return;
      onUpdate({
        key: update.customKind ?? update.kind,
        text: update.text ?? '',
        percent: update.percent,
      });
    },
  };
}
