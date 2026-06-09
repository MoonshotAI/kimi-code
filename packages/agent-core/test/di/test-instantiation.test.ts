import { describe, expect, it, vi } from 'vitest';

import * as mainBarrel from '#/di/index';
import { TestInstantiationService } from '#/di/test';
import { createDecorator } from '#/di/instantiation';
import { SyncDescriptor } from '#/di/descriptors';
import { ServiceCollection } from '#/di/serviceCollection';

/**
 * P1.3 — `TestInstantiationService` exposed via `@moonshot-ai/agent-core/di/test`
 * subpath only. The main barrel `@moonshot-ai/agent-core` (which re-exports
 * from `agent-core/src/di/index.ts`) MUST NOT carry `TestInstantiationService`
 * — test-time code stays out of production bundles.
 *
 * The local subpath alias `#/di/test` resolves to the same barrel
 * (`src/di/test.ts`) the external consumer sees via the `package.json`
 * exports map.
 */

interface ILogger {
  log(msg: string): void;
}
const ILogger = createDecorator<ILogger>('p1.3-ILogger');

describe('TestInstantiationService (P1.3)', () => {
  it('`.stub(id, impl)` registers a pre-built instance and `.get(id)` returns it', () => {
    const ix = new TestInstantiationService();
    const stub: ILogger = { log: vi.fn() };
    ix.stub(ILogger, stub);
    const resolved = ix.get(ILogger);
    expect(resolved).toBe(stub);
  });

  it('a class constructed via `.createInstance` receives the stubbed dependency', () => {
    const ix = new TestInstantiationService();
    const log = vi.fn();
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
    // Apply the parameter decorator manually (vitest's rolldown transform
    // does not parse TS parameter decorators in test files).
    (ILogger as unknown as (t: unknown, k: string, i: number) => void)(
      Greeter,
      '',
      1,
    );

    const g = ix.createInstance(Greeter as new (prefix: string) => Greeter, 'hello');
    expect(g.greet('world')).toBe('hello world');
    expect(log).toHaveBeenCalledWith('hello world');
  });

  it('`.set(id, descriptor)` accepts a SyncDescriptor and lazily constructs', () => {
    let ctorCount = 0;
    class DescLogger implements ILogger {
      constructor() {
        ctorCount += 1;
      }
      log(_m: string): void {
        /* noop */
      }
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
    // Subpath-only export contract: production code that imports the
    // package entry should not accidentally pull test scaffolding.
    expect((mainBarrel as Record<string, unknown>)['TestInstantiationService']).toBeUndefined();
  });

  it('`createChild` returns a `TestInstantiationService` (narrowed from base)', () => {
    const parent = new TestInstantiationService();
    const sharedStub: ILogger = { log: vi.fn() };
    parent.stub(ILogger, sharedStub);
    const child = parent.createChild(new ServiceCollection());
    expect(child).toBeInstanceOf(TestInstantiationService);
    // Child inherits the parent's stub.
    expect(child.get(ILogger)).toBe(sharedStub);
  });
});
