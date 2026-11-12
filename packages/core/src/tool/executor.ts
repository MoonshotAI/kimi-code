/**
 * `createToolExecutor`: a name-keyed tool registry that runs the starting and permitting hooks,
 * dispatches the call to its handler, runs the ending hooks, and appends hook notes and truncates the
 * result. Tools can be invalidated, restored, or replaced while calls are in flight.
 */
import { errorText } from '#/llm/protocol/errors';

import {
  isToolResult,
  type ExecutorPolicy,
  type RegisterOptions,
  type ToolDefinition,
  type ToolExecuteInput,
  type ToolExecutorHost,
  type ToolHandler,
  type ToolHookFailure,
  type ToolHookPoint,
  type ToolResult,
} from './contract';
import {
  createToolHookRegistry,
  runToolEnding,
  runToolPermitting,
  runToolStarting,
  toolHookFailureText,
} from './hooks';
import { toolError, truncateResult, unavailableTool, unknownTool, withNotes } from './policy';

export { isToolExecutorHost, isToolResult } from './contract';
export type {
  ExecutorPolicy,
  RegisterOptions,
  TaskWaitInput,
  TaskWaitOutcome,
  ToolDetachAck,
  ToolDetachInput,
  ToolEndingDecision,
  ToolEndingHookEvent,
  ToolExecuteInput,
  ToolExecutor,
  ToolExecutorHooks,
  ToolExecutorHost,
  ToolHandler,
  ToolHookFailure,
  ToolHookFailurePolicy,
  ToolHookInfo,
  ToolHookPoint,
  ToolHookRegistration,
  ToolHooks,
  ToolPermittingDecision,
  ToolPermittingHookEvent,
  ToolResult,
  ToolSchema,
  ToolStartingDecision,
  ToolStartingHookEvent,
  ToolUpdate,
  TypedToolInput,
} from './contract';

interface Slot {
  handler: ToolHandler;
  status: 'ready' | 'invalid';
  reason?: string;
  inflight: number;
  retired: boolean;
  released: boolean;
  onIdle?: () => void;
}

export interface CreateToolExecutorOptions {
  readonly policy?: ExecutorPolicy;
}

class ToolExecutionError extends Error {
  readonly original: unknown;
  readonly result: ToolResult;

  constructor(error: unknown, result: ToolResult) {
    super(errorText(error), { cause: error });
    this.name = 'ToolExecutionError';
    this.original = error;
    this.result = result;
  }
}

export function toolExecutionFailureOf(error: unknown): { error: unknown; result: ToolResult } | undefined {
  return error instanceof ToolExecutionError ? { error: error.original, result: error.result } : undefined;
}

function assertName(name: string): void {
  if (name === '') throw new TypeError('tool name must be a non-empty string');
}

function isHandler(value: object): value is ToolHandler {
  return 'execute' in value && typeof value.execute === 'function';
}

function release(slot: Slot): void {
  if (!slot.retired || slot.inflight !== 0 || slot.released) return;
  slot.released = true;
  slot.onIdle?.();
}

