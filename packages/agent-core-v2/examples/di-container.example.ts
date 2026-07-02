/**
 * Example 01 — the DI container and the `App → Session → Agent` scope tree.
 *
 * Concept taught: a service declares an identity (`createDecorator`), its
 * dependencies (`@IToken`), and a lifetime (`registerScopedService`); the
 * container decides construction, singleton-per-scope, ordering, and disposal.
 *
 * It also shows `InstantiationType`: a `Delayed` service hands back a proxy
 * that is only constructed when a method is first called, while an `Eager`
 * service is constructed immediately on `accessor.get(...)`.
 *
 * Scope tiers: App (process-wide) → Session (one session) → Agent (one agent).
 * Short-lived may inject long-lived; never the reverse. Disposal is
 * deterministic: child scopes die before parents.
 *
 * Prerequisites: none (this is the entry point). Uses only in-file fixtures.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/di-container.example.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { type IDisposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';

interface IGreeter {
  greet(): string;
}
interface IConsumer {
  label(): string;
}

const IGreeter = createDecorator<IGreeter>('ex01-greeter');
const IConsumer = createDecorator<IConsumer>('ex01-consumer');

/** A Session-scope service that depends on an App-scope `IGreeter`. */
class Consumer implements IConsumer {
  constructor(@IGreeter private readonly greeter: IGreeter) {}
  label(): string {
    return `consumed:${this.greeter.greet()}`;
  }
}

/** Disposable fixtures used only by the disposal-order test. */
const disposalLog: string[] = [];

class AppThing implements IDisposable {
  dispose(): void {
    disposalLog.push('app');
  }
}
class SessionThing implements IDisposable {
  dispose(): void {
    disposalLog.push('session');
  }
}
class AgentThing implements IDisposable {
  dispose(): void {
    disposalLog.push('agent');
  }
}

const IAppThing = createDecorator<AppThing>('ex01-app-thing');
const ISessionThing = createDecorator<SessionThing>('ex01-session-thing');
const IAgentThing = createDecorator<AgentThing>('ex01-agent-thing');

describe('example 01 — di container & scope tree', () => {
  beforeEach(() => {
    disposalLog.length = 0;
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, IConsumer, Consumer);
    // Eager so `accessor.get(...)` returns the real instance immediately rather
    // than a delayed proxy — the disposal-order test needs the instances to
    // actually be constructed so the scope has something to dispose.
    registerScopedService(
      LifecycleScope.App,
      IAppThing,
      AppThing,
      InstantiationType.Eager,
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionThing,
      SessionThing,
      InstantiationType.Eager,
    );
    registerScopedService(
      LifecycleScope.Agent,
      IAgentThing,
      AgentThing,
      InstantiationType.Eager,
    );
  });

  it('injects an App-scope ancestor into a Session-scope child', () => {
    const host = createScopedTestHost([
      stubPair<IGreeter>(IGreeter, { greet: () => 'hello-from-app' }),
    ]);
    const session = host.child(LifecycleScope.Session, 's1');

    const consumer = session.accessor.get(IConsumer);
    expect(consumer.label()).toBe('consumed:hello-from-app');

    host.dispose();
  });

  it('isolates stubs between sibling Session scopes', () => {
    const host = createScopedTestHost();
    const s1 = host.child(LifecycleScope.Session, 's1', [
      stubPair<IGreeter>(IGreeter, { greet: () => 'one' }),
    ]);
    const s2 = host.child(LifecycleScope.Session, 's2', [
      stubPair<IGreeter>(IGreeter, { greet: () => 'two' }),
    ]);

    expect(s1.accessor.get(IConsumer).label()).toBe('consumed:one');
    expect(s2.accessor.get(IConsumer).label()).toBe('consumed:two');

    host.dispose();
  });

  it('builds an Agent scope under a Session and resolves upward', () => {
    const host = createScopedTestHost([
      stubPair<IGreeter>(IGreeter, { greet: () => 'from-app' }),
    ]);
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    // The Agent scope has no IGreeter seed, so resolution walks up to App.
    expect(agent.accessor.get(IGreeter).greet()).toBe('from-app');
    // IConsumer is registered at Session scope; the Agent scope finds it on the ancestor.
    expect(agent.accessor.get(IConsumer).label()).toBe('consumed:from-app');

    host.dispose();
  });

  it('disposes child scopes before parent scopes', () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    // Force construction of each scoped instance.
    host.app.accessor.get(IAppThing);
    session.accessor.get(ISessionThing);
    agent.accessor.get(IAgentThing);

    host.dispose();

    expect(disposalLog).toEqual(['agent', 'session', 'app']);
  });
});
