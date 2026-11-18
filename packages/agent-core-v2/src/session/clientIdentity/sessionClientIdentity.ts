import { createKimiUserAgent } from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

import type { ScopeSeed } from '#/_base/di/scope';
import {
  HOST_UI_CAPABILITIES,
  type HostUiCapability,
  type IBootstrapService,
} from '#/app/bootstrap/bootstrap';
import {
  IClientIdentity,
  clientIdentityScopedServiceSeed,
} from '#/app/clientIdentity/clientIdentity';

export interface SessionClientIdentity {
  readonly productName: string;
  readonly version: string;
  readonly platform: string;
  readonly userAgentSuffix?: string;
  readonly displayName?: string;
  readonly replyStyleGuide?: string;
  readonly uiCapabilities?: readonly HostUiCapability[];
}

const MAX_HEADER_FIELD_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_REPLY_STYLE_GUIDE_LENGTH = 4096;
const MAX_UI_CAPABILITIES = 16;
const MAX_UI_CAPABILITY_LENGTH = 64;

const headerField = z
  .string()
  .trim()
  .max(MAX_HEADER_FIELD_LENGTH)
  .regex(/^[\x20-\x7E]*$/, 'must be printable ASCII');

export const SessionClientIdentitySchema = z.object({
  productName: headerField.min(1),
  version: headerField.min(1),
  platform: headerField.min(1),
  userAgentSuffix: headerField.optional(),
  displayName: z
    .string()
    .max(MAX_DISPLAY_NAME_LENGTH)
    .regex(/^\P{Cc}*$/u, 'must not contain control characters')
    .optional(),
  replyStyleGuide: z.string().max(MAX_REPLY_STYLE_GUIDE_LENGTH).optional(),
  uiCapabilities: z
    .array(z.string().max(MAX_UI_CAPABILITY_LENGTH))
    .max(MAX_UI_CAPABILITIES)
    .transform((values) => values.filter(isHostUiCapability))
    .optional(),
});

const CLIENT_IDENTITY_HEADER_NAMES: ReadonlySet<string> = new Set([
  'user-agent',
  'x-msh-platform',
  'x-msh-version',
]);

export function sessionClientIdentitySeed(
  identity: SessionClientIdentity | undefined,
  bootstrap: IBootstrapService,
): ScopeSeed {
  if (identity === undefined) return [];
  const client: IClientIdentity = {
    _serviceBrand: undefined,
    ...identity,
    requestHeaders: clientRequestHeaders(bootstrap.args.requestHeaders, identity),
  };
  return [[IClientIdentity, client], ...clientIdentityScopedServiceSeed()];
}

function clientRequestHeaders(
  serverRequestHeaders: Readonly<Record<string, string>>,
  identity: SessionClientIdentity,
): Readonly<Record<string, string>> {
  const machineHeaders = Object.entries(serverRequestHeaders).filter(
    ([name]) => !CLIENT_IDENTITY_HEADER_NAMES.has(name.toLowerCase()),
  );
  return {
    ...Object.fromEntries(machineHeaders),
    'User-Agent': createKimiUserAgent(identity),
    'X-Msh-Platform': identity.platform,
    'X-Msh-Version': identity.version,
  };
}

function isHostUiCapability(value: string): value is HostUiCapability {
  return (HOST_UI_CAPABILITIES as readonly string[]).includes(value);
}
