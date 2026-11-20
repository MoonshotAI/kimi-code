// Core hook 组合契约；不包含 Issue #4439 的配置 regex matcher，也不包含 loop 调度。
import { describe, expect, it, vi } from 'vitest';

import { createToolExecutorHookRegistry } from '#/hook/tool-executor/registry';
import { textToolContent } from '#/tool/tool-executor';
import type {
  ToolDecisionContext,
  ToolExecutionEvent,
  ToolExecutorHook,
  ToolResult,
} from '#/tool/types';

function registeredToolExecutorHook(hooks: readonly ToolExecutorHook[]): ToolExecutorHook {
  const registry = createToolExecutorHookRegistry();
  for (const hook of hooks) {
    if (hook.validating !== undefined) registry.addToolHook({ point: 'validating', hook: hook.validating.bind(hook) });
    if (hook.starting !== undefined) registry.addToolHook({ point: 'starting', hook: hook.starting.bind(hook) });
    if (hook.permitting !== undefined) registry.addToolHook({ point: 'permitting', hook: hook.permitting.bind(hook) });
    if (hook.beforeExecute !== undefined) {
      registry.addToolHook({ point: 'beforeExecute', hook: hook.beforeExecute.bind(hook) });
    }
    if (hook.afterExecute !== undefined) {
      registry.addToolHook({ point: 'afterExecute', hook: hook.afterExecute.bind(hook) });
    }
    if (hook.observe !== undefined) registry.addToolHook({ point: 'observe', hook: hook.observe.bind(hook) });
  }
  return registry.hook;
}

function decisionContext(args: unknown): ToolDecisionContext {
  return {
    call: { type: 'function', id: 'call-1', name: 'tool', arguments: JSON.stringify(args) },
    taskId: 'task-1',
    args,
    context: undefined,
    signal: new AbortController().signal,
    prepared: undefined,
  };
}

function successResult(text = 'raw'): ToolResult {
  return {
    toolCallId: 'call-1',
    content: textToolContent(text),
    outcome: { type: 'success' },
  };
}

