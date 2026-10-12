import type { Request, Response } from 'express';

import { ConfigRef, ConfigSections, useInject, type ConfigSectionContribution, type ConfigStore } from '@moonshot-ai/agent-core';
import { useCollection } from '@moonshot-ai/agent-core/kernel/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, sendErr, sendOk } from '../route/http';

export function useConfigRoutes(prefix: string): void {
  useHttpRoute({
    id: 'config.get',
    method: 'GET',
    path: `${prefix}/config`,
    handler: (request, response) => {
      const config = configFacade(request, response);
      if (config === undefined) return;
      sendOk(request, response, configResponse(config, registeredSections()));
    },
  });

  useHttpRoute({
    id: 'config.patch',
    method: 'POST',
    path: `${prefix}/config`,
    handler: async (request, response) => {
      const config = configFacade(request, response);
      if (config === undefined) return;
      if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'body must be an object');
        return;
      }
      const camelPatch = convertKeysSnakeToCamel(request.body) as Record<string, unknown>;
      if (camelPatch['yolo'] === true) {
        camelPatch['defaultPermissionMode'] = 'yolo';
      }
      delete camelPatch['yolo'];
      const sections = registeredSections();
      try {
        for (const domain of Object.keys(camelPatch)) {
          await config.set(domain, camelPatch[domain], 'user');
        }
      } catch (error) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      sendOk(request, response, configResponse(config, sections));
    },
  });
}

function configFacade(request: Request, response: Response): ConfigStore | undefined {
  const config = useInject(ConfigRef).value;
  if (config === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.CONFIG_UNAVAILABLE,
      'config is unavailable (config feature is not installed)',
    );
  }
  return config;
}

function registeredSections(): readonly ConfigSectionContribution[] {
  const seen = new Set<string>();
  const out: ConfigSectionContribution[] = [];
  for (const section of useCollection(ConfigSections).value) {
    if (seen.has(section.name)) continue;
    seen.add(section.name);
    out.push(section);
  }
  return out;
}

function configResponse(
  config: ConfigStore,
  sections: readonly ConfigSectionContribution[],
): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const section of sections) {
    const value = config.get(section.name);
    if (value === undefined) continue;
    wire[camelToSnake(section.name)] =
      section.name === 'providers'
        ? toProviderResponses(value)
        : section.name === 'models'
          ? toModelResponses(value)
          : section.name === 'services'
            ? toServiceResponses(value)
            : value;
  }
  const defaultPermissionMode = config.get('defaultPermissionMode');
  if (typeof defaultPermissionMode === 'string') {
    wire['yolo'] = defaultPermissionMode === 'yolo';
  }
  if (wire['providers'] === undefined) {
    wire['providers'] = {};
  }
  return wire;
}

interface ProviderLike {
  readonly type?: unknown;
  readonly baseUrl?: unknown;
  readonly defaultModel?: unknown;
  readonly apiKey?: unknown;
  readonly oauth?: unknown;
}

function toProviderResponses(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!isPlainObject(value)) return result;
  for (const [id, raw] of Object.entries(value)) {
    const provider = raw as ProviderLike;
    result[id] = {
      type: typeof provider.type === 'string' ? provider.type : '',
      base_url: nonEmpty(provider.baseUrl),
      default_model: nonEmpty(provider.defaultModel),
      has_api_key: hasCredential(provider),
    };
  }
  return result;
}

function toModelResponses(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!isPlainObject(value)) return result;
  for (const [id, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      result[id] = raw;
      continue;
    }
    const { apiKey: _apiKey, oauth: _oauth, ...rest } = raw as Record<string, unknown>;
    result[id] = { ...rest, has_api_key: hasCredential(raw as ProviderLike) };
  }
  return result;
}

function toServiceResponses(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!isPlainObject(value)) return result;
  for (const [id, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      result[id] = raw;
      continue;
    }
    const { apiKey: _apiKey, oauth: _oauth, customHeaders, ...rest } = raw as Record<string, unknown>;
    result[id] = {
      ...rest,
      has_api_key: hasCredential(raw as ProviderLike),
      custom_header_keys: isPlainObject(customHeaders) ? Object.keys(customHeaders) : undefined,
    };
  }
  return result;
}

function hasCredential(entry: ProviderLike): boolean {
  if (nonEmpty(entry.apiKey) !== undefined) return true;
  return entry.oauth !== undefined;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAP_VALUED_CONFIG_KEYS = new Set(['providers', 'models', 'services', 'experimental', 'raw']);

function convertKeysSnakeToCamel(obj: unknown, preserveKeys = false): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => convertKeysSnakeToCamel(item));
  }
  if (isPlainObject(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[preserveKeys ? key : snakeToCamel(key)] = convertKeysSnakeToCamel(
        value,
        !preserveKeys && MAP_VALUED_CONFIG_KEYS.has(key),
      );
    }
    return result;
  }
  return obj;
}

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
