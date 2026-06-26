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

  it('throws when next() is called more than once', async () => {
    const slot = new OrderedHookSlot<Record<string, never>>();
    slot.register('a', async (_ctx, next) => {
      await next();
      await next();
    });
    await expect(slot.run({})).rejects.toThrow(/next\(\) cannot be called more than once/);
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
