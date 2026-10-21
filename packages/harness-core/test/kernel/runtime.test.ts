import { describe, expect, it } from 'vitest';

import {
  createCollection,
  createFacadeToken,
  createToken,
  createUnit,
  effectScope,
  EventContext,
  mountRoot,
  provide,
  ref,
  useChildren,
  useCleanup,
  useCollection,
  useContribute,
  useExpose,
  useFire,
  useInject,
  useOn,
  useReady,
  useWait,
  watch,
  watchEffect,
  type ChildEntry,
  type ComputedRef,
  type RuntimeEvent,
  type ShallowRef,
} from '#/kernel/index';
import { currentUnit, type UnitErrorEvent, type UnitNode } from '#/kernel/runtime';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('mount lifecycle', () => {
  it('unmounts descendants before the unit and runs cleanup stacks LIFO', async () => {
    const log: string[] = [];
    const grand = createUnit('grand', () => {
      useCleanup(() => {
        log.push('grand');
      });
    });
    const childA = createUnit('childA', () => {
      useCleanup(() => {
        log.push('childA-first');
      });
      useCleanup(() => {
        log.push('childA-second');
      });
    });
    const childB = createUnit('childB', () => {
      useCleanup(() => {
        log.push('childB');
      });
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      useCleanup(() => {
        log.push('root');
      });
    });
    const handle = mountRoot(root);
    expect(handle.state).toBe('active');
    const node = rootNode as UnitNode;
    const childAUnit = node.mount(childA, undefined);
    node.mount(childB, undefined);
    childAUnit.mount(grand, undefined);
    await handle.unmount();
    expect(log).toEqual(['grand', 'childB', 'childA-second', 'childA-first', 'root']);
    expect(handle.state).toBe('disposed');
    await handle.unmount();
    expect(log).toHaveLength(5);
  });

  it('returns the in-progress disposal when dispose is re-entered concurrently', async () => {
    const order: string[] = [];
    let releaseCleanup: () => void = () => {};
    const child = createUnit('child', () => {
      useCleanup(async () => {
        order.push('child-cleanup-start');
        await new Promise<void>((resolve) => {
          releaseCleanup = () => {
            order.push('child-cleanup-done');
            resolve();
          };
        });
      });
    });
    let rootNode: UnitNode | undefined;
    mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const childUnit = (rootNode as UnitNode).mount(child, undefined);
    const first = childUnit.dispose();
    const second = childUnit.dispose();
    expect(second).toBe(first);
    await flush();
    releaseCleanup();
    await Promise.all([first, second]);
    expect(order).toEqual(['child-cleanup-start', 'child-cleanup-done']);
    await (rootNode as UnitNode).dispose();
  });

  it('waits for a child disposal already in progress when the parent unmounts', async () => {
    const order: string[] = [];
    let releaseCleanup: () => void = () => {};
    const child = createUnit('child', () => {
      useCleanup(async () => {
        order.push('child-cleanup-start');
        await new Promise<void>((resolve) => {
          releaseCleanup = () => {
            order.push('child-cleanup-done');
            resolve();
          };
        });
      });
    });
    let rootNode: UnitNode | undefined;
    mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const node = rootNode as UnitNode;
    const childUnit = node.mount(child, undefined);
    const childDisposal = childUnit.dispose();
    let parentResolved = false;
    const parentDisposal = node.dispose().then(() => {
      parentResolved = true;
    });
    await flush();
    expect(parentResolved).toBe(false);
    releaseCleanup();
    await parentDisposal;
    await childDisposal;
    expect(parentResolved).toBe(true);
    expect(order).toEqual(['child-cleanup-start', 'child-cleanup-done']);
  });

  it('rolls back a failed child mount: reports unit.error, detaches the child, runs its cleanups', async () => {
    const log: string[] = [];
    const errors: UnitErrorEvent[] = [];
    const bad = createUnit('bad', () => {
      useCleanup(() => {
        log.push('bad-cleanup');
      });
      throw new Error('boom');
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      useOn<UnitErrorEvent>('unit.error', (event) => {
        errors.push(event);
      });
    });
    mountRoot(root);
    const node = rootNode as UnitNode;
    const failed = node.mount(bad, undefined);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.unit).toBe('root');
    expect(String(errors[0]?.error)).toContain('boom');
    await flush();
    expect(failed.state).toBe('disposed');
    expect(node.children).toHaveLength(0);
    expect(log).toEqual(['bad-cleanup']);
    const handle = mountRoot(bad);
    await flush();
    expect(handle.state).toBe('disposed');
    await expect(handle.ready()).rejects.toThrow('boom');
    expect(log).toEqual(['bad-cleanup', 'bad-cleanup']);
    await node.dispose();
  });

  it('stops effects and runs cleanups when a root setup throws', async () => {
    const log: string[] = [];
    const source = ref(0);
    const root = createUnit('root', () => {
      watchEffect(() => {
        log.push(`tick:${source.value}`);
      });
      useCleanup(() => {
        log.push('cleanup');
      });
      throw new Error('boom');
    });
    const handle = mountRoot(root);
    await flush();
    expect(log).toEqual(['tick:0', 'cleanup']);
    expect(handle.state).toBe('disposed');
    await expect(handle.ready()).rejects.toThrow('boom');
    source.value = 1;
    await flush();
    expect(log).toEqual(['tick:0', 'cleanup']);
  });

  it('rejects mounting into a disposed unit', async () => {
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    await handle.unmount();
    expect(() => (rootNode as UnitNode).mount(createUnit('late', () => {}), undefined)).toThrow(
      "unit 'root' is not active",
    );
  });
});

