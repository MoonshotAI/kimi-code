import { ToolAccesses } from '../../../src/loop/index';
import type {
  ExecutableTool,
  ExecutableToolResult,
  ToolExecution,
  ToolUpdate,
} from '../../../src/loop/index';

const RECORD_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
};

const TEXT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

const STRICT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: { value: { type: 'number' } },
  required: ['value'],
  additionalProperties: false,
};

export interface RecordedToolCall<Input> {
  readonly id: string;
  readonly args: Input;
  readonly turnId: string;
}

export function markReadFileAccesses<T extends ExecutableTool>(tool: T): T {
  const resolveExecution = tool.resolveExecution.bind(tool);
  tool.resolveExecution = (async (input: unknown) => {
    const execution = await resolveExecution(input);
    return { ...execution, accesses: ToolAccesses.readFile(`/test/${tool.name}`) };
  }) as T['resolveExecution'];
  return tool;
}

export interface EchoInput {
  text: string;
}

export class EchoTool implements ExecutableTool<EchoInput> {
  readonly name = 'echo';
  readonly description = 'Return the input text unchanged.';
  readonly parameters = TEXT_PARAMETERS;
  readonly calls: RecordedToolCall<EchoInput>[] = [];

  resolveExecution(args: EchoInput): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args,
          turnId: ctx.turnId,
        });
        return { output: args.text };
      },
    };
  }
}

export type FailingInput = Record<string, unknown>;

export class FailingTool implements ExecutableTool<FailingInput> {
  readonly name = 'fail';
  readonly description = 'Always throws.';
  readonly parameters = RECORD_PARAMETERS;
  readonly calls: RecordedToolCall<FailingInput>[] = [];
  readonly errorMessage: string;

  constructor(errorMessage = 'tool blew up') {
    this.errorMessage = errorMessage;
  }

  resolveExecution(args: FailingInput): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args,
          turnId: ctx.turnId,
        });
        throw new Error(this.errorMessage);
      },
    };
  }
}

export type SlowInput = Record<string, unknown>;

/**
 * Awaits the abort signal forever. Useful for asserting abort propagation
 * during tool execution. Throws an AbortError once aborted.
 */
export class SlowTool implements ExecutableTool<SlowInput> {
  readonly name = 'slow';
  readonly description = 'Blocks until aborted.';
  readonly parameters = RECORD_PARAMETERS;
  readonly calls: RecordedToolCall<SlowInput>[] = [];
  readonly started: { resolve: () => void; promise: Promise<void> };

  constructor() {
    let resolveStart: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    this.started = { resolve: resolveStart, promise: startedPromise };
  }

  resolveExecution(args: SlowInput): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args,
          turnId: ctx.turnId,
        });
        this.started.resolve();
        return new Promise<ExecutableToolResult>((_resolve, reject) => {
          const onAbort = (): void => {
            ctx.signal.removeEventListener('abort', onAbort);
            const err = new Error('slow tool cancelled');
            err.name = 'AbortError';
            reject(err);
          };
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener('abort', onAbort);
        });
      },
    };
  }
}

/**
 * Ignores abort signals entirely. Combined with the loop's grace timeout this
 * exercises the "tool refuses to cancel" code path. The promise never
 * settles on its own.
 */
export class HangingTool implements ExecutableTool<Record<string, unknown>> {
  readonly name = 'hang';
  readonly description = 'Never settles, ignores abort.';
  readonly parameters = RECORD_PARAMETERS;
  readonly calls: RecordedToolCall<Record<string, unknown>>[] = [];

  resolveExecution(args: Record<string, unknown>): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args,
          turnId: ctx.turnId,
        });
        return new Promise<ExecutableToolResult>(() => {
          // never resolve, never reject
        });
      },
    };
  }
}

export type ProgressInput = Record<string, unknown>;

export class ProgressTool implements ExecutableTool<ProgressInput> {
  readonly name = 'progress';
  readonly description = 'Streams a few progress updates before returning.';
  readonly parameters = RECORD_PARAMETERS;
  readonly calls: RecordedToolCall<ProgressInput>[] = [];
  readonly updates: ToolUpdate[];

  constructor(
    updates: ToolUpdate[] = [
      { kind: 'stdout', text: 'working...' },
      { kind: 'progress', percent: 50 },
    ],
  ) {
    this.updates = updates;
  }

  resolveExecution(args: ProgressInput): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args,
          turnId: ctx.turnId,
        });
        for (const update of this.updates) ctx.onUpdate?.(update);
        return { output: 'done' };
      },
    };
  }
}

export interface StrictInput {
  value: number;
}

export class StrictArgsTool implements ExecutableTool<StrictInput> {
  readonly name = 'strict';
  readonly description = 'Requires { value: number }.';
  readonly parameters = STRICT_PARAMETERS;
  readonly calls: RecordedToolCall<StrictInput>[] = [];

  resolveExecution(args: StrictInput): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args,
          turnId: ctx.turnId,
        });
        return { output: `value=${String(args.value)}` };
      },
    };
  }
}

/**
 * A tool whose result is a content-block array. Useful for exercising
 * media-aware tool-result persistence in the loop.
 */
export class ContentBlocksTool implements ExecutableTool<Record<string, unknown>> {
  readonly name = 'blocks';
  readonly description = 'Returns a structured ExecutableToolResult.';
  readonly parameters = RECORD_PARAMETERS;
  readonly calls: RecordedToolCall<Record<string, unknown>>[] = [];
  readonly result: ExecutableToolResult;

  constructor(result: ExecutableToolResult) {
    this.result = result;
  }

  resolveExecution(args: Record<string, unknown>): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args,
          turnId: ctx.turnId,
        });
        return this.result;
      },
    };
  }
}

/**
 * A tool that signals when its execute starts and resolves only after
 * `release()` is called. Useful for orchestrating concurrent execution
 * tests deterministically.
 */
export class GatedTool implements ExecutableTool<Record<string, unknown>> {
  readonly name: string;
  readonly description = 'Waits for an external release signal.';
  readonly parameters = RECORD_PARAMETERS;
  readonly calls: RecordedToolCall<Record<string, unknown>>[] = [];
  readonly started: Promise<void>;

  private resolveStarted: () => void = () => {};
  private gate: Promise<void>;
  private resolveGate: () => void = () => {};

  constructor(name = 'gated') {
    this.name = name;
    this.started = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.resolveGate = resolve;
    });
  }

  release(): void {
    this.resolveGate();
  }

  resolveExecution(args: Record<string, unknown>): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async (ctx): Promise<ExecutableToolResult> => {
        this.calls.push({
          id: ctx.toolCallId,
          args,
          turnId: ctx.turnId,
        });
        this.resolveStarted();
        await this.gate;
        return { output: `${this.name} done` };
      },
    };
  }
}
