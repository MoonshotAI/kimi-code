import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ToolCall } from '@moonshot-ai/core/llm/message';
import type { ToolResult } from '#/tool/toolContract';
import { isToolDetachAck, legacyToolDurationMs } from '#/tool/executor';

export interface LegacyExecutionResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolResult;
  readonly durationMs: number;
}

export interface LegacyExecuteOptions {
  readonly turnId: number;
  readonly signal?: AbortSignal;
  readonly trace?: LLMRequestTrace;
  readonly detach?: (toolCallId: string, text: string) => void;
}

export async function executeLegacyTool(
  executor: IAgentToolExecutorService,
  calls: readonly ToolCall[],
  options: LegacyExecuteOptions,
): Promise<LegacyExecutionResult[]> {
  return Promise.all(calls.map(async (call) => {
    const handler = executor.executor.execute(call, {
      turnId: options.turnId,
      trace: options.trace,
    });
    const onAbort = (): void => {
      void handler.stop(options.signal?.reason);
    };
    if (options.signal?.aborted === true) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await handler;
      if (isToolDetachAck(response)) {
        const text = response.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
        options.detach?.(call.id, text);
      }
      const final = await handler.wait();
      const snapshot = handler.snapshot();
      const prepared = snapshot.prepared;
      const legacy = prepared?.kind === 'execute' || prepared?.kind === 'synthetic'
        ? prepared.result
        : undefined;
      const content = (value: typeof final.content) => value.every((part) => part.type === 'text')
        ? value.map((part) => part.type === 'text' ? part.text : '').join('')
        : value;
      const result: ToolResult = {
        ...legacy,
        output: final.outcome.type !== 'success'
          ? content(final.content)
          : (legacy?.output ?? content(final.content)),
        isError: final.outcome.type === 'success' ? legacy?.isError : true,
        description: prepared?.kind === 'execute' ? prepared.description : undefined,
        display: prepared?.kind === 'execute' ? prepared.display : undefined,
        approvalRule: prepared?.kind === 'execute' ? prepared.approvalRule : undefined,
      };
      return {
        toolCallId: call.id,
        toolName: call.name,
        result,
        durationMs: legacyToolDurationMs(snapshot),
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      executor.release(handler.taskId);
    }
  }));
}