describe('setup contract', () => {
  it('fails a unit whose setup returns a value', async () => {
    const bad = createUnit('bad', () => {
      return (() => undefined) as unknown as void;
    });
    const handle = mountRoot(bad);
    await flush();
    expect(handle.state).toBe('disposed');
    await expect(handle.ready()).rejects.toThrow("setup of unit 'bad' must return undefined");
  });

  it('rejects non-object props at mount and update', async () => {
    const recipe = createUnit<{ n: number }>('root', () => {});
    expect(() => mountRoot(recipe, 1 as never)).toThrow("props of unit 'root' must be an object");
    const handle = mountRoot(recipe, { n: 1 });
    expect(() => handle.update(2 as never)).toThrow("props of unit 'root' must be an object");
    await handle.unmount();
  });

  it('throws when currentUnit is called outside a setup', () => {
    expect(() => currentUnit()).toThrow('hook called outside of a unit setup');
  });
});

describe('ready and failure', () => {
  it('resolves ready after tracked operations settle and rejects after unmount', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const root = createUnit('root', () => {
      useReady(gate);
    });
    const handle = mountRoot(root);
    let settled = false;
    void handle.ready().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    release();
    await handle.ready();
    expect(settled).toBe(true);
    await handle.unmount();
    await expect(handle.ready()).rejects.toThrow("unit 'root' is unmounted");
  });

  it('disposes the unit and reports to its parent when a tracked operation rejects', async () => {
    const errors: UnitErrorEvent[] = [];
    const child = createUnit('child', () => {
      useReady(Promise.reject(new Error('async-boom')));
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      useOn<UnitErrorEvent>('unit.error', (event) => {
        errors.push(event);
      });
    });
    const handle = mountRoot(root);
    const node = rootNode as UnitNode;
    const childUnit = node.mount(child, undefined);
    await flush();
    expect(childUnit.state).toBe('disposed');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.unit).toBe('root');
    expect(String(errors[0]?.error)).toContain('async-boom');
    expect(handle.state).toBe('active');
    await handle.ready();
    await handle.unmount();
  });
});

