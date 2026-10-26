import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
} from '@moonshot-ai/kimi-code-sdk';
import {
  createKimiRegionResolver,
  KIMI_CODE_OAUTH_KEY,
  KIMI_REGION_PROFILES,
  type KimiRegion,
  type KimiRegionAuthRead,
  type KimiRegionProfile,
  type KimiRegionResolution,
  type KimiRegionResolver,
} from '@moonshot-ai/kimi-code-oauth';

const MANAGED_KIMI_CODE_PROVIDER_KEY = 'managed:kimi-code';

export const KIMI_CODE_GLOBAL_PLATFORM_VALUE = 'kimi-code-global';

export interface PersistedKimiOAuthRef {
  readonly key: string;
  readonly oauthHost?: string;
}

export function persistedKimiOAuthRef(): PersistedKimiOAuthRef | undefined {
  const result = loadRuntimeConfigSafe(resolveConfigPath({}));
  const oauth = result.config.providers?.[MANAGED_KIMI_CODE_PROVIDER_KEY]?.oauth;
  if (oauth === undefined) return undefined;
  return { key: oauth.key, oauthHost: oauth.oauthHost };
}

function readAuth(): KimiRegionAuthRead {
  try {
    const result = loadRuntimeConfigSafe(resolveConfigPath({}));
    if (result.fileError !== undefined) return { status: 'unreadable' };
    const ref = result.config.providers?.[MANAGED_KIMI_CODE_PROVIDER_KEY]?.oauth;
    return ref === undefined ? { status: 'logged-out' } : { status: 'logged-in', ref };
  } catch {
    return { status: 'unreadable' };
  }
}

let resolver: KimiRegionResolver | undefined;

function regionResolver(): KimiRegionResolver {
  resolver ??= createKimiRegionResolver({
    homeDir: resolveKimiHome(),
    readAuth,
    authFilePath: resolveConfigPath({}),
    readMarker: process.env['KIMI_CODE_REGION_MARKER'] !== 'off',
  });
  return resolver;
}

export function regionForBareLogin(ref: PersistedKimiOAuthRef | undefined): KimiRegion | undefined {
  if (ref === undefined) return currentKimiRegion();
  return ref.key === KIMI_CODE_OAUTH_KEY ? 'mainland-cn' : undefined;
}

export function currentKimiRegionResolution(): KimiRegionResolution {
  return regionResolver().current();
}

export function resolveKimiRegionFresh(): KimiRegionResolution {
  return regionResolver().refresh();
}

export function currentKimiRegion(): KimiRegion {
  return currentKimiRegionResolution().region;
}

export function currentKimiProfile(): KimiRegionProfile {
  return KIMI_REGION_PROFILES[currentKimiRegion()];
}

export function freshKimiProfile(): KimiRegionProfile {
  return KIMI_REGION_PROFILES[resolveKimiRegionFresh().region];
}

export function refreshKimiRegion(): KimiRegion {
  return resolveKimiRegionFresh().region;
}

export function resetKimiRegionCache(): void {
  resolver = undefined;
}
