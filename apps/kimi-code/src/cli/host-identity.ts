/**
 * Kimi Code host identity and product User-Agent.
 */

import { createKimiUserAgent, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { CLI_MSH_PLATFORM, CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import { getVersion } from './version';

export function createKimiCodeHostIdentity(version = getVersion()): KimiHostIdentity {
  return {
    productName: CLI_USER_AGENT_PRODUCT,
    version,
    platform: CLI_MSH_PLATFORM,
  };
}

/**
 * Product User-Agent (`kimi-code-cli/<version>`) for ad-hoc outbound fetches
 * that don't go through the provider pipeline (registry / catalog imports).
 */
export function createKimiCodeUserAgent(version = getVersion()): string {
  return createKimiUserAgent(createKimiCodeHostIdentity(version));
}
