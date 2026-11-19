// Core hook 组合契约；不包含 Issue #4439 的配置 regex matcher，也不包含 loop 调度。
import { describe, expect, it, vi } from 'vitest';

import { composeToolExecutorHooks } from '#/tool/hook-composer';
import { textToolContent } from '#/tool/tool-executor';
import type {
  ToolDecisionContext,
  ToolExecutionEvent,
  ToolResult,
} from '#/tool/types';

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

describe('composeToolExecutorHooks', () => {
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
    const composed = composeToolExecutorHooks([first, second]);
    expect(composed.validating?.(decisionContext({ initial: true }))).toEqual({
      args: { first: 1, second: 2 },
    });
  });

  it('stops validating and starting at the first rejection', async () => {
    const laterValidating = vi.fn();
    const laterStarting = vi.fn();
    const rejected = composeToolExecutorHooks([
      { validating: () => ({ reject: 'validation denied' }) },
      { validating: laterValidating },
    ]);
    expect(rejected.validating?.(decisionContext({}))).toEqual({ reject: 'validation denied' });
    expect(laterValidating).not.toHaveBeenCalled();

    const startingRejected = composeToolExecutorHooks([
      { starting: () => ({ reject: 'starting denied' }) },
      { starting: laterStarting },
    ]);
    await expect(startingRejected.starting?.(decisionContext({}))).resolves.toEqual({
      reject: 'starting denied',
    });
    expect(laterStarting).not.toHaveBeenCalled();
  });

  it('combines starting rewrites with skipPermitting', async () => {
    const composed = composeToolExecutorHooks([
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
    const composed = composeToolExecutorHooks([
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
    const composed = composeToolExecutorHooks([
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
    const composed = composeToolExecutorHooks([
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
    const composed = composeToolExecutorHooks([
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

  it('returns no decisions and the original result when no hooks make changes', async () => {
    const composed = composeToolExecutorHooks([]);
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
  });

});

describe('As a policy author, I want partially implemented hooks to be optional so that composed policies only act on decisions they understand', () => {
  it('skips missing validating hooks and undefined validating decisions', () => {
    const later = vi.fn(() => ({ args: { validated: true } }));
    const composed = composeToolExecutorHooks([
      {},
      { validating: () => undefined },
      { validating: later },
    ]);

    expect(composed.validating?.(decisionContext({}))).toEqual({ args: { validated: true } });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('skips missing starting hooks and undefined starting decisions', async () => {
    const later = vi.fn(() => ({ args: { started: true } }));
    const composed = composeToolExecutorHooks([
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
    const composed = composeToolExecutorHooks([
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
    const composed = composeToolExecutorHooks([
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
    const composed = composeToolExecutorHooks([
      { starting: () => ({ skipPermitting: true }) },
    ]);

    await expect(composed.starting?.(decisionContext({ initial: true }))).resolves.toEqual({
      skipPermitting: true,
    });
  });

  it('returns starting args when no hook skips permitting', async () => {
    const composed = composeToolExecutorHooks([
      { starting: () => ({ args: { rewritten: true } }) },
      { starting: () => undefined },
    ]);

    await expect(composed.starting?.(decisionContext({}))).resolves.toEqual({
      args: { rewritten: true },
    });
  });

  it('returns permitting args after all hooks decline to reject', async () => {
    const composed = composeToolExecutorHooks([
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
