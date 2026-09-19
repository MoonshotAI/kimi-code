import { describe, expect, it } from 'vitest';

import { createUnit, mountRoot, useOn, type Ref } from '#/kernel/index';
import { emit, setup, useMachine, type EventFromLogic, type SnapshotFrom } from '#/xstate2/index';

describe('useMachine', () => {
  it('starts the actor after setup, mirrors snapshots, and re-fires emitted events', async () => {
    const machine = setup({}).createMachine({
      id: 'probe',
      initial: 'idle',
      states: {
        idle: { on: { go: { target: 'done', actions: emit({ type: 'probe.finished' }) } } },
        done: {},
      },
    });
    const fired: string[] = [];
    let snapshot: Ref<SnapshotFrom<typeof machine> | undefined> | undefined;
    let send: ((event: EventFromLogic<typeof machine>) => void) | undefined;
    const probe = createUnit('probe', () => {
      useOn('probe.finished', () => fired.push('probe.finished'));
      const [snap, snd] = useMachine(() => machine, { key: 'probe', input: undefined });
      snapshot = snap;
      send = snd;
    });
    const { handle } = mountRoot(probe);
    expect(snapshot?.value?.value).toBe('idle');
    send?.({ type: 'go' });
    expect(snapshot?.value?.value).toBe('done');
    expect(fired).toEqual(['probe.finished']);
    await handle.unmount();
  });
});
