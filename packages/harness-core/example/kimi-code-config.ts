import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  anthropicProvider,
  createStaticCredentialProvider,
  googleProvider,
  openaiProvider,
  type LlmCredentialProvider,
  type LlmModel,
  type LlmRequester,
  type ModelCapability,
  type ThinkingRequestOptions,
} from '@moonshot-ai/agent-core';
import { parse } from 'smol-toml';

import { kimiProvider } from '@moonshot-ai/harness-core';

export interface KimiCodeDefault {
  readonly model: LlmModel;
  readonly requester: LlmRequester;
  readonly credentialProvider: LlmCredentialProvider;
  readonly thinking?: ThinkingRequestOptions;
  readonly key: string;
}

export function loadKimiCodeDefault(): KimiCodeDefault {
  const home = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  const path = join(home, 'config.toml');
  const root = asRecord(parse(readFileSync(path, 'utf8')));
  if (root === undefined) {
    throw new Error(`invalid kimi-code config: ${path}`);
  }
  const key = process.env['KIMI_MODEL'] ?? 'free-tokens_kimi/kimi-k3';
  const models = asRecord(root['models']);
  const entry = models === undefined ? undefined : asRecord(models[key]);
  if (entry === undefined) {
    throw new Error(`model '${key}' is not in ${path}`);
  }
  const providerId = asString(entry['provider']);
  const modelName = asString(entry['model']);
  if (providerId === undefined || modelName === undefined) {
    throw new Error(`model '${key}' is missing provider or model`);
  }
  const providers = asRecord(root['providers']);
  const provider = providers === undefined ? undefined : asRecord(providers[providerId]);
  if (provider === undefined) {
    throw new Error(`provider '${providerId}' is not in ${path}`);
  }
  const type = asString(provider['type']) ?? 'openai';
  const protocol = asString(entry['protocol']);
  const apiKey = process.env['KIMI_API_KEY'] ?? asString(provider['api_key']);
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`provider '${providerId}' has no api_key`);
  }
  const capabilities = asStringList(entry['capabilities']);
  const model: LlmModel = {
    provider: providerId,
    model: modelName,
    capability: capabilityOf(capabilities),
    maxContextSize: asNumber(entry['max_context_size']),
    baseUrl: asString(provider['base_url']),
    apiKey,
  };
  const thinking = thinkingOf(asRecord(root['thinking']), asString(entry['default_effort']));
  return {
    model,
    requester: requesterOf(type, protocol),
    credentialProvider: createStaticCredentialProvider(apiKey),
    thinking,
    key,
  };
}

function requesterOf(type: string, protocol: string | undefined): LlmRequester {
  if (type === 'kimi') {
    return kimiProvider.createRequester(protocol);
  }
  if (type === 'anthropic') {
    return anthropicProvider.createRequester();
  }
  if (type === 'google-genai' || type === 'google') {
    return googleProvider.createRequester();
  }
  if ((protocol ?? type) === 'openai_responses') {
    return openaiProvider.createRequester('openai_responses');
  }
  return openaiProvider.createRequester('openai');
}

function capabilityOf(names: readonly string[]): ModelCapability {
  const has = (name: string) => names.includes(name);
  return {
    image_in: has('image_in'),
    video_in: has('video_in'),
    audio_in: has('audio_in'),
    thinking: has('thinking') || has('always_thinking'),
    tool_use: has('tool_use'),
    dynamically_loaded_tools: has('dynamically_loaded_tools'),
  };
}

function thinkingOf(
  section: Record<string, unknown> | undefined,
  defaultEffort: string | undefined,
): ThinkingRequestOptions | undefined {
  if (section === undefined || section['enabled'] === false) {
    return undefined;
  }
  const effort = asString(section['effort']) ?? defaultEffort;
  return effort === undefined ? undefined : { effort };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}
