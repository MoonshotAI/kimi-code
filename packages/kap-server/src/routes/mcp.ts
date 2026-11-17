import type { ServerResponse } from 'node:http';

import {
  ErrorCodes,
  IMcpManagementService,
  isError2,
  type GlobalMcpServerConfig,
  type McpManagedServer,
  type McpServerAuthBeginResult,
  type McpServerAuthStatus,
  type McpServerInspection,
  type McpServerLocator,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { McpServerConfig } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import { MAX_MCP_TIMEOUT_MS, McpTimeoutMsSchema } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import type { McpServerConfigView } from '@moonshot-ai/agent-core-v2/mcpCore/configView';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { getRequestPrincipal } from '../middleware/auth';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface McpRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const stringRecordSchema = z.record(z.string(), z.string());
const serverNameSchema = z.string().min(1);

const serverNameParamSchema = z.object({ name: serverNameSchema });

const serverScopedQuerySchema = z.object({ cwd: z.string().min(1).optional() });

const authStatusesQuerySchema = z.object({
  cwd: z.string().min(1).optional(),
  verify: z.enum(['true', 'false']).optional(),
});

const mcpServerCommonWireFields = {
  enabled: z.boolean().optional(),
  deferred: z.boolean().optional(),
  startup_timeout_ms: McpTimeoutMsSchema.optional(),
  tool_timeout_ms: McpTimeoutMsSchema.optional(),
  enabled_tools: z.array(z.string()).optional(),
  disabled_tools: z.array(z.string()).optional(),
} as const;

const mcpServerStdioWireSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringRecordSchema.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  environment_id: z.string().min(1).optional(),
  ...mcpServerCommonWireFields,
});

const mcpServerHttpWireSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: stringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearer_token_env_var: z.string().min(1).optional(),
  ...mcpServerCommonWireFields,
});

const mcpServerSseWireSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: stringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearer_token_env_var: z.string().min(1).optional(),
  ...mcpServerCommonWireFields,
});

const globalMcpServerConfigSchema = z.discriminatedUnion('transport', [
  mcpServerStdioWireSchema.extend({ name: serverNameSchema }),
  mcpServerHttpWireSchema.extend({ name: serverNameSchema }),
  mcpServerSseWireSchema.extend({ name: serverNameSchema }),
]);

const mcpServerConfigBodySchema = z.discriminatedUnion('transport', [
  mcpServerStdioWireSchema,
  mcpServerHttpWireSchema,
  mcpServerSseWireSchema,
]);

const testServerBodySchema = z.object({
  name: serverNameSchema.optional(),
  server: globalMcpServerConfigSchema.optional(),
  cwd: z.string().min(1).optional(),
});

const mcpServerLocatorSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('global'), name: serverNameSchema }),
  z.object({
    source: z.literal('plugin'),
    plugin_id: z.string().min(1),
    server_name: z.string().min(1),
  }),
]);
type McpServerLocatorWire = z.infer<typeof mcpServerLocatorSchema>;

const inspectServersBodySchema = z.object({
  targets: z.array(mcpServerLocatorSchema).optional(),
  cwd: z.string().min(1).optional(),
});

const authCompleteBodySchema = z.object({
  flow_id: z.string().min(1),
  timeout_ms: z.number().int().min(1).max(MAX_MCP_TIMEOUT_MS).optional(),
});

const authCancelBodySchema = z.object({ flow_id: z.string().min(1) });

const mcpServerSourceSchema = z.enum(['global', 'plugin', 'caller']);

const mcpServerAuthStateSchema = z.enum([
  'not-applicable',
  'bearer-token',
  'oauth-required',
  'oauth-authorized',
  'oauth-expired',
  'unavailable',
]);

const mcpServerConfigDataSchema = z.union([
  mcpServerStdioWireSchema.extend({ env_keys: z.array(z.string()).optional() }),
  mcpServerHttpWireSchema.extend({ header_keys: z.array(z.string()).optional() }),
  mcpServerSseWireSchema.extend({ header_keys: z.array(z.string()).optional() }),
]);
type McpServerConfigDataWire = z.infer<typeof mcpServerConfigDataSchema>;

