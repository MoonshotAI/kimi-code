import { Type, type Static } from 'typebox';
import { defineBrowserValidator } from './browser-validator';

export const BROWSER_USER_AGENT_MAX = 512;

export const BrowserCustomUserAgentSchema = Type.String({
  minLength: 1,
  maxLength: BROWSER_USER_AGENT_MAX,
  pattern: '^[^\\u0000-\\u001f\\u007f]*[^\\u0000-\\u0020\\u007f][^\\u0000-\\u001f\\u007f]*$',
});

export function isBrowserCustomUserAgent(value: unknown): value is string {
  return browserValidators.BrowserCustomUserAgentSchema.Check(value);
}

export const BROWSER_USER_AGENT_PRESET_NAME_MAX = 60;
export const BROWSER_USER_AGENT_SAVED_PRESETS_MAX = 20;

export const BrowserUserAgentPresetNameSchema = Type.String({
  minLength: 1,
  maxLength: BROWSER_USER_AGENT_PRESET_NAME_MAX,
  pattern: '^[^\\u0000-\\u0020\\u007f](?:[^\\u0000-\\u001f\\u007f]*[^\\u0000-\\u0020\\u007f])?$',
});
export const BrowserUserAgentSavedPresetSchema = Type.Object({
  name: BrowserUserAgentPresetNameSchema,
  value: BrowserCustomUserAgentSchema,
}, { additionalProperties: false });
export const BrowserUserAgentSavedPresetsSchema = Type.Array(BrowserUserAgentSavedPresetSchema, {
  maxItems: BROWSER_USER_AGENT_SAVED_PRESETS_MAX,
});
export type BrowserUserAgentSavedPreset = Static<typeof BrowserUserAgentSavedPresetSchema>;

function presetNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function isBrowserUserAgentSavedPresets(value: unknown): value is BrowserUserAgentSavedPreset[] {
  if (!browserValidators.BrowserUserAgentSavedPresetsSchema.Check(value)) return false;
  return new Set(value.map(preset => presetNameKey(preset.name))).size === value.length;
}

export function browserUserAgentSavedPresetsFrom(value: unknown): BrowserUserAgentSavedPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: BrowserUserAgentSavedPreset[] = [];
  for (const entry of value) {
    if (presets.length >= BROWSER_USER_AGENT_SAVED_PRESETS_MAX) break;
    if (!browserValidators.BrowserUserAgentSavedPresetSchema.Check(entry)) continue;
    const key = presetNameKey(entry.name);
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({ name: entry.name, value: entry.value });
  }
  return presets;
}

export type BrowserUserAgentPresetNameError = 'empty' | 'tooLong' | 'invalid' | 'duplicate' | 'full';

export function browserUserAgentPresetNameError(
  name: string,
  saved: readonly BrowserUserAgentSavedPreset[],
): BrowserUserAgentPresetNameError | null {
  if (saved.length >= BROWSER_USER_AGENT_SAVED_PRESETS_MAX) return 'full';
  const trimmed = name.trim();
  if (trimmed === '') return 'empty';
  if (trimmed.length > BROWSER_USER_AGENT_PRESET_NAME_MAX) return 'tooLong';
  if (!browserValidators.BrowserUserAgentPresetNameSchema.Check(trimmed)) return 'invalid';
  const key = presetNameKey(trimmed);
  return saved.some(preset => presetNameKey(preset.name) === key) ? 'duplicate' : null;
}

export interface BrowserUserAgentBrand {
  brand: string;
  version: string;
}

export interface BrowserUserAgentMetadata {
  brands: BrowserUserAgentBrand[];
  fullVersionList: BrowserUserAgentBrand[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  formFactors: string[];
}

export interface BrowserUserAgentOverride {
  userAgent: string;
  platform?: string;
  userAgentMetadata?: BrowserUserAgentMetadata;
}

export type BrowserHostArchitecture = 'x86' | 'arm';

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
const BRAND_ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const NON_CHROMIUM_TOKEN = /\b(?:Firefox|FxiOS|CriOS|EdgiOS|OPiOS|Trident)\//;
const OTHER_CHROMIUM_TOKEN = /\b(?:OPR|YaBrowser|SamsungBrowser|Vivaldi|Brave|UCBrowser)\//;

function fullVersionOf(version: string): string {
  const parts = version.split('.');
  while (parts.length < 4) parts.push('0');
  return parts.slice(0, 4).join('.');
}

function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}

