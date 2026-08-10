/**
 * Local managed kimi-code login — device-code OAuth flow + config
 * provisioning, ported from `@moonshot-ai/kimi-code-oauth` (`oauth.ts`
 * raw flow, `oauth-manager.ts` login loop, `managed-kimi-code.ts`
 * provisioning) and the SDK `KimiAuthFacade.login` (G-1 CLI consumption
 * cutover: the oauth package is retired from the host, the CLI still runs
 * `kimi login` / `kimi acp --login`).
 *
 * Wire shapes match the originals exactly:
 *  - token persisted to `<homeDir>/credentials/kimi-code.json` (snake_case),
 *    the same file `auth-local.ts` reads for telemetry auth headers;
 *  - config.toml written with `providers['managed:kimi-code']` + oauth ref,
 *    merged managed model aliases, `default_model`, `thinking.enabled` and
 *    the `moonshot_search` / `moonshot_fetch` service entries — the same
 *    on-disk shape the SDK `writeConfigFile` produced.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname, release } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { parse as parseToml, stringify } from 'smol-toml';

import {
  createKimiDeviceId,
  KIMI_CODE_PLATFORM,
  KIMI_CODE_PROVIDER_NAME,
  type KimiHostIdentity,
} from '#/cli/oauth-local';
import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
} from '#/cli/runtime-config';

/** The managed kimi-code oauth credential slot (`oauth/kimi-code` → `kimi-code`). */
const KIMI_CODE_OAUTH_KEY = 'oauth/kimi-code';
const KIMI_CODE_PLATFORM_ID = 'kimi-code';
/** Token storage name for the default credential slot (default-format check). */
const DEFAULT_TOKEN_STORAGE_NAME = 'kimi-code';

const DEFAULT_KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';
const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_KIMI_FLOW_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
/** Server-side transient failures — retry the poll instead of failing. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Upstream-owned model alias fields (SDK `MANAGED_KIMI_MODEL_FIELDS`). */
const MANAGED_MODEL_FIELDS = new Set([
  'provider',
  'model',
  'maxContextSize',
  'capabilities',
  'displayName',
  'protocol',
  'betaApi',
  'adaptiveThinking',
  'supportEfforts',
  'defaultEffort',
]);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Device-code payload handed to the `onDeviceCode` callback. */
export interface DeviceCodeData {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number | null;
  readonly interval: number;
}

export interface ManagedKimiLoginOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onDeviceCode?: ((data: DeviceCodeData) => void | Promise<void>) | undefined;
  /** Explicit base URL override (used by mirrors / tests). */
  readonly baseUrl?: string | undefined;
  /** Explicit OAuth host override (used by mirrors / tests). */
  readonly oauthHost?: string | undefined;
}

export interface ManagedKimiLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath: string;
}

export interface ManagedKimiAuthStatusEntry {
  readonly providerName: string;
  readonly hasToken: boolean;
}

export interface ManagedKimiAuthStatus {
  readonly providers: readonly ManagedKimiAuthStatusEntry[];
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extract a readable API error message from a JSON payload. */
function extractApiErrorMessage(data: Record<string, unknown>): string | undefined {
  const error = data['error'];
  if (isRecord(error) && typeof error['message'] === 'string' && error['message'].length > 0) {
    return error['message'];
  }
  if (typeof error === 'string' && error.length > 0) return error;
  if (typeof data['message'] === 'string' && data['message'].length > 0) return data['message'];
  return undefined;
}

function pickErrorDetail(data: Record<string, unknown>): string {
  return extractApiErrorMessage(data) ?? 'unknown';
}

/**
 * Flatten a fetch rejection into a readable message: undici throws a
 * generic `TypeError: fetch failed` and hides the real reason (DNS,
 * refused, TLS, timeout) in a nested `cause` chain.
 */
function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages = new Set<string>();
  let current: Error | undefined = error;
  while (current !== undefined) {
    messages.add(current.message);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return [...messages].join(': ');
}

/** `Kimi code` device identity headers (`createKimiDeviceHeaders` port). */
function deviceHeadersFor(
  homeDir: string,
  identity: KimiHostIdentity | undefined,
): Record<string, string> | undefined {
  if (identity === undefined) return undefined;
  const ascii = (value: string): string => value.replaceAll(/[^\u0020-\u007E]/g, '');
  return {
    'X-Msh-Platform': KIMI_CODE_PLATFORM,
    'X-Msh-Version': ascii(identity.version),
    'X-Msh-Device-Name': ascii(hostname()),
    'X-Msh-Os-Version': ascii(release()),
    'X-Msh-Device-Id': createKimiDeviceId(homeDir),
  };
}

/** POST form-encoded to the OAuth host with a bounded timeout + abort. */
async function postForm(
  url: string,
  params: Record<string, string>,
  deviceHeaders: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const parsedUrl = new URL(url);
  const isLoopback =
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === '::1';
  if (parsedUrl.protocol !== 'https:' && !isLoopback) {
    throw new Error(`Refusing to send credentials to non-HTTPS OAuth endpoint: ${parsedUrl.origin}`);
  }
  const signals: AbortSignal[] = [AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS)];
  if (signal !== undefined) signals.push(signal);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        ...deviceHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    throw new Error(`OAuth request to ${url} failed: ${describeFetchFailure(error)}`, { cause: error });
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed)) data = parsed;
  } catch {
    // Non-JSON response — the caller interprets by status.
  }
  return { status: response.status, data };
}