const mcpManagedServerSchema = z.object({
  name: z.string(),
  config: mcpServerConfigDataSchema,
  source: mcpServerSourceSchema,
  origin: z.string(),
  mutable: z.boolean(),
  plugin: z.object({ id: z.string(), name: z.string() }).optional(),
});
type McpManagedServerWire = z.infer<typeof mcpManagedServerSchema>;

const mcpServerTestResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
});

const mcpServerAuthStatusSchema = z.object({
  name: z.string(),
  auth_status: mcpServerAuthStateSchema,
});
type McpServerAuthStatusWire = z.infer<typeof mcpServerAuthStatusSchema>;

const mcpServerInspectionSchema = z.object({
  server_id: z.string(),
  locator: mcpServerLocatorSchema,
  runtime_name: z.string(),
  canonical_url: z.string().optional(),
  origin: mcpServerSourceSchema,
  config: mcpServerConfigDataSchema,
  enabled: z.boolean(),
  editable: z.boolean(),
  auth_status: mcpServerAuthStateSchema,
  checked_at: z.number().optional(),
  error: z.string().optional(),
});
type McpServerInspectionWire = z.infer<typeof mcpServerInspectionSchema>;

const mcpServerAuthBeginResultSchema = z.union([
  z.object({
    status: z.literal('authorization-required'),
    flow_id: z.string(),
    authorization_url: z.string(),
  }),
  z.object({ status: z.literal('already-authorized') }),
]);
type McpServerAuthBeginResultWire = z.infer<typeof mcpServerAuthBeginResultSchema>;

type McpServerConfigWire = z.infer<typeof mcpServerConfigBodySchema>;
type GlobalMcpServerConfigWire = z.infer<typeof globalMcpServerConfigSchema>;

function fromMcpServerConfigWire(wire: McpServerConfigWire): McpServerConfig {
  const common = {
    enabled: wire.enabled,
    deferred: wire.deferred,
    startupTimeoutMs: wire.startup_timeout_ms,
    toolTimeoutMs: wire.tool_timeout_ms,
    enabledTools: wire.enabled_tools,
    disabledTools: wire.disabled_tools,
  };
  if (wire.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: wire.command,
      args: wire.args,
      env: wire.env,
      cwd: wire.cwd,
      executor: wire.executor,
      environment_id: wire.environment_id,
      ...common,
    };
  }
  return {
    transport: wire.transport,
    url: wire.url,
    headers: wire.headers,
    auth: wire.auth,
    bearerTokenEnvVar: wire.bearer_token_env_var,
    ...common,
  };
}

function fromGlobalMcpServerConfigWire(wire: GlobalMcpServerConfigWire): GlobalMcpServerConfig {
  return { ...fromMcpServerConfigWire(wire), name: wire.name };
}

function toMcpServerConfigDataWire(
  config: McpServerConfig | McpServerConfigView,
  redactSecrets = false,
): McpServerConfigDataWire {
  const common = {
    enabled: config.enabled,
    deferred: config.deferred,
    startup_timeout_ms: config.startupTimeoutMs,
    tool_timeout_ms: config.toolTimeoutMs,
    enabled_tools: config.enabledTools,
    disabled_tools: config.disabledTools,
  };
  if (config.transport === 'stdio') {
    const envKeys =
      'envKeys' in config && config.envKeys !== undefined
        ? [...config.envKeys]
        : redactSecrets && 'env' in config && config.env !== undefined
          ? Object.keys(config.env)
          : undefined;
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: !redactSecrets && 'env' in config ? config.env : undefined,
      env_keys: envKeys,
      cwd: config.cwd,
      executor: config.executor,
      environment_id: config.environment_id,
      ...common,
    };
  }
  const headerKeys =
    'headerKeys' in config && config.headerKeys !== undefined
      ? [...config.headerKeys]
      : redactSecrets && 'headers' in config && config.headers !== undefined
        ? Object.keys(config.headers)
        : undefined;
  return {
    transport: config.transport,
    url: config.url,
    headers: !redactSecrets && 'headers' in config ? config.headers : undefined,
    header_keys: headerKeys,
    auth: config.auth,
    bearer_token_env_var: config.bearerTokenEnvVar,
    ...common,
  };
}

