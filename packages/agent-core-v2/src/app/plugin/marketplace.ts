import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KIMI_REGION_PROFILES, OAuthUnauthorizedError } from '@moonshot-ai/kimi-code-oauth';
import { gt, valid } from 'semver';

export function isMissingMarketplaceTokenError(error: unknown): boolean {
  return (
    error instanceof OAuthUnauthorizedError &&
    /^No token for ".+"\. Run \/login to authenticate\.$/.test(error.message)
  );
}

export const KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV = 'KIMI_CODE_PLUGIN_MARKETPLACE_URL';

export const PLUGIN_MARKETPLACE_CLASSIFICATIONS = ['official', 'third_party'] as const;
export const PLUGIN_MARKETPLACE_TIERS = ['official', 'curated'] as const;
export const PLUGIN_MARKETPLACE_PLATFORMS = ['macos', 'windows', 'linux', 'cloud'] as const;

export type PluginMarketplaceClassification = (typeof PLUGIN_MARKETPLACE_CLASSIFICATIONS)[number];
export type PluginMarketplaceTier = (typeof PLUGIN_MARKETPLACE_TIERS)[number];
export type PluginMarketplacePlatform = 'darwin' | 'win32' | 'linux' | 'cloud';

export interface PluginMarketplaceLocalizedText {
  readonly cliDescription?: string;
  readonly longDescription?: string;
  readonly shortDescription?: string;
}

export interface PluginMarketplaceLocale {
  readonly defaultLocale?: string;
  readonly [key: string]: string | PluginMarketplaceLocalizedText | undefined;
}

export interface PluginMarketplaceDistribution {
  readonly category: PluginMarketplaceClassification;
  readonly region?: string;
  readonly defaultInstall?: boolean;
  readonly weight?: number;
  readonly userLevel?: unknown;
}

export interface PluginMarketplaceEntry {
  readonly id: string;
  readonly displayName: string;
  readonly source: string;
  readonly classification?: PluginMarketplaceClassification;
  readonly tier?: PluginMarketplaceTier;
  readonly version?: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
  readonly iconUrl?: string;
  readonly sha256sum?: string;
  readonly filename?: string;
  readonly cliDescription?: string;
  readonly locale?: PluginMarketplaceLocale;
  readonly platforms?: readonly PluginMarketplacePlatform[];
  readonly distribution?: PluginMarketplaceDistribution;
  readonly billing?: unknown;
  readonly builtIn?: boolean;
}

export interface PluginMarketplace {
  readonly source: string;
  readonly version?: string;
  readonly plugins: readonly PluginMarketplaceEntry[];
}

export type MarketplaceUpdateStatus =
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'up-to-date'; readonly version?: string }
  | { readonly kind: 'update'; readonly local: string; readonly latest: string };

export interface MarketplaceLocation {
  readonly raw: string;
  readonly kind: 'remote' | 'local';
  readonly resolved: string;
}

export interface ReadPluginMarketplaceOptions {
  readonly source: string;
  readonly workDir: string;
  readonly fetchImpl?: typeof fetch;
}

export function pluginMarketplaceUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (normalized.length === 0) throw new Error('Kimi Code base URL cannot be empty.');
  return `${normalized}/plugins/marketplace`;
}

const TRUSTED_PLUGIN_MARKETPLACE_URLS = new Set(
  [...Object.values(KIMI_REGION_PROFILES).map((profile) => profile.baseUrl), 'https://coding.deva.msh.team/coding/v1']
    .map(pluginMarketplaceUrl),
);

export function isTrustedPluginMarketplaceUrl(source: string): boolean {
  return TRUSTED_PLUGIN_MARKETPLACE_URLS.has(source.trim().replace(/\/+$/, ''));
}

export function computeUpdateStatus(
  latest: string | undefined,
  local: string | undefined,
  installed: boolean,
): MarketplaceUpdateStatus {
  if (!installed) return { kind: 'not-installed' };
  if (
    latest !== undefined &&
    local !== undefined &&
    valid(latest) !== null &&
    valid(local) !== null &&
    gt(latest, local)
  ) {
    return { kind: 'update', local, latest };
  }
  return { kind: 'up-to-date', version: local };
}

export function resolveMarketplaceLocation(source: string, workDir: string): MarketplaceLocation {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new Error(`${KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV} cannot be empty.`);
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { raw: trimmed, kind: 'remote', resolved: trimmed };
  }
  if (trimmed.startsWith('file://')) {
    const path = fileURLToPath(trimmed);
    return { raw: trimmed, kind: 'local', resolved: path };
  }
  return { raw: trimmed, kind: 'local', resolved: resolveLocalPath(trimmed, workDir) };
}

