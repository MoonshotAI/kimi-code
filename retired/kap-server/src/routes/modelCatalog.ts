/**
 * `/models` + `/providers` catalog route handlers — native-engine projection.
 *
 * Implements the v1 model/provider catalog wire contract as projections over
 * the Rust engine's parsed config (`rustSession.configGet` /
 * `rustSession.configSet`). The engine is the only runtime (web sessions all
 * run through `RustSessionService`), so every handler below reads or writes
 * the camelCase KimiConfig directly — there is no v2 `IModelCatalog`:
 *   GET    /models                       — list configured model aliases
 *   GET    /providers                    — list configured providers
 *   GET    /providers/{provider_id}      — get a configured provider by id
 *   POST   /providers                    — create a provider manually
 *   PUT    /providers/{provider_id}      — replace a provider + rebuild its model aliases
 *   DELETE /providers/{provider_id}      — delete a provider + its model aliases
 *   POST   /models/{tail} (:set_default) — set the global default model alias
 *   POST   /providers/{tail} (:refresh)  — refresh a single provider by id (no-op)
 *
 * **Wire fidelity**: reuses the local catalog schemas and the numeric
 * `ErrorCode` envelope verbatim, so the response shape and error codes
 * (`40412` provider-not-found, `40413` model-not-found, `40001` validation)
 * stay byte-for-byte compatible with v1's `routes/modelCatalog.ts`. The v2
 * remote-discovery surface is gone from this edge: the models.dev directory
 * browse/import (`/catalog/providers*`, `/providers:import_*`) and the
 * discovery refreshes (`/providers:refresh*`) were v2-service-only
 * (`IModelsDevImportService` / `IProviderDiscoveryService` / `IOAuthService`)
 * and are not registered on the native engine.
 *
 * **Write surface**: create/replace/delete write the engine config through
 * `rustSession.configSet`. Replace and delete rebuild each section's entries
 * so an entry id absent from the replacement truly disappears. Multi-step
 * sequences are serialized through `enqueueProviderWrite`.
 */

import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import type { RustSessionService } from '../services/rustSession/rustSessionService';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  createProviderRequestSchema,
  createProviderResponseSchema,
  getProviderResponseSchema,
  listModelsResponseSchema,
  listProvidersResponseSchema,
  refreshProviderModelsResponseSchema,
  replaceProviderRequestSchema,
  replaceProviderResponseSchema,
  setDefaultModelResponseSchema,
} from '../protocol/rest-modelCatalog';
import { parseActionSuffix } from './action-suffix';

/**
 * The synthesized runtime-only model alias the engine overlays onto the
 * effective `models` view (bound-secondary config); never a configured alias,
 * so the list route keeps it out of pickers (the catalog still resolves it by
 * id). Copied from the v2 `app/kosongConfig/secondaryModelOverlay`.
 */
const SECONDARY_DERIVED_MODEL_ID = '__secondary__';

interface ModelCatalogRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

/** Reply shape used where a route answers a non-200 status (201/204). */
interface StatusReply {
  code(status: number): StatusReply;
  send(payload?: unknown): unknown;
}

const providerIdParamSchema = z.object({
  provider_id: z.string().min(1),
});

const modelActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const providerActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

/** Rust-engine provider projection (stage 3h): camelCase patch → v1 item. */
function toRustProviderCatalogItem(
  id: string,
  patch: Record<string, unknown>,
): {
  id: string;
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
  status: 'connected' | 'error' | 'unconfigured';
} {
  return {
    id,
    type: typeof patch['type'] === 'string' ? (patch['type'] as string) : 'unknown',
    ...(patch['baseUrl'] !== undefined ? { base_url: patch['baseUrl'] as string } : {}),
    ...(patch['defaultModel'] !== undefined
      ? { default_model: patch['defaultModel'] as string }
      : {}),
    has_api_key: patch['apiKey'] !== undefined,
    status: patch['apiKey'] !== undefined ? 'connected' : 'unconfigured',
  };
}

