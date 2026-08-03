/**
 * Shared `IAgentIdentity` stub.
 *
 * The identity cuts across the system prompt, outbound headers, MCP client
 * naming, and the builtin skill catalog, so plenty of suites need it present
 * without caring what it says. The default states "no custom identity", which
 * is the shape every pre-existing test expects: consumers must behave exactly
 * as they did before the feature existed.
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';

export function stubAgentIdentity(
  overrides: { readonly displayName?: string; readonly slug?: string } = {},
): IAgentIdentity {
  return {
    _serviceBrand: undefined,
    displayName: overrides.displayName,
    slug: overrides.slug,
  };
}

export function registerAgentIdentityStub(
  reg: ServiceRegistration,
  overrides?: { readonly displayName?: string; readonly slug?: string },
): void {
  reg.defineInstance(IAgentIdentity, stubAgentIdentity(overrides));
}
