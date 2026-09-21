import { describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { Environment } from '#/environment/environment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { fakeEnvironment } from './stubs';
import { SharedEnvironmentUnitHostFactory, type EnvironmentProviderHost, type EnvironmentUnitImports } from '#/environment/environmentUnitHost';

interface IValue {
  readonly value: string;
}

const IRoot = createDecorator<IValue>('environmentUnitHost.root');
const IHidden = createDecorator<IValue>('environmentUnitHost.hidden');

const emptyImports = (): EnvironmentUnitImports => ({ root: [] });

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
  async function provideHost() {
    const { disposables, host, registry } = setup();
    let providerHost!: EnvironmentProviderHost;
    const handle = await host.provide(emptyImports(), async (provider) => {
      providerHost = provider;
      return { dispose: () => {} };
    });
    return {
      registry,
      providerHost,
      handle,
      dispose: async () => {
        await host.dispose();
        disposables.dispose();
      },
    };
  }

  it('exposes declared root dependencies and hides raw DI APIs', async () => {
    const { disposables, host } = setup();
    const handle = await host.provide(
      { root: [IRoot] },
      async (provider) => {
        expect(provider.get(IRoot).value).toBe('root');
        expect(() => provider.get(IHidden)).toThrow('not declared');
        expect('accessor' in provider).toBe(false);
        expect('container' in provider).toBe(false);
        expect('instantiation' in provider).toBe(false);
        return { dispose: () => {} };
      },
    );
    await handle.remove();
    await host.dispose();
    disposables.dispose();
  });

  it('rolls back a failed prepare without publishing', async () => {
    const { disposables, host, registry } = setup();
    const failed = environment('failed');
    await expect(host.provide(emptyImports(), async (provider) => {
      provider.registerEnvironment(failed);
      await Promise.resolve();
      throw new Error('prepare failed');
    })).rejects.toThrow('prepare failed');
    expect(registry.current('local')).toBeUndefined();
    expect(failed.disposed).toBe(true);
    await host.dispose();
    disposables.dispose();
  });

  it('publishes a replacement before reporting the previous generation cleanup failure', async () => {
    const { disposables, host, registry } = setup();
    const first = environment('one');
    Object.assign(first, {
      dispose: async () => {
        first.disposed = true;
        throw new Error('cleanup failed');
      },
    });
    let registration!: { update(prepare: () => Environment | Promise<Environment>): Promise<void>; remove(): Promise<void> };
    const handle = await host.provide(emptyImports(), async (provider) => {
      registration = provider.registerEnvironment(first);
      return { dispose: () => {} };
    });
    const second = environment('two');

    await expect(registration.update(() => second)).rejects.toThrow('cleanup failed');

    expect(registry.current('local')).toBe(second);
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'local' });
    expect(lease.environment).toBe(second);
    expect(second.disposed).toBe(false);
    expect(first.disposed).toBe(true);
    lease.dispose();
    await handle.remove();
    expect(second.disposed).toBe(true);
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
    const { registry, providerHost, handle, dispose } = await provideHost();

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
    await dispose();
  });

  it('re-registers the same environment id after its registration was removed', async () => {
    const { registry, providerHost, handle, dispose } = await provideHost();

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
    await dispose();
  });

  it('re-registers the same environment id even when removal teardown fails', async () => {
    const { registry, providerHost, handle, dispose } = await provideHost();

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
    await dispose();
  });

  it('waits for in-flight prepare, rejects new transactions, and tears down the attachment', async () => {
    const { disposables, host } = setup();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    await host.provide(
      emptyImports(),
      async () => ({ dispose: async () => { await Promise.resolve(); order.push('first'); } }),
    );
    const second = host.provide(
      emptyImports(),
      async () => {
        await ready;
        return { dispose: async () => { await Promise.resolve(); order.push('second'); } };
      },
    );
    await Promise.resolve();
    const closing = host.dispose();
    await expect(host.provide(emptyImports(), async () => ({ dispose: () => {} }))).rejects.toThrow('disposed');
    expect(order).toEqual([]);
    release?.();
    await Promise.all([second, closing]);
    expect(order).toEqual(['second', 'first']);
    disposables.dispose();
  });

  it('exposes only the restricted provider host compile surface', () => {
    const keys: Record<keyof EnvironmentProviderHost, true> = {
      get: true,
      registerEnvironment: true,
    };
    expect(Object.keys(keys).toSorted()).toEqual(['get', 'registerEnvironment']);
  });
});
