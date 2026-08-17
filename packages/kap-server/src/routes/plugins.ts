/**
 * `/plugins` REST routes — plugin management and the marketplace catalog.
 *
 *   GET  /plugins                                  data: {plugins: PluginSummary[]}
 *   GET  /plugins/marketplace                      data: {entries: MarketplaceEntry[]}
 *   POST /plugins                 body {source}    data: PluginSummary
 *   POST /plugins/{plugin_id}:enable|:disable|:remove
 *
 * Thin projection of the App-scope `IPluginService` (install/remove/enable
 * are serialized there and fire `onDidReload`, which converges session skill
 * catalogs and the capability shelf-install hook). The marketplace catalog is
 * read on demand from the configured location (`pluginMarketplaceUrl` server
 * option, env `KIMI_CODE_PLUGIN_MARKETPLACE_URL`, default the production
 * catalog) through the shared `app/plugin/marketplace` client — catalog
 * reading, the lenient entry normalization, source resolution, and version
 * derivation all live there (one implementation, consumed by the CLI too).
 * When the location is the built-in default, a failed read falls back to the
 * source checkout's own catalog (offline dev); an explicitly configured
 * catalog fails hard. The route merges the entries with the live install
 * state — install status is always detected from the local records, never
 * from the catalog — and marks capability wiring rows with `capabilityId` so
 * clients route them through `/capabilities/{id}:install`.
 *
 * **Action suffix**: `:enable` / `:disable` / `:remove` via `parseActionSuffix`
 * (bare ids rejected).
 *
 * **Error mapping**:
 *   - unknown plugin id            → `40419 plugin.not_found` (from the domain code)
 *   - bad install source / path    → `40001 validation.failed` / `40409 fs.path_not_found`
 *   - malformed `{tail}` / body    → `40001 validation.failed`
 *   - catalog unreachable/invalid  → `50001` with a plain-language message
 *   - other errors                 → `50001` via the global error handler
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  computeUpdateStatus,
  ErrorCodes as DomainErrorCodes,
  ICapabilityService,
  IPluginService,
  PluginErrors,
  isError2,
  parsePluginMarketplace,
  readPluginMarketplace,
  withLatestVersions,
  type MarketplaceLocation,
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
  pluginMarketplaceResponseSchema,
  pluginIdParamSchema,
  pluginSummarySchema,
  type PluginMarketplaceEntryWire,
} from '../protocol/rest-plugin';
import { parseActionSuffix } from './action-suffix';

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

const PLUGIN_ACTIONS = ['enable', 'disable', 'remove'] as const;

/**
 * Capability wiring plugin id → capability id, applied only to the DEFAULT
 * catalog (a custom catalog may legitimately carry a same-id fork — the CLI
 * likewise injects built-in rows only for the default catalog). The closed
 * id set belongs to the client/engine contract (mirrored by the klient
 * schema; the CLI names it inline). Marking these rows lets clients route
 * them through `/capabilities/{id}:install` — a plain `POST /plugins`
 * installs only the wiring layer, never the binary runtime.
 */
const CAPABILITY_ROW_IDS: Readonly<
  Record<string, { capabilityId: string; wiringPluginIds: readonly string[] }>
> = {
  // kimi-cu's wiring plugin id is platform-specific ('kimi-cu-win' on
  // Windows x64); the catalog row joins install state through either id.
  'kimi-cu': { capabilityId: 'kimi-cu', wiringPluginIds: ['kimi-cu', 'kimi-cu-win'] },
  'kimi-cu-win': { capabilityId: 'kimi-cu', wiringPluginIds: ['kimi-cu', 'kimi-cu-win'] },
  'kimi-webbridge': { capabilityId: 'kimi-webbridge', wiringPluginIds: ['kimi-webbridge'] },
};

/**
 * Wiring plugin ids in this platform's preference order — the canonical one
 * first ('kimi-cu-win' on Windows x64), so a stale same-id record never
 * shadows the capability's actual wiring plugin.
 */
function orderedWiringPluginIds(ids: readonly string[]): readonly string[] {
  if (process.platform === 'win32' && process.arch === 'x64' && ids.includes('kimi-cu-win')) {
    return ['kimi-cu-win', ...ids.filter((id) => id !== 'kimi-cu-win')];
  }
  return ids;
}

const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(...args: Parameters<typeof fetch>): Promise<Response> {
  const [input, init] = args;
  return fetch(input, { ...init, signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS) });
}

/**
 * The repo checkout's own catalog — the fallback when the default location
 * is unreachable (offline / source-checkout dev). Absent in bundled
 * installs, where the fallback simply never fires.
 */
async function getSourceCheckoutLocation(): Promise<MarketplaceLocation | undefined> {
  const candidate = resolve(import.meta.dirname, '../../../../plugins/marketplace.json');
  const info = await stat(candidate).catch(() => undefined);
  if (info?.isFile() !== true) return undefined;
  return { raw: candidate, kind: 'local', resolved: candidate };
}

