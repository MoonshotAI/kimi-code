import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gt, valid } from 'semver';

import {
  KIMI_CODE_PLUGIN_MARKETPLACE_URL,
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
} from '#/constant/app';

export const PLUGIN_MARKETPLACE_TIERS = ['official', 'curated'] as const;

export type PluginMarketplaceTier = (typeof PLUGIN_MARKETPLACE_TIERS)[number];

export interface PluginMarketplaceEntry {
  readonly id: string;
  readonly displayName: string;
  readonly source: string;
  readonly tier?: PluginMarketplaceTier;
  readonly version?: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly keywords?: readonly string[];
}

export interface PluginMarketplace {
  readonly source: string;
  readonly version?: string;
  readonly plugins: readonly PluginMarketplaceEntry[];
}

export type PluginUpdateStatus =
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'up-to-date'; readonly version?: string }
  | { readonly kind: 'update'; readonly local: string; readonly latest: string };

/**
 * Compare a marketplace entry's (latest) version against the locally installed
 * version. Only reports `update` when both are valid semver and latest > local,
 * so a stale or non-semver version never produces a spurious or downgrading prompt.
 */
export function computeUpdateStatus(
  latest: string | undefined,
  local: string | undefined,
  installed: boolean,
): PluginUpdateStatus {
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
  // Report only the actual installed version. When it is unknown, don't borrow the
  // marketplace version — that would falsely claim "up to date" and hide future updates.
  return { kind: 'up-to-date', version: local };
}

interface MarketplaceLocation {
  readonly raw: string;
  readonly kind: 'remote' | 'local';
  readonly resolved: string;
}

export interface LoadPluginMarketplaceOptions {
  readonly workDir: string;
  readonly source?: string;
  readonly fetchImpl?: typeof fetch;
}

export async function loadPluginMarketplace(
  options: LoadPluginMarketplaceOptions,
): Promise<PluginMarketplace> {
  const configuredSource = options.source ?? process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV];
  const location = resolveMarketplaceLocation(
    configuredSource ?? KIMI_CODE_PLUGIN_MARKETPLACE_URL,
    options.workDir,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  let raw: string;
  try {
    raw = await readMarketplaceText(location, fetchImpl);
  } catch (error) {
    const fallback =
      configuredSource === undefined ? await getSourceCheckoutMarketplaceLocation() : undefined;
    if (fallback === undefined) throw error;
    raw = await readMarketplaceText(fallback, fetchImpl);
    return withLatestVersions(parsePluginMarketplace(raw, fallback), fetchImpl);
  }
  return withLatestVersions(parsePluginMarketplace(raw, location), fetchImpl);
}

async function withLatestVersions(
  marketplace: PluginMarketplace,
  fetchImpl: typeof fetch,
): Promise<PluginMarketplace> {
  const plugins = await Promise.all(
    marketplace.plugins.map(async (entry) => {
      if (entry.version !== undefined) return entry;
      const latest = await resolveLatestGithubRelease(entry.source, fetchImpl);
      return latest === undefined ? entry : { ...entry, version: latest };
    }),
  );
  return { ...marketplace, plugins };
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

function resolveMarketplaceLocation(source: string, workDir: string): MarketplaceLocation {
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

async function getSourceCheckoutMarketplaceLocation(): Promise<MarketplaceLocation | undefined> {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const marketplacePath = resolve(sourceDir, '../../../../plugins/marketplace.json');
  const info = await stat(marketplacePath).catch(() => undefined);
  if (info?.isFile() !== true) return undefined;
  return { raw: marketplacePath, kind: 'local', resolved: marketplacePath };
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
  return {
    id,
    displayName: stringField(value, 'displayName') ?? stringField(value, 'name') ?? id,
    source: resolvedSource,
    tier: parseMarketplaceTier(value, id),
    version: stringField(value, 'version') ?? deriveVersionFromGithubSource(resolvedSource),
    description: stringField(value, 'description') ?? stringField(value, 'shortDescription'),
    homepage: stringField(value, 'homepage') ?? stringField(value, 'websiteURL'),
    keywords: stringArrayField(value, 'keywords'),
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

function resolveEntrySource(source: string, location: MarketplaceLocation): string {
  const trimmed = source.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('~/') ||
    trimmed === '~' ||
    isAbsolute(trimmed)
  ) {
    return trimmed;
  }
  if (trimmed.startsWith('file://')) return fileURLToPath(trimmed);
  if (location.kind === 'remote') {
    return new URL(trimmed, location.resolved).toString();
  }
  return resolve(dirname(location.resolved), trimmed);
}

/**
 * Best-effort derivation of a semver version from a GitHub source URL that pins
 * a specific ref. Lets a marketplace entry omit `version` when the source
 * already encodes the release (for example `/releases/tag/v6.0.3`), keeping the
 * source URL the single source of truth and avoiding drift between the two.
 *
 * Only refs shaped like semver (`v6.0.3`, `6.0.3`, `6.0.3-rc.1`) are accepted;
 * bare repo URLs, branch names and commit SHAs yield `undefined`, so update
 * detection degrades to "unknown" instead of comparing meaningless values.
 */
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
  // Pathname shape: /<owner>/<repo>/<tail...>. Recognized tails:
  //   releases/tag/<tag>
  //   tree/<ref>
  //   commit/<sha>
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

async function resolveLatestGithubRelease(
  source: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const repo = parseGithubRepo(source);
  if (repo === undefined) return undefined;
  try {
    const tag = await fetchLatestReleaseTag(repo.owner, repo.repo, fetchImpl);
    if (tag === undefined) return undefined;
    const candidate = tag.replace(/^v/i, '');
    return valid(candidate) !== null ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function parseGithubRepo(source: string): { owner: string; repo: string } | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;
  // Only bare repo URLs (/<owner>/<repo>) qualify — URLs with a ref tail are
  // already handled by deriveVersionFromGithubSource.
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) return undefined;
  const [owner, repo] = segments;
  return { owner: owner!, repo: repo! };
}

async function fetchLatestReleaseTag(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  // Avoid api.github.com: its anonymous quota is shared with the user's browser
  // and other tools, and a first-time lookup failing because something else
  // burned the budget is unacceptable. The /releases/latest UI route 302s to
  // the tag and is not part of the API quota.
  const url = `https://github.com/${owner}/${repo}/releases/latest`;
  const resp = await fetchImpl(url, { redirect: 'manual' });
  if (resp.status === 404) return undefined;
  if (resp.status !== 301 && resp.status !== 302) {
    throw new Error(
      `Could not look up latest release of ${owner}/${repo}: HTTP ${resp.status} (${url}).`,
    );
  }
  const location = resp.headers.get('location');
  if (location === null) return undefined;
  const match = /\/releases\/tag\/([^/?#]+)/.exec(location);
  const tag = match?.[1];
  if (tag === undefined) return undefined;
  try {
    return decodeURIComponent(tag);
  } catch {
    return tag;
  }
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
