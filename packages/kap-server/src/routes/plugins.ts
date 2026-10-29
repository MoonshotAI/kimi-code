import {
  computeUpdateStatus,
  ErrorCodes as DomainErrorCodes,
  ICapabilityService,
  IPluginMarketplaceService,
  IPluginService,
  PluginErrors,
  isError2,
  type PluginMarketplace,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  installPluginRequestSchema,
  listPluginsResponseSchema,
  pluginCapabilitiesSchema,
  pluginInfoSchema,
  pluginMarketplaceResponseSchema,
  pluginIdParamSchema,
  pluginInfoQuerySchema,
  pluginSummarySchema,
  previewPluginRequestSchema,
  type PluginMarketplaceEntryWire,
} from '../protocol/rest-plugin';
import { type ActionTable, dispatchAction } from './action-dispatch';

interface PluginsRouteHost {
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
}

const pluginActions: ActionTable<'enable' | 'disable' | 'remove', PluginActionExtra> = {
  enable: { handle: enablePluginAction },
  disable: { handle: disablePluginAction },
  remove: { handle: removePluginAction },
};

type PluginActionExtra = {
  readonly plugins: IPluginService;
};

type PluginActionCtx = PluginActionExtra & { readonly id: string; readonly body: unknown };

async function enablePluginAction(ctx: PluginActionCtx): Promise<void> {
  await ctx.plugins.setPluginEnabled({ id: ctx.id, enabled: true });
}

async function disablePluginAction(ctx: PluginActionCtx): Promise<void> {
  await ctx.plugins.setPluginEnabled({ id: ctx.id, enabled: false });
}

async function removePluginAction(ctx: PluginActionCtx): Promise<void> {
  await ctx.plugins.removePlugin({ id: ctx.id });
}

const CAPABILITY_ROW_IDS: Readonly<Record<string, string>> = {
  'kimi-cu': 'kimi-cu',
  'kimi-cu-win': 'kimi-cu',
  'kimi-browser-extension': 'kimi-webbridge',
};

export interface PluginsRouteOptions {
  readonly marketplaceIsDefault?: boolean;
}

