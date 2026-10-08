import { describe, expect, it } from 'vitest';

import { createActor, setRootActorErrorReporter, setup } from '#/xstate2';

describe('createActor root abort guard', () => {
  it('swallows AbortError at the root actor while preserving other error reporting', async () => {
    const abortError = new Error('operation cancelled');
    abortError.name = 'AbortError';
    const aborting = setup({
      actions: {
        boom: () => {
          throw abortError;
        },
      },
    }).createMachine({
      id: 'aborting',
      on: { go: { actions: 'boom' } },
    });
    const reported: unknown[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    setRootActorErrorReporter((err) => {
      reported.push(err);
    });
    process.on('uncaughtException', onUncaught);
    try {
      const actor = createActor(aborting);
      actor.start();
      actor.send({ type: 'go' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(actor.getSnapshot().status).toBe('error');
      expect(uncaught).toHaveLength(0);
      expect(reported).toEqual([abortError]);
    } finally {
      setRootActorErrorReporter(() => {});
      process.off('uncaughtException', onUncaught);
    }

    const failing = setup({
      actions: {
        boom: () => {
          throw new TypeError('real bug');
        },
      },
    }).createMachine({
      id: 'failing',
      on: { go: { actions: 'boom' } },
    });
    const seen: unknown[] = [];
    const actor = createActor(failing);
    actor.subscribe({
      error: (error) => {
        seen.push(error);
      },
    });
    actor.start();
    actor.send({ type: 'go' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(TypeError);
  });
});