describe('provide / resolve', () => {
  it('resolves certain tokens through the parent chain with the nearest provider winning', () => {
    const token = createToken<string>('chain');
    let childSeen: string | undefined;
    let grandSeen: string | undefined;
    const grandchild = createUnit('grandchild', () => {
      grandSeen = useInject(token);
    });
    const child = createUnit('child', () => {
      provide(token, 'child-val');
      childSeen = useInject(token);
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      provide(token, 'root-val');
    });
    const handle = mountRoot(root);
    const childUnit = (rootNode as UnitNode).mount(child, undefined);
    childUnit.mount(grandchild, undefined);
    expect(childSeen).toBe('child-val');
    expect(grandSeen).toBe('child-val');
    expect(handle.resolve(token)).toBe('root-val');
  });

  it('prefers the nearest facade exposure along the lineage', () => {
    const facade = createFacadeToken<string>('chain-facade');
    let seen: Readonly<ShallowRef<string | undefined>> | undefined;
    const qaExposer = createUnit('qa-exposer', () => {
      useExpose(facade, 'qa-val');
    });
    const reader = createUnit('reader', () => {
      seen = useInject(facade);
    });
    const qa = createUnit('qa', () => {});
    const pa = createUnit('pa', () => {
      useExpose(facade, 'pa-val');
    });
    let hostNode: UnitNode | undefined;
    const host = createUnit('host', () => {
      hostNode = currentUnit();
    });
    const handle = mountRoot(host);
    const node = hostNode as UnitNode;
    const qaUnit = node.mount(qa, undefined);
    qaUnit.mount(qaExposer, undefined);
    qaUnit.mount(reader, undefined);
    node.mount(pa, undefined);
    expect(seen?.value).toBe('qa-val');
    expect(handle.resolve(facade)).toBe('pa-val');
  });

  it('shadows same-node registrations as a stack and unwinds on unregister', async () => {
    const token = createToken<string>('stack');
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const node = rootNode as UnitNode;
    const un1 = node.register(token, 'v1');
    const un2 = node.register(token, 'v2');
    expect(node.resolve(token)).toBe('v2');
    un2();
    expect(node.resolve(token)).toBe('v1');
    un2();
    expect(node.resolve(token)).toBe('v1');
    un1();
    expect(() => node.resolve(token)).toThrow("no provider for token 'stack'");
    await handle.unmount();
  });

  it('fails units that inject absent certain tokens and withdraws provisions on unmount', async () => {
    const token = createToken<string>('timing');
    const failing = mountRoot(createUnit('injector', () => {
      useInject(token);
    }));
    await expect(failing.ready()).rejects.toThrow("no provider for token 'timing'");
    await flush();
    expect(failing.state).toBe('disposed');
    const provider = createUnit('provider', () => {
      provide(token, 'value');
    });
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    (rootNode as UnitNode).mount(provider, undefined);
    const providerUnit = (rootNode as UnitNode).children[0] as UnitNode;
    expect(providerUnit.resolve(token)).toBe('value');
    expect(() => handle.resolve(token)).toThrow("no provider for token 'timing'");
    await providerUnit.dispose();
    expect(() => providerUnit.resolve(token)).toThrow("no provider for token 'timing'");
    await handle.unmount();
  });

  it('keeps facade injection reactively nullable across expose and unmount', async () => {
    const facade = createFacadeToken<string>('timing-facade');
    let seen: Readonly<ShallowRef<string | undefined>> | undefined;
    const watcher = createUnit('watcher', () => {
      seen = useInject(facade);
    });
    let rootNode: UnitNode | undefined;
    const facadeRoot = createUnit('facadeRoot', () => {
      rootNode = currentUnit();
    });
    const handle = mountRoot(facadeRoot);
    const node = rootNode as UnitNode;
    node.mount(watcher, undefined);
    expect(seen?.value).toBeUndefined();
    expect(handle.resolve(facade)).toBeUndefined();
    const late = node.mount(createUnit('late-provider', () => {
      useExpose(facade, 'late-val');
    }), undefined);
    expect(seen?.value).toBe('late-val');
    expect(handle.resolve(facade)).toBe('late-val');
    await late.dispose();
    expect(seen?.value).toBeUndefined();
    expect(handle.resolve(facade)).toBeUndefined();
    await handle.unmount();
  });
});

