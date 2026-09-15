import { describe, expect, it } from 'vitest';

import {
  createCollection,
  createStore,
  createToken,
  createUnit,
  effectScope,
  EventContext,
  inject,
  mountRoot,
  provide,
  pushCleanup,
  ref,
  useChildren,
  useCollection,
  useContribute,
  useNode,
  useOn,
  watch,
  watchEffect,
  type ChildEntry,
  type ComputedRef,
  type Ref,
  type StoreResolution,
  type UnitHandle,
  type UnitNode,
} from '#/kernel/index';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('mount lifecycle', () => {
  it('unmounts children in reverse order and runs cleanup stacks LIFO', async () => {
    const log: string[] = [];
    const grand = createUnit('grand', () => () => {
      log.push('grand');
    });
    const childA = createUnit('childA', () => {
      const node = useNode();
      node.mount(grand);
      pushCleanup(node, () => {
        log.push('childA-extra');
      });
      return () => {
        log.push('childA-return');
      };
    });
    const childB = createUnit('childB', () => () => {
      log.push('childB');
    });
    const root = createUnit('root', () => {
      const node = useNode();
      node.mount(childA);
      node.mount(childB);
      return () => {
        log.push('root');
      };
    });
    const { handle } = mountRoot(root);
    expect(handle.state).toBe('active');
    await handle.unmount();
    expect(log).toEqual(['childB', 'grand', 'childA-return', 'childA-extra', 'root']);
    expect(handle.state).toBe('unmounted');
    await handle.unmount();
    expect(log).toHaveLength(5);
  });

  it('awaits an in-progress child unmount when re-entered concurrently', async () => {
    const order: string[] = [];
    let releaseCleanup: () => void = () => {};
    const child = createUnit('child', () => async () => {
      order.push('child-cleanup-start');
      await new Promise<void>((resolve) => {
        releaseCleanup = () => {
          order.push('child-cleanup-done');
          resolve();
        };
      });
    });
    const root = createUnit('root', () => {
      useNode().mount(child);
    });
    const { node } = mountRoot(root);
    const childNode = node.children[0] as UnitNode;
    const first = childNode.unmount();
    const second = childNode.unmount();
    expect(second).toBe(first);
    releaseCleanup();
    await Promise.all([first, second]);
    expect(order).toEqual(['child-cleanup-start', 'child-cleanup-done']);
  });

  it('parent unmount waits for a child unmount already in progress', async () => {
    const order: string[] = [];
    let releaseCleanup: () => void = () => {};
    const child = createUnit('child', () => async () => {
      order.push('child-cleanup-start');
      await new Promise<void>((resolve) => {
        releaseCleanup = () => {
          order.push('child-cleanup-done');
          resolve();
        };
      });
    });
    const root = createUnit('root', () => {
      useNode().mount(child);
    });
    const { node } = mountRoot(root);
    const childNode = node.children[0] as UnitNode;
    const childUnmount = childNode.unmount();
    let parentResolved = false;
    const parentUnmount = node.unmount().then(() => {
      parentResolved = true;
    });
    await flush();
    expect(parentResolved).toBe(false);
    releaseCleanup();
    await parentUnmount;
    await childUnmount;
    expect(parentResolved).toBe(true);
    expect(order).toEqual(['child-cleanup-start', 'child-cleanup-done']);
  });

  it('rolls back a failed mount: error propagates, child detached, cleanups run', async () => {
    const log: string[] = [];
    const bad = createUnit('bad', () => {
      pushCleanup(useNode(), () => {
        log.push('bad-cleanup');
      });
      throw new Error('boom');
    });
    const root = createUnit('root', () => {});
    const { node } = mountRoot(root);
    expect(() => node.mount(bad)).toThrow('boom');
    expect(node.children).toHaveLength(0);
    await flush();
    expect(log).toEqual(['bad-cleanup']);
    expect(() => mountRoot(bad)).toThrow('boom');
  });

  it('rolls back a failed root mount: mounted children unmount and the scope stops', async () => {
    const log: string[] = [];
    const source = ref(0);
    const child = createUnit('child', () => {
      watchEffect(() => {
        log.push(`tick:${source.value}`);
      });
      return () => {
        log.push('child-cleanup');
      };
    });
    const root = createUnit('root', () => {
      useNode().mount(child);
      throw new Error('boom');
    });
    expect(() => mountRoot(root)).toThrow('boom');
    await flush();
    expect(log).toEqual(['tick:0', 'child-cleanup']);
    source.value = 1;
    await flush();
    expect(log).toEqual(['tick:0', 'child-cleanup']);
  });

  it('rejects mounting into an unmounted unit', async () => {
    const root = createUnit('root', () => {});
    const { node, handle } = mountRoot(root);
    await handle.unmount();
    expect(() => node.mount(createUnit('late', () => {}))).toThrow("unit 'root' is unmounted");
  });
});

