import {
  computeUpdateStatus,
  ErrorCodes as DomainErrorCodes,
  IBootstrapService,
  ICapabilityService,
  IPluginMarketplaceService,
  IPluginService,
  PluginErrors,
  isError2,
  marketplaceEntryVisibleOnHost,
  pluginClientForIdentity,
  type PluginCapabilities,
  type PluginInfo,
  type PluginMarketplace,
  type PluginMarketplaceDistribution,
  type PluginMarketplaceLocale,
  type PluginMcpServerInfo,
  type PluginSkillInfo,
  type PluginSummary,
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
  type PluginCapabilitiesWire,
  type PluginInfoWire,
  type PluginMarketplaceEntryWire,
  type PluginMarketplaceLocalizedTextWire,
  type PluginMcpServerInfoWire,
  type PluginSkillInfoWire,
  type PluginSummaryWire,
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

function toPluginSummaryWire(summary: PluginSummary): PluginSummaryWire {
  return {
    id: summary.id,
    display_name: summary.displayName,
    description: summary.description,
    short_description: summary.shortDescription,
    long_description: summary.longDescription,
    version: summary.version,
    enabled: summary.enabled,
    state: summary.state,
    skill_count: summary.skillCount,
    mcp_server_count: summary.mcpServerCount,
    enabled_mcp_server_count: summary.enabledMcpServerCount,
    hook_count: summary.hookCount,
    command_count: summary.commandCount,
    has_errors: summary.hasErrors,
    source: summary.source,
    origin: summary.origin,
    catalog_id: summary.catalogId,
    installed_at: summary.installedAt,
    original_source: summary.originalSource,
    github:
      summary.github === undefined
        ? undefined
        : {
            owner: summary.github.owner,
            repo: summary.github.repo,
            ref: { kind: summary.github.ref.kind, value: summary.github.ref.value },
            installed_sha: summary.github.installedSha,
          },
  };
}

function toPluginSkillInfoWire(skill: PluginSkillInfo): PluginSkillInfoWire {
  return {
    name: skill.name,
    display_name: skill.displayName,
    description: skill.description,
  };
}

function toPluginMcpServerInfoWire(server: PluginMcpServerInfo): PluginMcpServerInfoWire {
  return {
    name: server.name,
    display_name: server.displayName,
    description: server.description,
    icon_url: server.iconUrl,
    runtime_name: server.runtimeName,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    args: server.args === undefined ? undefined : [...server.args],
    cwd: server.cwd,
    url: server.url,
    env_keys: server.envKeys === undefined ? undefined : [...server.envKeys],
    header_keys: server.headerKeys === undefined ? undefined : [...server.headerKeys],
  };
}

function toPluginCapabilitiesWire(capabilities: PluginCapabilities): PluginCapabilitiesWire {
  return {
    skills: capabilities.skills.map(toPluginSkillInfoWire),
    mcp_servers: capabilities.mcpServers.map(toPluginMcpServerInfoWire),
  };
}

function toPluginInfoWire(info: PluginInfo): PluginInfoWire {
  return {
    ...toPluginSummaryWire(info),
    root: info.root,
    updated_at: info.updatedAt,
    manifest_kind: info.manifestKind,
    manifest_path: info.manifestPath,
    skills: info.skills.map(toPluginSkillInfoWire),
    mcp_servers: info.mcpServers.map(toPluginMcpServerInfoWire),
    shadowed_manifest_path: info.shadowedManifestPath,
    diagnostics: info.diagnostics.map((d) => ({ severity: d.severity, message: d.message })),
  };
}

function toMarketplaceLocaleWire(
  locale: PluginMarketplaceLocale | undefined,
): Record<string, string | PluginMarketplaceLocalizedTextWire | undefined> | undefined {
  if (locale === undefined) return undefined;
  const out: Record<string, string | PluginMarketplaceLocalizedTextWire | undefined> = {};
  for (const [key, value] of Object.entries(locale)) {
    if (key === 'defaultLocale') {
      if (typeof value === 'string') out['default_locale'] = value;
      continue;
    }
    if (typeof value === 'string' || value === undefined) {
      out[key] = value;
      continue;
    }
    out[key] = {
      display_name: value.displayName,
      cli_description: value.cliDescription,
      long_description: value.longDescription,
      short_description: value.shortDescription,
    };
  }
  return out;
}

function toMarketplaceDistributionWire(
  dist: PluginMarketplaceDistribution | undefined,
): PluginMarketplaceEntryWire['distribution'] {
  if (dist === undefined) return undefined;
  return {
    category: dist.category,
    region: dist.region,
    default_install: dist.defaultInstall,
    weight: dist.weight,
    user_level: dist.userLevel,
  };
}

export function registerPluginsRoutes(
  app: PluginsRouteHost,
  core: Scope,
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
      const marketplaceIsDefault = await core.accessor.get(IPluginMarketplaceService).isDefaultMarketplace();
      const plugins = core.accessor.get(IPluginService);
      await plugins.reconcileAvailability(marketplace);
      const installed = await plugins.listPlugins();
      const byId = new Map(installed.map((p) => [p.id, p]));
      const byCatalogId = new Map(
        installed.filter((p) => p.catalogId !== undefined).map((p) => [p.catalogId, p]),
      );
      const capabilities = core.accessor.get(ICapabilityService).describeCapabilities();
      const bootstrap = core.accessor.get(IBootstrapService);
      const client = pluginClientForIdentity(bootstrap.clientIdentity.platform);
      const entries: PluginMarketplaceEntryWire[] = [];
      for (const entry of marketplace.plugins) {
        if (entry.id === 'kimi-webbridge') continue;
        if (!marketplaceEntryVisibleOnHost(entry, client, bootstrap.platform)) continue;
        const capabilityId =
          marketplaceIsDefault ? CAPABILITY_ROW_IDS[entry.id] : undefined;
        const capability = capabilities.find(
          (descriptor) =>
            descriptor.supported &&
            descriptor.id === capabilityId &&
            descriptor.pluginId === entry.id,
        );
        if (capabilityId !== undefined && capability === undefined) continue;

        const byIdRecord = byId.get(entry.id);
        const record =
          capability !== undefined
            ? capability.id === 'kimi-webbridge'
              ? (byIdRecord ?? byId.get('kimi-webbridge'))
              : byIdRecord
            : (byCatalogId.get(entry.id) ??
              (byIdRecord?.origin === 'unknown' ? byIdRecord : undefined));
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
          display_name: entry.displayName,
          description: entry.description,
          short_description: entry.shortDescription,
          long_description: entry.longDescription,
          homepage: entry.homepage,
          keywords: entry.keywords === undefined ? undefined : [...entry.keywords],
          version: entry.version,
          source: entry.source,
          icon_url: entry.iconUrl,
          sha256sum: entry.sha256sum,
          filename: entry.filename,
          cli_description: entry.cliDescription,
          locale: toMarketplaceLocaleWire(entry.locale),
          default_locale: entry.locale?.defaultLocale,
          platforms: entry.platforms === undefined ? undefined : [...entry.platforms],
          distribution: toMarketplaceDistributionWire(entry.distribution),
          billing: entry.billing,
          installed: installedInfo,
          update_available: updateAvailable ? true : undefined,
          capability_id: capability?.id,
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
      reply.send(okEnvelope({ plugins: plugins.map(toPluginSummaryWire) }, req.id));
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
        reply.send(okEnvelope(toPluginInfoWire(info), req.id));
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
        const capabilities = await core.accessor.get(IPluginService).previewPlugin({
          marketplaceId: req.body.marketplace_id,
          expectedVersion: req.body.expected_version,
          expectedSha256: req.body.expected_sha256,
          locale: req.body.locale,
        });
        reply.send(okEnvelope(toPluginCapabilitiesWire(capabilities), req.id));
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
        [ErrorCode.PLUGIN_NOT_FOUND]: {},
        [ErrorCode.PLUGIN_CATALOG_CHANGED]: {},
      },
      description: 'Install a custom plugin or a marketplace entry at an expected version',
      tags: ['plugins'],
      operationId: 'installPlugin',
    },
    async (req, reply) => {
      try {
        const input =
          'source' in req.body
            ? { source: req.body.source }
            : {
                marketplaceId: req.body.marketplace_id,
                expectedVersion: req.body.expected_version,
                expectedSha256: req.body.expected_sha256,
              };
        const plugin = await core.accessor.get(IPluginService).installPlugin(input);
        reply.send(okEnvelope(toPluginSummaryWire(plugin), req.id));
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
    return errEnvelope(mapped, error.message, requestId);
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
    requestId,
  );
}
