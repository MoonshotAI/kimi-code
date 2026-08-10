import type { ContentPart, ToolCall } from '#/message';
import type { Tool } from '#/tool';
import {
  compileArgsValidator,
  validateArgs,
  type ArgsValidator,
  type JsonValue,
} from './args-validator';

/**
 * Test-only fixtures that emulate an agent tool-runtime layer on top of
 * kosong's wire types. These were previously exposed by `kosong/src` but
 * have no production consumers — the real tool runtime lives in
 * `@moonshot-ai/agent-core`. Kosong's own e2e tests still need a minimal
 * Toolset implementation to drive `generate()` through multi-turn flows.
 */

export interface BriefDisplayBlock {
  type: 'brief';
  text: string;
}

export interface UnknownDisplayBlock {
  type: string;
  data: Record<string, unknown>;
}

export type DisplayBlock = BriefDisplayBlock | UnknownDisplayBlock;

export interface ToolReturnValue {
  isError: boolean;
  output: string | ContentPart[];
  message: string;
  display: DisplayBlock[];
}

export interface ToolResult {
  toolCallId: string;
  returnValue: ToolReturnValue;
}

export interface Toolset {
  readonly tools: Tool[];
  handle(toolCall: ToolCall, options?: { signal?: AbortSignal }): Promise<ToolResult> | ToolResult;
}

function normalizeOutput(output: string | ContentPart | ContentPart[]): string | ContentPart[] {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output;
  return [output];
}

export function toolOk(opts: {
  output: string | ContentPart | ContentPart[];
  message?: string;
  brief?: string;
}): ToolReturnValue {
  const display: DisplayBlock[] = [];
  if (opts.brief) display.push({ type: 'brief', text: opts.brief });
  return {
    isError: false,
    output: normalizeOutput(opts.output),
    message: opts.message ?? '',
    display,
  };
}

export function toolError(opts: {
  message: string;
  brief: string;
  output?: string | ContentPart | ContentPart[];
}): ToolReturnValue {
  return {
    isError: true,
    output: opts.output !== undefined ? normalizeOutput(opts.output) : '',
    message: opts.message,
    display: [{ type: 'brief', text: opts.brief }],
  };
}

export function toolNotFoundError(toolName: string): ToolReturnValue {
  const message = `Tool \`${toolName}\` not found`;
  return {
    isError: true,
    output: '',
    message,
    display: [{ type: 'brief', text: message }],
  };
}

export function toolParseError(message: string): ToolReturnValue {
  const toolMessage = `Error parsing JSON arguments: ${message}`;
  return {
    isError: true,
    output: '',
    message: toolMessage,
    display: [{ type: 'brief', text: 'Invalid arguments' }],
  };
}

export function toolValidateError(message: string): ToolReturnValue {
  const toolMessage = `Error validating JSON arguments: ${message}`;
  return {
    isError: true,
    output: '',
    message: toolMessage,
    display: [{ type: 'brief', text: 'Invalid arguments' }],
  };
}

export function toolRuntimeError(message: string): ToolReturnValue {
  const toolMessage = `Error running tool: ${message}`;
  return {
    isError: true,
    output: '',
    message: toolMessage,
    display: [{ type: 'brief', text: 'Tool runtime error' }],
  };
}

export type ToolHandler = (args: JsonValue) => Promise<ToolReturnValue>;

interface ToolEntry {
  tool: Tool;
  handler: ToolHandler;
  validator: ArgsValidator;
}

export class SimpleToolset implements Toolset {
  private readonly toolMap: Map<string, ToolEntry> = new Map();

  get tools(): Tool[] {
    return [...this.toolMap.values()].map((entry) => entry.tool);
  }

  add(tool: Tool, handler: ToolHandler): void {
    this.toolMap.set(tool.name, {
      tool,
      handler,
      validator: compileArgsValidator(tool.parameters),
    });
  }

  remove(name: string): void {
    if (!this.toolMap.has(name)) {
      throw new Error(`Tool \`${name}\` not found in the toolset.`);
    }
    this.toolMap.delete(name);
  }

  handle(toolCall: ToolCall, _options?: { signal?: AbortSignal }): Promise<ToolResult> {
    const entry = this.toolMap.get(toolCall.name);
    if (entry === undefined) {
      return Promise.resolve({
        toolCallId: toolCall.id,
        returnValue: toolNotFoundError(toolCall.name),
      });
    }

    let args: JsonValue;
    try {
      args = JSON.parse(toolCall.arguments ?? '{}') as JsonValue;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return Promise.resolve({
        toolCallId: toolCall.id,
        returnValue: toolParseError(msg),
      });
    }

    const validationError = validateArgs(entry.validator, args);
    if (validationError !== null) {
      return Promise.resolve({
        toolCallId: toolCall.id,
        returnValue: toolValidateError(validationError),
      });
    }

    return (async (): Promise<ToolResult> => {
      try {
        const returnValue = await entry.handler(args);
        return { toolCallId: toolCall.id, returnValue };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { toolCallId: toolCall.id, returnValue: toolRuntimeError(msg) };
      }
    })();
  }
}
