import { SessionClientIdentitySchema, type SessionClientIdentity } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

export const CLIENT_IDENTITY_HEADER = 'x-kimi-client-identity';

export const MAX_CLIENT_IDENTITY_HEADER_LENGTH = 8192;

const clientIdentityHeaderValueSchema = z
  .string()
  .max(MAX_CLIENT_IDENTITY_HEADER_LENGTH)
  .regex(/^[\w-]+$/, 'must be base64url without padding');

const clientIdentityWireSchema = z
  .object({
    product_name: z.string(),
    version: z.string(),
    platform: z.string(),
    user_agent_suffix: z.string().optional(),
    display_name: z.string().optional(),
    reply_style_guide: z.string().optional(),
    ui_capabilities: z.array(z.string()).optional(),
  })
  .transform((wire): z.input<typeof SessionClientIdentitySchema> => ({
    productName: wire.product_name,
    version: wire.version,
    platform: wire.platform,
    userAgentSuffix: wire.user_agent_suffix,
    displayName: wire.display_name,
    replyStyleGuide: wire.reply_style_guide,
    uiCapabilities: wire.ui_capabilities,
  }))
  .pipe(SessionClientIdentitySchema);

export const clientIdentityRequestHeadersSchema = z.object({
  [CLIENT_IDENTITY_HEADER]: clientIdentityHeaderValueSchema
    .optional()
    .describe(
      'Base64url-encoded JSON identity of the client creating the session: { product_name, version, platform, user_agent_suffix?, display_name?, reply_style_guide?, ui_capabilities? }. The session keeps it for its whole lifetime and its forks inherit it. An invalid value is ignored and the session uses the server identity.',
    ),
});

export type ClientIdentityHeaderResult =
  | { readonly success: true; readonly identity: SessionClientIdentity }
  | { readonly success: false; readonly reason: string };

export function parseClientIdentityHeader(value: unknown): ClientIdentityHeaderResult {
  const header = clientIdentityHeaderValueSchema.safeParse(value);
  if (!header.success) return { success: false, reason: z.prettifyError(header.error) };
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(header.data, 'base64url')),
    );
  } catch {
    return { success: false, reason: 'must encode UTF-8 JSON' };
  }
  const identity = clientIdentityWireSchema.safeParse(decoded);
  return identity.success
    ? { success: true, identity: identity.data }
    : { success: false, reason: z.prettifyError(identity.error) };
}

export function encodeClientIdentityHeader(identity: SessionClientIdentity): string {
  const wire = {
    product_name: identity.productName,
    version: identity.version,
    platform: identity.platform,
    user_agent_suffix: identity.userAgentSuffix,
    display_name: identity.displayName,
    reply_style_guide: identity.replyStyleGuide,
    ui_capabilities: identity.uiCapabilities,
  };
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}
