import {
  ErrorCodes,
  IConfigService,
  IMcpManagementService,
  isError2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { mcpManagementFlag } from '@moonshot-ai/agent-core-v2/app/mcpManagement/flag';
import {
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
  McpServerStdioConfigSchema,
} from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import { z } from 'zod';

import { defineRoute } from '../../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../../protocol/envelope';
import { ErrorCode } from '../../protocol/error-codes';

interface V2McpRouteHost {
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

const serverNameSchema = z.string().min(1);

const serverNameParamSchema = z.object({ name: serverNameSchema });

const serverScopedQuerySchema = z.object({ cwd: z.string().min(1).optional() });

const authStatusesQuerySchema = z.object({
  cwd: z.string().min(1).optional(),
  verify: z.enum(['true', 'false']).optional(),
});

const globalMcpServerConfigSchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema.extend({ name: serverNameSchema }),
  McpServerHttpConfigSchema.extend({ name: serverNameSchema }),
  McpServerSseConfigSchema.extend({ name: serverNameSchema }),
]);

const mcpServerConfigBodySchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
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
    pluginId: z.string().min(1),
    serverName: z.string().min(1),
  }),
]);

const inspectServersBodySchema = z.object({
  targets: z.array(mcpServerLocatorSchema).optional(),
});

const authCompleteBodySchema = z.object({
  flowId: z.string().min(1),
  timeoutMs: z.number().int().min(1).optional(),
});

const authCancelBodySchema = z.object({ flowId: z.string().min(1) });

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
  McpServerStdioConfigSchema.extend({ envKeys: z.array(z.string()).optional() }),
  McpServerHttpConfigSchema.extend({ headerKeys: z.array(z.string()).optional() }),
  McpServerSseConfigSchema.extend({ headerKeys: z.array(z.string()).optional() }),
]);

const mcpManagedServerSchema = z.object({
  name: z.string(),
  config: mcpServerConfigDataSchema,
  source: mcpServerSourceSchema,
  origin: z.string(),
  mutable: z.boolean(),
  plugin: z.object({ id: z.string(), name: z.string() }).optional(),
});

const mcpServerTestResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
});

const mcpServerAuthStatusSchema = z.object({
  name: z.string(),
  authStatus: mcpServerAuthStateSchema,
});

const mcpServerInspectionSchema = z.object({
  serverId: z.string(),
  locator: mcpServerLocatorSchema,
  runtimeName: z.string(),
  canonicalUrl: z.string().optional(),
  origin: mcpServerSourceSchema,
  config: mcpServerConfigDataSchema,
  enabled: z.boolean(),
  editable: z.boolean(),
  authStatus: mcpServerAuthStateSchema,
  checkedAt: z.number().optional(),
  error: z.string().optional(),
});

const mcpServerAuthBeginResultSchema = z.union([
  z.object({
    status: z.literal('authorization-required'),
    flowId: z.string(),
    authorizationUrl: z.string(),
  }),
  z.object({ status: z.literal('already-authorized') }),
]);

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const baseErrorSchemas = {
  [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
  [ErrorCode.MCP_MANAGEMENT_DISABLED]: {},
};

const namedServerErrorSchemas = {
  ...baseErrorSchemas,
  [ErrorCode.MCP_SERVER_NOT_FOUND]: {},
};

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.MCP_SERVER_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.MCP_SERVER_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.REQUEST_INVALID:
      case ErrorCodes.CONFIG_INVALID:
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
      case ErrorCodes.MCP_MANAGEMENT_DISABLED:
        reply.send(
          errEnvelope(ErrorCode.MCP_MANAGEMENT_DISABLED, err.message, requestId, err.stack),
        );
        return;
    }
  }
  throw err;
}

