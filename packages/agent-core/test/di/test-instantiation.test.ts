import * as sinon from 'sinon';
import { describe, expect, it } from 'vitest';

import * as mainBarrel from '#/di/index';
import { createServices, TestInstantiationService } from '#/di/test';
import { createDecorator } from '#/di/instantiation';
import { SyncDescriptor } from '#/di/descriptors';
import { ServiceCollection } from '#/di/serviceCollection';
import { DisposableStore } from '#/di/lifecycle';

interface ILogger {
  log(msg: string): void;
}
const ILogger = createDecorator<ILogger>('p1.3-ILogger');

interface IAsyncService {
  load(id: string): Promise<string[]>;
  answer(): number;
}
const IAsyncService = createDecorator<IAsyncService>('p1.3-IAsyncService');

function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('TestInstantiationService (P1.3)', () => {
  it('`.stub(id, impl)` registers a pre-built instance and `.get(id)` returns it', () => {
    const ix = new TestInstantiationService();
    const stub: ILogger = { log: sinon.stub() };
    ix.stub(ILogger, stub);
    const resolved = ix.get(ILogger);
    expect(resolved).toBe(stub);
  });

  it('a class constructed via `.createInstance` receives the stubbed dependency', () => {
    const ix = new TestInstantiationService();
    const log = sinon.stub();
    const stub: ILogger = { log };
    ix.stub(ILogger, stub);

    class Greeter {
      constructor(
        public readonly prefix: string,
        public readonly logger: ILogger,
      ) {}
      greet(name: string): string {
        const msg = `${this.prefix} ${name}`;
        this.logger.log(msg);
        return msg;
      }
    }
    (ILogger as unknown as (t: unknown, k: string, i: number) => void)(
      Greeter,
      '',
      1,
    );

    const g = ix.createInstance(Greeter as new (prefix: string) => Greeter, 'hello');
    expect(g.greet('world')).toBe('hello world');
    sinon.assert.calledWith(log, 'hello world');
  });

  it('`.set(id, descriptor)` accepts a SyncDescriptor and lazily constructs', () => {
    let ctorCount = 0;
    class DescLogger implements ILogger {
      constructor() {
        ctorCount += 1;
      }
      log(_m: string): void {}
    }
    const ix = new TestInstantiationService();
    ix.set(ILogger, new SyncDescriptor(DescLogger));
    expect(ctorCount).toBe(0);
    const a = ix.get(ILogger);
    const b = ix.get(ILogger);
    expect(a).toBe(b);
    expect(ctorCount).toBe(1);
  });

  it('main barrel `#/di/index` does NOT re-export `TestInstantiationService`', () => {
    expect((mainBarrel as Record<string, unknown>)['TestInstantiationService']).toBeUndefined();
  });

  it('`createChild` returns a `TestInstantiationService` (narrowed from base)', () => {
    const parent = new TestInstantiationService();
    const sharedStub: ILogger = { log: sinon.stub() };
    parent.stub(ILogger, sharedStub);
    const child = parent.createChild(new ServiceCollection());
    expect(child).toBeInstanceOf(TestInstantiationService);
    expect(child.get(ILogger)).toBe(sharedStub);
  });

  it('`.mock(id)` returns a sinon expectation mock for the injected service', () => {
    const ix = new TestInstantiationService();
    ix.stub(ILogger, {
      log(_msg: string): void {},
    });

    const mock = ix.mock(ILogger) as sinon.SinonMock;
    mock.expects('log').once().withArgs('error');

    ix.get(ILogger).log('error');

    mock.verify();
  });

  it('`.stubPromise(id, method, value)` installs a sinon stub that resolves to the value', async () => {
    const ix = new TestInstantiationService();

    const load = ix.stubPromise(IAsyncService, 'load', ['a', 'b']) as sinon.SinonStub;
    const service = ix.get(IAsyncService);

    await expect(service.load('req-1')).resolves.toEqual(['a', 'b']);
    sinon.assert.calledWith(load, 'req-1');
  });

  it('`.stub(id, method, value)` installs a sinon stub that returns the value', () => {
    const ix = new TestInstantiationService();

    const answer = ix.stub(IAsyncService, 'answer', 42);
    const service = ix.get(IAsyncService);

    expect(service.answer()).toBe(42);
    sinon.assert.calledOnce(answer);
  });

  it('`.stub(id, ctor)` creates a sinon stub instance for the service', () => {
    class AsyncService implements IAsyncService {
      async load(_id: string): Promise<string[]> {
        return ['real'];
      }

      answer(): number {
        return 0;
      }
    }

    const ix = new TestInstantiationService();
    const service = ix.stub(IAsyncService, AsyncService);
    (service.answer as sinon.SinonStub).returns(42);

    expect(ix.get(IAsyncService).answer()).toBe(42);
    sinon.assert.calledOnce(service.answer as sinon.SinonStub);
  });

  it('`.spy(id, method)` installs a sinon spy function on the service', () => {
    const ix = new TestInstantiationService();

    const spy = ix.spy(ILogger, 'log');
    ix.get(ILogger).log('hello');

    sinon.assert.calledWith(spy, 'hello');
  });

  it('`.stubInstance(ctor, instance)` overrides createInstance and is inherited by children', () => {
    class Widget {
      constructor(public readonly name: string) {}
      render(): string {
        return `real:${this.name}`;
      }
    }

    const parent = new TestInstantiationService();
    const replacement = {
      render: sinon.stub().returns('stubbed'),
    };
    parent.stubInstance(Widget, replacement);

    expect(parent.createInstance(Widget, 'parent')).toBe(replacement);

    const child = parent.createChild(new ServiceCollection());
    expect(child.createInstance(Widget, 'child')).toBe(replacement);
    expect(replacement.render()).toBe('stubbed');
  });

  it('`createServices` registers prebuilt services and disposes them with the store', () => {
    class DisposableLogger implements ILogger {
      disposeCount = 0;
      log = sinon.stub();

      dispose(): void {
        this.disposeCount += 1;
      }
    }

    const disposables = new DisposableStore();
    const logger = new DisposableLogger();
    const ix = createServices(disposables, [[ILogger, logger]]);

    expect(ix.get(ILogger)).toBe(logger);

    disposables.dispose();

    expect(logger.disposeCount).toBe(1);
  });

  it('`createServices` disposes all prebuilt services before throwing AggregateError', () => {
    interface IOtherLogger {
      log(msg: string): void;
    }
    const IOtherLogger = createDecorator<IOtherLogger>('p1.3-IOtherLogger');
    const events: string[] = [];
    class FirstLogger implements ILogger {
      log = sinon.stub();
      dispose(): void {
        events.push('first');
        throw new Error('first-dispose');
      }
    }
    class SecondLogger implements IOtherLogger {
      log = sinon.stub();
      dispose(): void {
        events.push('second');
        throw new Error('second-dispose');
      }
    }

    const disposables = new DisposableStore();
    createServices(disposables, [
      [ILogger, new FirstLogger()],
      [IOtherLogger, new SecondLogger()],
    ]);

    const error = captureThrown(() => { disposables.dispose(); });

    expect(events).toEqual(['first', 'second']);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((err) => (err as Error).message)).toEqual([
      'first-dispose',
      'second-dispose',
    ]);
  });
});
