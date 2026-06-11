/**
 *   GET  /v1/tools
 *     Query: `{ session_id?: string }` — when omitted returns global tool list;
 *            when present returns the session-effective list (REST §3.8 line 430).
 *     Response data: `{ tools: ToolDescriptor[] }`
 *
 *   GET  /v1/mcp/servers
 *     Response data: `{ servers: McpServer[] }`
 *
 *   POST /v1/mcp/servers/{mcp_server_id}:restart
 *     Body: empty
 *     Response data: `{ restarting: true }` (REST §3.8 line 442)
 *     Errors: 40408 mcp.server_not_found
 */

import { z } from 'zod';

import { mcpServerSchema, toolDescriptorSchema } from '../tool';

export const listToolsQuerySchema = z.object({
  session_id: z.string().min(1).optional(),
});
export type ListToolsQuery = z.infer<typeof listToolsQuerySchema>;

export const listToolsResponseSchema = z.object({
  tools: z.array(toolDescriptorSchema),
});
export type ListToolsResponse = z.infer<typeof listToolsResponseSchema>;

export const listMcpServersResponseSchema = z.object({
  servers: z.array(mcpServerSchema),
});
export type ListMcpServersResponse = z.infer<typeof listMcpServersResponseSchema>;

export const restartMcpServerResultSchema = z.object({
  restarting: z.literal(true),
});
export type RestartMcpServerResult = z.infer<typeof restartMcpServerResultSchema>;
