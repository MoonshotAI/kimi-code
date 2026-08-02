/**
 * `/mcp/config/servers` REST route handlers — user-level `mcp.json` management.
 *
 * The wire contract is the snake_case rendering of `McpServerConfig`; the
 * route converts between the wire form and the camelCase JSON persisted in
 * `<kimi-home>/mcp.json` (`{ "mcpServers": { name: McpServerConfig } }`),
 * the same file `workspaceMcpConfig` watches and reloads on change—so a
 * successful write is picked up by every workspace automatically, with no
 * explicit reload notification needed.
 *
 *   GET    /mcp/config/servers                data: { servers: Record<name, WireMcpServerConfig> }
 *   POST   /mcp/config/servers/{name}         body: WireMcpServerConfig  → upsert (returns updated full map)
 *   DELETE /mcp/config/servers/{name}         → remove (returns empty data)
 *
 * **Scope**: only the user-level `<kimi-home>/mcp.json` is editable here.
 * Project-level `.mcp.json` and `.kimi-code/mcp.json` ship with the checkout
 * and are read-only from this surface. The MCP server `name` is constrained
 * to `/^[a-zA-Z0-9_-]+$/` so it cannot escape the flat-file layout.
 *
 * **Path design**: this surface is intentionally distinct from the existing
 * runtime `GET /mcp/servers` (in `routes/tools.ts`) which returns live
 * `McpServer[]` status (connected/connecting/error). That endpoint reads
 * runtime state; this one reads/writes the config file. They share the
 * `/mcp` prefix but diverge at `/config` to make the distinction explicit.
 *
 * **Filesystem**: every read/write goes through `IHostFileSystem` (the same
 * primitive `workspaceMcpConfig` reads through). `os.fs.not_found` on GET is
 * treated as "no user-level MCP servers yet" (returns `{ servers: {} }`);
 * the same code on DELETE maps to `40408 mcp.not_found` so callers can
 * distinguish "nothing to delete" from "delete succeeded". Write failures
 * map to `50003 persistence.failure`.
 *
 * **Anti-corruption**: route resolves every service via the accessor; no SDK
 * imports. The on-disk schema (`McpServerConfigSchema`) is imported only as
 * a Zod validator, never as a value type carrying domain semantics.
 */

import { join } from 'node:path';

import {
  ErrorCodes,
  IBootstrapService,
  IHostFileSystem,
  isError2,
  McpServerConfigSchema,
  type McpServerConfig,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  listMcpServersResponseSchema,
  mcpServerNameParamSchema,
  upsertMcpServerRequestSchema,
  type WireListMcpServersResponse,
  type WireMcpServerConfig,
} from '../protocol/rest-mcp';

interface McpRouteHost {
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
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const McpJsonFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
});

interface UserMcpJson {
  readonly mcpServers: Record<string, McpServerConfig>;
}