/** `POST /api/oauth/device_authorization` (raw flow port). */
async function requestDeviceAuthorization(
  oauthHost: string,
  clientId: string,
  deviceHeaders: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<DeviceCodeData & { readonly deviceCode: string }> {
  const url = `${oauthHost.replace(/\/$/, '')}/api/oauth/device_authorization`;
  const { status, data } = await postForm(url, { client_id: clientId }, deviceHeaders, signal);
  if (status !== 200) {
    throw new Error(
      `Device authorization failed (HTTP ${status}): ${pickErrorDetail(data)}`,
    );
  }
  const userCode = data['user_code'];
  const deviceCode = data['device_code'];
  const verificationUriComplete = data['verification_uri_complete'];
  if (typeof userCode !== 'string' || userCode.length === 0) {
    throw new Error('Device authorization response missing user_code');
  }
  if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
    throw new Error('Device authorization response missing device_code');
  }
  if (typeof verificationUriComplete !== 'string' || verificationUriComplete.length === 0) {
    throw new Error('Device authorization response missing verification_uri_complete');
  }
  return {
    userCode,
    deviceCode,
    verificationUri: typeof data['verification_uri'] === 'string' ? data['verification_uri'] : '',
    verificationUriComplete,
    expiresIn: data['expires_in'] !== undefined ? Number(data['expires_in']) : null,
    interval: Number(data['interval'] ?? 5),
  };
}

