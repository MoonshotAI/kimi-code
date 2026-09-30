import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  anthropicRequester,
  createStaticCredentialProvider,
  googleGenAIRequester,
  kimiAnthropicRequester,
  kimiRequester,
  kimiResponsesRequester,
  openAIRequester,
  openAIResponsesRequester,
  type AgentLlmRequester,
  type LlmEndpoint,
  type LlmModelSpec,
  type ModelCapability,
  type ThinkingRequestOptions,
} from '@moonshot-ai/agent-core';
import { parse } from 'smol-toml';

export interface KimiCodeDefault {
  readonly model: LlmModelSpec;
  readonly requester: AgentLlmRequester;
  readonly endpoint: LlmEndpoint;
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
  const model: LlmModelSpec = {
    provider: providerId,
    name: modelName,
    capability: capabilityOf(capabilities),
    maxContextSize: asNumber(entry['max_context_size']),
  };
  const thinking = thinkingOf(asRecord(root['thinking']), asString(entry['default_effort']));
  return {
    model,
    requester: requesterFor(type, protocol),
    endpoint: {
      baseUrl: asString(provider['base_url']),
      credentials: createStaticCredentialProvider(apiKey),
    },
    thinking,
    key,
  };
}

function requesterFor(type: string, protocol: string | undefined): AgentLlmRequester {
  if (type === 'kimi') {
    if (protocol === 'anthropic') return kimiAnthropicRequester;
    if (protocol === 'openai_responses') return kimiResponsesRequester;
    if (protocol === undefined || protocol === 'openai') return kimiRequester;
    throw new Error(`provider 'kimi' has no protocol '${protocol}'`);
  }
  if (type === 'anthropic') {
    return anthropicRequester;
  }
  if (type === 'google-genai' || type === 'google') {
    return googleGenAIRequester;
  }
  if ((protocol ?? type) === 'openai_responses') {
    return openAIResponsesRequester;
  }
  return openAIRequester;
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
