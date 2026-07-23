import { Buffer } from 'node:buffer';

import { OAuthError, OAuthUnauthorizedError } from './errors';
import type {
  ManagedKimiConfigShape,
  ManagedKimiModelAlias,
  ManagedKimiOAuthRef,
} from './managed-kimi-code';
import { mergeRefreshedModelAlias } from './model-alias-merge';
import type { TokenStorage } from './storage';
import type { TokenInfo } from './types';
import { isRecord } from './utils';
import { resolveKimiTokenStorageName, type BearerTokenProvider } from './toolkit';

export const OPENAI_CODEX_PROVIDER_NAME = 'openai-codex';
export const OPENAI_CODEX_OAUTH_KEY = 'oauth/openai-codex';
export const OPENAI_CODEX_OAUTH_HOST = 'https://auth.openai.com';
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const DEVICE_USER_CODE_URL = `${OPENAI_CODEX_OAUTH_HOST}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${OPENAI_CODEX_OAUTH_HOST}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${OPENAI_CODEX_OAUTH_HOST}/codex/device`;
const DEVICE_REDIRECT_URI = `${OPENAI_CODEX_OAUTH_HOST}/deviceauth/callback`;
const TOKEN_URL = `${OPENAI_CODEX_OAUTH_HOST}/oauth/token`;
const MODELS_URL = `${OPENAI_CODEX_BASE_URL}/models`;
const REFRESH_THRESHOLD_SECONDS = 60;
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const MODEL_CATALOG_CLIENT_VERSIONS = ['0.200.0', '0.145.0', '0.124.0', '0.0.0'] as const;
const OPENAI_CODEX_MODEL_FIELDS = new Set([
  'provider',
  'model',
  'maxContextSize',
  'capabilities',
  'displayName',
  'supportEfforts',
  'defaultEffort',
]);

export interface OpenAICodexDeviceCode {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly interval: number;
  readonly expiresIn: number;
}

interface DeviceAuthInfo {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly interval: number;
}

export interface OpenAICodexModelInfo {
  readonly id: string;
  readonly displayName: string;
  readonly contextLength: number;
  readonly supportsImageIn: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

export interface OpenAICodexRequestAuth {
  readonly apiKey: string;
  readonly headers: Record<string, string>;
}

export interface OpenAICodexCleanupResult {
  readonly providerName: typeof OPENAI_CODEX_PROVIDER_NAME;
  readonly removedProvider: boolean;
  readonly removedModels: readonly string[];
  readonly defaultModelCleared: boolean;
}

export const OPENAI_CODEX_MODELS: readonly OpenAICodexModelInfo[] = [
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    contextLength: 272000,
    supportsImageIn: true,
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    contextLength: 272000,
    supportsImageIn: true,
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    contextLength: 372000,
    supportsImageIn: true,
  },
];

function tokenFromResponse(payload: unknown): TokenInfo {
  if (!isRecord(payload)) throw new OAuthError('OpenAI Codex token response must be an object.');
  const accessToken = payload['access_token'];
  const refreshToken = payload['refresh_token'];
  const expiresIn = Number(payload['expires_in']);
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthError('OpenAI Codex token response missing access_token.');
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new OAuthError('OpenAI Codex token response missing refresh_token.');
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError('OpenAI Codex token response missing or invalid expires_in.');
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    expiresIn,
    scope: typeof payload['scope'] === 'string' ? payload['scope'] : '',
    tokenType: typeof payload['token_type'] === 'string' ? payload['token_type'] : 'Bearer',
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return body.length > 0 ? body : response.statusText;
}

async function startDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthInfo> {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    signal,
  });
  if (!response.ok) {
    throw new OAuthError(
      `OpenAI Codex device authorization failed (HTTP ${response.status}): ${await readError(response)}`,
    );
  }
  const payload = await readJson(response);
  if (!isRecord(payload)) throw new OAuthError('OpenAI Codex device authorization response must be an object.');
  const deviceAuthId = payload['device_auth_id'];
  const userCode = payload['user_code'];
  const interval = Number(payload['interval'] ?? 5);
  if (typeof deviceAuthId !== 'string' || deviceAuthId.length === 0) {
    throw new OAuthError('OpenAI Codex device authorization response missing device_auth_id.');
  }
  if (typeof userCode !== 'string' || userCode.length === 0) {
    throw new OAuthError('OpenAI Codex device authorization response missing user_code.');
  }
  return {
    deviceAuthId,
    userCode,
    interval: Number.isFinite(interval) && interval >= 0 ? interval : 5,
  };
}