type DevicePollResult =
  | { readonly kind: 'success'; readonly token: TokenInfo }
  | { readonly kind: 'pending'; readonly errorCode: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied'; readonly description: string };

/** `POST /api/oauth/token` (grant_type=device_code) — raw flow port. */
async function pollDeviceToken(
  oauthHost: string,
  clientId: string,
  deviceCode: string,
  deviceHeaders: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<DevicePollResult> {
  const url = `${oauthHost.replace(/\/$/, '')}/api/oauth/token`;
  const { status, data } = await postForm(
    url,
    {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    deviceHeaders,
    signal,
  );
  if (status === 200 && typeof data['access_token'] === 'string') {
    return { kind: 'success', token: tokenFromResponse(data) };
  }
  if (status >= 500 || RETRYABLE_STATUSES.has(status)) {
    throw new Error(
      `Device token polling server error (HTTP ${status}): ${pickErrorDetail(data)}`,
    );
  }
  const errorCode = typeof data['error'] === 'string' ? data['error'] : 'unknown_error';
  const detail = extractApiErrorMessage(data);
  const description =
    typeof data['error_description'] === 'string' ? data['error_description'] : (detail ?? '');
  switch (errorCode) {
    case 'authorization_pending':
    case 'slow_down':
      return { kind: 'pending', errorCode };
    case 'expired_token':
      return { kind: 'expired' };
    case 'access_denied':
      return { kind: 'denied', description };
    default:
      throw new Error(
        `Device token polling failed (HTTP ${status}): ${detail ?? `${errorCode} ${description}`}`,
      );
  }
}

/* ------------------------------------------------------------------ */
/* Token storage (FileTokenStorage-compatible subset)                  */
/* ------------------------------------------------------------------ */

interface TokenInfo {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scope: string;
  readonly tokenType: string;
  readonly expiresIn: number;
}

/** Validate the required token fields of an OAuth token response. */
function tokenFromResponse(payload: Record<string, unknown>): TokenInfo {
  const accessToken = payload['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('OAuth response missing access_token');
  }
  const refreshToken = payload['refresh_token'];
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new Error('OAuth response missing refresh_token');
  }
  const expiresIn = Number(payload['expires_in']);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth response missing or invalid expires_in');
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scope: typeof payload['scope'] === 'string' ? payload['scope'] : '',
    tokenType: typeof payload['token_type'] === 'string' ? payload['token_type'] : 'Bearer',
    expiresIn,
  };
}

/** Resolve the token storage name for the managed kimi-code slot. */
function tokenStorageName(oauthKey: string): string {
  if (oauthKey === 'kimi-code' || oauthKey === KIMI_CODE_OAUTH_KEY) {
    return DEFAULT_TOKEN_STORAGE_NAME;
  }
  const prefix = 'oauth/';
  if (oauthKey.startsWith(prefix) && oauthKey.slice(prefix.length).length > 0) {
    return oauthKey.slice(prefix.length);
  }
  if (!oauthKey.includes('/') && !oauthKey.startsWith('.')) return oauthKey;
  throw new Error(`Invalid Kimi OAuth token key: "${oauthKey}".`);
}

function credentialsPath(homeDir: string, storageName: string): string {
  const safe = basename(storageName);
  if (safe.length === 0 || safe !== storageName || safe.startsWith('.')) {
    throw new Error(`Invalid token name: "${storageName}"`);
  }
  return join(homeDir, 'credentials', `${safe}.json`);
}

/** Persist the token atomically (`FileTokenStorage.save` port). */
function saveToken(homeDir: string, storageName: string, token: TokenInfo): void {
  const dir = join(homeDir, 'credentials');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort; Windows / read-only FS may refuse.
  }
  const target = credentialsPath(homeDir, storageName);
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const data = Buffer.from(
    `${JSON.stringify(
      {
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        expires_at: token.expiresAt,
        scope: token.scope,
        token_type: token.tokenType,
        expires_in: token.expiresIn,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  const fd = openSync(tmp, 'w', 0o600);
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
}

/** Read the cached managed kimi-code access token (undefined when absent). */
export function readCachedAccessToken(
  homeDir: string,
  oauthKey: string = KIMI_CODE_OAUTH_KEY,
): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(homeDir, tokenStorageName(oauthKey)), 'utf-8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const accessToken = parsed['access_token'];
  return typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : undefined;
}

/* ------------------------------------------------------------------ */
/* Config provisioning                                                 */
/* ------------------------------------------------------------------ */

/** The device-code polling loop (`OAuthManager.login` port). */
async function runDeviceFlow(options: {
  readonly homeDir: string;
  readonly oauthHost: string;
  readonly clientId: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onDeviceCode?: ((data: DeviceCodeData) => void | Promise<void>) | undefined;
}): Promise<TokenInfo> {
  const deviceHeaders = deviceHeadersFor(options.homeDir, options.identity);
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  const startedAt = Math.floor(Date.now() / 1000);
  const deadlineAt = startedAt + Math.ceil(DEVICE_CODE_TIMEOUT_MS / 1000);

  while (true) {
    if (options.signal?.aborted === true) {
      throw new AbortError('Device login aborted.');
    }
    const auth = await requestDeviceAuthorization(
      options.oauthHost,
      options.clientId,
      deviceHeaders,
      options.signal,
    );
    await options.onDeviceCode?.(auth);

    // RFC 8628 §3.5: add at least 5s on `slow_down` and keep the higher
    // interval thereafter.
    let currentInterval = Math.max(auth.interval, 1);
    let deviceExpired = false;
    while (true) {
      if (options.signal !== undefined && options.signal.aborted) {
        throw new AbortError('Device login aborted.');
      }
      if (Math.floor(Date.now() / 1000) >= deadlineAt) {
        throw new Error(`Device authorization timed out after ${DEVICE_CODE_TIMEOUT_MS / 1000}s`);
      }
      const result = await pollDeviceToken(
        options.oauthHost,
        options.clientId,
        auth.deviceCode,
        deviceHeaders,
        options.signal,
      );
      if (result.kind === 'success') return result.token;
      if (result.kind === 'denied') {
        throw new Error(
          `Authorization denied${result.description ? `: ${result.description}` : ''}`,
        );
      }
      if (result.kind === 'expired') {
        deviceExpired = true;
        break;
      }
      // pending — bump the interval permanently when the server asks.
      if (result.errorCode === 'slow_down') currentInterval += 5;
      await sleep(currentInterval * 1000);
    }
    if (!deviceExpired) break;
    if (Math.floor(Date.now() / 1000) >= deadlineAt) {
      throw new Error('Device authorization timed out');
    }
  }
  throw new Error('Device flow ended unexpectedly');
}

class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

interface ManagedModelInfo {
  readonly id: string;
  readonly contextLength: number;
  readonly supportsReasoning: boolean;
  readonly supportsImageIn: boolean;
  readonly supportsVideoIn: boolean;
  readonly supportsToolUse: boolean;
  readonly supportsThinkingType: 'only' | 'no' | 'both' | undefined;
  readonly supportEfforts: readonly string[] | undefined;
  readonly defaultEffort: string | undefined;
  readonly displayName: string | undefined;
  readonly protocol: string | undefined;
}

/** Parse one `/models` entry (`toModelInfo` port). */
function toModelInfo(item: unknown): ManagedModelInfo | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
    return undefined;
  }
  const contextLength = Number(item['context_length']);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error(`Kimi Code model "${item['id']}" must include a positive context_length.`);
  }
  const displayName = item['display_name'];
  const normalizedDisplayName =
    typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined;
  const supportsToolUse = Object.hasOwn(item, 'supports_tool_use')
    ? Boolean(item['supports_tool_use'])
    : true;
  const thinkEfforts = parseThinkEfforts(item['think_efforts']);
  const supportsThinkingType = parseSupportsThinkingType(item['supports_thinking_type']);
  return {
    id: item['id'],
    contextLength,
    supportsReasoning: Boolean(item['supports_reasoning']),
    supportsImageIn: Boolean(item['supports_image_in']),
    supportsVideoIn: Boolean(item['supports_video_in']),
    supportsToolUse,
    supportsThinkingType,
    supportEfforts: thinkEfforts.supportEfforts,
    defaultEffort: thinkEfforts.defaultEffort,
    displayName: normalizedDisplayName,
    protocol: parseModelProtocol(item['protocol']),
  };
}

function parseThinkEfforts(value: unknown): {
  supportEfforts: readonly string[] | undefined;
  defaultEffort: string | undefined;
} {
  if (!isRecord(value)) {
    return { supportEfforts: undefined, defaultEffort: undefined };
  }
  const supportRaw = value['support'];
  const validRaw = value['valid_efforts'];
  const defaultRaw = value['default_effort'];
  const supportEfforts =
    supportRaw === true
      ? parseStringArray(validRaw)
      : supportRaw === false
        ? undefined
        : parseStringArray(validRaw);
  return {
    supportEfforts,
    defaultEffort: typeof defaultRaw === 'string' && defaultRaw.length > 0 ? defaultRaw : undefined,
  };
}

function parseSupportsThinkingType(value: unknown): 'only' | 'no' | 'both' | undefined {
  return value === 'only' || value === 'no' || value === 'both' ? value : undefined;
}

function parseModelProtocol(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return out.length > 0 ? out : undefined;
}

/** `GET <baseUrl>/models` with the granted token (`fetchManagedKimiCodeModels` port). */
async function fetchManagedKimiCodeModels(
  baseUrl: string,
  accessToken: string,
  headers: Record<string, string> | undefined,
): Promise<ManagedModelInfo[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      ...headers,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    let message: string;
    try {
      message = await readApiErrorMessage(response, `Failed to list Kimi Code models (HTTP ${response.status}).`);
    } catch {
      message = `Failed to list Kimi Code models (HTTP ${response.status}).`;
    }
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new Error(`Kimi Code models access denied (HTTP ${response.status}): ${message}`);
    }
    throw new Error(message);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response for ${baseUrl}.`);
  }
  return payload['data']
    .map((item) => toModelInfo(item))
    .filter((item): item is ManagedModelInfo => item !== undefined);
}

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return fallback;
  }
  if (text.length === 0) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      return extractApiErrorMessage(parsed) ?? text.slice(0, 500);
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text.slice(0, 500);
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function managedModelKey(modelId: string): string {
  return `${KIMI_CODE_PLATFORM_ID}/${modelId}`;
}