describe('createToolExecutorHookRegistry', () => {
  it('chains validating rewrites in order and preserves hook this binding', () => {
    const first = {
      label: 'first',
      validating() {
        expect(this.label).toBe('first');
        return { args: { first: 1 } };
      },
    };
    const second = {
      label: 'second',
      validating(context: ToolDecisionContext) {
        expect(this.label).toBe('second');
        expect(context.args).toEqual({ first: 1 });
        return { args: { first: 1, second: 2 } };
      },
    };
    const composed = registeredToolExecutorHook([first, second]);
    expect(composed.validating?.(decisionContext({ initial: true }))).toEqual({
      args: { first: 1, second: 2 },
    });
  });

  it('stops validating and starting at the first rejection', async () => {
    const laterValidating = vi.fn();
    const laterStarting = vi.fn();
    const rejected = registeredToolExecutorHook([
      { validating: () => ({ reject: 'validation denied' }) },
      { validating: laterValidating },
    ]);
    expect(rejected.validating?.(decisionContext({}))).toEqual({ reject: 'validation denied' });
    expect(laterValidating).not.toHaveBeenCalled();

    const startingRejected = registeredToolExecutorHook([
      { starting: () => ({ reject: 'starting denied' }) },
      { starting: laterStarting },
    ]);
    await expect(startingRejected.starting?.(decisionContext({}))).resolves.toEqual({
      reject: 'starting denied',
    });
    expect(laterStarting).not.toHaveBeenCalled();
  });

  it('combines starting rewrites with skipPermitting', async () => {
    const composed = registeredToolExecutorHook([
      { starting: () => ({ args: { rewritten: true } }) },
      {
        starting: (context) => {
          expect(context.args).toEqual({ rewritten: true });
          return { skipPermitting: true };
        },
      },
    ]);
    await expect(composed.starting?.(decisionContext({}))).resolves.toEqual({
      skipPermitting: true,
      args: { rewritten: true },
    });
  });

  // 来源：Issue #437 / #4437 的 executor 决策子集，只验证拒绝和改写，不断言权限服务存储或规则匹配。
  // https://github.com/MoonshotAI/kimi-code/issues/437
  // https://github.com/MoonshotAI/kimi-code/issues/4437
  it('chains permitting rewrites until a rejection and skips later hooks', async () => {
    const later = vi.fn();
    const composed = registeredToolExecutorHook([
      { permitting: () => ({ args: { first: true } }) },
      {
        permitting: (context) => {
          expect(context.args).toEqual({ first: true });
          return { reject: 'permission denied' };
        },
      },
      { permitting: later },
    ]);
    await expect(composed.permitting?.(decisionContext({}))).resolves.toEqual({
      reject: 'permission denied',
    });
    expect(later).not.toHaveBeenCalled();
  });

  it('awaits beforeExecute hooks in registration order', async () => {
    const events: string[] = [];
    const composed = registeredToolExecutorHook([
      {
        beforeExecute: async () => {
          await Promise.resolve();
          events.push('first');
        },
      },
      {
        beforeExecute: () => {
          events.push('second');
        },
      },
    ]);
    await composed.beforeExecute?.(decisionContext({}));
    expect(events).toEqual(['first', 'second']);
  });

  it('feeds each afterExecute replacement into the next hook', async () => {
    const context = {
      ...decisionContext({}),
      fields: {},
      result: successResult(),
      set: () => {},
    };
    const composed = registeredToolExecutorHook([
      {
        afterExecute: () => ({
          ...successResult('first'),
        }),
      },
      {
        afterExecute: (current) => {
          expect(current.result.content).toEqual(textToolContent('first'));
          return { ...current.result, content: textToolContent('second') };
        },
      },
    ]);
    const replaced = await composed.afterExecute?.(context);
    expect(replaced?.content).toEqual(textToolContent('second'));
  });

  it('isolates observe failures and continues with the remaining hooks', () => {
    const second = vi.fn();
    const composed = registeredToolExecutorHook([
      {
        observe: () => {
          throw new Error('observer failed');
        },
      },
      { observe: second },
    ]);
    const event = { type: 'created' } as ToolExecutionEvent;
    expect(() => composed.observe?.(event)).not.toThrow();
    expect(second).toHaveBeenCalledWith(event);
  });

  it('returns no decisions without rewrites and supports nonblocking registrations', async () => {
    const composed = registeredToolExecutorHook([]);
    const context = decisionContext({});
    const result = successResult();
    expect(composed.validating?.(context)).toBeUndefined();
    await expect(composed.starting?.(context)).resolves.toBeUndefined();
    await expect(composed.permitting?.(context)).resolves.toBeUndefined();
    await expect(composed.afterExecute?.({
      ...context,
      fields: {},
      result,
      set: () => {},
    })).resolves.toBe(result);

    const registry = createToolExecutorHookRegistry();
    const events: string[] = [];
    const lifecycle: { type: string; hookId: string; point: string }[] = [];
    registry.subscribe((event) => lifecycle.push(event));
    let release = (): void => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.addToolHook({
      point: 'starting',
      id: 'observer',
      blocking: false,
      hook: async () => {
        events.push('nonblocking');
        await waiting;
      },
    });
    registry.addToolHook({
      point: 'starting',
      id: 'failed',
      blocking: false,
      hook: () => {
        throw new Error('observer failed');
      },
    });
    registry.addToolHook({
      point: 'starting',
      id: 'blocking',
      hook: () => {
        events.push('blocking');
        return { args: { rewritten: true } };
      },
    });
    await expect(registry.hook.starting?.(context)).resolves.toEqual({ args: { rewritten: true } });
    expect(events).toEqual(['nonblocking', 'blocking']);
    expect(registry.list()).toEqual([
      { id: 'observer', point: 'starting', onFailure: 'pause', paused: false, mode: 'nonblocking' },
      { id: 'failed', point: 'starting', onFailure: 'pause', paused: true, mode: 'nonblocking' },
      { id: 'blocking', point: 'starting', onFailure: 'pause', paused: false, mode: 'blocking' },
    ]);
    expect(lifecycle).toEqual([
      { type: 'hook.added', hookId: 'observer', point: 'starting', mode: 'nonblocking' },
      { type: 'hook.added', hookId: 'failed', point: 'starting', mode: 'nonblocking' },
      { type: 'hook.added', hookId: 'blocking', point: 'starting', mode: 'blocking' },
      { type: 'hook.paused', hookId: 'failed', point: 'starting', reason: 'failed' },
      {
        type: 'hook.failed',
        hookId: 'failed',
        point: 'starting',
        error: new Error('observer failed'),
        paused: true,
        blocking: false,
        mode: 'nonblocking',
      },
    ]);
    expect(registry.pause('observer')).toBe(true);
    expect(registry.resume('observer')).toBe(true);
    expect(registry.remove('observer')).toBe(true);
    expect(lifecycle.slice(5)).toEqual([
      { type: 'hook.paused', hookId: 'observer', point: 'starting', reason: 'manual' },
      { type: 'hook.resumed', hookId: 'observer', point: 'starting' },
      { type: 'hook.removed', hookId: 'observer', point: 'starting', mode: 'nonblocking' },
    ]);
    release();
  });

});