function fromMcpLocatorWire(locator: McpServerLocatorWire): McpServerLocator {
  if (locator.source === 'global') return { source: 'global', name: locator.name };
  return { source: 'plugin', pluginId: locator.plugin_id, serverName: locator.server_name };
}

function toMcpLocatorWire(locator: McpServerLocator): McpServerLocatorWire {
  if (locator.source === 'global') return { source: 'global', name: locator.name };
  return { source: 'plugin', plugin_id: locator.pluginId, server_name: locator.serverName };
}

function toManagedServerWire(
  server: McpManagedServer,
  redactSecrets = false,
): McpManagedServerWire {
  return {
    name: server.name,
    config: toMcpServerConfigDataWire(server.config, redactSecrets),
    source: server.source,
    origin: server.origin,
    mutable: server.mutable,
    plugin: server.plugin,
  };
}

function toAuthStatusWire(item: McpServerAuthStatus): McpServerAuthStatusWire {
  return { name: item.name, auth_status: item.authStatus };
}

function toInspectionWire(item: McpServerInspection): McpServerInspectionWire {
  return {
    server_id: item.serverId,
    locator: toMcpLocatorWire(item.locator),
    runtime_name: item.runtimeName,
    canonical_url: item.canonicalUrl,
    origin: item.origin,
    config: toMcpServerConfigDataWire(item.config),
    enabled: item.enabled,
    editable: item.editable,
    auth_status: item.authStatus,
    checked_at: item.checkedAt,
    error: item.error,
  };
}

function toAuthBeginResultWire(result: McpServerAuthBeginResult): McpServerAuthBeginResultWire {
  if (result.status === 'already-authorized') return { status: 'already-authorized' };
  return {
    status: 'authorization-required',
    flow_id: result.flowId,
    authorization_url: result.authorizationUrl,
  };
}

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const baseErrorSchemas = {
  [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
};

const namedServerErrorSchemas = {
  ...baseErrorSchemas,
  [ErrorCode.MCP_SERVER_NOT_FOUND]: {},
};

const oauthErrorSchemas = {
  ...baseErrorSchemas,
  [ErrorCode.MCP_OAUTH_FAILED]: {},
};

const namedServerOAuthErrorSchemas = {
  ...namedServerErrorSchemas,
  [ErrorCode.MCP_OAUTH_FAILED]: {},
};

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.MCP_SERVER_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.MCP_SERVER_NOT_FOUND, err.message, requestId));
        return;
      case ErrorCodes.REQUEST_INVALID:
      case ErrorCodes.CONFIG_INVALID:
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
        return;
      case ErrorCodes.MCP_OAUTH_FAILED:
        reply.send(errEnvelope(ErrorCode.MCP_OAUTH_FAILED, err.message, requestId));
        return;
    }
  }
  throw err;
}