/** The alias record the engine/SDK consumes, in on-disk snake_case. */
function toManagedModelAlias(providerId: string, model: ManagedModelInfo): Record<string, unknown> {
  const capabilities = capabilitiesForModel(model);
  const supportsAdaptiveThinking =
    model.protocol === 'anthropic' &&
    (capabilities?.includes('thinking') === true ||
      capabilities?.includes('always_thinking') === true);
  return {
    provider: providerId,
    model: model.id,
    max_context_size: model.contextLength,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(model.displayName !== undefined ? { display_name: model.displayName } : {}),
    ...(model.supportEfforts !== undefined ? { support_efforts: [...model.supportEfforts] } : {}),
    ...(model.defaultEffort !== undefined ? { default_effort: model.defaultEffort } : {}),
    ...(model.protocol !== undefined ? { protocol: model.protocol } : {}),
    ...(model.protocol === 'anthropic' ? { beta_api: true } : {}),
    ...(supportsAdaptiveThinking ? { adaptive_thinking: true } : {}),
  };
}

function capabilitiesForModel(model: ManagedModelInfo): readonly string[] | undefined {
  const caps = new Set<string>();
  switch (model.supportsThinkingType) {
    case 'only':
      caps.add('thinking');
      caps.add('always_thinking');
      break;
    case 'both':
      caps.add('thinking');
      break;
    case 'no':
      break;
    case undefined:
      if (model.supportsReasoning) caps.add('thinking');
      break;
  }
  if (model.supportsImageIn) caps.add('image_in');
  if (model.supportsVideoIn) caps.add('video_in');
  if (model.supportsToolUse ?? true) caps.add('tool_use');
  return caps.size > 0 ? [...caps] : undefined;
}