describe('external effect scope', () => {
  it('unmounts the whole tree when the external scope stops', async () => {
    const source = ref(0);
    const ticks: string[] = [];
    const child = createUnit('child', () => {
      watchEffect(() => {
        ticks.push(`child:${source.value}`);
      });
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      watchEffect(() => {
        ticks.push(`root:${source.value}`);
      });
    });
    const scope = effectScope();
    const handle = mountRoot(root, undefined, { scope });
    (rootNode as UnitNode).mount(child, undefined);
    expect(ticks).toEqual(['root:0', 'child:0']);
    source.value = 1;
    await flush();
    expect(ticks).toEqual(['root:0', 'child:0', 'root:1', 'child:1']);
    scope.stop();
    await flush();
    expect(handle.state).toBe('disposed');
    source.value = 2;
    await flush();
    expect(ticks).toEqual(['root:0', 'child:0', 'root:1', 'child:1']);
  });

  it('leaves tree watchers untouched when no external scope is given', async () => {
    const source = ref(0);
    const ticks: number[] = [];
    const root = createUnit('root', () => {
      watchEffect(() => {
        ticks.push(source.value);
      });
    });
    const handle = mountRoot(root);
    effectScope().stop();
    source.value = 1;
    await flush();
    expect(ticks).toEqual([0, 1]);
    await handle.unmount();
  });

  it('unmounts useChildren-mounted children when the external scope stops', async () => {
    const source = ref(0);
    const entries = ref<ChildEntry[]>([]);
    const ticks: number[] = [];
    const child = createUnit('child', () => {
      watchEffect(() => {
        ticks.push(source.value);
      });
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      useChildren(entries);
    });
    const scope = effectScope();
    const handle = mountRoot(root, undefined, { scope });
    entries.value = [{ key: 'a', recipe: child }];
    await flush();
    expect((rootNode as UnitNode).children).toHaveLength(1);
    source.value = 1;
    await flush();
    expect(ticks).toEqual([0, 1]);
    scope.stop();
    source.value = 2;
    await flush();
    expect(ticks).toEqual([0, 1]);
    expect(handle.state).toBe('disposed');
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
    return createUnit<{ v: string }>(name, (props) => {
      const v = props.v;
      log.push(`setup:${name}:${v}`);
      useCleanup(() => {
        log.push(`cleanup:${name}:${v}`);
      });
    });
  }

  it('mounts, updates props, remounts on recipe change, and unmounts removed keys', async () => {
    const log: string[] = [];
    const childA = childRecipe('childA', log);
    const childB = childRecipe('childB', log);
    const source = ref<Array<ChildEntry | null>>([{ key: 'a', recipe: childA, props: { v: 'p1' } }]);
    let rootNode: UnitNode | undefined;
    const parent = createUnit('parent', () => {
      rootNode = currentUnit();
      useChildren(source);
    });
    mountRoot(parent);
    const node = rootNode as UnitNode;
    await flush();
    expect(node.children.map((child) => child.name)).toEqual(['childA']);
    expect(log).toEqual(['setup:childA:p1']);

    source.value = [
      { key: 'a', recipe: childA, props: { v: 'p1' } },
      { key: 'b', recipe: childB, props: { v: 'p2' } },
    ];
    await flush();
    expect(node.children.map((child) => child.name)).toEqual(['childA', 'childB']);
    expect(log).toEqual(['setup:childA:p1', 'setup:childB:p2']);

    source.value = [
      { key: 'a', recipe: childA, props: { v: 'p1-next' } },
      { key: 'b', recipe: childB, props: { v: 'p2' } },
    ];
    await flush();
    expect(node.children).toHaveLength(2);
    expect(node.children[0]?.props).toMatchObject({ v: 'p1-next' });
    expect(log).toEqual(['setup:childA:p1', 'setup:childB:p2']);

    source.value = [
      { key: 'a', recipe: childB, props: { v: 'p1-next' } },
      { key: 'b', recipe: childB, props: { v: 'p2' } },
    ];
    await flush();
    expect(node.children.map((child) => child.name)).toEqual(['childB', 'childB']);
    expect(log).toEqual([
      'setup:childA:p1',
      'setup:childB:p2',
      'cleanup:childA:p1',
      'setup:childB:p1-next',
    ]);

    source.value = [null, { key: 'b', recipe: childB, props: { v: 'p2' } }];
    await flush();
    expect(node.children.map((child) => child.name)).toEqual(['childB']);
    expect(node.children[0]?.props).toMatchObject({ v: 'p2' });

    source.value = [];
    await flush();
    expect(node.children).toHaveLength(0);
    expect(log.filter((entry) => entry.startsWith('cleanup:'))).toEqual([
      'cleanup:childA:p1',
      'cleanup:childB:p1-next',
      'cleanup:childB:p2',
    ]);
  });

  it('reports duplicate child keys as unit.error and mounts nothing', async () => {
    const errors: UnitErrorEvent[] = [];
    const child = createUnit('child', () => {});
    let rootNode: UnitNode | undefined;
    const parent = createUnit('parent', () => {
      rootNode = currentUnit();
      useOn<UnitErrorEvent>('unit.error', (event) => {
        errors.push(event);
      });
      useChildren([
        { key: 'a', recipe: child },
        { key: 'a', recipe: child },
      ]);
    });
    const handle = mountRoot(parent);
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.unit).toBe('parent');
    expect(String(errors[0]?.error)).toContain("duplicate child key 'a' in unit 'parent'");
    expect((rootNode as UnitNode).children).toHaveLength(0);
    expect(handle.state).toBe('active');
    await handle.unmount();
  });

  it('keeps setup props reactive across handle.update', async () => {
    const seen: number[] = [];
    const probe = createUnit<{ n: number }>('probe', (props) => {
      watch(
        () => props.n,
        (next) => {
          seen.push(next);
        },
        { immediate: true },
      );
    });
    const handle = mountRoot(probe, { n: 1 });
    expect(seen).toEqual([1]);
    handle.update({ n: 2 });
    await flush();
    expect(seen).toEqual([1, 2]);
    await handle.unmount();
  });
});