describe('As a policy author, I want partially implemented hooks to be optional so that composed policies only act on decisions they understand', () => {
  it('skips missing validating hooks and undefined validating decisions', () => {
    const later = vi.fn(() => ({ args: { validated: true } }));
    const composed = registeredToolExecutorHook([
      {},
      { validating: () => undefined },
      { validating: later },
    ]);

    expect(composed.validating?.(decisionContext({}))).toEqual({ args: { validated: true } });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('skips missing starting hooks and undefined starting decisions', async () => {
    const later = vi.fn(() => ({ args: { started: true } }));
    const composed = registeredToolExecutorHook([
      {},
      { starting: () => undefined },
      { starting: later },
    ]);

    await expect(composed.starting?.(decisionContext({}))).resolves.toEqual({
      args: { started: true },
    });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('skips missing permitting hooks and undefined permitting decisions', async () => {
    const later = vi.fn(() => ({ args: { permitted: true } }));
    const composed = registeredToolExecutorHook([
      {},
      { permitting: () => undefined },
      { permitting: later },
    ]);

    await expect(composed.permitting?.(decisionContext({}))).resolves.toEqual({
      args: { permitted: true },
    });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('skips missing afterExecute hooks and preserves results through undefined replacements', async () => {
    const context = {
      ...decisionContext({}),
      fields: {},
      result: successResult(),
      set: () => {},
    };
    const composed = registeredToolExecutorHook([
      {},
      { afterExecute: () => undefined },
      {
        afterExecute: (current) => {
          expect(current.result.content).toEqual(textToolContent('raw'));
          return successResult('replaced');
        },
      },
    ]);

    await expect(composed.afterExecute?.(context)).resolves.toEqual(successResult('replaced'));
  });

});

describe('As a permission policy author, I want argument rewrites and skipPermitting to remain independent so that composed decisions do not add unintended behavior', () => {
  it('returns skipPermitting without args when no starting rewrite occurred', async () => {
    const composed = registeredToolExecutorHook([
      { starting: () => ({ skipPermitting: true }) },
    ]);

    await expect(composed.starting?.(decisionContext({ initial: true }))).resolves.toEqual({
      skipPermitting: true,
    });
  });

  it('returns starting args when no hook skips permitting', async () => {
    const composed = registeredToolExecutorHook([
      { starting: () => ({ args: { rewritten: true } }) },
      { starting: () => undefined },
    ]);

    await expect(composed.starting?.(decisionContext({}))).resolves.toEqual({
      args: { rewritten: true },
    });
  });

  it('returns permitting args after all hooks decline to reject', async () => {
    const composed = registeredToolExecutorHook([
      { permitting: () => ({ args: { first: true } }) },
      {
        permitting: (current) => {
          expect(current.args).toEqual({ first: true });
          return { args: { first: true, second: true } };
        },
      },
    ]);

    await expect(composed.permitting?.(decisionContext({}))).resolves.toEqual({
      args: { first: true, second: true },
    });
  });
});