async function pollDeviceAuth(
  device: DeviceAuthInfo,
  options: { readonly signal?: AbortSignal; readonly sleep?: (ms: number) => Promise<void> },
): Promise<{ readonly authorizationCode: string; readonly codeVerifier: string }> {
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    if (options.signal?.aborted) throw new OAuthError('OpenAI Codex login cancelled.');
    if (Date.now() > deadline) throw new OAuthError('OpenAI Codex device authorization timed out.');
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
      signal: options.signal,
    });
    if (response.ok) {
      const payload = await readJson(response);
      if (!isRecord(payload)) throw new OAuthError('OpenAI Codex device token response must be an object.');
      const authorizationCode = payload['authorization_code'];
      const codeVerifier = payload['code_verifier'];
      if (typeof authorizationCode !== 'string' || authorizationCode.length === 0) {
        throw new OAuthError('OpenAI Codex device token response missing authorization_code.');
      }
      if (typeof codeVerifier !== 'string' || codeVerifier.length === 0) {
        throw new OAuthError('OpenAI Codex device token response missing code_verifier.');
      }
      return { authorizationCode, codeVerifier };
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new OAuthError(
        `OpenAI Codex device token polling failed (HTTP ${response.status}): ${await readError(response)}`,
      );
    }
    await sleep((device.interval + 3) * 1000);
  }
}

async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<TokenInfo> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
    signal,
  });
  if (!response.ok) {
    throw new OAuthError(
      `OpenAI Codex token exchange failed (HTTP ${response.status}): ${await readError(response)}`,
    );
  }
  return tokenFromResponse(await readJson(response));
}

export async function loginOpenAICodexDeviceCode(options: {
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onDeviceCode?: (info: OpenAICodexDeviceCode) => void;
} = {}): Promise<TokenInfo> {
  const device = await startDeviceAuth(options.signal);
  options.onDeviceCode?.({
    userCode: device.userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    interval: device.interval,
    expiresIn: 15 * 60,
  });
  const token = await pollDeviceAuth(device, options);
  return exchangeAuthorizationCode(
    token.authorizationCode,
    token.codeVerifier,
    DEVICE_REDIRECT_URI,
    options.signal,
  );
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<TokenInfo> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OPENAI_CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new OAuthUnauthorizedError('OpenAI Codex OAuth credentials were rejected.');
  }
  if (!response.ok) {
    throw new OAuthError(
      `OpenAI Codex token refresh failed (HTTP ${response.status}): ${await readError(response)}`,
    );
  }
  return tokenFromResponse(await readJson(response));
}

