import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { URL } from 'node:url';

import {
  ASTRON_MODEL_DEFS,
  ASTRON_REASONING_EFFORT_MODEL_IDS,
  type AstronModelDef,
} from './astron-models';
import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';
import { parseKimiCodeCustomHeaders } from './identity';
import { parseSupportsThinkingType, parseThinkEfforts } from './managed-kimi-code';
import { MANAGED_KIMI_MODEL_FIELDS, mergeRefreshedModelAlias } from './model-alias-merge';
import type {
  ManagedKimiCodeModelInfo,
  ManagedKimiConfigShape,
  ManagedKimiModelAlias,
} from './managed-kimi-code';

export type { ManagedKimiConfigShape };

export interface OpenPlatformDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly consoleUrl?: string;
  readonly allowedPrefixes?: readonly string[] | undefined;
}

export const OPEN_PLATFORMS: readonly OpenPlatformDefinition[] = [
  {
    id: 'moonshot-cn',
    name: 'Kimi Platform (API key · platform.kimi.com)',
    baseUrl: 'https://api.moonshot.cn/v1',
    consoleUrl: 'https://platform.kimi.com',
    allowedPrefixes: ['kimi-k'],
  },
  {
    id: 'moonshot-ai',
    name: 'Kimi Platform (API key · platform.kimi.ai)',
    baseUrl: 'https://api.moonshot.ai/v1',
    consoleUrl: 'https://platform.kimi.ai',
    allowedPrefixes: ['kimi-k'],
  },
  {
    id: 'astron',
    name: 'Xunfei Coding Plan (API key · xfyun.cn)',
    baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2',
    consoleUrl: 'https://www.xfyun.cn',
  },
];

/** Embedded model list for iFlytek Astron Coding Plan — no remote fetch needed.
 *  Re-exports the canonical model definitions from @moonshot-ai/kosong. */
export type AstronPlatformModelInfo = AstronModelDef;
export const ASTRON_PLATFORM_MODELS: readonly AstronModelDef[] = ASTRON_MODEL_DEFS;

export function getOpenPlatformById(id: string): OpenPlatformDefinition | undefined {
  return OPEN_PLATFORMS.find((p) => p.id === id);
}

export function isOpenPlatformId(id: string): boolean {
  return OPEN_PLATFORMS.some((p) => p.id === id);
}

function toModelInfo(item: unknown): ManagedKimiCodeModelInfo | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
    return undefined;
  }
  const contextLength = Number(item['context_length']);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error(`Model "${item['id']}" must include a positive context_length.`);
  }
  const displayName = item['display_name'];
  const normalizedDisplayName =
    typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined;
  const supportsToolUse = Object.hasOwn(item, 'supports_tool_use')
    ? Boolean(item['supports_tool_use'])
    : true;
  // Effort levels come from the nested `think_efforts` object
  // ({ support, valid_efforts, default_effort }) returned by /models.
  const thinkEfforts = parseThinkEfforts(item['think_efforts']);
  return {
    id: item['id'],
    contextLength,
    supportsReasoning: Boolean(item['supports_reasoning']),
    supportsImageIn: Boolean(item['supports_image_in']),
    supportsVideoIn: Boolean(item['supports_video_in']),
    supportsToolUse,
    supportsThinkingType: parseSupportsThinkingType(item['supports_thinking_type']),
    supportEfforts: thinkEfforts.supportEfforts,
    defaultEffort: thinkEfforts.defaultEffort,
    displayName: normalizedDisplayName,
  };
}

export function capabilitiesForModel(model: ManagedKimiCodeModelInfo): string[] | undefined {
  const caps = new Set<string>();
  // supports_thinking_type is the full three-state declaration and wins over
  // the legacy supports_reasoning boolean; absent (older servers) falls back.
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

export class OpenPlatformApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenPlatformApiError';
    this.status = status;
  }
}

// ── System CA fetch for providers with non-Mozilla CAs (e.g. xfyun.cn) ──────

const SYSTEM_CA_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
];

let _systemCaCerts: string[] | undefined;
let _systemCaLoadedAt = 0;

function loadSystemCAs(): string[] {
  const now = Date.now();
  // Refresh cached CAs every hour so newly installed certificates are picked up.
  if (_systemCaCerts && now - _systemCaLoadedAt < 3_600_000) {
    return _systemCaCerts;
  }
  _systemCaLoadedAt = now;
  let systemCerts = '';
  for (const path of SYSTEM_CA_PATHS) {
    if (existsSync(path)) {
      try {
        systemCerts = readFileSync(path, 'utf-8');
        break;
      } catch { /* ignore */ }
    }
  }
  _systemCaCerts = [systemCerts, ...rootCertificates].filter(Boolean);
  return _systemCaCerts;
}

function systemCaFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const ca = loadSystemCAs();
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers,
        ca,
        rejectUnauthorized: true,
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve(
            new Response(body, {
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string>,
            }),
          );
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
    if (init?.signal) {
      const onAbort = (): void => {
        req.destroy();
        reject(new Error('Aborted'));
      };
      if (init.signal.aborted) {
        onAbort();
        return;
      }
      init.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

export async function fetchOpenPlatformModels(
  platform: OpenPlatformDefinition,
  apiKey: string,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<ManagedKimiCodeModelInfo[]> {
  // Astron (xfyun.cn) models are embedded — no remote fetch needed.
  if (platform.id === 'astron') {
    return ASTRON_MODEL_DEFS.map((m): ManagedKimiCodeModelInfo => {
      // Only GLM-5.2 and the DeepSeek-V4 Pro/Flash models accept reasoning_effort
      // (high/max) on the Coding Plan; expose those levels so the effort picker
      // can select a concrete level. Every other model is thinking on/off only.
      const effortCapable = ASTRON_REASONING_EFFORT_MODEL_IDS.includes(m.id);
      return {
        id: m.id,
        contextLength: m.contextLength,
        displayName: m.displayName,
        supportsReasoning: true,
        supportsImageIn: false,
        supportsVideoIn: false,
        supportEfforts: effortCapable ? ['high', 'max'] : undefined,
        defaultEffort: effortCapable ? 'high' : undefined,
      };
    });
  }

  // Astron's xfyun.cn uses a Chinese CA not in the Mozilla store; fall back
  // to a system-CA fetch unless the caller explicitly provided one.
  const effectiveFetch = fetchImpl ?? (platform.id === 'astron' ? systemCaFetch as typeof fetch : fetch);
  const res = await effectiveFetch(`${platform.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: {
      ...parseKimiCodeCustomHeaders(),
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (!res.ok) {
    throw new OpenPlatformApiError(
      await readApiErrorMessage(res, `Failed to list models (HTTP ${res.status}).`),
      res.status,
    );
  }
  const payload: unknown = await res.json();
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response for ${platform.baseUrl}.`);
  }
  return payload['data']
    .map((item) => toModelInfo(item))
    .filter((item): item is ManagedKimiCodeModelInfo => item !== undefined);
}

export function filterModelsByPrefix(
  models: ManagedKimiCodeModelInfo[],
  platform: OpenPlatformDefinition,
): ManagedKimiCodeModelInfo[] {
  if (!platform.allowedPrefixes || platform.allowedPrefixes.length === 0) {
    return models;
  }
  const prefixes = platform.allowedPrefixes;
  return models.filter((m) => prefixes.some((p) => m.id.startsWith(p)));
}

export interface ApplyOpenPlatformResult {
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
}

export function applyOpenPlatformConfig(
  config: ManagedKimiConfigShape,
  options: {
    readonly platform: OpenPlatformDefinition;
    readonly models: readonly ManagedKimiCodeModelInfo[];
    readonly selectedModel: ManagedKimiCodeModelInfo;
    readonly thinking: boolean;
    /** Concrete thinking effort to persist (e.g. 'low'/'high'/'max'). Omit
     * for boolean models, where thinking is simply enabled with no effort. */
    readonly effort?: string;
    readonly apiKey: string;
  },
): ApplyOpenPlatformResult {
  const providerKey = options.platform.id;
  const modelKey = `${providerKey}/${options.selectedModel.id}`;

  config.providers[providerKey] = {
    type: 'kimi',
    baseUrl: options.platform.baseUrl,
    apiKey: options.apiKey,
  };

  const existingModels = config.models ?? {};
  // Selectively merge upstream models into the existing config so any fields
  // the user added by hand (or that upstream does not declare) survive a
  // refresh. Models that upstream no longer lists are removed; the rest are
  // merged field-by-field.
  const upstreamKeys = new Set(options.models.map((m) => `${providerKey}/${m.id}`));
  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === providerKey && !upstreamKeys.has(key)) {
      delete existingModels[key];
    }
  }

  for (const model of options.models) {
    const aliasKey = `${providerKey}/${model.id}`;
    const existing = isRecord(existingModels[aliasKey]) ? existingModels[aliasKey] : {};
    const remoteAlias: ManagedKimiModelAlias = {
      provider: providerKey,
      model: model.id,
      maxContextSize: model.contextLength,
      capabilities: capabilitiesForModel(model),
      ...(model.displayName !== undefined ? { displayName: model.displayName } : {}),
      ...(model.supportEfforts !== undefined ? { supportEfforts: model.supportEfforts } : {}),
      ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
    };
    existingModels[aliasKey] = mergeRefreshedModelAlias(
      existing,
      remoteAlias,
      MANAGED_KIMI_MODEL_FIELDS,
    );
  }

  config.models = existingModels;
  config.defaultModel = modelKey;
  config.thinking = {
    ...config.thinking,
    enabled: options.thinking,
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
  };

  return { defaultModel: modelKey, defaultThinking: options.thinking };
}

export function removeOpenPlatformConfig(
  config: ManagedKimiConfigShape,
  platformId: string,
): void {
  delete config.providers[platformId];

  let removedDefault = false;
  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (!isRecord(model) || model['provider'] !== platformId) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefault = true;
  }
  config.models = existingModels;

  if (removedDefault) {
    config.defaultModel = undefined;
  }

  if (config['defaultProvider'] === platformId) {
    config['defaultProvider'] = undefined;
  }
}