describe('provide / resolve', () => {
  it('resolves through the parent chain with nearest provider winning', () => {
    const token = createToken<string>('chain');
    let childSeen: string | undefined;
    const child = createUnit('child', () => {
      provide(token, 'child-val');
      childSeen = inject(token);
    });
    const root = createUnit('root', () => {
      provide(token, 'root-val');
      useNode().mount(child);
    });
    const { node } = mountRoot(root);
    expect(childSeen).toBe('child-val');
    expect(node.resolve(token)).toBe('root-val');
  });

  it('shadows same-node provisions as a stack and unwinds on unsubscribe', () => {
    const token = createToken<string>('stack');
    const { node } = mountRoot(createUnit('root', () => {}));
    const un1 = node.provide(token, 'v1');
    const un2 = node.provide(token, 'v2');
    expect(node.resolve(token)).toBe('v2');
    un2();
    expect(node.resolve(token)).toBe('v1');
    un1();
    expect(() => node.resolve(token)).toThrow("no provider for token 'stack'");
  });

  it('fails loudly when no provider exists, enforcing provider-first mount order', () => {
    const token = createToken<string>('timing');
    const injector = createUnit('injector', () => {
      inject(token);
    });
    const provider = createUnit('provider', (_props, ctx) => {
      ctx.node.parent?.provide(token, 'value');
    });
    const rootLate = createUnit('rootLate', () => {
      const node = useNode();
      node.mount(injector);
      node.mount(provider);
    });
    expect(() => mountRoot(rootLate)).toThrow("no provider for token 'timing'");
    const rootFirst = createUnit('rootFirst', () => {
      const node = useNode();
      node.mount(provider);
      node.mount(injector);
    });
    expect(() => mountRoot(rootFirst)).not.toThrow();
  });
});

describe('provider directory', () => {
  it('reflects provide and unprovide from any node in the root directory', () => {
    const token = createToken<string>('dir');
    let childNode: UnitNode | undefined;
    const child = createUnit('child', () => {
      childNode = useNode();
    });
    const root = createUnit('root', () => {
      useNode().mount(child);
    });
    const { node } = mountRoot(root);
    const directory = node.providerRef(token);
    expect(directory.value).toEqual([]);
    const withdraw = (childNode as UnitNode).provide(token, 'v1');
    expect(directory.value).toHaveLength(1);
    expect(directory.value[0]?.value).toBe('v1');
    expect(directory.value[0]?.node).toBe(childNode);
    withdraw();
    expect(directory.value).toEqual([]);
  });

  it('stacks same-token providers in provide order with the providing node attached', () => {
    const token = createToken<string>('dir-stack');
    let childNode: UnitNode | undefined;
    const child = createUnit('child', () => {
      provide(token, 'child-val');
      childNode = useNode();
    });
    const root = createUnit('root', () => {
      provide(token, 'root-val');
      useNode().mount(child);
    });
    const { node } = mountRoot(root);
    const entries = node.providerRef(token).value;
    expect(entries.map((entry) => entry.value)).toEqual(['root-val', 'child-val']);
    expect(entries[0]?.node).toBe(node);
    expect(entries[1]?.node).toBe(childNode);
    expect(node.resolve(token)).toBe('root-val');
  });

  it('notifies directory watchers when a token appears and disappears', async () => {
    const token = createToken<string>('dir-watch');
    const { node } = mountRoot(createUnit('root', () => {}));
    const counts: number[] = [];
    watch(node.providerRef(token), (entries) => {
      counts.push(entries.length);
    });
    const withdraw = node.provide(token, 'v');
    await flush();
    withdraw();
    await flush();
    expect(counts).toEqual([1, 0]);
  });

  it('drops directory entries when a providing unit unmounts', async () => {
    const token = createToken<string>('dir-unmount');
    const child = createUnit('child', () => {
      provide(token, 'child-val');
    });
    const { node } = mountRoot(createUnit('root', () => {}));
    const directory = node.providerRef(token);
    const handle = node.mount(child);
    expect(directory.value).toHaveLength(1);
    await handle.unmount();
    expect(directory.value).toEqual([]);
  });

  it('drops directory entries of direct node.provide calls when the node unmounts', async () => {
    const token = createToken<string>('dir-direct-unmount');
    let childNode: UnitNode | undefined;
    const child = createUnit('child', () => {
      childNode = useNode();
    });
    const { node } = mountRoot(createUnit('root', () => {}));
    const directory = node.providerRef(token);
    const handle = node.mount(child);
    (childNode as UnitNode).provide(token, 'v1');
    expect(directory.value).toHaveLength(1);
    await handle.unmount();
    expect(directory.value).toEqual([]);
  });

  it('keeps manual withdrawals idempotent across a later unmount', async () => {
    const token = createToken<string>('dir-early-withdraw');
    const { node, handle } = mountRoot(createUnit('root', () => {}));
    const directory = node.providerRef(token);
    const withdraw = node.provide(token, 'v1');
    withdraw();
    expect(directory.value).toEqual([]);
    withdraw();
    await handle.unmount();
    expect(directory.value).toEqual([]);
    expect(() => node.resolve(token)).toThrow("no provider for token 'dir-early-withdraw'");
  });
});

