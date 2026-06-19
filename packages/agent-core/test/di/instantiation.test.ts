import { describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/di/descriptors';
import { InstantiationService } from '#/di/instantiationService';
import {
  createDecorator,
  type BrandedService,
  type IConstructorSignature,
  type ServicesAccessor,
} from '#/di/instantiation';
import type { IDisposable } from '#/di/lifecycle';
import { ServiceCollection } from '#/di/serviceCollection';

interface ILogger {
  log(msg: string): void;
}
const ILogger = createDecorator<ILogger>('logger');

function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

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
    ix.invokeFunction((a) => {
      a.get(ILogger).log('hi');
    });
    expect(logSpy).toHaveBeenCalledWith('hi');
    logSpy.mockRestore();
  });

  it('returns the same cached instance across multiple invokeFunction calls', () => {
    class ConsoleLogger implements ILogger {
      log(_m: string): void {}
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
      log(_m: string): void {}
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

  it('IConstructorSignature models manual constructor args followed by DI services', () => {
    interface IBrandedLogger {
      readonly _serviceBrand: undefined;
      log(msg: string): void;
    }
    const IBrandedLogger = createDecorator<IBrandedLogger>('branded-logger');

    class BrandedLogger implements IBrandedLogger {
      declare readonly _serviceBrand: undefined;
      readonly messages: string[] = [];

      log(msg: string): void {
        this.messages.push(msg);
      }
    }

    class RouteContribution {
      constructor(
        public readonly route: string,
        public readonly logger: IBrandedLogger,
      ) {}

      start(): void {
        this.logger.log(this.route);
      }
    }

    function registerRouteContribution<Services extends BrandedService[]>(
      ctor: new (route: string, ...services: Services) => RouteContribution,
    ): IConstructorSignature<RouteContribution, [string]> {
      return ctor as IConstructorSignature<RouteContribution, [string]>;
    }

    const ctor = registerRouteContribution(RouteContribution);
    (IBrandedLogger as unknown as (t: unknown, k: string, i: number) => void)(
      RouteContribution,
      '',
      1,
    );
    const ix = new InstantiationService(
      new ServiceCollection([IBrandedLogger, new SyncDescriptor(BrandedLogger)]),
    );

    const contribution = ix.createInstance(ctor, '/auth');
    contribution.start();

    expect(contribution.route).toBe('/auth');
    expect(contribution.logger).toBeInstanceOf(BrandedLogger);
    expect((contribution.logger as BrandedLogger).messages).toEqual(['/auth']);
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
    const inst = ix.createInstance(new SyncDescriptor(Foo, ['a']), 'b');
    expect(inst.a).toBe('a');
    expect(inst.b).toBe('b');
  });

  it('eagerly constructs on first get (ctor side-effect runs during get)', () => {
    let ctorCount = 0;
    class CountingService {
      readonly tag = 'counting';

      constructor() {
        ctorCount++;
      }
    }
    const IFoo = createDecorator<CountingService>('foo');
    const ix = new InstantiationService(
      new ServiceCollection([IFoo, new SyncDescriptor(CountingService)]),
    );
    expect(ctorCount).toBe(0);
    ix.invokeFunction((a) => a.get(IFoo));
    expect(ctorCount).toBe(1);
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
      log(_m: string): void {}
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
      log(_m: string): void {}
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
      log(_m: string): void {}
    }
    class ReplacementLogger implements ILogger {
      log(_m: string): void {}
    }
    const first = new InitialLogger();
    const second = new ReplacementLogger();
    const services = new ServiceCollection([ILogger, first]);
    const ix = new InstantiationService(services);
    expect(ix.invokeFunction((a) => a.get(ILogger))).toBe(first);
    services.set(ILogger, second);
    expect(ix.invokeFunction((a) => a.get(ILogger))).toBe(second);
  });

  it('does not expose the backing ServiceCollection as a public runtime property', () => {
    const ix = new InstantiationService(new ServiceCollection());
    expect('services' in ix).toBe(false);
  });

  it('createChild returns a child container, dispose tears down', () => {
    const ix = new InstantiationService();
    const child = ix.createChild(new ServiceCollection());
    expect(child).toBeDefined();
    expect(() => { ix.dispose(); }).not.toThrow();
  });

  it('disposes all constructed services before throwing AggregateError', () => {
    interface IService {
      tag: string;
    }
    const IA = createDecorator<IService>('dispose-a');
    const IB = createDecorator<IService>('dispose-b');
    const IC = createDecorator<IService>('dispose-c');
    const events: string[] = [];
    class A implements IService, IDisposable {
      tag = 'a';
      dispose(): void {
        events.push('A');
        throw new Error('dispose-a');
      }
    }
    class B implements IService, IDisposable {
      tag = 'b';
      dispose(): void {
        events.push('B');
      }
    }
    class C implements IService, IDisposable {
      tag = 'c';
      dispose(): void {
        events.push('C');
        throw new Error('dispose-c');
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(A)],
        [IB, new SyncDescriptor(B)],
        [IC, new SyncDescriptor(C)],
      ),
    );

    ix.invokeFunction((a) => {
      a.get(IA);
      a.get(IB);
      a.get(IC);
    });
    const error = captureThrown(() => { ix.dispose(); });

    expect(events).toEqual(['C', 'B', 'A']);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((err) => (err as Error).message)).toEqual([
      'dispose-c',
      'dispose-a',
    ]);
  });
});
