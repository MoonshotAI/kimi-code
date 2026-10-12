import type { Request, Response } from 'express';
import { z } from 'zod';

import { useInject } from '@moonshot-ai/agent-core';

import {
  McpManagementError,
  McpRef,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
  McpServerStdioConfigSchema,
  type McpFacade,
} from '#/features/mcp/index';

import { useHttpRoute } from '../feature';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

const MCP_SERVER_ACTIONS = ['restart'] as const;
const MCP_AUTH_ACTIONS = ['begin', 'complete', 'cancel', 'reset'] as const;

const serverNameSchema = z.string().min(1);

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
  cwd: z.string().min(1).optional(),
});

const authCompleteBodySchema = z.object({
  flowId: z.string().min(1),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1)
    .optional(),
});

const authCancelBodySchema = z.object({ flowId: z.string().min(1) });

export function useMcpRoutes(prefix: string): void {
  useHttpRoute({
    id: 'mcp.servers.list',
    method: 'GET',
    path: `${prefix}/mcp/servers`,
    handler: async (request, response) => {
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.listServers({ cwd: readCwd(request) }));
      } catch (error) {
        if (sendMcpErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'mcp.servers.create',
    method: 'POST',
    path: `${prefix}/mcp/servers`,
    handler: async (request, response) => {
      const parsed = parseBody(globalMcpServerConfigSchema, request.body);
      if (!parsed.ok) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, parsed.message);
        return;
      }
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.addServer(parsed.value, { cwd: readCwd(request) }));
      } catch (error) {
        if (sendMcpErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'mcp.servers.get',
    method: 'GET',
    path: `${prefix}/mcp/servers/:name`,
    handler: async (request, response) => {
      const name = param(request, 'name');
      if (name === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'mcp server name is required');
        return;
      }
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.getServer(name, { cwd: readCwd(request) }));
      } catch (error) {
        if (sendMcpErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'mcp.servers.update',
    method: 'PUT',
    path: `${prefix}/mcp/servers/:name`,
    handler: async (request, response) => {
      const name = param(request, 'name');
      if (name === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'mcp server name is required');
        return;
      }
      const parsed = parseBody(mcpServerConfigBodySchema, request.body);
      if (!parsed.ok) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, parsed.message);
        return;
      }
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(
          request,
          response,
          await facade.updateServer({ ...parsed.value, name }, { cwd: readCwd(request) }),
        );
      } catch (error) {
        if (sendMcpErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'mcp.servers.remove',
    method: 'DELETE',
    path: `${prefix}/mcp/servers/:name`,
    handler: async (request, response) => {
      const name = param(request, 'name');
      if (name === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'mcp server name is required');
        return;
      }
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, await facade.removeServer(name, { cwd: readCwd(request) }));
      } catch (error) {
        if (sendMcpErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'mcp.servers.testInspect',
    method: 'POST',
    path: `${prefix}/mcp/servers:action`,
    handler: async (request, response) => {
      const raw = param(request, 'action');
      const action = raw === undefined ? undefined : raw.replace(/^:+/, '');
      if (action !== 'test' && action !== 'inspect') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          `unsupported action: ${raw ?? ''}`,
        );
        return;
      }
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      if (action === 'test') {
        const parsed = parseBody(testServerBodySchema, request.body);
        if (!parsed.ok) {
          sendErr(request, response, ErrorCode.VALIDATION_FAILED, parsed.message);
          return;
        }
        try {
          sendOk(request, response, await facade.testServer(parsed.value));
        } catch (error) {
          if (sendMcpErr(request, response, error)) return;
          throw error;
        }
        return;
      }
      const parsed = parseBody(inspectServersBodySchema, request.body);
      if (!parsed.ok) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, parsed.message);
        return;
      }
      try {
        sendOk(
          request,
          response,
          await facade.inspectServers(parsed.value.targets, { cwd: parsed.value.cwd }),
        );
      } catch (error) {
        if (sendMcpErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'mcp.servers.action',
    method: 'POST',
    path: `${prefix}/mcp/servers/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'mcp server id is required');
        return;
      }
      const parsed = parseActionSuffix({
        tail,
        allowedActions: MCP_SERVER_ACTIONS,
        resourceLabel: 'mcp_server',
      });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      if (!facade.list().some((entry) => entry.name === parsed.id)) {
        sendErr(
          request,
          response,
          ErrorCode.MCP_SERVER_NOT_FOUND,
          `MCP server ${parsed.id} does not exist`,
        );
        return;
      }
      await facade.reconnect(parsed.id);
      sendOk(request, response, { restarting: true });
    },
  });

  useHttpRoute({
    id: 'mcp.auth.statuses',
    method: 'GET',
    path: `${prefix}/mcp/auth-statuses`,
    handler: async (request, response) => {
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      const verifyRaw = request.query['verify'];
      if (verifyRaw !== undefined && verifyRaw !== 'true' && verifyRaw !== 'false') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'verify must be "true" or "false"',
        );
        return;
      }
      try {
        sendOk(
          request,
          response,
          await facade.listAuthStatuses({
            cwd: readCwd(request),
            verify: verifyRaw === undefined ? undefined : verifyRaw === 'true',
          }),
        );
      } catch (error) {
        if (sendMcpErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'mcp.auth.action',
    method: 'POST',
    path: `${prefix}/mcp/auth:action`,
    handler: async (request, response) => {
      const raw = param(request, 'action');
      const action = raw === undefined ? undefined : raw.replace(/^:+/, '');
      if (
        action === undefined ||
        !(MCP_AUTH_ACTIONS as readonly string[]).includes(action)
      ) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          `unsupported action: ${raw ?? ''}`,
        );
        return;
      }
      const facade = mcpFacade(request, response);
      if (facade === undefined) return;
      if (action === 'begin' || action === 'reset') {
        const parsed = parseBody(mcpServerLocatorSchema, request.body);
        if (!parsed.ok) {
          sendErr(request, response, ErrorCode.VALIDATION_FAILED, parsed.message);
          return;
        }
        try {
          if (action === 'begin') {
            sendOk(
              request,
              response,
              await facade.beginServerAuth(parsed.value, { cwd: readCwd(request) }),
            );
          } else {
            await facade.resetServerAuth(parsed.value, { cwd: readCwd(request) });
            sendOk(request, response, null);
          }
        } catch (error) {
          if (sendMcpErr(request, response, error)) return;
          throw error;
        }
        return;
      }
      if (action === 'complete') {
        const parsed = parseBody(authCompleteBodySchema, request.body);
        if (!parsed.ok) {
          sendErr(request, response, ErrorCode.VALIDATION_FAILED, parsed.message);
          return;
        }
        const disconnect = new AbortController();
        const onClose = (): void => {
          if (response.writableFinished) return;
          disconnect.abort();
        };
        response.on('close', onClose);
        try {
          await facade.completeServerAuth(parsed.value, { signal: disconnect.signal });
          sendOk(request, response, null);
        } catch (error) {
          if (sendMcpErr(request, response, error)) return;
          throw error;
        } finally {
          response.off('close', onClose);
        }
        return;
      }
      const parsed = parseBody(authCancelBodySchema, request.body);
      if (!parsed.ok) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, parsed.message);
        return;
      }
      try {
        await facade.cancelServerAuth(parsed.value);
        sendOk(request, response, null);
      } catch (error) {
        if (sendMcpErr(request, response, error)) return;
        throw error;
      }
    },
  });
}

function readCwd(request: Request): string | undefined {
  const value = request.query['cwd'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseBody<S extends z.ZodType>(
  schema: S,
  body: unknown,
): { ok: true; value: z.output<S> } | { ok: false; message: string } {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, value: result.data as z.output<S> };
  return {
    ok: false,
    message: result.error.issues.map((issue) => issue.message).join('; '),
  };
}

function mcpFacade(request: Request, response: Response): McpFacade | undefined {
  const facade = useInject(McpRef).value;
  if (facade === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.MCP_UNAVAILABLE,
      'mcp is unavailable (mcp feature is not installed)',
    );
  }
  return facade;
}

function sendMcpErr(request: Request, response: Response, error: unknown): boolean {
  if (!(error instanceof McpManagementError)) return false;
  if (error.code === 'mcp.server_not_found') {
    sendErr(request, response, ErrorCode.MCP_SERVER_NOT_FOUND, error.message);
    return true;
  }
  if (error.code === 'mcp.oauth_failed') {
    sendErr(request, response, ErrorCode.MCP_OAUTH_FAILED, error.message);
    return true;
  }
  sendErr(request, response, ErrorCode.VALIDATION_FAILED, error.message);
  return true;
}
