import { describe, expect, it } from 'vitest';

import { createUnit, EventContext, inject, mountRoot, provide, ref, useNode, type Ref, type UnitHandle } from '#/kernel/index';
import { createStore, type StoreResolution } from '#/store/index';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createStore', () => {
  interface CounterFace {
    count: Ref<number>;
    label: string;
    increment: () => void;
  }

  it('provides a live handle to the parent and publishes full state snapshots', async () => {
    const counterStore = createStore<CounterFace>('counter', () => {
      const count = ref(0);
      return {
        count,
        label: 'fixed',
        increment: () => { count.value += 1; },
      };
    });
    const events: Array<Record<string, unknown>> = [];
    let sibling: StoreResolution<CounterFace> | undefined;
    let storeHandle: UnitHandle | undefined;
    const consumer = createUnit('consumer', () => { sibling = inject(counterStore); });
    const root = createUnit('root', () => {
      provide(EventContext, { agentId: 'a1' });
      const node = useNode();
      node.on('store.state', (event) => { events.push(event as unknown as Record<string, unknown>); });
      storeHandle = node.mount(counterStore);
      node.mount(consumer);
    });
    const { node } = mountRoot(root);
    expect(sibling?.name).toBe('counter');
    expect(sibling?.count.value).toBe(0);
    expect(sibling?.label).toBe('fixed');
    expect(sibling?.select((state) => state.label)).toBe('fixed');
    const faces: CounterFace[] = [];
    const unsubscribe = sibling?.subscribe((face) => { faces.push(face); });
    sibling?.increment();
    expect(sibling?.count.value).toBe(1);
    await flush();
    expect(events).toHaveLength(1);
    const first = events[0] as Record<string, unknown>;
    expect(first['type']).toBe('store.state');
    expect(first['store']).toBe('counter');
    expect(first['agentId']).toBe('a1');
    expect(first['state']).toEqual({ count: 1, label: 'fixed' });
    expect(faces).toHaveLength(1);
    expect(faces[0]).toBe(sibling?.getState());
    unsubscribe?.();
    sibling?.increment();
    await flush();
    expect(events).toHaveLength(2);
    expect(faces).toHaveLength(1);
    await storeHandle?.unmount();
    expect(() => node.resolve(counterStore)).toThrow("no provider for token 'store:counter'");
  });
});
