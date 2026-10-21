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

    const sessionCollection = new ServiceCollection();
    sessionCollection.set(IProbe, seedInstance);
    const session = new InstantiationService(sessionCollection, true);

    const agentCollection = new ServiceCollection();
    agentCollection.set(IProbe, new SyncDescriptor(AgentRegisteredProbe));
    const agent = session.createChild(agentCollection);

    expect(session.invokeFunction((a) => a.get(IProbe)).origin).toBe('session-seed');
    expect(agent.invokeFunction((a) => a.get(IProbe)).origin).toBe('agent-registered');
  });
});