describe('external effect scope', () => {
  it('cascades a parent scope stop to every watcher in the tree', async () => {
    const source = ref(0);
    const ticks: string[] = [];
    const child = createUnit('child', () => {
      watchEffect(() => {
        ticks.push(`child:${source.value}`);
      });
    });
    const root = createUnit('root', () => {
      watchEffect(() => {
        ticks.push(`root:${source.value}`);
      });
      useNode().mount(child);
    });
    const scope = effectScope();
    const { handle } = mountRoot(root, undefined, { scope });
    expect(ticks).toEqual(['root:0', 'child:0']);
    source.value = 1;
    await flush();
    expect(ticks).toEqual(['root:0', 'child:0', 'root:1', 'child:1']);
    scope.stop();
    expect(handle.state).toBe('active');
    source.value = 2;
    await flush();
    expect(ticks).toEqual(['root:0', 'child:0', 'root:1', 'child:1']);
    await handle.unmount();
    expect(handle.state).toBe('unmounted');
  });

  it('leaves tree watchers untouched when no external scope is given', async () => {
    const source = ref(0);
    const ticks: number[] = [];
    const root = createUnit('root', () => {
      watchEffect(() => {
        ticks.push(source.value);
      });
    });
    const { handle } = mountRoot(root);
    effectScope().stop();
    source.value = 1;
    await flush();
    expect(ticks).toEqual([0, 1]);
    await handle.unmount();
  });

  it('cascades a parent scope stop to children mounted by a useChildren re-trigger', async () => {
    const source = ref(0);
    const entries = ref<ChildEntry[]>([]);
    const ticks: number[] = [];
    const child = createUnit('child', () => {
      watchEffect(() => {
        ticks.push(source.value);
      });
    });
    const root = createUnit('root', () => {
      useChildren(entries);
    });
    const scope = effectScope();
    const { node } = mountRoot(root, undefined, { scope });
    entries.value = [{ key: 'a', recipe: child }];
    await flush();
    expect(node.children).toHaveLength(1);
    source.value = 1;
    await flush();
    expect(ticks).toEqual([0, 1]);
    scope.stop();
    source.value = 2;
    await flush();
    expect(ticks).toEqual([0, 1]);
  });

  it('rejects mounting into an inactive scope', () => {
    const scope = effectScope();
    scope.stop();
    expect(() => mountRoot(createUnit('root', () => {}), undefined, { scope })).toThrow(
      "cannot mount root unit 'root' into an inactive effect scope",
    );
  });
});