function greasedBrands(seed: number, entries: BrowserUserAgentBrand[], full: boolean): BrowserUserAgentBrand[] {
  const greaseVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.length]!;
  const grease = {
    brand: `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`,
    version: full ? `${greaseVersion}.0.0.0` : greaseVersion,
  };
  if (entries.length === 1) return seed % 2 === 0 ? [grease, entries[0]!] : [entries[0]!, grease];
  const order = BRAND_ORDERS[seed % BRAND_ORDERS.length]!;
  const list: BrowserUserAgentBrand[] = [grease, grease, grease];
  list[order[1]!] = entries[0]!;
  list[order[2]!] = entries[1]!;
  return list;
}

interface PlatformInfo {
  platform: string;
  platformVersion: string;
  navigatorPlatform: string;
  architecture: string;
  bitness: string;
  model: string;
  wow64: boolean;
}

function windowsPlatformVersion(nt: string): string {
  if (nt === '10.0') return '10.0.0';
  const minor = /^6\.([1-3])$/.exec(nt)?.[1];
  return minor === undefined ? '' : `0.${minor}.0`;
}

interface ArchitectureEntry {
  pattern: RegExp;
  architecture: string;
  bitness: string;
  linuxPlatform?: string;
}

const ARCHITECTURES: ArchitectureEntry[] = [
  { pattern: /^(?:aarch64|arm64)$/i, architecture: 'arm', bitness: '64', linuxPlatform: 'Linux aarch64' },
  { pattern: /^(?:armv8l|armv[4-7]\w*|arm)$/i, architecture: 'arm', bitness: '32' },
  { pattern: /^(?:x86_64|amd64|x64|Win64|WOW64)$/i, architecture: 'x86', bitness: '64', linuxPlatform: 'Linux x86_64' },
  { pattern: /^i[3-6]86$/i, architecture: 'x86', bitness: '32' },
];

function architectureOf(tokens: string[]): ArchitectureEntry | undefined {
  return ARCHITECTURES.find(entry => tokens.some(token => entry.pattern.test(token)));
}

function unixArchitecture(system: string, token: string | undefined): Pick<PlatformInfo, 'navigatorPlatform' | 'architecture' | 'bitness'> {
  if (token === undefined) return { navigatorPlatform: system, architecture: '', bitness: '' };
  const entry = architectureOf([token]);
  return {
    navigatorPlatform: system === 'Linux' ? entry?.linuxPlatform ?? `Linux ${token}` : `${system} ${token}`,
    architecture: entry?.architecture ?? '',
    bitness: entry?.bitness ?? '',
  };
}

function platformInfo(userAgent: string, hostArchitecture: BrowserHostArchitecture): PlatformInfo | null {
  const system = /^Mozilla\/5\.0 \(([^)]*)\)/.exec(userAgent)?.[1] ?? '';
  const android = /\bAndroid(?: ([\d.]+))?/.exec(system);
  if (android !== null) {
    const model = /\bAndroid[^;]*;\s*([^;]+?)(?:\s+Build\/[^;]*)?\s*$/.exec(system)?.[1] ?? '';
    return {
      platform: 'Android', platformVersion: android[1] ?? '', navigatorPlatform: 'Linux armv8l',
      architecture: '', bitness: '', model: model === 'K' ? '' : model, wow64: false,
    };
  }
  const windows = /\bWindows NT ([\d.]+)/.exec(system);
  if (windows !== null) {
    const entry = architectureOf(system.split(';').map(token => token.trim()));
    return {
      platform: 'Windows', platformVersion: windowsPlatformVersion(windows[1]!), navigatorPlatform: 'Win32',
      architecture: entry?.architecture ?? 'x86', bitness: entry?.bitness ?? '32', model: '', wow64: /\bWOW64\b/.test(system),
    };
  }
  const mac = /\bMac OS X ([\d_.]+)/.exec(system);
  if (mac !== null || /\bMacintosh\b/.test(system)) {
    const version = (mac?.[1] ?? '').replaceAll('_', '.');
    return {
      platform: 'macOS', platformVersion: version === '' ? '' : fullVersionOf(version).split('.').slice(0, 3).join('.'),
      navigatorPlatform: 'MacIntel', architecture: hostArchitecture, bitness: '64', model: '', wow64: false,
    };
  }
  const chromeOs = /\bCrOS(?: ([^\s;]+))?(?: ([\d.]+))?/.exec(system);
  if (chromeOs !== null) {
    return {
      platform: 'Chrome OS', platformVersion: chromeOs[2] ?? '', ...unixArchitecture('Linux', chromeOs[1]), model: '', wow64: false,
    };
  }
  const unix = /\b(Linux|FreeBSD|OpenBSD|NetBSD)\b(?: ([^\s;]+))?/.exec(system)
    ?? /\bX11;(?:\s*[A-Z];)*\s*([A-Za-z][\w-]*)(?: ([^\s;]+))?/.exec(system);
  if (unix !== null || /\bX11\b/.test(system)) {
    const name = unix?.[1] ?? 'Linux';
    return {
      platform: name, platformVersion: '', ...unixArchitecture(name, unix?.[2]), model: '', wow64: false,
    };
  }
  return null;
}

