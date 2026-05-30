import { describe, expect, it, vi } from 'vitest';

import { createStallDetectionHook } from '../../../src/agent/swarm/stall-hook';
import type { ToolExecutionHookContext } from '../../../src/loop/index';

function makeCtx(name: string, args: unknown, id = 'call'): ToolExecutionHookContext {
  return {
    toolCall: { type: 'function', id, name, arguments: JSON.stringify(args) },
    args,
    turnId: 'turn-1',
    stepNumber: 1,
    signal: new AbortController().signal,
    // `llm` is unused by the stall hook; the cast keeps the fixture small.
  } as unknown as ToolExecutionHookContext;
}

describe('createStallDetectionHook', () => {
  it('blocks and fires onStall exactly once when the same call repeats >= threshold', async () => {
    const onStall = vi.fn();
    const hook = createStallDetectionHook({ repeatThreshold: 3, onStall });
    const prepare = hook.prepareToolExecution;
    expect(prepare).toBeDefined();

    const ctx = makeCtx('Read', { path: '/a' });

    const r1 = await prepare!(ctx);
    const r2 = await prepare!(ctx);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(onStall).not.toHaveBeenCalled();

    const r3 = await prepare!(ctx);
    expect(r3?.block).toBe(true);
    expect(r3?.reason).toMatch(/stalled/i);
    expect(r3?.reason).toContain('Read');
    // The reason includes the repeated call's canonical args so the reviser
    // can tell WHAT was repeated, not just which tool.
    expect(r3?.reason).toContain('/a');
    expect(r3?.reason).toContain('"path"');
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenLastCalledWith(r3?.reason);

    // Further repeats keep blocking but never re-fire onStall.
    const r4 = await prepare!(ctx);
    expect(r4?.block).toBe(true);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('truncates very long repeated args in the stall reason', async () => {
    const onStall = vi.fn();
    const hook = createStallDetectionHook({ repeatThreshold: 2, onStall });
    const prepare = hook.prepareToolExecution!;

    const longPattern = 'x'.repeat(500);
    const ctx = makeCtx('Grep', { pattern: longPattern });
    await prepare(ctx);
    const r = await prepare(ctx);
    expect(r?.block).toBe(true);
    // Truncated with an ellipsis — the full 500-char pattern is not embedded.
    expect(r?.reason).toContain('…');
    expect(r?.reason?.length).toBeLessThan(longPattern.length);
    expect(r?.reason).toContain('Grep');
  });

  it('never triggers on distinct progressing calls', async () => {
    const onStall = vi.fn();
    const hook = createStallDetectionHook({ repeatThreshold: 3, onStall });
    const prepare = hook.prepareToolExecution!;

    for (let i = 0; i < 10; i += 1) {
      const r = await prepare(makeCtx('Read', { path: `/file-${String(i)}` }));
      expect(r).toBeUndefined();
    }
    expect(onStall).not.toHaveBeenCalled();
  });

  it('treats canonically-equal args as the same key (key order independent)', async () => {
    const onStall = vi.fn();
    const hook = createStallDetectionHook({ repeatThreshold: 2, onStall });
    const prepare = hook.prepareToolExecution!;

    const r1 = await prepare(makeCtx('Edit', { a: 1, b: 2 }));
    const r2 = await prepare(makeCtx('Edit', { b: 2, a: 1 }));
    expect(r1).toBeUndefined();
    expect(r2?.block).toBe(true);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('keys on tool name too: same args under different names do not collide', async () => {
    const onStall = vi.fn();
    const hook = createStallDetectionHook({ repeatThreshold: 2, onStall });
    const prepare = hook.prepareToolExecution!;

    await prepare(makeCtx('Read', { path: '/a' }));
    const r = await prepare(makeCtx('Grep', { path: '/a' }));
    expect(r).toBeUndefined();
    expect(onStall).not.toHaveBeenCalled();
  });
});
