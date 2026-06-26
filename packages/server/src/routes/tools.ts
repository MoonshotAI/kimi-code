/**
 * `/tools` + `/mcp/servers*` REST routes.
 *
 * 3 endpoints (REST.md §3.8):
 *
 *   GET  /tools                                  query: {session_id?}    data: {tools: ToolDescriptor[]}
 *   GET  /mcp/servers                            -                       data: {servers: McpServer[]}
 *   POST /mcp/servers/{mcp_server_id}:restart    body: empty             data: {restarting: true}
 *
 * **Error mapping**:
 *   - `McpServerNotFoundError` → envelope `code: 40408 mcp.server_not_found`.
 *   - Other errors → 50001 via the global `installErrorHandler`.
 *
 * **Action suffix**: the `:restart` POST endpoint uses the shared
 * `parseActionSuffix` helper.
 *
 * **Anti-corruption**: route resolves `IToolService` / `IMcpService` via the
 * accessor; no SDK imports.
 */

import {
  ErrorCode,
  listMcpServersResponseSchema,
  listToolsQuerySchema,
  listToolsResponseSchema,
  restartMcpServerResultSchema,
} from '@moonshot-ai/protocol';
import { IMcpService, IToolService, McpServerNotFoundError, type IInstantiationService } from '@moonshot-ai/agent-core';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface ToolsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
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
}

export function registerToolsRoutes(
  app: ToolsRouteHost,
  ix: IInstantiationService,
): void {
  // GET /tools ----------------------------------------------------------
  const listToolsRoute = defineRoute(
    {
      method: 'GET',
      path: '/tools',
      querystring: listToolsQuerySchema,
      success: { data: listToolsResponseSchema },
      description: 'List available tools',
      tags: ['tools'],
    },
    async (req, reply) => {
      try {
        const tools = await ix.invokeFunction((a) =>
          a.get(IToolService).list(req.query.session_id),
        );
        reply.send(okEnvelope({ tools }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    listToolsRoute.path,
    listToolsRoute.options,
    listToolsRoute.handler as Parameters<ToolsRouteHost['get']>[2],
  );

  // GET /mcp/servers ----------------------------------------------------
  const listMcpServersRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/servers',
      success: { data: listMcpServersResponseSchema },
      description: 'List configured MCP servers',
      tags: ['tools'],
    },
    async (req, reply) => {
      try {
        const servers = await ix.invokeFunction((a) => a.get(IMcpService).list());
        reply.send(okEnvelope({ servers }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    listMcpServersRoute.path,
    listMcpServersRoute.options,
    listMcpServersRoute.handler as Parameters<ToolsRouteHost['get']>[2],
  );

  // POST /mcp/servers/{mcp_server_id}:restart ---------------------------
  const restartMcpServerRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/servers/{tail}',
      success: { data: restartMcpServerResultSchema },
      errors: {
        [ErrorCode.MCP_SERVER_NOT_FOUND]: {},
      },
      description: 'Restart an MCP server by ID',
      tags: ['tools'],
      operationId: 'restartMcpServer',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params as { tail: string };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['restart'] as const,
          resourceLabel: 'mcp_server',
        });
        if (parsed.kind === 'invalid') {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
          );
          return;
        }
        if (parsed.kind === 'bare') {
          // No bare form for /mcp/servers/{id} — only :restart.
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `unsupported action: ${tail}`,
              req.id,
            ),
          );
          return;
        }
        const result = await ix.invokeFunction((a) =>
          a.get(IMcpService).restart(parsed.id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    restartMcpServerRoute.path,
    restartMcpServerRoute.options,
    restartMcpServerRoute.handler as Parameters<ToolsRouteHost['post']>[2],
  );
}

/**
 * Map a thrown error to the right envelope. See module header for the table.
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof McpServerNotFoundError) {
    reply.send(errEnvelope(ErrorCode.MCP_SERVER_NOT_FOUND, err.message, requestId));
    return;
  }
  throw err;
}
