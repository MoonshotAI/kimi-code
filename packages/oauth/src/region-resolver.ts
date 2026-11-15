import { statSync } from 'node:fs';
import { join } from 'node:path';

import { kimiCodeEnvBaseUrl } from './managed-kimi-code';
import {
  clearKimiRegionCache,
  KIMI_REGION_CACHE_FILENAME,
  readKimiRegionCache,
  writeKimiRegionCache,
  type KimiRegionCacheRecord,
} from './region-cache';
import {
  collectLocalRegionSignals,
  detectKimiRegionFromLocalSignals,
  type LocalRegionDetection,
  type LocalRegionSignals,
} from './region-local';
import {
  KIMI_REGION_MARKER_FILENAME,
  readKimiRegionMarker,
  resolveKimiRegionFromParts,
  type KimiRegion,
  type KimiRegionResolution,
} from './region';

export interface KimiRegionOAuthRef {
  readonly key: string;
  readonly oauthHost?: string;
}

/**
 * Two-state account snapshot: the client is either logged out or logged in
 * with the persisted oauth ref. A read failure (corrupt/unreadable config,
 * un-hydrated provider state) is NOT a state — the reader reports
 * `unreadable` and the resolver short-circuits without inferring, touching
 * the cache, or memoizing, so every read retries and the failure self-heals.
 */
export type KimiRegionAuthSnapshot =
  | { readonly status: 'logged-out' }
  | { readonly status: 'logged-in'; readonly ref: KimiRegionOAuthRef };

export type KimiRegionAuthRead = KimiRegionAuthSnapshot | { readonly status: 'unreadable' };

export type KimiRegionCacheAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'write'; readonly region: KimiRegion }
  | { readonly kind: 'clear' };

export interface KimiRegionDecideInput {
  readonly auth: KimiRegionAuthSnapshot;
  readonly env: NodeJS.ProcessEnv;
  /** Install-channel marker value; absent when unreadable or skipped. */
  readonly marker?: KimiRegion;
  /** Persisted logged-out inference record, when one validates. */
  readonly cacheRecord?: KimiRegionCacheRecord;
  /** Invoked only when the chain reaches local-signals. */
  readonly signals: () => LocalRegionSignals;
  readonly readMarker?: boolean;
  readonly allowLocalInference?: boolean;
}

export interface KimiRegionDecision {
  readonly resolution: KimiRegionResolution;
  readonly cacheAction: KimiRegionCacheAction;
}

/**
 * Pure two-state decision over env > login > marker > cache > local-signals >
 * default. No I/O: file effects are returned as `cacheAction` for the single
 * exit in the resolver to execute once.
 */
export function decideKimiRegion(input: KimiRegionDecideInput): KimiRegionDecision {
  const ref = input.auth.status === 'logged-in' ? input.auth.ref : undefined;
  const explicit = resolveKimiRegionFromParts({
    env: input.env,
    configuredOAuthHost: ref?.oauthHost,
    configuredOAuthKey: ref?.key,
    marker: input.marker,
  });
  if (explicit.source === 'env') {
    return {
      resolution: explicit,
      cacheAction: input.auth.status === 'logged-in' ? { kind: 'clear' } : { kind: 'none' },
    };
  }
  if (input.auth.status === 'logged-in') {
    return { resolution: explicit, cacheAction: { kind: 'clear' } };
  }
  if (explicit.source === 'marker') {
    return { resolution: explicit, cacheAction: { kind: 'none' } };
  }
  if (
    input.readMarker === false ||
    input.allowLocalInference === false ||
    kimiCodeEnvBaseUrl(input.env) !== undefined
  ) {
    return { resolution: explicit, cacheAction: { kind: 'none' } };
  }
  if (input.cacheRecord !== undefined) {
    return {
      resolution: { region: input.cacheRecord.region, source: input.cacheRecord.source },
      cacheAction: { kind: 'none' },
    };
  }
  let detection: LocalRegionDetection;
  try {
    detection = detectKimiRegionFromLocalSignals(input.signals());
  } catch {
    return {
      resolution: { region: 'mainland-cn', source: 'fallback' },
      cacheAction: { kind: 'none' },
    };
  }
  if (!detection.confident) {
    return {
      resolution: { region: detection.region, source: 'fallback' },
      cacheAction: { kind: 'none' },
    };
  }
  return {
    resolution: { region: detection.region, source: 'local-signals' },
    cacheAction: { kind: 'write', region: detection.region },
  };
}

