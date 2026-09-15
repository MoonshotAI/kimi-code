import type { ServiceRegistration } from '#/_base/di/test';
import {
  buildAgentIdentitySnapshot,
  IAgentIdentity,
  type AgentIdentitySnapshot,
} from '#/app/agentIdentity/agentIdentity';

export interface AgentIdentityStubOverrides {
  readonly displayName?: string;
  readonly slug?: string;
  readonly hostRequestHeaders?: Readonly<Record<string, string>>;
}

export function stubAgentIdentity(overrides: AgentIdentityStubOverrides = {}): IAgentIdentity {
  const products = buildAgentIdentitySnapshot({
    slug: overrides.slug,
    hostRequestHeaders: overrides.hostRequestHeaders ?? {},
  });
  const snapshot: AgentIdentitySnapshot = {
    ...products,
    displayName: overrides.displayName,
  };
  return {
    _serviceBrand: undefined,
    resolved: () => Promise.resolve(snapshot),
    current: () => snapshot,
  };
}

export function registerAgentIdentityStub(
  reg: ServiceRegistration,
  overrides?: AgentIdentityStubOverrides,
): void {
  reg.defineInstance(IAgentIdentity, stubAgentIdentity(overrides));
}

export function deferredAgentIdentityStub(overrides: AgentIdentityStubOverrides = {}): {
  identity: IAgentIdentity;
  freeze: () => void;
} {
  let snapshot: AgentIdentitySnapshot | undefined;
  let settle!: (frozen: AgentIdentitySnapshot) => void;
  const frozen = new Promise<AgentIdentitySnapshot>((resolve) => {
    settle = resolve;
  });
  return {
    identity: {
      _serviceBrand: undefined,
      resolved: () => frozen,
      current: () => {
        if (snapshot === undefined) throw new Error('identity read before the test froze it');
        return snapshot;
      },
    },
    freeze: () => {
      const products = buildAgentIdentitySnapshot({
        slug: overrides.slug,
        hostRequestHeaders: overrides.hostRequestHeaders ?? {},
      });
      snapshot = { ...products, displayName: overrides.displayName };
      settle(snapshot);
    },
  };
}