export interface PluginsRouteOptions {
  /** Resolved catalog URL (server option / env already applied by start.ts). */
  readonly marketplaceUrl: string;
  /**
   * True when the catalog location is the built-in default (neither the
   * server option nor the env var set) — only then does a failed remote read
   * fall back to the source-checkout catalog and get capability markers
   * (an explicitly configured catalog fails hard and stays unmarked).
   */
  readonly marketplaceIsDefault?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export function registerPluginsRoutes(
  app: PluginsRouteHost,
  core: Scope,
  opts: PluginsRouteOptions,
): void {
  // GET /plugins/marketplace — registered BEFORE /plugins/{tail} so the
  // literal segment wins over the param route.
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
      const fetchImpl = opts.fetchImpl ?? fetchWithTimeout;
      let read: { raw: string; location: MarketplaceLocation };
      try {
        read = await readPluginMarketplace({
          source: opts.marketplaceUrl,
          workDir: process.cwd(),
          fetchImpl,
          sourceCheckoutLocation:
            opts.marketplaceIsDefault === true ? getSourceCheckoutLocation : undefined,
        });
      } catch (error) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            `Plugin marketplace is unreachable: ${error instanceof Error ? error.message : String(error)}`,
            req.id,
          ),
        );
        return;
      }
      let marketplace: PluginMarketplace;
      try {
        marketplace = parsePluginMarketplace(read.raw, read.location);
      } catch (error) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            `Plugin marketplace returned an invalid catalog: ${error instanceof Error ? error.message : String(error)}`,
            req.id,
          ),
        );
        return;
      }
      // The default catalog is completed with the built-in capability rows
      // it does not carry itself (e.g. kimi-cu) — the CLI injects the same
      // rows client-side. Injected before the projection below so they get
      // the same install-state join and capabilityId marker; the
      // `capability:<id>` source is a sentinel, never a plain-plugin source.
      if (opts.marketplaceIsDefault === true) {
        const presentIds = new Set(marketplace.plugins.map((entry) => entry.id));
        const missing = core.accessor
          .get(ICapabilityService)
          .describeCapabilities()
          .filter((descriptor) => descriptor.supported && !presentIds.has(descriptor.id))
          .map((descriptor) => ({
            id: descriptor.id,
            tier: 'official' as const,
            displayName: descriptor.displayName,
            description: descriptor.description,
            source: `capability:${descriptor.id}`,
          }));
        if (missing.length > 0) {
          marketplace = { ...marketplace, plugins: [...marketplace.plugins, ...missing] };
        }
      }
      marketplace = await withLatestVersions(marketplace, fetchImpl);
      const installed = await core.accessor.get(IPluginService).listPlugins();
      const byId = new Map(installed.map((p) => [p.id, p]));
      // Capability rows unsupported on this host are hidden entirely (the CLI
      // does the same for its built-in rows) — never marked, never offered.
      const supportedCapabilityIds = new Set<string>(
        core.accessor
          .get(ICapabilityService)
          .describeCapabilities()
          .filter((descriptor) => descriptor.supported)
          .map((descriptor) => descriptor.id),
      );
      const entries: PluginMarketplaceEntryWire[] = [];
      for (const entry of marketplace.plugins) {
        const capabilityRow =
          opts.marketplaceIsDefault === true ? CAPABILITY_ROW_IDS[entry.id] : undefined;
        if (
          capabilityRow !== undefined &&
          !supportedCapabilityIds.has(capabilityRow.capabilityId)
        ) {
          continue;
        }

        // Capability rows join through the wiring plugin ids (platform order)
        // BEFORE the bare catalog id — a stale same-id record must not win.
        const record =
          capabilityRow !== undefined
            ? (orderedWiringPluginIds(capabilityRow.wiringPluginIds)
                .map((id) => byId.get(id))
                .find((candidate) => candidate !== undefined) ?? byId.get(entry.id))
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
          tier: entry.tier ?? 'third-party',
          displayName: entry.displayName,
          description: entry.description,
          homepage: entry.homepage,
          keywords: entry.keywords === undefined ? undefined : [...entry.keywords],
          version: entry.version,
          source: entry.source,
          installed: installedInfo,
          updateAvailable: updateAvailable ? true : undefined,
          capabilityId: capabilityRow?.capabilityId,
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

  // GET /plugins ------------------------------------------------------------
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

  // POST /plugins {source} --------------------------------------------------
  const installRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins',
      body: installPluginRequestSchema,
      success: { data: pluginSummarySchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
      },
      description: 'Install a plugin from a local path, zip URL, or GitHub repo',
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

  // POST /plugins/{plugin_id}:{enable|disable|remove} ------------------------
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
      const parsed = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: PLUGIN_ACTIONS,
        resourceLabel: 'plugin',
      });
      if (parsed.kind !== 'action') {
        const message =
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${req.params.tail}`;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      const plugins = core.accessor.get(IPluginService);
      try {
        switch (parsed.action) {
          case 'enable':
            await plugins.setPluginEnabled({ id: parsed.id, enabled: true });
            break;
          case 'disable':
            await plugins.setPluginEnabled({ id: parsed.id, enabled: false });
            break;
          case 'remove':
            await plugins.removePlugin({ id: parsed.id });
            break;
        }
        reply.send(okEnvelope({ ok: true as const }, req.id));
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
  // Client-fixable input mistakes (relative source, missing local path, an
  // unloadable manifest at a valid location) keep their 4xx semantics
  // instead of collapsing into a 50001.
  [PluginErrors.codes.PLUGIN_LOAD_FAILED]: ErrorCode.VALIDATION_FAILED,
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
