import type { ILogService } from '#/_base/log/log';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ToolCall } from '#/kosong/contract/message';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '#/tool/args-validator';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import type {
  ExecutableTool,
  RunnableToolExecution,
  ToolExecution,
} from '#/tool/toolContract';

import type {
  MissingToolDescriber,
  ToolCallGuard,
  ToolExecutorExecuteOptions,
  UnavailableToolDescriber,
} from '../toolExecutor';
import type { ResolvedToolExecutionHookContext } from '../toolHooks';

export interface RunnableToolCall {
  readonly kind: 'runnable';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

export interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

export type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

export type ToolCallDisplayFields = { description?: string | undefined; display?: ToolInputDisplay | undefined };

const validators = new WeakMap<
  ExecutableTool,
  { schema: Record<string, unknown>; validator: ToolArgsValidator }
>();

export function buildBeforeExecuteContext(
  call: RunnableToolCall,
  execution: RunnableToolExecution,
  allCalls: readonly ToolCall[],
  options: ToolExecutorExecuteOptions,
): ResolvedToolExecutionHookContext {
  return {
    turnId: options.turnId,
    signal: options.signal,
    trace: options.trace,
    toolCall: call.toolCall,
    toolCalls: allCalls,
    tool: call.tool,
    args: call.args,
    execution,
  };
}

export function preflightToolCall(
  toolRegistry: IAgentToolRegistryService,
  toolCall: ToolCall,
  guard: ToolCallGuard | undefined,
  describeUnavailableTool: UnavailableToolDescriber | undefined,
  describeMissingTool: MissingToolDescriber | undefined,
  log?: ILogService,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  if (parsedArgs.parseFailed) {
    log?.debug('tool args JSON parse failed', {
      toolName,
      toolCallId: toolCall.id,
      rawLength: typeof toolCall.arguments === 'string' ? toolCall.arguments.length : 0,
      error: parsedArgs.error,
    });
  }
  const tool = toolRegistry.resolve(toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: describeMissingTool?.(toolName) ?? `Tool "${toolName}" not found`,
    };
  }
  const source = toolRegistry.list().find((entry) => entry.name === toolName)?.source ?? 'builtin';
  const denied = guard?.({ name: toolName, source });
  if (denied !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: denied,
    };
  }
  const unavailable = describeUnavailableTool?.(toolName);
  if (unavailable !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: unavailable,
    };
  }
  const validationError = validateExecutableToolArgs(tool, parsedArgs.data);
  if (validationError !== null) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Invalid args for tool "${toolName}": ${validationError}`,
    };
  }
  return { kind: 'runnable', toolCall, toolName, tool, args: parsedArgs.data };
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): string | null {
  const schema = tool.parameters;
  let cached = validators.get(tool);
  if (cached === undefined || cached.schema !== schema) {
    try {
      cached = { schema, validator: compileToolArgsValidator(schema) };
      validators.set(tool, cached);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(cached.validator, args as JsonType);
}

export function toolCallDisplayFieldsFromExecution(
  execution: ToolExecution,
): ToolCallDisplayFields | undefined {
  if (execution.isError === true) return undefined;
  const description = execution.description;
  const display = execution.display;
  return {
    description: description !== undefined && description.length > 0 ? description : undefined,
    display,
  };
}
