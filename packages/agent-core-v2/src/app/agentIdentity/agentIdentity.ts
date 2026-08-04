/**
 * `agentIdentity` domain — resolved identity contract.
 *
 * The identity the agent uses for itself, resolved from the `[identity]`
 * config section over the host's declared display name. Bound at App scope.
 *
 * Its two faces carry different contracts. `displayName` fills the prompt's
 * `${product_name}` slot, and `undefined` means nobody declared one, so the
 * consumer applies its own default. `slug` is the protocol identifier, where
 * `undefined` means no custom identity was declared and consumers must leave
 * what the host gave them untouched — that is what keeps an unconfigured
 * install behaving exactly as before. A defined slug is always a non-empty
 * ASCII token, safe to place in a header.
 *
 * The projections differ in what the caller owes its peer.
 * `identityUserAgent` rewrites only a header the host already sends, for
 * provider requests where the host's silence is its own choice;
 * `identityUserAgentOrDefault` always yields one, for directories this process
 * chooses to call. `identityHeaders` applies the former across a header set.
 * `kosong`'s model catalog may not import an app domain, so it carries the
 * same guards inline.
 */

import { replaceUserAgentProduct } from '@moonshot-ai/kimi-code-oauth';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const DEFAULT_IDENTITY_SLUG = 'agent';

export interface IAgentIdentity {
  readonly _serviceBrand: undefined;

  readonly displayName: string | undefined;
  readonly slug: string | undefined;
}

export const IAgentIdentity: ServiceIdentifier<IAgentIdentity> =
  createDecorator<IAgentIdentity>('agentIdentity');

export function normalizeIdentitySlug(raw: string): string {
  const folded = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return folded.length > 0 ? folded : DEFAULT_IDENTITY_SLUG;
}

export function identityUserAgent(
  hostUserAgent: string | undefined,
  slug: string | undefined,
): string | undefined {
  if (hostUserAgent === undefined || slug === undefined) return hostUserAgent;
  return replaceUserAgentProduct(hostUserAgent, slug);
}

export function identityHeaders(
  headers: Readonly<Record<string, string>>,
  slug: string | undefined,
): Record<string, string> {
  const rewritten = identityUserAgent(headers['User-Agent'], slug);
  if (rewritten === undefined) return { ...headers };
  return { ...headers, 'User-Agent': rewritten };
}

export function identityUserAgentOrDefault(
  hostUserAgent: string | undefined,
  slug: string | undefined,
): string {
  return identityUserAgent(hostUserAgent, slug) ?? slug ?? DEFAULT_IDENTITY_SLUG;
}
