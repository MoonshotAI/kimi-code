/**
 * `/config` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/config` wire contract on top of `agent-core-v2`'s
 * section-registry `IConfigService`:
 *   GET  /config   — global Kimi configuration, secrets redacted
 *   POST /config   — update global configuration (merge semantics)
 *
 * **Wire fidelity**: reuses the local `protocol/rest-config` `configResponseSchema` /
 * `patchConfigRequestSchema` verbatim, so the request/response shape is
 * byte-for-byte compatible with v1's `routes/config.ts`. v2's `IConfigService`
 * is a per-domain registry (`get(domain)` / `set(domain, patch)`) and does not
 * expose a whole-config view or redaction, so this route is the edge facade
 * that:
 *   - projects `getAll()` (camelCase resolved config) into the snake_case
 *     `ConfigResponse`, redacting provider credentials to `has_api_key`
 *     (mirrors v1 `toConfigResponse`);
 *   - splits v1's flat multi-domain `POST /config` patch into per-domain
 *     `IConfigService.set(domain, value)` calls (snake_case → camelCase);
 *   - republishes the change as a v2 `DomainEvent` on `IEventService`.
 *
 * **Event shape**: v2's `DomainEvent` is `{ type, payload }`, and the Core
 * `events` WS stream forwards it as-is. The config-changed notification is
 * therefore emitted as `{ type: 'event.config.changed', payload: { changedFields,
 * config } }` rather than v1's flat `{ type, changedFields, config }`. The HTTP
 * response (the schema contract) is unaffected.
 */

import { IConfigService, IEventService, type Scope } from '@moonshot-ai/agent-core-v2';

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
        // v1 wire sugar: `yolo: true` is an alias for
        // `default_permission_mode = 'yolo'`. Fold it into the canonical domain and
        // drop the key so `yolo` is never a config domain and never persisted.
        if (camelPatch['yolo'] === true) {
          camelPatch['defaultPermissionMode'] = 'yolo';
        }
        delete camelPatch['yolo'];
        for (const domain of Object.keys(camelPatch)) {
          await config.set(domain, camelPatch[domain]);
        }
        const response = toConfigResponse(config.getAll());
        const changedFields = Object.keys(req.body as Record<string, unknown>);
        core.accessor.get(IEventService).publish({
          type: 'event.config.changed',
          payload: {
            changedFields,
            config: response,
          },
        });
        // Only the changed field *names* — values may carry secrets.
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

// ---------------------------------------------------------------------------
// Edge facade — project the v2 resolved config into the v1 `ConfigResponse`
// wire shape. Top-level domain keys are mapped camelCase→snake_case generically,
// so this route does not enumerate the config domains; values pass through
// unchanged except `providers`, whose credentials are redacted to `has_api_key`
// (the only domain-specific transform). Pure projection: no service calls.
// ---------------------------------------------------------------------------

function toConfigResponse(resolved: Record<string, unknown>): ConfigResponse {
  const wire: Record<string, unknown> = {};
  for (const [domain, value] of Object.entries(resolved)) {
    wire[camelToSnake(domain)] = domain === 'providers' ? toProviderResponses(value) : value;
  }
  // v1 wire echo: surface `yolo` as a derived boolean of the effective default
  // permission mode. `yolo` is not a config domain; it is computed here so the
  // v1 `/config` shape is preserved without persisting a parallel field.
  const defaultPermissionMode = resolved['defaultPermissionMode'];
  if (typeof defaultPermissionMode === 'string') {
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
      const targetKey = snakeToCamel(key);
      result[targetKey] = targetKey === 'customBody' ? value : convertKeysSnakeToCamel(value);
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
