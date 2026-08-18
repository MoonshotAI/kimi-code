import {
  ConfigChanged,
  IConfigService,
  IEventService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { configResponseSchema, patchConfigRequestSchema } from '../protocol/rest-config';
import type { ConfigResponse } from '../protocol/rest-config';

type ProviderResponse = ConfigResponse['providers'][string];

interface ConfigRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerConfigRoutes(app: ConfigRouteHost, core: Scope): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/config',
      success: { data: configResponseSchema },
      description: 'Get the global Kimi configuration (secrets redacted)',
      tags: ['config'],
    },
    async (req, reply) => {
      const config = core.accessor.get(IConfigService);
      await config.ready;
      reply.send(okEnvelope(toConfigResponse(config.getAll()), req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<ConfigRouteHost['get']>[2]);

  const setRoute = defineRoute(
    {
      method: 'POST',
      path: '/config',
      body: patchConfigRequestSchema,
      success: { data: configResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description: 'Update the global Kimi configuration (merge semantics)',
      tags: ['config'],
    },
    async (req, reply) => {
      try {
        const config = core.accessor.get(IConfigService);
        await config.ready;
        const camelPatch = convertKeysSnakeToCamel(req.body) as Record<string, unknown>;
        if (camelPatch['yolo'] === true) {
          camelPatch['defaultPermissionMode'] = 'yolo';
        }
        delete camelPatch['yolo'];
        for (const domain of Object.keys(camelPatch)) {
          await config.set(domain, camelPatch[domain]);
        }
        const response = toConfigResponse(config.getAll());
        const changedFields = Object.keys(req.body as Record<string, unknown>);
        core.accessor.get(IEventService).publish(
          new ConfigChanged({ payload: { changedFields, config: response } }),
        );
        requestLog(req)?.info({ changedFields }, 'config updated');
        reply.send(okEnvelope(response, req.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        requestLog(req)?.error({ err: error }, 'config update failed');
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
      }
    },
  );
  app.post(setRoute.path, setRoute.options, setRoute.handler as Parameters<ConfigRouteHost['post']>[2]);
}

function toConfigResponse(resolved: Record<string, unknown>): ConfigResponse {
  const wire: Record<string, unknown> = {};
  for (const [domain, value] of Object.entries(resolved)) {
    wire[camelToSnake(domain)] = domain === 'providers' ? toProviderResponses(value) : value;
  }
  const defaultPermissionMode = resolved['defaultPermissionMode'];
  if (typeof defaultPermissionMode === 'string') {
    wire['yolo'] = defaultPermissionMode === 'yolo';
  }
  if (wire['providers'] === undefined) {
    wire['providers'] = {};
  }
  return wire as ConfigResponse;
}

interface ProviderLike {
  readonly type?: unknown;
  readonly baseUrl?: unknown;
  readonly defaultModel?: unknown;
  readonly apiKey?: unknown;
  readonly oauth?: unknown;
}

function toProviderResponses(value: unknown): Record<string, ProviderResponse> {
  const result: Record<string, ProviderResponse> = {};
  if (!isPlainObject(value)) return result;
  for (const [id, raw] of Object.entries(value)) {
    const provider = raw as ProviderLike;
    result[id] = {
      type: typeof provider.type === 'string' ? provider.type : '',
      base_url: nonEmpty(provider.baseUrl),
      default_model: nonEmpty(provider.defaultModel),
      has_api_key: hasProviderCredential(provider),
    };
  }
  return result;
}

function hasProviderCredential(provider: ProviderLike): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  if (provider.oauth !== undefined) return true;
  return false;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAP_VALUED_CONFIG_KEYS = new Set(['providers', 'models', 'experimental', 'raw']);

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
