import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di';
import {
  InstantiationType,
  _clearRegistryForTests,
  getSingletonServiceDescriptors,
} from '#/_base/di';
import { createDecorator } from '#/_base/di';
import { LifecycleScope } from '#/scope/lifecycle';
import {
  _resetScopeRegistryForTests,
  getScopedServiceDescriptors,
  isBuilt,
  markBuilt,
  registerScopedService,
} from '#/scope/registry';

interface IGreeter {
  greet(): string;
}

class GreeterA implements IGreeter {
  greet(): string {
    return 'a';
  }
}

class GreeterB implements IGreeter {
  greet(): string {
    return 'b';
  }
}

describe('ScopeRegistry / registerScopedService', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetScopeRegistryForTests();
    _clearRegistryForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    _resetScopeRegistryForTests();
    _clearRegistryForTests();
  });

  it('register + getScopedServiceDescriptors returns the descriptor', () => {
    const IGreeterId = createDecorator<IGreeter>('p11-greeter-register');

    registerScopedService(
      LifecycleScope.Session,
      IGreeterId,
      GreeterA,
      InstantiationType.Delayed,
    );

    const entries = getScopedServiceDescriptors(LifecycleScope.Session);
    expect(entries).toHaveLength(1);
    const [id, descriptor] = entries[0]!;
    expect(id).toBe(IGreeterId);
    expect(descriptor).toBeInstanceOf(SyncDescriptor);
    expect(descriptor.ctor).toBe(GreeterA);
    // Delayed → supportsDelayedInstantiation === true.
    expect(descriptor.supportsDelayedInstantiation).toBe(true);
    // Lazy: registration never instantiates the ctor.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Core alias routes to registerSingleton (visible via getSingletonServiceDescriptors)', () => {
    const IGreeterId = createDecorator<IGreeter>('p11-greeter-core');

    registerScopedService(
      LifecycleScope.Core,
      IGreeterId,
      GreeterA,
      InstantiationType.Eager,
    );

    // Core does NOT go into the scoped registry.
    expect(getScopedServiceDescriptors(LifecycleScope.Core)).toHaveLength(0);

    const singletons = getSingletonServiceDescriptors();
    expect(singletons).toHaveLength(1);
    const [id, descriptor] = singletons[0]!;
    expect(id).toBe(IGreeterId);
    expect(descriptor).toBeInstanceOf(SyncDescriptor);
    expect(descriptor.ctor).toBe(GreeterA);
    // Eager (registerSingleton default mapping) → supportsDelayedInstantiation === false.
    expect(descriptor.supportsDelayedInstantiation).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('duplicate registration is last-write-wins and warns', () => {
    const IGreeterId = createDecorator<IGreeter>('p11-greeter-dup');

    registerScopedService(
      LifecycleScope.Agent,
      IGreeterId,
      GreeterA,
      InstantiationType.Delayed,
    );
    registerScopedService(
      LifecycleScope.Agent,
      IGreeterId,
      GreeterB,
      InstantiationType.Delayed,
    );

    const entries = getScopedServiceDescriptors(LifecycleScope.Agent);
    expect(entries).toHaveLength(1);
    expect(entries[0]![1].ctor).toBe(GreeterB); // last write wins
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/duplicate registration/);
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/last write wins/);
  });

  it('duplicate registration with { replace: true } is silent', () => {
    const IGreeterId = createDecorator<IGreeter>('p11-greeter-replace');

    registerScopedService(
      LifecycleScope.Agent,
      IGreeterId,
      GreeterA,
      InstantiationType.Delayed,
    );
    registerScopedService(
      LifecycleScope.Agent,
      IGreeterId,
      GreeterB,
      InstantiationType.Delayed,
      { replace: true },
    );

    const entries = getScopedServiceDescriptors(LifecycleScope.Agent);
    expect(entries).toHaveLength(1);
    expect(entries[0]![1].ctor).toBe(GreeterB);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('registration after markBuilt() warns and is ignored', () => {
    const IGreeterId = createDecorator<IGreeter>('p11-greeter-late');

    expect(isBuilt()).toBe(false);
    markBuilt();
    expect(isBuilt()).toBe(true);

    registerScopedService(
      LifecycleScope.Turn,
      IGreeterId,
      GreeterA,
      InstantiationType.Delayed,
    );

    // Ignored: never reaches the registry.
    expect(getScopedServiceDescriptors(LifecycleScope.Turn)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/after the first/);
  });

  it('keeps multiple scopes isolated', () => {
    const IGreeterId = createDecorator<IGreeter>('p11-greeter-isolation');

    registerScopedService(
      LifecycleScope.Session,
      IGreeterId,
      GreeterA,
      InstantiationType.Delayed,
    );

    expect(getScopedServiceDescriptors(LifecycleScope.Session)).toHaveLength(1);
    expect(getScopedServiceDescriptors(LifecycleScope.Agent)).toHaveLength(0);
    expect(getScopedServiceDescriptors(LifecycleScope.Turn)).toHaveLength(0);
    expect(getScopedServiceDescriptors(LifecycleScope.ToolCall)).toHaveLength(0);
  });

  it('getScopedServiceDescriptors for an untouched scope is empty', () => {
    expect(getScopedServiceDescriptors(LifecycleScope.ToolCall)).toEqual([]);
  });

  it('LifecycleScope exposes the five scopes', () => {
    expect(LifecycleScope.Core).toBe('core');
    expect(LifecycleScope.Session).toBe('session');
    expect(LifecycleScope.Agent).toBe('agent');
    expect(LifecycleScope.Turn).toBe('turn');
    expect(LifecycleScope.ToolCall).toBe('toolCall');
  });
});
