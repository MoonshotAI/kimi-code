import { describe, expect, it } from 'vitest';

import { _util, createDecorator } from '#/di/instantiation';

/**
 * P0.3 updates `createDecorator`:
 *  - Singleton per name (calling with the same name returns the same ref).
 *  - Decorator body now stashes `{ id, index }` on the target ctor under
 *    `$di$dependencies` instead of being a no-op.
 *  - Throws `@IServiceName-decorator can only be used to decorate a parameter`
 *    on `arguments.length !== 3`.
 */
describe('createDecorator (P0.3)', () => {
  it('singleton per name: two calls with same name return the SAME identifier', () => {
    const A = createDecorator<{ x: 1 }>('singleton-test-A');
    const B = createDecorator<{ x: 1 }>('singleton-test-A');
    expect(A).toBe(B);
    // Map key identity follows naturally from `===`.
    const m = new Map<unknown, string>();
    m.set(A, 'first');
    m.set(B, 'second');
    expect(m.size).toBe(1);
    expect(m.get(A)).toBe('second');
  });

  it('different names mint distinct identifiers', () => {
    const A = createDecorator<{ x: 1 }>('distinct-A');
    const B = createDecorator<{ x: 1 }>('distinct-B');
    expect(A).not.toBe(B);
  });

  it('toString() returns the diagnostic name', () => {
    const ILogger = createDecorator<{ log(m: string): void }>('tostring-logger');
    expect(ILogger.toString()).toBe('tostring-logger');
    expect(String(ILogger)).toBe('tostring-logger');
  });

  it('applying @IFoo on a single ctor parameter records {id, index: 0}', () => {
    const IFoo = createDecorator<{ a: 1 }>('deco-IFoo-single');
    class Target {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(foo: { a: 1 }) {}
    }
    // Manually apply: the runtime form TS would synthesize is the same — call
    // the identifier with `(target, key, index)`. Param-decorator key is
    // undefined at runtime; we pass an empty string here (the body only reads
    // `arguments.length` + target + index).
    (IFoo as unknown as (t: unknown, k: string, i: number) => void)(Target, '', 0);

    const deps = _util.getServiceDependencies(Target as unknown as _util.DI_TARGET_OBJ);
    expect(deps).toEqual([{ id: IFoo, index: 0 }]);
  });

  it('two decorators on the same ctor record both with correct indexes', () => {
    const IFoo = createDecorator<{ a: 1 }>('deco-IFoo-two');
    const IBar = createDecorator<{ b: 1 }>('deco-IBar-two');
    class Target {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(foo: { a: 1 }, bar: { b: 1 }) {}
    }
    // TS emits parameter decorators in reverse-parameter order, but the
    // public contract is "index reflects parameter position". Apply IBar
    // first (index 1), then IFoo (index 0).
    (IBar as unknown as (t: unknown, k: string, i: number) => void)(Target, '', 1);
    (IFoo as unknown as (t: unknown, k: string, i: number) => void)(Target, '', 0);

    const deps = _util.getServiceDependencies(Target as unknown as _util.DI_TARGET_OBJ);
    // Order of insertion follows decorator evaluation order, not parameter
    // order; tests should sort by index before asserting.
    const sorted = [...deps].sort((a, b) => a.index - b.index);
    expect(sorted).toEqual([
      { id: IFoo, index: 0 },
      { id: IBar, index: 1 },
    ]);
  });

  it('subclass does NOT inherit parent ctor metadata (storeServiceDependency reset)', () => {
    const IFoo = createDecorator<{ a: 1 }>('deco-IFoo-inherit');
    const IBar = createDecorator<{ b: 1 }>('deco-IBar-inherit');
    class Parent {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(foo: { a: 1 }) {}
    }
    class Child extends Parent {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(bar: { b: 1 }) {
        super({ a: 1 });
      }
    }
    (IFoo as unknown as (t: unknown, k: string, i: number) => void)(Parent, '', 0);
    // Without the own-property reset, Child would see Parent's array via
    // prototype lookup and end up sharing the same list.
    (IBar as unknown as (t: unknown, k: string, i: number) => void)(Child, '', 0);

    const parentDeps = _util.getServiceDependencies(Parent as unknown as _util.DI_TARGET_OBJ);
    const childDeps = _util.getServiceDependencies(Child as unknown as _util.DI_TARGET_OBJ);
    expect(parentDeps).toEqual([{ id: IFoo, index: 0 }]);
    expect(childDeps).toEqual([{ id: IBar, index: 0 }]);
  });

  it('applying with arguments.length !== 3 throws the parameter-decorator error', () => {
    const IFoo = createDecorator<{ a: 1 }>('deco-IFoo-arglen');
    const fn = IFoo as unknown as (...args: unknown[]) => void;
    expect(() => fn({})).toThrowError(
      /can only be used to decorate a parameter/,
    );
    expect(() => fn({}, 'k')).toThrowError(
      /can only be used to decorate a parameter/,
    );
    // 3 args: still records metadata (smoke).
    expect(() => fn(class Ok {}, '', 0)).not.toThrow();
  });
});