function forcedThinking(
  model: ManagedModelInfo | undefined,
  fallback: boolean,
): boolean {
  if (model?.supportsThinkingType === 'only') return true;
  if (model?.supportsThinkingType === 'no') return false;
  return fallback;
}

function canPreserveDefaultModel(
  existingModels: Record<string, Record<string, unknown>>,
  defaultModel: string,
  managedModels: ReadonlyMap<string, ManagedModelInfo>,
): boolean {
  if (managedModels.has(defaultModel)) return true;
  const existing = existingModels[defaultModel];
  return isRecord(existing) && existing['provider'] !== KIMI_CODE_PROVIDER_NAME;
}

/** Select the default model alias (`selectDefaultModel` port). */
function selectDefaultModel(
  rawConfig: Record<string, unknown>,
  models: readonly ManagedModelInfo[],
  preserveExisting: boolean,
): { modelKey: string; thinking: boolean } {
  const firstModel = models[0];
  if (firstModel === undefined) {
    throw new Error('No models available for Kimi Code.');
  }
  const managedModels = new Map(models.map((model) => [managedModelKey(model.id), model]));
  const existingModels = isRecord(rawConfig['models']) ? rawConfig['models'] : {};
  const currentDefault =
    typeof rawConfig['default_model'] === 'string' && rawConfig['default_model'].length > 0
      ? rawConfig['default_model']
      : undefined;
  const thinkingRaw = isRecord(rawConfig['thinking']) ? rawConfig['thinking'] : undefined;
  const thinkingEnabled =
    thinkingRaw?.['enabled'] !== undefined ? Boolean(thinkingRaw['enabled']) : undefined;

  if (
    preserveExisting &&
    currentDefault !== undefined &&
    canPreserveDefaultModel(existingModels as Record<string, Record<string, unknown>>, currentDefault, managedModels)
  ) {
    const preservedModel = managedModels.get(currentDefault);
    return {
      modelKey: currentDefault,
      thinking: forcedThinking(preservedModel, thinkingEnabled ?? preservedModel?.supportsReasoning ?? false),
    };
  }
  return {
    modelKey: managedModelKey(firstModel.id),
    thinking: forcedThinking(firstModel, thinkingEnabled ?? firstModel.supportsReasoning),
  };
}

