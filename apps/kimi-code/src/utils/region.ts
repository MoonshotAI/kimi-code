/**
 * Process-wide region cache for the CLI/TUI.
 *
 * Region decides which deployment (mainland-China .com / international .ai)
 * the client's off-session endpoints point at: CDN (updates, plugins, tips),
 * site links, telemetry. The OAuth login flow itself does NOT read this — it
 * takes explicit hosts; this cache is for everything derived afterwards.
 *
 * Resolution lives in `@moonshot-ai/kimi-code-oauth` (see `resolveKimiRegion`);
 * this module only adds the one thing that package deliberately does not own:
 * reading the persisted login's oauth ref (credential key + `oauthHost`) out
 * of config.toml, synchronously, via the SDK's safe config reader. First call
 * wins; `refreshKimiRegion` re-resolves after login/logout rewrote the oauth
 * ref.
 */

import { loadRuntimeConfigSafe, resolveConfigPath } from '@moonshot-ai/kimi-code-sdk';
import {
  KIMI_CODE_OAUTH_KEY,
  KIMI_REGION_PROFILES,
  resolveKimiRegion,
  type KimiRegion,
  type KimiRegionProfile,
} from '@moonshot-ai/kimi-code-oauth';

// Same value as DEFAULT_OAUTH_PROVIDER_NAME in '#/constant/app' — inlined here
// to keep the import one-directional (constant/app derives URLs from this
// module, so this module must not import back from it).
const MANAGED_KIMI_CODE_PROVIDER_KEY = 'managed:kimi-code';

/** Platform-selector value for the global OAuth login entry. */
export const KIMI_CODE_GLOBAL_PLATFORM_VALUE = 'kimi-code-global';

let cached: KimiRegion | undefined;

export interface PersistedKimiOAuthRef {
  readonly key: string;
  readonly oauthHost?: string;
}

/** The oauth ref persisted by a previous login, if any. */
export function persistedKimiOAuthRef(): PersistedKimiOAuthRef | undefined {
  const result = loadRuntimeConfigSafe(resolveConfigPath({}));
  // `providers` is always present on a real config load; the `?.` guards
  // hosts/tests that hand us a partial config shape.
  const oauth = result.config.providers?.[MANAGED_KIMI_CODE_PROVIDER_KEY]?.oauth;
  if (oauth === undefined) return undefined;
  return { key: oauth.key, oauthHost: oauth.oauthHost };
}

/** Region for a no-flag `kimi login` / `kimi acp --login`: a fresh install
    follows the resolved region (env/marker/default); the default slot (only
    ever a mainland-cn login) re-pins the profile explicitly; a scoped slot —
    a global login, or a custom env persisted with only KIMI_CODE_BASE_URL and
    no oauthHost — keeps its configured hosts (`undefined`). */
export function regionForBareLogin(ref: PersistedKimiOAuthRef | undefined): KimiRegion | undefined {
  if (ref === undefined) return currentKimiRegion();
  return ref.key === KIMI_CODE_OAUTH_KEY ? 'mainland-cn' : undefined;
}

export function currentKimiRegion(): KimiRegion {
  if (cached === undefined) {
    const persisted = persistedKimiOAuthRef();
    cached = resolveKimiRegion({
      configuredOAuthHost: persisted?.oauthHost,
      configuredOAuthKey: persisted?.key,
      readMarker: process.env['KIMI_CODE_REGION_MARKER'] !== 'off',
    });
  }
  return cached;
}

export function currentKimiProfile(): KimiRegionProfile {
  return KIMI_REGION_PROFILES[currentKimiRegion()];
}

/** Drop the cache and re-resolve. Call after login/logout rewrote config. */
export function refreshKimiRegion(): KimiRegion {
  cached = undefined;
  return currentKimiRegion();
}
