import { describe, expect, it } from 'vitest';

import { OrderedHookSlot, createHooks } from '#/hooks';

describe('OrderedHookSlot', () => {
  it('runs the terminal when no handlers are registered', async () => {
    const slot = new OrderedHookSlot<{ value: number }>();
    let terminalRan = false;
    await slot.run({ value: 0 }, async () => {
      terminalRan = true;
    });
    expect(terminalRan).toBe(true);
  });

  it('runs handlers in registration order and threads context', async () => {
    const slot = new OrderedHookSlot<{ value: number }>();
    const order: string[] = [];
    slot.register('a', async (ctx, next) => {
      order.push('a');
      ctx.value += 1;
      await next();
    });
    slot.register('b', async (ctx, next) => {
      order.push('b');
      ctx.value += 10;
      await next();
    });
    const ctx = { value: 0 };
    await slot.run(ctx);
    expect(order).toEqual(['a', 'b']);
    expect(ctx.value).toBe(11);
  });

  it('removes a handler with delete()', async () => {
    const slot = new OrderedHookSlot<Record<string, never>>();
    const order: string[] = [];
    slot.register('a', async (_ctx, next) => {
      order.push('a');
      await next();
    });
    slot.register('b', async (_ctx, next) => {
      order.push('b');
      await next();
    });
    expect(slot.delete('a')).toBe(true);
    await slot.run({});
    expect(order).toEqual(['b']);
  });

  it('honors before / after ordering', async () => {
    const slot = new OrderedHookSlot<Record<string, never>>();
    const order: string[] = [];
    const mk =
      (id: string) =>
      async (_ctx: Record<string, never>, next: () => Promise<void>) => {
        order.push(id);
        await next();
      };
    slot.register('a', mk('a'));
    slot.register('c', mk('c'));
    slot.register('b', mk('b'), { before: 'c' });
    await slot.run({});
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('re-runs the remaining chain when next() is called more than once', async () => {
    const slot = new OrderedHookSlot<Record<string, never>>();
    let terminalRuns = 0;
    slot.register('a', async (_ctx, next) => {
      await next();
      await next();
    });
    await slot.run({}, async () => {
      terminalRuns += 1;
    });
    expect(terminalRuns).toBe(2);
  });

  it('skips downstream handlers and the terminal when next() is not called', async () => {
    const slot = new OrderedHookSlot<{ value: number }>();
    const order: string[] = [];
    slot.register('veto', () => {
      order.push('veto');
    });
    slot.register('downstream', async (_ctx, next) => {
      order.push('downstream');
      await next();
    });
    let terminalRan = false;
    await slot.run({ value: 0 }, async () => {
      terminalRan = true;
    });
    expect(order).toEqual(['veto']);
    expect(terminalRan).toBe(false);
  });

  it('re-runs the remaining chain and terminal on each next() call', async () => {
    const slot = new OrderedHookSlot<{ attempt: number; result?: string }>();
    const attempts: number[] = [];
    slot.register('retry', async (ctx, next) => {
      ctx.attempt = 1;
      await next();
      if (ctx.result === 'fail') {
        ctx.attempt = 2;
        await next();
      }
    });
    slot.register('downstream', async (ctx, next) => {
      attempts.push(ctx.attempt);
      await next();
    });
    const ctx: { attempt: number; result?: string } = { attempt: 0 };
    await slot.run(ctx, async (current) => {
      current.result = current.attempt === 1 ? 'fail' : 'ok';
    });
    expect(attempts).toEqual([1, 2]);
    expect(ctx.result).toBe('ok');
  });

  it('resumes the remaining chain and terminal with a forked context', async () => {
    interface Ctx {
      readonly id: number;
      value: number;
      result?: number;
    }
    const slot = new OrderedHookSlot<Ctx>();
    const seen: number[] = [];
    slot.register('fork', async (ctx, next) => {
      const fork: Ctx = { ...ctx, value: 100 };
      await next(fork);
      ctx.result = fork.result;
    });
    slot.register('downstream', async (ctx, next) => {
      seen.push(ctx.value);
      await next();
    });
    const original: Ctx = { id: 1, value: 0 };
    await slot.run(original, async (current) => {
      current.result = current.value + 1;
    });
    expect(seen).toEqual([100]);
    expect(original.value).toBe(0);
    expect(original.result).toBe(101);
  });

  it('propagates a fork through nested next() calls without arguments', async () => {
    interface Ctx {
      value: number;
    }
    const slot = new OrderedHookSlot<Ctx>();
    slot.register('fork', async (ctx, next) => {
      await next({ ...ctx, value: 42 });
    });
    slot.register('middle', async (_ctx, next) => {
      await next();
    });
    let terminalValue: number | undefined;
    await slot.run({ value: 0 }, async (current) => {
      terminalValue = current.value;
    });
    expect(terminalValue).toBe(42);
  });

  it('runs forked branches concurrently', async () => {
    interface Ctx {
      input: number;
      output?: number;
    }
    const slot = new OrderedHookSlot<Ctx>();
    slot.register('race', async (ctx, next) => {
      const forks: Ctx[] = [
        { ...ctx, input: 1 },
        { ...ctx, input: 2 },
      ];
      await Promise.all(forks.map((fork) => next(fork)));
      ctx.output = Math.max(...forks.map((fork) => fork.output ?? 0));
    });
    const ctx: Ctx = { input: 0 };
    await slot.run(ctx, async (current) => {
      current.output = current.input * 10;
    });
    expect(ctx.output).toBe(20);
  });
});

describe('createHooks', () => {
  it('creates one slot per event key', () => {
    type HookEvents = { start: { x: number }; stop: { y: number } };
    const hooks = createHooks<HookEvents, keyof HookEvents>(['start', 'stop']);
    expect(hooks.start).toBeInstanceOf(OrderedHookSlot);
    expect(hooks.stop).toBeInstanceOf(OrderedHookSlot);
  });
});
