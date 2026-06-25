import type { ContentPart } from '@moonshot-ai/kosong';

import { registerSingleton, SyncDescriptor } from "#/_base/di";
import { isAbortError } from '../../../loop/errors';
import type {
  ExecutableToolResult,
  ToolExecution,
} from '../../../loop/types';
import { isUserCancellation } from "#/_base/utils/abort";
import type { ToolCall, ToolResult } from '../types';
import { IToolExecutor, type ToolExecutorOptions } from './toolExecutor';

const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';
const NEVER_ABORTS = new AbortController().signal;

export class ToolExecutorService implements IToolExecutor {
  async execute(
    call: ToolCall,
    execution: ToolExecution,
    options: ToolExecutorOptions = {},
  ): Promise<ToolResult> {
    if (isAborted(options.signal)) {
      return abortedToolResult(call.name, options.signal);
    }

    try {
      if (execution.isError === true) {
        return normalizeToolResult(coerceToolResult(execution, call.name));
      }

      const result = await execution.execute({
        turnId: options.turnId ?? '',
        toolCallId: call.id,
        metadata: options.metadata,
        signal: options.signal ?? NEVER_ABORTS,
        onUpdate: (update) => {
          if (isAborted(options.signal)) return;
          options.onUpdate?.(update);
        },
      });
      const normalized = normalizeToolResult(coerceToolResult(result, call.name));
      return {
        ...normalized,
        description: execution.description ?? normalized.description,
        display: execution.display ?? normalized.display,
        approvalRule: execution.approvalRule,
        stopBatchAfterThis: execution.stopBatchAfterThis ?? normalized.stopBatchAfterThis,
      };
    } catch (error) {
      if (isAbortError(error) || isAborted(options.signal)) {
        return abortedToolResult(call.name, options.signal);
      }
      return {
        output: `Tool "${call.name}" failed: ${errorMessage(error)}`,
        isError: true,
      };
    }
  }
}

function coerceToolResult(value: unknown, toolName: string): ToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  const result = value as ToolResult | ExecutableToolResult;
  return { ...result, output: result.output };
}

function normalizeToolResult(result: ToolResult): ToolResult {
  let output: ToolResult['output'];
  if (typeof result.output === 'string') {
    output = result.output.length > 0 ? result.output : TOOL_OUTPUT_EMPTY;
  } else if (result.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = result.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = result.output.some(
        (part) => part.type === 'text' && part.text.length > 0,
      );
      output = hasNonEmptyText
        ? result.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...result.output];
    } else {
      const textJoined = result.output
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  if (result.isError === true) {
    return { output, isError: true };
  }
  return { output };
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

function abortedToolResult(toolName: string, signal: AbortSignal | undefined): ToolResult {
  if (signal !== undefined && isUserCancellation(signal.reason)) {
    return {
      output: `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`,
      isError: true,
    };
  }
  return {
    output: `Tool "${toolName}" was aborted`,
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

registerSingleton(IToolExecutor, new SyncDescriptor(ToolExecutorService, [], true));
