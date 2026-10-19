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
  const userAgentKeys = Object.keys(input.hostRequestHeaders).filter(
    (key) => key.toLowerCase() === 'user-agent',
  );
  const hostUserAgent =
    userAgentKeys[0] === undefined ? undefined : input.hostRequestHeaders[userAgentKeys[0]];
  const thirdPartyUserAgent =
    hostUserAgent === undefined || slug === undefined
      ? hostUserAgent
      : replaceUserAgentProduct(hostUserAgent, slug);
  const requestHeaders: Record<string, string> = { ...input.hostRequestHeaders };
  if (slug !== undefined) {
    for (const key of userAgentKeys) {
      const value = requestHeaders[key];
      if (value !== undefined) requestHeaders[key] = replaceUserAgentProduct(value, slug);
    }
  }
  return {
    displayName: name ?? declared(input.hostDisplayName),
    slug,
    outboundUserAgent: thirdPartyUserAgent ?? slug ?? DEFAULT_IDENTITY_SLUG,
    thirdPartyUserAgent,
    requestHeaders,
  };
}

function declared(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
