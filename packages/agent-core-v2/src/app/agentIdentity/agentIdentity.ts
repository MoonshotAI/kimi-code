/**
 * `agentIdentity` domain — resolved identity contract.
 *
 * The identity the agent presents to the outside world, resolved from the
 * `[identity]` config section over the host's declared display name. It has
 * two faces, and they are deliberately NOT symmetric:
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
 * The asymmetry is what keeps the feature safe: with no identity configured,
 * the protocol-rewriting code paths are equivalent to not existing at all.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** Fallback slug when a name normalizes to nothing (e.g. a CJK-only name). */
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

/**
 * Fold an arbitrary human name into a protocol-safe token.
 *
 * Everything outside `[a-z0-9]` collapses to `-`, so the result is ASCII by
 * construction — this is what stops a non-ASCII name from reaching the
 * User-Agent builder, which rejects a blank/non-ASCII product token by
 * throwing. A name that leaves nothing behind (CJK-only, punctuation-only,
 * blank) falls back to {@link DEFAULT_IDENTITY_SLUG} rather than producing an
 * empty token.
 */
export function normalizeIdentitySlug(raw: string): string {
  const folded = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return folded.length > 0 ? folded : DEFAULT_IDENTITY_SLUG;
}
