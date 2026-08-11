/**
 * Shared `IAgentIdentity` stub.
 *
 * The identity cuts across the system prompt, outbound headers, MCP client
 * naming, and the builtin skill catalog, so plenty of suites need it present
 * without caring what it says. The default states "no custom identity", which
 * is the shape every pre-existing test expects: consumers must behave exactly
 * as they did before the feature existed. Unlike the real resolution, the
 * stub's `displayName` and `slug` are independent — naming a display name
 * does not derive a slug, so a suite can exercise one face in isolation.
 */

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
