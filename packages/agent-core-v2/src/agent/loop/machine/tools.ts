import type {
  IAgentToolExecutorService,
  ToolCallStartedPayload,
  ToolExecutionResult,
} from '#/agent/toolExecutor/toolExecutor';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type {
  ToolDelivery,
  ToolInfo,
  ToolResult as AgentToolResult,
  ToolUpdate as AgentToolUpdate,
} from '#/tool/toolContract';
import type { ContentPart } from '#human/llm/message';
import type { ToolExecuteInput, ToolResult, ToolUpdate } from '#human/tool/executor';
import type { ToolDefinition } from '#human/tool/tool';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const SKIPPED_TOOL_OUTPUT = 'Tool skipped because a previous tool call stopped the turn.';

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
}

export interface MachineTools {
  readonly tools: ToolDefinition[];
  readonly extras: ReadonlyMap<string, ToolResultExtras>;
  beginBatch(): void;
  handleProgress(toolCallId: string, update: AgentToolUpdate): void;
}

function toContentParts(output: string | ContentPart[]): ContentPart[] {
  return typeof output === 'string' ? [{ type: 'text', text: output }] : output;
}

function parseToolArgs(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createMachineTools(options: CreateMachineToolsOptions): MachineTools {
  const extras = new Map<string, ToolResultExtras>();
  const progressHandlers = new Map<string, ((update: ToolUpdate) => void) | undefined>();
  let batchChain: Promise<unknown> = Promise.resolve();
  let batchStopped = false;

  const skippedResult = (input: ToolExecuteInput): ToolResult => {
    options.onToolCall?.({
      toolCallId: input.toolCall.id,
      name: input.toolCall.name,
      args: parseToolArgs(input.toolCall.arguments),
    });
    const result: AgentToolResult = { output: SKIPPED_TOOL_OUTPUT, isError: true };
    options.onToolResult?.(input.toolCall.id, result);
    extras.set(input.toolCall.id, { output: SKIPPED_TOOL_OUTPUT, isError: true });
    return { content: [{ type: 'text', text: SKIPPED_TOOL_OUTPUT }], isError: true };
  };

  const executeOne = async (input: ToolExecuteInput): Promise<ToolResult> => {
    if (batchStopped) return skippedResult(input);
    progressHandlers.set(input.toolCall.id, input.onUpdate);
    try {
      let matched: ToolExecutionResult | undefined;
      for await (const result of options.toolExecutor.execute([input.toolCall], {
        signal: input.signal,
        turnId: options.turnId(),
        trace: options.trace?.(),
        onToolCall: options.onToolCall,
      })) {
        if (result.toolCallId === input.toolCall.id) {
          matched = result;
          options.onToolResult?.(input.toolCall.id, result.result);
        }
      }
      if (matched === undefined) {
        return {
          content: [
            { type: 'text', text: `Tool "${input.toolCall.name}" produced no result.` },
          ],
          isError: true,
        };
      }
      const { result } = matched;
      extras.set(input.toolCall.id, {
        stopTurn: result.stopTurn,
        stopTurnReason: result.stopTurnReason,
        note: result.note,
        delivery: result.delivery,
        stopBatchAfterThis: result.stopBatchAfterThis,
        output: result.output,
        isError: result.isError,
      });
      if (
        result.isError === true &&
        (result.stopBatchAfterThis === true || result.stopTurn === true)
      ) {
        batchStopped = true;
      }
      return {
        content: toContentParts(result.output),
        isError: result.isError === true ? true : undefined,
      };
    } finally {
      progressHandlers.delete(input.toolCall.id);
    }
  };

  const execute = (input: ToolExecuteInput): Promise<ToolResult> => {
    const run = batchChain.then(() => executeOne(input));
    batchChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    beginBatch: () => {
      batchStopped = false;
      batchChain = Promise.resolve();
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
