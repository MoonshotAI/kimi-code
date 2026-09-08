import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { ScopeUnits } from '#/_base/di/fiber';
import { createDecorator } from '#/_base/di/instantiation';
import { Scope } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';

interface IFoo {
  tag: string;
}
const IFoo = createDecorator<IFoo>('scope-units-foo');

interface IPack {
  marker: string;
}
const IPack = createDecorator<IPack>('scope-units-pack');

class Foo implements IFoo {
  tag = 'foo';
}

describe('ScopeUnits — kernel materialization fold (D11/G2)', () => {
  const log: string[] = [];

  class AgentFeature extends Service {
    constructor() {
      super();
      this.provide(IFoo, Foo);
      this.effect(() => {
        log.push('feature up');
        return () => {
          log.push('feature down');
        };
      });
    }
  }

  class FeaturePack extends Service {
    constructor() {
      super();
      this.provide(ScopeUnits('agent'), AgentFeature);
    }
  }

  function appWithPack(): Scope {
    log.length = 0;
    const app = Scope.createApp({ id: 'app' });
    app.instantiation.provide(IPack, new SyncDescriptor(FeaturePack));
    app.accessor.get(IPack);
    return app;
  }

  it('materializes a contributed recipe inside every new scope of the kind', () => {
    const app = appWithPack();
    const a1 = app.createChild('agent', 'a1');
    expect(a1.accessor.get(IFoo).tag).toBe('foo');
    expect(log).toEqual(['feature up']);
    const a2 = app.createChild('agent', 'a2');
    expect(a2.accessor.get(IFoo).tag).toBe('foo');
    expect(log).toEqual(['feature up', 'feature up']);
    app.dispose();
  });

  it('tears the materialized unit down when the provider dies (连坐)', () => {
    const app = appWithPack();
    const a1 = app.createChild('agent', 'a1');
    expect(a1.accessor.get(IFoo).tag).toBe('foo');
    app.instantiation.unprovide(IPack);
    expect(log).toEqual(['feature up', 'feature down']);
    expect(() => a1.accessor.get(IFoo)).toThrow();
    app.dispose();
  });

  it('tears the materialized unit down with the target scope (idempotent with 连坐)', () => {
    const app = appWithPack();
    const a1 = app.createChild('agent', 'a1');
    expect(a1.accessor.get(IFoo).tag).toBe('foo');
    a1.dispose();
    expect(log).toEqual(['feature up', 'feature down']);
    app.dispose();
    expect(log).toEqual(['feature up', 'feature down']);
  });

  it('materializes records that arrive after the scope exists, and retracts them on withdrawal', () => {
    log.length = 0;
    const app = Scope.createApp({ id: 'app' });
    const a1 = app.createChild('agent', 'a1');
    app.instantiation.provide(IPack, new SyncDescriptor(FeaturePack));
    app.accessor.get(IPack);
    expect(log).toEqual(['feature up']);
    expect(a1.accessor.get(IFoo).tag).toBe('foo');
    app.instantiation.unprovide(IPack);
    expect(log).toEqual(['feature up', 'feature down']);
    app.dispose();
  });

  it('does not materialize records of a different kind', () => {
    log.length = 0;
    const app = Scope.createApp({ id: 'app' });
    app.instantiation.provide(IPack, new SyncDescriptor(FeaturePack));
    app.accessor.get(IPack);
    app.createChild('session', 's1');
    expect(log).toEqual([]);
    app.dispose();
  });
});
