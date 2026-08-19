/**
 * Browser-safe region profile table for the mainland-China (.com) and global
 * (.ai) Kimi Code deployments. Pure data — no node:fs / node:os / process —
 * so browser bundles (e.g. the Remote Control auth-login page) can pick an
 * OAuth host by their own hostname. `region.ts` re-exports everything here
 * and adds the node-only resolver on top; keep the two in sync.
 */

import { DEFAULT_KIMI_CODE_OAUTH_HOST } from './constants';

export type KimiRegion = 'mainland-cn' | 'global';

export interface KimiRegionProfile {
  /** OAuth host the device flow talks to (authorize/token derive from it). */
  readonly oauthHost: string;
  /** Managed API base (`/coding/v1`): usages, userinfo, models, feedback... */
  readonly baseUrl: string;
  /** Update/install/plugin-marketplace root. */
  readonly cdnBase: string;
  /** Official site root (docs, console, signup, upgrade pages). */
  readonly siteBase: string;
  readonly telemetryEndpoint: string;
}

export const KIMI_REGION_PROFILES: Record<KimiRegion, KimiRegionProfile> = {
  'mainland-cn': {
    oauthHost: DEFAULT_KIMI_CODE_OAUTH_HOST,
    baseUrl: 'https://api.kimi.com/coding/v1',
    cdnBase: 'https://code.kimi.com/kimi-code',
    siteBase: 'https://www.kimi.com',
    telemetryEndpoint: 'https://telemetry-logs.kimi.com/v1/event',
  },
  global: {
    oauthHost: 'https://auth.kimi.ai',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    cdnBase: 'https://code.kimi.ai/kimi-code',
    siteBase: 'https://www.kimi.ai',
    telemetryEndpoint: 'https://telemetry-logs.kimi.ai/v1/event',
  },
};

export function kimiRegionProfile(region: KimiRegion): KimiRegionProfile {
  return KIMI_REGION_PROFILES[region];
}
