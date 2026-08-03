/**
 * `agentIdentity` domain — resolved identity contract.
 *
 * The identity the agent uses for itself, resolved from the `[identity]`
 * config section over the host's declared display name. It has two faces, and
 * they are deliberately NOT symmetric:
 *
 * - `displayName` fills the `${product_name}` slot in the system prompt. It is
 *   a *filling* value: `config > host-declared > (consumer's own default)`.
 *   `undefined` here means "nobody declared one" — the consumer applies its own
 *   fallback, so this domain never needs to know the prompt's default text.
 * - `slug` is the machine identifier for protocol fields (User-Agent product
 *   token, MCP client name). It is a *rewriting* value with only two states:
 *   `undefined` means no custom identity was declared, so consumers must leave
 *   what the host gave them completely untouched. A defined slug is always a
 *   non-empty ASCII token safe to place in a header.
 *
 * The asymmetry is deliberate: with no identity configured the rewriting
 * paths are equivalent to not existing, so an unconfigured install behaves
 * exactly as it did before.
 *
 * `normalizeIdentitySlug` folds an arbitrary human name into that protocol-safe
 * token: everything outside `[a-z0-9]` collapses to `-`, which is what stops a
 * non-ASCII name from reaching the User-Agent builder — that builder throws on
 * a blank or non-ASCII product token. A name leaving nothing behind (CJK-only,
 * punctuation-only, blank) yields `DEFAULT_IDENTITY_SLUG` instead of an empty
 * token.
 *
 * `identityUserAgent` projects the identity onto a host User-Agent for the
 * app-scope callers that issue their own outbound requests: no identity, or no
 * host header to rewrite, leaves the value untouched. `kosong`'s model catalog
 * cannot use it — a foundational layer must not import an app domain — so it
 * carries the same two guards inline against its header map.
 */

import { replaceUserAgentProduct } from '@moonshot-ai/kimi-code-oauth';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const DEFAULT_IDENTITY_SLUG = 'agent';

export interface IAgentIdentity {
  readonly _serviceBrand: undefined;

  /**
   * Display name for the system prompt, or `undefined` when neither the user
   * nor the host declared one (the caller then applies its own default).
   */
  readonly displayName: string | undefined;
  /**
   * Protocol identifier, or `undefined` when no custom identity is configured
   * — in which case callers must not rewrite anything. Always a non-empty
   * ASCII token when defined.
   */
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