export function registerMcpRoutes(app: McpRouteHost, core: Scope): void {
  const hostFs = core.accessor.get(IHostFileSystem);
  const bootstrap = core.accessor.get(IBootstrapService);
  const userMcpJsonPath = join(bootstrap.homeDir, 'mcp.json');

  // GET /mcp/config/servers -------------------------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/config/servers',
      success: { data: listMcpServersResponseSchema },
      description: 'List MCP servers configured at the user level (<kimi-home>/mcp.json)',
      tags: ['mcp'],
      operationId: 'listMcpServers',
    },
    async (req, reply) => {
      const servers = await readUserMcpServers(hostFs, userMcpJsonPath, req.id, reply);
      if (servers === undefined) return; // error already sent
      const wire: WireListMcpServersResponse = {
        servers: Object.fromEntries(
          Object.entries(servers).map(([name, cfg]) => [name, mcpConfigToWire(cfg)]),
        ),
      };
      reply.send(okEnvelope(wire, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<McpRouteHost['get']>[2],
  );

  // POST /mcp/config/servers/{name} ----------------------------------------
  const upsertRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/config/servers/{name}',
      body: upsertMcpServerRequestSchema,
      params: mcpServerNameParamSchema,
      success: { data: listMcpServersResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PERSISTENCE_FAILURE]: {},
      },
      description: 'Create or update a user-level MCP server entry (upsert)',
      tags: ['mcp'],
      operationId: 'upsertMcpServer',
    },
    async (req, reply) => {
      const { name } = req.params;
      const wireConfig = req.body as WireMcpServerConfig;
      const camelConfig = mcpConfigFromWire(wireConfig);

      // Re-validate the converted camelCase form through the on-disk schema
      // so the persisted shape is always a valid `McpServerConfig`.
      const parsed = McpServerConfigSchema.safeParse(camelConfig);
      if (!parsed.success) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `invalid MCP server config: ${parsed.error.message}`,
            req.id,
          ),
        );
        return;
      }

      const existing = await readUserMcpServers(hostFs, userMcpJsonPath, req.id, reply);
      if (existing === undefined) return;
      const updated: Record<string, McpServerConfig> = { ...existing, [name]: parsed.data };
      const ok = await writeUserMcpServers(hostFs, userMcpJsonPath, updated, req.id, reply);
      if (!ok) return;
      requestLog(req)?.info({ name }, 'mcp server upserted');

      const wire: WireListMcpServersResponse = {
        servers: Object.fromEntries(
          Object.entries(updated).map(([n, cfg]) => [n, mcpConfigToWire(cfg)]),
        ),
      };
      reply.send(okEnvelope(wire, req.id));
    },
  );
  app.post(
    upsertRoute.path,
    upsertRoute.options,
    upsertRoute.handler as Parameters<McpRouteHost['post']>[2],
  );

  // DELETE /mcp/config/servers/{name} --------------------------------------
  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/mcp/config/servers/{name}',
      params: mcpServerNameParamSchema,
      success: { data: z.object({}).optional() },
      errors: {
        [ErrorCode.MCP_SERVER_NOT_FOUND]: {},
        [ErrorCode.PERSISTENCE_FAILURE]: {},
      },
      description: 'Remove a user-level MCP server entry',
      tags: ['mcp'],
      operationId: 'deleteMcpServer',
    },
    async (req, reply) => {
      const { name } = req.params;
      const existing = await readUserMcpServers(hostFs, userMcpJsonPath, req.id, reply);
      if (existing === undefined) return;
      if (!(name in existing)) {
        reply.send(
          errEnvelope(
            ErrorCode.MCP_SERVER_NOT_FOUND,
            `mcp server ${name} does not exist`,
            req.id,
          ),
        );
        return;
      }
      const next: Record<string, McpServerConfig> = { ...existing };
      delete next[name];
      const ok = await writeUserMcpServers(hostFs, userMcpJsonPath, next, req.id, reply);
      if (!ok) return;
      requestLog(req)?.info({ name }, 'mcp server deleted');
      reply.send(okEnvelope({}, req.id));
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as Parameters<McpRouteHost['delete']>[2],
  );
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Read the user-level `mcp.json` and return its `mcpServers` map. A missing
 * file is treated as an empty map (GET and POST both treat absence as "no
 * servers yet"). Other fs failures are mapped to wire errors and reported
 * via `reply.send`; the function returns `undefined` to signal "already
 * handled" so callers can early-return.
 */
async function readUserMcpServers(
  hostFs: IHostFileSystem,
  path: string,
  requestId: string,
  reply: { send(payload: unknown): unknown },
): Promise<Record<string, McpServerConfig> | undefined> {
  let text: string;
  try {
    text = await hostFs.readText(path);
  } catch (err) {
    if (isError2(err) && err.code === ErrorCodes.OS_FS_NOT_FOUND) {
      return {};
    }
    reply.send(
      errEnvelope(
        ErrorCode.PERSISTENCE_FAILURE,
        `failed to read ${path}: ${describeError(err)}`,
        requestId,
        err instanceof Error ? err.stack : undefined,
      ),
    );
    return undefined;
  }
  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    reply.send(
      errEnvelope(
        ErrorCode.PERSISTENCE_FAILURE,
        `invalid JSON in ${path}: ${describeError(err)}`,
        requestId,
        err instanceof Error ? err.stack : undefined,
      ),
    );
    return undefined;
  }

  try {
    const parsed = McpJsonFileSchema.parse(data) as UserMcpJson;
    return parsed.mcpServers;
  } catch (err) {
    reply.send(
      errEnvelope(
        ErrorCode.PERSISTENCE_FAILURE,
        `invalid MCP server config in ${path}: ${describeError(err)}`,
        requestId,
        err instanceof Error ? err.stack : undefined,
      ),
    );
    return undefined;
  }
}

/**
 * Atomically write the user-level `mcp.json` with the given servers map.
 * Returns `false` if the write failed and an error envelope was already sent.
 */
async function writeUserMcpServers(
  hostFs: IHostFileSystem,
  path: string,
  servers: Record<string, McpServerConfig>,
  requestId: string,
  reply: { send(payload: unknown): unknown },
): Promise<boolean> {
  const payload: UserMcpJson = { mcpServers: servers };
  try {
    await hostFs.writeText(path, `${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch (err) {
    reply.send(
      errEnvelope(
        ErrorCode.PERSISTENCE_FAILURE,
        `failed to write ${path}: ${describeError(err)}`,
        requestId,
        err instanceof Error ? err.stack : undefined,
      ),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wire ↔ on-disk conversion (snake_case ↔ camelCase).
//
// The two schemas share the discriminated-union shape; only the leaf keys
// differ. The converters branch on `transport` so the type-narrowing is
// exhaustive without a runtime fallback.
// ---------------------------------------------------------------------------

function mcpConfigToWire(cfg: McpServerConfig): WireMcpServerConfig {
  const common = {
    enabled: cfg.enabled,
    startup_timeout_ms: cfg.startupTimeoutMs,
    tool_timeout_ms: cfg.toolTimeoutMs,
    enabled_tools: cfg.enabledTools,
    disabled_tools: cfg.disabledTools,
  };
  if (cfg.transport === 'stdio') {
    return stripUndefined({
      ...common,
      transport: 'stdio',
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
      cwd: cfg.cwd,
      executor: cfg.executor,
    }) as WireMcpServerConfig;
  }
  // http | sse share the same remote fields
  return stripUndefined({
    ...common,
    transport: cfg.transport,
    url: cfg.url,
    headers: cfg.headers,
    bearer_token_env_var: cfg.bearerTokenEnvVar,
  }) as WireMcpServerConfig;
}

function mcpConfigFromWire(wire: WireMcpServerConfig): unknown {
  const common = {
    enabled: wire.enabled,
    startupTimeoutMs: wire.startup_timeout_ms,
    toolTimeoutMs: wire.tool_timeout_ms,
    enabledTools: wire.enabled_tools,
    disabledTools: wire.disabled_tools,
  };
  if (wire.transport === 'stdio') {
    return stripUndefined({
      ...common,
      transport: 'stdio' as const,
      command: wire.command,
      args: wire.args,
      env: wire.env,
      cwd: wire.cwd,
      executor: wire.executor,
    });
  }
  return stripUndefined({
    ...common,
    transport: wire.transport,
    url: wire.url,
    headers: wire.headers,
    bearerTokenEnvVar: wire.bearer_token_env_var,
  });
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
