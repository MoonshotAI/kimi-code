import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di';
import {
  InstantiationType,
  _clearRegistryForTests,
  getSingletonServiceDescriptors,
} from '#/_base/di';
import { InstantiationService } from '#/_base/di';
import { ServiceCollection } from '#/_base/di';
import { SessionScopeBuilder } from '#/scope/builder';
import { ISessionContext } from '#/scope/context/index';
import { LifecycleScope } from '#/scope/lifecycle';
import {
  _resetScopeRegistryForTests,
  getScopedServiceDescriptors,
  registerScopedService,
} from '#/scope/registry';
import { ILogService } from '#/services/logger/logger';

/**
 * Minimal `ILogService` implementation used to drive the scope-mechanism
 * migration test. It records every call so the "behavior unchanged" case can
 * assert the contract still holds after the registration path changes.
 *
 * Note: agent-core deliberately ships no production `ILogService` adapter —
 * the server wires `PinoLogger` via `services.set(ILogService, ...)` (see
 * `src/services/AGENTS.md`: "adapter lives in server"). Because there is no
 * pre-existing `registerSingleton(ILogService, ...)` to migrate, this test
 * validates the target state directly: `registerScopedService(Core,
 * ILogService, ...)` registers + resolves identically to the singleton alias.
 */
class FakeLogService implements ILogService {
  declare readonly _serviceBrand: undefined;

  static constructed = 0;
  static lastInstance: FakeLogService | undefined;

  readonly calls: Array<{
    level: 'info' | 'warn' | 'error' | 'debug';
    obj: object | string;
    msg?: string;
  }> = [];

  constructor(private readonly bindings: object = {}) {
    FakeLogService.constructed += 1;
    FakeLogService.lastInstance = this;
  }

  info(obj: object | string, msg?: string): void {
    this.calls.push({ level: 'info', obj, msg });
  }

  warn(obj: object | string, msg?: string): void {
    this.calls.push({ level: 'warn', obj, msg });
  }

  error(obj: object | string, msg?: string): void {
    this.calls.push({ level: 'error', obj, msg });
  }

  debug(obj: object | string, msg?: string): void {
    this.calls.push({ level: 'debug', obj, msg });
  }

  child(bindings: object): ILogService {
    return new FakeLogService({ ...this.bindings, ...bindings });
  }
}

function sessionContext(id: string): ISessionContext {
  return {
    id,
    abortSignal: new AbortController().signal,
    executionScope: undefined,
  };
}

describe('ILogService → registerScopedService(Core, …)', () => {
  beforeEach(() => {
    _resetScopeRegistryForTests();
    _clearRegistryForTests();
    FakeLogService.constructed = 0;
    FakeLogService.lastInstance = undefined;

    registerScopedService(
      LifecycleScope.Core,
      ILogService,
      FakeLogService,
      InstantiationType.Delayed,
    );
  });

  afterEach(() => {
    _resetScopeRegistryForTests();
    _clearRegistryForTests();
  });

  it('Core alias routes ILogService to the singleton registry (not the scoped registry)', () => {
    // Core never touches the scoped registry — it aliases to registerSingleton.
    expect(getScopedServiceDescriptors(LifecycleScope.Core)).toHaveLength(0);

    const singletons = getSingletonServiceDescriptors();
    const entry = singletons.find(([id]) => id === ILogService);
    expect(entry).toBeDefined();

    const [, descriptor] = entry!;
    expect(descriptor).toBeInstanceOf(SyncDescriptor);
    expect(descriptor.ctor).toBe(FakeLogService);
    // Delayed → supportsDelayedInstantiation === true.
    expect(descriptor.supportsDelayedInstantiation).toBe(true);

    // Resolves through a root (Core) container seeded from those descriptors.
    const root = new InstantiationService(
      new ServiceCollection(...getSingletonServiceDescriptors()),
    );
    const log = root.invokeFunction((accessor) => accessor.get(ILogService));
    log.info('core-alias');

    expect(FakeLogService.lastInstance).toBeInstanceOf(FakeLogService);
    expect(FakeLogService.lastInstance!.calls).toContainEqual({
      level: 'info',
      obj: 'core-alias',
      msg: undefined,
    });
  });

  it('ILogService behavior is unchanged (info/warn/error/debug + child bindings)', () => {
    const root = new InstantiationService(
      new ServiceCollection(...getSingletonServiceDescriptors()),
    );
    const log = root.invokeFunction((accessor) => accessor.get(ILogService));

    log.info('i');
    log.warn('w');
    log.error('e', 'extra');
    log.debug({ detail: true });

    const instance = FakeLogService.lastInstance!;
    expect(instance.calls.map((c) => c.level)).toEqual([
      'info',
      'warn',
      'error',
      'debug',
    ]);
    expect(instance.calls[2]).toEqual({
      level: 'error',
      obj: 'e',
      msg: 'extra',
    });

    // child() returns a working ILogService that records with merged bindings.
    const child = log.child({ sessionId: 'ses_x' }) as FakeLogService;
    child.info('child-call');
    expect(child).toBeInstanceOf(FakeLogService);
    expect(child.calls).toEqual([
      { level: 'info', obj: 'child-call', msg: undefined },
    ]);
  });

  it('ScopeBuilder-built Session scope resolves the Core ILogService through the DI parent chain', () => {
    const root = new InstantiationService(
      new ServiceCollection(...getSingletonServiceDescriptors()),
    );

    const session = new SessionScopeBuilder().build(root, sessionContext('s1'));
    expect(session.scope).toBe(LifecycleScope.Session);

    // The Session collection does not contain ILogService; resolution walks up
    // to the Core (root) container that the Pattern-1 registration seeded.
    const log = session.accessor.get(ILogService);
    log.warn('via-session-child');

    expect(FakeLogService.lastInstance).toBeInstanceOf(FakeLogService);
    expect(FakeLogService.lastInstance!.calls).toContainEqual({
      level: 'warn',
      obj: 'via-session-child',
      msg: undefined,
    });
  });

  it('registration is lazy: the Core ILogService is not constructed at build', () => {
    const root = new InstantiationService(
      new ServiceCollection(...getSingletonServiceDescriptors()),
    );

    // Building a scope on top does not realize the Delayed Core service.
    new SessionScopeBuilder().build(root, sessionContext('s1'));
    expect(FakeLogService.constructed).toBe(0);

    // First real use triggers exactly one construction.
    const log = root.invokeFunction((accessor) => accessor.get(ILogService));
    log.debug('realize');
    expect(FakeLogService.constructed).toBe(1);
  });
});