export function registerPluginsRoutes(
  app: PluginsRouteHost,
  core: Scope,
  opts: PluginsRouteOptions,
): void {
  const marketplaceRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins/marketplace',
      success: { data: pluginMarketplaceResponseSchema },
      errors: {},
      description: 'List the plugin marketplace catalog merged with live install state',
      tags: ['plugins'],
      operationId: 'listPluginMarketplace',
    },
    async (req, reply) => {
      let marketplace: PluginMarketplace;
      try {
        marketplace = await core.accessor.get(IPluginMarketplaceService).listMarketplace();
      } catch (error) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            `Plugin marketplace is unavailable: ${error instanceof Error ? error.message : String(error)}`,
            req.id,
          ),
        );
        return;
      }
      const installed = await core.accessor.get(IPluginService).listPlugins();
      const byId = new Map(installed.map((p) => [p.id, p]));
      const capabilities = core.accessor.get(ICapabilityService).describeCapabilities();
      const entries: PluginMarketplaceEntryWire[] = [];
      for (const entry of marketplace.plugins) {
        if (entry.id === 'kimi-webbridge') continue;
        const supportsLocal =
          entry.platforms?.some((platform) => platform === process.platform) === true;
        const cloudOnly = entry.platforms?.every((platform) => platform === 'cloud') === true;
        if (entry.platforms !== undefined && !supportsLocal && !cloudOnly) continue;
        const capabilityId =
          opts.marketplaceIsDefault === true ? CAPABILITY_ROW_IDS[entry.id] : undefined;
        const capability = capabilities.find(
          (descriptor) =>
            descriptor.supported &&
            descriptor.id === capabilityId &&
            descriptor.pluginId === entry.id,
        );
        if (capabilityId !== undefined && capability === undefined) continue;

        const record =
          capability?.id === 'kimi-webbridge'
            ? (byId.get(entry.id) ?? byId.get('kimi-webbridge'))
            : byId.get(entry.id);
        const installedInfo =
          record === undefined
            ? undefined
            : { enabled: record.enabled, version: record.version };
        const updateAvailable =
          computeUpdateStatus(entry.version, record?.version, record !== undefined).kind ===
          'update';
        entries.push({
          id: entry.id,
          classification: entry.classification ?? (entry.tier === 'official' ? 'official' : 'third_party'),
          tier: entry.tier ?? 'third-party',
          displayName: entry.displayName,
          description: entry.description,
          homepage: entry.homepage,
          keywords: entry.keywords === undefined ? undefined : [...entry.keywords],
          version: entry.version,
          source: entry.source,
          iconUrl: entry.iconUrl,
          sha256sum: entry.sha256sum,
          filename: entry.filename,
          cliDescription: entry.cliDescription,
          locale: entry.locale,
          defaultLocale: entry.locale?.defaultLocale,
          platforms: entry.platforms === undefined ? undefined : [...entry.platforms],
          distribution: entry.distribution,
          billing: entry.billing,
          installed: installedInfo,
          updateAvailable: updateAvailable ? true : undefined,
          capabilityId: capability?.id,
        });
      }
      reply.send(okEnvelope({ entries }, req.id));
    },
  );
  app.get(
    marketplaceRoute.path,
    marketplaceRoute.options,
    marketplaceRoute.handler as Parameters<PluginsRouteHost['get']>[2],
  );

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins',
      success: { data: listPluginsResponseSchema },
      errors: {},
      description: 'List installed plugins',
      tags: ['plugins'],
      operationId: 'listPlugins',
    },
    async (req, reply) => {
      const plugins = await core.accessor.get(IPluginService).listPlugins();
      reply.send(okEnvelope({ plugins }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<PluginsRouteHost['get']>[2],
  );

  const infoRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins/{tail}',
      params: pluginIdParamSchema,
      querystring: pluginInfoQuerySchema,
      success: { data: pluginInfoSchema },
      errors: { [ErrorCode.PLUGIN_NOT_FOUND]: {} },
      description: 'Get an installed plugin and its declared capabilities',
      tags: ['plugins'],
      operationId: 'getPluginInfo',
    },
    async (req, reply) => {
      try {
        const info = await core.accessor.get(IPluginService).getPluginInfo({
          id: req.params.tail,
          locale: req.query.locale,
        });
        reply.send(okEnvelope(info, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.get(
    infoRoute.path,
    infoRoute.options,
    infoRoute.handler as Parameters<PluginsRouteHost['get']>[2],
  );

  const previewRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins/preview',
      body: previewPluginRequestSchema,
      success: { data: pluginCapabilitiesSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PLUGIN_NOT_FOUND]: {},
        [ErrorCode.PLUGIN_CATALOG_CHANGED]: {},
      },
      description: 'Inspect marketplace capabilities without installing the plugin',
      tags: ['plugins'],
      operationId: 'previewPlugin',
    },
    async (req, reply) => {
      try {
        const capabilities = await core.accessor.get(IPluginService).previewPlugin(req.body);
        reply.send(okEnvelope(capabilities, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.post(
    previewRoute.path,
    previewRoute.options,
    previewRoute.handler as Parameters<PluginsRouteHost['post']>[2],
  );

  const installRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins',
      body: installPluginRequestSchema,
      success: { data: pluginSummarySchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.PLUGIN_CATALOG_CHANGED]: {},
      },
      description: 'Install a custom plugin or a marketplace entry at an expected version',
      tags: ['plugins'],
      operationId: 'installPlugin',
    },
    async (req, reply) => {
      try {
        const plugin = await core.accessor.get(IPluginService).installPlugin(req.body);
        reply.send(okEnvelope(plugin, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.post(
    installRoute.path,
    installRoute.options,
    installRoute.handler as Parameters<PluginsRouteHost['post']>[2],
  );

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins/{tail}',
      params: pluginIdParamSchema,
      success: { data: z.object({ ok: z.literal(true) }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PLUGIN_NOT_FOUND]: {},
      },
      description: 'Enable, disable, or remove an installed plugin',
      tags: ['plugins'],
      operationId: 'pluginAction',
    },
    async (req, reply) => {
      const plugins = core.accessor.get(IPluginService);
      try {
        const handled = await dispatchAction({
          tail: req.params.tail,
          actions: pluginActions,
          resourceLabel: 'plugin',
          extra: { plugins },
          onUnsupported: (message) => {
            reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          },
        });
        if (handled) {
          reply.send(okEnvelope({ ok: true as const }, req.id));
        }
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.post(
    actionRoute.path,
    actionRoute.options,
    actionRoute.handler as Parameters<PluginsRouteHost['post']>[2],
  );
}

const PLUGIN_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  [PluginErrors.codes.PLUGIN_NOT_FOUND]: ErrorCode.PLUGIN_NOT_FOUND,
  [PluginErrors.codes.PLUGIN_LOAD_FAILED]: ErrorCode.VALIDATION_FAILED,
  [PluginErrors.codes.PLUGIN_CATALOG_CHANGED]: ErrorCode.PLUGIN_CATALOG_CHANGED,
  [DomainErrorCodes.VALIDATION_FAILED]: ErrorCode.VALIDATION_FAILED,
  [DomainErrorCodes.FS_PATH_NOT_FOUND]: ErrorCode.FS_PATH_NOT_FOUND,
};

function mapPluginError(error: unknown, requestId: string) {
  const mapped = isError2(error) ? PLUGIN_ERROR_MAP[error.code] : undefined;
  if (mapped !== undefined && isError2(error)) {
    return errEnvelope(mapped, error.message, requestId, error.stack);
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
    requestId,
    error instanceof Error ? error.stack : undefined,
  );
}