export function registerMcpRoutes(app: McpRouteHost, core: Scope): void {
  const management = (): IMcpManagementService => core.accessor.get(IMcpManagementService);

  const listServersRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/servers',
      minRole: 'viewer',
      querystring: serverScopedQuerySchema,
      success: { data: z.array(mcpManagedServerSchema) },
      errors: baseErrorSchemas,
      description:
        'List every MCP server the management plane knows about (user-level file, plugin manifests; project layers join when `cwd` is given). Read-only entries carry redacted configs.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const redact = getRequestPrincipal(req).role !== 'owner';
        const servers = await management().listServers({ cwd: req.query.cwd });
        reply.send(
          okEnvelope(
            servers.map((s) => toManagedServerWire(s, redact)),
            req.id,
          ),
        );
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(
    listServersRoute.path,
    listServersRoute.options,
    listServersRoute.handler as Parameters<McpRouteHost['get']>[2],
  );

  const getServerRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/servers/{name}',
      minRole: 'viewer',
      params: serverNameParamSchema,
      querystring: serverScopedQuerySchema,
      success: { data: mcpManagedServerSchema },
      errors: namedServerErrorSchemas,
      description: 'Get one MCP server by runtime name (`40408` when unknown).',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const redact = getRequestPrincipal(req).role !== 'owner';
        const server = await management().getServer(req.params.name, { cwd: req.query.cwd });
        reply.send(okEnvelope(toManagedServerWire(server, redact), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(
    getServerRoute.path,
    getServerRoute.options,
    getServerRoute.handler as Parameters<McpRouteHost['get']>[2],
  );

  const addServerRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/servers',
      minRole: 'owner',
      querystring: serverScopedQuerySchema,
      body: globalMcpServerConfigSchema,
      success: { data: z.array(mcpManagedServerSchema) },
      errors: baseErrorSchemas,
      description:
        'Add a server to the user-level `mcp.json`; a same-named read-only entry (plugin / project layer) is rejected. Returns the refreshed list.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const servers = await management().addServer(fromGlobalMcpServerConfigWire(req.body), {
          cwd: req.query.cwd,
        });
        reply.send(okEnvelope(servers.map((s) => toManagedServerWire(s)), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    addServerRoute.path,
    addServerRoute.options,
    addServerRoute.handler as Parameters<McpRouteHost['post']>[2],
  );

  const updateServerRoute = defineRoute(
    {
      method: 'PUT',
      path: '/mcp/servers/{name}',
      minRole: 'owner',
      params: serverNameParamSchema,
      querystring: serverScopedQuerySchema,
      body: mcpServerConfigBodySchema,
      success: { data: z.array(mcpManagedServerSchema) },
      errors: namedServerErrorSchemas,
      description:
        'Replace the user-level entry named in the path (the body carries no `name`); read-only entries reject the write. Returns the refreshed list.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const servers = await management().updateServer(
          { ...fromMcpServerConfigWire(req.body), name: req.params.name },
          { cwd: req.query.cwd },
        );
        reply.send(okEnvelope(servers.map((s) => toManagedServerWire(s)), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.put(
    updateServerRoute.path,
    updateServerRoute.options,
    updateServerRoute.handler as Parameters<McpRouteHost['put']>[2],
  );

  const removeServerRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/mcp/servers/{name}',
      minRole: 'owner',
      params: serverNameParamSchema,
      querystring: serverScopedQuerySchema,
      success: { data: z.array(mcpManagedServerSchema) },
      errors: namedServerErrorSchemas,
      description:
        'Remove a user-level entry; read-only entries reject the delete. Returns the refreshed list.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const servers = await management().removeServer(req.params.name, { cwd: req.query.cwd });
        reply.send(okEnvelope(servers.map((s) => toManagedServerWire(s)), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.delete(
    removeServerRoute.path,
    removeServerRoute.options,
    removeServerRoute.handler as Parameters<McpRouteHost['delete']>[2],
  );

  const testServerRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/servers::test',
      minRole: 'owner',
      body: testServerBodySchema,
      success: { data: mcpServerTestResultSchema },
      errors: namedServerErrorSchemas,
      description:
        'Probe a real connection to one server: pass `name` to test a registry entry (plugin and project layers included) or an inline `server` config to probe it as-is. Never persists anything.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const result = await management().testServer({
          name: req.body.name,
          server:
            req.body.server === undefined
              ? undefined
              : fromGlobalMcpServerConfigWire(req.body.server),
          cwd: req.body.cwd,
        });
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    testServerRoute.path,
    testServerRoute.options,
    testServerRoute.handler as Parameters<McpRouteHost['post']>[2],
  );

  const inspectServersRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/servers::inspect',
      minRole: 'owner',
      body: inspectServersBodySchema,
      success: { data: z.array(mcpServerInspectionSchema) },
      errors: namedServerErrorSchemas,
      description:
        'The locator-addressed catalog (redacted configs) plus a batched real-connection probe of every OAuth candidate. `targets` narrows the catalog; omitted inspects all. `cwd` includes trusted project layers.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const inspections = await management().inspectServers(
          req.body.targets?.map(fromMcpLocatorWire),
          { cwd: req.body.cwd },
        );
        reply.send(okEnvelope(inspections.map(toInspectionWire), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    inspectServersRoute.path,
    inspectServersRoute.options,
    inspectServersRoute.handler as Parameters<McpRouteHost['post']>[2],
  );

  const authStatusesRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/auth-statuses',
      minRole: 'viewer',
      querystring: authStatusesQuerySchema,
      success: { data: z.array(mcpServerAuthStatusSchema) },
      errors: baseErrorSchemas,
      description:
        'Per-server OAuth state over the registry catalog. Omitted `verify` preserves implicit OAuth detection; `verify=false` is fully offline; `verify=true` verifies every candidate. Probes may refresh or invalidate credentials.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const isOwner = getRequestPrincipal(req).role === 'owner';
        if (!isOwner && req.query.verify === 'true') {
          (reply as unknown as { code(s: number): { send(p: unknown): unknown } })
            .code(403)
            .send(errEnvelope(ErrorCode.ACCESS_FORBIDDEN, 'Insufficient token permissions', req.id));
          return;
        }
        const statuses = await management().listAuthStatuses({
          cwd: req.query.cwd,
          verify: !isOwner ? false : req.query.verify === undefined ? undefined : req.query.verify === 'true',
        });
        reply.send(okEnvelope(statuses.map(toAuthStatusWire), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(
    authStatusesRoute.path,
    authStatusesRoute.options,
    authStatusesRoute.handler as Parameters<McpRouteHost['get']>[2],
  );

  const authBeginRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/auth::begin',
      minRole: 'owner',
      body: mcpServerLocatorSchema,
      querystring: serverScopedQuerySchema,
      success: { data: mcpServerAuthBeginResultSchema },
      errors: namedServerOAuthErrorSchemas,
      description:
        'Begin an interactive OAuth flow for a remote server. Answers `authorization-required` with the flow handle + URL, or `already-authorized` when a grant exists.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        const result = await management().beginServerAuth(fromMcpLocatorWire(req.body), {
          cwd: req.query.cwd,
        });
        reply.send(okEnvelope(toAuthBeginResultWire(result), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    authBeginRoute.path,
    authBeginRoute.options,
    authBeginRoute.handler as Parameters<McpRouteHost['post']>[2],
  );

  const authCompleteRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/auth::complete',
      minRole: 'owner',
      body: authCompleteBodySchema,
      success: { data: z.null() },
      errors: oauthErrorSchemas,
      description:
        'Await the browser callback of a begun flow and finish the code exchange (`40001` for an unknown `flow_id`).',
      tags: ['mcp'],
    },
    async (req, reply) => {
      const { raw } = reply as unknown as { raw: ServerResponse };
      const disconnect = new AbortController();
      const onClose = (): void => {
        if (raw.writableFinished) return;
        disconnect.abort();
      };
      raw.once('close', onClose);
      try {
        await management().completeServerAuth(
          { flowId: req.body.flow_id, timeoutMs: req.body.timeout_ms },
          { signal: disconnect.signal },
        );
        reply.send(okEnvelope(null, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      } finally {
        raw.off('close', onClose);
      }
    },
  );
  app.post(
    authCompleteRoute.path,
    authCompleteRoute.options,
    authCompleteRoute.handler as Parameters<McpRouteHost['post']>[2],
  );

  const authCancelRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/auth::cancel',
      minRole: 'owner',
      body: authCancelBodySchema,
      success: { data: z.null() },
      errors: oauthErrorSchemas,
      description: 'Tear down a begun OAuth flow without finishing it; unknown flows are ignored.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        await management().cancelServerAuth({ flowId: req.body.flow_id });
        reply.send(okEnvelope(null, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    authCancelRoute.path,
    authCancelRoute.options,
    authCancelRoute.handler as Parameters<McpRouteHost['post']>[2],
  );

  const authResetRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/auth::reset',
      minRole: 'owner',
      body: mcpServerLocatorSchema,
      querystring: serverScopedQuerySchema,
      success: { data: z.null() },
      errors: namedServerOAuthErrorSchemas,
      description:
        'Clear the stored credentials of one server; the invalidation event reaches live sessions.',
      tags: ['mcp'],
    },
    async (req, reply) => {
      try {
        await management().resetServerAuth(fromMcpLocatorWire(req.body), { cwd: req.query.cwd });
        reply.send(okEnvelope(null, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    authResetRoute.path,
    authResetRoute.options,
    authResetRoute.handler as Parameters<McpRouteHost['post']>[2],
  );
}