/** Merge refreshed aliases into the models table, preserving user extras. */
function mergeManagedModelAliases(
  rawModels: Record<string, unknown>,
  models: readonly ManagedModelInfo[],
): void {
  const upstreamKeys = new Set(models.map((model) => managedModelKey(model.id)));
  for (const [key, model] of Object.entries(rawModels)) {
    if (
      isRecord(model) &&
      model['provider'] === KIMI_CODE_PROVIDER_NAME &&
      !upstreamKeys.has(key)
    ) {
      delete rawModels[key];
    }
  }
  for (const model of models) {
    const key = managedModelKey(model.id);
    const existing = isRecord(rawModels[key]) ? rawModels[key] : {};
    const overrides = isRecord(existing['overrides'])
      ? structuredClone(existing['overrides'])
      : undefined;
    const userExtras: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(existing)) {
      if (field === 'overrides') continue;
      if (!MANAGED_MODEL_FIELDS.has(camelToSnake(field)) && !MANAGED_MODEL_FIELDS.has(field)) {
        userExtras[field] = value;
      }
    }
    rawModels[key] = {
      ...userExtras,
      ...toManagedModelAlias(KIMI_CODE_PROVIDER_NAME, model),
      ...(overrides !== undefined ? { overrides } : {}),
    };
  }
}

/** The default oauth ref persisted when the host is the default one. */
function managedOAuthRef(oauthKey: string, oauthHost: string | undefined): Record<string, unknown> {
  const normalized = oauthHost?.trim().replace(/\/+$/, '');
  const isDefault =
    normalized === undefined ||
    normalized.length === 0 ||
    normalized === DEFAULT_KIMI_CODE_OAUTH_HOST;
  return {
    storage: 'file',
    key: oauthKey,
    ...(isDefault ? {} : { oauth_host: normalized }),
  };
}

/**
 * Apply the managed kimi-code provisioning onto the RAW (snake_case) config
 * record read from disk — same on-disk shape the SDK `configToTomlData`
 * produced (`applyManagedKimiCodeConfig` port).
 */
function applyManagedKimiCodeConfig(
  rawConfig: Record<string, unknown>,
  options: {
    readonly models: readonly ManagedModelInfo[];
    readonly baseUrl: string;
    readonly oauthKey: string;
    readonly oauthHost: string | undefined;
    readonly preserveDefaultModel: boolean;
  },
): { defaultModel: string; defaultThinking: boolean } {
  if (options.models.length === 0) {
    throw new Error('No models available for Kimi Code.');
  }
  const selected = selectDefaultModel(rawConfig, options.models, options.preserveDefaultModel);

  const providers = isRecord(rawConfig['providers']) ? rawConfig['providers'] : {};
  providers[KIMI_CODE_PROVIDER_NAME] = {
    type: 'kimi',
    base_url: options.baseUrl,
    api_key: '',
    oauth: managedOAuthRef(options.oauthKey, options.oauthHost),
  };
  rawConfig['providers'] = providers;

  const models = isRecord(rawConfig['models']) ? rawConfig['models'] : {};
  mergeManagedModelAliases(models, options.models);
  rawConfig['models'] = models;

  rawConfig['default_model'] = selected.modelKey;
  rawConfig['thinking'] = {
    ...(isRecord(rawConfig['thinking']) ? rawConfig['thinking'] : {}),
    enabled: selected.thinking,
  };
  rawConfig['services'] = {
    ...(isRecord(rawConfig['services']) ? rawConfig['services'] : {}),
    moonshot_search: {
      base_url: `${options.baseUrl}/search`,
      api_key: '',
      oauth: managedOAuthRef(options.oauthKey, options.oauthHost),
    },
    moonshot_fetch: {
      base_url: `${options.baseUrl}/fetch`,
      api_key: '',
      oauth: managedOAuthRef(options.oauthKey, options.oauthHost),
    },
  };
  return { defaultModel: selected.modelKey, defaultThinking: selected.thinking };
}

/* ------------------------------------------------------------------ */
/* Login + status entry points                                         */
/* ------------------------------------------------------------------ */

