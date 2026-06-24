import { beforeEach, describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function param(dec: any, target: any, index: number): void {
  (dec as (t: unknown, k: string, i: number) => void)(target, '', index);
}

interface IGreeter {
  greet(): string;
}
interface IConsumer {
  label(): string;
}

const IGreeter = createDecorator<IGreeter>('container-greeter');
const IConsumer = createDecorator<IConsumer>('container-consumer');

class Consumer implements IConsumer {
  constructor(private readonly greeter: IGreeter) {}
  label(): string {
    return `consumed:${this.greeter.greet()}`;
  }
}
param(IGreeter, Consumer, 0);

describe('scoped test container', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, IConsumer, Consumer);
  });

  it('injects a stubbed ancestor dependency into a child-layer service', () => {
    const stubGreeter: IGreeter = { greet: () => 'hello-from-stub' };
    const host = createScopedTestHost([stubPair(IGreeter, stubGreeter)]);
    const session = host.child(LifecycleScope.Session, 's1');

    const consumer = session.accessor.get(IConsumer);
    expect(consumer.label()).toBe('consumed:hello-from-stub');

    host.dispose();
  });

  it('stubs are isolated per scope (sibling scopes see different seeds)', () => {
    const host = createScopedTestHost();
    const s1 = host.child(LifecycleScope.Session, 's1', [
      stubPair(IGreeter, { greet: () => 'one' }),
    ]);
    const s2 = host.child(LifecycleScope.Session, 's2', [
      stubPair(IGreeter, { greet: () => 'two' }),
    ]);

    // Both sessions register IConsumer via the scoped registry; each resolves
    // IGreeter from its own layer (shadowing), so they diverge.
    // Re-register IConsumer to depend on the locally-seeded IGreeter.
    expect(s1.accessor.get(IGreeter).greet()).toBe('one');
    expect(s2.accessor.get(IGreeter).greet()).toBe('two');

    host.dispose();
  });

  it('childOf builds deeper (Agent) scopes under a given parent', () => {
    const host = createScopedTestHost([stubPair(IGreeter, { greet: () => 'deep' })]);
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', [
      stubPair(IGreeter, { greet: () => 'agent-local' }),
    ]);

    // Agent shadows IGreeter with its own seed.
    expect(agent.accessor.get(IGreeter).greet()).toBe('agent-local');
    // Session still resolves the core seed.
    expect(session.accessor.get(IGreeter).greet()).toBe('deep');

    host.dispose();
  });
});