export async function readPluginMarketplace(
  options: ReadPluginMarketplaceOptions,
): Promise<{ raw: string; location: MarketplaceLocation }> {
  const location = resolveMarketplaceLocation(options.source, options.workDir);
  return {
    raw: await readMarketplaceText(location, options.fetchImpl ?? fetch),
    location,
  };
}

export function parsePluginMarketplace(raw: string, location: MarketplaceLocation): PluginMarketplace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Plugin marketplace is not valid JSON: ${formatParseError(error)}`, {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new TypeError('Plugin marketplace must be an object.');
  }
  const rawPlugins = parsed['plugins'];
  if (!Array.isArray(rawPlugins)) {
    throw new TypeError('Plugin marketplace must contain a "plugins" array.');
  }

  return {
    source: location.resolved,
    version: stringField(parsed, 'version'),
    plugins: rawPlugins.map((entry, index) => parseMarketplaceEntry(entry, index, location)),
  };
}

async function readMarketplaceText(
  location: MarketplaceLocation,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (location.kind === 'local') {
    return readFile(location.resolved, 'utf8');
  }
  const response = await fetchImpl(location.resolved);
  if (!response.ok) {
    throw new Error(`Plugin marketplace returned HTTP ${response.status}`);
  }
  return response.text();
}

function parseMarketplaceEntry(
  value: unknown,
  index: number,
  location: MarketplaceLocation,
): PluginMarketplaceEntry {
  if (!isRecord(value)) {
    throw new TypeError(`Plugin marketplace entry ${index + 1} must be an object.`);
  }
  const id = requiredString(value, 'id', index);
  validateMarketplaceEntryType(value, id);
  const source = stringField(value, 'source') ??
    stringField(value, 'url') ??
    stringField(value, 'downloadUrl');
  if (source === undefined) {
    throw new Error(`Plugin marketplace entry ${id} must define "source".`);
  }
  const resolvedSource = resolveEntrySource(source, location);
  const distribution = parseDistribution(value['distribution'], id);
  const tier = distribution === undefined
    ? parseMarketplaceTier(value, id)
    : distribution.category === 'official' ? 'official' : 'curated';
  return {
    id,
    displayName: stringField(value, 'displayName') ?? stringField(value, 'name') ?? id,
    source: resolvedSource,
    classification: distribution?.category ??
      (tier === 'official' ? 'official' : tier === 'curated' ? 'third_party' : undefined),
    tier,
    version: stringField(value, 'version') ?? deriveVersionFromGithubSource(resolvedSource),
    description: stringField(value, 'description') ?? stringField(value, 'shortDescription'),
    homepage: stringField(value, 'homepage') ?? stringField(value, 'websiteURL'),
    keywords: stringArrayField(value, 'keywords'),
    iconUrl: stringField(value, 'iconUrl'),
    sha256sum: parseSha256sum(value, id),
    filename: stringField(value, 'filename'),
    cliDescription: stringField(value, 'cliDescription'),
    locale: parseLocale(value['locale'], id),
    platforms: parsePlatforms(value['platforms'], id),
    distribution,
    billing: value['billing'],
  };
}

function validateMarketplaceEntryType(value: Record<string, unknown>, id: string): void {
  const raw = value['type'];
  if (raw === undefined) return;
  if (typeof raw !== 'string') {
    throw new TypeError(`Plugin marketplace entry ${id} "type" must be a string.`);
  }
  const type = raw.trim();
  if (type === 'plugin' || type === 'managed' || type === 'guide') return;
  throw new Error(
    `Plugin marketplace entry ${id} "type" must be "plugin". Legacy aliases "managed" and "guide" are also accepted.`,
  );
}

function parseMarketplaceTier(
  value: Record<string, unknown>,
  id: string,
): PluginMarketplaceTier | undefined {
  const raw = value['tier'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new TypeError(`Plugin marketplace entry ${id} "tier" must be a string.`);
  }
  const tier = raw.trim();
  if (tier.length === 0) return undefined;
  if ((PLUGIN_MARKETPLACE_TIERS as readonly string[]).includes(tier)) {
    return tier as PluginMarketplaceTier;
  }
  throw new Error(
    `Plugin marketplace entry ${id} "tier" must be one of: ${PLUGIN_MARKETPLACE_TIERS.join(', ')}.`,
  );
}

function parseDistribution(
  value: unknown,
  id: string,
): PluginMarketplaceDistribution | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError(`Plugin marketplace entry ${id} must define "distribution".`);
  }
  const category = stringField(value, 'category');
  if (!(PLUGIN_MARKETPLACE_CLASSIFICATIONS as readonly string[]).includes(category ?? '')) {
    throw new Error(
      `Plugin marketplace entry ${id} "distribution.category" must be one of: ${PLUGIN_MARKETPLACE_CLASSIFICATIONS.join(', ')}.`,
    );
  }
  return {
    category: category as PluginMarketplaceClassification,
    region: stringField(value, 'region'),
    defaultInstall: booleanField(value, 'defaultInstall', id),
    weight: numberField(value, 'weight', id),
    userLevel: value['userLevel'],
  };
}

function parsePlatforms(
  value: unknown,
  id: string,
): readonly PluginMarketplacePlatform[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`Plugin marketplace entry ${id} "platforms" must be a non-empty array.`);
  }
  const platforms = value.map((platform) => {
    if (platform === 'macos') return 'darwin' as const;
    if (platform === 'windows') return 'win32' as const;
    if (platform === 'linux') return 'linux' as const;
    if (platform === 'cloud') return 'cloud' as const;
    throw new Error(
      `Plugin marketplace entry ${id} "platforms" must contain only: ${PLUGIN_MARKETPLACE_PLATFORMS.join(', ')}.`,
    );
  });
  return [...new Set(platforms)];
}

function parseSha256sum(value: Record<string, unknown>, id: string): string | undefined {
  const sha256sum = stringField(value, 'sha256sum');
  if (sha256sum !== undefined && !/^[A-Fa-f0-9]{64}$/.test(sha256sum)) {
    throw new Error(`Plugin marketplace entry ${id} "sha256sum" must be a SHA-256 hex digest.`);
  }
  return sha256sum;
}

function deriveVersionFromGithubSource(source: string): string | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return undefined;
  }
  const [, , kind, a, b] = url.pathname.split('/').filter(Boolean);
  const ref =
    kind === 'releases' && a === 'tag' ? b : kind === 'tree' || kind === 'commit' ? a : undefined;
  if (ref === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    decoded = ref;
  }
  const candidate = decoded.replace(/^v/i, '');
  return valid(candidate) !== null ? candidate : undefined;
}

function parseLocale(value: unknown, id: string): PluginMarketplaceLocale | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError(`Plugin marketplace entry ${id} "locale" must be an object.`);
  }
  const locale: Record<string, string | PluginMarketplaceLocalizedText> = {};
  const defaultLocale = stringField(value, 'defaultLocale');
  if (defaultLocale !== undefined) locale['defaultLocale'] = defaultLocale;
  for (const [key, block] of Object.entries(value)) {
    if (key === 'defaultLocale') continue;
    if (!isRecord(block)) {
      throw new TypeError(`Plugin marketplace entry ${id} locale "${key}" must be an object.`);
    }
    locale[key] = {
      cliDescription: stringField(block, 'cliDescription'),
      longDescription: stringField(block, 'longDescription'),
      shortDescription: stringField(block, 'shortDescription'),
    };
  }
  return locale;
}

function booleanField(
  value: Record<string, unknown>,
  field: string,
  id: string,
): boolean | undefined {
  const raw = value[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    throw new TypeError(`Plugin marketplace entry ${id} "distribution.${field}" must be a boolean.`);
  }
  return raw;
}

function numberField(
  value: Record<string, unknown>,
  field: string,
  id: string,
): number | undefined {
  const raw = value[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new TypeError(`Plugin marketplace entry ${id} "distribution.${field}" must be a number.`);
  }
  return raw;
}

function resolveEntrySource(source: string, location: MarketplaceLocation): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (trimmed.startsWith('file://')) return fileURLToPath(trimmed);
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return resolveLocalPath(trimmed, '');
  }
  if (isAbsolute(trimmed)) return trimmed;
  if (location.kind === 'remote') {
    return new URL(trimmed, location.resolved).toString();
  }
  return resolve(dirname(location.resolved), trimmed);
}

function resolveLocalPath(input: string, workDir: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return isAbsolute(input) ? input : resolve(workDir, input);
}

function requiredString(value: Record<string, unknown>, field: string, index: number): string {
  const result = stringField(value, field);
  if (result === undefined) {
    throw new Error(`Plugin marketplace entry ${index + 1} must define "${field}".`);
  }
  return result;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArrayField(
  value: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const raw = value[field];
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return out.length > 0 ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
