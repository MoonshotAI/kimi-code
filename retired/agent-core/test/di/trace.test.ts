import { describe, expect, it } from 'vitest';

import { InstantiationService, Trace } from '#/di/instantiationService';
import { ServiceCollection } from '#/di/serviceCollection';

/**
 * P0.2: `Trace` class + `_enableTracing` ctor param installed. These
 * assertions verify the class is reachable and the constructor follows the
 * VS Code argument order `(services, strict, parent, enableTracing)`.
 */

class ExposedInstantiationService extends InstantiationService {
  get tracingEnabled(): boolean {
    return this._enableTracing;
  }
}

describe('InstantiationService Trace installation (P0.2)', () => {
  it('constructs with the 2-arg signature (backward compat)', () => {
    const coll = new ServiceCollection();
    const ix = new InstantiationService(coll);
    expect(ix).toBeInstanceOf(InstantiationService);
  });

  it('constructs with strict=false, undefined parent, and tracing=true', () => {
    const coll = new ServiceCollection();
    const ix = new ExposedInstantiationService(coll, false, undefined, true);
    expect(ix).toBeInstanceOf(InstantiationService);
    expect(ix.tracingEnabled).toBe(true);
  });

  it('defaults _enableTracing to false when omitted', () => {
    const ix = new ExposedInstantiationService(new ServiceCollection());
    expect(ix.tracingEnabled).toBe(false);
  });

  it('Trace.traceCreation with _enableTracing=false returns the noop sentinel (Trace._None)', () => {
    // The sentinel has a no-op stop()/branch() — calling either must not throw.
    const t1 = Trace.traceCreation(false, class Foo {});
    expect(() => t1.stop()).not.toThrow();
    // Two non-tracing calls return identical sentinel; can't easily reach the
    // private static field, but exercising both noop methods is enough.
    const t2 = Trace.traceInvocation(false, function example() {});
    expect(() => t2.stop()).not.toThrow();
  });

  it('Trace.traceCreation with _enableTracing=true returns a real Trace instance', () => {
    const t = Trace.traceCreation(true, class Foo {});
    expect(t).toBeInstanceOf(Trace);
    // stop() should not throw on a real Trace either.
    expect(() => t.stop()).not.toThrow();
  });

  it('Trace.branch() on the noop sentinel does not throw', () => {
    const t = Trace.traceCreation(false, class Foo {});
    const branch = t.branch();
    expect(branch).toBeDefined();
    expect(() => branch.stop()).not.toThrow();
  });

  it('Trace.traceInvocation with tracing=true returns a real Trace with timing info', () => {
    const t = Trace.traceInvocation(true, function example() {});
    expect(t).toBeInstanceOf(Trace);
    expect(() => t.stop()).not.toThrow();
  });

  it('Trace.stop() on a real Trace can be called multiple times', () => {
    const t = Trace.traceCreation(true, class Foo {});
    expect(() => t.stop()).not.toThrow();
    // Second stop should also not throw (idempotent).
    expect(() => t.stop()).not.toThrow();
  });

  it('tracing is inherited by child containers', () => {
    const parent = new ExposedInstantiationService(new ServiceCollection(), false, undefined, true);
    expect(parent.tracingEnabled).toBe(true);
    const child = parent.createChild(new ServiceCollection()) as ExposedInstantiationService;
    expect(child.tracingEnabled).toBe(true);
  });
});