describe('useChildren', () => {
  function childRecipe(name: string, log: string[]) {
    return createUnit<string>(name, (props) => {
      log.push(`setup:${name}:${props}`);
      return () => {
        log.push(`cleanup:${name}:${props}`);
      };
    });
  }

  it('mounts, updates props, remounts on recipe change, and unmounts removed keys', async () => {
    const log: string[] = [];
    const childA = childRecipe('childA', log);
    const childB = childRecipe('childB', log);
    const source = ref<Array<ChildEntry | null>>([{ key: 'a', recipe: childA, props: 'p1' }]);
    const parent = createUnit('parent', () => {
      useChildren(source);
    });
    const { node } = mountRoot(parent);
    expect(node.children.map((child) => child.name)).toEqual(['childA']);
    expect(log).toEqual(['setup:childA:p1']);

    source.value = [
      { key: 'a', recipe: childA, props: 'p1' },
      { key: 'b', recipe: childB, props: 'p2' },
    ];
    await flush();
    expect(node.children.map((child) => child.name)).toEqual(['childA', 'childB']);
    expect(log).toEqual(['setup:childA:p1', 'setup:childB:p2']);

    source.value = [
      { key: 'a', recipe: childA, props: 'p1-next' },
      { key: 'b', recipe: childB, props: 'p2' },
    ];
    await flush();
    expect(node.children).toHaveLength(2);
    expect(node.children[0]?.props).toBe('p1-next');
    expect(log).toEqual(['setup:childA:p1', 'setup:childB:p2']);

    source.value = [
      { key: 'a', recipe: childB, props: 'p1-next' },
      { key: 'b', recipe: childB, props: 'p2' },
    ];
    await flush();
    expect(node.children.map((child) => child.name)).toEqual(['childB', 'childB']);
    expect(log).toEqual([
      'setup:childA:p1',
      'setup:childB:p2',
      'cleanup:childA:p1',
      'setup:childB:p1-next',
    ]);

    source.value = [null, { key: 'b', recipe: childB, props: 'p2' }];
    await flush();
    expect(node.children.map((child) => child.name)).toEqual(['childB']);
    expect(node.children[0]?.props).toBe('p2');

    source.value = [];
    await flush();
    expect(node.children).toHaveLength(0);
    expect(log.filter((entry) => entry.startsWith('cleanup:'))).toEqual([
      'cleanup:childA:p1',
      'cleanup:childB:p1-next',
      'cleanup:childB:p2',
    ]);
  });

  it('rejects duplicate child keys during setup', () => {
    const child = createUnit('child', () => {});
    const parent = createUnit('parent', () => {
      useChildren([
        { key: 'a', recipe: child },
        { key: 'a', recipe: child },
      ]);
    });
    expect(() => mountRoot(parent)).toThrow("duplicate child key 'a' in unit 'parent'");
  });

  it('keeps setup props reactive across handle.update', () => {
    const seen: number[] = [];
    const probe = createUnit<{ n: number }>('probe', (props) => {
      watch(() => props.n, (next) => seen.push(next), { immediate: true });
    });
    const { handle } = mountRoot(probe, { n: 1 });
    expect(seen).toEqual([1]);
    handle.update({ n: 2 });
    expect(seen).toEqual([1, 2]);
  });
});

describe('collection fold', () => {
  it('folds along the parent chain ordered by priority then insertion order', () => {
    const tools = createCollection<string>('tools');
    let childNode: UnitNode | undefined;
    const child = createUnit('child', () => {
      useContribute(tools, 'child-mid', 3);
      useContribute(tools, 'child-first', 1);
      childNode = useNode();
    });
    const sibling = createUnit('sibling', () => {
      useContribute(tools, 'sibling-only', 0);
    });
    const root = createUnit('root', () => {
      useContribute(tools, 'root-low', 5);
      useContribute(tools, 'root-high', 1);
      const node = useNode();
      node.mount(child);
      node.mount(sibling);
    });
    const { node } = mountRoot(root);
    expect(childNode?.fold(tools)).toEqual(['root-high', 'child-first', 'child-mid', 'root-low']);
    expect(node.fold(tools)).toEqual(['root-high', 'root-low']);
  });

  it('tracks contribute and withdraw reactively through useCollection', () => {
    const tools = createCollection<string>('tools-live');
    let live: ComputedRef<readonly string[]> | undefined;
    const child = createUnit('child', () => {
      live = useCollection(tools);
    });
    const root = createUnit('root', () => {
      useNode().mount(child);
    });
    const { node } = mountRoot(root);
    const childNode = node.children[0] as UnitNode;
    expect(live?.value).toEqual([]);
    const withdraw = childNode.contribute(tools, 'late', 0);
    expect(live?.value).toEqual(['late']);
    withdraw();
    expect(live?.value).toEqual([]);
  });
});