export function registerV2McpRoutes(app: V2McpRouteHost, core: Scope): void {
  const management = (): IMcpManagementService => core.accessor.get(IMcpManagementService);

  const gate = (
    req: { id: string },
    reply: { send(payload: unknown): unknown },
    done: (err?: Error) => void,
  ): void => {
    void core.accessor.get(IConfigService).ready.then(
      () => {
        if (core.accessor.get(IFlagService).enabled(mcpManagementFlag.id)) {
          done();
          return;
        }
        reply.send(
          errEnvelope(
            ErrorCode.MCP_MANAGEMENT_DISABLED,
            `the MCP management plane is experimental and disabled; enable the '${mcpManagementFlag.id}' flag (${mcpManagementFlag.env}=1 or [experimental] ${mcpManagementFlag.id} = true)`,
            req.id,
          ),
        );
      },
      (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
    );
  };

  const gated = (options: { preHandler: unknown[]; schema: Record<string, unknown> }) => ({
    ...options,
    preHandler: [gate, ...options.preHandler],
  });

  const listServersRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/servers',
      querystring: serverScopedQuerySchema,
      success: { data: z.array(mcpManagedServerSchema) },
      errors: baseErrorSchemas,
      description:
        'List every MCP server the management plane knows about (user-level file, plugin manifests; project layers join when `cwd` is given). Read-only entries carry redacted configs.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const servers = await management().listServers({ cwd: req.query.cwd });
        reply.send(okEnvelope(servers, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    listServersRoute.path,
    gated(listServersRoute.options),
    listServersRoute.handler as Parameters<V2McpRouteHost['get']>[2],
  );

  const getServerRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/servers/{name}',
      params: serverNameParamSchema,
      querystring: serverScopedQuerySchema,
      success: { data: mcpManagedServerSchema },
      errors: namedServerErrorSchemas,
      description: 'Get one MCP server by runtime name (`40408` when unknown).',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const server = await management().getServer(req.params.name, { cwd: req.query.cwd });
        reply.send(okEnvelope(server, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    getServerRoute.path,
    gated(getServerRoute.options),
    getServerRoute.handler as Parameters<V2McpRouteHost['get']>[2],
  );

  const addServerRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/servers',
      body: globalMcpServerConfigSchema,
      success: { data: z.array(mcpManagedServerSchema) },
      errors: baseErrorSchemas,
      description:
        'Add a server to the user-level `mcp.json`; a same-named read-only entry (plugin / project layer) is rejected. Returns the refreshed list.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const servers = await management().addServer(req.body);
        reply.send(okEnvelope(servers, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    addServerRoute.path,
    gated(addServerRoute.options),
    addServerRoute.handler as Parameters<V2McpRouteHost['post']>[2],
  );

  const updateServerRoute = defineRoute(
    {
      method: 'PUT',
      path: '/mcp/servers/{name}',
      params: serverNameParamSchema,
      body: mcpServerConfigBodySchema,
      success: { data: z.array(mcpManagedServerSchema) },
      errors: namedServerErrorSchemas,
      description:
        'Replace the user-level entry named in the path (the body carries no `name`); read-only entries reject the write. Returns the refreshed list.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const servers = await management().updateServer({ ...req.body, name: req.params.name });
        reply.send(okEnvelope(servers, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.put(
    updateServerRoute.path,
    gated(updateServerRoute.options),
    updateServerRoute.handler as Parameters<V2McpRouteHost['put']>[2],
  );

  const removeServerRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/mcp/servers/{name}',
      params: serverNameParamSchema,
      success: { data: z.array(mcpManagedServerSchema) },
      errors: namedServerErrorSchemas,
      description:
        'Remove a user-level entry; read-only entries reject the delete. Returns the refreshed list.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const servers = await management().removeServer(req.params.name);
        reply.send(okEnvelope(servers, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.delete(
    removeServerRoute.path,
    gated(removeServerRoute.options),
    removeServerRoute.handler as Parameters<V2McpRouteHost['delete']>[2],
  );

  const testServerRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/servers::test',
      body: testServerBodySchema,
      success: { data: mcpServerTestResultSchema },
      errors: namedServerErrorSchemas,
      description:
        'Probe a real connection to one server: pass `name` to test a registry entry (plugin and project layers included) or an inline `server` config to probe it as-is. Never persists anything.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const result = await management().testServer(req.body);
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    testServerRoute.path,
    gated(testServerRoute.options),
    testServerRoute.handler as Parameters<V2McpRouteHost['post']>[2],
  );

  const inspectServersRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/servers::inspect',
      body: inspectServersBodySchema,
      success: { data: z.array(mcpServerInspectionSchema) },
      errors: namedServerErrorSchemas,
      description:
        'The locator-addressed catalog (redacted configs) plus a batched real-connection probe of every OAuth candidate. `targets` narrows the catalog; omitted inspects all.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const inspections = await management().inspectServers(req.body.targets);
        reply.send(okEnvelope(inspections, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    inspectServersRoute.path,
    gated(inspectServersRoute.options),
    inspectServersRoute.handler as Parameters<V2McpRouteHost['post']>[2],
  );

  const authStatusesRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/auth-statuses',
      querystring: authStatusesQuerySchema,
      success: { data: z.array(mcpServerAuthStatusSchema) },
      errors: baseErrorSchemas,
      description:
        'Per-server OAuth state over the registry catalog. Offline classification by default; `?verify=true` probes a real connection. Never mutates credentials.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const statuses = await management().listAuthStatuses({
          cwd: req.query.cwd,
          verify: req.query.verify === undefined ? undefined : req.query.verify === 'true',
        });
        reply.send(okEnvelope(statuses, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    authStatusesRoute.path,
    gated(authStatusesRoute.options),
    authStatusesRoute.handler as Parameters<V2McpRouteHost['get']>[2],
  );

  const authBeginRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/auth::begin',
      body: mcpServerLocatorSchema,
      success: { data: mcpServerAuthBeginResultSchema },
      errors: namedServerErrorSchemas,
      description:
        'Begin an interactive OAuth flow for a remote server. Answers `authorization-required` with the flow handle + URL, or `already-authorized` when a grant exists.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        const result = await management().beginServerAuth(req.body);
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    authBeginRoute.path,
    gated(authBeginRoute.options),
    authBeginRoute.handler as Parameters<V2McpRouteHost['post']>[2],
  );

  const authCompleteRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/auth::complete',
      body: authCompleteBodySchema,
      success: { data: z.null() },
      errors: baseErrorSchemas,
      description:
        'Await the browser callback of a begun flow and finish the code exchange (`40001` for an unknown `flowId`).',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        await management().completeServerAuth(req.body);
        reply.send(okEnvelope(null, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    authCompleteRoute.path,
    gated(authCompleteRoute.options),
    authCompleteRoute.handler as Parameters<V2McpRouteHost['post']>[2],
  );

  const authCancelRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/auth::cancel',
      body: authCancelBodySchema,
      success: { data: z.null() },
      errors: baseErrorSchemas,
      description: 'Tear down a begun OAuth flow without finishing it; unknown flows are ignored.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        await management().cancelServerAuth(req.body);
        reply.send(okEnvelope(null, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    authCancelRoute.path,
    gated(authCancelRoute.options),
    authCancelRoute.handler as Parameters<V2McpRouteHost['post']>[2],
  );

  const authResetRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/auth::reset',
      body: mcpServerLocatorSchema,
      success: { data: z.null() },
      errors: namedServerErrorSchemas,
      description:
        'Clear the stored credentials of one server; the invalidation event reaches live sessions.',
      tags: ['v2-mcp'],
    },
    async (req, reply) => {
      try {
        await management().resetServerAuth(req.body);
        reply.send(okEnvelope(null, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    authResetRoute.path,
    gated(authResetRoute.options),
    authResetRoute.handler as Parameters<V2McpRouteHost['post']>[2],
  );
}