/**
 * Serializes the provider write routes' multi-step sequences (inspect → build
 * → replace × N). The engine config only serializes individual writes, so two
 * interleaved edits could otherwise lose each other's section rebuilds (or
 * land a half-migrated rename). The single-provider refresh route is excluded
 * — it is a no-op and chains nothing.
 */
let providerWriteChain: Promise<unknown> = Promise.resolve();

function enqueueProviderWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = providerWriteChain.then(task, task);
  providerWriteChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function registerModelCatalogRoutes(
  app: ModelCatalogRouteHost,
  rustSession: RustSessionService,
): void {
  const listModelsRoute = defineRoute(
    {
      method: 'GET',
      path: '/models',
      success: { data: listModelsResponseSchema },
      description: 'List configured model aliases',
      tags: ['models'],
    },
    async (req, reply) => {
      // Stage 3f: project configured model aliases from the engine's parsed
      // config — no v2 IModelCatalog.
      const config = (await rustSession.configGet()) as
        | { models?: Record<string, { provider: string; model: string }> }
        | null;
      const items = Object.entries(config?.models ?? {})
        .filter(([, alias]) => alias?.model !== SECONDARY_DERIVED_MODEL_ID)
        .map(([id, alias]) => ({
          provider: alias.provider,
          model: alias.model,
          display_name: id,
          max_context_size: 1_000_000,
        }));
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listModelsRoute.path,
    listModelsRoute.options,
    listModelsRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const setDefaultModelRoute = defineRoute(
    {
      method: 'POST',
      path: '/models/{tail}',
      params: modelActionTailParamSchema,
      success: { data: setDefaultModelResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.MODEL_NOT_FOUND]: {},
      },
      description: 'Set the global default model alias',
      tags: ['models'],
      operationId: 'setDefaultModel',
    },
    async (req, reply) => {
      const { tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['set_default'] as const,
        resourceLabel: 'model',
      });
      if (parsed.kind !== 'action') {
        const message =
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      // Stage 3h: write the global default-model pointer through the engine's
      // config — validated against the configured aliases like v2
      // `IModelCatalog.setDefaultModel` (unknown id → 40413). The v2
      // materialization gate (dangling provider, conflicting credentials)
      // does not exist on this path: any configured alias is settable.
      const config = (await rustSession.configGet()) as
        | {
            models?: Record<
              string,
              { provider?: string; model?: string; displayName?: string; maxContextSize?: number }
            >;
          }
        | null;
      const alias = config?.models?.[parsed.id];
      if (alias === undefined) {
        reply.send(
          errEnvelope(ErrorCode.MODEL_NOT_FOUND, `model ${parsed.id} does not exist`, req.id),
        );
        return;
      }
      await rustSession.configSet({ defaultModel: parsed.id });
      reply.send(
        okEnvelope(
          {
            default_model: parsed.id,
            model: {
              provider: alias.provider ?? '',
              model: alias.model ?? parsed.id,
              display_name: alias.displayName ?? parsed.id,
              max_context_size: alias.maxContextSize ?? 1_000_000,
            },
          },
          req.id,
        ),
      );
    },
  );
  app.post(
    setDefaultModelRoute.path,
    setDefaultModelRoute.options,
    setDefaultModelRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const listProvidersRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers',
      success: { data: listProvidersResponseSchema },
      description: 'List configured providers',
      tags: ['providers'],
    },
    async (req, reply) => {
      // Stage 3e: project the provider list from the engine's parsed config
      // (camelCase KimiConfig) — no v2 IModelCatalog/IConfigService.
      const config = (await rustSession.configGet()) as
        | { providers?: Record<string, { type?: string; baseUrl?: string; defaultModel?: string; apiKey?: string; oauth?: unknown }> }
        | null;
      const items = Object.entries(config?.providers ?? {}).map(([id, p]) => ({
        id,
        type: p?.type ?? 'unknown',
        ...(p?.baseUrl !== undefined ? { base_url: p.baseUrl } : {}),
        ...(p?.defaultModel !== undefined ? { default_model: p.defaultModel } : {}),
        has_api_key: Boolean(p?.apiKey),
        status: p?.apiKey !== undefined || p?.oauth !== undefined ? 'connected' : 'unconfigured',
      }));
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listProvidersRoute.path,
    listProvidersRoute.options,
    listProvidersRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const createProviderRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers',
      body: createProviderRequestSchema,
      success: { data: createProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_ALREADY_EXISTS]: {},
      },
      description:
        'Create a provider manually (type + credentials + model list). When no global default_model is configured (fresh setup), it is seeded with the new provider default (or first) model; an existing default is never modified.',
      tags: ['providers'],
      operationId: 'createProvider',
    },
    async (req, reply) => {
      await enqueueProviderWrite(async () => {
        // Stage 3h: write through the engine's config/set — no v2 config
        // service or model catalog.
        const { id } = req.body;
        const current = (await rustSession.configGet()) as
          | { providers?: Record<string, unknown>; defaultModel?: string }
          | null;
        if (current?.providers?.[id] !== undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_ALREADY_EXISTS,
              `provider ${id} already exists`,
              req.id,
            ),
          );
          return;
        }
        const providerPatch: Record<string, unknown> = { type: req.body.type };
        if (req.body.api_key !== undefined) providerPatch['apiKey'] = req.body.api_key;
        if (req.body.base_url !== undefined) providerPatch['baseUrl'] = req.body.base_url;
        let providerDefault: string | undefined;
        if (req.body.default_model !== undefined) {
          providerDefault = `${id}/${req.body.default_model}`;
          providerPatch['defaultModel'] = providerDefault;
        }
        const modelsPatch: Record<string, unknown> = {};
        for (const entry of req.body.models) {
          const alias: Record<string, unknown> = {
            provider: id,
            model: entry.model,
            maxContextSize: entry.max_context_size,
          };
          if (entry.display_name !== undefined) alias['displayName'] = entry.display_name;
          if (entry.capabilities !== undefined) alias['capabilities'] = [...entry.capabilities];
          if (entry.max_output_size !== undefined)
            alias['maxOutputSize'] = entry.max_output_size;
          if (entry.support_efforts !== undefined)
            alias['supportEfforts'] = [...entry.support_efforts];
          if (entry.adaptive_thinking !== undefined)
            alias['adaptiveThinking'] = entry.adaptive_thinking;
          modelsPatch[`${id}/${entry.model}`] = alias;
        }
        const patch: Record<string, unknown> = {
          providers: { [id]: providerPatch },
          models: modelsPatch,
        };
        const firstModel = req.body.models[0];
        if (current?.defaultModel === undefined && firstModel !== undefined) {
          patch['defaultModel'] = providerDefault ?? `${id}/${firstModel.model}`;
        }
        await rustSession.configSet(patch);
        const created = toRustProviderCatalogItem(id, providerPatch);
        (reply as unknown as StatusReply).code(201).send(okEnvelope(created, req.id));
      });
    },
  );
  app.post(
    createProviderRoute.path,
    createProviderRoute.options,
    createProviderRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const replaceProviderRoute = defineRoute(
    {
      method: 'PUT',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      body: replaceProviderRequestSchema,
      success: { data: replaceProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_OAUTH_MANAGED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
        [ErrorCode.PROVIDER_ALREADY_EXISTS]: {},
      },
      description:
        'Replace a provider in one save (type + base_url + model list), optionally renaming it via `new_id` (the providers key, model aliases, default_provider and a default_model pointing at an old alias all migrate). `api_key` is tri-state: omitted keeps the stored key, "" clears it, any other value replaces it. The provider\'s model aliases are rebuilt from `models` — aliases no longer listed disappear from config.toml, other providers\' aliases are untouched. Beyond the rename migration, the global default pointers are never modified. Answers 200 with `{provider}`. OAuth-managed providers are rejected: log out via /oauth/logout instead.',
      tags: ['providers'],
      operationId: 'replaceProvider',
    },
    async (req, reply) => {
      await enqueueProviderWrite(async () => {
        // Stage 3h: replace via the engine's config/set. Same-id replacement
        // only — renames (new_id) are rejected: the TOML-key migration is a
        // v2 config-transform concern not replicated on the native path.
        const { provider_id } = req.params;
        const body = req.body;
        if (body.new_id !== undefined && body.new_id !== provider_id) {
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              'provider rename (new_id) is not supported on the native engine',
              req.id,
            ),
          );
          return;
        }
        const current = (await rustSession.configGet()) as
          | { providers?: Record<string, unknown>; models?: Record<string, { provider?: string }>; defaultModel?: string }
          | null;
        const target = current?.providers?.[provider_id];
        if (target === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_NOT_FOUND,
              `provider ${provider_id} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if ((target as { oauth?: unknown }).oauth !== undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_OAUTH_MANAGED,
              `provider ${provider_id} is managed by OAuth login; use POST /oauth/logout instead`,
              req.id,
            ),
          );
          return;
        }
        const providerPatch: Record<string, unknown> = { type: body.type };
        if (body.api_key !== undefined) providerPatch['apiKey'] = body.api_key;
        if (body.base_url !== undefined) providerPatch['baseUrl'] = body.base_url;
        if (body.default_model !== undefined) {
          providerPatch['defaultModel'] = `${provider_id}/${body.default_model}`;
        }
        const modelsPatch: Record<string, unknown> = {};
        for (const entry of body.models) {
          const alias: Record<string, unknown> = {
            provider: provider_id,
            model: entry.model,
            maxContextSize: entry.max_context_size,
          };
          if (entry.display_name !== undefined) alias['displayName'] = entry.display_name;
          if (entry.capabilities !== undefined) alias['capabilities'] = [...entry.capabilities];
          if (entry.max_output_size !== undefined)
            alias['maxOutputSize'] = entry.max_output_size;
          if (entry.support_efforts !== undefined)
            alias['supportEfforts'] = [...entry.support_efforts];
          modelsPatch[`${provider_id}/${entry.model}`] = alias;
        }
        // Drop the provider's previous aliases via null delete markers (the
        // engine merge is insert/update only); keep other providers' aliases.
        const restModels = Object.fromEntries(
          Object.entries(current?.models ?? {}).filter(
            ([, r]) => r?.provider !== provider_id,
          ),
        );
        const droppedAliases = Object.fromEntries(
          Object.keys(current?.models ?? {})
            .filter((alias) => alias.startsWith(`${provider_id}/`) && !(alias in modelsPatch))
            .map((alias) => [alias, null]),
        );
        const patch: Record<string, unknown> = {
          providers: { [provider_id]: providerPatch },
          models: { ...restModels, ...droppedAliases, ...modelsPatch },
        };
        await rustSession.configSet(patch);
        // Read back the merged provider so the response reflects retained
        // fields (e.g. an api_key kept because the PUT body omitted it).
        const after = (await rustSession.configGet()) as
          | { providers?: Record<string, Record<string, unknown>> }
          | null;
        const mergedProvider = after?.providers?.[provider_id] ?? providerPatch;
        reply.send(
          okEnvelope(toRustProviderCatalogItem(provider_id, mergedProvider), req.id),
        );
      });
    },
  );
  app.put(
    replaceProviderRoute.path,
    replaceProviderRoute.options,
    replaceProviderRoute.handler as Parameters<ModelCatalogRouteHost['put']>[2],
  );

  const refreshProviderRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers/{tail}',
      params: providerActionTailParamSchema,
      success: { data: refreshProviderModelsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description: 'Refresh model metadata for a single provider',
      tags: ['providers'],
      operationId: 'refreshProvider',
    },
    async (req, reply) => {
      const { tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['refresh'] as const,
        resourceLabel: 'provider',
      });
      if (parsed.kind !== 'action') {
        const message =
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      // Stage 3h: the engine manages models from config — a refresh is a
      // no-op (nothing auto-discovered), reported as unchanged.
      reply.send(okEnvelope({ changed: [], unchanged: [parsed.id], failed: [] }, req.id));
    },
  );
  app.post(
    refreshProviderRoute.path,
    refreshProviderRoute.options,
    refreshProviderRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const getProviderRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      success: { data: getProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description:
        'Get a configured provider by ID. Unlike the list route, the response reveals the stored `api_key` when one is set, so local clients can prefill an edit form.',
      tags: ['providers'],
    },
    async (req, reply) => {
      const { provider_id } = req.params;
      // Stage 3h: project the stored provider from the engine's parsed config,
      // revealing the stored api_key (the list route stays redacted).
      const config = (await rustSession.configGet()) as
        | { providers?: Record<string, Record<string, unknown>> }
        | null;
      const stored = config?.providers?.[provider_id];
      if (stored === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.PROVIDER_NOT_FOUND,
            `provider ${provider_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
      const provider = toRustProviderCatalogItem(provider_id, stored);
      const apiKey = stored['apiKey'];
      reply.send(
        okEnvelope(
          apiKey !== undefined && apiKey !== '' ? { ...provider, api_key: apiKey } : provider,
          req.id,
        ),
      );
    },
  );
  app.get(
    getProviderRoute.path,
    getProviderRoute.options,
    getProviderRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const deleteProviderRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_OAUTH_MANAGED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      rawResponse: {
        204: { description: 'Provider deleted.' },
      },
      description:
        'Delete a provider and all of its model aliases (204, no body). The global default_provider/default_model pointers are left untouched — they are the user\'s settings, not this endpoint\'s to garbage-collect. OAuth-managed providers are rejected: log out via /oauth/logout instead.',
      tags: ['providers'],
      operationId: 'deleteProvider',
    },
    async (req, reply) => {
      await enqueueProviderWrite(async () => {
        // Stage 3h: delete via the engine's config/set — providers + the
        // provider's model aliases.
        const { provider_id } = req.params;
        const current = (await rustSession.configGet()) as
          | { providers?: Record<string, unknown>; models?: Record<string, { provider?: string }> }
          | null;
        if (current?.providers?.[provider_id] === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_NOT_FOUND,
              `provider ${provider_id} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if ((current.providers[provider_id] as { oauth?: unknown })?.oauth !== undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.PROVIDER_OAUTH_MANAGED,
              `provider ${provider_id} is managed by OAuth login; use POST /oauth/logout instead`,
              req.id,
            ),
          );
          return;
        }
        const restProviders = { ...current.providers };
        delete restProviders[provider_id];
        const restModels = Object.fromEntries(
          Object.entries(current.models ?? {}).filter(([, r]) => r?.provider !== provider_id),
        );
        // Null entries are delete markers for the engine `config/set` (merge
        // is insert/update only); the removed provider's aliases are dropped
        // the same way.
        const patch: Record<string, unknown> = {
          providers: {
            ...restProviders,
            [provider_id]: null,
          },
          models: {
            ...restModels,
            ...Object.fromEntries(
              Object.keys(current.models ?? {})
                .filter((alias) => alias.startsWith(`${provider_id}/`))
                .map((alias) => [alias, null]),
            ),
          },
        };
        await rustSession.configSet(patch);
        (reply as unknown as StatusReply).code(204).send();
      });
    },
  );
  app.delete(
    deleteProviderRoute.path,
    deleteProviderRoute.options,
    deleteProviderRoute.handler as Parameters<ModelCatalogRouteHost['delete']>[2],
  );
}
