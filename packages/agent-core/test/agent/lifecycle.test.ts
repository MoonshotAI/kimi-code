import { describe, expect, it, vi } from 'vitest';

import { LifecycleService, type PromptCtx, type TurnHookCtx } from '#/agent/lifecycle';
import type { IDisposable } from '#/di';

type Handler<Ctx> = (ctx: Ctx) => void | Promise<void>;

/**
 * Exercises the three guarantees every lifecycle hook must honor:
 *   1. a registered handler is invoked with the fired ctx;
 *   2. `fireXxx` awaits async handlers (sequential, like `fireBeforePrompt`);
 *   3. a disposed subscription no longer receives fires.
 *
 * Each check disposes its own subscription before the next so the shared
 * handler set is clean between them. The ctx is passed as a plain object
 * literal at every call site; for `TurnHookCtx` (whose `turnId` is optional)
 * the call fixes the type parameter explicitly so the literal does not
 * narrow it to `{ turnId: number }`.
 */
async function expectHookContract<Ctx>(
  register: (handler: Handler<Ctx>) => IDisposable,
  fire: (ctx: Ctx) => Promise<void>,
  ctx: Ctx,
): Promise<void> {
  const handler = vi.fn();
  const subscription = register(handler);
  await fire(ctx);
  expect(handler).toHaveBeenCalledOnce();
  expect(handler).toHaveBeenCalledWith(ctx);
  subscription.dispose();

  let asyncResolved = false;
  const asyncSubscription = register(async () => {
    await Promise.resolve();
    asyncResolved = true;
  });
  await fire(ctx);
  expect(asyncResolved).toBe(true);
  asyncSubscription.dispose();

  const disposedHandler = vi.fn();
  const disposedSubscription = register(disposedHandler);
  disposedSubscription.dispose();
  await fire(ctx);
  expect(disposedHandler).not.toHaveBeenCalled();
}

describe('LifecycleService', () => {
  it('onBeforePrompt / fireBeforePrompt still works (regression guard)', async () => {
    const lifecycle = new LifecycleService();
    const handler = vi.fn();
    const subscription = lifecycle.onBeforePrompt(handler);
    const ctx: PromptCtx = { injectSystemReminder: () => {} };

    await lifecycle.fireBeforePrompt(ctx);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(ctx);
    subscription.dispose();
  });

  describe('session hooks', () => {
    it('onSessionWillStart / fireSessionWillStart', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onSessionWillStart(h),
        (ctx) => lifecycle.fireSessionWillStart(ctx),
        { sessionId: 'session-1' },
      );
    });

    it('onSessionDidStart / fireSessionDidStart', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onSessionDidStart(h),
        (ctx) => lifecycle.fireSessionDidStart(ctx),
        { sessionId: 'session-1' },
      );
    });

    it('onSessionWillClose / fireSessionWillClose', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onSessionWillClose(h),
        (ctx) => lifecycle.fireSessionWillClose(ctx),
        { sessionId: 'session-1' },
      );
    });

    it('onSessionDidClose / fireSessionDidClose', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onSessionDidClose(h),
        (ctx) => lifecycle.fireSessionDidClose(ctx),
        { sessionId: 'session-1' },
      );
    });
  });

  describe('agent hooks', () => {
    it('onAgentWillCreate / fireAgentWillCreate', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onAgentWillCreate(h),
        (ctx) => lifecycle.fireAgentWillCreate(ctx),
        { agentId: 'agent-1' },
      );
    });

    it('onAgentDidCreate / fireAgentDidCreate', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onAgentDidCreate(h),
        (ctx) => lifecycle.fireAgentDidCreate(ctx),
        { agentId: 'agent-1' },
      );
    });

    it('onAgentWillResume / fireAgentWillResume', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onAgentWillResume(h),
        (ctx) => lifecycle.fireAgentWillResume(ctx),
        { agentId: 'agent-1' },
      );
    });

    it('onAgentDidResume / fireAgentDidResume', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onAgentDidResume(h),
        (ctx) => lifecycle.fireAgentDidResume(ctx),
        { agentId: 'agent-1' },
      );
    });

    it('onAgentWillDispose / fireAgentWillDispose', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract(
        (h) => lifecycle.onAgentWillDispose(h),
        (ctx) => lifecycle.fireAgentWillDispose(ctx),
        { agentId: 'agent-1' },
      );
    });
  });

  describe('turn hooks', () => {
    it('onTurnWillStart / fireTurnWillStart', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract<TurnHookCtx>(
        (h) => lifecycle.onTurnWillStart(h),
        (ctx) => lifecycle.fireTurnWillStart(ctx),
        { turnId: 1 },
      );
    });

    it('onTurnDidStart / fireTurnDidStart', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract<TurnHookCtx>(
        (h) => lifecycle.onTurnDidStart(h),
        (ctx) => lifecycle.fireTurnDidStart(ctx),
        { turnId: 1 },
      );
    });

    it('onTurnDidEnd / fireTurnDidEnd', async () => {
      const lifecycle = new LifecycleService();
      await expectHookContract<TurnHookCtx>(
        (h) => lifecycle.onTurnDidEnd(h),
        (ctx) => lifecycle.fireTurnDidEnd(ctx),
        { turnId: 1 },
      );
    });
  });
});
