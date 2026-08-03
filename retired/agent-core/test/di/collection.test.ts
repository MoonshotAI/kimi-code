import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/di/descriptors';
import { createDecorator } from '#/di/instantiation';
import { ServiceCollection } from '#/di/serviceCollection';

interface ILogger {
  log(msg: string): void;
}
interface IClock {
  now(): number;
}
class ConsoleLogger implements ILogger {
  log(_m: string): void {
    /* noop */
  }
}
class FixedClock implements IClock {
  now(): number {
    return 42;
  }
}

const ILogger = createDecorator<ILogger>('logger');
const IClock = createDecorator<IClock>('clock');

describe('ServiceCollection', () => {
  it('starts empty when constructed without args', () => {
    const c = new ServiceCollection();
    expect(c.has(ILogger)).toBe(false);
    expect(c.get(ILogger)).toBeUndefined();
  });

  it('accepts initial pairs in constructor', () => {
    const inst = new ConsoleLogger();
    const c = new ServiceCollection([ILogger, inst], [IClock, new SyncDescriptor(FixedClock)]);
    expect(c.has(ILogger)).toBe(true);
    expect(c.has(IClock)).toBe(true);
    expect(c.get(ILogger)).toBe(inst);
    const desc = c.get(IClock);
    expect(desc).toBeInstanceOf(SyncDescriptor);
  });

  it('set() returns previous value, or undefined when none', () => {
    const c = new ServiceCollection();
    const first = new ConsoleLogger();
    const second = new ConsoleLogger();
    expect(c.set(ILogger, first)).toBeUndefined();
    expect(c.set(ILogger, second)).toBe(first);
    expect(c.get(ILogger)).toBe(second);
  });

  it('has() reflects set state', () => {
    const c = new ServiceCollection();
    expect(c.has(ILogger)).toBe(false);
    c.set(ILogger, new ConsoleLogger());
    expect(c.has(ILogger)).toBe(true);
  });

  it('forEach visits every entry exactly once', () => {
    const inst = new ConsoleLogger();
    const c = new ServiceCollection([ILogger, inst], [IClock, new SyncDescriptor(FixedClock)]);
    const seen: Array<[string, unknown]> = [];
    c.forEach((id, value) => {
      // P0.3: identifier name is exposed via `toString()` (krow style), no
      // longer a `serviceName` property.
      seen.push([id.toString(), value]);
    });
    expect(seen).toHaveLength(2);
    const names = seen.map(([n]) => n).sort();
    expect(names).toEqual(['clock', 'logger']);
  });

  it('forEach on empty collection produces zero entries', () => {
    const c = new ServiceCollection();
    const seen: Array<[string, unknown]> = [];
    c.forEach((id, value) => {
      seen.push([id.toString(), value]);
    });
    expect(seen).toHaveLength(0);
  });

  it('set() with the same key multiple times updates and returns the latest previous', () => {
    const c = new ServiceCollection();
    const a = new ConsoleLogger();
    const b = new ConsoleLogger();
    const c2 = new ConsoleLogger();
    expect(c.set(ILogger, a)).toBeUndefined();
    expect(c.set(ILogger, b)).toBe(a);
    expect(c.set(ILogger, c2)).toBe(b);
    expect(c.get(ILogger)).toBe(c2);
  });

  it('set() overrides a constructor-provided entry', () => {
    const original = new ConsoleLogger();
    const replacement = new ConsoleLogger();
    const c = new ServiceCollection([ILogger, original]);
    expect(c.set(ILogger, replacement)).toBe(original);
    expect(c.get(ILogger)).toBe(replacement);
  });

  it('has() returns false for an unknown id even after other registrations', () => {
    const c = new ServiceCollection([ILogger, new ConsoleLogger()]);
    expect(c.has(ILogger)).toBe(true);
    // IClock was never registered.
    expect(c.has(IClock)).toBe(false);
  });
});