describe('collection fold', () => {
  it('folds along the parent chain ordered by priority then insertion order', () => {
    const tools = createCollection<string>('tools');
    const child = createUnit('child', () => {
      useContribute(tools, 'child-mid', 3);
      useContribute(tools, 'child-first', 1);
    });
    const sibling = createUnit('sibling', () => {
      useContribute(tools, 'sibling-only', 0);
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      useContribute(tools, 'root-low', 5);
      useContribute(tools, 'root-high', 1);
    });
    mountRoot(root);
    const node = rootNode as UnitNode;
    const childUnit = node.mount(child, undefined);
    node.mount(sibling, undefined);
    expect(childUnit.fold(tools)).toEqual(['root-high', 'child-first', 'child-mid', 'root-low']);
    expect(node.fold(tools)).toEqual(['root-high', 'root-low']);
  });

  it('tracks register and withdraw reactively through useCollection', async () => {
    const tools = createCollection<string>('tools-live');
    let live: ComputedRef<readonly string[]> | undefined;
    const child = createUnit('child', () => {
      live = useCollection(tools);
    });
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const childUnit = (rootNode as UnitNode).mount(child, undefined);
    expect(live?.value).toEqual([]);
    const withdraw = childUnit.register(tools, 'late', 0);
    expect(live?.value).toEqual(['late']);
    withdraw();
    expect(live?.value).toEqual([]);
    await handle.unmount();
  });
});

