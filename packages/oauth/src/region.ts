import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { DEFAULT_KIMI_CODE_OAUTH_HOST } from './constants';
import { DEFAULT_KIMI_CODE_BASE_URL } from './managed-usage';
import {
  kimiCodeEnvBaseUrl,
  kimiCodeEnvOAuthHost,
  KIMI_CODE_OAUTH_KEY,
  resolveKimiCodeOAuthRef,
} from './managed-kimi-code';

export type KimiRegion = 'mainland-cn' | 'global';

export const kimiRegionSchema = z.enum(['mainland-cn', 'global']);

export interface KimiRegionProfile {
  readonly oauthHost: string;
  readonly baseUrl: string;
  readonly cdnBase: string;
  readonly siteBase: string;
  readonly telemetryEndpoint?: string;
  readonly relayOrigin: string;
}

export const KIMI_REGION_PROFILES: Record<KimiRegion, KimiRegionProfile> = {
  'mainland-cn': {
    oauthHost: DEFAULT_KIMI_CODE_OAUTH_HOST,
    baseUrl: DEFAULT_KIMI_CODE_BASE_URL,
    cdnBase: 'https://code.kimi.com/kimi-code',
    siteBase: 'https://www.kimi.com',
    telemetryEndpoint: 'https://telemetry-logs.kimi.com/v1/event',
    relayOrigin: 'https://code-rc.kimi.com',
  },
  global: {
    oauthHost: 'https://auth.kimi.ai',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    cdnBase: 'https://code.kimi.ai/kimi-code',
    siteBase: 'https://www.kimi.ai',
    telemetryEndpoint: 'https://telemetry-logs.kimi.ai/v1/event',
    relayOrigin: 'https://code-rc.kimi.ai',
  },
};

export function kimiRegionProfile(region: KimiRegion): KimiRegionProfile {
  return KIMI_REGION_PROFILES[region];
}

export function kimiCdnContentUrl(path: string): string {
  return `https://cdn.kimi.com/${path.replace(/^\/+/, '')}`;
}

export function kimiRegionLoginHosts(
  region: KimiRegion,
  env: NodeJS.ProcessEnv = process.env,
): { readonly oauthHost: string; readonly baseUrl: string } | undefined {
  if (kimiCodeEnvOAuthHost(env) !== undefined || kimiCodeEnvBaseUrl(env) !== undefined) {
    return undefined;
  }
  const profile = kimiRegionProfile(region);
  return { oauthHost: profile.oauthHost, baseUrl: profile.baseUrl };
}

export const KIMI_REGION_MARKER_FILENAME = 'region';

export interface ResolveKimiRegionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly configuredOAuthHost?: string;
  readonly configuredOAuthKey?: string;
  readonly homeDir?: string;
  readonly readMarker?: boolean;
}

function normalizeHost(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function regionForOAuthHost(oauthHost: string): KimiRegion | undefined {
  const normalized = normalizeHost(oauthHost);
  for (const region of Object.keys(KIMI_REGION_PROFILES) as KimiRegion[]) {
    if (normalizeHost(KIMI_REGION_PROFILES[region].oauthHost) === normalized) return region;
  }
  return undefined;
}

export function readKimiRegionMarker(homeDir: string): KimiRegion | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(homeDir, KIMI_REGION_MARKER_FILENAME), 'utf-8');
  } catch {
    return undefined;
  }
  const value = raw.trim();
  return value === 'mainland-cn' || value === 'global' ? value : undefined;
}

function defaultHomeDir(env: NodeJS.ProcessEnv): string {
  const override = env['KIMI_CODE_HOME'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.kimi-code');
}

export type KimiRegionSource =
  | 'env'
  | 'login'
  | 'marker'
  | 'local-signals'
  | 'fallback'
  | 'default';

export interface KimiRegionResolution {
  readonly region: KimiRegion;
  readonly source: KimiRegionSource;
}

export interface ResolveKimiRegionParts {
  readonly env?: NodeJS.ProcessEnv;
  readonly configuredOAuthHost?: string;
  readonly configuredOAuthKey?: string;
  readonly marker?: KimiRegion;
}

export function resolveKimiRegionFromParts(
  parts: ResolveKimiRegionParts,
): KimiRegionResolution {
  const env = parts.env ?? process.env;
  const envHost = env['KIMI_CODE_OAUTH_HOST'] ?? env['KIMI_OAUTH_HOST'];
  if (envHost !== undefined && envHost.length > 0) {
    return { region: regionForOAuthHost(envHost) ?? 'mainland-cn', source: 'env' };
  }
  const configured = parts.configuredOAuthHost;
  if (configured !== undefined && configured.length > 0) {
    const configuredRegion = regionForOAuthHost(configured);
    if (configuredRegion !== undefined) return { region: configuredRegion, source: 'login' };
  }
  if (parts.configuredOAuthKey === KIMI_CODE_OAUTH_KEY) {
    return { region: 'mainland-cn', source: 'login' };
  }
  if (parts.marker !== undefined) return { region: parts.marker, source: 'marker' };
  return { region: 'mainland-cn', source: 'default' };
}

export function resolveKimiRegionDetailed(
  options: ResolveKimiRegionOptions = {},
): KimiRegionResolution {
  const env = options.env ?? process.env;
  const marker =
    options.readMarker === false
      ? undefined
      : readKimiRegionMarker(options.homeDir ?? defaultHomeDir(env));
  return resolveKimiRegionFromParts({
    env,
    configuredOAuthHost: options.configuredOAuthHost,
    configuredOAuthKey: options.configuredOAuthKey,
    marker,
  });
}

export function resolveKimiRegion(options: ResolveKimiRegionOptions = {}): KimiRegion {
  return resolveKimiRegionDetailed(options).region;
}

export interface KimiRemoteControlAuth {
  readonly region: KimiRegion;
  readonly oauthKey: string;
  readonly relayOrigin: string;
}

export function resolveKimiRemoteControlAuth(
  options: ResolveKimiRegionOptions = {},
): KimiRemoteControlAuth {
  const region = resolveKimiRegion(options);
  const profile = kimiRegionProfile(region);
  const configuredKey = options.configuredOAuthKey;
  const customSlot =
    configuredKey !== undefined &&
    configuredKey !== KIMI_CODE_OAUTH_KEY &&
    configuredKey !==
      resolveKimiCodeOAuthRef({
        oauthHost: KIMI_REGION_PROFILES.global.oauthHost,
        baseUrl: KIMI_REGION_PROFILES.global.baseUrl,
      }).key;
  const hostPinned =
    options.configuredOAuthHost !== undefined &&
    regionForOAuthHost(options.configuredOAuthHost) !== undefined;
  return {
    region,
    oauthKey:
      configuredKey ??
      resolveKimiCodeOAuthRef({
        oauthHost: profile.oauthHost,
        baseUrl: profile.baseUrl,
      }).key,
    relayOrigin:
      customSlot && !hostPinned
        ? KIMI_REGION_PROFILES['mainland-cn'].relayOrigin
        : profile.relayOrigin,
  };
}
