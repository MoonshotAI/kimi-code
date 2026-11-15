import type { ArtexAsset } from '#/features/artex/protocol/index';
import type {
  ArtexAssetInterceptKind,
  ArtexAssetInterceptRule,
} from '#/features/artex/store/artexWorkStore';

import { cidrContainsIp } from './net';

export function artexAssetInterceptKindLabel(kind: ArtexAssetInterceptKind): string {
  switch (kind) {
    case 'exact_domain':
      return 'Domain (exact)';
    case 'exact_ip':
      return 'IP (exact)';
    case 'exact_url':
      return 'URL (exact)';
    case 'fuzzy_domain':
      return 'Domain (fuzzy)';
    case 'fuzzy_ip':
      return 'IP (fuzzy)';
    case 'fuzzy_url':
      return 'URL (fuzzy)';
    case 'cidr':
      return 'CIDR range';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function artexAssetInterceptReason(rule: ArtexAssetInterceptRule): string {
  let reason = `Matched asset interception rule [${artexAssetInterceptKindLabel(rule.kind)}: ${rule.pattern}]`;
  const note = rule.note.trim();
  if (note !== '') reason += ` (${note})`;
  return reason;
}

export interface ArtexAssetMatch {
  readonly rule: ArtexAssetInterceptRule;
  readonly value: string;
}

function matchOne(
  rule: ArtexAssetInterceptRule,
  domains: readonly string[],
  ips: readonly string[],
  urls: readonly string[],
): string | undefined {
  const pattern = rule.pattern.trim();
  if (pattern === '') return undefined;
  switch (rule.kind) {
    case 'exact_domain':
      return domains.find((domain) => domain.trim().toLowerCase() === pattern.toLowerCase());
    case 'exact_ip':
      return ips.find((ip) => ip.trim() === pattern);
    case 'exact_url':
      return urls.find((url) => url.trim() === pattern);
    case 'fuzzy_domain': {
      const needle = pattern.toLowerCase();
      return domains.find((domain) => domain !== '' && domain.toLowerCase().includes(needle));
    }
    case 'fuzzy_ip':
      return ips.find((ip) => ip !== '' && ip.includes(pattern));
    case 'fuzzy_url': {
      const needle = pattern.toLowerCase();
      return urls.find((url) => url !== '' && url.toLowerCase().includes(needle));
    }
    case 'cidr':
      return ips.find((ip) => ip.trim() !== '' && cidrContainsIp(pattern, ip.trim()));
    default: {
      const exhaustive: never = rule.kind;
      return exhaustive;
    }
  }
}

/**
 * Returns the first enabled rule matching the domain/IP/URL candidates, plus the
 * matched value. Ported from ARTEX db.MatchAssetInterceptRules.
 */
export function matchAssetInterceptRules(
  rules: readonly ArtexAssetInterceptRule[],
  domains: readonly string[],
  ips: readonly string[],
  urls: readonly string[],
): ArtexAssetMatch | undefined {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const value = matchOne(rule, domains, ips, urls);
    if (value !== undefined) return { rule, value };
  }
  return undefined;
}

function hasEnabledRule(rules: readonly ArtexAssetInterceptRule[]): boolean {
  return rules.some((rule) => rule.enabled);
}

export interface ArtexAssetGateDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * The "intercept first, then allow" gate over candidate strings. Ported from
 * ARTEX db.EvaluateAssetGate:
 *  1. any enabled block rule hit → reject (interception reason);
 *  2. otherwise, if there are enabled allow rules and none match → reject;
 *  3. otherwise allow.
 */
export function evaluateAssetGate(
  blockRules: readonly ArtexAssetInterceptRule[],
  allowRules: readonly ArtexAssetInterceptRule[],
  domains: readonly string[],
  ips: readonly string[],
  urls: readonly string[],
): ArtexAssetGateDecision {
  const hit = matchAssetInterceptRules(blockRules, domains, ips, urls);
  if (hit !== undefined) return { allowed: false, reason: artexAssetInterceptReason(hit.rule) };
  if (hasEnabledRule(allowRules)) {
    if (matchAssetInterceptRules(allowRules, domains, ips, urls) === undefined) {
      return {
        allowed: false,
        reason: "Not in the task's allowed (whitelist) scope; testing is not permitted",
      };
    }
  }
  return { allowed: true, reason: '' };
}

export interface ArtexInterceptCandidates {
  readonly domains: readonly string[];
  readonly ips: readonly string[];
  readonly urls: readonly string[];
}

/**
 * Extracts a persisted asset's domain/IP/URL candidates for interception
 * matching. Ported from ARTEX db.Asset.interceptCandidates.
 */
export function assetInterceptCandidates(asset: ArtexAsset): ArtexInterceptCandidates {
  const domains: string[] = [];
  const ips: string[] = [];
  const urls: string[] = [];
  const addDomain = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') domains.push(trimmed);
  };
  const addIp = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') ips.push(trimmed);
  };
  addDomain(asset.domain);
  addDomain(asset.rootDomain);
  for (const bound of asset.boundDomains) addDomain(bound);
  addIp(asset.ip);
  if (asset.url !== undefined && asset.url.trim() !== '') {
    urls.push(asset.url.trim());
    const host = hostFromUrl(asset.url);
    if (host !== undefined) {
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) addIp(host);
      else addDomain(host);
    }
  }
  return { domains, ips, urls };
}

function hostFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const hostname = url.hostname;
    if (hostname === '') return undefined;
    if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1).toLowerCase();
    return hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
