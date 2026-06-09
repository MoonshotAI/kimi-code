import { describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/di/descriptors';
import { InstantiationService } from '#/di/instantiationService';
import { createDecorator, type ServicesAccessor } from '#/di/instantiation';
import { ServiceCollection } from '#/di/serviceCollection';

interface ILogger {
  log(msg: string): void;
}
const ILogger = createDecorator<ILogger>('logger');

describe('InstantiationService (basic)', () => {
  it('constructs an impl from SyncDescriptor on first get', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    class ConsoleLogger implements ILogger {
      log(m: string): void {
        // eslint-disable-next-line no-console
        console.log(m);
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([ILogger, new SyncDescriptor(ConsoleLogger)]),
    );
    ix.invokeFunction((a) => a.get(ILogger).log('hi'));
    expect(logSpy).toHaveBeenCalledWith('hi');
    logSpy.mockRestore();
  });

  it('returns the same cached instance across multiple invokeFunction calls', () => {
    class ConsoleLogger implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([ILogger, new SyncDescriptor(ConsoleLogger)]),
    );
    const first = ix.invokeFunction((a) => a.get(ILogger));
    const second = ix.invokeFunction((a) => a.get(ILogger));
    expect(first).toBe(second);
  });

  it('returns the same cached instance within a single invokeFunction call', () => {
    class ConsoleLogger implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([ILogger, new SyncDescriptor(ConsoleLogger)]),
    );
    let inner: ILogger | undefined;
    const outer = ix.invokeFunction((a) => {
      const first = a.get(ILogger);
      inner = a.get(ILogger);
      return first;
    });
    expect(outer).toBe(inner);
  });

  it('createInstance() constructs a raw ctor with literal args (no DI)', () => {
    class MyClass {
      constructor(
        public readonly a: string,
        public readonly b: number,
      ) {}
    }
    const ix = new InstantiationService();
    const inst = ix.createInstance(MyClass, 'x', 7);
    expect(inst).toBeInstanceOf(MyClass);
    expect(inst.a).toBe('x');
    expect(inst.b).toBe(7);
  });

  it('createInstance(descriptor) unpacks ctor + staticArguments (P0.4)', () => {
    class Foo {
      constructor(
        public readonly a: string,
        public readonly b: string,
      ) {}
    }
    const ix = new InstantiationService();
    const inst = ix.createInstance(new SyncDescriptor(Foo, ['a', 'b']));
    expect(inst).toBeInstanceOf(Foo);
    expect(inst.a).toBe('a');
    expect(inst.b).toBe('b');
  });

  it('createInstance(descriptor, ...rest) concatenates static prefix + rest (P0.4)', () => {
    class Foo {
      constructor(
        public readonly a: string,
        public readonly b: string,
      ) {}
    }
    const ix = new InstantiationService();
    // staticArguments=['a'], rest=['b'] → new Foo('a', 'b')
    const inst = ix.createInstance(new SyncDescriptor(Foo, ['a']), 'b');
    expect(inst.a).toBe('a');
    expect(inst.b).toBe('b');
  });

  it('eagerly constructs on first get (ctor side-effect runs during get)', () => {
    let ctorCount = 0;
    class CountingService {
      constructor() {
        ctorCount++;
      }
    }
    const IFoo = createDecorator<CountingService>('foo');
    const ix = new InstantiationService(
      new ServiceCollection([IFoo, new SyncDescriptor(CountingService)]),
    );
    // Not constructed at container creation time.
    expect(ctorCount).toBe(0);
    ix.invokeFunction((a) => a.get(IFoo));
    expect(ctorCount).toBe(1);
    // Second get: cached, ctor NOT re-run.
    ix.invokeFunction((a) => a.get(IFoo));
    expect(ctorCount).toBe(1);
  });

  it('honours SyncDescriptor.staticArguments when constructing', () => {
    class Greeter {
      constructor(public readonly prefix: string) {}
      greet(name: string): string {
        return `${this.prefix} ${name}`;
      }
    }
    const IGreeter = createDecorator<Greeter>('greeter');
    const ix = new InstantiationService(
      new ServiceCollection([IGreeter, new SyncDescriptor(Greeter, ['hello'])]),
    );
    expect(ix.invokeFunction((a) => a.get(IGreeter).greet('world'))).toBe('hello world');
  });

  it('accepts a pre-built instance shorthand from ServiceCollection', () => {
    class ConsoleLogger implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    const inst = new ConsoleLogger();
    const ix = new InstantiationService(new ServiceCollection([ILogger, inst]));
    expect(ix.invokeFunction((a) => a.get(ILogger))).toBe(inst);
  });

  it('non-strict mode returns undefined for an unregistered id', () => {
    const ix = new InstantiationService();
    expect(ix.invokeFunction((a) => a.get(ILogger))).toBeUndefined();
  });

  it('strict mode throws when getting an unregistered id', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    expect(() => ix.invokeFunction((a) => a.get(ILogger))).toThrowError(
      /unknown service 'logger'/,
    );
  });

  it('invokeFunction forwards additional arguments to the callback', () => {
    const ix = new InstantiationService();
    expect(
      ix.invokeFunction(
        (_a, prefix: string, count: number) => `${prefix}:${count}`,
        'req',
        7,
      ),
    ).toBe('req:7');
  });

  it('invokeFunction accessor is invalid after the callback returns', () => {
    class AccessorLogger implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([ILogger, new SyncDescriptor(AccessorLogger)]),
    );
    let captured: ServicesAccessor | undefined;
    ix.invokeFunction((a) => {
      captured = a;
      expect(a.get(ILogger)).toBeInstanceOf(AccessorLogger);
    });
    expect(() => captured!.get(ILogger)).toThrowError(
      /service accessor is only valid/,
    );
  });

  it('uses the live ServiceCollection entry instead of a stale instance cache', () => {
    class InitialLogger implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    class ReplacementLogger implements ILogger {
      log(_m: string): void {
        /* noop */
      }
    }
    const first = new InitialLogger();
    const second = new ReplacementLogger();
    const services = new ServiceCollection([ILogger, first]);
    const ix = new InstantiationService(services);
    expect(ix.invokeFunction((a) => a.get(ILogger))).toBe(first);
    services.set(ILogger, second);
    expect(ix.invokeFunction((a) => a.get(ILogger))).toBe(second);
  });

  it('createChild returns a child container, dispose tears down', () => {
    // Detailed createChild + dispose semantics live in `child.test.ts`; this
    // is just a smoke test that the W2.3 wiring is in place.
    const ix = new InstantiationService();
    const child = ix.createChild(new ServiceCollection());
    expect(child).toBeDefined();
    expect(() => ix.dispose()).not.toThrow();
  });
});
