/**
 * ACP terminal reverse-RPC tests (`clientCapabilities.terminal`).
 *
 * The first suite is the DI verification experiment that decided the design.
 * Facts under test (from `agent-core-v2/src/_base/di`):
 *  1. A scope seed beats a registry entry ON THE SAME scope level —
 *     `buildCollection` applies `extra` after the registered descriptors, and
 *     `ServiceCollection.set` overwrites. This is why a Session-scope
 *     `registerScopedService(ISessionProcessRunner, ...)` from acp-server can
 *     NOT shadow the workspace runner the handler seeds into every real
 *     Session scope (`sessionLifecycleService`).
 *  2. Instantiation resolution checks the scope's OWN collection before
 *     walking up to the parent (`_getServiceInstanceOrDescriptor`). So an
 *     Agent-scope registration DOES shadow the Session-scope seed for
 *     Agent-scope consumers — and the Bash tool resolves
 *     `ISessionProcessRunner` at Agent scope.
 *
 * The experiment uses a bare `InstantiationService` (not `Scope.createApp`)
 * so the engine's real App-scope registrations stay out of the way; it wires
 * the collections exactly the way `buildCollection` / `createChild` do.
 */

import {
  createDecorator,
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

interface IShadowProbe {
  readonly _serviceBrand: undefined;
  readonly origin: string;
}

class AgentRegisteredProbe implements IShadowProbe {
  declare readonly _serviceBrand: undefined;
  readonly origin = 'agent-registered';
}

describe('DI experiment: scope seed vs registry vs child-scope registration', () => {
  const IProbe: ServiceIdentifier<IShadowProbe> = createDecorator<IShadowProbe>('shadowProbe');

  it('a same-level seed overwrites a registered descriptor (buildCollection order)', () => {
    // Mirror `buildCollection`: registered descriptors first, then the seed.
    const collection = new ServiceCollection();
    collection.set(IProbe, new SyncDescriptor(AgentRegisteredProbe));
    const seedInstance: IShadowProbe = { _serviceBrand: undefined, origin: 'session-seed' };
    collection.set(IProbe, seedInstance);

    const instantiation = new InstantiationService(collection, true);
    const resolved = instantiation.invokeFunction((accessor) => accessor.get(IProbe));
    expect(resolved.origin).toBe('session-seed');
  });

  it('a child-scope (Agent) registration shadows a parent-scope (Session) seed', () => {
    const seedInstance: IShadowProbe = { _serviceBrand: undefined, origin: 'session-seed' };

    // Session level: only the seed (what `sessionLifecycleService` injects).
    const sessionCollection = new ServiceCollection();
    sessionCollection.set(IProbe, seedInstance);
    const session = new InstantiationService(sessionCollection, true);

    // Agent level: the acp-server registration lands in the child collection.
    const agentCollection = new ServiceCollection();
    agentCollection.set(IProbe, new SyncDescriptor(AgentRegisteredProbe));
    const agent = session.createChild(agentCollection);

    // Session-scope consumers keep seeing the seed…
    expect(session.invokeFunction((a) => a.get(IProbe)).origin).toBe('session-seed');
    // …while Agent-scope consumers (the Bash tool) resolve the Agent-scope
    // registration. This is the fact the `AcpProcessRunner` design relies on.
    expect(agent.invokeFunction((a) => a.get(IProbe)).origin).toBe('agent-registered');
  });
});
