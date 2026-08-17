import { describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { SharedRuntimeUnitHostFactory, type RuntimeProviderHost, type RuntimeUnitImports } from '#/runtime/runtimeUnitHost';

interface IValue {
  readonly value: string;
}

const IRoot = createDecorator<IValue>('runtimeUnitHost.root');
const IHidden = createDecorator<IValue>('runtimeUnitHost.hidden');
const ILocal = createDecorator<IValue>('runtimeUnitHost.local');
const IDependent = createDecorator<IValue>('runtimeUnitHost.dependent');
const IFirst = createDecorator<IValue>('runtimeUnitHost.first');
const ISecond = createDecorator<IValue>('runtimeUnitHost.second');

const emptyImports = (): RuntimeUnitImports => ({ root: [], imports: [], local: [] });

class RootUnit implements IValue {
  readonly value: string;
  constructor(@IRoot root: IValue) {
    this.value = root.value;
  }
}

class HiddenUnit implements IValue {
  readonly value: string;
  constructor(@IHidden hidden: IValue) {
    this.value = hidden.value;
  }
}

class LocalUnit implements IValue {
  readonly value = 'local';
}

class DependentUnit implements IValue {
  readonly value: string;
  constructor(@ILocal local: IValue) {
    this.value = local.value;
  }
}

function runtime(generation: string, runtimeId = 'local'): FakeRuntime {
  return new FakeRuntime(
    { workspaceId: 'workspace', runtimeId, generation },
    { capabilities: [] },
  );
}

function setup() {
  const disposables = new DisposableStore();
  const root = createServices(disposables, {
    additionalServices: (services) => {
      services.defineInstance(IRoot, { value: 'root' });
      services.defineInstance(IHidden, { value: 'hidden' });
    },
  });
  const registry = new RuntimeRegistry('workspace');
  const host = new SharedRuntimeUnitHostFactory().create(root, registry);
  return { disposables, host, registry, root };
}

describe('RuntimeUnitHost', () => {
  it('separates root, imported, and local dependencies and hides raw DI APIs', async () => {
    const { disposables, host } = setup();
    const producer = await host.provide(
      { root: [IRoot], imports: [], local: [ILocal] },
      async (provider) => {
        expect(provider.get(IRoot).value).toBe('root');
        expect(() => provider.get(IHidden)).toThrow('not declared');
        expect(provider.provide(ILocal, LocalUnit).value).toBe('local');
        expect('accessor' in provider).toBe(false);
        expect('container' in provider).toBe(false);
        expect('instantiation' in provider).toBe(false);
        return { dispose: () => {} };
      },
    );
    const consumer = await host.provide(
      { root: [], imports: [ILocal], local: [IDependent] },
      async (provider) => {
        expect(provider.provide(IDependent, DependentUnit).value).toBe('local');
        return { dispose: () => {} };
      },
    );
    await expect(host.provide(
      { root: [IRoot], imports: [], local: [IDependent] },
      async (provider) => {
        provider.provide(IDependent, HiddenUnit);
        return { dispose: () => {} };
      },
    )).rejects.toThrow('not declared');
    await consumer.remove();
    await producer.remove();
    await host.dispose();
    disposables.dispose();
  });

  it('rolls back failed async updates and only publishes prepared generations', async () => {
    const { disposables, host, registry } = setup();
    const first = runtime('one');
    const handle = await host.provide(emptyImports(), async (provider) => {
      provider.registerRuntime(first);
      return { dispose: () => {} };
    });
    const failed = runtime('failed');
    await expect(handle.update(emptyImports(), async (provider) => {
      provider.registerRuntime(failed);
      await Promise.resolve();
      throw new Error('prepare failed');
    })).rejects.toThrow('prepare failed');
    expect(registry.current('local')).toBe(first);
    expect(failed.disposed).toBe(true);
    const second = runtime('two');
    await handle.update(emptyImports(), async (provider) => {
      provider.registerRuntime(second);
      return { dispose: () => {} };
    });
    expect(registry.current('local')).toBe(second);
    expect(first.disposed).toBe(true);
    await handle.remove();
    expect(registry.current('local')).toBeUndefined();
    await host.dispose();
    disposables.dispose();
  });

  it('publishes every replacement before reporting previous generation cleanup failures', async () => {
    const { disposables, host, registry } = setup();
    const firstLocal = runtime('one-local');
    const firstRemote = runtime('one-remote', 'remote');
    Object.assign(firstRemote, {
      dispose: async () => {
        firstRemote.disposed = true;
        throw new Error('remote cleanup failed');
      },
    });
    const handle = await host.provide(emptyImports(), async (provider) => {
      provider.registerRuntime(firstLocal);
      provider.registerRuntime(firstRemote);
      return { dispose: () => {} };
    });
    const secondLocal = runtime('two-local');
    const secondRemote = runtime('two-remote', 'remote');

    await expect(handle.update(emptyImports(), async (provider) => {
      provider.registerRuntime(secondLocal);
      provider.registerRuntime(secondRemote);
      return { dispose: () => {} };
    })).rejects.toThrow('remote cleanup failed');

    expect(registry.current('local')).toBe(secondLocal);
    expect(registry.current('remote')).toBe(secondRemote);
    const localLease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'local' });
    const remoteLease = registry.acquire({ workspaceId: 'workspace', runtimeId: 'remote' });
    expect(localLease.runtime).toBe(secondLocal);
    expect(remoteLease.runtime).toBe(secondRemote);
    expect(secondLocal.disposed).toBe(false);
    expect(secondRemote.disposed).toBe(false);
    expect(firstLocal.disposed).toBe(true);
    expect(firstRemote.disposed).toBe(true);
    localLease.dispose();
    remoteLease.dispose();
    await handle.remove();
    expect(secondLocal.disposed).toBe(true);
    expect(secondRemote.disposed).toBe(true);
    await host.dispose();
    disposables.dispose();
  });

  it('enforces handle ownership on removal', async () => {
    const first = setup();
    const second = setup();
    const handle = await first.host.provide(emptyImports(), async (provider) => {
      provider.registerRuntime(runtime('one'));
      return { dispose: () => {} };
    });
    await expect(second.host.remove(handle)).rejects.toThrow('not owned');
    expect(first.registry.current('local')).toBeDefined();
    await first.host.remove(handle);
    expect(first.registry.current('local')).toBeUndefined();
    await Promise.all([first.host.dispose(), second.host.dispose()]);
    first.disposables.dispose();
    second.disposables.dispose();
  });

  it('allows an attachment to remove its owned registration during host teardown', async () => {
    const { disposables, host, registry } = setup();
    const handle = await host.provide(emptyImports(), async (provider) => {
      const registration = provider.registerRuntime(runtime('one'));
      return { dispose: () => registration.remove() };
    });

    await handle.remove();
    expect(registry.current('local')).toBeUndefined();
    await host.dispose();
    disposables.dispose();
  });

  it('publishes runtimes registered by a committed attachment and owns their teardown', async () => {
    const { disposables, host, registry } = setup();
    let providerHost!: RuntimeProviderHost;
    const handle = await host.provide(emptyImports(), async (provider) => {
      providerHost = provider;
      return { dispose: () => {} };
    });

    const first = runtime('one');
    const registration = providerHost.registerRuntime(first);
    expect(registry.current('local')).toBe(first);
    await registration.remove();
    expect(registry.current('local')).toBeUndefined();
    expect(first.disposed).toBe(true);

    const second = runtime('two', 'dynamic');
    providerHost.registerRuntime(second);
    expect(registry.current('dynamic')).toBe(second);
    await handle.remove();
    expect(registry.current('dynamic')).toBeUndefined();
    expect(second.disposed).toBe(true);
    await host.dispose();
    disposables.dispose();
  });

  it('waits for in-flight prepare, rejects new transactions, and tears down in reverse order', async () => {
    const { disposables, host } = setup();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    class Unit implements IValue {
      readonly value: string;
      constructor(value: string) {
        this.value = value;
      }
      async dispose(): Promise<void> {
        await Promise.resolve();
        order.push(this.value);
      }
    }
    const providing = host.provide(
      { root: [], imports: [], local: [IFirst, ISecond] },
      async (provider) => {
        provider.provide(IFirst, Unit, 'first');
        provider.provide(ISecond, Unit, 'second');
        await ready;
        return { dispose: async () => { await Promise.resolve(); order.push('attachment'); } };
      },
    );
    await Promise.resolve();
    const closing = host.dispose();
    await expect(host.provide(emptyImports(), async () => ({ dispose: () => {} }))).rejects.toThrow('disposed');
    expect(order).toEqual([]);
    release?.();
    await providing;
    await closing;
    expect(order).toEqual(['attachment', 'second', 'first']);
    disposables.dispose();
  });

  it('exposes only the restricted provider host compile surface', () => {
    const keys: Record<keyof RuntimeProviderHost, true> = {
      get: true,
      provide: true,
      registerRuntime: true,
    };
    expect(Object.keys(keys).toSorted()).toEqual(['get', 'provide', 'registerRuntime']);
  });
});