export function extractOpenAICodexAccountId(accessToken: string): string | undefined {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf-8')) as unknown;
    if (!isRecord(payload)) return undefined;
    const auth = payload[JWT_CLAIM_PATH];
    if (isRecord(auth) && typeof auth['chatgpt_account_id'] === 'string') {
      return auth['chatgpt_account_id'];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function isOpenAICodexAuth(
  providerName: string,
  oauthRef?: Pick<ManagedKimiOAuthRef, 'key'>,
): boolean {
  return (
    providerName === OPENAI_CODEX_PROVIDER_NAME || oauthRef?.key === OPENAI_CODEX_OAUTH_KEY
  );
}

export function createOpenAICodexRequestAuth(accessToken: string): OpenAICodexRequestAuth {
  const accountId = extractOpenAICodexAccountId(accessToken);
  if (accountId === undefined) {
    throw new OAuthUnauthorizedError('OpenAI Codex OAuth token missing ChatGPT account id.');
  }
  return {
    apiKey: accessToken,
    headers: {
      'ChatGPT-Account-Id': accountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'kimi-code',
    },
  };
}

function readModelNumber(model: Record<string, unknown>, key: string): number | undefined {
  const value = model[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function parseReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const effort = item['effort'];
    return typeof effort === 'string' && effort.length > 0 ? [effort] : [];
  });
  return efforts.length > 0 ? efforts : undefined;
}

function parseOpenAICodexModel(value: unknown): OpenAICodexModelInfo | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['slug'];
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (value['visibility'] === 'hide') return undefined;
  if (value['supported_in_api'] === false) return undefined;
  if (value['upgrade'] !== null && value['upgrade'] !== undefined) return undefined;
  const contextLength =
    readModelNumber(value, 'context_window') ?? readModelNumber(value, 'max_context_window');
  if (contextLength === undefined) return undefined;

  const inputModalities = value['input_modalities'];
  const supportsImageIn =
    Array.isArray(inputModalities) && inputModalities.some((item) => item === 'image');
  const displayName = typeof value['display_name'] === 'string' && value['display_name'].length > 0
    ? value['display_name']
    : id;
  const defaultEffort = value['default_reasoning_level'];
  return {
    id,
    displayName,
    contextLength,
    supportsImageIn,
    supportEfforts: parseReasoningEfforts(value['supported_reasoning_levels']),
    defaultEffort: typeof defaultEffort === 'string' && defaultEffort.length > 0
      ? defaultEffort
      : undefined,
  };
}

async function fetchOpenAICodexModelsForVersion(
  accessToken: string,
  clientVersion: string,
  signal?: AbortSignal,
): Promise<OpenAICodexModelInfo[]> {
  const accountId = extractOpenAICodexAccountId(accessToken);
  if (accountId === undefined) {
    throw new OAuthError('OpenAI Codex OAuth token missing ChatGPT account id.');
  }
  const url = new URL(MODELS_URL);
  url.searchParams.set('client_version', clientVersion);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
      originator: 'kimi-code',
    },
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new OAuthUnauthorizedError('OpenAI Codex OAuth credentials were rejected.');
  }
  if (!response.ok) {
    throw new OAuthError(
      `OpenAI Codex models endpoint failed (HTTP ${response.status}): ${await readError(response)}`,
    );
  }
  const payload = await readJson(response);
  if (!isRecord(payload) || !Array.isArray(payload['models'])) {
    throw new OAuthError('OpenAI Codex models response must include a models array.');
  }
  return payload['models'].flatMap((item) => {
    const parsed = parseOpenAICodexModel(item);
    return parsed === undefined ? [] : [parsed];
  });
}