export function browserUserAgentOverride(userAgent: string, hostArchitecture: BrowserHostArchitecture = 'x86'): BrowserUserAgentOverride {
  if (NON_CHROMIUM_TOKEN.test(userAgent) || !/\bAppleWebKit\//.test(userAgent)) return { userAgent };
  const chrome = /\bChrome\/(\d+(?:\.\d+)*)/.exec(userAgent)?.[1];
  if (chrome === undefined) return { userAgent };
  const info = platformInfo(userAgent, hostArchitecture);
  if (info === null) return { userAgent };
  const chromeFull = fullVersionOf(chrome);
  const major = Number(majorOf(chrome));
  const seed = Number.isSafeInteger(major) ? major : 0;
  const edge = /\bEdg(?:A)?\/(\d+(?:\.\d+)*)/.exec(userAgent)?.[1];
  const product = edge !== undefined
    ? { brand: 'Microsoft Edge', version: fullVersionOf(edge) }
    : OTHER_CHROMIUM_TOKEN.test(userAgent) ? null : { brand: 'Google Chrome', version: chromeFull };
  const chromium = { brand: 'Chromium', version: chromeFull };
  const full = product === null ? [chromium] : [chromium, product];
  const mobile = /\bMobile\b/.test(userAgent);
  return {
    userAgent,
    platform: info.navigatorPlatform,
    userAgentMetadata: {
      brands: greasedBrands(seed, full.map(entry => ({ brand: entry.brand, version: majorOf(entry.version) })), false),
      fullVersionList: greasedBrands(seed, full, true),
      fullVersion: product?.version ?? chromeFull,
      platform: info.platform,
      platformVersion: info.platformVersion,
      architecture: info.architecture,
      model: info.model,
      mobile,
      bitness: info.bitness,
      wow64: info.wow64,
      formFactors: [mobile ? 'Mobile' : 'Desktop'],
    },
  };
}

export function browserTabUserAgentOverride(
  customUserAgent: string | null,
  deviceOverride: BrowserUserAgentOverride | null,
  hostArchitecture: BrowserHostArchitecture = 'x86',
): BrowserUserAgentOverride | null {
  if (deviceOverride !== null) return deviceOverride;
  return customUserAgent === null ? null : browserUserAgentOverride(customUserAgent, hostArchitecture);
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function brandList(brands: BrowserUserAgentBrand[]): string {
  return brands.map(entry => `${quoted(entry.brand)};v=${quoted(entry.version)}`).join(', ');
}

function booleanHint(value: boolean): string {
  return value ? '?1' : '?0';
}

export function browserClientHintHeaders(metadata: BrowserUserAgentMetadata): Record<string, string> {
  return {
    'sec-ch-ua': brandList(metadata.brands),
    'sec-ch-ua-mobile': booleanHint(metadata.mobile),
    'sec-ch-ua-platform': quoted(metadata.platform),
    'sec-ch-ua-platform-version': quoted(metadata.platformVersion),
    'sec-ch-ua-arch': quoted(metadata.architecture),
    'sec-ch-ua-bitness': quoted(metadata.bitness),
    'sec-ch-ua-model': quoted(metadata.model),
    'sec-ch-ua-wow64': booleanHint(metadata.wow64),
    'sec-ch-ua-full-version': quoted(metadata.fullVersion),
    'sec-ch-ua-full-version-list': brandList(metadata.fullVersionList),
    'sec-ch-ua-form-factors': metadata.formFactors.map(quoted).join(', '),
  };
}

const LOW_ENTROPY_HINTS = new Set(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isTrustworthyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') return true;
    return (parsed.protocol === 'http:' || parsed.protocol === 'ws:') && (LOCAL_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.localhost'));
  } catch {
    return false;
  }
}

export interface BrowserRequestHeadersInput {
  url: string;
  requestHeaders: Record<string, string>;
  userAgent: BrowserUserAgentOverride;
  deviceMode: boolean;
  electronUserAgent?: string;
}

const ELECTRON_IDENTITY_HOSTS = new Set(['accounts.google.com']);

function requestHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function requestUserAgent(input: BrowserRequestHeadersInput): string {
  if (input.electronUserAgent === undefined) return input.userAgent.userAgent;
  const hostname = requestHostname(input.url);
  if (hostname === undefined || !ELECTRON_IDENTITY_HOSTS.has(hostname)) return input.userAgent.userAgent;
  return withoutAppNameTokens(input.electronUserAgent);
}

export function rewriteBrowserRequestHeaders(input: BrowserRequestHeadersInput): Record<string, string> | null {
  const { userAgent, requestHeaders } = input;
  if (input.deviceMode) return null;
  const next: Record<string, string> = {};
  const present = new Set<string>();
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    if (lower === 'user-agent') continue;
    if (lower.startsWith('sec-ch-ua')) {
      present.add(lower);
      continue;
    }
    next[name] = value;
  }
  next['User-Agent'] = requestUserAgent(input);
  const metadata = userAgent.userAgentMetadata;
  if (metadata === undefined) return next;
  const hints = browserClientHintHeaders(metadata);
  const addLowEntropy = isTrustworthyUrl(input.url);
  for (const [name, value] of Object.entries(hints)) {
    if (present.has(name) || (addLowEntropy && LOW_ENTROPY_HINTS.has(name))) next[name] = value;
  }
  return next;
}

function withoutAppNameTokens(value: string): string {
  return value
    .replace(/\sKimi(?:%20|\s)?Code\w*\/[^\s]+/gi, '')
    .replace(/\skimi-code-app\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function withoutAppTokens(value: string): string {
  return withoutAppNameTokens(value.replace(/\sElectron\/[^\s]+/g, ''));
}

export function strippedBrowserUserAgent(value: string): string {
  return withoutAppTokens(value).replace(/\bChrome\/(\d+)(?:\.\d+)*/, 'Chrome/$1.0.0.0');
}

export function defaultBrowserUserAgentOverride(electronUserAgent: string, hostArchitecture: BrowserHostArchitecture = 'x86'): BrowserUserAgentOverride {
  return { ...browserUserAgentOverride(withoutAppTokens(electronUserAgent), hostArchitecture), userAgent: strippedBrowserUserAgent(electronUserAgent) };
}

export interface BrowserUserAgentPreset {
  id: 'chrome' | 'edge' | 'safari' | 'firefox';
  label: string;
  version: string;
  platform: string;
  value: string;
}

const SAFARI_VERSION = '18.5';
const FIREFOX_VERSION = '140.0';

export function browserUserAgentPresets(defaultUserAgent: string): BrowserUserAgentPreset[] {
  const system = /^Mozilla\/5\.0 \(([^)]*)\)/.exec(defaultUserAgent)?.[1] ?? 'Macintosh; Intel Mac OS X 10_15_7';
  const major = majorOf(/\bChrome\/(\d+(?:\.\d+)*)/.exec(defaultUserAgent)?.[1] ?? '138');
  const chrome = `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const chromePlatform = platformInfo(chrome, 'x86')?.platform ?? '';
  const firefoxPlatform = /\bWindows\b/.test(system) ? 'Windows' : /\bMacintosh\b/.test(system) ? 'macOS' : 'Linux';
  const firefoxSystem = firefoxPlatform === 'Windows'
    ? 'Windows NT 10.0; Win64; x64'
    : firefoxPlatform === 'macOS' ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64';
  return [
    { id: 'chrome', label: 'Chrome', version: major, platform: chromePlatform, value: chrome },
    { id: 'edge', label: 'Edge', version: major, platform: chromePlatform, value: `${chrome} Edg/${major}.0.0.0` },
    {
      id: 'safari', label: 'Safari', version: SAFARI_VERSION, platform: 'macOS',
      value: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${SAFARI_VERSION} Safari/605.1.15`,
    },
    {
      id: 'firefox', label: 'Firefox', version: majorOf(FIREFOX_VERSION), platform: firefoxPlatform,
      value: `Mozilla/5.0 (${firefoxSystem}; rv:${FIREFOX_VERSION}) Gecko/20100101 Firefox/${FIREFOX_VERSION}`,
    },
  ];
}

export const browserValidators = {
  BrowserCustomUserAgentSchema: defineBrowserValidator(BrowserCustomUserAgentSchema),
  BrowserUserAgentPresetNameSchema: defineBrowserValidator(BrowserUserAgentPresetNameSchema),
  BrowserUserAgentSavedPresetSchema: defineBrowserValidator(BrowserUserAgentSavedPresetSchema),
  BrowserUserAgentSavedPresetsSchema: defineBrowserValidator(BrowserUserAgentSavedPresetsSchema),
};
