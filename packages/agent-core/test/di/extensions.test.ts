import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor, InstantiationType } from '#/di/descriptors';
import {
  _clearRegistryForTests,
  getSingletonServiceDescriptors,
  registerSingleton,
} from '#/di/extensions';
import { createDecorator } from '#/di/instantiation';
import { InstantiationService } from '#/di/instantiationService';
import { ServiceCollection } from '#/di/serviceCollection';

describe('registerSingleton / getSingletonServiceDescriptors', () => {
  beforeEach(() => {
    _clearRegistryForTests();
  });
  afterEach(() => {
    _clearRegistryForTests();
  });

  it('registers a descriptor that the snapshot exposes', () => {
    interface ILogger {
      log(m: string): void;
    }
    const ILogger = createDecorator<ILogger>('logger');
    class ConsoleLogger implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    registerSingleton(ILogger, ConsoleLogger);

    const snapshot = getSingletonServiceDescriptors();
    expect(snapshot).toHaveLength(1);
    const [id, descriptor] = snapshot[0]!;
    expect(id).toBe(ILogger);
    expect(descriptor).toBeInstanceOf(SyncDescriptor);
    expect(descriptor.ctor).toBe(ConsoleLogger);
    // Eager (the default) maps to supportsDelayedInstantiation === false.
    expect(descriptor.supportsDelayedInstantiation).toBe(false);
  });

  it('maps InstantiationType to descriptor.supportsDelayedInstantiation', () => {
    interface IFoo {
      a: number;
    }
    interface IBar {
      b: number;
    }
    const IFoo = createDecorator<IFoo>('foo');
    const IBar = createDecorator<IBar>('bar');
    class Foo implements IFoo {
      a = 1;
    }
    class Bar implements IBar {
      b = 2;
    }
    registerSingleton(IFoo, Foo);
    registerSingleton(IBar, Bar, InstantiationType.Delayed);

    // After the VS Code alignment the registry no longer stores
    // `InstantiationType` separately — the flag lives on the descriptor.
    const map = new Map<string, boolean>(
      getSingletonServiceDescriptors().map(([id, descriptor]) => [
        String(id),
        descriptor.supportsDelayedInstantiation,
      ]),
    );
    expect(map.get('foo')).toBe(false);
    expect(map.get('bar')).toBe(true);
  });

  it('re-registering the same id overwrites the previous entry (VS Code semantics)', () => {
    interface ILogger {
      log(m: string): void;
    }
    const ILogger = createDecorator<ILogger>('logger');
    class A implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    class B implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    registerSingleton(ILogger, A);
    registerSingleton(ILogger, B);

    // Snapshot length stays at 1; the entry wraps B's ctor.
    const snapshot = getSingletonServiceDescriptors();
    expect(snapshot).toHaveLength(1);
    const [id, descriptor] = snapshot[0]!;
    expect(id).toBe(ILogger);
    expect(descriptor.ctor).toBe(B);
  });

  it('accepts a SyncDescriptor overload directly', () => {
    interface IFoo {
      a: number;
    }
    const IFoo = createDecorator<IFoo>('foo');
    class Foo implements IFoo {
      constructor(public readonly a: number) {}
    }
    registerSingleton(IFoo, new SyncDescriptor(Foo, [42], true));

    const snapshot = getSingletonServiceDescriptors();
    expect(snapshot).toHaveLength(1);
    const [, descriptor] = snapshot[0]!;
    expect(descriptor.ctor).toBe(Foo);
    expect(descriptor.staticArguments).toEqual([42]);
    expect(descriptor.supportsDelayedInstantiation).toBe(true);
  });

  it('_clearRegistryForTests empties the registry', () => {
    interface IFoo {
      a: number;
    }
    const IFoo = createDecorator<IFoo>('foo');
    class Foo implements IFoo {
      a = 1;
    }
    registerSingleton(IFoo, Foo);
    expect(getSingletonServiceDescriptors()).toHaveLength(1);
    _clearRegistryForTests();
    expect(getSingletonServiceDescriptors()).toHaveLength(0);
  });

  it('end-to-end bootstrap (mirrors the README copy-paste example)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // 1. Declare a service.
    interface ILogger {
      log(message: string): void;
    }
    const ILogger = createDecorator<ILogger>('logger');

    // 2. Implement it.
    class ConsoleLogger implements ILogger {
      log(message: string): void {
        // eslint-disable-next-line no-console
        console.log(`[log] ${message}`);
      }
    }

    // 3. Register at module load time.
    registerSingleton(ILogger, ConsoleLogger);

    // 4. Bootstrap.
    const services = new ServiceCollection(
      ...getSingletonServiceDescriptors().map(
        ([id, descriptor]) => [id, descriptor] as const,
      ),
    );
    const ix = new InstantiationService(services);

    // 5. Use.
    ix.invokeFunction((accessor) => {
      const logger = accessor.get(ILogger);
      logger.log('hello world');
    });
    expect(logSpy).toHaveBeenCalledWith('[log] hello world');

    // 6. Scoped child.
    interface IRequestContext {
      requestId: string;
    }
    const IRequestContext = createDecorator<IRequestContext>('requestContext');
    class RequestContext implements IRequestContext {
      constructor(public readonly requestId: string) {}
    }
    const child = ix.createChild(
      new ServiceCollection([
        IRequestContext,
        new SyncDescriptor(RequestContext, ['req-123']),
      ]),
    );
    child.invokeFunction((accessor) => {
      // Child sees parent services transparently.
      accessor
        .get(ILogger)
        .log(`handling ${accessor.get(IRequestContext).requestId}`);
    });
    expect(logSpy).toHaveBeenCalledWith('[log] handling req-123');

    // 7. Teardown.
    ix.dispose();
    expect(() => ix.invokeFunction((_a) => undefined)).toThrowError(/disposed/);

    logSpy.mockRestore();
  });

  it('snapshot is independent of subsequent registrations (returns a fresh array)', () => {
    interface IFoo {
      a: number;
    }
    const IFoo = createDecorator<IFoo>('foo');
    class Foo implements IFoo {
      a = 1;
    }
    registerSingleton(IFoo, Foo);

    const snap1 = getSingletonServiceDescriptors();
    expect(snap1).toHaveLength(1);

    interface IBar {
      b: number;
    }
    const IBar = createDecorator<IBar>('bar');
    class Bar implements IBar {
      b = 2;
    }
    registerSingleton(IBar, Bar);

    // Prior snapshot must not have been mutated retroactively.
    expect(snap1).toHaveLength(1);

    const snap2 = getSingletonServiceDescriptors();
    expect(snap2).toHaveLength(2);
  });
});