export async function fetchOpenAICodexModels(
  accessToken: string,
  options: {
    readonly signal?: AbortSignal;
    readonly clientVersions?: readonly string[];
  } = {},
): Promise<OpenAICodexModelInfo[]> {
  const versions = options.clientVersions ?? MODEL_CATALOG_CLIENT_VERSIONS;
  let lastError: unknown;
  for (const clientVersion of versions) {
    try {
      const models = await fetchOpenAICodexModelsForVersion(
        accessToken,
        clientVersion,
        options.signal,
      );
      if (models.length > 0) return models;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new OAuthError('OpenAI Codex models endpoint returned no available models.');
}

export function createOpenAICodexTokenProvider(options: {
  readonly storage: TokenStorage;
  readonly providerName?: string | undefined;
  readonly oauthRef?: Pick<ManagedKimiOAuthRef, 'key'> | undefined;
  readonly now?: () => number;
}): BearerTokenProvider {
  const storageName = resolveKimiTokenStorageName({
    providerName: options.providerName ?? OPENAI_CODEX_PROVIDER_NAME,
    oauthKey: options.oauthRef?.key ?? OPENAI_CODEX_OAUTH_KEY,
  });
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    getAccessToken: async (requestOptions) => {
      const current = await options.storage.load(storageName);
      if (current === undefined || current.refreshToken.length === 0) {
        throw new OAuthUnauthorizedError('OpenAI Codex OAuth login is required.');
      }
      if (
        requestOptions?.force !== true &&
        current.accessToken.length > 0 &&
        current.expiresAt - now() > REFRESH_THRESHOLD_SECONDS
      ) {
        return current.accessToken;
      }
      const refreshed = await refreshOpenAICodexToken(current.refreshToken);
      await options.storage.save(storageName, refreshed);
      return refreshed.accessToken;
    },
  };
}

function modelCapabilities(model: OpenAICodexModelInfo): string[] {
  return model.supportsImageIn
    ? ['tool_use', 'thinking', 'image_in']
    : ['tool_use', 'thinking'];
}

export function openAICodexModelToAlias(model: OpenAICodexModelInfo): ManagedKimiModelAlias {
  const supportEfforts = model.supportEfforts ?? ['low', 'medium', 'high', 'xhigh'];
  return {
    provider: OPENAI_CODEX_PROVIDER_NAME,
    model: model.id,
    maxContextSize: model.contextLength,
    capabilities: modelCapabilities(model),
    displayName: model.displayName,
    supportEfforts,
    defaultEffort: model.defaultEffort ?? (supportEfforts.includes('medium') ? 'medium' : supportEfforts[0]),
  };
}

export function openAICodexOAuthRef(): ManagedKimiOAuthRef {
  return {
    storage: 'file',
    key: OPENAI_CODEX_OAUTH_KEY,
    oauthHost: OPENAI_CODEX_OAUTH_HOST,
  };
}

export function applyOpenAICodexConfig(
  config: ManagedKimiConfigShape,
  options: {
    readonly selectedModelId?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly effort?: string | undefined;
    readonly models?: readonly OpenAICodexModelInfo[];
  } = {},
): { readonly defaultModel: string; readonly defaultThinking: boolean } {
  config.providers[OPENAI_CODEX_PROVIDER_NAME] = {
    type: 'openai_responses',
    baseUrl: OPENAI_CODEX_BASE_URL,
    apiKey: '',
    oauth: openAICodexOAuthRef(),
  };

  const models = config.models ?? {};
  const upstreamModels = options.models ?? OPENAI_CODEX_MODELS;
  const upstreamKeys = new Set(upstreamModels.map((model) => `${OPENAI_CODEX_PROVIDER_NAME}/${model.id}`));
  for (const [key, alias] of Object.entries(models)) {
    if (isRecord(alias) && alias['provider'] === OPENAI_CODEX_PROVIDER_NAME && !upstreamKeys.has(key)) {
      delete models[key];
    }
  }
  for (const model of upstreamModels) {
    const key = `${OPENAI_CODEX_PROVIDER_NAME}/${model.id}`;
    const existing = isRecord(models[key]) ? models[key] : {};
    models[key] = mergeRefreshedModelAlias(
      existing,
      openAICodexModelToAlias(model),
      OPENAI_CODEX_MODEL_FIELDS,
    );
  }
  config.models = models;

  const selectedModelId = options.selectedModelId ?? 'gpt-5.4';
  const defaultModel = `${OPENAI_CODEX_PROVIDER_NAME}/${selectedModelId}`;
  config.defaultModel = defaultModel;
  const defaultThinking = options.thinking ?? true;
  config.thinking = {
    ...config.thinking,
    enabled: defaultThinking,
    effort: options.effort,
  };
  return { defaultModel, defaultThinking };
}

export function clearOpenAICodexConfig(
  config: ManagedKimiConfigShape,
): OpenAICodexCleanupResult {
  const removedProvider = Object.hasOwn(config.providers, OPENAI_CODEX_PROVIDER_NAME);
  delete config.providers[OPENAI_CODEX_PROVIDER_NAME];

  const removedModels: string[] = [];
  if (config.models !== undefined) {
    for (const [key, model] of Object.entries(config.models)) {
      if (!isRecord(model) || model['provider'] !== OPENAI_CODEX_PROVIDER_NAME) continue;
      delete config.models[key];
      removedModels.push(key);
    }
  }

  const defaultModelCleared =
    typeof config.defaultModel === 'string' && removedModels.includes(config.defaultModel);
  if (defaultModelCleared) config.defaultModel = undefined;

  return {
    providerName: OPENAI_CODEX_PROVIDER_NAME,
    removedProvider,
    removedModels,
    defaultModelCleared,
  };
}
