/**
 * Kimi Code version helpers.
 *
 * `getVersion` reads the host CLI's `package.json#version`.
 */

import { readFileSync } from 'node:fs';

import { createKimiUserAgent, KIMI_CODE_PLATFORM, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import { KIMI_BUILD_INFO } from './build-info';
import { getHostPackageJsonPath } from './host-package';

export { getHostPackageJsonPath, getHostPackageRoot } from './host-package';

export function getVersion(): string {
  if (KIMI_BUILD_INFO.version !== undefined) {
    return KIMI_BUILD_INFO.version;
  }
  const pkg = JSON.parse(readFileSync(getHostPackageJsonPath(), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

export function createKimiCodeHostIdentity(version = getVersion()): KimiHostIdentity {
  return {
    productName: CLI_USER_AGENT_PRODUCT,
    version,
    platform: KIMI_CODE_PLATFORM,
  };
}

/**
 * Product User-Agent (`kimi-code-cli/<version>`) for ad-hoc outbound fetches
 * that don't go through the provider pipeline (registry / catalog imports).
 */
export function createKimiCodeUserAgent(version = getVersion()): string {
  return createKimiUserAgent(createKimiCodeHostIdentity(version));
}