export interface CreateKimiRegionResolverOptions {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readAuth: () => KimiRegionAuthRead;
  /**
   * Path of the file `readAuth` parses (config.toml). When set, `readAuth`
   * only runs again after the file's stat fingerprint changes; hosts whose
   * snapshot lives in memory leave this unset and the snapshot enters the
   * memo basis directly.
   */
  readonly authFilePath?: string;
  readonly readMarker?: boolean;
  readonly allowLocalInference?: boolean;
  readonly collectSignals?: () => LocalRegionSignals;
}

export interface KimiRegionResolver {
  current(): KimiRegionResolution;
  /** Force a full re-read of every input; `current()` re-validates via stat. */
  refresh(): KimiRegionResolution;
}

interface FileRead<T> {
  readonly fingerprint: string;
  readonly value: T;
}

function statFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${String(stat.mtimeMs)}:${String(stat.size)}`;
  } catch {
    return 'absent';
  }
}

function authBasis(auth: KimiRegionAuthRead): string {
  if (auth.status !== 'logged-in') return auth.status;
  return JSON.stringify([auth.status, auth.ref.key, auth.ref.oauthHost]);
}

export function createKimiRegionResolver(
  options: CreateKimiRegionResolverOptions,
): KimiRegionResolver {
  const env = options.env ?? process.env;
  const collectSignals = options.collectSignals ?? collectLocalRegionSignals;
  const markerPath = join(options.homeDir, KIMI_REGION_MARKER_FILENAME);
  const cachePath = join(options.homeDir, KIMI_REGION_CACHE_FILENAME);
  let memo: { readonly basis: string; readonly resolution: KimiRegionResolution } | undefined;
  let authRead: FileRead<KimiRegionAuthRead> | undefined;
  let markerRead: FileRead<KimiRegion | undefined> | undefined;
  let cacheRead: FileRead<KimiRegionCacheRecord | undefined> | undefined;

  function readAuth(): KimiRegionAuthRead {
    try {
      return options.readAuth();
    } catch {
      return { status: 'unreadable' };
    }
  }

  function current(): KimiRegionResolution {
    let auth: KimiRegionAuthRead;
    let authFileFingerprint: string | undefined;
    if (options.authFilePath !== undefined) {
      authFileFingerprint = statFingerprint(options.authFilePath);
      if (authRead?.fingerprint === authFileFingerprint) {
        auth = authRead.value;
      } else {
        auth = readAuth();
        authRead = { fingerprint: authFileFingerprint, value: auth };
      }
    } else {
      auth = readAuth();
    }

    let marker: KimiRegion | undefined;
    let markerFingerprint = 'off';
    if (options.readMarker !== false) {
      markerFingerprint = statFingerprint(markerPath);
      if (markerRead?.fingerprint === markerFingerprint) {
        marker = markerRead.value;
      } else {
        marker = readKimiRegionMarker(options.homeDir);
        markerRead = { fingerprint: markerFingerprint, value: marker };
      }
    }

    if (auth.status === 'unreadable') {
      return resolveKimiRegionFromParts({ env, marker });
    }

    let cacheRecord: KimiRegionCacheRecord | undefined;
    const cacheFingerprint = statFingerprint(cachePath);
    if (cacheRead?.fingerprint === cacheFingerprint) {
      cacheRecord = cacheRead.value;
    } else {
      cacheRecord = readKimiRegionCache(options.homeDir);
      cacheRead = { fingerprint: cacheFingerprint, value: cacheRecord };
    }

    const basis = JSON.stringify([
      authBasis(auth),
      env['KIMI_CODE_OAUTH_HOST'],
      env['KIMI_OAUTH_HOST'],
      env['KIMI_CODE_BASE_URL'],
      authFileFingerprint,
      markerFingerprint,
      cacheFingerprint,
    ]);
    if (memo?.basis === basis) return memo.resolution;

    const decision = decideKimiRegion({
      auth,
      env,
      marker,
      cacheRecord,
      signals: collectSignals,
      readMarker: options.readMarker,
      allowLocalInference: options.allowLocalInference,
    });
    if (decision.cacheAction.kind === 'write') {
      writeKimiRegionCache(options.homeDir, decision.cacheAction.region);
    } else if (decision.cacheAction.kind === 'clear') {
      clearKimiRegionCache(options.homeDir);
    }
    memo = { basis, resolution: decision.resolution };
    return decision.resolution;
  }

  function refresh(): KimiRegionResolution {
    memo = undefined;
    authRead = undefined;
    markerRead = undefined;
    cacheRead = undefined;
    return current();
  }

  return { current, refresh };
}