describe('events', () => {
  it('delivers events from the firing unit up through its ancestors', () => {
    const seq: string[] = [];
    const grand = createUnit('grand', () => {
      useOn('e', () => {
        seq.push('grand');
      });
    });
    const child = createUnit('child', () => {
      useOn('e', () => {
        seq.push('child');
      });
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      useOn('e', () => {
        seq.push('root');
      });
    });
    mountRoot(root);
    const node = rootNode as UnitNode;
    const childUnit = node.mount(child, undefined);
    const grandUnit = childUnit.mount(grand, undefined);
    grandUnit.fire({ type: 'e' });
    expect(seq).toEqual(['grand', 'child', 'root']);
  });

  it('merges EventContext down the lineage with deeper and explicit fields winning', () => {
    const seen: Array<Record<string, unknown>> = [];
    const leaf = createUnit('leaf', () => {
      useContribute(EventContext, { feature: 'todo', shared: 'leaf', depth: 'leaf' });
    });
    const mid = createUnit('mid', () => {
      useContribute(EventContext, { sessionId: 's1', shared: 'mid' });
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      useContribute(EventContext, { agentId: 'a1', shared: 'root', depth: 'root' });
      useOn('e', (event) => {
        seen.push(event);
      });
    });
    mountRoot(root);
    const midUnit = (rootNode as UnitNode).mount(mid, undefined);
    const leafUnit = midUnit.mount(leaf, undefined);
    leafUnit.fire({ type: 'e', shared: 'explicit', extra: 1 });
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

  it('delivers events to wildcard handlers and honors unsubscribe', async () => {
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const node = rootNode as UnitNode;
    const types: string[] = [];
    let plainCount = 0;
    node.listen('*', (event) => {
      types.push(event.type);
    });
    const unsubscribe = node.listen('e', () => {
      plainCount += 1;
    });
    node.fire({ type: 'e' });
    node.fire({ type: 'other' });
    expect(types).toEqual(['e', 'other']);
    expect(plainCount).toBe(1);
    unsubscribe();
    node.fire({ type: 'e' });
    expect(plainCount).toBe(1);
    expect(types).toEqual(['e', 'other', 'e']);
    await handle.unmount();
  });

  it('delivers events fired during mounting once the unit becomes active', () => {
    const seen: string[] = [];
    const child = createUnit('child', () => {
      const fire = useFire();
      fire({ type: 'child-ready' });
    });
    let rootNode: UnitNode | undefined;
    const root = createUnit('root', () => {
      rootNode = currentUnit();
      useOn('self-ready', () => {
        seen.push('self');
      });
      useOn('child-ready', () => {
        seen.push('heard');
      });
      const fire = useFire();
      fire({ type: 'self-ready' });
    });
    mountRoot(root);
    expect(seen).toEqual(['self']);
    (rootNode as UnitNode).mount(child, undefined);
    expect(seen).toEqual(['self', 'heard']);
  });

  it('removes useOn handlers when the unit unmounts', async () => {
    let calls = 0;
    const child = createUnit('child', () => {
      useOn('e', () => {
        calls += 1;
      });
    });
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const childUnit = (rootNode as UnitNode).mount(child, undefined);
    childUnit.fire({ type: 'e' });
    expect(calls).toBe(1);
    await childUnit.dispose();
    childUnit.fire({ type: 'e' });
    expect(calls).toBe(1);
    await handle.unmount();
  });

  it('reports a throwing event handler as unit.error', async () => {
    const errors: UnitErrorEvent[] = [];
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
      useOn<UnitErrorEvent>('unit.error', (event) => {
        errors.push(event);
      });
    }));
    const node = rootNode as UnitNode;
    node.listen('e', () => {
      throw new Error('handler-boom');
    });
    node.fire({ type: 'e' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.unit).toBe('root');
    expect(String(errors[0]?.error)).toContain('handler-boom');
    await handle.unmount();
  });

  it('removes once listeners after their first invocation', async () => {
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const node = rootNode as UnitNode;
    let plainCount = 0;
    let wildcardCount = 0;
    node.listen('e', () => {
      plainCount += 1;
    }, { once: true });
    node.listen('*', () => {
      wildcardCount += 1;
    }, { once: true });
    node.fire({ type: 'e' });
    node.fire({ type: 'e' });
    expect(plainCount).toBe(1);
    expect(wildcardCount).toBe(1);
    await handle.unmount();
  });

  it('removes a once listener even when its handler throws', async () => {
    const errors: UnitErrorEvent[] = [];
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
      useOn<UnitErrorEvent>('unit.error', (event) => {
        errors.push(event);
      });
    }));
    const node = rootNode as UnitNode;
    let calls = 0;
    node.listen('e', () => {
      calls += 1;
      throw new Error('once-boom');
    }, { once: true });
    node.fire({ type: 'e' });
    node.fire({ type: 'e' });
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.error)).toContain('once-boom');
    await handle.unmount();
  });

  it('resolves wait with the enriched event only when match passes', async () => {
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
      useContribute(EventContext, { sessionId: 's1' });
    }));
    const node = rootNode as UnitNode;
    const pending = node.wait('e', { match: (event) => event['extra'] === 2 });
    node.fire({ type: 'e', extra: 1 });
    node.fire({ type: 'e', extra: 2 });
    const event = await pending;
    expect(event).toEqual({ type: 'e', sessionId: 's1', extra: 2 });
    await handle.unmount();
  });

  it('rejects wait on timeout, external abort, and unit unmount', async () => {
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const node = rootNode as UnitNode;
    await expect(node.wait('never', { timeoutMs: 10 })).rejects.toThrow('wait timed out after 10ms');
    const controller = new AbortController();
    const bySignal = node.wait('never', { signal: controller.signal });
    controller.abort(new Error('stop-waiting'));
    await expect(bySignal).rejects.toThrow('stop-waiting');
    const byUnmount = node.wait('never');
    await handle.unmount();
    await expect(byUnmount).rejects.toThrow("unit 'root' is unmounted");
  });

  it('useWait waits for a matching event from within a unit setup', async () => {
    let pending: Promise<RuntimeEvent> | undefined;
    const child = createUnit('child', () => {
      pending = useWait('ready');
    });
    let rootNode: UnitNode | undefined;
    const handle = mountRoot(createUnit('root', () => {
      rootNode = currentUnit();
    }));
    const childUnit = (rootNode as UnitNode).mount(child, undefined);
    childUnit.fire({ type: 'ready' });
    await expect(pending).resolves.toMatchObject({ type: 'ready' });
    await handle.unmount();
  });
});
