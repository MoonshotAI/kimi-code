import type {
  ExecutorPolicy,
  RegisterOptions,
  ToolDefinition,
  ToolExecuteInput,
  ToolExecutorHost,
  ToolHandler,
  ToolResult,
} from './contract';
import { truncateResult, unavailableTool, unknownTool } from './policy';

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
      const limit = maxResultChars;
      const name = input.toolCall.name;
      const slot = slots.get(name);
      if (slot === undefined) return unknownTool(name);
      if (slot.status === 'invalid') return unavailableTool(name, slot.reason ?? '');
      slot.inflight += 1;
      try {
        const result = await slot.handler.execute(input);
        return truncateResult(result, limit);
      } finally {
        slot.inflight -= 1;
        release(slot);
      }
    },
  };
}