export function createToolExecutor(options: CreateToolExecutorOptions = {}): ToolExecutorHost {
  const maxResultChars = options.policy?.maxResultChars;
  if (maxResultChars !== undefined && (!Number.isSafeInteger(maxResultChars) || maxResultChars < 0)) {
    throw new TypeError('maxResultChars must be a non-negative integer');
  }
  const slots = new Map<string, Slot>();
  const hooks = createToolHookRegistry();

  const bind = (name: string, handler: ToolHandler, registerOptions?: RegisterOptions): (() => void) => {
    assertName(name);
    if (typeof handler.execute !== 'function') throw new TypeError('tool handler must have an execute function');
    const previous = slots.get(name);
    if (previous !== undefined) {
      previous.retired = true;
      release(previous);
    }
    const slot: Slot = {
      handler,
      status: 'ready',
      inflight: 0,
      retired: false,
      released: false,
      ...(registerOptions?.onIdle === undefined ? {} : { onIdle: registerOptions.onIdle }),
    };
    slots.set(name, slot);
    return () => {
      if (slots.get(name) !== slot) return;
      slots.delete(name);
      slot.retired = true;
      release(slot);
    };
  };

  const register = (
    nameOrDefinition: string | ToolDefinition,
    handlerOrOptions?: ToolHandler | RegisterOptions,
    registerOptions?: RegisterOptions,
  ): (() => void) => {
    if (typeof nameOrDefinition === 'string') {
      if (handlerOrOptions === undefined || !isHandler(handlerOrOptions)) {
        throw new TypeError('tool handler is required');
      }
      return bind(nameOrDefinition, handlerOrOptions, registerOptions);
    }
    if (handlerOrOptions !== undefined && isHandler(handlerOrOptions)) {
      throw new TypeError('registering a tool definition does not take a handler');
    }
    return bind(nameOrDefinition.name, nameOrDefinition, handlerOrOptions);
  };

  return {
    hooks: {
      add: (registration) => hooks.add(registration),
      remove: (id) => hooks.remove(id),
      list: () => hooks.list(),
    },
    register: register as ToolExecutorHost['register'],
    invalidate(name, reason) {
      if (typeof reason !== 'string') throw new TypeError('invalidate reason must be a string');
      const slot = slots.get(name);
      if (slot === undefined) return;
      slot.status = 'invalid';
      slot.reason = reason;
    },
    restore(name) {
      const slot = slots.get(name);
      if (slot === undefined || slot.status !== 'invalid') return;
      slot.status = 'ready';
      delete slot.reason;
    },
    async execute(input: ToolExecuteInput): Promise<ToolResult> {
      const notes: string[] = [];
      const report = (point: ToolHookPoint, failures: readonly ToolHookFailure[]): void => {
        for (const failure of failures) {
          if (!failure.blocking) notes.push(toolHookFailureText(point, failure.error));
          if (failure.paused && failure.hookId !== undefined) hooks.suspend(failure.hookId);
          input.onHookFailure?.(point, failure);
        }
      };
      const settle = (result: ToolResult): ToolResult => truncateResult(withNotes(result, notes), maxResultChars);
      const finish = async (result: ToolResult, failed: boolean, toolCall: ToolExecuteInput['toolCall']) => {
        const ending = await runToolEnding(
          hooks,
          {
            toolCall,
            result,
            failed,
            turnId: input.turnId,
            step: input.step,
            signal: input.signal,
          },
          input.signal,
        );
        report('tool.ending', ending.failures);
        const final = ending.blocked === undefined
          ? ending.result
          : { ...ending.result, isError: true, blocked: ending.blocked };
        return settle(final);
      };

      const starting =
        hooks.active('tool.starting').length === 0
          ? { toolCall: input.toolCall, failures: [] }
          : await runToolStarting(
              hooks,
              {
                toolCall: input.toolCall,
                turnId: input.turnId,
                step: input.step,
                signal: input.signal,
              },
              input.signal,
            );
      report('tool.starting', starting.failures);
      let toolCall = starting.toolCall;
      let blocked = starting.blocked;
      let blockedResult = starting.result;
      if (blocked === undefined && starting.skipPermitting !== true && hooks.active('tool.permitting').length > 0) {
        const permitting = await runToolPermitting(
          hooks,
          {
            toolCall,
            turnId: input.turnId,
            step: input.step,
            signal: input.signal,
          },
          input.signal,
        );
        report('tool.permitting', permitting.failures);
        toolCall = permitting.toolCall;
        blocked = permitting.blocked;
        blockedResult = permitting.result;
      }
      input.onAdjudicated?.(toolCall, blocked);
      if (blocked !== undefined) {
        return settle({
          ...(blockedResult ?? toolError(blocked.message ?? blocked.reason)),
          isError: true,
          blocked,
        });
      }

      const slot = slots.get(toolCall.name);
      if (slot === undefined) return finish(unknownTool(toolCall.name), false, toolCall);
      if (slot.status === 'invalid') {
        return finish(unavailableTool(toolCall.name, slot.reason ?? ''), false, toolCall);
      }

      let detached = false;
      let raw: unknown;
      let thrown: unknown;
      let didThrow = false;
      slot.inflight += 1;
      try {
        raw = await slot.handler.execute({
          ...input,
          toolCall,
          detach:
            input.detach === undefined
              ? undefined
              : (text) => {
                  detached = true;
                  input.detach?.(text);
                },
        });
      } catch (error) {
        didThrow = true;
        thrown = error;
      } finally {
        slot.inflight -= 1;
        release(slot);
      }

      if (didThrow) {
        if (input.signal.aborted) throw thrown;
        if (detached) throw thrown;
        const result = await finish(toolError(errorText(thrown)), true, toolCall);
        throw new ToolExecutionError(thrown, result);
      }
      if (!isToolResult(raw)) {
        const error = new Error('invalid tool result');
        if (detached) throw error;
        const result = await finish(toolError(errorText(error)), true, toolCall);
        throw new ToolExecutionError(error, result);
      }
      if (detached) return settle(raw);
      return finish(raw, false, toolCall);
    },
  };
}