/** Resolve the base URL / oauth host for login (`resolveKimiCodeLoginAuth` port). */
function resolveLoginAuth(
  rawConfig: Record<string, unknown>,
  requested: { baseUrl?: string; oauthHost?: string },
): { baseUrl: string | undefined; oauthHost: string } {
  const env = process.env;
  const envBaseUrl = env['KIMI_CODE_BASE_URL'];
  const envOAuthHost = env['KIMI_CODE_OAUTH_HOST'] ?? env['KIMI_OAUTH_HOST'];
  const configuredProvider = isRecord(rawConfig['providers'])
    ? rawConfig['providers'][KIMI_CODE_PROVIDER_NAME]
    : undefined;
  const configuredBaseUrl =
    isRecord(configuredProvider) &&
    typeof (configuredProvider['baseUrl'] ?? configuredProvider['base_url']) === 'string'
      ? (configuredProvider['baseUrl'] ?? configuredProvider['base_url']) as string
      : undefined;
  const baseUrl =
    requested.baseUrl !== undefined
      ? requested.baseUrl.replace(/\/+$/, '')
      : envBaseUrl !== undefined
        ? envBaseUrl.replace(/\/+$/, '')
        : configuredBaseUrl;
  const oauthHost = requested.oauthHost ?? envOAuthHost ?? DEFAULT_KIMI_CODE_OAUTH_HOST;
  return { baseUrl, oauthHost };
}

/**
 * Run the managed kimi-code device login: device flow → token persistence →
 * `/models` fetch → config.toml provisioning. Equivalent to the SDK
 * `KimiAuthFacade.login(undefined, ...)` path.
 */
export async function managedKimiLogin(options: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly identity?: KimiHostIdentity | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onDeviceCode?: ((data: DeviceCodeData) => void | Promise<void>) | undefined;
  readonly baseUrl?: string | undefined;
  readonly oauthHost?: string | undefined;
}): Promise<ManagedKimiLoginResult> {
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: options.configPath });
  const { config: loadedConfig } = loadRuntimeConfigSafe(configPath);
  const { baseUrl, oauthHost } = resolveLoginAuth(loadedConfig as Record<string, unknown>, {
    baseUrl: options.baseUrl,
    oauthHost: options.oauthHost,
  });
  const clientId = DEFAULT_KIMI_FLOW_CLIENT_ID;
  const identity = options.identity;

  const token = await runDeviceFlow({
    homeDir,
    oauthHost,
    clientId,
    identity,
    signal: options.signal,
    onDeviceCode: options.onDeviceCode,
  });
  saveToken(homeDir, tokenStorageName(KIMI_CODE_OAUTH_KEY), token);

  const resolvedBaseUrl = (baseUrl ?? DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/, '');
  const headers =
    identity === undefined
      ? undefined
      : {
          'User-Agent': `${identity.userAgentProduct}/${identity.version}`,
          ...deviceHeadersFor(homeDir, identity),
        };
  const models = await fetchManagedKimiCodeModels(resolvedBaseUrl, token.accessToken, headers);

  let raw: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    text = undefined;
  }
  if (text !== undefined && text.trim().length > 0) {
    try {
      const parsed = parseToml(text);
      raw = isRecord(parsed) ? parsed : {};
    } catch {
      // Unparseable config: start from an empty record (the write below
      // recreates the file with the managed sections).
    }
  }
  const hadToken = readCachedAccessToken(homeDir) !== undefined;
  const applied = applyManagedKimiCodeConfig(raw, {
    models,
    baseUrl: resolvedBaseUrl,
    oauthKey: KIMI_CODE_OAUTH_KEY,
    oauthHost,
    preserveDefaultModel: hadToken,
  });

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileAtomic(tmp, `${stringify(raw)}\n`);
  renameSync(tmp, configPath);

  return {
    providerName: KIMI_CODE_PROVIDER_NAME,
    ok: true,
    defaultModel: applied.defaultModel,
    defaultThinking: applied.defaultThinking,
    configPath,
  };
}

function writeFileAtomic(path: string, content: string): void {
  const fd = openSync(path, 'w', 0o600);
  const data = Buffer.from(content, 'utf-8');
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Managed kimi-code auth status (SDK `KimiAuthFacade.status()` subset):
 * whether the default credential slot holds a token.
 */
export function kimiAuthStatus(homeDir: string): ManagedKimiAuthStatus {
  const resolvedHome = resolveKimiHome(homeDir);
  return {
    providers: [
      {
        providerName: KIMI_CODE_PROVIDER_NAME,
        hasToken: readCachedAccessToken(resolvedHome) !== undefined,
      },
    ],
  };
}
