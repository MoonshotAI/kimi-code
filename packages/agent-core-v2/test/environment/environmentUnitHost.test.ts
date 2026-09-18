import { describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { fakeEnvironment } from './stubs';
import { SharedEnvironmentUnitHostFactory, type EnvironmentProviderHost, type EnvironmentUnitImports } from '#/environment/environmentUnitHost';

interface IValue {
  readonly value: string;
}

const IRoot = createDecorator<IValue>('environmentUnitHost.root');
const IHidden = createDecorator<IValue>('environmentUnitHost.hidden');
const ILocal = createDecorator<IValue>('environmentUnitHost.local');
const IDependent = createDecorator<IValue>('environmentUnitHost.dependent');
const IFirst = createDecorator<IValue>('environmentUnitHost.first');
const ISecond = createDecorator<IValue>('environmentUnitHost.second');

const emptyImports = (): EnvironmentUnitImports => ({ root: [], imports: [], local: [] });

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

function environment(generation: string, environmentId = 'local'): FakeEnvironment {
  return fakeEnvironment(environmentId, generation, { capabilities: [] });
}

function setup() {
  const disposables = new DisposableStore();
  const root = createServices(disposables, {
    additionalServices: (services) => {
      services.defineInstance(IRoot, { value: 'root' });
      services.defineInstance(IHidden, { value: 'hidden' });
    },
  });
  const registry = new EnvironmentRegistry('workspace');
  const host = new SharedEnvironmentUnitHostFactory().create(root, registry);
  return { disposables, host, registry, root };
}

describe('EnvironmentUnitHost', () => {
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
    const first = environment('one');
    const handle = await host.provide(emptyImports(), async (provider) => {
      provider.registerEnvironment(first);
      return { dispose: () => {} };
    });
    const failed = environment('failed');
    await expect(handle.update(emptyImports(), async (provider) => {
      provider.registerEnvironment(failed);
      await Promise.resolve();
      throw new Error('prepare failed');
    })).rejects.toThrow('prepare failed');
    expect(registry.current('local')).toBe(first);
    expect(failed.disposed).toBe(true);
    const second = environment('two');
    await handle.update(emptyImports(), async (provider) => {
      provider.registerEnvironment(second);
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
    const firstLocal = environment('one-local');
    const firstRemote = environment('one-remote', 'remote');
    Object.assign(firstRemote, {
      dispose: async () => {
        firstRemote.disposed = true;
        throw new Error('remote cleanup failed');
      },
    });
    const handle = await host.provide(emptyImports(), async (provider) => {
      provider.registerEnvironment(firstLocal);
      provider.registerEnvironment(firstRemote);
      return { dispose: () => {} };
    });
    const secondLocal = environment('two-local');
    const secondRemote = environment('two-remote', 'remote');

    await expect(handle.update(emptyImports(), async (provider) => {
      provider.registerEnvironment(secondLocal);
      provider.registerEnvironment(secondRemote);
      return { dispose: () => {} };
    })).rejects.toThrow('remote cleanup failed');

    expect(registry.current('local')).toBe(secondLocal);
    expect(registry.current('remote')).toBe(secondRemote);
    const localLease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    const remoteLease = registry.acquire({ workspaceId: 'workspace', environmentId: 'remote' });
    expect(localLease.environment).toBe(secondLocal);
    expect(remoteLease.environment).toBe(secondRemote);
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
      provider.registerEnvironment(environment('one'));
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
      const registration = provider.registerEnvironment(environment('one'));
      return { dispose: () => registration.remove() };
    });

    await handle.remove();
    expect(registry.current('local')).toBeUndefined();
    await host.dispose();
    disposables.dispose();
  });

  it('publishes environments registered by a committed attachment and owns their teardown', async () => {
    const { disposables, host, registry } = setup();
    let providerHost!: EnvironmentProviderHost;
    const handle = await host.provide(emptyImports(), async (provider) => {
      providerHost = provider;
      return { dispose: () => {} };
    });

    const first = environment('one');
    const registration = providerHost.registerEnvironment(first);
    expect(registry.current('local')).toBe(first);
    await registration.remove();
    expect(registry.current('local')).toBeUndefined();
    expect(first.disposed).toBe(true);

    const second = environment('two', 'dynamic');
    providerHost.registerEnvironment(second);
    expect(registry.current('dynamic')).toBe(second);
    await handle.remove();
    expect(registry.current('dynamic')).toBeUndefined();
    expect(second.disposed).toBe(true);
    await host.dispose();
    disposables.dispose();
  });

  it('re-registers the same environment id after its registration was removed', async () => {
    const { disposables, host, registry } = setup();
    let providerHost!: EnvironmentProviderHost;
    const handle = await host.provide(emptyImports(), async (provider) => {
      providerHost = provider;
      return { dispose: () => {} };
    });

    const first = environment('one');
    const registration = providerHost.registerEnvironment(first);
    await registration.remove();
    expect(registry.current('local')).toBeUndefined();

    const second = environment('two');
    providerHost.registerEnvironment(second);
    expect(registry.current('local')).toBe(second);

    await handle.remove();
    expect(registry.current('local')).toBeUndefined();
    expect(second.disposed).toBe(true);
    await host.dispose();
    disposables.dispose();
  });

  it('re-registers the same environment id even when removal teardown fails', async () => {
    const { disposables, host, registry } = setup();
    let providerHost!: EnvironmentProviderHost;
    const handle = await host.provide(emptyImports(), async (provider) => {
      providerHost = provider;
      return { dispose: () => {} };
    });

    const failing = environment('one');
    failing.dispose = () => {
      throw new Error('boom');
    };
    const registration = providerHost.registerEnvironment(failing);
    await expect(registration.remove()).rejects.toThrow('boom');
    expect(registry.current('local')).toBeUndefined();

    const second = environment('two');
    providerHost.registerEnvironment(second);
    expect(registry.current('local')).toBe(second);

    await handle.remove();
    expect(registry.current('local')).toBeUndefined();
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
    const keys: Record<keyof EnvironmentProviderHost, true> = {
      get: true,
      provide: true,
      registerEnvironment: true,
    };
    expect(Object.keys(keys).toSorted()).toEqual(['get', 'provide', 'registerEnvironment']);
  });
});