describe('event fire', () => {
  function threeLevelTree(seq: string[]): { node: UnitNode; grandNode: UnitNode } {
    const grand = createUnit('grand', () => {
      useOn('e', () => seq.push('grand-bubble'));
      useOn('e', () => seq.push('grand-capture'), { capture: true });
    });
    const child = createUnit('child', () => {
      useOn('e', () => seq.push('child-bubble'));
      useOn('e', () => seq.push('child-capture'), { capture: true });
      useNode().mount(grand);
    });
    const root = createUnit('root', () => {
      useOn('e', () => seq.push('root-bubble'));
      useOn('e', () => seq.push('root-capture'), { capture: true });
      useNode().mount(child);
    });
    const { node } = mountRoot(root);
    const grandNode = (node.children[0] as UnitNode).children[0] as UnitNode;
    return { node, grandNode };
  }

  it('runs capture from root to target then bubble from target to root', () => {
    const seq: string[] = [];
    const { grandNode } = threeLevelTree(seq);
    grandNode.fire({ type: 'e' });
    expect(seq).toEqual([
      'root-capture',
      'child-capture',
      'grand-capture',
      'grand-bubble',
      'child-bubble',
      'root-bubble',
    ]);
  });

  it('merges EventContext down the lineage with deeper and explicit fields winning', () => {
    const seen: Array<Record<string, unknown>> = [];
    const leaf = createUnit('leaf', () => {
      provide(EventContext, { feature: 'todo', shared: 'leaf', depth: 'leaf' });
    });
    const mid = createUnit('mid', () => {
      provide(EventContext, { sessionId: 's1', shared: 'mid' });
      useNode().mount(leaf);
    });
    const root = createUnit('root', () => {
      provide(EventContext, { agentId: 'a1', shared: 'root', depth: 'root' });
      const node = useNode();
      node.on('e', (event) => seen.push(event as unknown as Record<string, unknown>));
      node.mount(mid);
    });
    const { node } = mountRoot(root);
    const leafNode = (node.children[0] as UnitNode).children[0] as UnitNode;
    leafNode.fire({ type: 'e', shared: 'explicit', extra: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      type: 'e',
      agentId: 'a1',
      sessionId: 's1',
      feature: 'todo',
      shared: 'explicit',
      depth: 'leaf',
      extra: 1,
    });
  });

  it('honors once, wildcard handlers, and unsubscribe', () => {
    const { node } = mountRoot(createUnit('root', () => {}));
    let onceCount = 0;
    const types: string[] = [];
    let plainCount = 0;
    node.on('e', () => {
      onceCount += 1;
    }, { once: true });
    node.on('*', (event) => types.push(event.type));
    const unsubscribe = node.on('e', () => {
      plainCount += 1;
    });
    node.fire({ type: 'e' });
    node.fire({ type: 'e' });
    node.fire({ type: 'other' });
    expect(onceCount).toBe(1);
    expect(types).toEqual(['e', 'e', 'other']);
    expect(plainCount).toBe(2);
    unsubscribe();
    node.fire({ type: 'e' });
    expect(plainCount).toBe(2);
  });

  it('removes useOn handlers when the unit unmounts', async () => {
    let calls = 0;
    const child = createUnit('child', () => {
      useOn('e', () => {
        calls += 1;
      });
    });
    const root = createUnit('root', () => {});
    const { node } = mountRoot(root);
    const handle = node.mount(child);
    handle.node.fire({ type: 'e' });
    expect(calls).toBe(1);
    await handle.unmount();
    handle.node.fire({ type: 'e' });
    expect(calls).toBe(1);
  });
});

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
        increment: () => {
          count.value += 1;
        },
      };
    });
    const events: Array<Record<string, unknown>> = [];
    let sibling: StoreResolution<CounterFace> | undefined;
    let storeHandle: UnitHandle | undefined;
    const consumer = createUnit('consumer', () => {
      sibling = inject(counterStore);
    });
    const root = createUnit('root', () => {
      provide(EventContext, { agentId: 'a1' });
      const node = useNode();
      node.on('store.state', (event) => {
        events.push(event as unknown as Record<string, unknown>);
      });
      storeHandle = node.mount(counterStore);
      node.mount(consumer);
    });
    const { node } = mountRoot(root);
    expect(sibling?.name).toBe('counter');
    expect(sibling?.count.value).toBe(0);
    expect(sibling?.label).toBe('fixed');
    expect(sibling?.select((state) => state.label)).toBe('fixed');

    const faces: CounterFace[] = [];
    const unsubscribe = sibling?.subscribe((face) => {
      faces.push(face);
    });

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
