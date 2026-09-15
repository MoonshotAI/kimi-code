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
import type { ToolExecuteInput, ToolExecutor, ToolResult, ToolUpdate } from '#human/tool/executor';
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
  readonly toolInfos: () => readonly ToolInfo[];
  readonly turnId: () => number;
  readonly steerSignal?: () => AbortSignal | undefined;
  readonly trace?: () => LLMRequestTrace | undefined;
  readonly onToolCall?: (payload: ToolCallStartedPayload) => void;
  readonly onToolResult?: (toolCallId: string, result: AgentToolResult) => void;
  readonly onBatchError?: (error: unknown) => void;
}

export interface MachineTools {
  readonly tools: ToolDefinition[];
  readonly executor: ToolExecutor;
  readonly extras: ReadonlyMap<string, ToolResultExtras>;
  sync(): void;
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
  const definitions = new Map<string, ToolDefinition>();
  const tools: ToolDefinition[] = [];
  const pending = new Map<string, PendingEntry>();
  let expectedIds: readonly string[] | undefined;
  let batchInFlight = false;

  const materialize = (): void => {
    for (const info of options.toolInfos()) {
      if (definitions.has(info.name)) continue;
      const definition: ToolDefinition = {
        name: info.name,
        description: info.description,
        parameters: info.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: info.disclosure === 'deferred' ? true : undefined,
        execute,
      };
      definitions.set(info.name, definition);
      tools.push(definition);
    }
  };

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
      for (const entry of entries) inFlight.set(entry.input.toolCall.id, entry);
      const signal = AbortSignal.any(entries.map((entry) => entry.input.signal));
      const calls = entries.map((entry) => entry.input.toolCall);
      const stream = options.toolExecutor.execute(calls, {
        signal,
        steerSignal: options.steerSignal?.(),
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

  const startBatch = (entries: readonly PendingEntry[]): void => {
    void runBatch(entries).catch((error: unknown) => {
      options.onBatchError?.(error);
    });
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
      const entry = pending.get(id);
      if (entry === undefined) continue;
      pending.delete(id);
      entries.push(entry);
    }
    if (entries.length === 0) return;
    startBatch(entries);
  };

  const execute = (input: ToolExecuteInput): Promise<ToolResult> => {
    if (expectedIds === undefined || batchInFlight) {
      progressHandlers.set(input.toolCall.id, input.onUpdate);
      return new Promise<ToolResult>((resolve) => {
        const entry: PendingEntry = { input, resolve, removeAbortListener: () => {} };
        startBatch([entry]);
      });
    }
    return new Promise<ToolResult>((resolve) => {
      const previous = pending.get(input.toolCall.id);
      if (previous !== undefined) {
        pending.delete(input.toolCall.id);
        settleEntry(previous, {
          content: [
            {
              type: 'text',
              text: `Tool "${previous.input.toolCall.name}" superseded by a duplicate tool call id.`,
            },
          ],
          isError: true,
        });
      }
      progressHandlers.set(input.toolCall.id, input.onUpdate);
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
    tools,
    executor: {
      execute: async (input) => {
        materialize();
        const tool = definitions.get(input.toolCall.name);
        if (tool === undefined) {
          return {
            content: [{ type: 'text', text: `unknown tool: ${input.toolCall.name}` }],
            isError: true,
          };
        }
        return tool.execute(input);
      },
    },
    extras,
    sync: materialize,
    beginBatch: (expectedCalls) => {
      materialize();
      if (expectedCalls === undefined) {
        expectedIds = undefined;
        const stale = [...pending.values()];
        pending.clear();
        for (const entry of stale) settleAborted(entry);
        return;
      }
      expectedIds = [
        ...new Set(expectedCalls.filter((call) => definitions.has(call.name)).map((call) => call.id)),
      ];
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
