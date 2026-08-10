/**
 * `/config` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/config` wire contract. Engine mode: the Rust
 * engine owns `config.toml` (`config/get` / `config/set` RPC), and this route
 * is the edge facade that projects the resolved camelCase config into the
 * snake_case `ConfigResponse`, redacting provider credentials to `has_api_key`
 * (mirrors v1 `toConfigResponse`), and folds v1's `yolo` sugar.
 */

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { configResponseSchema, patchConfigRequestSchema } from '../protocol/rest-config';
import type { ConfigResponse } from '../protocol/rest-config';
import type { RustSessionService } from '../services/rustSession/rustSessionService';

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

export function registerConfigRoutes(app: ConfigRouteHost, rustSession: RustSessionService): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/config',
      success: { data: configResponseSchema },
      description: 'Get the global Kimi configuration (secrets redacted)',
      tags: ['config'],
    },
    async (req, reply) => {
      // Engine mode: the engine parses config.toml itself (stage 2a); the
      // resolved camelCase KimiConfig flows through the same projection and
      // redaction as the retired v2 path.
      const resolved = (await rustSession.configGet()) as Record<string, unknown> | null;
      reply.send(okEnvelope(toConfigResponse(resolved ?? {}), req.id));
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
        // Engine mode: the engine owns config.toml — merge the camelCase patch
        // and re-read for the wire response.
        const camelPatch = convertKeysSnakeToCamel(req.body) as Record<string, unknown>;
        // v1 wire sugar: `yolo: true` is an alias for
        // `default_permission_mode = 'yolo'`. Fold it into the canonical
        // setting and drop the key so `yolo` is never persisted.
        if (camelPatch['yolo'] === true) {
          camelPatch['defaultPermissionMode'] = 'yolo';
        }
        delete camelPatch['yolo'];
        // v1 wire: `default_permission_mode` maps onto the engine's nested
        // `[agent.permission] mode` (the engine owns config.toml).
        const defaultMode = camelPatch['defaultPermissionMode'];
        if (defaultMode !== undefined) {
          delete camelPatch['defaultPermissionMode'];
          const agent = (camelPatch['agent'] as Record<string, unknown> | undefined) ?? {};
          camelPatch['agent'] = { ...agent, permission: { mode: defaultMode } };
        }
        await rustSession.configSet(camelPatch);
        const resolved = (await rustSession.configGet()) as Record<string, unknown> | null;
        const changedFields = Object.keys(req.body as Record<string, unknown>);
        // Only the changed field *names* — values may carry secrets.
        requestLog(req)?.info({ changedFields }, 'config updated');
        reply.send(okEnvelope(toConfigResponse(resolved ?? {}), req.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        requestLog(req)?.error({ err: error }, 'config update failed');
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
      }
    },
  );
  app.post(setRoute.path, setRoute.options, setRoute.handler as Parameters<ConfigRouteHost['post']>[2]);
}

// ---------------------------------------------------------------------------
// Edge facade — project the engine config into the v1 `ConfigResponse` wire
// shape. Top-level domain keys are mapped camelCase→snake_case generically,
// so this route does not enumerate the config domains; values pass through
// unchanged except `providers`, whose credentials are redacted to `has_api_key`
// (the only domain-specific transform). Pure projection: no service calls.
// ---------------------------------------------------------------------------

function toConfigResponse(resolved: Record<string, unknown>): ConfigResponse {
  const wire: Record<string, unknown> = {};
  for (const [domain, value] of Object.entries(resolved)) {
    wire[camelToSnake(domain)] = domain === 'providers' ? toProviderResponses(value) : value;
  }
  // v1 wire echo: surface the effective permission mode as
  // `default_permission_mode` + derived `yolo`. The engine stores it as
  // `[agent.permission] mode`; a legacy top-level `defaultPermissionMode`
  // (if the engine ever reports one) wins over the nested read.
  const agent = resolved['agent'] as Record<string, unknown> | undefined;
  const engineMode = (agent?.['permission'] as { mode?: unknown } | undefined)?.mode;
  const defaultPermissionMode = resolved['defaultPermissionMode'] ?? engineMode;
  if (typeof defaultPermissionMode === 'string') {
    wire['default_permission_mode'] = defaultPermissionMode;
    wire['yolo'] = defaultPermissionMode === 'yolo';
  }
  // `providers` is required by `ConfigResponse` even when no provider is configured.
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

function convertKeysSnakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(convertKeysSnakeToCamel);
  }
  if (isPlainObject(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[snakeToCamel(key)] = convertKeysSnakeToCamel(value);
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
