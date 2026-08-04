/**
 * `agentIdentity` domain — resolved identity contract.
 *
 * The identity the agent uses for itself, resolved from the `[identity]`
 * config section over the host's declared display name and frozen for the
 * life of the process: the identity is announced outward — MCP initialize,
 * OAuth client registration, provider request logs — and none of those can be
 * re-announced, so a mid-process change could only ever apply partially.
 * Freezing makes the one coherent semantic ("restart to change") the actual
 * contract, and lets consumers bake the snapshot into caches, prompts, and
 * connections without any invalidation obligations. Bound at App scope.
 *
 * Access is the enforcement point: `resolved()` waits for the config-derived
 * freeze, so a consumer cannot read a pre-config value by being early;
 * `current()` serves the frozen snapshot synchronously and throws before the
 * freeze, so a path that materializes identity too early fails loudly instead
 * of caching the wrong name.
 *
 * The snapshot carries finished products, not raw material — call sites must
 * not compose host headers with the slug themselves. `displayName` fills the
 * prompt's `${product_name}` slot (`undefined`: the template default applies).
 * `slug` is the protocol token for MCP client naming (`undefined`: no custom
 * identity, peers get the built-in name); when defined it is always a
 * non-empty ASCII token, safe to place in a header. `thirdPartyUserAgent`
 * rewrites only a `User-Agent` the host already sends — for provider
 * requests, where the host's silence is its own choice — while
 * `outboundUserAgent` always yields one, for directories this process chooses
 * to call. `requestHeaders` is the host's full header set with the
 * `User-Agent` product token rewritten, for self-configured service
 * endpoints.
 */

import { replaceUserAgentProduct } from '@moonshot-ai/kimi-code-oauth';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const DEFAULT_IDENTITY_SLUG = 'agent';

export interface AgentIdentitySnapshot {
  readonly displayName: string | undefined;
  readonly slug: string | undefined;
  readonly outboundUserAgent: string;
  readonly thirdPartyUserAgent: string | undefined;
  readonly requestHeaders: Readonly<Record<string, string>>;
}

export interface IAgentIdentity {
  readonly _serviceBrand: undefined;

  resolved(): Promise<AgentIdentitySnapshot>;
  current(): AgentIdentitySnapshot;
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

export interface AgentIdentityInput {
  readonly name?: string;
  readonly slug?: string;
  readonly hostDisplayName?: string;
  readonly hostRequestHeaders: Readonly<Record<string, string>>;
}

export function buildAgentIdentitySnapshot(input: AgentIdentityInput): AgentIdentitySnapshot {
  const name = declared(input.name);
  const rawSlug = declared(input.slug) ?? name;
  const slug = rawSlug === undefined ? undefined : normalizeIdentitySlug(rawSlug);
  const hostUserAgent = input.hostRequestHeaders['User-Agent'];
  const thirdPartyUserAgent =
    hostUserAgent === undefined || slug === undefined
      ? hostUserAgent
      : replaceUserAgentProduct(hostUserAgent, slug);
  return {
    displayName: name ?? declared(input.hostDisplayName),
    slug,
    outboundUserAgent: thirdPartyUserAgent ?? slug ?? DEFAULT_IDENTITY_SLUG,
    thirdPartyUserAgent,
    requestHeaders:
      thirdPartyUserAgent === undefined
        ? { ...input.hostRequestHeaders }
        : { ...input.hostRequestHeaders, 'User-Agent': thirdPartyUserAgent },
  };
}

function declared(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
