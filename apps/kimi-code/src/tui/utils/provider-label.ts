/**
 * Readable label for a configured provider id.
 *
 * Config stores provider ids (`managed:kimi-code`, `managed:<vendor>`, or a
 * user-chosen name); every surface that shows one to the user — the model
 * dialogs and the footer status line — renders it through here so the
 * `managed:` plumbing never leaks into the UI.
 */

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}
